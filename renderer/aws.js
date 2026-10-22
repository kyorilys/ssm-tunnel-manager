/* AWS profiles: sidebar line, sign-in banner, the AWS Profiles sheet (list / add SSO / add keys / edit in one sheet) and the
   tunnel-form profile picker. Loaded before renderer.js; it reads that file's globals (M, toast, showSheet, ...) only at call time.
   Everything is gated on AWS_ON so an older preload (no aws calls) simply hides the feature. Text from profile names, identities
   and messages always goes through esc() or textContent. */
const AWS_ON = L.awsSupported(typeof ssm === 'undefined' ? null : ssm)
const AWS_CFG = '~/.aws/config', AWS_CRED = '~/.aws/credentials'
const AW = { data: null, v: 'list', ed: null, open: new Set(), hl: null, rm: null, tried: false, saving: false, formErr: [], testing: new Set(), si: null, done: new Map(), sig: '' }

const awsSnap = () => (AWS_ON && M && M.snap && M.snap.aws) || null
const awsPName = n => n || 'default'
// Sign-in state: what this window started (AW.si), else what the snapshot says is running (e.g. started from the menu bar).
function awsSi() {
  if (AW.si) return AW.si
  const s = awsSnap(); return s && s.signingIn ? { profile: s.signingIn, phase: 'waiting' } : null
}
function awsProfiles() {
  const snapP = (awsSnap() || {}).profiles || []
  if (!AW.data) return snapP.map(p => ({ ...p, tunnels: 0 }))
  const fresh = new Map(snapP.map(p => [p.name, p.status]))
  return AW.data.profiles.map(p => ({ ...p, status: fresh.get(p.name) || p.status }))
}
const awsUsers = n => M.shown.filter(t => awsPName(t.profile) === n)
const awsFind = n => awsProfiles().find(p => p.name === awsPName(n))
const awsAnn = (m) => announce(m)
const awsKeys = ['a', 'p']
const awsSel = a => awsKeys.filter(k => a.dataset[k] != null).map(k => `[data-${k}="${q(a.dataset[k])}"]`).join('')

async function awsLoad() {
  if (!AWS_ON) return
  try { AW.data = await ssm.awsProfiles() } catch (_) { /* keep the last list */ }
  if ($('#dAws').open && AW.v === 'list') awsDraw()
  if ($('#dForm').open) awsProfMsg()
  if ($('#dSet').open) awsDrawSet()
}

/* ---------- called from renderer.js render() ---------- */
function awsPaint() {
  if (!AWS_ON) return
  const s = awsSnap(), side = $('#sideAws'), sd = L.sidebarAws(AW.si && AW.si.phase !== 'failed' ? { ...(s || {}), signingIn: AW.si.profile } : s)
  side.innerHTML = sd ? `<button class="link aws-st ${sd.cls}" data-a="awsOpen" title="AWS profiles and sign-in">${ic(sd.icon)}<span>${esc(sd.text)}</span></button>` : ''
  const sig = JSON.stringify(((s || {}).profiles || []).map(p => [p.name, p.status && p.status.state]))
  if (sig !== AW.sig) { AW.sig = sig; if ($('#dAws').open || $('#dForm').open) awsLoad() }
  if ($('#dAws').open && AW.v === 'list') awsDraw()
  if ($('#dForm').open) { awsFillProf(); awsProfMsg() }
  if ($('#dSet').open) awsDrawSet()
}
function awsBannerHTML() {
  if (!AWS_ON) return ''
  const s = awsSnap(), si = AW.si, shown = si || (s && s.signingIn ? { profile: s.signingIn, phase: 'waiting' } : null)
  if (shown) {
    const n = esc(shown.profile)
    if (shown.phase === 'failed') return `<div class="banner aws err" role="status">${ic('x')}<span><b>Couldn’t sign in to ${n}.</b> ${esc(shown.message || '')}</span><span class="sp"></span><button class="btn sm" data-a="awsOpen" data-p="${n}">Details</button><button class="btn sm ic" data-a="awsSiDismiss" aria-label="Dismiss" title="Dismiss">${ic('x')}</button><button class="btn sm pri" data-a="awsSignIn" data-p="${n}">Try Again</button></div>`
    const t = L.signInPhaseText(shown.phase, shown.profile).text
    return `<div class="banner aws" role="status"><span class="spin" aria-hidden="true"></span><span><b>${esc(t)}</b> · signing in to ${n}</span><span class="sp"></span><button class="btn sm" data-a="awsCancel" data-p="${n}">Cancel</button></div>`
  }
  if (s && s.noCredentials && !(s.profiles || []).length) return `<div class="banner aws">${ic('key')}<span><b>No AWS credentials found on this Mac.</b> Tunnels can’t connect until you set up AWS access.</span><span class="sp"></span><button class="btn sm pri" data-a="awsOpen">Set Up AWS Access…</button></div>`
  const b = L.bannerText(s && s.waiting); if (!b) return ''
  const n = esc(b.profile)
  return `<div class="banner aws" role="status">${ic('key')}<span><b>${esc(b.text)}</b></span><span class="sp"></span><button class="btn sm" data-a="awsOpen" data-p="${n}">Details</button>${b.canSignIn ? `<button class="btn sm pri" data-a="awsSignIn" data-p="${n}">Sign In</button>` : ''}</div>`
}
const awsChip = t => {
  if (!t.profile) return ''
  const known = !AWS_ON || !awsSnap() || awsSnap().profiles.some(p => p.name === t.profile), n = esc(t.profile)
  return `<span class="pchip${known ? '' : ' miss'}" title="${known ? 'AWS profile ' : 'AWS profile not found: '}${n}">${ic('key')}${n}${known ? '' : '<span class="vh"> (not found)</span>'}</span>`
}
const awsWaitingSt = t => { const w = L.waitingText(t.profile); return `<div class="st wait"><div class="l1">${ic('key')}${esc(w.l1)}</div><div class="l2">${esc(w.l2)}</div></div>` }

/* ---------- sign-in ---------- */
function awsAnnPhase(phase, profile, message) { const t = L.signInPhaseText(phase, profile, message).text; if (t) awsAnn(t) }
async function awsSignInStart(name) {
  if (!AWS_ON || !name) return
  AW.si = { profile: name, phase: 'opening' }; render(); awsAnnPhase('opening', name)
  let r
  try { r = await ssm.awsSignIn(name) } catch (e) { r = { ok: false, message: e && e.message } }
  const si = AW.si; if (!si || si.profile !== name || si.phase === 'failed') return // an event already settled it
  r && r.ok ? awsSiDone(name) : r && r.cancelled ? awsSiClear(name, true) : awsSiFail(name, r && r.message)
}
function awsSiDone(name) {
  AW.si = null; const last = AW.done.get(name); AW.done.set(name, Date.now())
  render(); awsLoad(); refresh().catch(() => {})
  if (last && Date.now() - last < 3000) return
  toast(`Signed in to ${name}`); awsAnnPhase('done', name)
}
function awsSiFail(name, message) { AW.si = { profile: name, phase: 'failed', message: message || '' }; render(); awsAnnPhase('failed', name, message); awsLoad() }
function awsSiClear(name, announceIt) { AW.si = null; render(); if (announceIt) awsAnnPhase('cancelled', name) }
function awsOnEvent(ev) { // main-process progress: { type:'aws-signin', profile, phase, message? }
  if (!AWS_ON || !ev || ev.type !== 'aws-signin' || !ev.profile) return false
  const n = ev.profile
  if (ev.phase === 'opening' || ev.phase === 'waiting') { AW.si = { profile: n, phase: ev.phase }; render(); awsAnnPhase(ev.phase, n) }
  else if (ev.phase === 'done') awsSiDone(n)
  else if (ev.phase === 'failed') awsSiFail(n, ev.message)
  else if (ev.phase === 'cancelled') awsSiClear(n, true)
  return true
}

/* ---------- AWS Profiles sheet ---------- */
function awsStCell(p) {
  const si = awsSi(), signing = !!si && si.profile === p.name && si.phase !== 'failed'
  const s = L.statusLine(AW.testing.has(p.name) ? { ...p, status: { state: 'checking' } } : p, { signingIn: signing })
  const t = s.l1 + (s.l2 ? ' · ' + s.l2 : '')
  return `<div class="st ${s.cls === 'wait' ? 'wait' : esc(s.cls)}" title="${esc(t)}"><div class="l1">${s.spin ? '<span class="spin" aria-hidden="true"></span>' : ic(s.icon)}<span class="tx">${esc(s.l1)}</span></div><div class="l2">${esc(s.l2)}</div></div>`
}
function awsSiInline(n) {
  const si = awsSi(); if (!si || si.profile !== n) return ''
  if (si.phase === 'failed') return `<div class="pf-si err" role="status">${ic('x')}<span>${esc(si.message || 'Sign-in didn’t complete.')}</span><span class="sp"></span><button type="button" class="btn sm" data-a="awsSiDismiss">Dismiss</button><button type="button" class="btn sm pri" data-a="awsSignIn" data-p="${esc(n)}">Try Again</button></div>`
  return `<div class="pf-si"><span class="spin" aria-hidden="true"></span><span>${esc(L.signInPhaseText(si.phase, n).text)}</span><span class="sp"></span><button type="button" class="btn sm" data-a="awsCancel" data-p="${esc(n)}">Cancel</button></div>`
}
function awsProfHTML(p) {
  const o = AW.open.has(p.name), id = esc(p.name), sso = p.type === 'sso', u = awsUsers(p.name), si = awsSi(), mine = !!si && si.profile === p.name && si.phase !== 'failed'
  const ok = p.status && p.status.state === 'ok'
  const acts = `<button class="btn sm" data-a="awsTest" data-p="${id}"${AW.testing.has(p.name) || mine ? ' disabled' : ''}>Test</button>` + (sso && !mine ? `<button class="btn sm${ok ? '' : ' pri'}" data-a="awsSignIn" data-p="${id}">Sign In</button>` : '')
  const s = L.statusLine(p)
  return `<li class="prof${AW.hl === p.name ? ' hl' : ''}">
    <button class="pf-h" data-a="awsExp" data-p="${id}" aria-expanded="${o}"${o ? ` aria-controls="pd-${id}"` : ''} aria-label="${esc(`${p.name}, ${L.TYPE_LABELS[p.type] || p.type}${p.name === 'default' ? ', default profile' : ''}, ${s.l1}`)}">${ic('chev', 'chev')}
      <span class="pf-n"><b>${id}</b><span class="ptype">${esc(L.TYPE_LABELS[p.type] || p.type)}</span>${p.name === 'default' ? '<span class="ptype">Default</span>' : ''}</span>
      <span class="pf-m">${esc(p.region || 'no region')} · ${p.tunnels || u.length ? `used by ${(p.tunnels || u.length)} tunnel${(p.tunnels || u.length) > 1 ? 's' : ''}` : 'no tunnels'}</span></button>
    ${awsStCell(p)}<div class="pf-a">${acts}</div>${awsSiInline(p.name)}${o ? awsDetHTML(p, u) : ''}</li>`
}
function awsDetHTML(p, u) {
  const id = esc(p.name), sso = p.type === 'sso', R = []
  if (sso) {
    R.push(['Source', `<span class="mono">${AWS_CFG} [${p.name === 'default' ? 'default' : 'profile ' + id}]${p.ssoSession ? ` + [sso-session ${esc(p.ssoSession)}]` : ''}</span>`])
    R.push(['Start URL', `<span class="mono">${esc(p.ssoStartUrl || '')}</span>${p.ssoRegion ? ' · ' + esc(p.ssoRegion) : ''}`])
    R.push(['Account · role', `${esc(p.accountId || 'unknown')} · ${esc(p.roleName || '')}`])
  } else if (p.type === 'keys') R.push(['Access keys', `${p.hasKeys ? 'secret stored, never shown' : 'none'} · <span class="mono">${AWS_CRED} [${id}]</span>`])
  else R.push(['Source', 'Defined outside SSM Tunnels'])
  R.push(['Tunnels', u.length ? `<span class="tags">${u.map(t => `<span class="tag${t.env === 'prod' ? ' prod' : ''}">${esc(t.name)} <span class="mono">:${esc(t.local)}</span></span>`).join('')}</span>` : 'None'])
  if (sso) R.push(['Sign-in runs', `<span class="mono">aws sso login --profile ${id}</span>`])
  const st = p.status
  if (st && st.message && st.state !== 'ok') R.push(['Last message', `<span class="eline">${esc(st.message)}</span>`])
  R.push(['Last check', st && st.checkedAt ? esc(L.ago(st.checkedAt, Date.now())) : 'not yet'])
  const managed = p.type === 'sso' || p.type === 'keys'
  const mg = managed ? `<div class="pf-mg"><span class="sp"></span><button class="btn sm" data-a="awsEdit" data-p="${id}">${sso ? 'Edit…' : 'Replace Keys…'}</button><button class="btn sm red" data-a="awsRm" data-p="${id}">Remove…</button></div>` : `<div class="pf-mg"><span>Defined outside SSM Tunnels. Edit <span class="mono">${AWS_CFG}</span> to change it.</span></div>`
  return `<div class="pf-d" id="pd-${id}"><dl>${R.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${mg}${AW.rm === p.name ? awsRmHTML(p, u) : ''}</div>`
}
function awsRmHTML(p, u) {
  const id = esc(p.name), names = u.map(t => t.name)
  return `<div class="confirm" role="group" aria-labelledby="rmT">${ic('warn')}<div><b id="rmT">Remove ${id}?</b> It is deleted from ${AWS_CFG}${p.type === 'keys' ? ` and ${AWS_CRED}` : ''}.
    <p>${names.length ? `<b>${esc(L.removeWarning(p.name, names))}</b>` : 'No tunnels use it.'}</p>
    <div class="btns"><button class="btn sm" data-a="awsRmNo" data-p="${id}">Cancel</button><button class="btn sm red" data-a="awsRmYes" data-p="${id}">Remove Profile</button></div></div></div>`
}
function awsSetupHTML() {
  return `<div class="setup-hd">${ic('key')}<h3>Set up AWS access</h3><p>Tunnels run <span class="mono">aws ssm start-session</span>, which needs AWS credentials. None were found in ${AWS_CFG} or ${AWS_CRED}.</p></div>
  <div class="setup"><div class="path rec"><h4>${ic('globe')}Sign in with SSO <span class="ptype">Recommended</span></h4><p>Sign in through your organization’s AWS access portal in your browser. Nothing secret is saved; when the session ends, sign in again with one click.</p><p class="sub">You’ll need the start URL, account ID and role name.</p><button class="btn pri" data-a="awsAddSso">Set Up SSO…</button></div>
  <div class="path"><h4>${ic('key')}Use access keys</h4><p>An access key ID and secret for an IAM user, saved in ${AWS_CRED} and readable only by you. Keys don’t expire, so they need more care.</p><p class="sub">You’ll need both values from IAM.</p><button class="btn" data-a="awsAddKeys">Add Access Keys…</button></div></div>`
}
function awsSrcHTML(files) {
  const f = files || {}, ps = awsProfiles()
  return `<div class="srcs" role="group" aria-labelledby="srcH"><h4 id="srcH">Sources</h4>
    <div>${ic('doc')}<span class="mono">${AWS_CFG}</span><span>· ${ps.length ? `${ps.length} profile${ps.length > 1 ? 's' : ''}` : 'no profiles'}${f.config === false ? ' · not found' : ''}</span></div>
    <div>${ic('lock')}<span class="mono">${AWS_CRED}</span><span>· ${ps.filter(p => p.hasKeys).length ? 'access keys saved · readable only by you' : 'no keys'}${f.credentials === false ? ' · not found' : ''}</span></div>
    ${AW.data && AW.data.envCredentials ? `<div>${ic('term')}<span>Environment credentials were seen when the app started.</span></div>` : ''}
    <p>Re-read whenever these files change. Secrets are never shown or logged.</p></div>`
}
const awsRegOpts = v => [...new Set([...REGIONS, v].filter(Boolean))].map(r => `<option${r === v ? ' selected' : ''}>${esc(r)}</option>`).join('')
const awsMsgBox = () => `<div class="msg err" id="wErr" role="alert">${esc(AW.formErr.join(' '))}</div>`
function awsSsoFormHTML(e) {
  const v = k => esc(e ? e[k] || '' : '')
  return `<form id="fSso" class="wform" novalidate autocomplete="off">
  <div class="cols"><div class="f"><label for="sName">Profile name</label><input id="sName" class="mono" spellcheck="false" placeholder="team-prod" value="${v('name')}"${e ? ' readonly' : ''} aria-describedby="mSName"><div class="msg" id="mSName"></div></div>
    <div class="f"><label for="sReg">Default region</label><select id="sReg">${awsRegOpts(e && e.region ? e.region : L.preferredRegion(M.tunnels))}</select></div></div>
  <div class="f"><label for="sUrl">SSO start URL</label><input id="sUrl" class="mono" spellcheck="false" placeholder="https://d-xxxxxxxxxx.awsapps.com/start" value="${v('ssoStartUrl')}" aria-describedby="mSUrl"><div class="msg" id="mSUrl"></div></div>
  <div class="cols"><div class="f"><label for="sSReg">SSO region</label><select id="sSReg">${awsRegOpts(e && e.ssoRegion ? e.ssoRegion : 'us-east-1')}</select></div>
    <div class="f"><label for="sAcct">Account ID</label><input id="sAcct" class="mono" inputmode="numeric" spellcheck="false" placeholder="${e ? `Current ${esc(e.accountId || 'unknown')} · enter it again` : '123456789012'}" aria-describedby="mSAcct"><div class="msg" id="mSAcct"></div></div></div>
  <div class="f"><label for="sRole">Role name</label><input id="sRole" class="mono" spellcheck="false" placeholder="DeveloperAccess" value="${v('roleName')}" aria-describedby="mSRole"><div class="msg" id="mSRole"></div></div>
  <div class="f"><span class="lbl" id="lSPrev">What will be written to ${AWS_CFG} (no secrets)</span><pre class="cmd cfg" id="sPrev" aria-labelledby="lSPrev"></pre></div>${awsMsgBox()}</form>`
}
function awsKeysFormHTML(e) {
  return `<form id="fKeys" class="wform" novalidate autocomplete="off">
  <div class="cols"><div class="f"><label for="kName">Profile name</label><input id="kName" class="mono" spellcheck="false" placeholder="ci-user" value="${esc(e ? e.name : '')}"${e ? ' readonly' : ''} aria-describedby="mKName"><div class="msg" id="mKName"></div></div>
    <div class="f"><label for="kReg">Default region</label><select id="kReg">${awsRegOpts(e && e.region ? e.region : L.preferredRegion(M.tunnels))}</select></div></div>
  <div class="f"><label for="kId">Access key ID</label><input id="kId" class="mono" spellcheck="false" autocomplete="off" placeholder="AKIA…" aria-describedby="mKId"><div class="msg" id="mKId"></div></div>
  <div class="f"><label for="kSec">Secret access key</label><div class="inrow"><input id="kSec" type="password" class="mono" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="40 characters" aria-describedby="mKSec kNote"><button type="button" class="btn sm" data-a="awsReveal" aria-pressed="false" aria-controls="kSec">${ic('eye')}<span>Show</span></button></div><div class="msg" id="mKSec"></div></div>
  <div class="keynote" id="kNote">${ic('lock')}<div><p>Saved in <span class="mono">${AWS_CRED}</span>, readable only by you (permissions 600). SSM Tunnels never logs the secret and won’t show it again after you save.</p>
    <p>Access keys don’t expire on their own. If your organization offers SSO, prefer it. <button type="button" class="btn sm ghost" data-a="awsAddSso">Use SSO Instead</button></p></div></div>
  <div class="f"><span class="lbl" id="lKPrev">What will be written</span><pre class="cmd cfg" id="kPrev" aria-labelledby="lKPrev"></pre></div>${awsMsgBox()}</form>`
}
function awsDraw() {
  const sc = $('#wBody').scrollTop
  const v = AW.v, e = AW.ed, b = $('#wBody'), a = document.activeElement, had = b.contains(a), keep = had && a.dataset.a ? awsSel(a) : null
  const T = {
    list: ['AWS Profiles', 'Sign-ins aws can use for your tunnels. Each tunnel picks one in its form; otherwise it uses the default profile.'],
    sso: [e ? `Edit “${e.name}”` : 'Add SSO Profile', `Saved to ${AWS_CFG}. Nothing secret: you sign in through your browser.`],
    keys: [e ? `Replace Keys for “${e.name}”` : 'Add Access Keys', 'For an IAM user. Prefer SSO when your organization offers it.'],
  }[v]
  $('#wTitle').textContent = T[0]; $('#wSub').textContent = T[1]
  const ps = awsProfiles()
  if (v === 'sso') b.innerHTML = awsSsoFormHTML(e)
  else if (v === 'keys') b.innerHTML = awsKeysFormHTML(e)
  else {
    const files = AW.data && AW.data.files
    b.innerHTML = ps.length ? `<div class="wbar"><button class="btn sm" data-a="awsAddSso">${ic('plus')}SSO Profile…</button><button class="btn sm" data-a="awsAddKeys">${ic('plus')}Access Keys…</button><span class="sp"></span><button class="btn sm" data-a="awsTestAll">Test All</button></div><ul class="profs" aria-label="AWS profiles">${ps.map(awsProfHTML).join('')}</ul>${awsSrcHTML(files)}` : awsSetupHTML() + awsSrcHTML(files)
  }
  $('#wFt').innerHTML = v === 'list' ? '<span class="sp"></span><button class="btn pri" data-close>Done</button>'
    : `<span class="sp"></span><button class="btn" type="button" data-a="awsBack">Cancel</button><button class="btn pri" type="submit" form="${v === 'sso' ? 'fSso' : 'fKeys'}"${AW.saving ? ' disabled' : ''}>${v === 'sso' ? (e ? 'Save' : 'Save &amp; Sign In') : 'Save &amp; Test'}</button>`
  if (v === 'sso') awsSsoCheck(); if (v === 'keys') awsKeysCheck()
  b.scrollTop = sc
  if (had) { const el = keep && $(keep, b); if (el) el.focus({ preventScroll: true }); else if (!b.contains(document.activeElement)) ($('[data-a="awsCancel"],[data-a="awsSignIn"]', b) || $('#wTitle')).focus({ preventScroll: true }) }
}
function awsClearSecret() { const s = $('#kSec'); if (s) { s.value = ''; s.type = 'password' } }
function awsView(v, ed = null) {
  awsClearSecret(); AW.v = v; AW.ed = ed; AW.rm = null; AW.tried = false; AW.saving = false; AW.formErr = []; awsDraw()
  if (v !== 'list') $(v === 'sso' ? (ed ? '#sUrl' : '#sName') : (ed ? '#kId' : '#kName')).focus()
}
function awsBackToList() { const n = AW.ed && AW.ed.name; awsView('list'); const el = n && $(`.pf-h[data-p="${q(n)}"]`); (el || $('[data-a="awsAddSso"]', $('#wBody')) || $('#wTitle')).focus() }
function awsOpen(profile) {
  if (!AWS_ON) return
  closeMenu()
  const d = $('#dAws')
  if (!d.open) { $$('dialog[open]').forEach(x => x.close()); AW.v = 'list'; AW.ed = null; AW.rm = null }
  if (profile != null && profile !== '') { AW.open.add(profile); AW.hl = profile }
  awsDraw(); if (!d.open) showSheet(d)
  awsLoad()
  const el = profile ? $(`.pf-h[data-p="${q(profile)}"]`) : null
  if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }) } else ($('[data-a="awsAddSso"]', $('#wBody')) || $('#wTitle')).focus()
}
function awsShowMsgs(map, E) {
  for (const [k, [inp, msg]] of Object.entries(map)) { const bad = AW.tried && E[k], m = $(msg); m.className = 'msg' + (bad ? ' err' : ''); m.textContent = bad || ''; $(inp).setAttribute('aria-invalid', !!bad) }
}
const awsNames = () => awsProfiles().map(p => p.name).filter(n => !AW.ed || n !== AW.ed.name)
function awsSsoData() { return { name: $('#sName').value.trim(), region: $('#sReg').value, startUrl: $('#sUrl').value.trim(), ssoRegion: $('#sSReg').value, accountId: $('#sAcct').value.replace(/[\s-]/g, ''), roleName: $('#sRole').value.trim() } }
function awsSsoCheck() {
  const d = awsSsoData(), E = L.validateSso(d, awsNames())
  awsShowMsgs({ name: ['#sName', '#mSName'], startUrl: ['#sUrl', '#mSUrl'], accountId: ['#sAcct', '#mSAcct'], roleName: ['#sRole', '#mSRole'] }, E)
  $('#sPrev').textContent = L.ssoPreview(d); return { E, d }
}
function awsKeysCheck() {
  // Reads the fields only to validate and preview; the secret is never copied to a variable that outlives this call.
  const E = L.validateKeys({ name: $('#kName').value.trim(), accessKeyId: $('#kId').value, secretAccessKey: $('#kSec').value, region: $('#kReg').value }, awsNames())
  awsShowMsgs({ name: ['#kName', '#mKName'], accessKeyId: ['#kId', '#mKId'], secretAccessKey: ['#kSec', '#mKSec'] }, E)
  const n = $('#kName').value.trim() || '<profile name>', id = $('#kId').value.trim().toUpperCase(), has = !!$('#kSec').value
  $('#kPrev').textContent = `${AWS_CRED}\n[${n}]\naws_access_key_id = ${id ? L.maskKey(id) : '<key id>'}\naws_secret_access_key = ${has ? '(hidden)' : '<secret>'}\n\n${AWS_CFG}\n[${n === 'default' ? 'default' : 'profile ' + n}]\nregion = ${$('#kReg').value}`
  return E
}
// Editing a profile under its own name overwrites it; a new or renamed one must not clobber an existing profile.
const awsReplaceOpt = name => (AW.ed && AW.ed.name === name ? { replace: true } : undefined)
async function awsSaveSso() {
  if (AW.saving) return
  AW.tried = true; const { E, d } = awsSsoCheck(), bad = Object.keys(E)[0]
  if (bad) return $({ name: '#sName', startUrl: '#sUrl', accountId: '#sAcct', roleName: '#sRole' }[bad]).focus()
  AW.saving = true; $('#wFt button[type=submit]').disabled = true
  let r; try { r = await ssm.awsAddSso(d, awsReplaceOpt(d.name)) } catch (e) { r = { ok: false, errors: [e && e.message || 'Couldn’t save'] } }
  AW.saving = false
  if (!r || !r.ok) { AW.formErr = (r && r.errors) || ['Couldn’t save the profile.']; $('#wErr').textContent = AW.formErr.join(' '); $('#wFt button[type=submit]').disabled = false; return }
  const edited = !!AW.ed
  AW.v = 'list'; AW.ed = null; AW.tried = false; AW.formErr = []; AW.open.add(d.name); AW.hl = d.name
  await awsLoad(); awsDraw(); await refresh()
  const el = $(`.pf-h[data-p="${q(d.name)}"]`); if (el) el.focus()
  if (edited) toast(`Saved ${d.name} to ${AWS_CFG}`); else { toast(`Saved ${d.name} · signing in`); awsSignInStart(d.name) }
}
async function awsSaveKeys() {
  if (AW.saving) return
  AW.tried = true; const E = awsKeysCheck(), bad = Object.keys(E)[0]
  if (bad) return $({ name: '#kName', accessKeyId: '#kId', secretAccessKey: '#kSec' }[bad]).focus()
  AW.saving = true; $('#wFt button[type=submit]').disabled = true
  const name = $('#kName').value.trim()
  let r
  try { r = await ssm.awsAddKeys({ name, accessKeyId: $('#kId').value.trim().toUpperCase(), secretAccessKey: $('#kSec').value, region: $('#kReg').value }, awsReplaceOpt(name)); awsClearSecret() } // the object literal is the only copy; it ends with this expression
  catch (e) { awsClearSecret(); r = { ok: false, errors: [e && e.message || 'Couldn’t save'] } }
  AW.saving = false
  if (!r || !r.ok) { AW.formErr = (r && r.errors) || ['Couldn’t save the keys.']; $('#wErr').textContent = AW.formErr.join(' '); $('#wFt button[type=submit]').disabled = false; return }
  AW.v = 'list'; AW.ed = null; AW.tried = false; AW.formErr = []; AW.open.add(name); AW.hl = name
  await awsLoad(); awsDraw(); await refresh()
  const el = $(`.pf-h[data-p="${q(name)}"]`); if (el) el.focus()
  toast(`Saved ${name} · testing it now`); awsTest(name)
}
async function awsTest(name) {
  if (!AWS_ON || AW.testing.has(name)) return
  AW.testing.add(name); awsPaint()
  let s; try { s = await ssm.awsTest(name) } catch (e) { s = { state: 'error', message: e && e.message } }
  AW.testing.delete(name); await awsLoad(); await refresh()
  const p = awsFind(name), st = p && L.statusLine({ ...p, status: s || p.status })
  if (st) awsAnn(`${name}: ${st.l1}${st.l2 ? ', ' + st.l2 : ''}`)
}
async function awsRemove(name) {
  const used = awsUsers(name).length
  const r = await ssm.awsRemoveProfile(name, { force: used > 0 })
  if (!r || !r.ok) { AW.rm = null; awsDraw(); return toast(r && r.usedBy ? `${name} is still used by ${r.usedBy.join(', ')}` : `Couldn’t remove ${name}`) }
  AW.rm = null; AW.open.delete(name); await awsLoad(); await refresh(); awsDraw()
  ;($('[data-a="awsAddSso"]', $('#wBody')) || $('#wTitle')).focus()
  toast(`Removed ${name}${used ? ` · ${used} tunnel${used > 1 ? 's' : ''} keep the name and show “profile not found”` : ''}`)
}
function awsAct(a, b) {
  const p = b.dataset.p
  switch (a) {
    case 'awsOpen': return awsOpen(p)
    case 'awsFromSet': $('#dSet').close(); return awsOpen()
    case 'awsSignIn': return awsSignInStart(awsPName(p))
    case 'awsCancel': return ssm.awsCancelSignIn(awsPName(p)).then(() => { if (AW.si && AW.si.profile === awsPName(p)) awsSiClear(awsPName(p), true) })
    case 'awsSiDismiss': AW.si = null; return render()
    case 'awsExp': AW.open.has(p) ? AW.open.delete(p) : AW.open.add(p); AW.hl = null; return awsDraw()
    case 'awsTest': return awsTest(p)
    case 'awsTestAll': return Promise.all(awsProfiles().map(x => awsTest(x.name)))
    case 'awsAddSso': return awsView('sso')
    case 'awsAddKeys': return awsView('keys')
    case 'awsEdit': { const x = awsFind(p); return x && awsView(x.type === 'keys' ? 'keys' : 'sso', x) }
    case 'awsRm': AW.rm = p; awsDraw(); return $('[data-a="awsRmNo"]', $('#wBody')).focus()
    case 'awsRmNo': AW.rm = null; awsDraw(); { const x = $(`[data-a="awsRm"][data-p="${q(p)}"]`); return x && x.focus() }
    case 'awsRmYes': return awsRemove(p)
    case 'awsBack': return awsBackToList()
    case 'awsReveal': { const s = $('#kSec'), on = s.type === 'password'; s.type = on ? 'text' : 'password'; b.setAttribute('aria-pressed', on); b.querySelector('span').textContent = on ? 'Hide' : 'Show'; return }
  }
}
if (AWS_ON) {
  document.addEventListener('input', e => { if (e.target.closest('#fSso')) awsSsoCheck(); else if (e.target.closest('#fKeys')) awsKeysCheck() })
  document.addEventListener('change', e => { if (e.target.closest('#fSso')) awsSsoCheck(); else if (e.target.closest('#fKeys')) awsKeysCheck() })
  document.addEventListener('submit', e => { if (e.target.id === 'fSso') { e.preventDefault(); awsSaveSso().catch(failed) } else if (e.target.id === 'fKeys') { e.preventDefault(); awsSaveKeys().catch(failed) } })
  $('#dAws').addEventListener('cancel', e => { if (AW.v !== 'list') { e.preventDefault(); awsBackToList() } }) // Esc in a form goes back to the list
  $('#dAws').addEventListener('close', () => { awsClearSecret(); AW.v = 'list'; AW.ed = null; AW.rm = null; AW.hl = null; AW.tried = false; AW.saving = false; AW.formErr = []; $('#wBody').innerHTML = '' })
}

/* ---------- Settings row ---------- */
function awsDrawSet() {
  const row = $('#sAwsRow'); row.hidden = !AWS_ON; if (!AWS_ON) return
  const ps = awsProfiles(), w = L.groupWaiting((awsSnap() || {}).waiting), n = w.reduce((c, x) => c + x.tunnels.length, 0)
  $('#sAws').textContent = !ps.length ? 'No AWS credentials found. Tunnels can’t connect until you set up access.'
    : `${ps.length} profile${ps.length > 1 ? 's' : ''} from ${AWS_CFG} and ${AWS_CRED}${w.length ? ` · ${w[0].profile || 'default'} sign-in expired (${n} tunnel${n > 1 ? 's' : ''} waiting)` : ''}. Each tunnel picks a profile in its form.`
}

/* ---------- tunnel form: AWS profile picker ---------- */
function awsFillProf(sel) {
  const el = $('#iProf'); $('#fProf').hidden = !AWS_ON; if (!AWS_ON) return
  if (document.activeElement === el && sel === undefined) return // don't rebuild under an open menu
  const v = sel !== undefined ? sel : el.value
  el.innerHTML = L.profileOptions((awsSnap() || {}).profiles || [], v).map(o => `<option value="${esc(o.value)}"${o.selected ? ' selected' : ''}>${esc(o.label)}</option>`).join('')
  el.value = v
}
function awsProfMsg() {
  if (!AWS_ON) return
  const el = $('#mProf'), v = $('#iProf').value, n = awsPName(v), p = (awsSnap() ? awsSnap().profiles : []).find(x => x.name === n), a = document.activeElement
  const had = el.contains(a), keep = had && a.dataset.a ? awsSel(a) : null
  const si = awsSi()
  if (si && si.profile === n) { el.className = 'msg'; el.innerHTML = awsSiInline(n) }
  else if (!p) { el.className = 'msg err'; el.textContent = v ? `${v} isn’t in ${AWS_CFG} or ${AWS_CRED} anymore. Pick another profile.` : 'No default profile on this Mac. Set up AWS access first.' }
  else {
    const s = L.statusLine(p), need = p.type === 'sso' && p.status && (p.status.state === 'expired' || p.status.state === 'signed-out')
    el.className = 'msg' + (s.cls === 'ok' ? ' ok' : s.cls === 'err' ? ' err' : '')
    el.innerHTML = s.cls === 'ok' ? `✓ ${esc(s.l1)}${s.l2 ? ' · ' + esc(s.l2) : ''}${v ? '' : ' · used when no profile is chosen'}`
      : need ? `${esc(s.l1)}. This tunnel waits until you sign in. <button type="button" class="btn sm" data-a="awsSignIn" data-p="${esc(n)}">Sign In</button>`
        : s.cls === 'err' ? `${esc(s.l1)}${s.l2 ? ': ' + esc(s.l2) : ''}. Replace its keys in Settings › AWS.` : esc(s.l1)
  }
  if (had && !el.contains(document.activeElement)) ((keep && $(keep, el)) || $('[data-a="awsCancel"],[data-a="awsSignIn"]', el) || $('#iProf')).focus()
}
