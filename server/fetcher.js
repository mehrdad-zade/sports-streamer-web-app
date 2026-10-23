// HTTP helpers for scraping and for checking that an extracted stream still answers.
export const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

/** Returns the page HTML and the final URL after redirects. */
export async function fetchHTML (url, referer = null) {
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8'
  }
  if (referer) headers.Referer = String(referer)
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20_000) })
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`)
  return { html: await res.text(), finalURL: res.url || String(url) }
}

/**
 * A playable stream: the media URL plus the HTTP context needed to fetch it outside the page that found it.
 * `{url, referer, origin, userAgent, cookies}` where cookies is a "name=value; …" header string.
 */
export function streamHeaders (stream) {
  const headers = { 'User-Agent': stream.userAgent || USER_AGENT }
  if (stream.referer) headers.Referer = stream.referer
  if (stream.origin) headers.Origin = stream.origin
  if (stream.cookies) headers.Cookie = stream.cookies
  return headers
}

/** Lightweight liveness check for an HLS manifest. */
export async function isPlayableManifest (stream) {
  try {
    const res = await fetch(stream.url, { headers: streamHeaders(stream), signal: AbortSignal.timeout(10_000) })
    if (res.status < 200 || res.status >= 300) return false
    const reader = res.body.getReader()
    const { value } = await reader.read()
    reader.cancel().catch(() => {})
    if (!value?.length) return false
    const prefix = Buffer.from(value.subarray(0, 64)).toString('utf8')
    if (stream.url.toLowerCase().includes('m3u8') || prefix.includes('#EXTM3U')) return prefix.includes('#EXTM3U')
    return true
  } catch {
    return false
  }
}
