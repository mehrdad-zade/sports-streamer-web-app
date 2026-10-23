import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareEvents, isLive, matches } from '../public/event.js'
import { categoryLinks, looksLikeEvent, parseEvents } from '../server/eventListParser.js'
import { decodeEntities, parseDate, textNodes } from '../server/html.js'
import { rewritePlaylist, tsSyncOffset } from '../server/hlsProxy.js'
import { normalizeSiteURL } from '../server/settings.js'
import { parseSources, unwrap } from '../server/sourceParser.js'

const home = `
<nav><a href="/football">Football</a><a href="/nba">NBA</a><a href="/privacy">Privacy</a><a href="https://other.com/x">x</a></nav>
<a href="/events/real-madrid-vs-real-betis">
  <time datetime="2030-01-01T20:00:00Z"></time><img src="a.png" alt="Real Madrid Logo"><span>vs</span><img src="b.png" alt="Real Betis Logo"><span>Starts in: 01:00</span>
</a>
<a href="/events/real-madrid-vs-real-betis#top">Real Madrid vs Real Betis</a>
<a href="/events/f1-grand-prix"><span>F1 Grand Prix</span><span>Live Now!</span></a>
<a href="/watch/team-a-vs-team-b"><div>Team A vs Team B</div></a>
`

test('parses events from a listing page', () => {
  const events = parseEvents(home, 'https://site.test/')
  assert.deepEqual(events.map(e => e.title), ['Real Madrid vs Real Betis', 'F1 Grand Prix', 'Team A vs Team B'])
  assert.equal(events[0].start, Date.parse('2030-01-01T20:00:00Z'))
  assert.equal(events[0].statusText, 'Starts in: 01:00')
  assert.deepEqual(events[0].teams, ['Real Madrid', 'Real Betis'])
  assert.equal(events[1].statusText, 'Live Now!')
  assert.ok(isLive(events[1]))
  assert.ok(!isLive(events[0]))
})

test('finds sport category pages', () => {
  assert.deepEqual(categoryLinks(home, 'https://www.site.test/').map(c => c.name), ['Football', 'NBA'])
})

test('recognises event URLs', () => {
  assert.ok(looksLikeEvent(new URL('https://s.test/events/x')))
  assert.ok(looksLikeEvent(new URL('https://s.test/a-vs-b')))
  assert.ok(!looksLikeEvent(new URL('https://s.test/events')))
  assert.ok(!looksLikeEvent(new URL('https://s.test/football')))
})

test('search requires every word, ignoring case and accents', () => {
  const event = { title: 'Stuttgart vs Borussia Mönchengladbach', subtitle: null, sport: 'Soccer', teams: [] }
  assert.ok(matches(event, 'monchen stutt'))
  assert.ok(matches(event, 'soccer'))
  assert.ok(!matches(event, 'stuttgart real'))
  assert.ok(matches(event, '  '))
})

test('sorts live events first, then by start time', () => {
  const now = Date.parse('2030-01-01T12:00:00Z')
  const live = { title: 'B', start: now - 1000, end: null }
  const later = { title: 'A', start: now + 7200_000, end: null }
  const untimed = { title: 'C', start: null, end: null }
  assert.deepEqual([untimed, later, live].sort((a, b) => compareEvents(a, b, now)).map(e => e.title), ['B', 'A', 'C'])
})

test('unwraps wrapper links, including percent and base64 encoding', () => {
  assert.equal(unwrap(new URL('https://wrap.test/view.php?src=https://embed.test/x?id=1')).href, 'https://embed.test/x?id=1')
  assert.equal(unwrap(new URL('https://wrap.test/v?u=https%3A%2F%2Fembed.test%2Fch1')).href, 'https://embed.test/ch1')
  const b64 = Buffer.from('https://embed.test/b64').toString('base64').replace(/=+$/, '')
  assert.equal(unwrap(new URL(`https://wrap.test/v?id=${b64}`)).href, 'https://embed.test/b64')
})

test('parses stream sources and labels them from their table row', () => {
  const page = `
    <table>
      <tr><td>Sky Sports HD</td><td><a href="https://hitcast.test/totview.php?src=https://streame.test/embed/ch49.php">Watch</a></td></tr>
      <tr><td>Backup</td><td><a href="https://flyembed.test/embed/41.php">Watch</a></td></tr>
    </table>
    <a href="https://discord.gg/abc">Discord</a>
    <link href="https://cdn.test/style.css">
    <a href="/football">Football</a>`
  const sources = parseSources(page, 'https://site.test/events/x')
  assert.deepEqual(sources.map(s => [s.label, s.host, s.embedURL]), [
    ['Sky Sports HD', 'streame.test', 'https://streame.test/embed/ch49.php'],
    ['Backup', 'flyembed.test', 'https://flyembed.test/embed/41.php']
  ])
  assert.equal(sources[0].pageURL, 'https://hitcast.test/totview.php?src=https://streame.test/embed/ch49.php')
})

test('falls back to the event page when it has no sources', () => {
  assert.deepEqual(parseSources('<p>nothing</p>', 'https://site.test/events/x').map(s => s.label), ['Event page'])
})

test('rewrites playlist URIs through the proxy', () => {
  const playlist = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nseg1.ts\nhttps://cdn.test/seg2.ts\n'
  const out = rewritePlaylist(playlist, 'https://media.test/live/index.m3u8', 'abc')
  assert.match(out, /URI="\/proxy\/abc\?u=https%3A%2F%2Fmedia\.test%2Flive%2Fkey\.bin"/)
  assert.match(out, /\n\/proxy\/abc\?u=https%3A%2F%2Fmedia\.test%2Flive%2Fseg1\.ts\n/)
  assert.match(out, /\n\/proxy\/abc\?u=https%3A%2F%2Fcdn\.test%2Fseg2\.ts\n/)
})

test('finds MPEG-TS packets behind a fake image header', () => {
  const data = Buffer.alloc(100 + 188 * 4)
  for (let i = 0; i < 4; i++) data[100 + 188 * i] = 0x47
  assert.equal(tsSyncOffset(data), 100)
  assert.equal(tsSyncOffset(Buffer.alloc(1000)), -1)
})

test('html helpers', () => {
  assert.equal(decodeEntities('A &amp; B &#233; &#x41;'), 'A & B é A')
  assert.deepEqual(textNodes('<div>One<script>x()</script><b> Two </b></div>'), ['One', 'Two'])
  assert.equal(parseDate('1700000000'), 1700000000000)
  assert.equal(parseDate('1700000000000'), 1700000000000)
  assert.equal(parseDate('2030-01-01 20:00'), Date.parse('2030-01-01T20:00:00Z'))
  assert.equal(parseDate('nope'), null)
})

test('normalizes site addresses', () => {
  assert.equal(normalizeSiteURL('footy4u.st'), 'https://footy4u.st/')
  assert.equal(normalizeSiteURL(' '), null)
})
