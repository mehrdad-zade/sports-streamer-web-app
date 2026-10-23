// Ad/popup protection for the headless pages that probe stream sources.
import { bareHost } from './html.js'

const blockedDomains = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com', 'popads.net', 'popcash.net',
  'propellerads.com', 'onclickads.net', 'onclkds.com', 'exoclick.com', 'exosrv.com', 'juicyads.com', 'adcash.com',
  'hilltopads.net', 'acscdn.com', 'adsterra.com', 'adsterratech.com', 'clickadu.com', 'monetag.com', 'a-ads.com',
  'outbrain.com', 'taboola.com', 'adnxs.com', 'mgid.com', 'revcontent.com', 'trafficjunky.net', 'realsrv.com',
  'highperformanceformat.com', 'profitabledisplaynetwork.com', 'displayvertising.com', 'bidgear.com', 'ad-maven.com',
  'admaven.com', 'pushwhy.com', 'richads.com', 'zeydoo.com', 'galaksion.com', 'clickaine.com', 'dtscout.com',
  'histats.com', 'yandex.ru/ads', 'aclib.net', 'magsrv.com', 'popunder.net', 'ezoic.net'
]

const domainRules = blockedDomains.map(d => new RegExp('^https?://([^/]*\\.)?' + d.replaceAll('.', '\\.'), 'i'))
const popunderRule = /(popunder|popads|\/pop\.js|runpop|clickunder)/i

/** Ad networks plus pop-under scripts. */
export function isBlocked (url) {
  return popunderRule.test(url) || domainRules.some(r => r.test(url))
}

/**
 * Navigation policy: no weird schemes, and once the page has committed, no top-level jumps to another host
 * (the classic "click anywhere -> ad site" redirect).
 */
export function allowsNavigation (url, isMainFrame, committedHost) {
  let parsed
  try { parsed = new URL(url) } catch { return false }
  const scheme = parsed.protocol.slice(0, -1)
  if (['about', 'blob', 'data'].includes(scheme)) return true
  if (!['http', 'https'].includes(scheme)) return false
  return !(isMainFrame && committedHost && bareHost(parsed) !== committedHost)
}

/** Kills `window.open` so pop-ups/pop-unders never get a window. */
export const popupBlockerScript = `
(function(){
  try { window.open = function(){ return null; }; } catch(e) {}
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[target=_blank]') : null;
    if (a) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
})();
`
