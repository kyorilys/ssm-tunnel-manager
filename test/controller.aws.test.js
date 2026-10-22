const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { EventEmitter } = require('node:events');
const { Controller } = require('../lib/controller');
const { Store } = require('../lib/store');
const { TunnelManager } = require('../lib/tunnelManager');
const awsProfiles = require('../lib/awsProfiles');
const realScan = require('../lib/scan');
const archive = require('../lib/archive');

const MIN = 60000;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-controller-aws-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const tick = () => new Promise((r) => setImmediate(r));

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const CONFIG = `[profile dev]
sso_session = corp
sso_account_id = 123456789012
sso_role_name = Admin
region = us-east-1

[profile dev2]
sso_session = corp
sso_account_id = 210987654321
sso_role_name = Admin

[profile ops]
sso_start_url = https://ops.awsapps.com/start
sso_region = us-east-1
sso_account_id = 111111111111
sso_role_name = Ops

[sso-session corp]
sso_start_url = https://corp.awsapps.com/start
sso_region = us-east-1
`;
const CREDS = `[ci]
aws_access_key_id = ${KEY_ID}
aws_secret_access_key = ${SECRET}
`;
const NO_TOKEN = 'Error loading SSO Token: Token for https://corp.awsapps.com/start does not exist';

const T = (name, local, over = {}) => ({
  name, region: 'us-west-2', target: 'i-0357e26df0d26b2ae', host: `${name}.db.example`,
  port: 5432, local, desc: '', env: 'other', auto: true,
  archived: false, failingMs: 0, archivedAt: null, lastError: null, profile: '', ...over,
});

let count = 0;
function harness({ tunnels = [], config = CONFIG, creds = CREDS, withAws = true, envVars = {} } = {}) {
  const dir = path.join(ROOT, `case-${count++}`);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
  if (config !== null) fs.writeFileSync(path.join(home, '.aws', 'config'), config);
  if (creds !== null) fs.writeFileSync(path.join(home, '.aws', 'credentials'), creds);
  const file = path.join(dir, 'connections.json');
  if (tunnels.length) fs.writeFileSync(file, JSON.stringify({ version: 1, settings: {}, tunnels }));

  const h = { dir, home, procs: [], logs: [], events: [], states: [], clock: { v: 1e9 }, exec: [], sts: {},
    hangSts: false, children: [], spawned: [], timers: [] };
  const spawn = () => {
    const p = new EventEmitter();
    p.pid = 1000 + h.procs.length;
    p.stderr = new EventEmitter();
    p.kill = () => p.emit('close', null, null);
    p.end = (code = 1) => p.emit('close', code, null);
    h.procs.push(p);
    return p;
  };
  h.manager = new TunnelManager({
    spawn, kill: (proc) => proc.kill(), now: () => h.clock.v,
    setTimer: (fn) => { const t = { fn, cleared: false }; h.timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
  });
  const execFile = (bin, args, opts, cb) => {
    h.exec.push({ bin, args: [...args] });
    if (args[0] === 'configure') {
      const [, , key, value, , profile] = args;
      const f = path.join(home, '.aws', 'config');
      const doc = awsProfiles.parseIni(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
      awsProfiles.upsertSection(doc, profile === 'default' ? 'default' : `profile ${profile}`, { [key]: value });
      fs.writeFileSync(f, awsProfiles.serialize(doc));
      return cb(null, '', '');
    }
    if (h.hangSts) return undefined;
    const prof = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : 'default';
    const r = h.sts[prof] || { out: JSON.stringify({ Arn: 'arn:aws:sts::123456789012:assumed-role/Admin/me', Account: '123456789012' }) };
    if (r.err) return cb(Object.assign(new Error('x'), { code: 255 }), '', r.err);
    return cb(null, r.out, '');
  };
  const spawnAws = (bin, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => setImmediate(() => child.emit('close', null));
    child.args = args;
    h.children.push(child);
    h.spawned.push(args);
    return child;
  };
  h.c = new Controller({
    store: new Store({ file }), manager: h.manager, scan: {
      scanSessions: async () => [], matchSessions: realScan.matchSessions,
      isPortInUse: async () => false, killSession: async () => {},
    },
    archive, importPath: path.join(dir, 'none'), displayPath: (p) => p, dataPath: file,
    tools: null, loginItem: { supported: false, set() {} },
    notify() {}, clipboard: { writeText() {} }, now: () => h.clock.v,
    logger: { log: (level, event, tunnel, message, extra) => { h.logs.push({ level, event, tunnel, message, extra }); } },
    setInterval: () => ({}), clearInterval() {},
    setTimeout: (fn) => { const t = { fn }; h.timers.push(t); return t; }, clearTimeout() {},
    ...(withAws && { aws: { home, fs, execFile, spawn: spawnAws, awsBin: 'aws', env: { PATH: '/x', ...envVars } } }),
  });
  h.c.on('event', (e) => h.events.push(e));
  h.c.on('state', (s) => h.states.push(s));
  h.stsCalls = () => h.exec.filter((e) => e.args[0] === 'sts').map((e) => (e.args.includes('--profile') ? e.args[e.args.indexOf('--profile') + 1] : 'default'));
  h.fail = (i, msg) => { h.procs[i].stderr.emit('data', Buffer.from(`${msg}\n`)); h.procs[i].end(1); };
  h.flush = () => { for (const t of h.timers.splice(0)) if (!t.cleared && t.fn) t.fn(); };
  return h;
}

// Three auto tunnels: two on the corp SSO session, one on a separate SSO start URL.
const waitingSetup = async () => {
  const h = harness({ tunnels: [T('a', 15001, { profile: 'dev' }), T('b', 15002, { profile: 'dev2' }), T('c', 15003, { profile: 'ops' })] });
  await h.c.start();
  for (let i = 0; i < 3; i++) h.fail(i, NO_TOKEN);
  return h;
};

test('snapshot without any AWS setup reports noCredentials and no profiles', async () => {
  const h = harness({ config: null, creds: null, withAws: false });
  await h.c.start();
  assert.deepStrictEqual(h.c.snapshot().aws, { profiles: [], waiting: [], signingIn: null, noCredentials: true });
});

test('envCredentials alone means credentials exist', async () => {
  const h = harness({ config: null, creds: null, envVars: { AWS_ACCESS_KEY_ID: KEY_ID } });
  await h.c.start();
  await tick();
  assert.strictEqual(h.c.snapshot().aws.noCredentials, false);
  assert.strictEqual((await h.c.awsProfiles()).envCredentials, true);
});

test('start lists profiles and checks only profiles used by tunnels (default included) without waiting', async () => {
  const h = harness({ tunnels: [T('a', 15001, { profile: 'dev' }), T('b', 15002), T('c', 15003, { profile: 'ops', archived: true })] });
  h.hangSts = true; // a status check that never answers
  await h.c.start(); // resolves anyway
  await tick();
  assert.deepStrictEqual(h.stsCalls().sort(), ['default', 'dev']);
  assert.ok(h.exec.every((e) => e.args[0] === 'sts'));
  const names = h.c.snapshot().aws.profiles.map((p) => p.name).sort();
  assert.deepStrictEqual(names, ['ci', 'dev', 'dev2', 'ops']);
  assert.strictEqual(h.procs.length, 2, 'auto-connect was not delayed');
});

test('awsProfiles returns the contract shape and starts a refresh for stale or missing statuses', async () => {
  const h = harness({ tunnels: [T('a', 15001, { profile: 'dev' }), T('b', 15002), T('c', 15003), T('d', 15004, { archived: true, profile: 'dev' })] });
  await h.c.start();
  await tick();
  h.exec.length = 0;
  const r = await h.c.awsProfiles();
  assert.deepStrictEqual(r.files, { config: '~/.aws/config', credentials: '~/.aws/credentials' });
  assert.strictEqual(r.envCredentials, false);
  const by = Object.fromEntries(r.profiles.map((p) => [p.name, p]));
  assert.deepStrictEqual(Object.keys(by.dev).sort(), ['accountId', 'hasKeys', 'name', 'region', 'roleName', 'ssoRegion', 'ssoSession', 'ssoStartUrl', 'status', 'tunnels', 'type']);
  assert.strictEqual(by.dev.type, 'sso');
  assert.strictEqual(by.dev.accountId, '••••9012');
  assert.strictEqual(by.dev.tunnels, 1, 'archived tunnel not counted');
  assert.strictEqual(by.ci.type, 'keys');
  assert.strictEqual(by.ci.accountId, null);
  assert.strictEqual(by.ci.hasKeys, true);
  assert.strictEqual(by.ops.tunnels, 0);
  assert.deepStrictEqual(h.stsCalls().sort(), ['ci', 'dev2', 'ops'], 'dev was fresh from start');
  await tick();
  const after = (await h.c.awsProfiles()).profiles.find((p) => p.name === 'ci');
  assert.strictEqual(after.status.state, 'ok');
  assert.strictEqual(after.status.account, '••••9012');
  assert.strictEqual(typeof after.status.checkedAt, 'number');
});

test("a tunnel with profile '' counts toward the 'default' profile", async () => {
  const h = harness({ tunnels: [T('a', 15001), T('b', 15002, { profile: 'default' })], config: '[default]\nregion = us-east-1\n', creds: null });
  await h.c.start();
  const d = (await h.c.awsProfiles()).profiles.find((p) => p.name === 'default');
  assert.strictEqual(d.tunnels, 2);
});

test('status refresh is throttled to 5 minutes except for explicit awsTest', async () => {
  const h = harness();
  await h.c.start();
  await h.c.awsProfiles();
  await tick();
  const first = h.stsCalls().length;
  assert.strictEqual(first, 4);
  await h.c.awsProfiles();
  await tick();
  assert.strictEqual(h.stsCalls().length, first, 'fresh statuses are reused');
  h.clock.v += 4 * MIN;
  await h.c.awsProfiles();
  await tick();
  assert.strictEqual(h.stsCalls().length, first);
  await h.c.awsTest('dev'); // explicit test ignores the throttle
  assert.strictEqual(h.stsCalls().length, first + 1);
  h.clock.v += 2 * MIN;
  await h.c.awsProfiles();
  await tick();
  assert.strictEqual(h.stsCalls().length, first + 4, 'stale (older than 5 minutes) profiles refresh; dev was just tested');
});

test('awsTest returns the status, updates the cache and emits state', async () => {
  const h = harness();
  await h.c.start();
  h.sts.dev = { err: 'The SSO session associated with this profile has expired or is otherwise invalid' };
  h.states.length = 0;
  const s = await h.c.awsTest('dev');
  assert.strictEqual(s.state, 'expired');
  assert.strictEqual(s.checkedAt, h.clock.v);
  assert.strictEqual(h.c.snapshot().aws.profiles.find((p) => p.name === 'dev').status.state, 'expired');
  h.flush();
  assert.ok(h.states.length >= 1);
  assert.strictEqual((await h.c.awsTest('nope-profile')).state, 'error');
});

test('a waiting tunnel puts its profile in aws.waiting, marks it expired and warns once per profile', async () => {
  const h = await waitingSetup();
  const snap = h.c.snapshot();
  assert.deepStrictEqual(snap.tunnels.map((t) => t.state), ['waiting', 'waiting', 'waiting']);
  assert.deepStrictEqual(snap.aws.waiting, [
    { profile: 'dev', type: 'sso', tunnels: ['a'] },
    { profile: 'dev2', type: 'sso', tunnels: ['b'] },
    { profile: 'ops', type: 'sso', tunnels: ['c'] }]);
  assert.strictEqual(snap.aws.profiles.find((p) => p.name === 'dev').status.state, 'expired');
  const warns = h.logs.filter((l) => l.event === 'aws_signin_needed');
  assert.strictEqual(warns.length, 3);
  assert.ok(warns.every((w) => w.level === 'warn'));
  assert.match(warns[0].message, /dev/);
  assert.match(warns[0].message, /1/);
  // The same profile does not warn again while it stays waiting.
  h.manager.emit('change', 'a', h.manager.get('a'));
  assert.strictEqual(h.logs.filter((l) => l.event === 'aws_signin_needed').length, 3);
});

test('the default profile appears as "default" in aws.waiting', async () => {
  const h = harness({ tunnels: [T('a', 15001)], config: null, creds: null });
  await h.c.start();
  h.fail(0, 'ExpiredToken: the security token included in the request is expired');
  assert.deepStrictEqual(h.c.snapshot().aws.waiting, [{ profile: 'default', type: 'other', tunnels: ['a'] }]);
});

test('successful sign-in resumes only tunnels in the same SSO group and reports progress', async () => {
  const h = await waitingSetup();
  const before = h.procs.length;
  h.events.length = 0;
  h.sts.dev = { err: 'expired' };
  const p = h.c.awsSignIn('dev');
  assert.strictEqual(h.c.snapshot().aws.signingIn, 'dev');
  assert.deepStrictEqual(h.spawned, [['sso', 'login', '--profile', 'dev']]);
  h.children[0].stdout.emit('data', Buffer.from('Attempting to open your default browser.\nhttps://device.sso/?user_code=ABCD-EFGH\n'));
  h.sts.dev = undefined;
  h.children[0].emit('close', 0);
  assert.deepStrictEqual(await p, { ok: true });
  assert.strictEqual(h.procs.length, before + 2, 'a and b (same sso_session) resumed');
  assert.strictEqual(h.manager.get('a').state, 'active');
  assert.strictEqual(h.manager.get('b').state, 'active');
  assert.strictEqual(h.manager.get('c').state, 'waiting');
  const phases = h.events.filter((e) => e.type === 'aws-signin');
  assert.deepStrictEqual(phases.map((e) => e.phase), ['opening', 'waiting', 'done']);
  assert.ok(phases.every((e) => e.profile === 'dev'));
  assert.strictEqual(h.c.snapshot().aws.signingIn, null);
  assert.deepStrictEqual(h.c.snapshot().aws.waiting, [{ profile: 'ops', type: 'sso', tunnels: ['c'] }]);
  assert.strictEqual(h.c.snapshot().aws.profiles.find((p) => p.name === 'dev').status.state, 'ok');
  const log = h.logs.find((l) => l.event === 'aws_signin');
  assert.strictEqual(log.level, 'info');
  assert.ok(!/user_code|device\.sso/.test(JSON.stringify(h.logs)));
  // A later wait on the same profile warns again (the earlier episode ended).
  h.fail(h.procs.length - 2, NO_TOKEN);
  assert.strictEqual(h.logs.filter((l) => l.event === 'aws_signin_needed' && /dev\b/.test(l.message)).length, 2);
});

test('sign-in groups by start URL when there is no sso_session, else just the profile', async () => {
  const cfg = `[profile x]
sso_start_url = https://one.awsapps.com/start
sso_region = us-east-1
sso_account_id = 111111111111
sso_role_name = R
[profile y]
sso_start_url = https://one.awsapps.com/start
sso_region = us-east-1
sso_account_id = 222222222222
sso_role_name = R
[profile z]
sso_start_url = https://two.awsapps.com/start
sso_region = us-east-1
sso_account_id = 333333333333
sso_role_name = R
`;
  const h = harness({ config: cfg, creds: null, tunnels: [T('tx', 15001, { profile: 'x' }), T('ty', 15002, { profile: 'y' }), T('tz', 15003, { profile: 'z' })] });
  await h.c.start();
  for (let i = 0; i < 3; i++) h.fail(i, NO_TOKEN);
  const p = h.c.awsSignIn('x');
  h.children[0].emit('close', 0);
  await p;
  assert.strictEqual(h.manager.get('tx').state, 'active');
  assert.strictEqual(h.manager.get('ty').state, 'active');
  assert.strictEqual(h.manager.get('tz').state, 'waiting');
});

test('only one sign-in at a time; cancel ends it and leaves tunnels waiting', async () => {
  const h = await waitingSetup();
  h.events.length = 0;
  const first = h.c.awsSignIn('dev');
  assert.deepStrictEqual(await h.c.awsSignIn('ops'), { ok: false, message: 'A sign-in is already in progress' });
  assert.strictEqual(h.spawned.length, 1);
  assert.deepStrictEqual(await h.c.awsCancelSignIn('ops'), { ok: false }, 'not the running profile');
  assert.deepStrictEqual(await h.c.awsCancelSignIn('dev'), { ok: true });
  const r = await first;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.cancelled, true);
  assert.deepStrictEqual(h.events.filter((e) => e.type === 'aws-signin').map((e) => e.phase), ['opening', 'cancelled']);
  assert.strictEqual(h.c.snapshot().aws.signingIn, null);
  assert.strictEqual(h.manager.get('a').state, 'waiting');
  const log = h.logs.find((l) => l.event === 'aws_signin');
  assert.strictEqual(log.level, 'warn');
  // A new sign-in can start afterwards.
  const again = h.c.awsSignIn('ops');
  h.children[1].emit('close', 0);
  assert.strictEqual((await again).ok, true);
});

test('a failed sign-in reports the reason, logs a warning and resumes nothing', async () => {
  const h = await waitingSetup();
  h.events.length = 0;
  const before = h.procs.length;
  const p = h.c.awsSignIn('dev');
  h.children[0].stderr.emit('data', Buffer.from('Error: authorization was denied\n'));
  h.children[0].emit('close', 1);
  const r = await p;
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /authorization was denied/);
  assert.deepStrictEqual(h.events.filter((e) => e.type === 'aws-signin').map((e) => e.phase), ['opening', 'failed']);
  assert.match(h.events.at(-1).message, /authorization was denied/);
  assert.strictEqual(h.procs.length, before);
  const log = h.logs.find((l) => l.event === 'aws_signin');
  assert.strictEqual(log.level, 'warn');
  assert.match(log.message, /authorization was denied/);
});

test('sign-in rejects unknown and non-SSO profiles without spawning', async () => {
  const h = harness();
  await h.c.start();
  assert.strictEqual((await h.c.awsSignIn('ghost')).ok, false);
  assert.strictEqual((await h.c.awsSignIn('ci')).ok, false);
  assert.deepStrictEqual(h.spawned, []);
  assert.strictEqual(h.c.snapshot().aws.signingIn, null);
});

test('awsAddKeys never leaves the secret in controller state, logs, events, snapshots or argv', async () => {
  const h = harness({ config: null, creds: null });
  await h.c.start();
  const input = { name: 'newkeys', accessKeyId: KEY_ID, secretAccessKey: SECRET, region: 'us-east-1' };
  const r = await h.c.awsAddKeys(input);
  assert.deepStrictEqual(r, { ok: true });
  await tick();
  h.flush();
  assert.ok(fs.readFileSync(path.join(h.home, '.aws', 'credentials'), 'utf8').includes(SECRET), 'written to the credentials file only');
  const reachable = [JSON.stringify(h.c.snapshot()), JSON.stringify(h.logs), JSON.stringify(h.events), JSON.stringify(h.states),
    JSON.stringify(h.exec), JSON.stringify(r), JSON.stringify(await h.c.awsProfiles()),
    util.inspect(h.c, { depth: 8, maxArrayLength: null, maxStringLength: null }),
    util.inspect(h.manager, { depth: 6, maxStringLength: null })];
  for (const text of reachable) assert.ok(!text.includes(SECRET), 'secret leaked');
  assert.ok(h.stsCalls().includes('newkeys'), 'status test ran in the background');
  const log = h.logs.find((l) => l.event === 'aws_profile_added');
  assert.strictEqual(log.level, 'info');
  assert.ok(log.message.includes('newkeys'));
  assert.ok(!r.errors);
});

test('awsAddKeys validation errors do not echo the secret', async () => {
  const h = harness();
  await h.c.start();
  const r = await h.c.awsAddKeys({ name: 'ci', accessKeyId: 'bad', secretAccessKey: `${SECRET}!`, region: 'nope' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.length >= 3);
  assert.ok(!JSON.stringify(r).includes(SECRET));
  assert.ok(!JSON.stringify(h.logs).includes(SECRET));
  assert.strictEqual(h.logs.filter((l) => l.event === 'aws_profile_added').length, 0);
});

test('awsAddSso adds a profile, logs name only and refreshes the profile list', async () => {
  const h = harness({ config: null, creds: null });
  await h.c.start();
  assert.strictEqual(h.c.snapshot().aws.noCredentials, true);
  const bad = await h.c.awsAddSso({ name: 'x', startUrl: 'http://no', ssoRegion: 'r', accountId: '1', roleName: '' });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.length >= 4);
  const r = await h.c.awsAddSso({ name: 'sso1', startUrl: 'https://acme.awsapps.com/start', ssoRegion: 'us-east-1', accountId: '123456789012', roleName: 'Admin', region: 'us-east-1' });
  assert.deepStrictEqual(r, { ok: true });
  const s = h.c.snapshot().aws;
  assert.deepStrictEqual(s.profiles.map((p) => [p.name, p.type]), [['sso1', 'sso']]);
  assert.strictEqual(s.noCredentials, false);
  const log = h.logs.find((l) => l.event === 'aws_profile_added');
  assert.ok(log.message.includes('sso1'));
  assert.ok(!/awsapps|123456789012/.test(JSON.stringify(log)));
});

test('removing a profile used by tunnels needs force and tunnels keep the profile name', async () => {
  const h = harness({ tunnels: [T('a', 15001, { profile: 'dev' }), T('b', 15002, { profile: 'dev' }), T('c', 15003, { profile: 'dev', archived: true })] });
  await h.c.start();
  assert.deepStrictEqual(await h.c.awsRemoveProfile('dev'), { ok: false, usedBy: ['a', 'b'] });
  assert.deepStrictEqual(await h.c.awsRemoveProfile('dev', { force: false }), { ok: false, usedBy: ['a', 'b'] });
  assert.ok(h.c.snapshot().aws.profiles.some((p) => p.name === 'dev'));
  assert.deepStrictEqual(await h.c.awsRemoveProfile('dev', { force: true }), { ok: true });
  assert.ok(!h.c.snapshot().aws.profiles.some((p) => p.name === 'dev'));
  assert.deepStrictEqual(h.c.snapshot().tunnels.map((t) => t.profile), ['dev', 'dev', 'dev']);
  const log = h.logs.find((l) => l.event === 'aws_profile_removed');
  assert.ok(log.message.includes('dev'));
  assert.ok(!fs.readFileSync(path.join(h.home, '.aws', 'config'), 'utf8').includes('[profile dev]'));
});

test('removing an unused profile needs no force; an unknown profile fails', async () => {
  const h = harness();
  await h.c.start();
  assert.deepStrictEqual(await h.c.awsRemoveProfile('ci'), { ok: true });
  assert.strictEqual((await h.c.awsRemoveProfile('ghost')).ok, false);
});

test('hourly tick refreshes statuses of profiles in use', async () => {
  const h = harness({ tunnels: [T('a', 15001, { profile: 'dev' })] });
  const intervals = [];
  h.c.setIntervalFn = (fn, ms) => { intervals.push({ fn, ms }); return {}; };
  await h.c.start();
  await tick();
  const n = h.stsCalls().length;
  h.clock.v += 61 * MIN;
  intervals.find((i) => i.ms === 3600000).fn();
  await tick();
  assert.strictEqual(h.stsCalls().length, n + 1);
});

test('editing an existing profile saves only with { replace: true }; without it the name is refused', async () => {
  const h = harness();
  const edit = { name: 'ops', startUrl: 'https://ops.awsapps.com/start', ssoRegion: 'us-east-1', accountId: '111111111111', roleName: 'ReadOnly', region: 'eu-west-1' };
  const refused = await h.c.awsAddSso(edit);
  assert.strictEqual(refused.ok, false);
  assert.match(refused.errors.join(' '), /already exists/);
  assert.strictEqual((await h.c.awsAddSso(edit, { replace: true })).ok, true);
  assert.match(fs.readFileSync(path.join(h.home, '.aws', 'config'), 'utf8'), /sso_role_name = ReadOnly/);

  const NEW_SECRET = 'abcdEFGHijklMNOPqrstUVWXyz0123456789/+=A';
  const keys = { name: 'ci', accessKeyId: 'AKIAIOSFODNN7EXAMPL2', secretAccessKey: NEW_SECRET, region: 'us-east-1' };
  assert.strictEqual((await h.c.awsAddKeys({ ...keys })).ok, false);
  assert.strictEqual((await h.c.awsAddKeys({ ...keys }, { replace: true })).ok, true);
  const creds = fs.readFileSync(path.join(h.home, '.aws', 'credentials'), 'utf8');
  assert.ok(creds.includes('AKIAIOSFODNN7EXAMPL2') && creds.includes(NEW_SECRET) && !creds.includes(SECRET));
});
