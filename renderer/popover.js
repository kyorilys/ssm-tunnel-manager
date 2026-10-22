/* Menu bar popover: the mockup's popHTML driven by window.ssm (the contextBridge global; not redeclared). */
const { busy, failing } = L
let M = null

const byName = n => M && M.tunnels.find(t => t.name === n)
const prodLive = () => M.shown.filter(t => t.env === 'prod' && t.state === 'active')
const AWS_ON = L.awsSupported(typeof ssm === 'undefined' ? null : ssm)
const retryPending = t => t.nextAt && t.nextAt > Date.now()

function subText(t) {
  const s = t.state
  if (s === 'active') return `${esc(L.dur(t.since, Date.now()))} · PID ${esc(t.pid)}${t.origin === 'terminal' ? ' · Terminal' : ''}`
  if (s === 'connecting') return 'Connecting…'
  if (s === 'reconnecting') return retryPending(t) ? `Retrying in <span data-cd="${esc(t.name)}">${esc(secs(t))}s</span> · attempt ${esc(fmt(t.attempt))} of ${esc(t.maxAttempts || 5)}` : 'Reconnecting…'
  if (s === 'waiting') return `Waiting for sign-in · ${esc(t.profile || 'default')}`
  if (s === 'failed') return t.gaveUp ? `Stopped after ${esc(t.maxAttempts || 5)} attempts` : esc(L.stripGaveUp(t.error))
  return esc(t.desc)
}
const ctl = t => failing(t)
  ? `<button class="btn sm" data-a="retry" data-id="${esc(t.name)}">${t.state === 'reconnecting' ? 'Retry Now' : 'Retry'}</button>`
  : `<button class="sw" role="switch" aria-checked="${t.state === 'active' ? 'true' : t.state === 'connecting' || t.state === 'waiting' ? 'mixed' : 'false'}" data-a="toggle" data-id="${esc(t.name)}" aria-label="${esc(t.name)} tunnel"></button>`
const prow = t => `<div class="prow ${esc(t.state)}"><span class="dot" aria-hidden="true"></span><span style="min-width:0"><span class="pt"><b>${esc(t.name)}</b>${t.env === 'prod' ? '<span class="badge prod">PROD</span>' : ''}${t.auto ? `<span class="am" title="Auto-connect">${ic('loop')}<span class="vh">auto</span></span>` : ''}</span><small>${subText(t)}</small></span><span class="port-s">:${esc(t.local)}</span>${ctl(t)}</div>`

function awsLineHTML() {
  const l = AWS_ON ? L.popoverLine(M.snap.aws) : null; if (!l) return ''
  const n = esc(l.profile)
  if (l.kind === 'signing') return `<div class="pop-warn k"><span class="spin" aria-hidden="true"></span><span class="sp">${esc(l.text)}</span><button class="btn sm" data-a="awsCancel" data-p="${n}">Cancel</button></div>`
  return `<div class="pop-warn k">${ic('key')}<span class="sp">${esc(l.text)}</span>${l.canSignIn ? `<button class="btn sm" data-a="awsSignIn" data-p="${n}">Sign In</button>` : `<button class="btn sm" data-a="awsOpen">Details</button>`}</div>`
}
function popHTML() {
  const S = M.shown, pl = prodLive(), hot = S.filter(t => busy(t) || t.state === 'failed'), cold = S.filter(t => !hot.includes(t))
  const nt = M.notice, n = S.filter(t => t.state === 'active').length + M.terminal.length, term = M.terminal.length
  return `<div class="pop-hd"><b>SSM Tunnels</b><span class="sub">${n} connected</span></div>
    ${L.allFailing(M.tunnels) ? `<div class="pop-warn e">${ic('warn')}<span class="sp"><b>Every tunnel is failing</b></span></div>` : ''}
    ${awsLineHTML()}
    ${pl.length ? `<div class="pop-warn">${ic('shield')}<span class="sp"><b>${pl.length} production live</b></span><button class="btn sm" data-a="discProd">Disconnect</button></div>` : ''}
    ${nt.length ? `<div class="pop-note">${ic('archive')}<span class="sp">${nt.length === 1 ? esc(nt[0]) + ' was' : nt.length + ' tunnels were'} auto-archived</span><button class="btn sm ghost" data-a="archived">View</button></div>` : ''}
    ${term ? `<div class="pop-note">${ic('term')}<span class="sp">${term} unsaved Terminal session${term > 1 ? 's' : ''}</span><button class="btn sm ghost" data-a="openApp">Review</button></div>` : ''}
    <div class="pop-list">${hot.length ? `<h4>Active</h4>${hot.map(prow).join('')}` : ''}${cold.length ? `<h4>Saved</h4>${cold.map(prow).join('')}` : ''}${S.length ? '' : '<p class="sub" style="padding:8px">No tunnels yet.</p>'}</div>
    <div class="pop-ft"><button class="btn sm" data-a="disconnectAll">Disconnect All</button><span class="sp"></span><button class="btn sm ic" data-a="settings" aria-label="Settings" title="Settings (⌘,)">${ic('gear')}</button><button class="btn sm" data-a="openApp">Open SSM Tunnels</button></div>`
}

function render() {
  const pop = $('#pop'), a = document.activeElement
  let sel = null
  if (a && a !== document.body && pop.contains(a) && a.dataset.a) sel = ['a', 'id'].filter(k => a.dataset[k] != null).map(k => `[data-${k}="${CSS.escape(a.dataset[k])}"]`).join('')
  const top = $('.pop-list', pop) ? $('.pop-list', pop).scrollTop : 0
  pop.innerHTML = popHTML()
  const list = $('.pop-list', pop); if (list) list.scrollTop = top
  if (sel) { const el = $(sel, pop); if (el) el.focus({ preventScroll: true }) }
  ssm.resizePopover(document.body.scrollHeight)
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b) return
  const t = b.dataset.id != null ? byName(b.dataset.id) : null
  switch (b.dataset.a) {
    case 'toggle': if (t) busy(t) ? ssm.disconnect(t.name) : ssm.connect(t.name); break
    case 'retry': if (t) ssm.retry(t.name); break
    case 'discProd': ssm.disconnectEnv('production'); break
    case 'disconnectAll': ssm.disconnectAll(); break
    case 'archived': ssm.openMain({ view: 'archived' }); break
    case 'settings': ssm.openMain({ sheet: 'settings' }); break
    case 'awsSignIn': ssm.awsSignIn(b.dataset.p || 'default').catch(() => {}); break
    case 'awsCancel': ssm.awsCancelSignIn(b.dataset.p || 'default').catch(() => {}); break
    case 'awsOpen': ssm.openMain({ sheet: 'aws' }); break
    case 'openApp': ssm.openMain({}); break
  }
})

function ingest(snap) { M = normalize(snap); render() }

setInterval(() => { // 1 s: countdown text only; a countdown reaching 0 swaps to "Reconnecting…" via a full render
  let expired = false
  $$('[data-cd]').forEach(el => {
    const t = byName(el.dataset.cd)
    if (t && t.state === 'reconnecting') { if (!retryPending(t)) expired = true; else el.textContent = secs(t) + 's' }
  })
  if (expired) render()
}, 1000)
setInterval(() => M && render(), 30e3)

ssm.onState(ingest)
ssm.getState().then(ingest)
