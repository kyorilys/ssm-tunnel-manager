/* Pure renderer helpers (no DOM). UMD: module.exports in Node, window.SSMLogic in the browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../lib/validate'))
  else root.SSMLogic = factory(root.SSMValidate) // pages load ../lib/validate.js first
})(typeof self !== 'undefined' ? self : this, function (V) {
  const MIN = 60e3, HR = 36e5, DAY = 864e5
  const ENV_LABELS = { prod: 'Production', stg: 'Staging', other: 'Other' }
  const TO_MOCK = { production: 'prod', staging: 'stg', other: 'other' }
  const TO_CANON = { prod: 'production', stg: 'staging', other: 'other' }

  const envToMock = e => TO_MOCK[e] || 'other'
  const envToCanon = e => TO_CANON[e] || 'other'

  const dur = (ms, now) => {
    const m = Math.max(0, Math.floor((now - ms) / MIN))
    return m < 1 ? 'just now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${Math.floor(m / 1440)}d`
  }
  const ago = (ms, now) => { const d = dur(ms, now); return d === 'just now' ? d : d + ' ago' }

  const kind = t => {
    const p = +t.port
    return p === 5432 ? ['PostgreSQL', 'db'] : p === 3306 ? ['MySQL', 'db']
      : p === 6379 ? [/valkey/i.test(t.host) ? 'Valkey' : 'Redis', 'cache']
        : p === 443 ? ['HTTPS', 'lock'] : ['TCP', 'plug']
  }
  // POSIX shell quoting for copied commands: safe values stay bare, anything else is single-quoted (' becomes '\'').
  const shq = v => {
    const s = String(v)
    return /^[A-Za-z0-9._:/=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
  }
  // --parameters is one argument: left bare when every part is safe (the commas are literal), else quoted as a unit.
  const params = d => {
    const parts = [d.host, d.port, d.local].map(String)
    const s = `host=${parts[0]},portNumber=${parts[1]},localPortNumber=${parts[2]}`
    return parts.every(p => shq(p) === p) ? s : shq(s)
  }
  const cliFor = t => {
    const kl = kind(t)[0]
    return kl === 'PostgreSQL' ? `psql -h localhost -p ${shq(t.local)}`
      : kl === 'MySQL' ? `mysql -h 127.0.0.1 -P ${shq(t.local)}`
        : /Redis|Valkey/.test(kl) ? `redis-cli -p ${shq(t.local)}`
          : shq(`https://localhost:${t.local}`)
  }
  const awsCmd = d => `aws ssm start-session --region ${shq(d.region)} --target ${shq(d.target)} --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters ${params(d)}${d.profile ? ` --profile ${shq(d.profile)}` : ''}`

  // Default for new tunnels and profiles: the region most saved tunnels use (first one wins a tie), else AWS's default.
  const preferredRegion = tunnels => {
    const n = new Map()
    for (const t of tunnels || []) if (t && t.region) n.set(t.region, (n.get(t.region) || 0) + 1)
    let best = 'us-east-1', most = 0
    for (const [r, c] of n) if (c > most) { best = r; most = c }
    return best
  }

  const suggestPort = (remote, taken) => {
    const set = new Set([...(taken || [])].map(Number))
    let p = { 5432: 1430, 3306: 3300, 6379: 6370, 443: 1443 }[+remote] || Math.min(+remote + 10000, 60000)
    while (set.has(p)) p++
    return p
  }

  const live = t => t.state === 'active' || t.state === 'connecting'
  const busy = t => live(t) || t.state === 'reconnecting'
  const stableActive = (t, now) => t.state === 'active' && t.since != null && now - t.since >= V.STABLE_MS
  const failing = t => V.FAILING.has(t.state)
  const needsAttention = t => failing(t) || t.state === 'waiting'

  const matchQuery = (t, query) => {
    const q = String(query || '').trim().toLowerCase()
    return !q || [t.name, t.desc, t.host, t.local, t.region, kind(t)[0], ENV_LABELS[t.env]].join(' ').toLowerCase().includes(q)
  }
  const visible = (tunnels, view, query) => tunnels.filter(t => {
    if (t.archived) return false
    if (view === 'active' && !live(t)) return false
    if (view === 'attn' && !needsAttention(t)) return false
    if (ENV_LABELS[view] && t.env !== view) return false
    if (typeof view === 'string' && view.startsWith('i-') && t.target !== view) return false
    return matchQuery(t, query)
  })

  // candidates: tunnels to start; held: Map(localPort -> holder label). Returns {go, skip:[[tunnel, holder]]}.
  const plan = (candidates, held) => {
    const h = new Map(held || [])
    const go = [], skip = []
    for (const t of candidates) {
      const who = h.get(+t.local)
      if (who) skip.push([t, who])
      else { h.set(+t.local, t.name); go.push(t) }
    }
    return { go, skip }
  }

  const failingDays = t => Math.floor((t.failingMs || 0) / DAY)
  const purgeDaysLeft = (t, purgeDays, now) => {
    if (!purgeDays) return null
    if (t.archivedAt == null) return purgeDays
    return Math.max(0, Math.ceil((t.archivedAt + purgeDays * DAY - now) / DAY))
  }
  const errorKind = e => /address already in use|already in use/i.test(e || '') ? 'port' : /ExpiredToken|expired/i.test(e || '') || V.SIGNIN_ERROR.test(e || '') ? 'token' : 'other'
  const stripGaveUp = e => String(e == null ? '' : e).replace(/^Gave up after 5 attempts: /, '')
  const allFailing = tunnels => {
    const used = tunnels.filter(t => !t.archived && t.state !== 'idle')
    return used.length >= 2 && used.every(failing)
  }
  const shortId = b => `${b.slice(0, 6)}…${b.slice(-5)}`

  /* ---------- Logs view ---------- */
  const LOG_LIMIT = 2000
  const LOG_EVENTS = {
    app_start: 'App started', app_quit: 'App quit', connect: 'Connected', disconnect: 'Disconnected', session_ended: 'Session ended',
    reconnect_scheduled: 'Retry scheduled', reconnect_attempt: 'Retry attempt', retry: 'Retry', wake: 'Woke from sleep', wake_retry: 'Retry after wake',
    gave_up: 'Gave up', auto_archived: 'Auto-archived', archive_sweep: 'Archive check', purged: 'Deleted permanently', restored: 'Restored',
    imported: 'Imported', added: 'Added', edited: 'Edited', removed: 'Removed', settings_changed: 'Settings changed', external_reload: 'Reloaded from disk',
    kill: 'Stopped all', up: 'Started', down: 'Stopped',
  }
  const LOG_LEVELS = { info: 1, warn: 1, error: 1 }
  const LOG_RANGES = { hour: 'Last hour', today: 'Today', '7d': 'Last 7 days', all: 'All time' }
  const LOG_LEVEL_LABELS = { all: '', warn: 'Warnings+', error: 'Errors' }
  const LOG_SOURCE_LABELS = { both: '', app: 'App', cli: 'CLI' }
  const p2 = n => String(n).padStart(2, '0')
  const dayStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }

  const logEventLabel = e => e.event === 'connect' && e.level === 'error' ? 'Connect failed' : LOG_EVENTS[e.event] || e.event
  const logHms = ms => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` }
  const logYmd = ms => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` }

  // logs:read rows (newest first) -> view entries with a numeric time and a stable id. Identical lines get a counter taken from the oldest side,
  // so a newer entry arriving never renames the older ones (expand state is keyed by id).
  const decorateLogs = raws => {
    const rows = []
    for (const r of Array.isArray(raws) ? raws : []) {
      const ms = r && typeof r === 'object' ? Date.parse(r.t) : NaN
      if (Number.isNaN(ms) || typeof r.event !== 'string') continue
      rows.push({ ...r, ms, level: LOG_LEVELS[r.level] ? r.level : 'info', tunnel: r.tunnel || null, source: r.source === 'cli' ? 'cli' : 'app', message: String(r.message == null ? '' : r.message), raw: r })
    }
    const seen = new Map()
    for (let i = rows.length - 1; i >= 0; i--) {
      const e = rows[i], base = [e.t, e.source, e.tunnel, e.event, e.message].join('|'), n = seen.get(base) || 0
      seen.set(base, n + 1); e.id = `${base}#${n}`
    }
    return rows
  }

  // Filters -> logs:read arguments. Search stays client-side so it also matches event labels and "general".
  const logRequest = (F, now) => {
    const req = { limit: LOG_LIMIT }
    if (F.level === 'warn' || F.level === 'error') req.level = F.level
    if (F.source === 'app' || F.source === 'cli') req.source = F.source
    const since = F.range === 'hour' ? now - HR : F.range === 'today' ? dayStart(now) : F.range === '7d' ? now - 7 * DAY : null
    if (since != null) req.since = Math.floor(since)
    return req
  }
  const logMatchSearch = (e, q) => {
    const needle = String(q || '').trim().toLowerCase()
    return !needle || [e.tunnel || 'general', logEventLabel(e), e.event, e.message, e.source].join(' ').toLowerCase().includes(needle)
  }

  // Newest-first entries -> groups with at least one match, most recently active first.
  const buildLogGroups = (entries, q) => {
    const m = new Map()
    for (const e of entries) {
      const key = e.tunnel || ''
      if (!m.has(key)) m.set(key, { key, name: key || 'General', total: 0, vis: [] })
      const g = m.get(key); g.total++
      if (logMatchSearch(e, q)) g.vis.push(e)
    }
    const byTime = (a, b) => b.ms - a.ms
    const gs = [...m.values()].filter(g => g.vis.length)
    for (const g of gs) { g.vis.sort(byTime); g.last = g.vis[0] }
    return gs.sort((a, b) => b.last.ms - a.last.ms)
  }

  const logErrorPill = (g, now) => {
    const errs = g.vis.filter(e => e.level === 'error')
    return errs.length ? { count: errs.length, hot: now - Math.max(...errs.map(e => e.ms)) < DAY } : null
  }

  // Entries of one group -> render rows with a day divider whenever the date changes (and on top unless the whole group is today).
  const logRows = (vis, now) => {
    const today = dayStart(now), rows = []
    const multi = new Set(vis.map(e => dayStart(e.ms))).size > 1
    let prev = null
    for (const e of vis) {
      const d = dayStart(e.ms)
      if (d !== prev && (prev !== null || multi || d !== today)) {
        const n = Math.round((today - d) / DAY)
        rows.push({ type: 'day', ms: e.ms, rel: n === 0 ? 'today' : n === 1 ? 'yesterday' : null })
      }
      prev = d; rows.push({ type: 'entry', e })
    }
    return rows
  }

  const logCopyText = groups => groups.flatMap(g => g.vis.map(e =>
    `${logYmd(e.ms)} ${logHms(e.ms)}  ${e.level.toUpperCase().padEnd(5)}  ${(e.tunnel || 'general').padEnd(16)}  ${e.event.padEnd(19)}  ${e.source.padEnd(3)}  ${e.message}`)).join('\n')

  // prev: {entries} shown now (null on first load or after a filter change). Live applies the fetch; paused keeps the list and counts what is waiting.
  const logApplyPoll = (prev, fetched, live) => {
    const seen = new Set(prev ? prev.entries.map(e => e.id) : [])
    const fresh = new Set(prev ? fetched.filter(e => !seen.has(e.id)).map(e => e.id) : [])
    if (!prev || live) return { entries: fetched, fresh, pending: 0 }
    return { entries: prev.entries, fresh: new Set(), pending: fresh.size }
  }

  // open: Map(group key -> expanded). Never overwrites a user choice; only fills in groups it has not seen.
  const logSeedOpen = (open, groups, now, { initial = false, fresh = new Set() } = {}) => {
    let hot = new Set()
    if (initial) {
      hot = new Set(groups.filter(g => g.vis.some(e => e.level !== 'info' && now - e.ms < DAY)).map(g => g.key))
      if (!hot.size && groups.length) hot.add(groups[0].key)
    }
    for (const g of groups) if (!open.has(g.key)) open.set(g.key, initial ? hot.has(g.key) : g.vis.some(e => fresh.has(e.id)))
    return open
  }

  const logGroupEnv = (name, tunnels) => {
    const t = name && (tunnels || []).find(x => x.name === name)
    return t ? (ENV_LABELS[t.env] ? t.env : 'other') : null
  }

  const logBytes = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
  const logLimit = n => n >= 1048576 ? `${+(n / 1048576).toFixed(1)} MB` : `${+(n / 1024).toFixed(1)} KB`
  const logFooter = info => info && info.ok ? { path: info.path, text: `${info.size > 0 ? logBytes(info.size) : 'not created yet'} · rotates at ${logLimit(info.maxBytes)}, keeps ${info.keep}` } : null
  const logFilterDesc = F => [String(F.q || '').trim() && `“${String(F.q).trim()}”`, LOG_LEVEL_LABELS[F.level], LOG_SOURCE_LABELS[F.source], LOG_RANGES[F.range]].filter(Boolean).join(' · ')
  const logStatus = groups => ({ entries: groups.reduce((n, g) => n + g.vis.length, 0), groups: groups.length, errors: groups.reduce((n, g) => n + g.vis.filter(e => e.level === 'error').length, 0) })

  // The IPC copy channel caps text at 10,000 characters: keep whole lines from the top (newest) that fit.
  const logClipFit = (text, max) => {
    const lines = text ? text.split('\n') : []
    let used = 0, kept = 0
    for (const l of lines) { const n = l.length + (kept ? 1 : 0); if (used + n > max) break; used += n; kept++ }
    return { text: lines.slice(0, kept).join('\n'), kept, total: lines.length }
  }
  const logDescribeNew = es => {
    if (!es.length) return ''
    if (es.length === 1) { const e = es[0]; return `New ${e.level === 'warn' ? 'warning' : e.level === 'error' ? 'error' : 'entry'} in ${e.tunnel || 'General'}: ${logEventLabel(e)}. ${e.message}` }
    const er = es.filter(e => e.level === 'error').length
    return `${es.length} new log entries${er ? `, ${er} error${er > 1 ? 's' : ''}` : ''}`
  }


  /* ---------- AWS sign-in UI helpers ---------- */
  const AWS_CALLS = ['awsProfiles', 'awsTest', 'awsSignIn', 'awsCancelSignIn', 'awsAddSso', 'awsAddKeys', 'awsRemoveProfile']
  const awsSupported = api => !!api && AWS_CALLS.every(k => typeof api[k] === 'function')
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
  const TYPE_LABELS = { sso: 'SSO', keys: 'Access keys', other: 'Other' }

  // snapshot.aws.waiting rows -> one row per profile (names deduped), most tunnels first (stable on ties).
  const groupWaiting = rows => {
    const m = new Map()
    for (const r of Array.isArray(rows) ? rows : []) {
      const key = r.profile || ''
      if (!m.has(key)) m.set(key, { profile: key, type: r.type, tunnels: [] })
      const g = m.get(key)
      for (const n of r.tunnels || []) if (!g.tunnels.includes(n)) g.tunnels.push(n)
    }
    return [...m.values()].sort((a, b) => b.tunnels.length - a.tunnels.length)
  }
  const profLabel = p => p ? p : 'the default profile'
  const bannerText = rows => {
    const g = groupWaiting(rows); if (!g.length) return null
    const total = g.reduce((n, x) => n + x.tunnels.length, 0), top = g[0]
    return { profile: top.profile, canSignIn: top.type === 'sso', text: `AWS sign-in expired for ${profLabel(top.profile)}${g.length > 1 ? ` and ${g.length - 1} more` : ''} · ${plural(total, 'tunnel', 'tunnels')} waiting` }
  }
  const popoverLine = aws => {
    if (!aws) return null
    if (aws.signingIn) return { kind: 'signing', profile: aws.signingIn, canSignIn: false, text: `Approve the sign-in to ${aws.signingIn} in your browser` }
    const g = groupWaiting(aws.waiting); if (!g.length) return null
    const total = g.reduce((n, x) => n + x.tunnels.length, 0)
    return { kind: 'needed', profile: g[0].profile, canSignIn: g[0].type === 'sso', text: `${g[0].profile || 'default'}${g.length > 1 ? ` and ${g.length - 1} more` : ''} sign-in needed · ${total} waiting` }
  }
  const waitingText = profile => ({ l1: 'Waiting for sign-in', l2: `${profile || 'default'} · retries paused` })

  // Profile (awsProfiles()) -> status cell. Text is raw; the renderer escapes it.
  const statusLine = (p, o = {}) => {
    if (o.signingIn) return { cls: 'busy', spin: true, l1: 'Signing in…', l2: 'Waiting for your browser' }
    const s = p.status
    if (!s) return { cls: 'note', icon: 'ring', l1: 'Not checked yet', l2: '' }
    switch (s.state) {
      case 'ok': return { cls: 'ok', icon: 'check', l1: `Signed in as ${s.identity || p.name}`, l2: s.account ? `account ${s.account}` : '' }
      case 'expired': return { cls: 'wait', icon: 'key', l1: 'Sign-in expired', l2: s.message || '' }
      case 'signed-out': return { cls: 'wait', icon: 'key', l1: 'Not signed in', l2: p.type === 'sso' ? 'Sign in to use it' : (s.message || '') }
      case 'no-credentials': return { cls: 'note', icon: 'ring', l1: 'No credentials', l2: s.message || '' }
      case 'network': return { cls: 'note', icon: 'warn', l1: 'Can’t reach AWS', l2: s.message || 'Check your network' }
      case 'checking': return { cls: 'busy', spin: true, l1: 'Testing…', l2: 'aws sts get-caller-identity' }
      case 'invalid': return { cls: 'err', icon: 'x', l1: 'Credentials rejected', l2: s.message || '' }
      default: return { cls: 'err', icon: 'x', l1: 'Error', l2: s.message || '' }
    }
  }

  const profileTag = p => { const s = p.status && p.status.state; return s === 'expired' ? ' · sign-in expired' : s === 'signed-out' ? ' · not signed in' : s === 'invalid' || s === 'error' ? ' · error' : '' }
  // Select options for the tunnel form: '' = default profile; a saved name that no longer exists stays selectable.
  const profileOptions = (profiles, selected) => {
    const list = Array.isArray(profiles) ? profiles : [], d = list.find(p => p.name === 'default')
    const out = [{ value: '', label: `Default profile${d ? ` · ${TYPE_LABELS[d.type] || d.type}${profileTag(d)}` : ' · not set up'}`, selected: !selected }]
    for (const p of list) if (p.name !== 'default') out.push({ value: p.name, label: `${p.name} · ${TYPE_LABELS[p.type] || p.type}${profileTag(p)}`, selected: p.name === selected })
    if (selected && !list.some(p => p.name === selected)) out.push({ value: selected, label: `${selected} · not found`, selected: true })
    return out
  }

  const sidebarAws = aws => {
    if (!aws) return null
    const ps = aws.profiles || [], w = groupWaiting(aws.waiting)
    if (aws.noCredentials || !ps.length) return { cls: 'w', icon: 'warn', text: 'AWS: not set up' }
    if (aws.signingIn) return { cls: 'k', icon: 'key', text: `AWS: signing in to ${aws.signingIn}…` }
    if (w.length === 1) return { cls: 'k', icon: 'key', text: `AWS: ${w[0].profile || 'default'} sign-in expired` }
    if (w.length > 1) return { cls: 'k', icon: 'key', text: `AWS: ${w.length} profiles waiting for sign-in` }
    return { cls: 'ok', icon: 'check', text: `AWS: ${plural(ps.length, 'profile', 'profiles')}` }
  }

  const signInPhaseText = (phase, profile, message) => ({
    opening: { text: 'Opening your browser…', busy: true },
    waiting: { text: 'Approve the sign-in in your browser', busy: true },
    done: { text: `Signed in to ${profile}`, busy: false },
    cancelled: { text: `Sign-in to ${profile} cancelled`, busy: false },
    failed: { text: `Couldn’t sign in to ${profile}.${message ? ' ' + message : ''}`, busy: false },
  }[phase] || { text: '', busy: false })

  // Removal never falls back to the default profile (it may be a different account).
  const removeWarning = (name, tunnels) => {
    const u = tunnels || []; if (!u.length) return 'No tunnels use it.'
    const they = u.length > 1 ? 'They' : 'It'
    return `${plural(u.length, 'tunnel', 'tunnels')} ${u.length > 1 ? 'use' : 'uses'} it: ${u.join(', ')}. ${they} won’t switch to the default profile, which may be a different account, and keep the name ${name} until you pick another.`
  }

  const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
  const nameHint = (n, existing, editing) => !NAME_RE.test(n || '') ? 'Letters, digits, dot, dash or underscore.' : (existing || []).includes(n) && n !== editing ? `${n} already exists.` : ''
  const validateSso = (d, existing, editing) => {
    const E = {}, ex = Array.isArray(existing) ? existing : []
    const ne = nameHint(d.name, ex, editing); if (ne) E.name = ne
    if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(d.startUrl || '')) E.startUrl = 'Use the https:// address of your AWS access portal.'
    if (!/^\d{12}$/.test(String(d.accountId || '').replace(/[\s-]/g, ''))) E.accountId = '12 digits.'
    if (!/^[\w+=,.@-]{1,64}$/.test(d.roleName || '')) E.roleName = 'The permission set or role name.'
    return E
  }
  // keep: editing with both fields empty keeps the stored keys.
  const validateKeys = (d, existing, editing) => {
    const E = {}, ex = Array.isArray(existing) ? existing : []
    const ne = nameHint(d.name, ex, editing); if (ne) E.name = ne
    const id = String(d.accessKeyId || '').trim().toUpperCase(), sec = d.secretAccessKey || ''
    if (editing && !id && !sec) return E
    if (/^ASIA/.test(id)) E.accessKeyId = 'ASIA keys are temporary and need a session token. Use SSO instead.'
    else if (!/^AKIA[A-Z0-9]{16}$/.test(id)) E.accessKeyId = '20 characters, starting with AKIA.'
    if (sec.length !== 40) E.secretAccessKey = sec ? 'Secret access keys are 40 characters.' : 'Paste the secret shown when the key was created.'
    return E
  }
  const maskKey = k => k && k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k || ''
  // Exactly what an SSO profile adds to ~/.aws/config (no secrets exist for SSO).
  const ssoPreview = d => {
    const n = d.name || '<profile name>'
    return `[profile ${n}]\nsso_session = ${n}\nsso_account_id = ${d.accountId || '<account id>'}\nsso_role_name = ${d.roleName || '<role name>'}\nregion = ${d.region || '<region>'}\n\n[sso-session ${n}]\nsso_start_url = ${d.startUrl || '<start url>'}\nsso_region = ${d.ssoRegion || '<sso region>'}\nsso_registration_scopes = sso:account:access`
  }

  return { preferredRegion, awsSupported, groupWaiting, bannerText, popoverLine, waitingText, statusLine, profileOptions, sidebarAws, signInPhaseText, removeWarning, validateSso, validateKeys, maskKey, ssoPreview, TYPE_LABELS, MIN, HR, DAY, ENV_LABELS, envToMock, envToCanon, dur, ago, kind, shq, cliFor, awsCmd, suggestPort, live, busy, failing, needsAttention, stableActive, matchQuery, visible, plan, failingDays, purgeDaysLeft, errorKind, stripGaveUp, allFailing, shortId,
    LOG_RANGES, decorateLogs, logEventLabel, logRequest, buildLogGroups, logErrorPill, logRows, logHms, logYmd, logCopyText, logApplyPoll, logSeedOpen, logGroupEnv, logFooter, logFilterDesc, logStatus, logClipFit, logDescribeNew }
})
