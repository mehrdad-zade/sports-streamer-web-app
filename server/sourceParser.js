// Extracts candidate stream/embed links from an event page.
import { bareHost, decodeEntities, matches, resolveURL, sameSite, textNodes } from './html.js'

const blockedHosts = ['discord', 't.me', 'telegram', 'twitter.com', 'x.com', 'facebook', 'instagram', 'reddit',
  'tiktok', 'whatsapp', 'google', 'gstatic', 'cloudflare', 'jsdelivr', 'unpkg', 'schema.org',
  'w3.org', 'apple.com', 'wikipedia', 'youtube.com/@']
const assetExtensions = new Set(['css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'json', 'xml', 'txt', 'map'])
const streamHint = /(embed|stream|player|live|watch|channel|\/ch\b|[?&]ch=|\/ch\d|\.php|hls|m3u8|ppv|\/tv\b|event|\/e\/|\/v\/)/
const buttonText = /^(watch|watch now|play|go|open|link|stream|view|click here|▶)$/i

/** Sources are `{id, pageURL, embedURL, label, host}`: the link as it appeared, and its unwrapped embed URL. */
export function parseSources (html, pageURL) {
  const base = new URL(pageURL)
  const rows = matches(String.raw`<tr\b[^>]*>(.*?)</tr>`, html).map(m => ({
    start: m.index,
    end: m.index + m.length,
    label: textNodes(m.groups[1] ?? '').find(t => !buttonText.test(t) && t.length > 1) ?? null
  }))

  const candidates = []
  const attr = String.raw`\b(?:href|src|data-src|data-url|data-link|data-iframe|data-stream|data-embed)\s*=\s*["']([^"'<>\s]+)["']`
  for (const m of matches(attr, html)) {
    const page = resolveURL(decodeEntities(m.groups[1]), base)
    if (!page || !/^https?:$/.test(page.protocol)) continue
    const embed = unwrap(page)
    const wrapped = embed.href !== page.href
    if (!isCandidate(embed, base, wrapped)) continue
    candidates.push({ page, embed, wrapped, position: m.index })
  }

  const strong = candidates.filter(c => c.wrapped || hasStreamHint(c.embed))
  const chosen = strong.length ? strong : candidates

  const seen = new Set()
  const sources = []
  for (const c of chosen) {
    const key = c.embed.href.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const rowLabel = rows.find(r => c.position >= r.start && c.position < r.end)?.label
    const host = bareHost(c.embed) || 'source'
    sources.push({ id: sources.length, pageURL: c.page.href, embedURL: c.embed.href, label: rowLabel ?? host, host })
  }

  if (!sources.length) {
    // Some sites embed the player directly on the event page.
    sources.push({ id: 0, pageURL: base.href, embedURL: base.href, label: 'Event page', host: bareHost(base) })
  }
  return sources
}

/** `https://wrapper/view.php?src=https://embed/x?id=1` -> `https://embed/x?id=1` (also handles percent/base64 encoding). */
export function unwrap (url) {
  const query = url.search.slice(1)
  if (!query) return url
  const m = query.match(/=(https?(:|%3A)\S*)/i)
  if (m) {
    let value = m[1]
    if (/^https?%3a/i.test(value)) {
      try { value = decodeURIComponent(value) } catch {}
    }
    const inner = resolveURL(value)
    if (inner?.hostname) return unwrap(inner)
  }
  for (const [, v] of url.searchParams) {
    if (!v.startsWith('aHR0c')) continue
    let b64 = v
    while (b64.length % 4) b64 += '='
    const decoded = Buffer.from(b64, 'base64').toString('utf8')
    const inner = resolveURL(decoded)
    if (inner?.hostname && /^https?:$/.test(inner.protocol)) return unwrap(inner)
  }
  return url
}

function isCandidate (url, pageURL, wrapped) {
  const full = url.href.toLowerCase()
  if (blockedHosts.some(h => full.includes(h))) return false
  const ext = url.pathname.split('/').at(-1).split('.').slice(1).at(-1)?.toLowerCase()
  if (ext && assetExtensions.has(ext)) return false
  if (sameSite(url, pageURL)) {
    // Same-site links are navigation, unless they clearly point at a player.
    return !wrapped && /(embed|player|\/stream\/)/.test(url.pathname.toLowerCase())
  }
  return true
}

function hasStreamHint (url) {
  return streamHint.test(url.href.toLowerCase())
}
