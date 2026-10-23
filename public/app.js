// Sports Streamer UI: event list, watch page with automatic source failover, and settings.
import { isLive, matches } from './event.js'

const $ = selector => document.querySelector(selector)
const app = $('#app')
const searchInput = $('#search')
const clearButton = $('#clear-btn')
const nextButton = $('#next-btn')
const recheckButton = $('#recheck-btn')

const ICONS = {
  warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 1.5 21h21zm-1 6.5h2v6h-2zm0 7.5h2v2h-2z"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 5h2v2h-2zm0 4h2v6h-2z"/></svg>',
  chevron: '<svg class="chevron stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>',
  court: '<svg class="big stroke" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="1.5"/><path d="M12 5v14"/><circle cx="12" cy="12" r="2.6"/><path d="M2.5 9h3v6h-3M21.5 9h-3v6h3"/></svg>',
  search: '<svg class="big stroke" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></svg>',
  play: '<svg class="now" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM9.5 7.5l7 4.5-7 4.5z"/></svg>',
  globe: '<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>'
}

const state = {
  events: [],
  error: null,
  loading: false,
  loadedOnce: false,
  query: '',
  canExtract: true,
  settings: null,
  watch: null // the active WatchSession
}

// MARK: - API

async function api (method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function loadEvents (reload = false) {
  state.loading = true
  render()
  try {
    const data = await api('GET', '/api/events' + (reload ? '?reload=1' : ''))
    state.events = data.events
    state.error = data.error
  } catch (err) {
    state.error = `Couldn't reach the app server: ${err.message}`
  }
  state.loading = false
  state.loadedOnce = true
  render()
}

// MARK: - Helpers

function escapeHTML (s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function relativeTime (ms) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' })

function watchHash (url) {
  return '#/watch/' + encodeURIComponent(url)
}

function currentRoute () {
  const m = location.hash.match(/^#\/watch\/(.+)$/)
  if (!m) return { name: 'list' }
  try { return { name: 'watch', url: decodeURIComponent(m[1]) } } catch { return { name: 'list' } }
}

// MARK: - List view

function renderList () {
  const events = state.events.filter(e => matches(e, state.query))
  const now = Date.now()
  const live = events.filter(e => isLive(e, now))
  const upcoming = events.filter(e => !isLive(e, now))

  let html = '<div class="list-view"><h1 class="page-title">Live Sports</h1>'
  if (state.error && !state.loading) html += `<div class="banner">${ICONS.warning}<span>${escapeHTML(state.error)}</span></div>`
  if (live.length) html += section('Live now', live, now)
  if (upcoming.length) html += section('Upcoming', upcoming, now)

  if (state.loading && !state.events.length) {
    html += '<div class="empty"><div><span class="spinner"></span><p style="margin-top:12px">Finding events…</p></div></div>'
  } else if (!events.length && state.query.trim()) {
    html += `<div class="empty"><div>${ICONS.search}<h2>No results for “${escapeHTML(state.query.trim())}”</h2><p>Check the spelling or try a new search.</p></div></div>`
  } else if (!events.length && !state.error && state.loadedOnce && !state.loading) {
    html += `<div class="empty"><div>${ICONS.court}<h2>No events</h2><p>Press Home to refresh.</p></div></div>`
  }
  html += '</div>'
  app.innerHTML = html
}

function section (title, events, now) {
  return `<h2 class="section-title">${title}</h2><div class="event-grid">${events.map(e => eventRow(e, now)).join('')}</div>`
}

function eventRow (event, now) {
  const meta = [event.sport, event.subtitle].filter(Boolean).map(t => `<span>${escapeHTML(t)}</span>`).join('')
  let trailing = ''
  if (isLive(event, now)) {
    trailing = '<span class="live-pill">LIVE</span>'
  } else if (event.start != null) {
    const date = new Date(event.start)
    trailing = `<div class="event-time"><div class="time">${timeFormat.format(date)}</div><div class="day">${dayFormat.format(date)}</div></div>`
  }
  return `<a class="event" href="${watchHash(event.url)}">
    <div class="event-text"><div class="event-title">${escapeHTML(event.title)}</div>${meta ? `<div class="event-meta">${meta}</div>` : ''}</div>
    ${trailing}${ICONS.chevron}
  </a>`
}

// MARK: - Watch session (failover logic mirrors the iOS WatchSession)

class WatchSession {
  constructor (eventURL) {
    this.eventURL = eventURL
    this.event = state.events.find(e => e.url === eventURL) ?? null
    this.id = null
    this.sources = []
    this.isLoadingSources = true
    this.completedPasses = 0
    this.currentID = null
    this.mode = 'native' // 'native' (hls.js through the proxy) or 'web' (the embed page itself)
    this.notice = null
    this.isAutomaticWebFallback = false // true when we fell back to the web player because nothing could be extracted
    this.isBuffering = false
    this.stopped = false
    this.hls = null
    this.stallTimer = null
    this.playingURL = null
    this.stream = null
  }

  get title () {
    if (this.event) return this.event.title
    const slug = new URL(this.eventURL).pathname.split('/').filter(Boolean).at(-1) ?? ''
    return slug.replace(/-vs-/g, ' vs ').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Event'
  }

  get currentSource () { return this.sources.find(s => s.id === this.currentID) ?? null }
  get aliveSources () { return this.sources.filter(s => s.status === 'alive') }

  nextAlive (after) {
    const alive = this.aliveSources.filter(s => s.id !== after)
    if (after == null) return alive[0] ?? null
    return alive.find(s => s.id > after) ?? alive[0] ?? null
  }

  async start () {
    try {
      const data = await api('POST', '/api/watch', { url: this.eventURL })
      if (this.stopped) {
        api('POST', '/api/watch/stop', { id: data.id }).catch(() => {})
        return
      }
      this.id = data.id
      this.apply(data)
      this.stream = new EventSource('/api/watch/events?id=' + encodeURIComponent(this.id))
      this.stream.addEventListener('sources', e => this.apply(JSON.parse(e.data)))
      this.stream.onerror = () => {
        if (this.stream?.readyState === EventSource.CLOSED && !this.stopped) {
          this.notice = 'Lost contact with the app server. Is it still running?'
          renderWatch()
        }
      }
    } catch (err) {
      this.isLoadingSources = false
      this.notice = `Couldn't open this event: ${err.message}`
      renderWatch()
    }
  }

  stop () {
    this.stopped = true
    this.stream?.close()
    this.stopPlayer()
    if (this.id) navigator.sendBeacon?.('/api/watch/stop', new Blob([JSON.stringify({ id: this.id })], { type: 'application/json' }))
  }

  apply (data) {
    const previous = new Map(this.sources.map(s => [s.id, s]))
    const passes = this.completedPasses
    this.sources = data.sources
    this.isLoadingSources = data.isLoadingSources
    this.completedPasses = data.completedPasses
    if (data.loadError) this.notice ??= `Couldn't read the event page (${data.loadError}). Trying it directly.`

    for (const source of this.sources) {
      if (source.status === 'alive' && previous.get(source.id)?.status !== 'alive') this.sourceBecameAlive(source)
    }
    if (passes === 0 && this.completedPasses >= 1) this.passFinished()
    if (!state.canExtract && !this.isLoadingSources && this.currentID == null && this.sources.length) this.fallBackToWeb()
    renderWatch()
  }

  sourceBecameAlive (source) {
    const nothingPlaying = this.currentID == null || (this.mode === 'web' && this.isAutomaticWebFallback)
    if (!nothingPlaying) return
    this.isAutomaticWebFallback = false
    this.currentID = source.id
    this.mode = 'native'
    this.notice = null
    this.play(source)
  }

  passFinished () {
    if (this.currentID != null || !this.sources.length) return
    this.fallBackToWeb()
  }

  fallBackToWeb () {
    this.notice = state.canExtract
      ? "Couldn't extract a direct stream. Showing the web player; sources keep being checked."
      : 'Chrome was not found on this computer, so streams open in the web player.'
    this.currentID = this.sources[0].id
    this.mode = 'web'
    this.isAutomaticWebFallback = true
  }

  /** User picked a source. */
  select (source) {
    this.isAutomaticWebFallback = false
    this.currentID = source.id
    this.notice = null
    if (source.status === 'alive' && source.playURL) {
      this.mode = 'native'
      this.play(source)
    } else {
      // Not (yet) extractable: show the page itself in the sandboxed web player.
      this.stopPlayer()
      this.mode = 'web'
    }
    renderWatch()
  }

  showInWebPlayer (source) {
    this.isAutomaticWebFallback = false
    this.currentID = source.id
    this.notice = null
    this.stopPlayer()
    this.mode = 'web'
    renderWatch()
  }

  switchToNextAlive () {
    const next = this.nextAlive(this.currentID)
    if (next) this.select(next)
  }

  recheck () {
    if (this.id) api('POST', '/api/watch/recheck', { id: this.id }).catch(() => {})
  }

  currentStreamFailed () {
    const failed = this.currentID
    if (failed == null) return
    this.stopPlayer()
    const source = this.sources.find(s => s.id === failed)
    if (source) Object.assign(source, { status: 'dead', playURL: null, lastChecked: Date.now() })
    if (this.id) api('POST', '/api/watch/dead', { id: this.id, sourceId: failed }).catch(() => {})
    const next = state.settings?.autoSwitch !== false ? this.nextAlive(failed) : null
    if (next) {
      this.select(next)
      this.notice = `Source ${failed + 1} stopped. Switched to source ${next.id + 1}.`
    } else {
      this.currentID = null
      this.mode = 'native'
      this.notice = `Source ${failed + 1} stopped. Looking for another live source…`
      this.recheck()
    }
    renderWatch()
  }

  // MARK: Player

  play (source) {
    this.stopPlayer()
    this.playingURL = source.playURL
    this.pendingPlay = true // attached by renderWatch once the <video> exists
  }

  attachVideo (video) {
    if (!this.pendingPlay || !this.playingURL) return
    this.pendingPlay = false
    const url = this.playingURL
    const onFatal = () => { if (this.playingURL === url) this.currentStreamFailed() }

    if (window.Hls?.isSupported()) {
      const hls = new window.Hls({ liveDurationInfinity: true, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 3, fragLoadingMaxRetry: 3 })
      let recovered = false
      hls.on(window.Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
          recovered = true
          hls.recoverMediaError()
        } else {
          onFatal()
        }
      })
      hls.loadSource(url)
      hls.attachMedia(video)
      this.hls = hls
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url // Safari plays HLS natively.
      video.addEventListener('error', onFatal, { once: true })
    } else {
      this.notice = 'This browser cannot play HLS streams.'
      return
    }

    video.addEventListener('waiting', () => this.bufferingChanged(true, url))
    video.addEventListener('playing', () => this.bufferingChanged(false, url))
    video.addEventListener('ended', onFatal)
    const attempt = video.play()
    attempt?.catch(err => {
      // Autoplay with sound needs a recent click; fall back to muted playback.
      if (err.name === 'NotAllowedError' && this.playingURL === url) {
        video.muted = true
        video.play().catch(() => {})
      }
    })
    this.bufferingChanged(true, url)
  }

  bufferingChanged (waiting, url) {
    if (this.playingURL !== url) return
    this.isBuffering = waiting
    $('#buffering')?.toggleAttribute('hidden', !waiting)
    clearTimeout(this.stallTimer)
    if (waiting) this.stallTimer = setTimeout(() => { if (this.playingURL === url) this.currentStreamFailed() }, 20_000)
  }

  stopPlayer () {
    clearTimeout(this.stallTimer)
    this.hls?.destroy()
    this.hls = null
    this.playingURL = null
    this.pendingPlay = false
    this.isBuffering = false
    const video = $('#player-video')
    if (video) {
      video.removeAttribute('src')
      video.load()
    }
  }
}

function statusText (status) {
  return { unknown: 'Not checked yet', checking: 'Checking…', alive: 'Live', dead: 'Offline' }[status] ?? status
}

function searchStatus (session) {
  if (session.isLoadingSources) return 'Opening event page…'
  if (!session.sources.length) return 'No sources found'
  const checked = session.sources.filter(s => s.lastChecked != null).length
  return `Finding a live stream… checked ${checked} of ${session.sources.length}`
}

let renderedPlayerKey = null

function renderWatch () {
  const session = state.watch
  if (!session || currentRoute().name !== 'watch') return

  let view = app.querySelector('.watch-view')
  if (!view) {
    app.innerHTML = `<div class="watch-view">
      <h1 class="watch-title"></h1>
      <div class="player" id="player"></div>
      <section class="sources" aria-label="Sources">
        <div id="notice"></div>
        <h2 class="sources-header" id="sources-header"></h2>
        <ul class="source-list" id="source-list"></ul>
        <p class="sources-footer" id="sources-footer"></p>
      </section>
    </div>`
    view = app.querySelector('.watch-view')
    renderedPlayerKey = null
  }
  view.querySelector('.watch-title').textContent = session.title
  document.title = session.title

  // Player: only rebuilt when what it shows changes, so playback isn't interrupted by status updates.
  const source = session.currentSource
  const playerKey = session.mode === 'web' && source
    ? 'web:' + source.pageURL
    : session.playingURL ? 'native:' + session.playingURL : 'search'
  const player = $('#player')
  if (playerKey !== renderedPlayerKey) {
    renderedPlayerKey = playerKey
    if (playerKey.startsWith('web:')) {
      player.innerHTML = `<iframe src="${escapeHTML(source.pageURL)}" title="Web player"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-forms"
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="no-referrer"></iframe>`
    } else if (playerKey.startsWith('native:')) {
      player.innerHTML = `<video id="player-video" controls playsinline autoplay></video>
        <div class="player-overlay" id="buffering"><span class="spinner"></span></div>`
      session.attachVideo($('#player-video'))
    } else {
      player.innerHTML = '<div class="player-overlay"><span class="spinner"></span><span id="search-status"></span></div>'
    }
  }
  if (playerKey === 'search') $('#search-status').textContent = searchStatus(session)
  if (playerKey.startsWith('native:')) $('#buffering')?.toggleAttribute('hidden', !session.isBuffering)

  $('#notice').innerHTML = session.notice ? `<div class="banner info" style="margin:0 0 14px">${ICONS.info}<span>${escapeHTML(session.notice)}</span></div>` : ''
  $('#sources-header').textContent = `Sources (${session.aliveSources.length} live)`
  $('#sources-footer').textContent = `Sources are re-checked every ${state.settings?.recheckInterval ?? 60}s while you watch. Use the globe button to open a source in the web player.`
  $('#source-list').innerHTML = session.sources.map(s => sourceRow(session, s)).join('') ||
    (session.isLoadingSources ? '<li><div class="source"><span class="spinner small"></span><span class="source-main">Loading sources…</span></div></li>' : '')

  nextButton.disabled = !session.nextAlive(session.currentID)
}

function sourceRow (session, s) {
  const dot = s.status === 'checking' ? '<span class="spinner"></span>' : `<span class="dot ${s.status}"></span>`
  const current = s.id === session.currentID
  const marker = current ? (session.mode === 'web' ? ICONS.globe.replace('class="stroke"', 'class="stroke now"') : ICONS.play) : ''
  return `<li class="source-row${current ? ' current' : ''}">
    <button type="button" class="source" data-play="${s.id}">
      <span class="dot-wrap">${dot}</span>
      <span class="source-main">
        <div class="source-title">Source ${s.id + 1} · ${escapeHTML(s.label)}</div>
        <div class="source-host">${escapeHTML(s.host)}</div>
      </span>
      <span class="source-status">
        <b class="${s.status}">${statusText(s.status)}</b>
        ${s.lastChecked ? `<small>${relativeTime(s.lastChecked)}</small>` : ''}
      </span>
      ${marker}
    </button>
    <button type="button" class="web-btn" data-web="${s.id}" aria-label="Open source ${s.id + 1} in web player" title="Open in web player">${ICONS.globe}</button>
  </li>`
}

app.addEventListener('click', e => {
  const session = state.watch
  if (!session) return
  const play = e.target.closest('[data-play]')
  const web = e.target.closest('[data-web]')
  const id = Number((play ?? web)?.dataset.play ?? (play ?? web)?.dataset.web)
  const source = session.sources.find(s => s.id === id)
  if (!source) return
  if (web) session.showInWebPlayer(source)
  else session.select(source)
})

// MARK: - Routing

function render () {
  const route = currentRoute()
  const watching = route.name === 'watch'
  for (const button of document.querySelectorAll('.watch-only')) button.hidden = !watching
  if (watching) {
    if (state.watch?.eventURL !== route.url) {
      state.watch?.stop()
      state.watch = new WatchSession(route.url)
      app.innerHTML = ''
      renderWatch()
      state.watch.start()
    } else {
      renderWatch()
    }
  } else {
    if (state.watch) {
      state.watch.stop()
      state.watch = null
    }
    document.title = 'Live Sports'
    renderList()
  }
}

window.addEventListener('hashchange', () => {
  render()
  window.scrollTo(0, 0)
})
window.addEventListener('pagehide', () => state.watch?.stop())

// Keep "checked 12s ago" and LIVE badges fresh.
setInterval(() => {
  if (state.watch) renderWatch()
  else if (!document.activeElement?.closest?.('.event')) renderList()
}, 15_000)

// MARK: - Top bar

function goHome () {
  state.query = ''
  searchInput.value = ''
  clearButton.hidden = true
  searchInput.blur()
  if (location.hash && location.hash !== '#/') location.hash = '#/'
  loadEvents(true)
}

$('#home-btn').addEventListener('click', goHome)
nextButton.addEventListener('click', () => state.watch?.switchToNextAlive())
recheckButton.addEventListener('click', () => state.watch?.recheck())

searchInput.addEventListener('input', () => {
  state.query = searchInput.value
  clearButton.hidden = !state.query
  if (currentRoute().name === 'list') renderList()
})
$('#search-form').addEventListener('submit', e => {
  e.preventDefault()
  if (currentRoute().name === 'watch') location.hash = '#/'
  searchInput.blur()
})
clearButton.addEventListener('click', () => {
  searchInput.value = ''
  state.query = ''
  clearButton.hidden = true
  searchInput.focus()
  if (currentRoute().name === 'list') renderList()
})
document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement === document.body) {
    e.preventDefault()
    searchInput.focus()
  }
})

// MARK: - Settings

const dialog = $('#settings')
const siteInput = $('#site-url')
const testButton = $('#test-site')
const testResult = $('#test-result')
const saveButton = $('#settings-save')

function normalizedDraft () {
  let text = siteInput.value.trim()
  if (!text) return null
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text
  try { return new URL(text).hostname ? text : null } catch { return null }
}

function updateDraftState () {
  const valid = Boolean(normalizedDraft())
  saveButton.disabled = !valid
  testButton.disabled = !valid
}

$('#settings-btn').addEventListener('click', () => {
  const s = state.settings
  siteInput.value = s?.siteURL ?? ''
  $('#recheck-interval').value = String(s?.recheckInterval ?? 60)
  $('#auto-switch').checked = s?.autoSwitch ?? true
  testResult.hidden = true
  updateDraftState()
  dialog.showModal()
})
siteInput.addEventListener('input', updateDraftState)
$('#settings-cancel').addEventListener('click', () => dialog.close())
$('#reset-site').addEventListener('click', () => {
  siteInput.value = state.settings?.defaultSiteURL ?? ''
  updateDraftState()
})
testButton.addEventListener('click', async () => {
  const spinner = testButton.querySelector('.spinner')
  spinner.hidden = false
  testButton.disabled = true
  try {
    testResult.textContent = (await api('POST', '/api/settings/test', { siteURL: normalizedDraft() })).message
  } catch (err) {
    testResult.textContent = `Couldn't load: ${err.message}`
  }
  testResult.hidden = false
  spinner.hidden = true
  updateDraftState()
})
$('#settings-form').addEventListener('submit', async e => {
  e.preventDefault()
  const site = normalizedDraft()
  if (!site) return
  const previousSite = state.settings?.siteURL
  try {
    state.settings = await api('POST', '/api/settings', {
      siteURL: site,
      recheckInterval: Number($('#recheck-interval').value),
      autoSwitch: $('#auto-switch').checked
    })
  } catch (err) {
    testResult.textContent = err.message
    testResult.hidden = false
    return
  }
  dialog.close()
  if (state.settings.siteURL !== previousSite) {
    if (currentRoute().name === 'watch') location.hash = '#/'
    state.events = []
    loadEvents(true)
  } else {
    render()
  }
})

// MARK: - Start

api('GET', '/api/info').then(info => {
  state.canExtract = info.canExtract
  state.settings = info.settings
}).catch(() => {})
render()
loadEvents()
