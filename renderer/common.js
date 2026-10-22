/* Shared by renderer.js and popover.js (classic scripts share this top-level scope). */
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)]
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const ic = (n, cls = '') => `<svg class="i${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${n}"/></svg>`
const L = window.SSMLogic
const fmt = n => Number(n).toLocaleString()
const day = ms => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })
const hm = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const secs = t => Math.max(0, Math.ceil((t.nextAt - Date.now()) / 1e3))

// Snapshot -> view model. Tunnel env is mapped to the mock keys (prod|stg|other) used by CSS classes and data-env.
function normalize(snap) {
  const tunnels = snap.tunnels.map(t => ({ ...t, env: L.envToMock(t.env) }))
  return {
    snap,
    tunnels,
    shown: tunnels.filter(t => !t.archived),
    archived: tunnels.filter(t => t.archived),
    terminal: snap.terminal || [],
    settings: snap.settings || {},
    notice: (snap.notice || []).filter(n => tunnels.some(t => t.name === n && t.archived)),
  }
}
