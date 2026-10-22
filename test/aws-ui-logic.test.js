const test = require('node:test')
const assert = require('node:assert')
const L = require('../renderer/logic.js')

const P = (o = {}) => ({ name: 'dev', type: 'sso', region: 'us-east-1', accountId: '••••4321', roleName: 'Dev', hasKeys: false, tunnels: 0, status: null, ...o })

test('aws feature detection needs every call', () => {
  assert.equal(L.awsSupported(undefined), false)
  assert.equal(L.awsSupported({ awsProfiles() {} }), false)
  const full = {}; for (const k of ['awsProfiles', 'awsTest', 'awsSignIn', 'awsCancelSignIn', 'awsAddSso', 'awsAddKeys', 'awsRemoveProfile']) full[k] = () => {}
  assert.equal(L.awsSupported(full), true)
})

test('groupWaiting merges rows per profile and sorts by tunnel count', () => {
  const g = L.groupWaiting([
    { profile: 'a', type: 'sso', tunnels: ['x'] },
    { profile: 'b', type: 'sso', tunnels: ['y', 'z'] },
    { profile: 'a', type: 'sso', tunnels: ['w', 'x'] }])
  assert.deepEqual(g.map(x => [x.profile, x.tunnels]), [['a', ['x', 'w']], ['b', ['y', 'z']]])
  assert.deepEqual(L.groupWaiting(null), [])
})

test('bannerText names the profile and counts tunnels', () => {
  assert.equal(L.bannerText([]), null)
  assert.deepEqual(L.bannerText([{ profile: 'prod', type: 'sso', tunnels: ['a', 'b', 'c'] }]), { profile: 'prod', canSignIn: true, text: 'AWS sign-in expired for prod · 3 tunnels waiting' })
  assert.equal(L.bannerText([{ profile: 'prod', type: 'sso', tunnels: ['a'] }]).text, 'AWS sign-in expired for prod · 1 tunnel waiting')
  assert.equal(L.bannerText([{ profile: '', type: 'sso', tunnels: ['a'] }]).text, 'AWS sign-in expired for the default profile · 1 tunnel waiting')
  const two = L.bannerText([{ profile: 'a', type: 'sso', tunnels: ['x'] }, { profile: 'b', type: 'sso', tunnels: ['y', 'z'] }])
  assert.equal(two.profile, 'b')
  assert.equal(two.text, 'AWS sign-in expired for b and 1 more · 3 tunnels waiting')
  assert.equal(L.bannerText([{ profile: 'k', type: 'keys', tunnels: ['x'] }]).canSignIn, false)
})

test('statusLine covers every state and never trusts markup', () => {
  const at = Date.now()
  assert.deepEqual(L.statusLine(P({ status: { state: 'ok', identity: 'DevRole', account: '••••4321', checkedAt: at } })), { cls: 'ok', icon: 'check', l1: 'Signed in as DevRole', l2: 'account ••••4321' })
  assert.equal(L.statusLine(P({ status: { state: 'expired', checkedAt: at } })).cls, 'wait')
  assert.equal(L.statusLine(P({ status: { state: 'expired', checkedAt: at } })).l1, 'Sign-in expired')
  assert.equal(L.statusLine(P({ status: { state: 'signed-out', checkedAt: at } })).l1, 'Not signed in')
  assert.equal(L.statusLine(P({ status: { state: 'no-credentials' } })).cls, 'note')
  assert.deepEqual([L.statusLine(P({ status: { state: 'invalid', message: 'bad token' } })).cls, L.statusLine(P({ status: { state: 'invalid', message: 'bad token' } })).l2], ['err', 'bad token'])
  assert.equal(L.statusLine(P({ status: { state: 'network' } })).l1, 'Can’t reach AWS')
  assert.equal(L.statusLine(P({ status: { state: 'checking' } })).cls, 'busy')
  assert.equal(L.statusLine(P({ status: null })).l1, 'Not checked yet')
  assert.equal(L.statusLine(P({ status: { state: 'error', message: '<b>x</b>' } })).l2, '<b>x</b>') // raw text; the renderer escapes
  assert.equal(L.statusLine(P({ status: { state: 'ok' } }), { signingIn: true }).l1, 'Signing in…')
})

test('profileOptions: default first, then names, unknown selection kept', () => {
  const ps = [P({ name: 'default', type: 'keys' }), P({ name: 'dev', status: { state: 'expired' } }), P({ name: 'prod', status: { state: 'ok' } })]
  const o = L.profileOptions(ps, 'dev')
  assert.deepEqual(o.map(x => x.value), ['', 'dev', 'prod'])
  assert.equal(o[0].label, 'Default profile · Access keys')
  assert.equal(o[1].label, 'dev · SSO · sign-in expired')
  assert.equal(o[1].selected, true)
  assert.equal(o[2].label, 'prod · SSO')
  const gone = L.profileOptions(ps, 'ghost')
  assert.deepEqual(gone[gone.length - 1], { value: 'ghost', label: 'ghost · not found', selected: true })
  assert.equal(L.profileOptions([], '')[0].label, 'Default profile · not set up')
})

test('awsCmd gets --profile only for a chosen profile', () => {
  const d = { region: 'r', target: 'i-1', host: 'h', port: 1, local: 2 }
  assert.ok(!L.awsCmd(d).includes('--profile'))
  assert.ok(L.awsCmd({ ...d, profile: 'prod' }).endsWith('--profile prod'))
})

test('waitingStateText has no countdown', () => {
  assert.deepEqual(L.waitingText('prod'), { l1: 'Waiting for sign-in', l2: 'prod · retries paused' })
  assert.equal(L.waitingText('').l2, 'default · retries paused')
})

test('sidebarAws summarises the snapshot', () => {
  assert.deepEqual(L.sidebarAws(null), null)
  assert.deepEqual(L.sidebarAws({ noCredentials: true, profiles: [], waiting: [] }), { cls: 'w', icon: 'warn', text: 'AWS: not set up' })
  assert.deepEqual(L.sidebarAws({ profiles: [{ name: 'a' }, { name: 'b' }], waiting: [] }), { cls: 'ok', icon: 'check', text: 'AWS: 2 profiles' })
  assert.equal(L.sidebarAws({ profiles: [{ name: 'a' }], waiting: [] }).text, 'AWS: 1 profile')
  assert.equal(L.sidebarAws({ profiles: [{ name: 'a' }], waiting: [{ profile: 'a', tunnels: ['x', 'y'] }] }).text, 'AWS: a sign-in expired')
  assert.equal(L.sidebarAws({ profiles: [{ name: 'a' }], waiting: [{ profile: '', tunnels: ['x'] }] }).text, 'AWS: default sign-in expired')
  assert.equal(L.sidebarAws({ profiles: [{ name: 'a' }, { name: 'b' }], waiting: [{ profile: 'a', tunnels: ['x'] }, { profile: 'b', tunnels: ['y'] }] }).text, 'AWS: 2 profiles waiting for sign-in')
  assert.equal(L.sidebarAws({ profiles: [{ name: 'a' }], waiting: [], signingIn: 'a' }).text, 'AWS: signing in to a…')
})

test('signInPhase text', () => {
  assert.equal(L.signInPhaseText('opening', 'p').text, 'Opening your browser…')
  assert.equal(L.signInPhaseText('waiting', 'p').text, 'Approve the sign-in in your browser')
  assert.equal(L.signInPhaseText('done', 'p').text, 'Signed in to p')
  assert.equal(L.signInPhaseText('cancelled', 'p').text, 'Sign-in to p cancelled')
  assert.equal(L.signInPhaseText('failed', 'p', 'Denied').text, 'Couldn’t sign in to p. Denied')
  assert.equal(L.signInPhaseText('failed', 'p').text, 'Couldn’t sign in to p.')
})

test('removeWarning lists tunnels and never offers a fallback', () => {
  assert.equal(L.removeWarning('x', []), 'No tunnels use it.')
  const w = L.removeWarning('x', ['a', 'b'])
  assert.ok(w.includes('2 tunnels use it: a, b'))
  assert.ok(w.includes('default profile'))
  assert.ok(L.removeWarning('x', ['a']).includes('1 tunnel uses it: a'))
})

test('validateSso hints', () => {
  const ok = { name: 'team-prod', startUrl: 'https://d-1.awsapps.com/start', accountId: '123456789012', roleName: 'Dev', region: 'us-east-1', ssoRegion: 'us-east-1' }
  assert.deepEqual(L.validateSso(ok, []), {})
  assert.ok(L.validateSso({ ...ok, name: '' }, []).name)
  assert.ok(L.validateSso({ ...ok, name: 'a b' }, []).name)
  assert.ok(L.validateSso({ ...ok, name: 'dev' }, ['dev']).name.includes('already exists'))
  assert.deepEqual(L.validateSso({ ...ok, name: 'dev' }, ['dev'], 'dev'), {})
  assert.ok(L.validateSso({ ...ok, startUrl: 'http://x.com' }, []).startUrl)
  assert.ok(L.validateSso({ ...ok, accountId: '1234' }, []).accountId)
  assert.deepEqual(L.validateSso({ ...ok, accountId: '1234-5678-9012' }, {}), {})
  assert.ok(L.validateSso({ ...ok, roleName: '' }, []).roleName)
})

test('validateKeys hints, and keep-on-edit', () => {
  const ok = { name: 'ci', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'x'.repeat(40), region: 'us-east-1' }
  assert.deepEqual(L.validateKeys(ok, []), {})
  assert.ok(L.validateKeys({ ...ok, accessKeyId: 'ASIAIOSFODNN7EXAMPLE' }, []).accessKeyId.includes('SSO'))
  assert.ok(L.validateKeys({ ...ok, accessKeyId: 'nope' }, []).accessKeyId)
  assert.ok(L.validateKeys({ ...ok, secretAccessKey: '' }, []).secretAccessKey)
  assert.ok(L.validateKeys({ ...ok, secretAccessKey: 'short' }, []).secretAccessKey.includes('40'))
  assert.deepEqual(L.validateKeys({ name: 'ci', accessKeyId: '', secretAccessKey: '', region: 'r' }, ['ci'], 'ci'), {})
})

test('maskKey shows only the ends', () => {
  assert.equal(L.maskKey('AKIAIOSFODNN7EXAMPLE'), 'AKIA…MPLE')
  assert.equal(L.maskKey(''), '')
})

test('ssoPreview never contains secrets and reuses nothing it cannot know', () => {
  const s = L.ssoPreview({ name: 'p', startUrl: 'https://d.awsapps.com/start', accountId: '123456789012', roleName: 'R', region: 'us-east-1', ssoRegion: 'eu-west-1' })
  assert.ok(s.includes('[profile p]') && s.includes('[sso-session p]') && s.includes('sso_region = eu-west-1'))
  assert.ok(L.ssoPreview({}).includes('<profile name>'))
})

test('popoverLine is one short line, or the browser prompt while signing in', () => {
  assert.equal(L.popoverLine(null), null)
  assert.equal(L.popoverLine({ waiting: [] }), null)
  assert.deepEqual(L.popoverLine({ waiting: [{ profile: 'prod', type: 'sso', tunnels: ['a', 'b'] }] }), { kind: 'needed', profile: 'prod', canSignIn: true, text: 'prod sign-in needed · 2 waiting' })
  assert.equal(L.popoverLine({ waiting: [{ profile: '', type: 'sso', tunnels: ['a'] }] }).text, 'default sign-in needed · 1 waiting')
  assert.equal(L.popoverLine({ waiting: [{ profile: 'a', type: 'sso', tunnels: ['x'] }, { profile: 'b', type: 'sso', tunnels: ['y'] }] }).text, 'a and 1 more sign-in needed · 2 waiting')
  assert.deepEqual(L.popoverLine({ signingIn: 'prod', waiting: [{ profile: 'prod', type: 'sso', tunnels: ['a'] }] }), { kind: 'signing', profile: 'prod', canSignIn: false, text: 'Approve the sign-in to prod in your browser' })
})
