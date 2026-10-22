const test = require('node:test')
const assert = require('node:assert')
const L = require('../renderer/logic.js')

const MIN = 60e3, HR = 36e5, DAY = 864e5
const NOW = new Date(2026, 9, 21, 15, 30, 0).getTime() // local time, so the tests do not depend on the TZ
const at = (daysAgo, h, m, s = 0) => new Date(2026, 9, 21 - daysAgo, h, m, s).getTime()
const E = (ms, o = {}) => ({ t: new Date(ms).toISOString(), source: 'app', level: 'info', tunnel: null, event: 'connect', message: 'm', ...o })
const D = (...raws) => L.decorateLogs(raws) // raws are newest first, like logs:read

test('logEventLabel maps known events and falls back to the raw id', () => {
  const lab = (event, level = 'info') => L.logEventLabel({ event, level })
  assert.equal(lab('reconnect_scheduled'), 'Retry scheduled')
  assert.equal(lab('gave_up'), 'Gave up')
  assert.equal(lab('session_ended'), 'Session ended')
  assert.equal(lab('auto_archived'), 'Auto-archived')
  assert.equal(lab('external_reload'), 'Reloaded from disk')
  assert.equal(lab('archive_sweep'), 'Archive check')
  assert.equal(lab('connect', 'error'), 'Connect failed')
  assert.equal(lab('connect'), 'Connected')
  assert.equal(lab('something_new'), 'something_new')
})

test('decorateLogs adds ms, stable unique ids and drops unusable rows', () => {
  const a = E(NOW, { message: 'x' }), b = E(NOW, { message: 'x' }), bad = { t: 'nope', event: 'x' }
  const d1 = L.decorateLogs([a, b, bad, null])
  assert.equal(d1.length, 2)
  assert.equal(d1[0].ms, NOW)
  assert.notEqual(d1[0].id, d1[1].id, 'identical lines still get distinct ids')
  const newer = E(NOW + 1000, { message: 'y' })
  const d2 = L.decorateLogs([newer, a, b])
  assert.deepEqual(d2.slice(1).map(e => e.id), d1.map(e => e.id), 'ids survive a newer entry arriving')
  assert.equal(L.decorateLogs([E(NOW, { level: 'weird' })])[0].level, 'info')
})

test('logRequest maps filters to the logs:read arguments', () => {
  const F = { q: 'x', level: 'all', source: 'both', range: 'all' }
  assert.deepEqual(L.logRequest(F, NOW), { limit: 2000 })
  assert.deepEqual(L.logRequest({ ...F, level: 'warn', source: 'cli', range: 'hour' }, NOW), { limit: 2000, level: 'warn', source: 'cli', since: NOW - HR })
  assert.equal(L.logRequest({ ...F, level: 'error' }, NOW).level, 'error')
  assert.equal(L.logRequest({ ...F, range: 'today' }, NOW).since, at(0, 0, 0))
  assert.equal(L.logRequest({ ...F, range: '7d' }, NOW).since, NOW - 7 * DAY)
  assert.ok(Number.isInteger(L.logRequest({ ...F, range: '7d' }, NOW + 0.5).since))
  assert.equal('search' in L.logRequest({ ...F, q: 'abc' }, NOW), false, 'search is applied client-side so event labels match too')
  assert.equal(L.logRequest({ ...F, range: 'bogus' }, NOW).since, undefined)
})

test('buildLogGroups groups by tunnel, General for null, ordered by latest activity', () => {
  const es = D(
    E(at(0, 15, 0), { tunnel: 'b' }), E(at(0, 14, 0), { tunnel: null }), E(at(0, 13, 0), { tunnel: 'a' }), E(at(0, 12, 0), { tunnel: 'b' }))
  const gs = L.buildLogGroups(es, '')
  assert.deepEqual(gs.map(g => g.name), ['b', 'General', 'a'])
  assert.equal(gs[1].key, '')
  assert.equal(gs[0].vis.length, 2)
  assert.equal(gs[0].last.ms, at(0, 15, 0))
  assert.equal(gs[0].total, 2)
})

test('buildLogGroups search matches tunnel, label, event, message, source and hides empty groups', () => {
  const es = D(E(NOW, { tunnel: 'alpha', event: 'gave_up', message: 'boom' }), E(NOW - 1, { tunnel: null, event: 'settings_changed', message: 'Changed x' }), E(NOW - 2, { tunnel: 'beta', source: 'cli', message: 'ok' }))
  const names = q => L.buildLogGroups(es, q).map(g => g.name)
  assert.deepEqual(names('GAVE'), ['alpha'])
  assert.deepEqual(names('retry'), [])
  assert.deepEqual(names('general'), ['General'])
  assert.deepEqual(names('cli'), ['beta'])
  assert.deepEqual(names('  boom '), ['alpha'])
  const g = L.buildLogGroups(es, 'boom')[0]
  assert.equal(g.total, 1)
  assert.equal(L.buildLogGroups(D(E(NOW, { tunnel: 'a' }), E(NOW - 1, { tunnel: 'a', message: 'zzz' })), 'zzz')[0].total, 2, 'total counts every loaded entry of the group')
})

test('logErrorPill is hot only when the latest error is under 24 h old', () => {
  const pill = (...raws) => L.logErrorPill(L.buildLogGroups(D(...raws), '')[0], NOW)
  const err = ms => E(ms, { tunnel: 'a', level: 'error' })
  assert.equal(pill(E(NOW, { tunnel: 'a', level: 'warn' })), null)
  assert.deepEqual(pill(err(NOW - HR), err(NOW - 3 * DAY)), { count: 2, hot: true })
  assert.deepEqual(pill(err(NOW - DAY - 1)), { count: 1, hot: false })
  assert.equal(pill(err(NOW - DAY + MIN)).hot, true)
  assert.equal(pill(E(NOW, { tunnel: 'a' }), err(NOW - 2 * DAY)).hot, false, 'a newer info entry does not make an old error hot')
})

test('logRows inserts day dividers when the date changes', () => {
  const vis = D(E(at(0, 10, 0)), E(at(0, 9, 0)), E(at(1, 22, 0)), E(at(3, 8, 0)))
  const rows = L.logRows(vis, NOW)
  assert.deepEqual(rows.map(r => r.type), ['day', 'entry', 'entry', 'day', 'entry', 'day', 'entry'])
  assert.deepEqual(rows.filter(r => r.type === 'day').map(r => r.rel), ['today', 'yesterday', null])
  assert.equal(rows[3].ms, at(1, 22, 0))
})

test('logRows skips the top divider only for a group that is entirely today', () => {
  assert.deepEqual(L.logRows(D(E(at(0, 10, 0)), E(at(0, 9, 0))), NOW).map(r => r.type), ['entry', 'entry'])
  assert.deepEqual(L.logRows(D(E(at(2, 10, 0))), NOW).map(r => r.type), ['day', 'entry'])
  assert.deepEqual(L.logRows([], NOW), [])
})

test('logHms and logYmd use local time with zero padding', () => {
  const ms = new Date(2026, 0, 5, 3, 4, 9).getTime()
  assert.equal(L.logHms(ms), '03:04:09')
  assert.equal(L.logYmd(ms), '2026-01-05')
})

test('logCopyText lists every matching entry, collapsed groups included, as plain lines', () => {
  const gs = L.buildLogGroups(D(E(at(0, 10, 0, 5), { tunnel: 'a', level: 'error', event: 'gave_up', message: 'boom', source: 'cli' }), E(at(0, 9, 0), { message: 'hi' })), '')
  const lines = L.logCopyText(gs).split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^2026-10-21 10:00:05 +ERROR +a +gave_up +cli +boom$/)
  assert.match(lines[1], /^2026-10-21 09:00:00 +INFO +general +connect +app +hi$/)
  assert.equal(L.logCopyText([]), '')
})

test('logApplyPoll: first load, live merge flags only new ids, paused counts them', () => {
  const a = D(E(NOW - 2000, { message: 'a' }))
  const first = L.logApplyPoll(null, a, true)
  assert.equal(first.entries.length, 1)
  assert.equal(first.fresh.size, 0)
  assert.equal(first.pending, 0)

  const grown = D(E(NOW, { message: 'b' }), E(NOW - 2000, { message: 'a' }))
  const live = L.logApplyPoll(first, grown, true)
  assert.equal(live.entries.length, 2)
  assert.deepEqual([...live.fresh], [grown[0].id])
  assert.equal(live.pending, 0)

  const paused = L.logApplyPoll(first, grown, false)
  assert.equal(paused.entries, first.entries, 'the visible list is untouched while paused')
  assert.equal(paused.pending, 1)
  assert.equal(paused.fresh.size, 0)

  const same = L.logApplyPoll(live, grown, true)
  assert.equal(same.fresh.size, 0, 'a poll with nothing new flags nothing')
})

test('logSeedOpen: initial opens groups with a recent warning/error, else the newest; later only fresh ones', () => {
  const es = D(E(at(0, 15, 0), { tunnel: 'new' }), E(at(0, 14, 0), { tunnel: 'warny', level: 'warn' }), E(at(3, 14, 0), { tunnel: 'olderr', level: 'error' }))
  const open = new Map()
  L.logSeedOpen(open, L.buildLogGroups(es, ''), NOW, { initial: true })
  assert.deepEqual([...open], [['new', false], ['warny', true], ['olderr', false]])

  const calm = new Map()
  L.logSeedOpen(calm, L.buildLogGroups(D(E(at(0, 15, 0), { tunnel: 'x' }), E(at(0, 14, 0), { tunnel: 'y' })), ''), NOW, { initial: true })
  assert.deepEqual([...calm], [['x', true], ['y', false]], 'falls back to the most recent group')

  open.set('warny', false) // the user collapsed it
  const fresh = D(E(NOW, { tunnel: 'brandnew' }), E(NOW - 1, { tunnel: 'warny' }))
  L.logSeedOpen(open, L.buildLogGroups(fresh, ''), NOW, { fresh: new Set([fresh[0].id]) })
  assert.equal(open.get('brandnew'), true)
  assert.equal(open.get('warny'), false, 'existing state is never overwritten')
  const filtered = new Map(open)
  L.logSeedOpen(filtered, L.buildLogGroups(D(E(at(5, 1, 0), { tunnel: 'ancient' })), ''), NOW, {})
  assert.equal(filtered.get('ancient'), false, 'groups that merely appear through a filter stay collapsed')
  assert.equal(filtered.get('new'), false, 'groups missing from the current view keep their state')
})

test('logGroupEnv looks the env up from tunnel state; unknown names get none', () => {
  const ts = [{ name: 'p', env: 'prod' }, { name: 's', env: 'stg' }, { name: 'o', env: 'weird' }]
  assert.equal(L.logGroupEnv('p', ts), 'prod')
  assert.equal(L.logGroupEnv('s', ts), 'stg')
  assert.equal(L.logGroupEnv('o', ts), 'other')
  assert.equal(L.logGroupEnv('gone', ts), null)
  assert.equal(L.logGroupEnv('', ts), null)
  assert.equal(L.logGroupEnv('p', null), null)
})

test('logFooter formats size and rotation from logs:info', () => {
  assert.deepEqual(L.logFooter({ ok: true, path: '/x/events.log', size: 0, maxBytes: 1048576, keep: 5 }), { path: '/x/events.log', text: 'not created yet · rotates at 1 MB, keeps 5' })
  assert.equal(L.logFooter({ ok: true, path: 'p', size: 512, maxBytes: 1048576, keep: 5 }).text, '512 B · rotates at 1 MB, keeps 5')
  assert.equal(L.logFooter({ ok: true, path: 'p', size: 2048, maxBytes: 1048576, keep: 5 }).text, '2.0 KB · rotates at 1 MB, keeps 5')
  assert.equal(L.logFooter({ ok: true, path: 'p', size: 3 * 1048576, maxBytes: 524288, keep: 2 }).text, '3.0 MB · rotates at 512 KB, keeps 2')
  assert.equal(L.logFooter({ ok: false }), null)
  assert.equal(L.logFooter(undefined), null)
})

test('logFilterDesc and logStatus summarise the filters and the counts', () => {
  assert.equal(L.logFilterDesc({ q: ' x ', level: 'warn', source: 'cli', range: '7d' }), '“x” · Warnings+ · CLI · Last 7 days')
  assert.equal(L.logFilterDesc({ q: '', level: 'all', source: 'both', range: 'all' }), 'All time')
  const gs = L.buildLogGroups(D(E(NOW, { tunnel: 'a', level: 'error' }), E(NOW - 1, { tunnel: 'b' })), '')
  assert.deepEqual(L.logStatus(gs), { entries: 2, groups: 2, errors: 1 })
})

test('logClipFit keeps whole lines (newest first) within the clipboard limit', () => {
  assert.deepEqual(L.logClipFit('aaa\nbbb\nccc', 100), { text: 'aaa\nbbb\nccc', kept: 3, total: 3 })
  assert.deepEqual(L.logClipFit('aaa\nbbb\nccc', 7), { text: 'aaa\nbbb', kept: 2, total: 3 })
  assert.deepEqual(L.logClipFit('aaa\nbbb', 2), { text: '', kept: 0, total: 2 })
  assert.deepEqual(L.logClipFit('', 10), { text: '', kept: 0, total: 0 })
})

test('logDescribeNew words one entry or a burst for the live region', () => {
  const [one] = D(E(NOW, { tunnel: 'a', level: 'error', event: 'gave_up', message: 'boom' }))
  assert.equal(L.logDescribeNew([one]), 'New error in a: Gave up. boom')
  assert.equal(L.logDescribeNew(D(E(NOW, { message: 'x' }))), 'New entry in General: Connected. x')
  const many = D(E(NOW, { level: 'error' }), E(NOW - 1), E(NOW - 2, { level: 'error' }))
  assert.equal(L.logDescribeNew(many), '3 new log entries, 2 errors')
  assert.equal(L.logDescribeNew(D(E(NOW), E(NOW - 1))), '2 new log entries')
  assert.equal(L.logDescribeNew([]), '')
})
