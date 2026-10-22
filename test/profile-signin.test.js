const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { normalizeTunnel, validateTunnel, SIGNIN_ERROR } = require('../lib/validate');
const { Store } = require('../lib/store');
const { TunnelManager, buildArgs, MAX_RETRIES } = require('../lib/tunnelManager');
const { tick, CREDENTIAL_ERROR, DAY } = require('../lib/archive');
const { run } = require('../lib/cli');
const scanLib = require('../lib/scan');
const L = require('../renderer/logic.js');

const BASE = {
  name: 'glacier-prod', region: 'us-west-2', target: 'i-0357e26df0d26b2ae',
  host: 'db.example', port: 5432, local: 15003, env: 'production', auto: true,
};

// ---- validation --------------------------------------------------------

test('profile is trimmed and empty means the default chain', () => {
  assert.strictEqual(normalizeTunnel({ ...BASE, profile: '  dev  ' }).profile, 'dev');
  assert.strictEqual(normalizeTunnel({ ...BASE }).profile, '');
  assert.strictEqual(normalizeTunnel({ ...BASE, profile: '   ' }).profile, '');
  assert.strictEqual(normalizeTunnel({ ...BASE, profile: null }).profile, '');
});

test('profile validation accepts AWS profile names and rejects the rest', () => {
  for (const ok of ['', undefined, 'dev', 'my.sso+prod=1,x@corp-2_a', 'a'.repeat(64)]) {
    assert.strictEqual(validateTunnel({ ...BASE, profile: ok }, []).errors.profile, undefined, String(ok));
  }
  for (const bad of ['has space', 'semi;colon', '$(x)', 'a'.repeat(65), "q'uote", '-x/y']) {
    assert.match(validateTunnel({ ...BASE, profile: bad }, []).errors.profile, /profile/i, bad);
  }
});

// ---- store -------------------------------------------------------------

test('store round-trips profile and tolerates files without it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-prof-'));
  try {
    const file = path.join(dir, 'connections.json');
    const s = new Store({ file });
    s.load();
    assert.ok(s.add({ ...BASE, profile: 'dev' }).ok);
    assert.ok(s.add({ ...BASE, name: 'other', local: 15004 }).ok);
    const again = new Store({ file });
    again.load();
    assert.strictEqual(again.get('glacier-prod').profile, 'dev');
    assert.strictEqual(again.get('other').profile, '');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tunnels[0].profile, 'dev');
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete legacy.tunnels[0].profile;
    fs.writeFileSync(file, JSON.stringify(legacy));
    const old = new Store({ file });
    old.load();
    assert.strictEqual(old.get('glacier-prod').profile, '');
    assert.ok(old.update('glacier-prod', { ...old.get('glacier-prod'), profile: ' qa ' }).ok);
    assert.strictEqual(old.get('glacier-prod').profile, 'qa');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- buildArgs / renderer ---------------------------------------------

test('buildArgs omits --profile by default (unchanged) and appends it when set', () => {
  const base = [
    'ssm', 'start-session', '--region', 'us-west-2', '--target', 'i-0357e26df0d26b2ae',
    '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
    '--parameters', 'host=db.example,portNumber=5432,localPortNumber=15003',
  ];
  assert.deepStrictEqual(buildArgs(BASE), base);
  assert.deepStrictEqual(buildArgs({ ...BASE, profile: '' }), base);
  assert.deepStrictEqual(buildArgs({ ...BASE, profile: 'dev' }), [...base, '--profile', 'dev']);
});

test('awsCmd and cliFor include the profile, quoted when needed', () => {
  const d = { region: 'r', target: 'i-1', host: 'h', port: 5432, local: 15002 };
  const plain = 'aws ssm start-session --region r --target i-1 --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host=h,portNumber=5432,localPortNumber=15002';
  assert.strictEqual(L.awsCmd(d), plain);
  assert.strictEqual(L.awsCmd({ ...d, profile: '' }), plain);
  assert.strictEqual(L.awsCmd({ ...d, profile: 'dev' }), `${plain} --profile dev`);
  assert.strictEqual(L.awsCmd({ ...d, profile: 'a,b' }), `${plain} --profile 'a,b'`);
  assert.strictEqual(L.cliFor({ ...d, profile: 'dev' }), 'psql -h localhost -p 15002');
});

test('renderer helpers: waiting is neither failing nor busy; others unchanged', () => {
  assert.strictEqual(L.failing({ state: 'waiting' }), false);
  assert.strictEqual(L.busy({ state: 'waiting' }), false);
  assert.strictEqual(L.errorKind('The SSO session associated with this profile has expired'), 'token');
  assert.strictEqual(L.errorKind('Error loading SSO Token: Token for x does not exist'), 'token');
  assert.strictEqual(L.errorKind('bind: address already in use'), 'port');
  assert.strictEqual(L.errorKind('boom'), 'other');
});

// ---- SIGNIN_ERROR ------------------------------------------------------

test('SIGNIN_ERROR matches expired-login messages only', () => {
  for (const m of [
    'Error loading SSO Token: Token for https://x.awsapps.com/start does not exist',
    'Token for my-sso does not exist',
    'The SSO session associated with this profile has expired or is otherwise invalid.',
    'SSO session associated with this profile has expired',
    'UnauthorizedSSOToken: bad',
    'ExpiredToken', 'ExpiredTokenException: x',
    'The security token included in the request is expired',
  ]) assert.ok(SIGNIN_ERROR.test(m), m);
  for (const m of [
    'TargetNotConnected: i-123 is not connected.',
    'bind: address already in use', 'Session ended', 'Unable to locate credentials',
  ]) assert.ok(!SIGNIN_ERROR.test(m), m);
});

test('CREDENTIAL_ERROR covers everything SIGNIN_ERROR matches and the old list', () => {
  for (const m of [
    'Error loading SSO Token', 'Token for x does not exist', 'The SSO session associated with this profile has expired',
    'UnauthorizedSSOToken', 'ExpiredTokenException', 'The security token included in the request is expired',
  ]) assert.ok(CREDENTIAL_ERROR.test(m), m);
  for (const m of ['Unable to locate credentials', 'could not connect to the endpoint', 'Name or service not known'])
    assert.ok(CREDENTIAL_ERROR.test(m), m);
  assert.ok(!CREDENTIAL_ERROR.test('TargetNotConnected'));
});

// ---- manager -----------------------------------------------------------

function harness() {
  const procs = [];
  const timers = [];
  const spawn = (cmd, args) => {
    const p = new EventEmitter();
    p.pid = 1000 + procs.length;
    p.stderr = new EventEmitter();
    p.kill = () => p.emit('close', null, 'SIGTERM');
    p.args = args;
    procs.push(p);
    return p;
  };
  const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; };
  const clearTimer = (t) => { t.cleared = true; };
  const now = { v: 0 };
  const m = new TunnelManager({ spawn, setTimer, clearTimer, now: () => now.v });
  return { m, procs, timers, now };
}
const fail = (h, line) => {
  const p = h.procs.at(-1);
  p.stderr.emit('data', Buffer.from(`${line}\n`));
  p.emit('close', 1, null);
};
const EXPIRED = 'The SSO session associated with this profile has expired or is otherwise invalid.';

for (const auto of [true, false]) {
  test(`sign-in error -> waiting, no timer, attempts kept (auto=${auto})`, () => {
    const h = harness();
    h.now.v = 500;
    h.m.connect({ ...BASE, auto });
    fail(h, EXPIRED);
    const g = h.m.get('glacier-prod');
    assert.strictEqual(g.state, 'waiting');
    assert.strictEqual(g.attempt, 0);
    assert.strictEqual(g.gaveUp, false);
    assert.strictEqual(g.failingSince, 500);
    assert.match(g.error, /has expired/);
    assert.strictEqual(g.nextAt, null);
    assert.strictEqual(h.timers.length, 0);
    assert.strictEqual(h.procs.length, 1);
  });
}

test('attempts already used are not burned by a sign-in error', () => {
  const h = harness();
  h.m.connect(BASE);
  fail(h, 'boom'); // schedules retry, attempts = 1
  h.timers.at(-1).fn();
  fail(h, EXPIRED);
  assert.strictEqual(h.m.get('glacier-prod').state, 'waiting');
  assert.strictEqual(h.m.get('glacier-prod').attempt, 1);
});

test('resumeWaiting restarts only matching waiting entries with a fresh budget', () => {
  const h = harness();
  h.m.connect(BASE);
  h.m.connect({ ...BASE, name: 'b', local: 2, profile: 'dev' });
  h.m.connect({ ...BASE, name: 'c', local: 3, profile: 'other' });
  for (const p of [...h.procs]) { p.stderr.emit('data', Buffer.from(`${EXPIRED}\n`)); p.emit('close', 1, null); }
  assert.deepStrictEqual(['glacier-prod', 'b', 'c'].map((n) => h.m.get(n).state), ['waiting', 'waiting', 'waiting']);
  const before = h.procs.length;
  const resumed = h.m.resumeWaiting((t) => t.profile === 'dev');
  assert.deepStrictEqual(resumed, ['b']);
  assert.strictEqual(h.procs.length, before + 1);
  assert.strictEqual(h.m.get('b').state, 'active');
  assert.strictEqual(h.m.get('b').attempt, 0);
  assert.strictEqual(h.m.get('c').state, 'waiting');
  assert.strictEqual(h.m.get('glacier-prod').state, 'waiting');
  assert.deepStrictEqual(h.m.resumeWaiting(() => false), []);
});

test('onWake leaves waiting entries alone; disconnect makes them idle', () => {
  const h = harness();
  h.m.connect(BASE);
  fail(h, EXPIRED);
  h.m.onWake();
  assert.strictEqual(h.procs.length, 1);
  assert.strictEqual(h.m.get('glacier-prod').state, 'waiting');
  h.m.disconnect('glacier-prod');
  assert.strictEqual(h.m.get('glacier-prod').state, 'idle');
});

test('a non sign-in error still retries as before', () => {
  const h = harness();
  h.m.connect(BASE);
  fail(h, 'TargetNotConnected: nope');
  assert.strictEqual(h.m.get('glacier-prod').state, 'reconnecting');
  assert.ok(MAX_RETRIES > 0);
});

// ---- archive -----------------------------------------------------------

test('archive tick never charges waiting tunnels, even beside other failing ones', () => {
  const ts = [{ name: 'a', archived: false, failingMs: 0 }, { name: 'b', archived: false, failingMs: 0 },
    { name: 'c', archived: false, failingMs: 0 }];
  const st = { a: { state: 'waiting', error: EXPIRED }, b: { state: 'failed', error: 'boom' }, c: { state: 'active' } };
  tick(ts, (n) => st[n], 30 * DAY, 7);
  assert.strictEqual(ts[0].failingMs, 0);
  assert.strictEqual(ts[0].archived, false);
  const only = [{ name: 'a', archived: false, failingMs: 0 }, { name: 'b', archived: false, failingMs: 0 }];
  tick(only, (n) => ({ a: { state: 'waiting' }, b: { state: 'failed', error: 'boom' } })[n], 30 * DAY, 7);
  assert.strictEqual(only[1].failingMs, 0, 'waiting counts as a sign-in outage, not a bad tunnel');
});

// ---- CLI ---------------------------------------------------------------

function cli(tunnels = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-cliprof-'));
  const file = path.join(dir, 'connections.json');
  if (tunnels.length) fs.writeFileSync(file, JSON.stringify({ version: 1, settings: {}, tunnels }));
  const spawned = [];
  const deps = {
    store: new Store({ file }),
    scan: { scanSessions: async () => [], matchSessions: scanLib.matchSessions, isPortInUse: async () => false, killSession: () => [] },
    spawn: (cmd, args) => { spawned.push(args); return { pid: 7, unref() {} }; },
    now: () => 0, env: {}, version: '1',
  };
  return { exec: (a) => run(a, deps), spawned, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const ADD = ['add', 'x', '--region', 'eu-west-1', '--target', 'i-0357e26df0d26b2ae', '--host', 'h', '--port', '5432', '--local', '7000'];

test('cli add/edit/list/up with profile and clearing it', async () => {
  const s = cli();
  try {
    let r = await s.exec([...ADD, '--profile', 'dev']);
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(s.read().tunnels[0].profile, 'dev');
    r = await s.exec(['list']);
    assert.match(r.out.split('\n')[0], /PROFILE/);
    assert.match(r.out, /dev/);
    r = await s.exec(['list', '--json']);
    assert.strictEqual(JSON.parse(r.out)[0].profile, 'dev');
    r = await s.exec(['up', 'x']);
    assert.strictEqual(r.code, 0, r.err);
    assert.deepStrictEqual(s.spawned[0].slice(-2), ['--profile', 'dev']);
    r = await s.exec(['edit', 'x', '--profile', 'qa']);
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(s.read().tunnels[0].profile, 'qa');
    r = await s.exec(['edit', 'x', '--profile', 'bad name']);
    assert.strictEqual(r.code, 1);
    assert.match(r.err, /profile/);
    assert.strictEqual(s.read().tunnels[0].profile, 'qa');
    r = await s.exec(['edit', 'x', '--default-profile']);
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(s.read().tunnels[0].profile, '');
    r = await s.exec(['edit', 'x', '--profile', 'a', '--default-profile']);
    assert.strictEqual(r.code, 2);
    r = await s.exec(['list']);
    assert.doesNotMatch(r.out.split('\n')[0], /PROFILE/);
    assert.match((await s.exec(['--help'])).out, /--default-profile/);
  } finally { s.cleanup(); }
});
