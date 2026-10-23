// Builds the event list from the site's homepage plus its sport category pages.
import { compareEvents, hasEnded } from '../public/event.js'
import { categoryLinks, parseEvents } from './eventListParser.js'
import { fetchHTML } from './fetcher.js'

export class EventStore {
  constructor () {
    this.events = []
    this.error = null
    this.loadedSite = null
    this.loading = null
  }

  /** Shares one in-flight load; a different site or `force` starts a new one. */
  async get (site, { force = false } = {}) {
    if (this.loading && this.loading.site === site) return this.loading.promise
    if (!force && site === this.loadedSite && this.events.length) return this.snapshot()
    const promise = this.load(site).finally(() => { if (this.loading?.promise === promise) this.loading = null })
    this.loading = { site, promise }
    return promise
  }

  snapshot () {
    return { events: this.events, error: this.error, site: this.loadedSite }
  }

  async load (site) {
    if (!site) {
      this.events = []
      this.error = 'Add a valid site URL in Settings.'
      this.loadedSite = null
      return this.snapshot()
    }
    const host = new URL(site).hostname
    try {
      const home = await fetchHTML(site)
      const merged = parseEvents(home.html, home.finalURL)

      // Category pages (/football, /nba, …) usually list more events than the homepage.
      const categories = categoryLinks(home.html, home.finalURL)
      const categoryEvents = (await Promise.all(categories.map(async category => {
        try {
          const page = await fetchHTML(category.url, site)
          return parseEvents(page.html, page.finalURL, displayName(category.name))
        } catch {
          return []
        }
      }))).flat()

      const index = new Map(merged.map((e, i) => [e.url, i]))
      for (const event of categoryEvents) {
        const i = index.get(event.url)
        if (i != null) {
          merged[i].sport ??= event.sport
        } else {
          index.set(event.url, merged.length)
          merged.push(event)
        }
      }

      const now = Date.now()
      this.events = merged.filter(e => !hasEnded(e, now)).sort((a, b) => compareEvents(a, b, now))
      this.loadedSite = site
      this.error = this.events.length ? null : `No events found on ${host}.`
    } catch (err) {
      this.error = `Couldn't load ${host}: ${err.cause?.message || err.message}`
      if (this.loadedSite !== site) this.events = []
    }
    return this.snapshot()
  }

  /** Counts for the Settings "Test site" button. */
  static async test (site) {
    const page = await fetchHTML(site)
    return {
      events: parseEvents(page.html, page.finalURL).length,
      categories: categoryLinks(page.html, page.finalURL).length
    }
  }
}

function displayName (raw) {
  return raw === raw.toUpperCase() && raw.length > 3
    ? raw.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase())
    : raw
}
