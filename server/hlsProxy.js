// Plays extracted HLS streams in the browser: fetches playlists and segments with the Referer/Origin/cookies
// the stream needs (which a page can't set itself) and rewrites playlists so every URI comes back through here.
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { streamHeaders } from './fetcher.js'

const streams = new Map()
const idsByKey = new Map()

/** Returns a stable id for a stream (the same URL and headers get the same id). */
export function registerStream (stream) {
  const key = [stream.url, stream.referer, stream.origin].join('\n')
  let id = idsByKey.get(key)
  if (!id) {
    id = randomUUID().slice(0, 8)
    idsByKey.set(key, id)
  }
  streams.set(id, stream)
  return id
}

export function proxyURL (id, url) {
  return `/proxy/${id}?u=${encodeURIComponent(url)}`
}

export async function handleProxy (req, res, id, target) {
  const stream = streams.get(id)
  if (!stream || !target) {
    res.writeHead(404).end()
    return
  }
  let url
  try { url = new URL(target, stream.url) } catch {
    res.writeHead(400).end()
    return
  }
  if (!/^https?:$/.test(url.protocol)) {
    res.writeHead(400).end()
    return
  }

  const headers = streamHeaders(stream)
  if (req.headers.range) headers.Range = req.headers.range
  const abort = new AbortController()
  req.on('close', () => abort.abort())
  let upstream
  try {
    upstream = await fetch(url, { headers, signal: abort.signal })
  } catch {
    if (!res.headersSent) res.writeHead(502).end()
    return
  }

  const type = upstream.headers.get('content-type') ?? ''
  const looksLikePlaylist = /mpegurl/i.test(type) || /\.m3u8?(\?|$)/i.test(url.pathname)
  if (upstream.ok && looksLikePlaylist) {
    const text = await upstream.text().catch(() => '')
    if (text.trimStart().startsWith('#EXTM3U')) {
      const body = rewritePlaylist(text, upstream.url || url.href, id)
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' })
      res.end(body)
      return
    }
    res.writeHead(upstream.status, { 'Content-Type': type || 'text/plain' }).end(text)
    return
  }

  // Some hosts disguise MPEG-TS segments as images (a real PNG/WebP header in front of the TS packets).
  if (upstream.ok && /^image\//i.test(type)) {
    const data = Buffer.from(await upstream.arrayBuffer())
    const offset = tsSyncOffset(data)
    const body = offset >= 0 ? data.subarray(offset) : data
    res.writeHead(200, { 'Content-Type': offset >= 0 ? 'video/mp2t' : type, 'Content-Length': body.length, 'Cache-Control': 'no-store' })
    res.end(body)
    return
  }

  const out = { 'Cache-Control': 'no-store' }
  // fetch() decodes gzip/br, so the upstream length only holds for unencoded bodies.
  const names = ['content-type', 'content-range', 'accept-ranges']
  if (!upstream.headers.get('content-encoding')) names.push('content-length')
  for (const name of names) {
    const value = upstream.headers.get(name)
    if (value) out[name] = value
  }
  res.writeHead(upstream.status, out)
  if (!upstream.body) {
    res.end()
    return
  }
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res)
}

export function rewritePlaylist (text, baseURL, id) {
  const absolute = uri => {
    try { return proxyURL(id, new URL(uri, baseURL).href) } catch { return uri }
  }
  return text.split(/\r?\n/).map(line => {
    const trimmed = line.trim()
    if (!trimmed) return line
    if (trimmed.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${absolute(uri)}"`)
    return absolute(trimmed)
  }).join('\n')
}

/** Index of the first MPEG-TS packet (0x47 sync byte repeating every 188 bytes), or -1. */
export function tsSyncOffset (data) {
  const limit = data.length - 188 * 3
  for (let i = 0; i < limit; i++) {
    if (data[i] === 0x47 && data[i + 188] === 0x47 && data[i + 376] === 0x47) return i
  }
  return -1
}
