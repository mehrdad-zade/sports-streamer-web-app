// Heuristically extracts event links from a listing page.
import { anchors, decodeEntities, matches, parseDate, firstGroup, resolveURL, sameSite, textNodes } from './html.js'

const eventPathPrefixes = new Set(['event', 'events', 'match', 'matches', 'watch', 'live', 'game', 'games', 'stream', 'streams', 'fixture', 'fixtures'])
const nonCategoryPaths = new Set(['news', 'blog', 'about', 'contact', 'dmca', 'privacy', 'privacy-policy', 'terms', 'faq', 'login', 'register', 'signup', 'daily', 'schedule', 'sitemap', 'search', 'tos', 'disclaimer'])
const noiseText = /^(view|watch|watch now|vs\.?|v|live|live now!?|hd|sd|more|details|go|-|:)$/i
const statusText = /(live|starts? in|started|ended|finished|full ?time|half ?time|postponed|cancel+ed|^\d{1,2}:\d{2}(:\d{2})?( ?[ap]m)?$|^\d+'$)/i

export function pathParts (url) {
  return url.pathname.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p) } catch { return p } })
}

function httpURL (href, base) {
  const url = resolveURL(href, base)
  return url && /^https?:$/.test(url.protocol) ? url : null
}

export function parseEvents (html, pageURL, sport = null) {
  const base = new URL(pageURL)
  const byURL = new Map()

  for (const anchor of anchors(html)) {
    const url = httpURL(anchor.href, base)
    if (!url || !sameSite(url, base) || !looksLikeEvent(url)) continue
    url.hash = ''
    const event = makeEvent(url, anchor.inner, sport)
    const existing = byURL.get(event.url)
    if (!existing) {
      byURL.set(event.url, event)
    } else if (event.teams.length > existing.teams.length || (existing.start == null && event.start != null)) {
      byURL.set(event.url, event) // Map keeps the original insertion position.
    }
  }
  return [...byURL.values()]
}

/** Same-site single-segment links that look like sport categories (e.g. /football, /nba). */
export function categoryLinks (html, pageURL) {
  const base = new URL(pageURL)
  const seen = new Set()
  const result = []
  for (const anchor of anchors(html)) {
    const url = httpURL(anchor.href, base)
    if (!url || !sameSite(url, base) || looksLikeEvent(url)) continue
    const parts = pathParts(url)
    if (parts.length !== 1) continue
    const slug = parts[0].toLowerCase()
    if (nonCategoryPaths.has(slug) || slug.includes('.') || url.search) continue
    const text = textNodes(anchor.inner).join(' ')
    if (!text || text.length > 24) continue
    if (!seen.has(slug)) {
      seen.add(slug)
      url.hash = ''
      result.push({ url: url.href, name: text })
    }
  }
  return result.slice(0, 15)
}

export function looksLikeEvent (url) {
  const parts = pathParts(url).map(p => p.toLowerCase())
  if (!parts.length) return false
  if (parts.length >= 2 && eventPathPrefixes.has(parts[0])) return true
  const path = url.pathname.toLowerCase()
  return path.includes('-vs-') || path.includes('_vs_') || path.includes('-v-')
}

function makeEvent (url, inner, sport) {
  const start = parseDate(firstGroup(String.raw`data-(?:start|start-time|time|date|timestamp)\s*=\s*["']([^"']+)["']`, inner) ??
                          firstGroup(String.raw`datetime\s*=\s*["']([^"']+)["']`, inner))
  const end = parseDate(firstGroup(String.raw`data-(?:end|end-time)\s*=\s*["']([^"']+)["']`, inner))

  const texts = textNodes(inner)
  const status = texts.find(t => statusText.test(t)) ?? null

  // Prefer logo alt texts ("Real Madrid Logo"), fall back to visible text.
  let teams = matches(String.raw`<img\b[^>]*\balt\s*=\s*["']([^"']+)["']`, inner)
    .map(m => m.groups[1])
    .filter(Boolean)
    .map(alt => decodeEntities(alt).replace(/\s*(logo|icon|badge|flag)$/i, ''))
    .filter(t => t && !noiseText.test(t))
  if (!teams.length) {
    teams = texts.filter(t => t !== status && !noiseText.test(t) && t.length > 1)
    // "Team A vs Team B" in a single node.
    if (teams.length === 1) teams = splitVersus(teams[0]) ?? teams
  }
  teams = [...new Set(teams)]

  const isVersus = url.pathname.toLowerCase().includes('vs') ||
    (teams.length === 2 && texts.some(t => t.toLowerCase().startsWith('vs')))
  let title
  let subtitle = null
  if (teams.length >= 2 && isVersus) {
    title = `${teams[0]} vs ${teams[1]}`
  } else if (teams.length) {
    title = teams[0]
    subtitle = teams.length > 1 ? teams.slice(1).join(' · ') : null
  } else {
    title = humanize(pathParts(url).at(-1) ?? url.hostname)
  }

  return { url: url.href, title, subtitle, teams, start, end, statusText: status, sport }
}

function splitVersus (text) {
  const parts = text.split(' vs ').flatMap(p => p.split(' v ')).map(p => p.trim()).filter(Boolean)
  return parts.length === 2 ? parts : null
}

function humanize (slug) {
  return slug.replaceAll('-vs-', ' vs ')
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => w === 'vs' ? w : w[0].toUpperCase() + w.slice(1))
    .join(' ')
}
