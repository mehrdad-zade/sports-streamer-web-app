// User settings, persisted as JSON in ~/.sports-streamer-web/settings.json.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_SITE_URL = 'https://footy4u.st/'
const RECHECK_INTERVALS = [30, 60, 120, 300]
const dir = path.join(os.homedir(), '.sports-streamer-web')
const file = path.join(dir, 'settings.json')

/** Adds https:// when missing; null unless it parses as a URL with a host. */
export function normalizeSiteURL (raw) {
  let text = String(raw ?? '').trim()
  if (!text) return null
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text
  try {
    const url = new URL(text)
    return url.hostname ? url.href : null
  } catch {
    return null
  }
}

export class Settings {
  constructor () {
    this.siteURL = DEFAULT_SITE_URL
    // Seconds between re-checks of the other sources while a stream is playing.
    this.recheckInterval = 60
    // Automatically jump to another live source when the current one fails.
    this.autoSwitch = true
    try { this.apply(JSON.parse(fs.readFileSync(file, 'utf8'))) } catch {}
  }

  get resolvedSiteURL () { return normalizeSiteURL(this.siteURL) }

  apply (patch) {
    if (typeof patch.siteURL === 'string') this.siteURL = normalizeSiteURL(patch.siteURL) ?? this.siteURL
    if (RECHECK_INTERVALS.includes(Number(patch.recheckInterval))) this.recheckInterval = Number(patch.recheckInterval)
    if (typeof patch.autoSwitch === 'boolean') this.autoSwitch = patch.autoSwitch
  }

  update (patch) {
    this.apply(patch)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(this.toJSON(), null, 2))
  }

  toJSON () {
    return { siteURL: this.siteURL, recheckInterval: this.recheckInterval, autoSwitch: this.autoSwitch, defaultSiteURL: DEFAULT_SITE_URL }
  }
}
