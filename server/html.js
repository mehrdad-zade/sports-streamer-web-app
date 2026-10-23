// Tiny regex-based helpers. The pages we scrape are simple enough that a full DOM parser isn't needed.

/** All matches of `pattern` (case-insensitive, dot matches newlines) with their index and groups. */
export function matches (pattern, text, flags = 'gis') {
  const regex = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g')
  const out = []
  for (const m of text.matchAll(regex)) out.push({ index: m.index, length: m[0].length, groups: [...m] })
  return out
}

export function firstGroup (pattern, text) {
  const m = matches(pattern, text)[0]
  return m ? m.groups.slice(1).find(g => g != null) ?? null : null
}

/** `{href, inner}` of every `<a>` element. */
export function anchors (html) {
  return matches(String.raw`<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>`, html)
    .map(m => ({ href: decodeEntities(m.groups[1]), inner: m.groups[2] ?? '' }))
}

/** Visible text chunks, in document order. */
export function textNodes (html) {
  let text = html
  for (const pattern of [String.raw`<script\b.*?</script>`, String.raw`<style\b.*?</style>`, String.raw`<svg\b.*?</svg>`]) {
    text = text.replace(new RegExp(pattern, 'gis'), '\n')
  }
  text = text.replace(/<[^>]+>/g, '\n')
  return decodeEntities(text)
    .split(/\r?\n|\r/)
    .map(s => s.replace(/^[ \t ]+|[ \t ]+$/g, ''))
    .filter(Boolean)
}

const NAMED = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&#039;': "'" }

export function decodeEntities (s) {
  if (!s.includes('&')) return s
  let out = s
  for (const [k, v] of Object.entries(NAMED)) out = out.split(k).join(v)
  return out.replace(/&#(x?)([0-9a-f]+);/gi, (whole, hex, digits) => {
    const code = parseInt(digits, hex ? 16 : 10)
    try { return Number.isFinite(code) ? String.fromCodePoint(code) : whole } catch { return whole }
  })
}

export function bareHost (url) {
  return (url.hostname || '').toLowerCase().replace('www.', '')
}

export function sameSite (a, b) {
  return bareHost(a) === bareHost(b)
}

/** Resolves `href` against `base`; null for anything unparseable. */
export function resolveURL (href, base) {
  try { return new URL(href, base) } catch { return null }
}

/** Seconds/milliseconds since 1970, ISO 8601, or "yyyy-MM-dd HH:mm[:ss]" (UTC). Returns epoch ms or null. */
export function parseDate (raw) {
  raw = raw?.trim()
  if (!raw) return null
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw)
    return n > 1e11 ? n : n * 1000
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.test(raw)) {
    const iso = raw.replace(' ', 'T')
    const t = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : iso + 'Z')
    return Number.isNaN(t) ? null : t
  }
  return null
}
