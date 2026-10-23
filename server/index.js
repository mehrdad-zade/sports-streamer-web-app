// Sports Streamer web app: a local server (127.0.0.1 only) that serves the UI in public/ and a small JSON API.
// It runs until its terminal window is closed (SIGHUP) or Ctrl+C is pressed.
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventStore } from './eventStore.js'
import { handleProxy } from './hlsProxy.js'
import { SourceMonitor } from './monitor.js'
import { Settings, normalizeSiteURL } from './settings.js'
import { chromePath, closeBrowser } from './sniffer.js'

const APP_ID = 'sports-streamer-web'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const publicDir = path.join(root, 'public')
const args = process.argv.slice(2)
const firstPort = Number(process.env.PORT) || 8790

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json'
}
const VENDOR = { '/vendor/hls.min.js': path.join(root, 'node_modules', 'hls.js', 'dist', 'hls.min.js') }

// If the app is already running (another terminal window), just open it instead of starting a second server.
const existing = await findRunningInstance()
if (existing) {
  console.log(`Sports Streamer is already running at ${existing}. Opening it in your browser.`)
  if (args.includes('--open')) openURL(existing)
  process.exit(0)
}

const settings = new Settings()
const store = new EventStore()

/** Watch sessions: one SourceMonitor per open watch page. */
const sessions = new Map()
// A session whose page stops listening (tab closed, navigated away) is stopped after this long.
const ORPHAN_GRACE_MS = 20_000

class HTTPError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

function session (id) {
  const s = sessions.get(id)
  if (!s) throw new HTTPError(404, 'This watch session has ended')
  return s
}

function stopSession (id) {
  const s = sessions.get(id)
  if (!s) return
  clearTimeout(s.orphanTimer)
  s.monitor.stop()
  for (const res of s.clients) res.end()
  sessions.delete(id)
}

function scheduleOrphanStop (id) {
  const s = sessions.get(id)
  if (!s || s.clients.size) return
  clearTimeout(s.orphanTimer)
  s.orphanTimer = setTimeout(() => { if (!s.clients.size) stopSession(id) }, ORPHAN_GRACE_MS)
}

// MARK: - API

const routes = {
  'GET /api/ping': () => ({ app: APP_ID }),
  'GET /api/info': () => ({ canExtract: Boolean(chromePath), settings }),

  'GET /api/events': async ({ reload }) => {
    const site = settings.resolvedSiteURL
    return store.get(site, { force: reload === '1' })
  },

  'GET /api/settings': () => settings,
  'POST /api/settings': body => {
    if (body.siteURL !== undefined && !normalizeSiteURL(body.siteURL)) throw new HTTPError(400, 'Enter a valid site address')
    settings.update(body)
    return settings
  },
  'POST /api/settings/test': async ({ siteURL }) => {
    const site = normalizeSiteURL(siteURL)
    if (!site) throw new HTTPError(400, 'Enter a valid site address')
    try {
      const { events, categories } = await EventStore.test(site)
      return { message: `Found ${events} events on the homepage and ${categories} category pages.` }
    } catch (err) {
      return { message: `Couldn't load: ${err.cause?.message || err.message}` }
    }
  },

  'POST /api/watch': ({ url }) => {
    let eventURL
    try { eventURL = new URL(url).href } catch { throw new HTTPError(400, 'Not an event link') }
    const id = randomUUID()
    const monitor = new SourceMonitor(eventURL, () => settings.recheckInterval)
    const s = { monitor, clients: new Set(), orphanTimer: null }
    sessions.set(id, s)
    monitor.on('change', state => {
      const message = `event: sources\ndata: ${JSON.stringify(state)}\n\n`
      for (const res of s.clients) res.write(message)
    })
    monitor.start().catch(err => console.error('Source monitor stopped:', err))
    scheduleOrphanStop(id)
    return { id, ...monitor.toJSON() }
  },
  'POST /api/watch/stop': ({ id }) => { stopSession(id); return { ok: true } },
  'POST /api/watch/recheck': ({ id }) => { session(id).monitor.recheckNow(); return { ok: true } },
  'POST /api/watch/dead': ({ id, sourceId }) => { session(id).monitor.markDead(Number(sourceId)); return { ok: true } }
}

async function readBody (req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HTTPError(400, 'Invalid JSON') }
}

function sendJSON (res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

function openEventStream (req, res, id) {
  const s = sessions.get(id)
  if (!s) return sendJSON(res, 404, { error: 'This watch session has ended' })
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
  res.write(`event: sources\ndata: ${JSON.stringify(s.monitor.toJSON())}\n\n`)
  clearTimeout(s.orphanTimer)
  s.clients.add(res)
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => {
    clearInterval(keepAlive)
    s.clients.delete(res)
    scheduleOrphanStop(id)
  })
}

function serveStatic (res, pathname) {
  const file = VENDOR[pathname] ?? path.join(publicDir, pathname === '/' ? 'index.html' : pathname)
  if (!file.startsWith(publicDir) && !VENDOR[pathname]) return sendJSON(res, 404, { error: 'Not found' })
  fs.readFile(file, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'Not found' })
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' })
    res.end(data)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname.startsWith('/proxy/')) {
      return await handleProxy(req, res, url.pathname.split('/')[2], url.searchParams.get('u'))
    }
    if (req.method === 'GET' && url.pathname === '/api/watch/events') {
      return openEventStream(req, res, url.searchParams.get('id'))
    }
    const route = routes[`${req.method} ${url.pathname}`]
    if (route) {
      const input = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req)
      return sendJSON(res, 200, await route(input))
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(res, decodeURIComponent(url.pathname))
    sendJSON(res, 404, { error: 'Not found' })
  } catch (err) {
    if (!(err instanceof HTTPError)) console.error(err)
    if (!res.headersSent) sendJSON(res, err.status ?? 500, { error: err.message })
  }
})

// MARK: - Startup

async function findRunningInstance () {
  for (let port = firstPort; port < firstPort + 10; port++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(500) })
      if ((await response.json()).app === APP_ID) return `http://localhost:${port}`
    } catch {}
  }
  return null
}

function openURL (url) {
  const [command, list] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]]
  const child = spawn(command, list, { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', error => console.warn(`Could not open the browser: ${error.message}`))
  child.unref()
}

function listen (port) {
  server.once('error', error => {
    if (error.code === 'EADDRINUSE' && port < firstPort + 10) return listen(port + 1)
    console.error(`Could not start the server: ${error.message}`)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    const address = `http://localhost:${port}`
    console.log('')
    console.log('  Sports Streamer is running at ' + address)
    console.log(chromePath
      ? '  Stream extraction uses ' + path.basename(chromePath) + ' (headless).'
      : '  Chrome was not found, so streams open in the web player only. Set CHROME_PATH to enable extraction.')
    console.log('')
    console.log('  Keep this window open while you watch. Press Ctrl+C to stop.')
    console.log('')
    if (args.includes('--open')) openURL(address)
  })
}

async function shutdown () {
  for (const id of [...sessions.keys()]) stopSession(id)
  await closeBrowser()
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, shutdown)

listen(firstPort)
