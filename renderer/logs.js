/* Logs view (main window). Thin DOM wiring: all grouping, ordering, filtering and formatting lives in logic.js (window.SSMLogic).
   Classic script: shares $/$$/L (common.js) and toast/announce/copy/M/view (renderer.js) through the global scope; those are only touched at call time.
   Log text is arbitrary, so every node is built with createElement + textContent. There is no innerHTML in this file. */
const LOG_DEFAULT = { q: '', level: 'all', source: 'both', range: '7d' }
const LOG_POLL_MS = 2000
const LOG_COPY_MAX = 10000 // ssm.copy rejects longer strings (lib/ipc.js)
const LOG_LV = { info: ['info', 'Info'], warn: ['warn', 'Warning'], error: ['x', 'Error'] }
const LOG_ENV = { prod: ['PROD', 'Production'], stg: ['Staging', 'Staging'], other: ['Other', 'Other'] }

let logF = { ...LOG_DEFAULT }
let logShown = null          // {entries}: what the list is built from
let logStash = null          // latest fetch, applied when Live resumes or "Show" is pressed
let logInfo = null           // logs:info result
let logErr = null            // last read error message; the previous data stays on screen
let logLoaded = false, logLive = true, logOn = false, logPending = 0
let logSeq = 0, logInFlight = 0, logTimer = null, logSig = ''
let logFresh = new Set()
const logOpen = new Map()    // group key -> expanded (survives filtering and refreshes)
const logOpenE = new Set()   // entry ids with the raw JSON expanded

const SVG_NS = 'http://www.w3.org/2000/svg'
function lgIcon(name, cls) {
  const s = document.createElementNS(SVG_NS, 'svg'), u = document.createElementNS(SVG_NS, 'use')
  s.setAttribute('class', 'i' + (cls ? ' ' + cls : '')); s.setAttribute('aria-hidden', 'true'); u.setAttribute('href', '#i-' + name); s.append(u)
  return s
}
function lgEl(tag, props, ...kids) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue
    if (k === 'class') n.className = v; else if (k === 'data') Object.assign(n.dataset, v); else n.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid)
  return n
}
const lgDShort = ms => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
const lgFull = ms => `${lgDShort(ms)} ${new Date(ms).getFullYear()}, ${L.logHms(ms)}`
const lgPlural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/* ---------- elements ---------- */
function lgHead(g, i, now, tunnels) {
  const open = logOpen.get(g.key) === true, t = g.key ? tunnels.find(x => x.name === g.key) : null, env = L.logGroupEnv(g.key, tunnels)
  const pill = L.logErrorPill(g, now), last = g.last, [lvIcon] = LOG_LV[last.level]
  const cnt = g.vis.length === g.total ? lgPlural(g.total, 'entry', 'entries') : `${g.vis.length} of ${g.total}`
  const tags = !g.key ? [lgEl('span', { class: 'kind' }, lgIcon('tunnel'), 'App and CLI')]
    : !t ? [lgEl('span', { class: 'kind', title: 'Not in the tunnel list any more' }, lgIcon('x'), 'Deleted')]
      : [env === 'prod' ? lgEl('span', { class: 'badge prod', title: 'Production — live data' }, 'PROD') : lgEl('span', { class: 'badge env' }, LOG_ENV[env][0]),
        lgEl('span', { class: 'kind' }, lgIcon(L.kind(t)[1]), L.kind(t)[0]), t.archived && lgEl('span', { class: 'kind' }, lgIcon('archive'), 'Archived')]
  const aria = `${g.name}${t ? ', ' + LOG_ENV[env][1] : g.key ? ', deleted tunnel' : ''}, ${cnt}${pill ? `, ${lgPlural(pill.count, 'error', 'errors')}` : ''}, last event ${L.ago(last.ms, now)}: ${L.logEventLabel(last)}`
  const btn = lgEl('button', { class: 'lg-h' + (g.vis.some(e => logFresh.has(e.id)) ? ' new' : ''), type: 'button', data: { lg: 'g', k: g.key }, 'aria-expanded': String(open), 'aria-controls': open ? `lg-g${i}` : null, 'aria-label': aria, title: `${open ? 'Collapse' : 'Expand'} · ⌥-click for all groups` },
    lgIcon('chev', 'chev'),
    lgEl('span', { class: 'lg-t' }, lgEl('b', null, g.name), tags, pill && lgEl('span', { class: 'lg-err' + (pill.hot ? '' : ' old'), title: pill.hot ? 'Errors in the last 24 hours' : 'No errors in the last 24 hours' }, lgIcon('x'), lgPlural(pill.count, 'error', 'errors'))),
    lgEl('span', { class: 'lg-m' }, `${cnt} · `, lgEl('span', { title: lgFull(last.ms) }, L.ago(last.ms, now))),
    lgEl('span', { class: `lg-s lv-${last.level}` }, lgIcon(lvIcon), lgEl('b', null, L.logEventLabel(last)), lgEl('span', null, last.message)))
  return lgEl('h2', { class: 'lg-hw' }, btn)
}
function lgEntry(e, n) {
  const open = logOpenE.has(e.id), [icon, lvText] = LOG_LV[e.level]
  const btn = lgEl('button', { class: `lg-e lv-${e.level}` + (logFresh.has(e.id) ? ' new' : ''), type: 'button', data: { lg: 'e', id: e.id }, 'aria-expanded': String(open), 'aria-controls': open ? `lg-d${n}` : null, title: lgFull(e.ms) },
    lgEl('time', { datetime: new Date(e.ms).toISOString() }, L.logHms(e.ms)),
    lgEl('span', { class: 'lv' }, lgIcon(icon), lgEl('span', { class: 'vh' }, lvText + ':')),
    lgEl('span', { class: 'ev' }, L.logEventLabel(e)), lgEl('span', { class: 'msg' }, e.message),
    lgEl('span', { class: 'src' + (e.source === 'cli' ? ' cli' : ''), title: `Written by ${e.source === 'cli' ? 'the ssm-tunnels CLI' : 'the app'}` }, e.source === 'cli' ? [lgIcon('term'), 'CLI'] : 'App'))
  const detail = open && lgEl('div', { class: 'lg-d', id: `lg-d${n}` },
    lgEl('pre', { class: 'cmd' }, JSON.stringify(e.raw, null, 2)),
    lgEl('div', null, lgEl('button', { class: 'btn sm', type: 'button', data: { lg: 'copyE', id: e.id } }, 'Copy Entry'), lgEl('span', { class: 'sub' }, 'The line as stored in the log file')))
  return lgEl('li', null, btn, detail)
}
function lgEntries(g, i, now) {
  let n = 0
  const items = L.logRows(g.vis, now).map(r => r.type === 'entry' ? lgEntry(r.e, `${i}-${n++}`)
    : lgEl('li', { class: 'lg-day' }, r.rel === 'today' ? `Today · ${lgDShort(r.ms)}` : r.rel === 'yesterday' ? `Yesterday · ${lgDShort(r.ms)}` : lgDShort(r.ms)))
  return lgEl('ul', { class: 'lg-es', id: `lg-g${i}`, 'aria-label': `${g.name} entries` }, items)
}
const lgState = (icon, ...kids) => lgEl('div', { class: 'empty' }, lgIcon(icon), ...kids)

/* ---------- render ---------- */
const lgFiltersDefault = () => logF.q.trim() === '' && logF.level === 'all' && logF.source === 'both' && logF.range === 'all'
function logsRender() {
  const list = $('#lgList'), now = Date.now(), entries = logShown ? logShown.entries : []
  const a = document.activeElement
  let refocus = null; if (a && a.dataset && a.dataset.lg && list.contains(a)) refocus = { ...a.dataset }
  const top = list.scrollTop
  const groups = L.buildLogGroups(entries, logF.q), st = L.logStatus(groups)
  const never = logLoaded && !entries.length && (logInfo ? logInfo.size === 0 : lgFiltersDefault())
  const tunnels = (typeof M !== 'undefined' && M && M.tunnels) || []

  $('#title').textContent = 'Logs'
  $('#subtitle').textContent = !logLoaded ? (logErr ? 'Couldn’t read the log' : 'Loading…') : never ? 'Nothing logged yet'
    : `${st.entries} ${st.entries === 1 ? 'entry' : 'entries'} · ${lgPlural(st.groups, 'group', 'groups')}${st.errors ? ` · ${lgPlural(st.errors, 'error', 'errors')}` : ''}${logLive ? '' : ' · Live paused'}`
  $$('#fLevel button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === logF.level))
  $$('#fSrc button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === logF.source))
  $('#fRange').value = logF.range
  const keys = groups.map(g => g.key)
  $$('.lg-bar button').forEach(b => b.disabled = never || !logLoaded)
  $('#fRange').disabled = never; $('#q').disabled = never
  $('#bExp').disabled = !keys.length || keys.every(k => logOpen.get(k)); $('#bCol').disabled = !keys.some(k => logOpen.get(k))
  $('#bCopy').disabled = !st.entries; $('#bLive').setAttribute('aria-pressed', logLive)

  const pend = $('#lgPend'); pend.hidden = logLive || !logPending
  if (!pend.hidden) pend.replaceChildren(lgIcon('pause'), lgEl('span', null, `${logPending} new · since Live was paused`), lgEl('span', { class: 'sp' }),
    lgEl('button', { class: 'btn sm', type: 'button', data: { l: 'showPend' } }, 'Show'), lgEl('button', { class: 'btn sm', type: 'button', data: { l: 'live' } }, 'Resume Live'))

  const kids = []
  if (logErr && logLoaded) kids.push(lgEl('div', { class: 'lg-note', role: 'status' }, lgEl('span', null, `Couldn’t refresh the log (${logErr}). Showing the entries loaded earlier.`), lgEl('span', { class: 'sp' }), lgEl('button', { class: 'btn sm', type: 'button', data: { l: 'retry' } }, 'Try Again')))
  if (!logLoaded) kids.push(logErr
    ? lgState('warn', `Couldn’t read the log: ${logErr}`, lgEl('br'), lgEl('br'), lgEl('button', { class: 'btn sm', type: 'button', data: { l: 'retry' } }, 'Try Again'))
    : lgState('logs', 'Loading the log…'))
  else if (never) kids.push(lgEl('div', { class: 'empty lg-none' }, lgIcon('logs'), lgEl('b', null, 'Nothing logged yet'),
    lgEl('p', null, 'Connects, drops, retries, auto-archive and changes made in the app or with the ', lgEl('span', { class: 'mono' }, 'ssm-tunnels'), ' CLI show up here, grouped by tunnel.'),
    lgEl('p', null, 'Only tunnel names, ports and PIDs are recorded, never commands or credentials.')))
  else if (!groups.length) kids.push(lgState('search', `No entries match ${L.logFilterDesc(logF)}.`, lgEl('br'), lgEl('br'), lgEl('button', { class: 'btn sm', type: 'button', data: { l: 'reset' } }, 'Reset Filters')))
  else groups.forEach((g, i) => {
    const prod = g.key && L.logGroupEnv(g.key, tunnels) === 'prod'
    kids.push(lgEl('section', { class: 'lg-g' + (prod ? ' prod' : '') }, lgHead(g, i, now, tunnels), logOpen.get(g.key) ? lgEntries(g, i, now) : null))
  })
  list.replaceChildren(...kids); list.scrollTop = top

  const ft = L.logFooter(logInfo)
  $('#lgFt').replaceChildren(...(ft ? [lgIcon('doc'), lgEl('span', { class: 'mono', title: ft.path }, ft.path), lgEl('span', null, `· ${ft.text}`)] : []))
  if (refocus) {
    const el = [...list.querySelectorAll('[data-lg]')].find(x => x.dataset.lg === refocus.lg && x.dataset.k === refocus.k && x.dataset.id === refocus.id)
    if (el) el.focus({ preventScroll: true })
  }
}

/* ---------- reading ---------- */
async function logsPoll(reset) {
  if (!reset && logInFlight) return
  const seq = ++logSeq; logInFlight++
  try {
    const [r, info] = await Promise.all([ssm.logsRead(L.logRequest(logF, Date.now())), ssm.logsInfo().catch(() => null)])
    if (seq !== logSeq) return
    if (!r || !r.ok) throw new Error((r && r.error) || 'The log is unavailable')
    logErr = null
    if (info && info.ok) logInfo = info
    const fetched = L.decorateLogs(r.entries), initial = !logLoaded
    logStash = fetched
    const res = L.logApplyPoll(reset || initial ? null : logShown, fetched, logLive)
    const grew = logPending < res.pending
    logShown = { entries: res.entries }; logLoaded = true; logPending = res.pending
    L.logSeedOpen(logOpen, L.buildLogGroups(res.entries, logF.q), Date.now(), { initial, fresh: res.fresh })
    if (res.fresh.size) { lgFlash(res.fresh); announce(L.logDescribeNew(res.entries.filter(e => res.fresh.has(e.id)))) }
    else if (grew) announce(`${lgPlural(res.pending, 'new entry', 'new entries')} waiting. Live is paused.`)
    const sig = [res.entries.length, res.entries[0] && res.entries[0].id, logPending, logInfo && logInfo.size, logLive].join('|')
    if (reset || initial || res.fresh.size || sig !== logSig) { logSig = sig; if (logOn) logsRender() }
  } catch (err) {
    if (seq !== logSeq) return
    const msg = err && err.message ? err.message : String(err)
    if (msg !== logErr) { logErr = msg; logSig = ''; if (logOn) logsRender() }
  } finally { logInFlight-- }
}
function lgFlash(ids) {
  ids.forEach(id => logFresh.add(id))
  setTimeout(() => { ids.forEach(id => logFresh.delete(id)); if (logOn) logsRender() }, 3000)
}

/* ---------- actions ---------- */
function lgApplyStash(focusNewest) {
  if (!logStash) return
  const res = L.logApplyPoll(logShown, logStash, true)
  logShown = { entries: res.entries }; logPending = 0
  L.logSeedOpen(logOpen, L.buildLogGroups(res.entries, logF.q), Date.now(), { fresh: res.fresh })
  if (res.fresh.size) lgFlash(res.fresh)
  logsRender()
  if (focusNewest && res.fresh.size) {
    const first = res.entries.find(e => res.fresh.has(e.id)), hd = first && [...$('#lgList').querySelectorAll('[data-lg="g"]')].find(x => x.dataset.k === (first.tunnel || ''))
    if (hd) { hd.focus(); hd.scrollIntoView({ block: 'nearest' }) }
  }
}
function lgRefetch() { logsRender(); logsPoll(true) }
function lgSetAll(on) {
  new Set((logShown ? logShown.entries : []).map(e => e.tunnel || '')).forEach(k => logOpen.set(k, on))
  logsRender(); announce(on ? 'All groups expanded' : 'All groups collapsed')
}
async function lgCopyVisible() {
  const text = L.logCopyText(L.buildLogGroups(logShown ? logShown.entries : [], logF.q)), total = text.split('\n').length
  if (!text) return
  if (text.length <= LOG_COPY_MAX) { await ssm.copy(text); return toast(`Copied ${lgPlural(total, 'entry', 'entries')} matching the filters, collapsed groups included`) }
  try { await navigator.clipboard.writeText(text); return toast(`Copied ${lgPlural(total, 'entry', 'entries')} matching the filters, collapsed groups included`) } catch (_) { /* fall back below */ }
  const fit = L.logClipFit(text, LOG_COPY_MAX); await ssm.copy(fit.text)
  toast(`Copied the newest ${fit.kept} of ${total} entries (the clipboard bridge is limited to ${fmt(LOG_COPY_MAX)} characters)`)
}
function lgAct(a, b, ev) {
  switch (a) {
    case 'lv': logF.level = b.dataset.v; return lgRefetch()
    case 'src': logF.source = b.dataset.v; return lgRefetch()
    case 'live': logLive = !logLive; announce(logLive ? 'Live on' : 'Live paused. New entries wait until you show them.'); if (logLive) lgApplyStash(false); else logsRender(); return
    case 'showPend': return lgApplyStash(true)
    case 'retry': return logsPoll(true)
    case 'expandAll': return lgSetAll(true)
    case 'collapseAll': return lgSetAll(false)
    case 'copyVis': return lgCopyVisible()
    case 'open': return ssm.logsOpen().then(r => { if (r && r.ok === false) toast(r.error || 'Couldn’t open the log file') })
    case 'reset': { logF = { ...LOG_DEFAULT }; $('#q').value = ''; lgRefetch(); const hd = $('#lgList [data-lg="g"]'); return hd ? hd.focus() : $('#q').focus() }
    case 'g': { const k = b.dataset.k; if (ev && ev.altKey) { lgSetAll(!logOpen.get(k)); return } logOpen.set(k, !logOpen.get(k)); return logsRender() }
    case 'e': { const id = b.dataset.id; logOpenE.has(id) ? logOpenE.delete(id) : logOpenE.add(id); return logsRender() }
    case 'copyE': { const e = logShown && logShown.entries.find(x => x.id === b.dataset.id); return e && copy(JSON.stringify(e.raw), '', b) }
  }
}
document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-l],[data-lg]')
  if (!b || b.disabled || !logOn) return
  lgAct(b.dataset.l || b.dataset.lg, b, ev)
})
$('#fRange').addEventListener('change', e => { logF.range = e.target.value; lgRefetch() })

/* ---------- keyboard ---------- */
$('#logsPane').addEventListener('keydown', e => {
  const k = e.key, t = e.target
  if (e.metaKey || e.ctrlKey || e.altKey || t.tagName === 'SELECT') return
  const hd = t.closest('.lg-h'), en = t.closest('.lg-e'); if (!hd && !en) return
  const heads = $$('#lgList .lg-h'), go = x => { e.preventDefault(); e.stopPropagation(); if (x) { x.focus(); x.scrollIntoView({ block: 'nearest' }) } }
  if (hd) {
    const i = heads.indexOf(hd), key = hd.dataset.k, open = !!logOpen.get(key)
    if (k === 'ArrowDown') return go(heads[i + 1]); if (k === 'ArrowUp') return go(heads[i - 1])
    if (k === 'Home') return go(heads[0]); if (k === 'End') return go(heads[heads.length - 1])
    if (k === 'ArrowRight') { if (open) return go($('.lg-e', hd.closest('.lg-g'))); e.preventDefault(); e.stopPropagation(); logOpen.set(key, true); return logsRender() }
    if (k === 'ArrowLeft' && open) { e.preventDefault(); e.stopPropagation(); logOpen.set(key, false); return logsRender() }
  } else {
    const sec = en.closest('.lg-g'), es = $$('.lg-e', sec), i = es.indexOf(en), head = $('.lg-h', sec)
    if (k === 'ArrowDown') return go(es[i + 1] || heads[heads.indexOf(head) + 1]); if (k === 'ArrowUp') return go(es[i - 1] || head); if (k === 'ArrowLeft') return go(head)
  }
})
document.addEventListener('keydown', e => {
  if (!logOn || $('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return
  const t = e.target, typing = t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'
  if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus() }
})
$('#q').addEventListener('input', e => { if (!logOn) return; logF.q = e.target.value; logsRender() })
$('#q').addEventListener('keydown', e => { if (logOn && e.key === 'Escape') { logF.q = ''; logsRender() } })

/* ---------- lifecycle ---------- */
function logsStop() { clearInterval(logTimer); logTimer = null }
// Called by renderer.js render(): starts polling when the Logs view is shown, stops it when another view is, and redraws while shown.
// Polling runs while the view is visible and the window is not hidden; a paused Live still polls so the "N new" count is real.
function logsSync(on) {
  if (on !== logOn) {
    logOn = on
    const q = $('#q'); q.disabled = false
    q.placeholder = on ? 'Tunnel, event, message…' : 'Name, host, port…'; $('.search .vh').textContent = on ? 'Search logs' : 'Search tunnels'
    if (on) { q.value = logF.q; logsStop(); logTimer = setInterval(() => { if (!document.hidden) logsPoll(false) }, LOG_POLL_MS); logsPoll(true) }
    else { logsStop(); q.value = typeof query === 'string' ? query : '' }
  }
  if (on) logsRender()
}
document.addEventListener('visibilitychange', () => { if (logOn && !document.hidden) logsPoll(false) })
