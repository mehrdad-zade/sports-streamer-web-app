// Event helpers shared by the server (sorting, filtering ended events) and the browser (search, LIVE badges).
// An event is plain JSON: {url, title, subtitle, teams, start, end, statusText, sport}; start/end are epoch ms or null.

export function isLive (event, now = Date.now()) {
  if (event.start != null) {
    const end = event.end ?? event.start + 3 * 3600_000
    return now >= event.start - 10 * 60_000 && now <= end
  }
  return /live/i.test(event.statusText ?? '')
}

export function hasEnded (event, now = Date.now()) {
  return event.end != null && now > event.end
}

function fold (s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Every word of the query must appear somewhere ("real bet" -> Real Betis). */
export function matches (event, query) {
  const q = query.trim()
  if (!q) return true
  const haystack = fold([event.title, event.subtitle ?? '', event.sport ?? '', ...event.teams].join(' '))
  return q.split(/\s+/).every(word => haystack.includes(fold(word)))
}

/** Live first, then by start time, then events without a time, then by title. */
export function compareEvents (a, b, now = Date.now()) {
  const al = isLive(a, now)
  const bl = isLive(b, now)
  if (al !== bl) return al ? -1 : 1
  if (a.start != null && b.start != null && a.start !== b.start) return a.start - b.start
  if (a.start != null && b.start == null) return -1
  if (a.start == null && b.start != null) return 1
  return a.title < b.title ? -1 : a.title > b.title ? 1 : 0
}
