/* Main window: the mockup's UI driven by window.ssm (see preload.js). `ssm` resolves to the
   contextBridge global; it is not redeclared because a non-configurable global would make that a SyntaxError. */
const { live, busy, failing, visible } = L
const ENVS = L.ENV_LABELS
const VIEWS = { logs: 'Logs', all: 'All Tunnels', active: 'Connected', attn: 'Needs Attention', prod: 'Production', stg: 'Staging', other: 'Other', archived: 'Archived' }
const REGIONS = window.SSMValidate.AWS_REGIONS
const CONN_FIELDS = ['target', 'region', 'host', 'port', 'local']

let M = null, view = 'all', query = '', selName = null, menuFrom = null, impOverrides = {}
const retrying = new Map() // name -> last attempt seen while reconnecting (for the "reconnected" toast)
const portCache = new Map() // local port -> {inUse, at}

const byName = n => M && M.tunnels.find(t => t.name === n)
const now = () => Date.now()
const q = s => CSS.escape(s)
const viewLabel = () => VIEWS[view] || `Bastion ${L.shortId(view)}`
const tunnelData = t => ({ name: t.name, region: t.region, target: t.target, host: t.host, port: t.port, local: t.local, desc: t.desc || '', env: L.envToCanon(t.env), auto: !!t.auto, ...(t.profile ? { profile: t.profile } : {}) })
const firstError = r => Object.values((r && r.errors) || {})[0]

/* ---------- ports ---------- */
// Who holds a local port right now? (live saved tunnel or Terminal session)
function owner(port, selfName, skipTermId) {
  const t = M.tunnels.find(x => x.name !== selfName && !x.archived && live(x) && +x.local === +port)
  if (t) return { label: t.name }
  const u = M.terminal.find(x => x.id !== skipTermId && +x.local === +port)
  return u ? { label: `Terminal session (PID ${u.pid})` } : null
}
const takenPorts = (selfName, skipTermId) => new Set([
  ...M.tunnels.filter(x => x.name !== selfName).map(x => +x.local),
  ...M.terminal.filter(x => x.id !== skipTermId).map(x => +x.local),
  ...[...portCache].filter(([, c]) => c.inUse && now() - c.at < 30e3).map(([p]) => p)])
const suggestSync = (remote, selfName, skipTermId) => L.suggestPort(remote, takenPorts(selfName, skipTermId))
async function portInUse(port, ttl = 3000) {
  const c = portCache.get(+port)
  if (c && now() - c.at < ttl) return c.inUse
  const r = await ssm.checkPort(+port)
  portCache.set(+port, { inUse: !!(r && r.inUse), at: now() })
  return !!(r && r.inUse)
}
async function suggestFree(remote, selfName, skipTermId) {
  const taken = takenPorts(selfName, skipTermId)
  let p = L.suggestPort(remote, taken)
  for (let i = 0; i < 12 && await portInUse(p); i++) { taken.add(p); p = L.suggestPort(remote, taken) }
  return p
}

/* ---------- feedback ---------- */
let tt
function toast(msg, act) {
  const el = $('#toast'); el.innerHTML = `<span>${esc(msg)}</span>` + (act ? `<button type="button">${esc(act[0])}</button>` : '')
  if (act) el.querySelector('button').onclick = () => { el.classList.remove('show'); Promise.resolve(act[1]()).catch(failed) }
  el.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => el.classList.remove('show'), act ? 6000 : 2400); announce(msg)
}
function announce(m) { const l = $('#live'); l.textContent = ''; setTimeout(() => l.textContent = m, 40) }
const failed = err => toast(`Something went wrong: ${err && err.message ? err.message : err}`)
async function copy(text, label, btn) {
  try { await ssm.copy(text) } catch (_) { /* clipboard unavailable */ }
  if (btn) { const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => btn.textContent = o, 1200) } else toast(`Copied ${label || text}`)
}
async function refresh() { ingest(await ssm.getState()) }

/* ---------- actions ---------- */
async function toggle(t) {
  const s = t.state
  if (s === 'connecting') { await ssm.disconnect(t.name); return announce(`${t.name} cancelled`) }
  if (s === 'waiting') { await ssm.disconnect(t.name); return toast(`Stopped waiting for sign-in: ${t.name}`) }
  if (s === 'active' || s === 'reconnecting') {
    const ext = t.origin === 'terminal' && s === 'active'
    await ssm.disconnect(t.name)
    return toast(s === 'reconnecting' ? `Stopped retrying ${t.name}` : ext ? `Stopped ${t.name} (Terminal session)` : `Disconnected ${t.name}`)
  }
  const r = await ssm.connect(t.name)
  if (r && r.ok === false) toast(r.error || `Couldn’t connect ${t.name}`); else announce(`Connecting ${t.name}`)
}
async function fixPort(t) {
  const p = await suggestFree(t.port, t.name)
  const r = await ssm.saveTunnel({ ...tunnelData(t), local: p }, t.name)
  if (!r.ok) return toast(firstError(r) || 'Couldn’t change the local port')
  toast(`${t.name} now uses localhost:${p}`)
  if (failing(t)) await ssm.retry(t.name)
}
async function toggleAuto(t) {
  const on = !t.auto
  await ssm.setAuto(t.name, on)
  const s = on && M.shown.find(x => x.name !== t.name && x.auto && +x.local === +t.local)
  if (s) return toast(`${s.name} also auto-connects on :${t.local}, so ${t.name} would fail at every launch.`, [`Use :${suggestSync(t.port, t.name)}`, () => fixPort(t)])
  toast(on ? `${t.name} will connect at launch and reconnect if it drops` : `Auto-connect off for ${t.name}`)
}
async function stopAll(onlyProd) {
  const hadAuto = M.shown.some(t => busy(t) && t.auto && (!onlyProd || t.env === 'prod'))
  const r = await (onlyProd ? ssm.disconnectEnv('production') : ssm.disconnectAll())
  const n = (r && r.stopped) || 0
  toast(n ? `Stopped ${n} ${onlyProd ? 'production ' : ''}session${n > 1 ? 's' : ''}${hadAuto ? ' · auto tunnels reconnect at next launch' : ''}` : 'Nothing to stop')
}
async function del(t) {
  const r = await ssm.deleteTunnel(t.name)
  if (!r || !r.ok) return toast(`Couldn’t delete ${t.name}`)
  if (selName === t.name) selName = null
  toast(`Deleted ${t.name}`, ['Undo', async () => { await ssm.addTunnel(r.tunnel, r.index); selName = t.name; await refresh() }])
}
async function restore(name) {
  const t = byName(name); await ssm.restoreArchived(name)
  toast(`Restored ${name} · failure clock restarted${t && t.auto ? ' · connects at next launch' : ''}`, ['Connect Now', () => ssm.connect(name)])
}
async function purge(t) {
  const r = await ssm.deleteTunnel(t.name)
  if (!r || !r.ok) return toast(`Couldn’t delete ${t.name}`)
  toast(`Deleted ${t.name} forever`, ['Undo', async () => { await ssm.addTunnel(r.tunnel, r.index); await refresh() }])
}
async function killTerminal(id) {
  const u = M.terminal.find(x => x.id === id); if (!u) return
  await ssm.killTerminal(id); toast(`Stopped Terminal session (PID ${u.pid})`)
}

/* ---------- rendering ---------- */
const ageHTML = t => {
  const n = M.settings.archiveDays, days = L.failingDays(t); if (!n || days < 1) return ''
  return `<b class="age" title="Auto-archives after ${esc(n)} failing days (${esc(Math.max(0, n - days))} to go). Resets once it stays connected 10s. Days when every tunnel fails don't count."><span class="bar"><i style="width:${esc(Math.min(100, days / n * 100))}%"></i></span>Failing ${esc(days)} of ${esc(n)} days</b>`
}
const retryPending = t => t.nextAt && t.nextAt > now()
const maxAtt = t => t.maxAttempts || 5
function stHTML(t) {
  const s = t.state
  if (s === 'active') return `<div class="st ok"><div class="l1"><span class="dot"></span>Connected · ${esc(L.dur(t.since, now()))}</div><div class="l2">PID ${esc(t.pid)}${t.origin === 'terminal' ? `<span class="badge ext" title="Started outside the app, detected via ps">${ic('term')}Terminal</span>` : ''}</div></div>`
  if (s === 'connecting') return '<div class="st busy"><div class="l1"><span class="spin" aria-hidden="true"></span>Connecting…</div><div class="l2">Starting SSM session</div></div>'
  if (s === 'waiting') return AWS_ON ? awsWaitingSt(t) : '<div class="st"></div>'
  if (s === 'reconnecting') {
    const since = t.failingSince ? ` · since ${L.failingDays(t) ? day(t.failingSince) : hm(t.failingSince)}` : ''
    return `<div class="st re"><div class="l1">${retryPending(t) ? `${ic('loop')}<span>Retrying in <span data-cd="${esc(t.name)}">${esc(secs(t))}s</span></span>` : '<span class="spin re" aria-hidden="true"></span>Reconnecting…'}</div><div class="l2">attempt ${esc(fmt(t.attempt))} of ${esc(maxAtt(t))}${esc(since)}</div></div>`
  }
  if (s === 'failed') {
    const ago = t.errorAt ? L.ago(t.errorAt, now()) : ''
    return t.gaveUp
      ? `<div class="st err"><div class="l1">${ic('stop')}Stopped after ${esc(maxAtt(t))} attempts</div><div class="l2">${esc(ago)}</div></div>`
      : `<div class="st err"><div class="l1">${ic('x')}Failed</div><div class="l2">${esc(ago)}</div></div>`
  }
  const o = M.shown.find(x => x.name !== t.name && +x.local === +t.local)
  return o ? `<div class="st note"><div class="l1" title="Only one of these can run at a time">${ic('warn')}Shares :${esc(t.local)} with ${esc(o.name)}</div></div>` : '<div class="st"></div>'
}
function stripHTML(t) {
  if (!failing(t)) return ''
  const re = t.state === 'reconnecting', gave = t.state === 'failed' && t.gaveUp, id = esc(t.name)
  const kindE = L.errorKind(t.error), err = L.stripGaveUp(t.error), port = kindE === 'port', tok = kindE === 'token'
  const holder = port ? (owner(t.local, t.name) || {}).label : null
  const msg = port && holder ? `Port :${esc(t.local)} already in use by <b>${esc(holder)}</b>.`
    : `<span class="eline">${esc(err)}</span>${tok ? `<small>Your AWS login expired. Sign in again (e.g. <code>aws sso login</code>)${gave ? ', then Retry.' : '; the next retry picks it up.'}</small>` : ''}`
  return `<div class="strip ${re ? 're' : 'err'}">${ic(re ? 'loop' : 'x')}${ageHTML(t)}<span>${msg}</span>${tok ? `<button class="btn sm" data-a="copysso" data-id="${id}">Copy Command</button>` : ''}<button class="btn sm" data-a="retry" data-id="${id}">${re ? 'Retry Now' : 'Retry'}</button>${port ? `<button class="btn sm" data-a="fixport" data-id="${id}">Use :${esc(suggestSync(t.port, t.name))} instead</button>` : ''}</div>`
}
function rowHTML(t) {
  const [kl, ki] = L.kind(t), prod = t.env === 'prod', s = t.state, id = esc(t.name), days = L.failingDays(t), ad = M.settings.archiveDays
  const words = s === 'active' ? `connected for ${L.dur(t.since, now())}` : s === 'failed' ? (t.gaveUp ? `stopped after ${maxAtt(t)} attempts, ${L.stripGaveUp(t.error)}` : `failed, ${t.error}`) : s === 'reconnecting' ? `reconnecting, attempt ${t.attempt} of ${maxAtt(t)}` : s === 'waiting' ? `waiting for AWS sign-in${t.profile ? ` (${t.profile})` : ''}` : s
  return `<li class="row ${esc(s)}${prod ? ' prod' : ''}${t.name === selName ? ' sel' : ''}" data-row="${id}" tabindex="${t.name === selName ? 0 : -1}" aria-label="${esc(`${t.name}, ${ENVS[t.env]}, localhost ${t.local}, ${words}${t.auto ? ', auto-connect' : ''}${days && ad ? `, failing ${days} of ${ad} days` : ''}`)}">
    <button class="port" data-a="copy" data-id="${id}" title="Copy localhost:${esc(t.local)}" aria-label="Copy localhost:${esc(t.local)}">:${esc(t.local)}</button>
    <div class="mn"><div class="nm"><b>${esc(t.name)}</b>${prod ? '<span class="badge prod" title="Production — live data">PROD</span>' : ''}<span class="kind">${ic(ki)}${esc(kl)}</span>${AWS_ON ? awsChip(t) : ''}</div>
      <div class="sub2">${esc(t.desc)}${t.desc ? ' · ' : ''}<span class="mono">${esc(t.host)}:${esc(t.port)}</span></div></div>
    ${stHTML(t)}
    <button class="auto" aria-pressed="${!!t.auto}" data-a="auto" data-id="${id}" aria-label="Auto-connect ${id}" title="Auto-connect: connect at launch and reconnect if it drops (⌥⌘A)">${ic('loop')}Auto</button>
    <button class="sw" role="switch" aria-checked="${s === 'active' ? 'true' : s === 'connecting' || s === 'reconnecting' || s === 'waiting' ? 'mixed' : 'false'}" data-a="toggle" data-id="${id}" aria-label="${id} tunnel" title="${s === 'active' ? 'Disconnect' : s === 'connecting' ? 'Cancel' : s === 'reconnecting' ? 'Stop retrying' : s === 'waiting' ? 'Stop waiting' : 'Connect'} (Space)"></button>
    <button class="more" data-a="more" data-id="${id}" aria-haspopup="menu" aria-label="More actions for ${id}">${ic('dots')}</button>
    ${stripHTML(t)}</li>`
}
const detHTML = u => `<div class="det">${ic('term')}<div style="min-width:0"><b>Running in Terminal, not saved</b>
  <div class="sub2"><span class="mono">localhost:${esc(u.local)} → ${esc(u.host)}:${esc(u.port)}</span></div>
  <div class="sub2">PID ${esc(u.pid)} · up ${esc(L.dur(u.since, now()))} · ${esc(L.shortId(u.target))} · ${esc(u.region)}</div></div>
  <button class="btn sm" data-a="adopt" data-u="${esc(u.id)}">Save as Tunnel…</button><button class="btn sm" data-a="kill" data-u="${esc(u.id)}">Stop</button></div>`
function noticeHTML() {
  const nt = M.notice.map(byName).filter(Boolean); if (!nt.length) return ''
  const one = nt.length === 1 && nt[0], ad = M.settings.archiveDays, days = one ? L.failingDays(one) : 0
  return `<div class="notice" role="status">${ic('archive')}<div style="min-width:0"><b>Auto-archived ${esc(nt.map(t => t.name).join(', '))}</b>
    <div class="sub2">${one ? `${days ? `Failed ${esc(days)} days in a row · ` : ''}last error: <span class="mono">${esc(one.lastError || '')}</span>` : `Each failed ${esc(ad)}+ days in a row.`}</div>
    <div class="sub2">Hidden from the list and menu bar, kept in storage.</div></div>
    <button class="btn sm" data-a="archived">Show Archived</button>${one ? `<button class="btn sm" data-a="restore" data-id="${esc(one.name)}">Restore</button>` : '<span></span>'}
    <button class="btn sm ic" data-a="dismiss" aria-label="Dismiss" title="Dismiss">${ic('x')}</button></div>`
}
function purgeText(t) {
  const n = L.purgeDaysLeft(t, M.settings.purgeDays, now())
  return n === null ? 'Kept until you delete it' : n === 0 ? 'Deleted permanently at the next hourly check' : `Deleted permanently in ${esc(n)} day${n > 1 ? 's' : ''}`
}
function archHTML() {
  const a = M.archived.filter(t => L.matchQuery(t, query))
  const h = `<div class="ainfo">${ic('archive')}<span>Archived tunnels never auto-connect and are hidden from the list and menu bar. <b>Restore</b> brings one back and restarts its failure clock.</span></div>`
  if (!a.length) return h + `<div class="empty">${ic('check')}${query ? `No archived tunnels match “${esc(query)}”.` : 'Nothing archived.'}</div>`
  return h + `<ul class="rows">${a.map(t => {
    const [kl, ki] = L.kind(t), id = esc(t.name)
    return `<li class="arow${t.env === 'prod' ? ' prod' : ''}">
    <span class="port">:${esc(t.local)}</span>
    <div class="mn"><div class="nm"><b>${esc(t.name)}</b>${t.env === 'prod' ? '<span class="badge prod">PROD</span>' : ''}<span class="kind">${ic(ki)}${esc(kl)}</span>${t.auto ? `<span class="kind">${ic('loop')}was Auto</span>` : ''}</div>
      <div class="sub2">Archived ${t.archivedAt ? esc(L.ago(t.archivedAt, now())) + ' · ' : ''}${purgeText(t)}</div>
      <span class="eline">${esc(t.lastError || '')}</span></div>
    <button class="btn sm" data-a="restore" data-id="${id}" title="Back to the list; failure clock restarts">Restore</button>
    <button class="btn sm red" data-a="purge" data-id="${id}">Delete Forever</button></li>`
  }).join('')}</ul>`
}
function impRows() {
  const offer = M.snap.importOffer; if (!offer) return null
  return offer.tunnels.map(x => ({ name: x.name, port: x.port, orig: x.local, local: impOverrides[x.name] ?? x.local, env: L.envToMock(x.env) }))
}
const impSuggest = (x, rows) => L.suggestPort(x.port, new Set([...rows.filter(y => y !== x).map(y => y.local), ...M.terminal.map(u => +u.local)]))
function firstHTML() {
  const offer = M.snap.importOffer, rows = impRows()
  let card = ''
  if (rows) {
    const clashing = x => rows.some(y => y !== x && y.local === x.local), other = rows.filter(x => x.env === 'other').length
    const notes = rows.filter((x, i) => rows.findIndex(y => y.local === x.local) < i).map(x => {
      const y = rows.find(z => z.local === x.local)
      return `<div class="note w">${ic('warn')}<span>${esc(y.name)} and ${esc(x.name)} both use local port :${esc(x.local)}, so only one can run at a time. If both are set to Auto-connect, ${esc(x.name)} would fail at every launch.</span><button class="btn sm" data-a="impFix" data-i="${rows.indexOf(x)}">Use :${esc(impSuggest(x, rows))} for ${esc(x.name)}</button></div>`
    }).join('') + rows.filter(x => impOverrides[x.name] != null).map(x => `<div class="note ok">${ic('check')}<span>${esc(x.name)} will use :${esc(x.local)} (was :${esc(x.orig)}).</span></div>`).join('')
    card = `<div class="imp"><div class="imp-hd">${ic('term')}<span><b>Found your ssm-connect script</b><br><span class="mono">${esc(offer.path)}</span></span><span class="sp"></span><b>${rows.length} tunnels</b></div>
  <ul>${rows.map(x => `<li class="${clashing(x) ? 'clash' : ''}"><span class="mono">${esc(x.name)}</span><span class="mono">:${esc(x.local)}</span><span class="env ${esc(x.env)}">${esc(ENVS[x.env])}</span></li>`).join('')}</ul>
  ${notes}
  <div class="note">${ic('shield')}<span>Environment is guessed from the name: -stg is Staging and -prod is Production; everything else is Other.${other ? ` ${other} tunnel${other > 1 ? 's' : ''} will be marked Other; review whether they touch production.` : ''}</span></div></div>`
  }
  return `<div class="first"><div class="appicon">${ic('tunnel')}</div><h2>Set up your tunnels</h2>
  <p>Save each SSM port-forward once, then connect with a click. Sessions you start in Terminal show up here automatically.</p>
  ${card}
  <div class="btns">${rows ? `<button class="btn pri" data-a="import">Import ${rows.length} Tunnels</button><button class="btn" data-a="add">Add Manually…</button>` : '<button class="btn pri" data-a="add">Add Manually…</button>'}</div>
  ${AWS_ON && M.snap.aws && M.snap.aws.noCredentials ? '<p><button class="btn" data-a="awsOpen">Set Up AWS Access…</button></p>' : ''}
  <p class="foot">Stored in <span class="mono">${esc(M.snap.dataPath)}</span></p></div>`
}
function listHTML() {
  if (!M.tunnels.length) return firstHTML()
  if (view === 'archived') return archHTML()
  const v = visible(M.tunnels, view, query); let h = query ? '' : noticeHTML()
  if (M.terminal.length && (view === 'all' || view === 'active') && !query) h += M.terminal.map(detHTML).join('')
  if (!v.length) return h + (query ? `<div class="empty">${ic('search')}No tunnels match “${esc(query)}”.<br><br><button class="btn sm" data-a="clearq">Clear Search</button></div>`
    : `<div class="empty">${ic(view === 'attn' ? 'check' : 'ring')}${view === 'attn' ? 'Nothing needs attention.' : 'No tunnels here.'}</div>`)
  for (const e of Object.keys(ENVS)) {
    const g = v.filter(t => t.env === e); if (!g.length) continue
    const n = g.filter(t => t.state === 'active').length, au = g.filter(t => t.auto).length, nw = g.filter(t => t.state === 'waiting').length
    h += `<section aria-label="${esc(ENVS[e])}"><div class="sec ${esc(e)}"><h2>${e === 'prod' ? ic('shield') : ''}${esc(ENVS[e])}</h2><span class="meta">${g.length} · ${n} connected${nw ? ` · ${nw} waiting for sign-in` : ''}${au ? ` · ${au} auto` : ''}${e === 'prod' ? ' · live data' : ''}</span></div><ul class="rows">${g.map(rowHTML).join('')}</ul></section>`
  }
  return h
}
function sideHTML() {
  const S = M.shown, c = f => S.filter(f).length
  const item = (id, icon, label, n, cls = '') => `<button data-a="view" data-v="${esc(id)}" class="${cls}"${view === id ? ' aria-current="page"' : ''}>${ic(icon)}${label}<span class="n">${n || ''}</span></button>`
  const bast = [...new Set(S.map(t => t.target))].map(b => {
    const r = S.find(t => t.target === b).region
    return item(b, 'server', `<span class="lb"><span class="mono" title="${esc(b)}">${esc(L.shortId(b))}</span><small>${esc(r)}</small></span>`, c(t => t.target === b), 'two')
  }).join('')
  return `<h3>Tunnels</h3>${item('all', 'list', 'All Tunnels', S.length)}${item('active', 'bolt', 'Connected', c(t => t.state === 'active') + M.terminal.length, 'ok')}${item('attn', 'warn', 'Needs Attention', c(L.needsAttention), 'attn')}
    <h3>Environment</h3>${item('prod', 'shield', 'Production', c(t => t.env === 'prod'), 'prod')}${item('stg', 'flask', 'Staging', c(t => t.env === 'stg'))}${item('other', 'ring', 'Other', c(t => t.env === 'other'))}
    ${bast ? `<h3>Bastions</h3>${bast}` : ''}
    <h3>Activity</h3>${item('logs', 'logs', 'Logs', 0)}`
}
const sideActHTML = () => `<button class="link" data-a="archived"${view === 'archived' ? ' aria-current="page"' : ''}>${ic('archive')}Archived (${M.archived.length})</button><span class="sp"></span><button class="link" data-a="settings" title="Settings (⌘,)">${ic('gear')}Settings</button>`
const toolSpan = (name, ver) => ver ? `<span>${ic('check')}${name} ${esc(ver)}</span>` : `<span>${ic('warn', 'w')}${name} not found</span>`
const toolRow = (name, ver) => ver ? `<div class="full tool">${ic('check')}${name} <span class="mono">${esc(ver)}</span></div>` : `<div class="full tool">${ic('warn', 'w')}${name} not found</div>`

function render() {
  if (view.startsWith('i-') && !M.shown.some(t => t.target === view)) view = 'all'
  if (selName && !byName(selName)) selName = null
  const a = document.activeElement, root = a && a.closest ? a.closest('#list,#side,#banner,#sideAct,#sideAws') : null
  let sel = null
  if (root && a !== root) { const d = a.dataset; sel = d.row ? `[data-row="${q(d.row)}"]` : d.a ? ['a', 'id', 'v', 'u', 'i', 'p'].filter(k => d[k] != null).map(k => `[data-${k}="${q(d[k])}"]`).join('') : null }
  const list = $('#list'), top = list.scrollTop, S = M.shown, cnt = f => S.filter(f).length, arch = view === 'archived', logs = view === 'logs'
  const nA = cnt(t => t.state === 'active') + M.terminal.length, nC = cnt(t => t.state === 'connecting'), nR = cnt(t => t.state === 'reconnecting'), nF = cnt(t => t.state === 'failed'), nW = cnt(t => t.state === 'waiting')
  const pl = S.filter(t => t.env === 'prod' && t.state === 'active')
  $('#side').innerHTML = sideHTML()
  $('#sideTools').innerHTML = toolSpan('aws-cli', M.snap.tools && M.snap.tools.aws) + toolSpan('session-manager-plugin', M.snap.tools && M.snap.tools.plugin)
  $('#title').textContent = viewLabel()
  $('#subtitle').textContent = logs ? '' : arch ? `${M.archived.length} archived · kept in storage, never auto-connect` : M.tunnels.length ? [`${nA} connected`, nC && `${nC} connecting`, nR && `${nR} reconnecting`, nW && `${nW} waiting for sign-in`, nF && `${nF} failed`, `${S.length} saved`].filter(Boolean).join(' · ') : 'No tunnels saved yet'
  $('#banner').innerHTML = (AWS_ON ? awsBannerHTML() : '') + (arch || logs ? '' : (L.allFailing(M.tunnels) ? `<div class="banner off">${ic('warn')}<span><b>Every tunnel is failing.</b> That usually means no network or an expired AWS login. Time while everything fails doesn’t count toward auto-archive.</span></div>` : '')
    + (pl.length ? `<div class="banner">${ic('shield')}<span><b>${pl.length} production tunnel${pl.length > 1 ? 's' : ''} live</b> — ${pl.map(t => esc(t.name)).join(', ')}</span><span class="sp"></span><button class="btn sm" data-a="showProd">Show</button><button class="btn sm" data-a="discProd">Disconnect Production</button></div>` : ''))
  awsPaint()
  list.hidden = logs; if (!logs) { list.innerHTML = listHTML(); list.scrollTop = top }
  $('#tbActs').hidden = arch || logs; $('#tbLogs').hidden = !logs; $('#logsPane').hidden = !logs; $('#bBack').hidden = !arch
  $('#bAll').disabled = !S.some(t => !busy(t)); $('#bNone').disabled = !S.some(busy) && !M.terminal.length
  $('#sideAct').hidden = !M.tunnels.length; $('#sideAct').innerHTML = sideActHTML()
  if (sel) { const el = $(sel, root); if (el) el.focus({ preventScroll: true }); else if (root.id === 'banner') { const bb = $('button', root); if (bb) bb.focus({ preventScroll: true }) } }
  logsSync(logs)
  if ($('#dSet').open) drawSet()
  if ($('#dForm').open) check()
}
function select(name, focus) {
  selName = name
  $$('#list .row').forEach(r => { const on = r.dataset.row === name; r.classList.toggle('sel', on); r.tabIndex = on ? 0 : -1; if (on && focus) r.focus({ preventScroll: true }) })
}
function move(d) {
  const rows = $$('#list .row'); if (!rows.length) return
  let i = rows.findIndex(r => r.dataset.row === selName)
  i = i < 0 ? (d > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + d))
  select(rows[i].dataset.row, true); rows[i].scrollIntoView({ block: 'nearest' })
}

/* ---------- menus and sheets ---------- */
function openMenu(t, at) {
  const cli = L.cliFor(t), id = esc(t.name)
  const it = (a, l, k = '', x = '') => `<button role="menuitem" data-a="${a}" data-id="${id}"${x}>${l}<kbd>${k}</kbd></button>`
  const m = $('#menu')
  m.innerHTML = it('toggle', t.state === 'reconnecting' ? 'Stop Retrying' : t.state === 'waiting' ? 'Stop Waiting' : live(t) ? 'Disconnect' : 'Connect', 'Space') + (AWS_ON && t.state === 'waiting' ? `<button role="menuitem" data-a="awsSignIn" data-p="${esc(t.profile || 'default')}">Sign In to ${esc(t.profile || 'default')}<kbd></kbd></button>` : '') + (failing(t) ? it('retry', t.state === 'reconnecting' ? 'Retry Now' : 'Retry', '⌘R') : '')
    + `<button role="menuitemcheckbox" aria-checked="${!!t.auto}" data-a="auto" data-id="${id}"><span class="ck">${t.auto ? ic('check') : ''}</span>Auto-connect<kbd>⌥⌘A</kbd></button><hr>`
    + it('copy', `Copy localhost:${esc(t.local)}`, '⌘C') + it('copycli', `Copy “${esc(cli.split(' ')[0])}” command`, '', ` data-text="${esc(cli)}"`) + it('copyaws', 'Copy aws command') + '<hr>'
    + it('edit', 'Edit…', '⌘I') + it('dup', 'Duplicate…', '⌘D') + '<hr>' + it('del', `Delete “${esc(t.name)}”`, '⌘⌫', ' class="danger"')
  menuFrom = at instanceof Element ? at : document.activeElement; m.hidden = false
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y }, w = m.offsetWidth, h = m.offsetHeight
  let x = at instanceof Element ? r.right - w : r.left, y = r.bottom + 4; if (y + h > innerHeight - 8) y = r.top - h - 4
  m.style.left = Math.max(8, Math.min(innerWidth - w - 8, x)) + 'px'; m.style.top = Math.max(8, y) + 'px'
  $('button', m).focus()
}
function closeMenu(restoreFocus) { const m = $('#menu'); if (m.hidden) return; m.hidden = true; if (restoreFocus && menuFrom && menuFrom.isConnected) menuFrom.focus() }
function showSheet(d) {
  closeMenu(); d.showModal()
  const m = $('.main').getBoundingClientRect(), top = Math.max(12, m.top + 44)
  d.style.top = top + 'px'; d.style.maxHeight = (innerHeight - top - 12) + 'px'
  d.style.left = Math.max(12, Math.min(innerWidth - d.offsetWidth - 12, m.left + m.width / 2 - d.offsetWidth / 2)) + 'px'
}

let connectPlan = null
async function openAll() {
  if ($('dialog[open]') || view === 'logs') return
  const cands = visible(M.tunnels, view, query).filter(t => !busy(t)); if (!cands.length) return
  const held = new Map()
  M.shown.filter(live).forEach(t => held.set(+t.local, t.name))
  M.terminal.forEach(u => held.set(+u.local, `Terminal session (PID ${u.pid})`))
  const ports = [...new Set(cands.map(t => +t.local))].filter(p => !held.has(p))
  const used = await Promise.all(ports.map(p => portInUse(p, 0)))
  ports.forEach((p, i) => { if (used[i]) held.set(p, 'another app') })
  const p = connectPlan = L.plan(cands, held)
  $('#aSub').textContent = `Idle tunnels in “${viewLabel()}”`
  $('#aBody').innerHTML = `<div class="ca"><div class="ca-h">${ic('play')}<b>Will connect ${p.go.length}</b></div><div class="tags">${p.go.map(t => `<span class="tag${t.env === 'prod' ? ' prod' : ''}">${esc(t.name)} <span class="mono">:${esc(t.local)}</span></span>`).join('') || '<span class="sub">Nothing to connect.</span>'}</div></div>
    ${p.skip.length ? `<div class="ca skip"><div class="ca-h">${ic('warn')}<b>Skipping ${p.skip.length}</b> because the local port is already taken</div>${p.skip.map(([t, h]) => `<div><span class="mono">${esc(t.name)} :${esc(t.local)}</span> is held by ${esc(h)}</div>`).join('')}</div>` : ''}`
  const g = $('#aGo'); g.textContent = p.go.length ? `Connect ${p.go.length}` : 'Connect'; g.disabled = !p.go.length
  showSheet($('#dAll')); g.focus()
}
$('#aGo').onclick = async () => {
  const p = connectPlan; $('#dAll').close(); if (!p) return
  await Promise.all(p.go.map(t => ssm.connect(t.name)))
  toast(`Connecting ${p.go.length} tunnel${p.go.length > 1 ? 's' : ''}`)
}

function ensureOption(sel, v) {
  if (![...sel.options].some(o => o.value === String(v))) { const o = document.createElement('option'); o.value = v; o.textContent = `After ${v} days`; sel.add(o) }
  sel.value = v
}
function drawSet() {
  const st = M.settings, au = M.shown.filter(t => t.auto), supported = !!(M.snap.loginItem && M.snap.loginItem.supported)
  const sl = $('#sLogin'); sl.setAttribute('aria-checked', !!st.openAtLogin); sl.disabled = !supported; $('#nLogin').hidden = supported
  ensureOption($('#sArch'), st.archiveDays); ensureOption($('#sPurge'), st.purgeDays)
  $('#sQuit').setAttribute('aria-checked', !!st.stopOnQuit)
  $('#sAuto').innerHTML = au.length ? au.map(t => `<span class="tag${t.env === 'prod' ? ' prod' : ''}">${ic('loop')} ${esc(t.name)} <span class="mono">:${esc(t.local)}</span></span>`).join('') : '<span class="sub">No tunnels are marked Auto yet. Use the Auto button on any row.</span>'
  const tl = M.snap.tools || {}
  $('#sTools').innerHTML = toolRow('aws-cli', tl.aws) + toolRow('session-manager-plugin', tl.plugin)
  $('#sPath').textContent = M.snap.dataPath || ''
  awsDrawSet()
}
function openSet() { if ($('dialog[open]')) return; drawSet(); showSheet($('#dSet')); $('#sLogin').disabled ? $('#sArch').focus() : $('#sLogin').focus() }
async function patchSettings(patch, msg) {
  const r = await ssm.updateSettings(patch)
  if (!r || !r.ok) toast(firstError(r) || 'Couldn’t save the setting')
  else if (msg) announce(msg)
  await refresh()
}
$('#sArch').onchange = e => patchSettings({ archiveDays: +e.target.value })
$('#sPurge').onchange = e => patchSettings({ purgeDays: +e.target.value })

/* ---------- add / edit form ---------- */
let ed = null, adoptU = null, mode = 'new', envVal = 'other', autoVal = false, envTouched = false, localTouched = false, touched = new Set(), submitted = false, srvErr = {}, portTimer
const nameLocked = () => !!ed && ed.origin === 'app' && ['connecting', 'active', 'reconnecting', 'waiting'].includes(ed.state)
function fd() {
  const v = s => $(s).value.trim(), b = $('#iBastion').value
  return { name: v('#iName'), desc: v('#iDesc'), ...(AWS_ON ? { profile: $('#iProf').value } : {}), target: b === 'other' ? v('#iTarget') : b, region: $('#iRegion').value, host: v('#iHost'), port: +v('#iPort'), local: +v('#iLocal'), env: L.envToCanon(envVal), auto: autoVal }
}
function fillRegions(region) {
  const regions = [...new Set([...REGIONS, ...M.tunnels.map(t => t.region), region].filter(Boolean))]
  $('#iRegion').innerHTML = regions.map(r => `<option>${esc(r)}</option>`).join(''); $('#iRegion').value = region
}
function fillBastions(target, region) {
  const known = [...new Set(M.tunnels.map(t => t.target))], s = $('#iBastion')
  s.innerHTML = known.map(b => { const n = M.tunnels.filter(t => t.target === b).length; return `<option value="${esc(b)}">${esc(b)}  ·  used by ${n} tunnel${n > 1 ? 's' : ''}</option>` }).join('') + '<option value="other">Other instance…</option>'
  s.value = known.includes(target) ? target : 'other'; $('#iTarget').value = target || ''; fillRegions(region); syncBastion(false)
}
function syncBastion(user) {
  const v = $('#iBastion').value, k = v !== 'other'
  $('#fTarget').hidden = k; $('#iRegion').disabled = k || mode === 'adopt'
  if (k) $('#iRegion').value = M.tunnels.find(t => t.target === v).region; else if (user) { $('#iTarget').value = ''; $('#iTarget').focus() }
  check()
}
function schedulePortCheck(port) {
  clearTimeout(portTimer)
  portTimer = setTimeout(() => { portInUse(port, 0).then(() => { if ($('#dForm').open && fd().local === port) check() }).catch(() => {}) }, 250)
}
function check() {
  if (ed) ed = byName(ed.name) || ed
  const d = fd(), others = M.tunnels.filter(t => !ed || t.name !== ed.name)
  const { errors, clashes } = window.SSMValidate.validateTunnel(d, others)
  const E = { ...errors, ...srvErr }
  let lm = 'Free on this Mac', lc = 'ok', fix = false
  if (E.local) { lm = E.local; lc = 'err' }
  else {
    const o = owner(d.local, ed && ed.name, adoptU && adoptU.id), s = (d.auto && clashes.find(c => c.auto)) || clashes[0]
    const own = (ed && live(ed) && +ed.local === d.local) || (adoptU && +adoptU.local === d.local)
    let ext = false
    if (!o && !own) {
      const c = portCache.get(d.local)
      if (c && c.inUse && now() - c.at < 30e3) ext = true
      if (!c || now() - c.at > 4000) { if (!c) { lm = 'Checking…'; lc = '' } schedulePortCheck(d.local) }
    }
    if (o || ext) { lm = `In use right now by ${o ? o.label : 'another app'}. Connecting will fail.`; lc = 'err'; fix = true }
    if (s) {
      fix = true
      if (d.auto && s.auto) { lm = `${s.name} also uses :${d.local} and auto-connects. With both on, ${d.name || 'this tunnel'} fails at every launch and retries forever.`; lc = 'err' }
      else if (!o && !ext) { lm = `Also assigned to ${s.name}. The two can’t run at the same time.`; lc = 'warn' }
    }
  }
  const show = k => submitted || touched.has(k) || srvErr[k]
  const locked = nameLocked()
  ;['name', 'target', 'host', 'port'].forEach(k => { const m = $('#m' + k[0].toUpperCase() + k.slice(1)), bad = show(k) && E[k]; m.textContent = bad || ''; $(`[data-f="${k}"]`).classList.toggle('bad', !!bad) })
  if (locked) { $('#mName').textContent = 'Disconnect to rename'; $('#mName').className = 'msg'; $('[data-f="name"]').classList.remove('bad') } else $('#mName').className = 'msg err'
  const ml = $('#mLocal'); ml.textContent = (lc === 'ok' ? '✓ ' : '') + lm; ml.className = 'msg ' + lc
  const bf = $('#bFix'); bf.hidden = mode === 'adopt' || !fix || !(d.port > 0); if (!bf.hidden) bf.textContent = `Use :${suggestSync(d.port, ed && ed.name, adoptU && adoptU.id)}`
  $$('#envSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.env === envVal))
  $('#iAuto').setAttribute('aria-checked', autoVal)
  $('#mEnv').textContent = envVal === 'prod' ? 'Marked PROD in lists and the menu bar. Connects like any other tunnel.' : ''
  $('#cmd').innerHTML = `aws ssm start-session \\\n${d.profile ? `  --profile <b>${esc(d.profile)}</b> \\\n` : ''}  --region <b>${esc(d.region)}</b> \\\n  --target <b>${esc(d.target || 'i-…')}</b> \\\n  --document-name AWS-StartPortForwardingSessionToRemoteHost \\\n  --parameters host=<b>${esc(d.host || '<host>')}</b>,portNumber=<b>${esc(d.port || '?')}</b>,localPortNumber=<b>${esc(d.local || '?')}</b>`
  awsProfMsg()
  return { E, d }
}
function lockConnection(on) {
  $('#iBastion').disabled = on; $('#iTarget').readOnly = on; $('#iHost').readOnly = on; $('#iPort').readOnly = on; $('#iLocal').readOnly = on
  $('#presets').hidden = on; $('#bSuggest').hidden = on
  if (on) $('#iRegion').disabled = true
}
function openForm(m, t, u) {
  if ($('dialog[open]')) return
  mode = m; ed = m === 'edit' ? t : null; adoptU = u || null; touched = new Set(); submitted = false; srvErr = {}
  envTouched = m === 'edit' || m === 'dup'; localTouched = m === 'edit' || m === 'adopt'
  const common = [...M.tunnels.reduce((c, x) => c.set(x.target, (c.get(x.target) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0]
  const dflt = { region: common ? M.tunnels.find(x => x.target === common[0]).region : L.preferredRegion(M.tunnels), target: common ? common[0] : '', host: '', port: 5432, desc: '', name: '', env: 'other' }
  const src = t || u || dflt
  $('#fTitle').textContent = { new: 'New Tunnel', edit: `Edit “${t && t.name}”`, dup: `Duplicate “${t && t.name}”`, adopt: 'Save Terminal Session' }[m]
  $('#fSub').textContent = m === 'adopt' ? `PID ${u.pid} keeps running and becomes a saved tunnel the app manages.` : ed && live(ed) ? 'This tunnel is running. Connection changes apply after you reconnect.' : 'Saved to connections.json. No terminal needed.'
  lockConnection(false)
  $('#iName').value = m === 'dup' ? src.name + '-copy' : m === 'adopt' ? '' : src.name
  $('#iName').readOnly = nameLocked()
  $('#iDesc').value = src.desc || ''; awsFillProf(src.profile || ''); $('#iHost').value = src.host; $('#iPort').value = src.port
  $('#iLocal').value = m === 'new' || m === 'dup' ? suggestSync(src.port, null) : src.local
  envVal = src.env || 'other'; autoVal = (m === 'edit' || m === 'dup') ? !!t.auto : false; fillBastions(src.target, src.region)
  if (m === 'adopt') lockConnection(true)
  $('#bDel').hidden = m !== 'edit'; $('#bSaveGo').hidden = m === 'adopt' || !!(ed && live(ed))
  check(); showSheet($('#dForm')); $('#iName').readOnly ? $('#iDesc').focus() : $('#iName').focus()
  if ((m === 'new' || m === 'dup') && !localTouched) suggestFree(src.port, null).then(p => { if ($('#dForm').open && !localTouched && mode === m) { $('#iLocal').value = p; check() } }).catch(() => {})
}
async function save(go) {
  submitted = true; srvErr = {}; const { E, d } = check(), bad = Object.keys(E)[0]
  if (bad) { const f = { name: '#iName', target: '#iTarget', host: '#iHost', port: '#iPort', local: '#iLocal', region: '#iRegion' }[bad]; return f && $(f).focus() }
  const was = ed, r = await ssm.saveTunnel(d, was ? was.name : null)
  if (!r.ok) { srvErr = r.errors || {}; check(); const k = Object.keys(srvErr)[0]; const f = { name: '#iName', target: '#iTarget', host: '#iHost', port: '#iPort', local: '#iLocal' }[k]; if (f && !$(f).readOnly) $(f).focus(); return }
  $('#dForm').close()
  const changed = !!(was && live(was) && CONN_FIELDS.some(k => String(was[k]) !== String(d[k])))
  selName = d.name; await refresh()
  if (!visible(M.tunnels, view, query).some(t => t.name === d.name) && view !== 'archived') { view = 'all'; query = ''; $('#q').value = ''; render() }
  const t = byName(d.name)
  if (go && t && !live(t)) await ssm.connect(d.name)
  toast(changed ? `Saved. Reconnect ${d.name} to apply.` : `Saved ${d.name}${d.auto && !(t && busy(t)) ? ' · auto-connects at next launch' : ''}`, changed ? ['Reconnect', () => ssm.reconnect(d.name)] : null)
}
$('#form').addEventListener('input', e => {
  const f = e.target.closest('[data-f]'); if (f) touched.add(f.dataset.f)
  srvErr = {}
  if (e.target.id === 'iName' && !envTouched) envVal = L.envToMock(window.SSMValidate.inferEnv(e.target.value))
  if (e.target.id === 'iLocal') localTouched = true
  if (e.target.id === 'iPort' && !localTouched && +e.target.value) $('#iLocal').value = suggestSync(+e.target.value, ed && ed.name)
  check()
})
$('#iBastion').onchange = () => syncBastion(true); $('#iRegion').onchange = check; $('#iProf').onchange = check
$('#envSeg').onclick = e => { const b = e.target.closest('[data-env]'); if (!b) return; envVal = b.dataset.env; envTouched = true; check() }
$('#iAuto').onclick = () => { autoVal = !autoVal; check() }
$('#presets').onclick = e => { const b = e.target.closest('[data-p]'); if (!b) return; $('#iPort').value = b.dataset.p; touched.add('port'); if (!localTouched) $('#iLocal').value = suggestSync(+b.dataset.p, ed && ed.name); check() }
$('#bSuggest').onclick = async () => { localTouched = true; $('#iLocal').value = await suggestFree(+$('#iPort').value || 5432, ed && ed.name, adoptU && adoptU.id); check() }
$('#bFix').onclick = async () => { localTouched = true; $('#iLocal').value = await suggestFree(+$('#iPort').value, ed && ed.name, adoptU && adoptU.id); check(); $('#iLocal').focus() }
$('#bCopyCmd').onclick = e => copy(L.awsCmd(fd()), '', e.currentTarget)
$('#bCancel').onclick = () => $('#dForm').close()
$('#bDel').onclick = () => { const t = ed; $('#dForm').close(); del(t).catch(failed) }
$('#form').onsubmit = e => { e.preventDefault(); save(false).catch(failed) }
$('#bSaveGo').onclick = () => save(true).catch(failed)

/* ---------- commands, events ---------- */
const typingIn = el => !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')
const copyAllowed = () => !typingIn(document.activeElement) && !String(window.getSelection()).length
function selected() { if (view === 'logs') return null; const t = byName(selName); return t && $(`#list [data-row="${q(t.name)}"]`) ? t : null }
function runCommand(c) {
  if ($('dialog[open]')) return
  const t = selected()
  switch (c) {
    case 'new': return openForm('new')
    case 'find': $('#q').focus(); return $('#q').select()
    case 'settings': return openSet()
    case 'connectAll': return openAll()
    case 'disconnectAll': return stopAll(false)
    case 'shortcuts': return showSheet($('#dKeys'))
    case 'toggle': return t && toggle(t)
    case 'toggleAuto': return t && toggleAuto(t)
    case 'retry': return t && failing(t) && ssm.retry(t.name)
    case 'edit': return t && openForm('edit', t)
    case 'duplicate': return t && openForm('dup', t)
    case 'delete': return t && del(t)
    case 'copy': return t && copyAllowed() && copy(`localhost:${t.local}`)
  }
}
function act(a, t, b) {
  if (a.startsWith('aws')) return awsAct(a, b)
  switch (a) {
    case 'toggle': return t && toggle(t)
    case 'auto': return t && toggleAuto(t)
    case 'retry': return t && ssm.retry(t.name)
    case 'fixport': return t && fixPort(t)
    case 'copy': return t && copy(`localhost:${t.local}`)
    case 'copycli': return copy(b.dataset.text)
    case 'copyaws': return t && copy(L.awsCmd(t), 'aws command')
    case 'copysso': return copy('aws sso login')
    case 'more': return t && openMenu(t, b)
    case 'edit': return t && openForm('edit', t)
    case 'dup': return t && openForm('dup', t)
    case 'del': return t && del(t)
    case 'view': view = b.dataset.v; query = ''; $('#q').value = ''; return render()
    case 'showProd': view = 'prod'; return render()
    case 'discProd': return stopAll(true)
    case 'add': return openForm('new')
    case 'connectAll': return openAll()
    case 'disconnectAll': return stopAll(false)
    case 'archived': view = 'archived'; query = ''; $('#q').value = ''; render(); $('#bBack').focus(); return ssm.dismissNotice()
    case 'dismiss': return ssm.dismissNotice()
    case 'restore': return restore(b.dataset.id)
    case 'purge': return t && purge(t)
    case 'settings': return openSet()
    case 'login': return patchSettings({ openAtLogin: !M.settings.openAtLogin }, `Open at login ${M.settings.openAtLogin ? 'off' : 'on'}`)
    case 'quit': return patchSettings({ stopOnQuit: !M.settings.stopOnQuit })
    case 'impFix': { const rows = impRows(), x = rows[+b.dataset.i]; impOverrides[x.name] = impSuggest(x, rows); render(); return $('[data-a="import"]').focus() }
    case 'adopt': { const u = M.terminal.find(x => x.id === b.dataset.u); return u && openForm('adopt', null, u) }
    case 'kill': return killTerminal(b.dataset.u)
    case 'clearq': query = ''; $('#q').value = ''; render(); return $('#q').focus()
    case 'import': return importAll()
  }
}
async function importAll() {
  const r = await ssm.importTunnels(impOverrides)
  if (!r || !r.ok) return toast('Import failed')
  impOverrides = {}; view = 'all'; await refresh()
  toast(`Imported ${r.added.length} tunnel${r.added.length === 1 ? '' : 's'} from ssm-connect${r.skipped && r.skipped.length ? ` · ${r.skipped.length} skipped` : ''}`)
}
document.addEventListener('click', e => {
  const c = e.target.closest('[data-close]'); if (c) return c.closest('dialog').close()
  const b = e.target.closest('[data-a]'), inMenu = !!e.target.closest('#menu')
  if (inMenu) closeMenu(true); else if (!(b && b.dataset.a === 'more')) closeMenu()
  const row = e.target.closest('[data-row]'); if (row) select(row.dataset.row, !b)
  if (b) (async () => act(b.dataset.a, b.dataset.id != null ? byName(b.dataset.id) : null, b))().catch(failed)
})
$('#list').addEventListener('contextmenu', e => { const r = e.target.closest('[data-row]'); if (!r) return; e.preventDefault(); select(r.dataset.row); openMenu(byName(r.dataset.row), { x: e.clientX, y: e.clientY }) })
$('#q').addEventListener('input', e => { if (view === 'logs') return; query = e.target.value; render() })
document.addEventListener('keydown', e => {
  if ($('dialog[open]')) return // native dialogs handle Esc + focus
  const m = $('#menu')
  if (!m.hidden) {
    const items = $$('button', m), i = items.indexOf(document.activeElement)
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true) }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus() }
    else if (e.key === 'Tab') closeMenu()
    return
  }
  const typing = typingIn(e.target), k = e.key, c = e.code
  if (k === 'Escape') { if (e.target.id === 'q' && view !== 'logs') { e.target.value = ''; query = ''; render(); e.target.blur() } return }
  if (e.metaKey && !e.ctrlKey) {
    const plain = !e.altKey && !e.shiftKey; let cmd = null
    if (c === 'KeyN' && plain) cmd = 'new'
    else if (c === 'KeyF' && plain) cmd = 'find'
    else if (c === 'Comma' && plain) cmd = 'settings'
    else if (c === 'KeyK' && e.shiftKey) cmd = e.altKey ? 'disconnectAll' : 'connectAll'
    else if (c === 'KeyA' && e.altKey && !e.shiftKey) cmd = 'toggleAuto'
    else if (c === 'KeyR' && plain) cmd = 'retry'
    else if (c === 'KeyI' && plain) cmd = 'edit'
    else if (c === 'KeyD' && plain) cmd = 'duplicate'
    else if (c === 'KeyC' && plain && copyAllowed()) cmd = 'copy'
    else if (k === 'Backspace' && !typing) cmd = 'delete'
    if (cmd) { e.preventDefault(); runCommand(cmd) }
    return
  }
  if (typing || e.ctrlKey || e.altKey) return
  const run = f => { e.preventDefault(); f() }, t = selected(), onBtn = e.target.tagName === 'BUTTON'
  if (k === '?') return run(() => runCommand('shortcuts'))
  if (view === 'logs') return
  if (k === 'ArrowDown' || k === 'ArrowUp') return run(() => move(k === 'ArrowDown' ? 1 : -1))
  if (!t || (onBtn && (k === ' ' || k === 'Enter'))) return
  if (k === ' ') return run(() => toggle(t))
  if (k === 'Enter') return run(() => openForm('edit', t))
})

ssm.onEvent(ev => {
  if (!ev || !M) return
  const st = M.settings
  if (awsOnEvent(ev)) return
  if (ev.type === 'command') return (async () => runCommand(ev.command))().catch(failed)
  if (ev.type === 'navigate') {
    if (ev.view) { view = ev.view; query = ''; $('#q').value = ''; render() }
    if (ev.sheet === 'settings') openSet()
    if (ev.sheet === 'aws') awsOpen(ev.profile)
    return
  }
  if (ev.type === 'archived' && ev.names && ev.names.length) {
    const pd = st.purgeDays
    return toast(`Auto-archived ${ev.names.join(', ')} after ${st.archiveDays} failing days${pd ? ` · deleted permanently in ${pd} days unless restored` : ''}`,
      ['Undo', () => Promise.all(ev.names.map(n => ssm.restoreArchived(n)))])
  }
  if (ev.type === 'purged' && ev.names && ev.names.length) return toast(`Deleted ${ev.names.join(', ')} permanently (archived ${st.purgeDays} days)`)
})

function ingest(snap, quiet) {
  const next = normalize(snap)
  for (const t of next.tunnels) {
    if (t.archived) { retrying.delete(t.name); continue }
    if (t.state === 'reconnecting') retrying.set(t.name, t.attempt || 1)
    else if (t.state === 'active' && retrying.has(t.name)) {
      if (!L.stableActive(t, now())) continue // a failing retry reports active briefly; wait until it has lived 10 s
      const n = retrying.get(t.name); retrying.delete(t.name); if (!quiet) toast(`${t.name} reconnected on attempt ${fmt(n)}`) }
    else if (t.state === 'idle' || t.state === 'failed') retrying.delete(t.name)
  }
  for (const n of [...retrying.keys()]) if (!next.tunnels.some(t => t.name === n)) retrying.delete(n)
  M = next; render()
}

setInterval(() => { // 1 s: countdown text only; a countdown reaching 0 swaps to "Reconnecting…" via a full render
  if (!M) return
  let expired = false
  $$('[data-cd]').forEach(el => {
    const t = byName(el.dataset.cd)
    if (t && t.state === 'reconnecting') { if (!retryPending(t)) expired = true; else el.textContent = secs(t) + 's' }
  })
  if (expired) render()
}, 1000)
setInterval(() => M && render(), 30e3) // tick uptimes

ssm.onState(s => ingest(s))
ssm.getState().then(s => ingest(s, true)).catch(failed)
