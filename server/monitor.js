// Parses an event's sources and keeps re-checking which ones are actually streaming.
import { EventEmitter } from 'node:events'
import { fetchHTML, isPlayableManifest } from './fetcher.js'
import { bareHost } from './html.js'
import { parseSources } from './sourceParser.js'
import { sniff } from './sniffer.js'
import { proxyURL, registerStream } from './hlsProxy.js'

const MAX_CONCURRENT_CHECKS = 3

export class SourceMonitor extends EventEmitter {
  constructor (eventURL, interval) {
    super()
    this.eventURL = eventURL
    this.interval = interval
    this.sources = []
    this.isLoadingSources = false
    this.completedPasses = 0
    this.loadError = null
    this.stopped = false
    this.inFlight = new Set()
    this.abort = new AbortController()
    this.wake = null
  }

  /** What the browser sees: no raw stream headers, just the proxy id for live sources. */
  toJSON () {
    return {
      sources: this.sources.map(({ stream, ...s }) => s),
      isLoadingSources: this.isLoadingSources,
      completedPasses: this.completedPasses,
      loadError: this.loadError
    }
  }

  changed () {
    if (!this.stopped) this.emit('change', this.toJSON())
  }

  async start () {
    await this.loadSources()
    while (!this.stopped) {
      await this.checkAll()
      if (this.stopped) break
      this.completedPasses++
      this.changed()
      await new Promise(resolve => {
        const timer = setTimeout(resolve, Math.max(15, this.interval()) * 1000)
        this.wake = () => { clearTimeout(timer); resolve() }
      })
      this.wake = null
    }
  }

  stop () {
    this.stopped = true
    this.abort.abort()
    this.wake?.()
    this.removeAllListeners()
  }

  recheckNow () {
    this.checkAll()
  }

  markDead (id) {
    const source = this.sources.find(s => s.id === id)
    if (!source) return
    source.status = 'dead'
    source.streamId = null
    source.playURL = null
    source.stream = null
    source.lastChecked = Date.now()
    this.changed()
  }

  async loadSources () {
    this.isLoadingSources = true
    this.changed()
    try {
      const page = await fetchHTML(this.eventURL)
      this.sources = parseSources(page.html, page.finalURL).map(fresh)
      this.loadError = null
    } catch (err) {
      this.loadError = err.cause?.message || err.message
      this.sources = [fresh({ id: 0, pageURL: this.eventURL, embedURL: this.eventURL, label: 'Event page', host: bareHost(new URL(this.eventURL)) })]
    }
    this.isLoadingSources = false
    this.changed()
  }

  async checkAll () {
    const pending = this.sources.map(s => s.id)
    const worker = async () => {
      while (pending.length && !this.stopped) await this.check(pending.shift())
    }
    await Promise.all(Array.from({ length: MAX_CONCURRENT_CHECKS }, worker))
  }

  async check (id) {
    const source = this.sources.find(s => s.id === id)
    if (this.stopped || !source || this.inFlight.has(id)) return
    this.inFlight.add(id)
    try {
      // Cheap path: a known-good manifest that still answers is still alive.
      if (source.stream && await isPlayableManifest(source.stream)) {
        source.lastChecked = Date.now()
        this.changed()
        return
      }

      if (source.status !== 'alive') {
        source.status = 'checking'
        this.changed()
      }
      const signal = this.abort.signal
      let result = await sniff(source.pageURL, this.eventURL, { signal })
      if (!result && source.embedURL !== source.pageURL && !this.stopped) {
        result = await sniff(source.embedURL, source.pageURL, { signal })
      }
      if (this.stopped) return
      source.lastChecked = Date.now()
      if (result) {
        source.status = 'alive'
        source.stream = result
        source.streamId = registerStream(result)
        source.playURL = proxyURL(source.streamId, result.url)
      } else {
        source.status = 'dead'
        source.stream = null
        source.streamId = null
        source.playURL = null
      }
      this.changed()
    } finally {
      this.inFlight.delete(id)
    }
  }
}

function fresh (source) {
  return { ...source, status: 'unknown', lastChecked: null, streamId: null, playURL: null, stream: null }
}
