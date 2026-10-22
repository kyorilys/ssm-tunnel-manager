const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Controller } = require('../lib/controller');
const { Store } = require('../lib/store');
const { TunnelManager } = require('../lib/tunnelManager');
const realScan = require('../lib/scan');
const archive = require('../lib/archive');

const DAY = 86400000;
const HOUR = 3600000;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-controller-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const T = (name, local, over = {}) => ({
  name, region: 'us-west-2', target: 'i-0357e26df0d26b2ae', host: `${name}.db.example`,
  port: 5432, local, desc: '', env: 'production', auto: true,
  archived: false, failingMs: 0, archivedAt: null, lastError: null, ...over,
});

const sess = (t, pid, etimeSec = 100) => ({
  pid, ppid: pid - 1, pids: [pid - 1, pid], region: t.region, target: t.target,
  host: t.host, port: t.port, local: t.local, etimeSec, orphan: false,
});

let dirCount = 0;

// Real Store/TunnelManager/matchSessions; fakes for ps, ports, kills, timers, clock and the OS bits.
function harness({ tunnels = [], settings = {}, sessions = [], holdExit = false, loginSupported = false,
  tools, script, logThrows = false } = {}) {
  const dir = path.join(ROOT, `case-${dirCount++}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'connections.json');
  if (tunnels.length || Object.keys(settings).length) {
    fs.writeFileSync(file, JSON.stringify({ version: 1, settings, tunnels }));
  }
  const importPath = path.join(dir, 'ssm-connect');
  if (script) fs.writeFileSync(importPath, script);

  const h = {
    dir, file, importPath, sessions, holdExit, procs: [], killed: [], notices: [], copied: [],
    log: [], logs: [], logins: [], clock: { v: 1e9 }, timers: [], intervals: [], mtimers: [], events: [], states: [],
  };
  const spawn = () => {
    const p = new EventEmitter();
    p.pid = 1000 + h.procs.length;
    p.stderr = new EventEmitter();
    p.signals = [];
    p.end = (code = 1) => { p.emit('exit', code, null); p.emit('close', code, null); };
    p.kill = (sig) => { p.signals.push(sig); if (!h.holdExit) p.end(null); };
    h.procs.push(p);
    h.log.push('spawn');
    return p;
  };
  h.manager = new TunnelManager({
    spawn, kill: (proc, sig) => proc.kill(sig), now: () => h.clock.v,
    setTimer: (fn) => { const t = { fn, cleared: false }; h.mtimers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
  });
  h.store = new Store({ file });
  h.scan = {
    scanSessions: async () => { h.log.push('scan'); return h.sessions.map((s) => ({ ...s })); },
    matchSessions: realScan.matchSessions,
    isPortInUse: async (port) => h.sessions.some((s) => s.local === port),
    killSession: async (s) => { h.killed.push(s.pid); h.sessions = h.sessions.filter((x) => x.pid !== s.pid); },
  };
  h.c = new Controller({
    store: h.store, manager: h.manager, scan: h.scan, archive, importPath,
    displayPath: (p) => p.replace(ROOT, '~'), dataPath: file,
    tools: tools === undefined ? { aws: '2.37.5', plugin: '1.2.553.0', awsPath: '/opt/homebrew/bin/aws' } : tools,
    loginItem: { supported: loginSupported, set: (v) => h.logins.push(v) },
    notify: (title, body) => h.notices.push({ title, body }),
    clipboard: { writeText: (t) => h.copied.push(t) },
    now: () => h.clock.v,
    logger: {
      log: (level, event, tunnel, message, extra) => {
        if (logThrows) throw new Error('logger exploded');
        h.logs.push({ level, event, tunnel, message, extra });
        return true;
      },
    },
    setInterval: (fn, ms) => { const t = { fn, ms, cleared: false }; h.intervals.push(t); return t; },
    clearInterval: (t) => { t.cleared = true; },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; h.timers.push(t); return t; },
    clearTimeout: (t) => { t.cleared = true; },
  });
  h.c.on('event', (e) => h.events.push(e));
  h.c.on('state', (s) => h.states.push(s));
  h.flush = () => {
    for (let i = 0; i < h.timers.length; i++) {
      const t = h.timers[i];
      if (!t.cleared) { t.cleared = true; t.fn(); }
    }
  };
  h.poll = () => h.intervals.find((i) => i.ms === 5000 && !i.cleared).fn();
  h.hourly = () => h.intervals.find((i) => i.ms === HOUR && !i.cleared).fn();
  h.tick = (ms) => { h.clock.v += ms; return h.hourly(); };
  h.stored = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  h.snap = (name) => h.c.snapshot().tunnels.find((t) => t.name === name);
  h.fire = () => { // run due manager backoff timers
    for (const t of h.mtimers.splice(0)) if (!t.cleared) t.fn();
  };
  return h;
}

const fail = (h, procIndex, message) => {
  if (message) h.procs[procIndex].stderr.emit('data', Buffer.from(`${message}\n`));
  h.procs[procIndex].end(1);
};

test('launch scans before connecting, skips an auto tunnel already running, never starts an archived one', async () => {
  const a = T('a-prod', 15002);
  const h = harness({
    tunnels: [a, T('b-prod', 15003), T('c-old', 15004, { archived: true, archivedAt: 1e9 }), T('d-man', 1435, { auto: false })],
    sessions: [sess(a, 500)],
  });
  await h.c.start();
  assert.strictEqual(h.log[0], 'scan');
  assert.ok(h.log.indexOf('scan') < h.log.indexOf('spawn'));
  assert.strictEqual(h.procs.length, 1, 'only b-prod starts');
  assert.strictEqual(h.manager.get('b-prod').state, 'active');
  assert.strictEqual(h.manager.get('a-prod').state, 'idle');
  assert.strictEqual(h.manager.get('c-old').state, 'idle');
  assert.strictEqual(h.manager.get('d-man').state, 'idle');
  await h.c.shutdown();
});

test('start notifies when connections.json was unreadable', async () => {
  const h = harness();
  fs.writeFileSync(h.file, '{not json');
  await h.c.start();
  assert.strictEqual(h.notices.length, 1);
  assert.strictEqual(h.notices[0].title, 'SSM Tunnels');
  assert.match(h.notices[0].body, /connections\.json could not be read; the old file was kept as connections\.json\.corrupt-/);
  await h.c.shutdown();
});

test('start timers: poll every 5s and the archive tick hourly; tools do not block start', async () => {
  let resolveTools;
  const h = harness({ tools: new Promise((r) => { resolveTools = r; }) });
  await h.c.start();
  assert.deepStrictEqual(h.intervals.map((i) => i.ms).sort((x, y) => x - y), [5000, HOUR]);
  assert.strictEqual(h.c.snapshot().tools, null);
  resolveTools({ aws: '2.37.5', plugin: null, awsPath: '/x/aws' });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(h.c.snapshot().tools, { aws: '2.37.5', plugin: null, awsPath: '/x/aws' });
  await h.c.shutdown();
});

test('a rejected tools promise leaves tools null', async () => {
  const h = harness({ tools: Promise.reject(new Error('no aws')) });
  await h.c.start();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(h.c.snapshot().tools, null);
  await h.c.shutdown();
});

test('snapshot merges app, terminal, idle and failed (gaveUp) tunnels', async () => {
  const a = T('a-prod', 15002);
  const e = T('e-prod', 1436);
  const h = harness({
    tunnels: [a, T('b-prod', 15003, { auto: false }), T('d-man', 1435, { auto: false }), e],
    sessions: [sess(a, 500, 100)],
  });
  await h.c.start();
  await h.c.connect('b-prod');
  const since = h.clock.v;
  // e-prod (auto, started at launch as procs[0]) exhausts its retries
  let idx = 0;
  for (let i = 0; i < 6; i++) { fail(h, idx, 'boom'); h.fire(); idx = h.procs.length - 1; }
  const snap = h.c.snapshot();
  const byName = Object.fromEntries(snap.tunnels.map((t) => [t.name, t]));
  assert.strictEqual(byName['a-prod'].state, 'active');
  assert.strictEqual(byName['a-prod'].origin, 'terminal');
  assert.strictEqual(byName['a-prod'].pid, 500);
  assert.strictEqual(byName['a-prod'].since, h.clock.v - 100 * 1000);
  assert.strictEqual(byName['b-prod'].origin, 'app');
  assert.strictEqual(byName['b-prod'].since, since);
  assert.strictEqual(byName['d-man'].state, 'idle');
  assert.strictEqual(byName['d-man'].origin, null);
  assert.strictEqual(byName['e-prod'].state, 'failed');
  assert.strictEqual(byName['e-prod'].gaveUp, true);
  assert.strictEqual(byName['e-prod'].origin, null);
  assert.match(byName['e-prod'].error, /Gave up after 5 attempts: boom/);
  assert.strictEqual(snap.now, h.clock.v);
  assert.strictEqual(snap.dataPath, h.file.replace(ROOT, '~'));
  assert.deepStrictEqual(snap.loginItem, { supported: false });
  assert.deepStrictEqual(Object.keys(snap.settings).sort(), ['archiveDays', 'openAtLogin', 'purgeDays', 'stopOnQuit']);
  await h.c.shutdown();
});

test('terminal[] holds only unmatched, unowned sessions', async () => {
  const a = T('a-prod', 15002);
  const stray = T('stray', 2000);
  const h = harness({ tunnels: [a, T('b-prod', 15003)], sessions: [sess(a, 500)] });
  await h.c.start(); // b-prod spawned as pid 1000
  h.sessions.push(sess(stray, 700, 30), sess(T('b-prod', 15003), 1000));
  await h.poll();
  const { terminal } = h.c.snapshot();
  assert.deepStrictEqual(terminal, [{
    id: '700', pid: 700, region: stray.region, target: stray.target, host: stray.host,
    port: stray.port, local: 2000, since: h.clock.v - 30 * 1000,
  }]);
  await h.c.shutdown();
});

test('disconnect of a terminal-matched tunnel kills its ps session and not the manager', async () => {
  const a = T('a-prod', 15002);
  const h = harness({ tunnels: [a], sessions: [sess(a, 500)] });
  await h.c.start();
  const r = await h.c.disconnect('a-prod');
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(h.killed, [500]);
  assert.strictEqual(h.procs.length, 0);
  assert.strictEqual(h.snap('a-prod').state, 'idle');
  await h.c.shutdown();
});

test('disconnect of an app tunnel goes through the manager', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002)] });
  await h.c.start();
  await h.c.disconnect('a-prod');
  assert.deepStrictEqual(h.procs[0].signals, ['SIGTERM']);
  assert.deepStrictEqual(h.killed, []);
  await h.c.shutdown();
});

test('unknown tunnel names are rejected', async () => {
  const h = harness();
  await h.c.start();
  assert.deepStrictEqual(await h.c.connect('nope'), { ok: false, error: 'Unknown tunnel' });
  assert.deepStrictEqual(await h.c.disconnect('nope'), { ok: false, error: 'Unknown tunnel' });
  await h.c.shutdown();
});

test('connect refuses archived tunnels and is a no-op for a running Terminal one', async () => {
  const a = T('a-prod', 15002);
  const h = harness({ tunnels: [a, T('c-old', 15004, { archived: true, archivedAt: 1e9 })], sessions: [sess(a, 500)] });
  await h.c.start();
  assert.deepStrictEqual(await h.c.connect('c-old'), { ok: false, error: 'Restore it first' });
  assert.deepStrictEqual(await h.c.connect('a-prod'), { ok: true });
  assert.strictEqual(h.procs.length, 0);
  await h.c.shutdown();
});

test('disconnectAll stops app sessions and kills non-owned ps sessions, counting them', async () => {
  const a = T('a-prod', 15002);
  const h = harness({ tunnels: [a, T('b-prod', 15003)], sessions: [sess(a, 500)], holdExit: true });
  await h.c.start(); // b-prod = pid 1000, still exiting after disconnectAll
  h.sessions.push(sess(T('stray', 2000), 700), sess(T('b-prod', 15003), 1000));
  const r = await h.c.disconnectAll();
  assert.deepStrictEqual(r, { ok: true, stopped: 3 });
  assert.deepStrictEqual(h.killed.sort(), [500, 700]);
  assert.deepStrictEqual(h.procs[0].signals, ['SIGTERM']);
  h.procs[0].end(null);
  await h.c.shutdown();
});

test('disconnectEnv stops only that env: app via manager, matched via kill, unmatched untouched', async () => {
  const a = T('a-prod', 15002);
  const s = T('s-stg', 1437, { env: 'staging' });
  const h = harness({
    tunnels: [a, T('b-prod', 15003), s, T('c-old', 15004, { archived: true, archivedAt: 1e9 })],
    sessions: [sess(a, 500)],
  });
  await h.c.start(); // b-prod, s-stg app
  h.sessions.push(sess(T('stray', 2000), 700));
  const r = await h.c.disconnectEnv('production');
  assert.deepStrictEqual(r, { ok: true, stopped: 2 });
  assert.deepStrictEqual(h.killed, [500]);
  assert.strictEqual(h.manager.get('b-prod').state, 'idle');
  assert.strictEqual(h.manager.get('s-stg').state, 'active');
  await h.c.shutdown();
});

test('killTerminal kills only an unmatched session and refuses matched or unknown ids', async () => {
  const a = T('a-prod', 15002);
  const h = harness({ tunnels: [a], sessions: [sess(a, 500), sess(T('stray', 2000), 700)] });
  await h.c.start();
  assert.deepStrictEqual(await h.c.killTerminal('500'), { ok: false, error: 'Session not found' });
  assert.deepStrictEqual(await h.c.killTerminal('999'), { ok: false, error: 'Session not found' });
  assert.deepStrictEqual(h.killed, []);
  assert.deepStrictEqual(await h.c.killTerminal('700'), { ok: true });
  assert.deepStrictEqual(h.killed, [700]);
  await h.c.shutdown();
});

test('hourly tick archives a tunnel failing for archiveDays and tells everyone', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002), T('d-man', 1435, { auto: false })], settings: { archiveDays: 1, purgeDays: 7 } });
  await h.c.start();
  await h.c.connect('d-man');
  fail(h, 1, 'TargetNotConnected');
  for (let i = 0; i < 23; i++) await h.tick(HOUR);
  assert.strictEqual(h.snap('d-man').archived, false);
  await h.tick(HOUR);
  const d = h.snap('d-man');
  assert.strictEqual(d.archived, true);
  assert.strictEqual(d.archivedAt, h.clock.v);
  assert.strictEqual(h.manager.get('d-man').state, 'idle');
  assert.deepStrictEqual(h.events, [{ type: 'archived', names: ['d-man'] }]);
  assert.deepStrictEqual(h.c.snapshot().notice, ['d-man']);
  assert.deepStrictEqual(h.notices.at(-1), {
    title: 'Auto-archived d-man',
    body: 'Failed for 1 days. Deleted permanently in 7 days unless restored.',
  });
  assert.strictEqual(h.stored().tunnels.find((t) => t.name === 'd-man').archived, true);
  h.c.dismissNotice();
  assert.deepStrictEqual(h.c.snapshot().notice, []);
  await h.c.shutdown();
});

test('archive notification says kept until deleted when purgeDays is 0', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002), T('d-man', 1435, { auto: false })], settings: { archiveDays: 1, purgeDays: 0 } });
  await h.c.start();
  await h.c.connect('d-man');
  fail(h, 1, 'TargetNotConnected');
  for (let i = 0; i < 24; i++) await h.tick(HOUR);
  assert.strictEqual(h.notices.at(-1).body, 'Failed for 1 days. Kept until you delete it.');
  await h.c.shutdown();
});

test('credential errors are not charged toward archiving', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002), T('d-man', 1435, { auto: false })], settings: { archiveDays: 1 } });
  await h.c.start();
  await h.c.connect('d-man');
  fail(h, 1, 'An error occurred (ExpiredToken) when calling');
  for (let i = 0; i < 30; i++) await h.tick(HOUR);
  assert.strictEqual(h.snap('d-man').archived, false);
  assert.strictEqual(h.snap('d-man').failingMs, 0);
  await h.c.shutdown();
});

test('the tick delta is capped at tickMs and onWake does not charge the sleep', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002), T('d-man', 1435, { auto: false })], settings: { archiveDays: 30 } });
  await h.c.start();
  await h.c.connect('d-man');
  fail(h, 1, 'boom');
  await h.tick(10 * HOUR);
  assert.strictEqual(h.snap('d-man').failingMs, HOUR);
  h.clock.v += 10 * HOUR;
  await h.c.onWake();
  await h.tick(HOUR);
  assert.strictEqual(h.snap('d-man').failingMs, 2 * HOUR);
  await h.c.shutdown();
});

test('start purges an archived tunnel older than purgeDays and emits purged', async () => {
  const h = harness({
    tunnels: [T('keep', 15002, { auto: false }), T('c-old', 15004, { archived: true, archivedAt: 1e9 - 8 * DAY })],
    settings: { archiveDays: 7, purgeDays: 7 },
  });
  await h.c.start();
  assert.deepStrictEqual(h.store.list().map((t) => t.name), ['keep']);
  assert.deepStrictEqual(h.stored().tunnels.map((t) => t.name), ['keep']);
  assert.deepStrictEqual(h.events, [{ type: 'purged', names: ['c-old'] }]);
  assert.deepStrictEqual(h.notices.at(-1), { title: 'Deleted c-old permanently', body: 'Archived longer than 7 days.' });
  await h.c.shutdown();
});

test('renaming a running app tunnel is refused; renaming an idle one works', async () => {
  const a = T('a-prod', 15002);
  const h = harness({ tunnels: [a, T('d-man', 1435, { auto: false })] });
  await h.c.start();
  const data = (t, name) => ({ name, region: t.region, target: t.target, host: t.host, port: t.port, local: t.local, desc: '', env: t.env, auto: t.auto });
  assert.deepStrictEqual(await h.c.saveTunnel(data(a, 'a-renamed'), 'a-prod'), { ok: false, errors: { name: 'Disconnect to rename' } });
  assert.ok(h.store.get('a-prod'));
  const r = await h.c.saveTunnel(data(T('d-man', 1435, { auto: false }), 'd-renamed'), 'd-man');
  assert.strictEqual(r.ok, true);
  assert.ok(h.store.get('d-renamed'));
  assert.strictEqual(h.store.get('d-man'), undefined);
  const added = await h.c.saveTunnel(data(T('new-one', 1440, { auto: false }), 'new-one'), null);
  assert.strictEqual(added.ok, true);
  assert.ok(h.store.get('new-one'));
  await h.c.shutdown();
});

test('editing a running tunnel updates the stored config for the next spawn', async () => {
  const a = T('a-prod', 15002);
  const h = harness({ tunnels: [a] });
  await h.c.start();
  const r = await h.c.saveTunnel({ ...a, desc: 'new desc' }, 'a-prod');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.store.get('a-prod').desc, 'new desc');
  await h.c.shutdown();
});

test('setAuto(true) on a failed tunnel moves it to reconnecting', async () => {
  const h = harness({ tunnels: [T('d-man', 1435, { auto: false })] });
  await h.c.start();
  await h.c.connect('d-man');
  fail(h, 0, 'boom');
  assert.strictEqual(h.snap('d-man').state, 'failed');
  assert.deepStrictEqual(await h.c.setAuto('d-man', true), { ok: true });
  assert.strictEqual(h.snap('d-man').state, 'reconnecting');
  assert.strictEqual(h.stored().tunnels[0].auto, true);
  await h.c.shutdown();
});

test('lastError is persisted when a tunnel fails', async () => {
  const h = harness({ tunnels: [T('d-man', 1435, { auto: false })] });
  await h.c.start();
  await h.c.connect('d-man');
  fail(h, 0, 'TargetNotConnected: i-123');
  assert.strictEqual(h.stored().tunnels[0].lastError, 'TargetNotConnected: i-123');
  await h.c.shutdown();
});

test('failingMs resets after 10 seconds of staying connected', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002)] });
  await h.c.start();
  h.store.get('a-prod').failingMs = 5000; // accrued earlier; the launch tick would have cleared it
  h.store.save();
  h.clock.v += 9000;
  await h.poll();
  assert.strictEqual(h.stored().tunnels[0].failingMs, 5000);
  h.clock.v += 1000;
  await h.poll();
  assert.strictEqual(h.stored().tunnels[0].failingMs, 0);
  await h.c.shutdown();
});

test('state is pushed debounced after a change', async () => {
  const h = harness({ tunnels: [T('d-man', 1435, { auto: false })] });
  await h.c.start();
  h.states.length = 0;
  await h.c.connect('d-man');
  await h.c.setAuto('d-man', true);
  assert.strictEqual(h.states.length, 0);
  assert.ok(h.timers.some((t) => !t.cleared && t.ms === 100));
  h.flush();
  assert.strictEqual(h.states.length, 1);
  assert.strictEqual(h.states[0].tunnels[0].state, 'active');
  await h.c.shutdown();
});

test('updateSettings applies the login item only when supported', async () => {
  const off = harness({ loginSupported: false });
  await off.c.start();
  assert.strictEqual((await off.c.updateSettings({ openAtLogin: false })).ok, true);
  assert.deepStrictEqual(off.logins, []);
  await off.c.shutdown();

  const on = harness({ loginSupported: true });
  await on.c.start();
  assert.deepStrictEqual(on.logins, [true]); // applied at launch
  await on.c.updateSettings({ openAtLogin: false });
  await on.c.updateSettings({ stopOnQuit: false });
  assert.deepStrictEqual(on.logins, [true, false]);
  const bad = await on.c.updateSettings({ archiveDays: 999 });
  assert.strictEqual(bad.ok, false);
  await on.c.shutdown();
});

test('changing archiveDays re-runs the archive check', async () => {
  const h = harness({
    tunnels: [T('a-prod', 15002), T('d-man', 1435, { auto: false, failingMs: 2 * DAY })],
    settings: { archiveDays: 0, purgeDays: 7 },
  });
  await h.c.start();
  await h.c.connect('d-man');
  fail(h, 1, 'boom');
  assert.strictEqual(h.snap('d-man').archived, false);
  await h.c.updateSettings({ archiveDays: 1 });
  assert.strictEqual(h.snap('d-man').archived, true);
  await h.c.shutdown();
});

const SCRIPT = [
  '#!/bin/bash',
  'TUNNELS=(',
  '  "glacier-prod|us-west-2|i-0357e26df0d26b2ae|x.rds.amazonaws.com|5432|15002|DB"',
  '  "glacier-stg|us-west-2|i-0357e26df0d26b2ae|y.rds.amazonaws.com|5432|15003|Staging DB"',
  ')',
].join('\n');

test('importOffer appears for an empty store, importTunnels adds the tunnels and clears it', async () => {
  const h = harness({ script: SCRIPT });
  await h.c.start();
  const offer = h.c.snapshot().importOffer;
  assert.strictEqual(offer.path, h.importPath.replace(ROOT, '~'));
  assert.deepStrictEqual(offer.tunnels.map((t) => t.name), ['glacier-prod', 'glacier-stg']);
  const r = await h.c.importTunnels({ 'glacier-stg': 1500 });
  assert.deepStrictEqual(r, { ok: true, added: ['glacier-prod', 'glacier-stg'], skipped: [] });
  assert.strictEqual(h.store.get('glacier-stg').local, 1500);
  assert.strictEqual(h.c.snapshot().importOffer, null);
  assert.deepStrictEqual(await h.c.importTunnels({}), { ok: false, error: 'Already imported' });
  await h.c.shutdown();
});

test('no importOffer without the script or with saved tunnels', async () => {
  const none = harness();
  await none.c.start();
  assert.strictEqual(none.c.snapshot().importOffer, null);
  await none.c.shutdown();
  const some = harness({ tunnels: [T('a-prod', 15002, { auto: false })], script: SCRIPT });
  await some.c.start();
  assert.strictEqual(some.c.snapshot().importOffer, null);
  await some.c.shutdown();
});

test('continuity: an auto tunnel that left Terminal is reconnected by the app', async () => {
  const a = T('a-prod', 15002);
  const h = harness({ tunnels: [a], sessions: [sess(a, 500)] });
  await h.c.start();
  assert.strictEqual(h.procs.length, 0);
  h.sessions = [];
  await h.poll();
  assert.strictEqual(h.procs.length, 1);
  assert.strictEqual(h.snap('a-prod').origin, 'app');
  await h.c.shutdown();
});

test('continuity: no reconnect after the user disconnected it through the app', async () => {
  const a = T('a-prod', 15002);
  const h = harness({ tunnels: [a], sessions: [sess(a, 500)] });
  await h.c.start();
  await h.c.disconnect('a-prod'); // fake killSession removes the session
  await h.poll();
  await h.poll();
  assert.strictEqual(h.procs.length, 0);
  await h.c.shutdown();
});

test('retry clears the suppression so continuity applies again', async () => {
  const a = T('a-prod', 15002);
  const h = harness({ tunnels: [a], sessions: [sess(a, 500)] });
  await h.c.start();
  await h.c.disconnect('a-prod');
  await h.c.retry('a-prod'); // idle -> connect
  assert.strictEqual(h.procs.length, 1);
  await h.c.shutdown();
});

test('reconnect restarts an app tunnel with the saved config', async () => {
  const a = T('a-prod', 15002);
  const h = harness({ tunnels: [a] });
  await h.c.start();
  await h.c.saveTunnel({ ...a, local: 1999 }, 'a-prod');
  assert.deepStrictEqual(await h.c.reconnect('a-prod'), { ok: true });
  assert.strictEqual(h.procs.length, 2);
  assert.deepStrictEqual(h.procs[1].signals, []);
  assert.deepStrictEqual(h.procs[0].signals, ['SIGTERM']);
  assert.strictEqual(h.manager.get('a-prod').state, 'active');
  await h.c.shutdown();
});

test('reconnect of a Terminal tunnel kills it, waits for the port, then starts it in the app', async () => {
  const a = T('a-prod', 15002);
  const h = harness({ tunnels: [a], sessions: [sess(a, 500)] });
  await h.c.start();
  assert.deepStrictEqual(await h.c.reconnect('a-prod'), { ok: true });
  assert.deepStrictEqual(h.killed, [500]);
  assert.strictEqual(h.procs.length, 1);
  await h.c.shutdown();
});

test('retry on a failed tunnel uses the manager; delete stops it and drops the notice', async () => {
  const h = harness({ tunnels: [T('d-man', 1435, { auto: false })] });
  await h.c.start();
  await h.c.connect('d-man');
  fail(h, 0, 'boom');
  await h.c.retry('d-man');
  assert.strictEqual(h.procs.length, 2);
  const r = await h.c.deleteTunnel('d-man');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tunnel.name, 'd-man');
  assert.strictEqual(r.index, 0);
  assert.deepStrictEqual(h.procs[1].signals, ['SIGTERM']);
  assert.strictEqual(h.store.get('d-man'), undefined);
  const back = await h.c.addTunnel(r.tunnel, r.index);
  assert.strictEqual(back.ok, true);
  await h.c.shutdown();
});

test('restoreArchived, checkPort and copy', async () => {
  const h = harness({ tunnels: [T('c-old', 15004, { archived: true, archivedAt: 1e9 })], sessions: [sess(T('x', 2222), 800)] });
  await h.c.start();
  assert.deepStrictEqual(await h.c.restoreArchived('c-old'), { ok: true });
  assert.strictEqual(h.snap('c-old').archived, false);
  assert.deepStrictEqual(await h.c.checkPort(2222), { inUse: true });
  assert.deepStrictEqual(await h.c.checkPort(2223), { inUse: false });
  assert.deepStrictEqual(await h.c.copy(5432), { ok: true });
  assert.deepStrictEqual(h.copied, ['5432']);
  await h.c.shutdown();
});

test('a failing ps scan keeps the app running with an empty list', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002)] });
  h.scan.scanSessions = async () => { throw new Error('ps failed'); };
  await h.c.start();
  assert.strictEqual(h.procs.length, 1);
  await h.poll();
  assert.deepStrictEqual(h.c.snapshot().terminal, []);
  await h.c.shutdown();
});

test('shutdown with stopOnQuit true stops app procs and the timers', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002)], settings: { stopOnQuit: true } });
  await h.c.start();
  await h.c.shutdown();
  assert.deepStrictEqual(h.procs[0].signals, ['SIGTERM']);
  assert.ok(h.intervals.every((i) => i.cleared));
});

test('shutdown with stopOnQuit false leaves sessions running but still saves', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002)], settings: { stopOnQuit: false } });
  await h.c.start();
  fs.rmSync(h.file);
  await h.c.shutdown();
  assert.deepStrictEqual(h.procs[0].signals, []);
  assert.ok(fs.existsSync(h.file));
  assert.ok(h.intervals.every((i) => i.cleared));
});

test('launch does not reset the failure clock of a freshly spawned auto tunnel', async () => {
  const h = harness({
    tunnels: [T('a-prod', 15002, { failingMs: 3 * DAY }), T('b-prod', 15003)],
    settings: { archiveDays: 7 },
  });
  await h.c.start();
  assert.strictEqual(h.stored().tunnels[0].failingMs, 3 * DAY);
  h.clock.v += 10000; // stays up 10 s: now it counts as healthy and the clock resets
  await h.tick(0);
  assert.strictEqual(h.stored().tunnels[0].failingMs, 0);
  await h.c.shutdown();
});

test('disconnect kills a Terminal session even when the manager entry is failed', async () => {
  const d = T('d-man', 1435, { auto: false });
  const h = harness({ tunnels: [d] });
  await h.c.start();
  await h.c.connect('d-man');
  fail(h, 0, 'boom');
  assert.strictEqual(h.manager.get('d-man').state, 'failed');
  h.sessions.push(sess(d, 600));
  await h.poll();
  assert.strictEqual(h.snap('d-man').origin, 'terminal');
  await h.c.disconnect('d-man');
  assert.deepStrictEqual(h.killed, [600]);
  assert.strictEqual(h.manager.get('d-man').state, 'idle');
  await h.c.shutdown();
});

// ---- external edits (CLI writes the same file) -------------------------

const external = (h, fn) => { const s = new Store({ file: h.file }); s.load(); fn(s); };

test('poll picks up an external add, emits, and does not auto-connect it', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002, { auto: false })] });
  await h.c.start();
  h.flush();
  h.states.length = 0;
  external(h, (s) => s.add(T('b-new', 15003, { auto: true })));
  await h.poll();
  h.flush();
  assert.deepStrictEqual(h.c.snapshot().tunnels.map((t) => t.name), ['a-prod', 'b-new']);
  assert.strictEqual(h.states.length, 1);
  assert.strictEqual(h.procs.length, 0, 'not auto-connected');
  assert.strictEqual(h.manager.get('b-new').state, 'idle');
  await h.c.shutdown();
});

test('poll picks up an external edit and gives the manager the new config', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002, { auto: false })] });
  await h.c.start();
  h.flush();
  h.states.length = 0;
  external(h, (s) => s.update('a-prod', { ...s.get('a-prod'), local: 1999, desc: 'edited' }));
  await h.poll();
  h.flush();
  assert.strictEqual(h.snap('a-prod').local, 1999);
  assert.strictEqual(h.states.length, 1);
  assert.strictEqual(h.states[0].tunnels[0].desc, 'edited');
  h.c.connect('a-prod');
  assert.strictEqual(h.manager.get('a-prod').state, 'active');
  assert.strictEqual(h.manager.entries.get('a-prod').tunnel.local, 1999);
  await h.c.shutdown();
});

// Same as deleting it in the app, which stops it first: otherwise it keeps running, hidden and unstoppable.
test('an external remove of a connected tunnel stops it, and later saves do not resurrect it', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002), T('b-prod', 15003)] });
  await h.c.start();
  assert.strictEqual(h.manager.get('a-prod').state, 'active');
  external(h, (s) => s.remove('a-prod'));
  await h.poll();
  assert.deepStrictEqual(h.c.snapshot().tunnels.map((t) => t.name), ['b-prod']);
  assert.strictEqual(h.manager.get('a-prod').state, 'idle', 'stopped');
  assert.deepStrictEqual(h.procs[0].signals, ['SIGTERM']);
  h.c.runArchive(0);
  assert.deepStrictEqual(h.stored().tunnels.map((t) => t.name), ['b-prod']);
  await h.c.shutdown();
});

test('an external archive is shown as archived and not auto-connected', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002, { auto: false })] });
  await h.c.start();
  external(h, (s) => { s.get('a-prod').archived = true; s.get('a-prod').archivedAt = 1e9; s.save(); });
  await h.poll();
  assert.strictEqual(h.snap('a-prod').archived, true);
  assert.strictEqual(h.procs.length, 0);
  await h.c.shutdown();
});

test('an external add survives the app archive tick and shutdown save', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002, { auto: false })] });
  await h.c.start();
  external(h, (s) => s.add(T('b-new', 15003, { auto: false })));
  h.tick(HOUR); // hourly archive tick saves
  assert.deepStrictEqual(h.stored().tunnels.map((t) => t.name), ['a-prod', 'b-new']);
  external(h, (s) => s.add(T('c-new', 15004, { auto: false })));
  await h.c.shutdown();
  assert.deepStrictEqual(h.stored().tunnels.map((t) => t.name), ['a-prod', 'b-new', 'c-new']);
});

test('an app UI add applies on top of an external add', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002, { auto: false })] });
  await h.c.start();
  external(h, (s) => s.add(T('b-new', 15003, { auto: false })));
  const r = await h.c.saveTunnel(T('c-ui', 15004, { auto: false }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.stored().tunnels.map((t) => t.name), ['a-prod', 'b-new', 'c-ui']);
  await h.c.shutdown();
});

test('a missing or corrupt file during poll keeps the in-memory list and does not throw', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002, { auto: false })] });
  await h.c.start();
  fs.writeFileSync(h.file, '{ broken');
  await h.poll();
  fs.rmSync(h.file);
  await h.poll();
  assert.deepStrictEqual(h.c.snapshot().tunnels.map((t) => t.name), ['a-prod']);
  await h.c.shutdown();
});

// ---- event log (state transitions only) ---------------------------------

const ev = (h) => h.logs.map((l) => `${l.level}:${l.event}${l.tunnel ? `:${l.tunnel}` : ''}`);
const skipStartup = (h) => h.logs.splice(0);

test('log: app_start on start, connect (auto) with pid for each auto tunnel, no archive_sweep when nothing happened', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002), T('m', 15003, { auto: false })] });
  await h.c.start();
  assert.deepStrictEqual(ev(h), ['info:app_start', 'info:connect:a-prod']);
  const connect = h.logs[1];
  assert.strictEqual(connect.extra.pid, 1000);
  assert.strictEqual(connect.extra.by, 'auto');
  assert.strictEqual(connect.extra.local, 15002);
  assert.ok(!JSON.stringify(h.logs).includes('i-0357e26df0d26b2ae'), 'no target in the log');
  await h.c.shutdown();
  assert.strictEqual(h.logs.at(-1).event, 'app_quit');
});

test('log: unchanged polls and repeated state pushes add no events', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002)] });
  await h.c.start();
  skipStartup(h);
  for (let i = 0; i < 4; i++) { await h.poll(); h.flush(); }
  assert.deepStrictEqual(h.logs, []);
  await h.c.shutdown();
});

test('log: user connect then user disconnect', async () => {
  const h = harness({ tunnels: [T('d-man', 1435, { auto: false })] });
  await h.c.start();
  skipStartup(h);
  await h.c.connect('d-man');
  assert.deepStrictEqual(ev(h), ['info:connect:d-man']);
  assert.strictEqual(h.logs[0].extra.by, 'user');
  assert.strictEqual(h.logs[0].extra.pid, 1000);
  await h.c.disconnect('d-man');
  assert.deepStrictEqual(ev(h), ['info:connect:d-man', 'info:disconnect:d-man']);
  await h.c.shutdown();
});

test('log: a manual tunnel that dies logs session_ended with the last error line and nothing else', async () => {
  const h = harness({ tunnels: [T('d-man', 1435, { auto: false })] });
  await h.c.start();
  await h.c.connect('d-man');
  skipStartup(h);
  fail(h, 0, 'warming up\nTargetNotConnected: not connected');
  assert.deepStrictEqual(ev(h), ['error:session_ended:d-man']);
  assert.strictEqual(h.logs[0].message, 'TargetNotConnected: not connected');
  assert.strictEqual(h.logs[0].extra.pid, 1000);
  h.flush();
  await h.poll();
  assert.strictEqual(h.logs.length, 1, 'staying failed adds nothing');
  await h.c.shutdown();
});

test('log: a silent exit is session_ended at info level', async () => {
  const h = harness({ tunnels: [T('d-man', 1435, { auto: false })] });
  await h.c.start();
  await h.c.connect('d-man');
  skipStartup(h);
  fail(h, 0);
  assert.deepStrictEqual(ev(h), ['info:session_ended:d-man']);
  await h.c.shutdown();
});

test('log: auto tunnel drop -> session_ended, reconnect_scheduled (attempt, delayMs), retry connect, then gave_up after the limit', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002)] });
  await h.c.start();
  skipStartup(h);
  fail(h, 0, 'boom');
  assert.deepStrictEqual(ev(h), ['error:session_ended:a-prod', 'warn:reconnect_scheduled:a-prod']);
  assert.strictEqual(h.logs[1].extra.attempt, 1);
  assert.strictEqual(h.logs[1].extra.delayMs, 2000);
  skipStartup(h);
  h.fire();
  assert.deepStrictEqual(ev(h), ['info:connect:a-prod']);
  assert.strictEqual(h.logs[0].extra.by, 'retry');
  assert.strictEqual(h.logs[0].extra.pid, 1001);
  skipStartup(h);
  for (let i = 1; i <= 5; i++) { fail(h, i, 'boom'); h.fire(); }
  const names = ev(h);
  assert.strictEqual(names.filter((n) => n.startsWith('warn:reconnect_scheduled')).length, 4);
  assert.strictEqual(names.filter((n) => n === 'error:gave_up:a-prod').length, 1);
  assert.strictEqual(names.at(-1), 'error:gave_up:a-prod');
  assert.match(h.logs.at(-1).message, /Gave up after 5 attempts: boom/);
  await h.c.shutdown();
});

test('log: onWake logs wake_retry for tunnels waiting to reconnect', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002), T('b-prod', 15003)] });
  await h.c.start();
  fail(h, 0, 'boom');
  skipStartup(h);
  await h.c.onWake();
  assert.deepStrictEqual(ev(h).filter((n) => n.includes('wake_retry')), ['info:wake_retry:a-prod']);
  assert.strictEqual(h.logs.filter((l) => l.event === 'connect')[0].extra.by, 'wake');
  await h.c.shutdown();
});

test('log: external_reload when the CLI edited the file, once per change', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002, { auto: false })] });
  await h.c.start();
  skipStartup(h);
  await h.poll();
  assert.deepStrictEqual(h.logs, []);
  external(h, (s) => s.add(T('b-new', 15003, { auto: false })));
  await h.poll();
  assert.deepStrictEqual(ev(h), ['info:external_reload']);
  await h.poll();
  assert.strictEqual(h.logs.length, 1);
  await h.c.shutdown();
});

test('log: hourly archive logs auto_archived (tunnel, days) and archive_sweep; purge logs purged (names) and the sweep', async () => {
  const h = harness({
    tunnels: [T('a-prod', 15002), T('d-man', 1435, { auto: false }), T('c-old', 15004, { archived: true, archivedAt: 1e9 - 8 * DAY })],
    settings: { archiveDays: 1, purgeDays: 7 },
  });
  await h.c.start();
  const startup = ev(h);
  assert.ok(startup.includes('info:purged'));
  assert.ok(startup.includes('info:archive_sweep'));
  assert.deepStrictEqual(h.logs.find((l) => l.event === 'purged').extra.names, ['c-old']);
  await h.c.connect('d-man');
  fail(h, 1, 'TargetNotConnected');
  skipStartup(h);
  for (let i = 0; i < 23; i++) await h.tick(HOUR);
  assert.ok(!ev(h).includes('info:archive_sweep'), 'quiet ticks log nothing for the sweep');
  assert.ok(!ev(h).some((n) => n.includes('auto_archived')));
  skipStartup(h);
  await h.tick(HOUR);
  const archived = h.logs.find((l) => l.event === 'auto_archived');
  assert.strictEqual(archived.tunnel, 'd-man');
  assert.strictEqual(archived.extra.days, 1);
  const sweep = h.logs.find((l) => l.event === 'archive_sweep');
  assert.strictEqual(sweep.extra.archived, 1);
  assert.strictEqual(sweep.extra.purged, 0);
  await h.c.shutdown();
});

test('log: added, edited, removed, restored, imported, settings_changed', async () => {
  const script = 'TUNNELS=(\n  "imp-one|us-west-2|i-0357e26df0d26b2ae|h.example|5432|2432|d"\n)\n';
  const h = harness({ tunnels: [T('keep', 15002, { auto: false }), T('old', 15003, { auto: false, archived: true, archivedAt: 1e9 })], script });
  await h.c.start();
  skipStartup(h);
  await h.c.saveTunnel(T('fresh', 1500, { auto: false }));
  await h.c.saveTunnel(T('fresh', 1501, { auto: false }), 'fresh');
  await h.c.setAuto('fresh', true);
  await h.c.deleteTunnel('fresh');
  await h.c.restoreArchived('old');
  await h.c.updateSettings({ archiveDays: 3 });
  assert.deepStrictEqual(ev(h), ['info:added:fresh', 'info:edited:fresh', 'info:edited:fresh', 'info:removed:fresh',
    'info:restored:old', 'info:settings_changed']);
  assert.deepStrictEqual(h.logs.at(-1).extra.changes, { archiveDays: 3 });
  await h.c.shutdown();
  const g = harness({ script });
  await g.c.start();
  skipStartup(g);
  await g.c.importTunnels();
  assert.deepStrictEqual(ev(g), ['info:imported']);
  assert.strictEqual(g.logs[0].extra.count, 1);
  await g.c.shutdown();
});

test('log: failed commands (invalid save, unknown tunnel) log nothing', async () => {
  const h = harness({ tunnels: [T('keep', 15002, { auto: false })] });
  await h.c.start();
  skipStartup(h);
  assert.strictEqual((await h.c.saveTunnel({ ...T('bad', 15003), port: 'x' })).ok, false);
  await h.c.deleteTunnel('nope');
  await h.c.restoreArchived('nope');
  await h.c.updateSettings({ archiveDays: -1 });
  assert.deepStrictEqual(h.logs, []);
  await h.c.shutdown();
});

test('log: a throwing logger never breaks controller behaviour', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002), T('d-man', 1435, { auto: false })], logThrows: true });
  await h.c.start();
  assert.strictEqual(h.manager.get('a-prod').state, 'active');
  assert.deepStrictEqual(await h.c.connect('d-man'), { ok: true });
  fail(h, 1, 'boom');
  assert.strictEqual(h.manager.get('d-man').state, 'failed');
  assert.strictEqual((await h.c.saveTunnel(T('n', 1600, { auto: false }))).ok, true);
  assert.strictEqual((await h.c.updateSettings({ archiveDays: 2 })).ok, true);
  assert.strictEqual((await h.c.deleteTunnel('n')).ok, true);
  await h.c.shutdown();
});

test('log: a controller built without a logger still works', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002)] });
  h.c.logger = undefined;
  await h.c.start();
  await h.c.shutdown();
});

// ---- own processes only; EPERM tolerance --------------------------------

test('disconnectAll keeps going when one kill throws EPERM, reporting the failure', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002)] });
  await h.c.start();
  h.sessions.push(sess(T('s1', 2001), 701), sess(T('s2', 2002), 702), sess(T('s3', 2003), 703));
  h.scan.killSession = async (s) => {
    if (s.pid === 702) { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; }
    h.killed.push(s.pid);
  };
  const r = await h.c.disconnectAll();
  assert.deepStrictEqual(h.killed.sort(), [701, 703]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stopped, 3); // the app session plus two kills
  assert.deepStrictEqual(r.failed, [{ pid: 702, error: 'operation not permitted' }]);
  const warn = h.logs.find((l) => l.level === 'warn');
  assert.ok(warn);
  assert.match(warn.message, /702.*operation not permitted/);
  await h.c.shutdown();
});

test('disconnectEnv also survives a failing kill and reports it', async () => {
  const a = T('a-prod', 15002);
  const b = T('b-prod', 15003);
  const h = harness({ tunnels: [a, b], sessions: [sess(a, 500), sess(b, 600)] });
  await h.c.start();
  h.scan.killSession = async (s) => {
    if (s.pid === 500) throw new Error('operation not permitted');
    h.killed.push(s.pid);
  };
  const r = await h.c.disconnectEnv('production');
  assert.deepStrictEqual(h.killed, [600]);
  assert.strictEqual(r.stopped, 1);
  assert.deepStrictEqual(r.failed, [{ pid: 500, error: 'operation not permitted' }]);
  await h.c.shutdown();
});

test('a clean disconnectAll result has no failed field', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002)] });
  await h.c.start();
  assert.deepStrictEqual(await h.c.disconnectAll(), { ok: true, stopped: 1 });
  await h.c.shutdown();
});

test('other-uid look-alike sessions are not treated as running and never killed', async () => {
  const a = T('a-prod', 15002);
  const psLine = (uid, pid) => ` ${uid} ${pid} 1 00:05 /opt/homebrew/bin/aws ssm start-session --region ${a.region} --target ${a.target} --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host=${a.host},portNumber=${a.port},localPortNumber=${a.local}`;
  const h = harness({ tunnels: [a] });
  h.scan.scanSessions = () => realScan.scanSessions({ uid: 501, execFile: (f, args, o, cb) => cb(null, psLine(0, 900), '') });
  await h.c.start();
  assert.strictEqual(h.c.matched.size, 0);
  assert.strictEqual(h.procs.length, 1, 'auto-connect spawned its own session instead of skipping');
  await h.c.disconnectAll();
  assert.deepStrictEqual(h.killed, []);
  h.procs[0].end(null);
  await h.c.shutdown();
});

// ---- review findings -------------------------------------------------------

// What `ssm-tunnels down` does: a second Store on the same file records the stop, then the session is killed.
const cliStop = (h, names) => {
  const cli = new Store({ file: h.file });
  cli.load();
  cli.requestStop(names, h.clock.v);
};

test('#1 ssm-tunnels down of an app-run auto tunnel is not undone by the app', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002)] });
  await h.c.start();
  assert.strictEqual(h.procs.length, 1);
  cliStop(h, ['a-prod']);
  h.procs[0].end(null); // the CLI's kill lands
  h.fire();
  await h.poll();
  h.fire();
  assert.strictEqual(h.procs.length, 1, 'no respawn');
  assert.strictEqual(h.manager.get('a-prod').state, 'idle');
  await h.c.shutdown();
});

test('#1 ssm-tunnels down of a Terminal session is not taken over by the app', async () => {
  const a = T('a-prod', 15002);
  const h = harness({ tunnels: [a], sessions: [sess(a, 500)] });
  await h.c.start();
  assert.strictEqual(h.procs.length, 0);
  cliStop(h, ['a-prod']);
  h.sessions = []; // the CLI killed it
  await h.poll();
  assert.strictEqual(h.procs.length, 0, 'the app did not take it over');
  await h.c.shutdown();
});

test('#1 a stop recorded before the app started does not block launch auto-connect', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002, { stopRequestedAt: 5 })] });
  await h.c.start();
  assert.strictEqual(h.procs.length, 1);
  await h.c.shutdown();
});

test('#2 tunnels renamed or removed through the CLI while the app runs them are stopped, not left hidden', async () => {
  const h = harness({ tunnels: [T('a-prod', 15002), T('b-prod', 15003)] });
  await h.c.start();
  assert.strictEqual(h.procs.length, 2);
  const cli = new Store({ file: h.file });
  cli.load();
  cli.update('a-prod', { ...cli.get('a-prod'), name: 'a2-prod' });
  cli.remove('b-prod');
  await h.poll();
  assert.ok(h.procs[0].signals.length > 0, 'old a-prod session stopped');
  assert.ok(h.procs[1].signals.length > 0, 'removed b-prod session stopped');
  assert.deepStrictEqual(h.manager.ownedPids(), []);
  await h.c.shutdown();
});
