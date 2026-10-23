// Loads an embed page in headless Chrome and watches every frame for an HLS manifest request.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { allowsNavigation, isBlocked, popupBlockerScript } from './adBlocker.js'
import { isPlayableManifest, USER_AGENT } from './fetcher.js'
import { bareHost } from './html.js'

const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ]
}

export const chromePath = [process.env.CHROME_PATH, ...(CHROME_CANDIDATES[process.platform] ?? [])]
  .find(p => p && fs.existsSync(p)) ?? null

let browserPromise = null

function browser () {
  browserPromise ??= puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-features=Translate,MediaRouter', '--no-first-run', '--no-default-browser-check']
  }).then(b => {
    b.on('disconnected', () => { browserPromise = null })
    return b
  }, err => {
    browserPromise = null
    throw err
  })
  return browserPromise
}

export async function closeBrowser () {
  const b = await browserPromise?.catch(() => null)
  await b?.close().catch(() => {})
}

/**
 * Returns a playable stream `{url, referer, origin, userAgent, cookies}` found by loading `page`, or null.
 * Resolves early when `signal` aborts.
 */
export async function sniff (page, referer, { timeout = 20_000, signal } = {}) {
  if (!chromePath || signal?.aborted) return null
  let context
  try {
    context = await (await browser()).createBrowserContext()
  } catch (err) {
    console.error('Could not start headless Chrome:', err.message)
    return null
  }

  return new Promise(resolve => {
    let done = false
    const reported = new Set()
    const finish = stream => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      context.close().catch(() => {})
      resolve(stream)
    }
    const onAbort = () => finish(null)
    const timer = setTimeout(() => finish(null), timeout)
    signal?.addEventListener('abort', onAbort)

    const candidate = (url, frameURL, requestHeaders) => {
      if (done || reported.has(url) || url.startsWith('blob:') || url.startsWith('data:')) return
      reported.add(url)
      validate(context, url, frameURL, requestHeaders, () => done).then(stream => { if (stream) finish(stream) })
    }

    run(context, page, referer, candidate, () => done).catch(() => {
      // Navigation failures before the page commits mean there's nothing to sniff.
      if (!done && !reported.size) finish(null)
    })
  })
}

async function run (context, url, referer, candidate, isDone) {
  let tab = null
  // Pop-ups and new tabs never get to load.
  context.on('targetcreated', async target => {
    if (target.type() !== 'page') return
    const opened = await target.page().catch(() => null)
    if (opened && tab && opened !== tab) opened.close().catch(() => {})
  })

  tab = await context.newPage()
  let committedHost = null
  await tab.setUserAgent(USER_AGENT)
  await tab.setViewport({ width: 400, height: 225 })
  await tab.evaluateOnNewDocument(popupBlockerScript)
  await tab.evaluateOnNewDocument(hookScript)
  await tab.exposeFunction('__ssReport', (u, frameURL) => candidate(u, frameURL, null)).catch(() => {})
  await tab.setRequestInterception(true)

  tab.on('request', request => {
    if (request.isInterceptResolutionHandled()) return
    const reqURL = request.url()
    if (isBlocked(reqURL)) return request.abort('blockedbyclient').catch(() => {})
    if (request.isNavigationRequest()) {
      const isMain = request.frame() === tab.mainFrame()
      if (!allowsNavigation(reqURL, isMain, committedHost)) return request.abort('blockedbyclient').catch(() => {})
    }
    if (/^https?:/i.test(reqURL) && /m3u8/i.test(reqURL)) candidate(reqURL, request.frame()?.url(), request.headers())
    request.continue().catch(() => {})
  })
  tab.on('response', response => {
    const type = response.headers()['content-type'] ?? ''
    if (/mpegurl/i.test(type)) candidate(response.url(), response.frame()?.url(), response.request().headers())
  })
  tab.on('framenavigated', frame => {
    if (frame === tab.mainFrame() && !committedHost) {
      try { committedHost = bareHost(new URL(frame.url())) } catch {}
    }
  })
  tab.on('dialog', dialog => dialog.dismiss().catch(() => {}))

  if (isDone()) return
  await tab.goto(url, { referer: referer ?? undefined, waitUntil: 'domcontentloaded', timeout: 20_000 })
}

async function validate (context, urlString, framePage, requestHeaders, isDone) {
  let url
  try { url = new URL(urlString) } catch { return null }
  let frameURL = null
  try { frameURL = framePage ? new URL(framePage) : null } catch {}
  const origin = frameURL ? frameURL.origin : null

  let cookies = ''
  try {
    const all = await context.cookies?.() ?? []
    cookies = all.filter(c => url.hostname.endsWith(c.domain.replace(/^\./, ''))).map(c => `${c.name}=${c.value}`).join('; ')
  } catch {}

  const ua = USER_AGENT
  const attempts = []
  if (requestHeaders) {
    // Exactly what the player sent is the most likely to work.
    attempts.push({ referer: requestHeaders.referer ?? null, origin: requestHeaders.origin ?? null })
  }
  attempts.push(
    { referer: frameURL ? `${frameURL.protocol}//${frameURL.host}/` : null, origin },
    { referer: framePage ?? null, origin },
    { referer: null, origin: null }
  )
  for (const attempt of attempts) {
    if (isDone()) return null
    const stream = { url: url.href, ...attempt, userAgent: ua, cookies }
    if (await isPlayableManifest(stream)) return stream
  }
  return null
}

/** Injected into every frame: reports any URL containing "m3u8" seen via fetch, XHR, media src or resource timing. */
const hookScript = `
(function(){
  if (window.__ssHooked) return; window.__ssHooked = true;
  var seen = {};
  function report(u){
    try {
      if (!u) return; u = String(u);
      if (u.indexOf('blob:') === 0 || u.indexOf('data:') === 0) return;
      var abs = new URL(u, location.href).href;
      if (!/^https?:/i.test(abs) || !/m3u8/i.test(abs) || seen[abs]) return;
      seen[abs] = 1;
      if (window.__ssReport) window.__ssReport(abs, location.href);
    } catch(e) {}
  }
  try { var of = window.fetch; if (of) window.fetch = function(i){ try { report(typeof i === 'string' ? i : (i && i.url)); } catch(e){} return of.apply(this, arguments); }; } catch(e){}
  try { var oo = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function(m, u){ report(u); return oo.apply(this, arguments); }; } catch(e){}
  function hookSrc(proto){
    try {
      var d = Object.getOwnPropertyDescriptor(proto, 'src');
      Object.defineProperty(proto, 'src', { configurable: true,
        get: function(){ return d.get.call(this); },
        set: function(v){ report(v); return d.set.call(this, v); } });
    } catch(e){}
  }
  hookSrc(HTMLMediaElement.prototype); hookSrc(HTMLSourceElement.prototype);
  try { var sa = Element.prototype.setAttribute; Element.prototype.setAttribute = function(n, v){ if (n && String(n).toLowerCase() === 'src') report(v); return sa.apply(this, arguments); }; } catch(e){}
  var ticks = 0;
  setInterval(function(){
    ticks++;
    try { document.querySelectorAll('video, source').forEach(function(v){ report(v.currentSrc || v.src); if (v.tagName === 'VIDEO') v.muted = true; }); } catch(e){}
    try { performance.getEntriesByType('resource').forEach(function(e){ report(e.name); }); } catch(e){}
    if (ticks === 3 || ticks === 8) {
      // Some players only load the manifest after "play" is pressed.
      try {
        document.querySelectorAll('.vjs-big-play-button, .jw-icon-display, .jw-display-icon-container, .plyr__control--overlaid, .fp-play, .play-button, .playbtn, #play, [aria-label="Play"], video')
          .forEach(function(el){ try { el.click(); } catch(e){} });
        document.querySelectorAll('video').forEach(function(v){ v.muted = true; var p = v.play(); if (p && p.catch) p.catch(function(){}); });
      } catch(e){}
    }
  }, 700);
})();
`
