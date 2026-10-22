const test = require('node:test');
const assert = require('node:assert');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createLogger, defaultLogFile, redact, readEntries, tailEntries, followEntries, fileSize, LOCK_STALE_MS,
} = require('../lib/logger');

const ROOT = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'ssm-logger-'));
test.after(() => nodeFs.rmSync(ROOT, { recursive: true, force: true }));

const T0 = Date.UTC(2026, 9, 21, 10, 0, 0);
let n = 0;
const freshDir = () => {
  const dir = path.join(ROOT, `case-${n++}`);
  nodeFs.mkdirSync(dir, { recursive: true });
  return dir;
};
const setup = (opts = {}) => {
  const dir = freshDir();
  const file = path.join(dir, 'events.log');
  const clock = { v: T0 };
  const logger = createLogger({ file, source: 'app', now: () => clock.v, ...opts });
  return { dir, file, clock, logger, lines: () => nodeFs.readFileSync(file, 'utf8').split('\n').filter(Boolean) };
};

// Realistic fixtures (same shapes as test/scan.test.js)
const AWS_REAL = ' 4186     1    08:47 /opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python /opt/homebrew/bin/aws ssm start-session --region us-west-2 --target i-0357e26df0d26b2ae --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host=master.glacier-jobs.28i723.usw2.cache.amazonaws.com,portNumber=6379,localPortNumber=16001';
const PLUGIN_REAL = ' 4200  4186    08:47 session-manager-plugin AWS_SSM_START_SESSION_RESPONSE us-west-2 StartSession  {"Target": "i-0357e26df0d26b2ae", "DocumentName": "AWS-StartPortForwardingSessionToRemoteHost", "Parameters": {"host": ["master.glacier-jobs.28i723.usw2.cache.amazonaws.com"], "portNumber": ["6379"], "localPortNumber": ["16001"]}} https://ssm.us-west-2.amazonaws.com';
const TOKEN = 'AAEAAbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefABCDEFghijklmnopqrstuvwxyz0123456789+/AbCdEfGh==';
const RESPONSE_JSON = `{"SessionId": "alice-0a1b2c3d4e5f6a7b8", "TokenValue": "${TOKEN}", "StreamUrl": "wss://ssmmessages.us-west-2.amazonaws.com/v1/data-channel/alice-0a1b2c3d4e5f6a7b8?role=publish_subscribe"}`;

// ---- entry shape ---------------------------------------------------------

test('log writes exactly one JSON line with the documented shape and key order', () => {
  const { logger, lines } = setup();
  assert.strictEqual(logger.log('warn', 'reconnect_scheduled', 'db-prod', 'Retrying', { pid: 12, attempt: 2, delayMs: 4000, local: 15002 }), true);
  const [only, ...rest] = lines();
  assert.deepStrictEqual(rest, []);
  assert.deepStrictEqual(JSON.parse(only), {
    t: '2026-10-21T10:00:00.000Z', source: 'app', level: 'warn', tunnel: 'db-prod', event: 'reconnect_scheduled',
    message: 'Retrying', pid: 12, attempt: 2, delayMs: 4000, local: 15002,
  });
  assert.deepStrictEqual(Object.keys(JSON.parse(only)).slice(0, 6), ['t', 'source', 'level', 'tunnel', 'event', 'message']);
});

test('each log is a single append call; missing tunnel is null; extra cannot override core keys', () => {
  let appends = 0;
  const fs = { ...nodeFs, appendFileSync: (...a) => { appends++; return nodeFs.appendFileSync(...a); } };
  const { logger, lines } = setup({ fs, source: 'cli' });
  logger.log('info', 'app_start', undefined, 'hello', { source: 'evil', level: 'error', t: 'x', event: 'y' });
  assert.strictEqual(appends, 1);
  const e = JSON.parse(lines()[0]);
  assert.strictEqual(e.tunnel, null);
  assert.strictEqual(e.source, 'cli');
  assert.strictEqual(e.level, 'info');
  assert.strictEqual(e.event, 'app_start');
  assert.strictEqual(e.t, '2026-10-21T10:00:00.000Z');
});

test('an unknown level is written as info; the message is capped at 500 characters', () => {
  const { logger, lines } = setup();
  logger.log('loud', 'x', null, 'm'.repeat(2000));
  const e = JSON.parse(lines()[0]);
  assert.strictEqual(e.level, 'info');
  assert.ok(e.message.length <= 500);
});

test('defaultLogFile honours SSM_TUNNELS_LOG and otherwise uses ~/Library/Logs/SSM Tunnels', () => {
  assert.strictEqual(defaultLogFile({ SSM_TUNNELS_LOG: '/tmp/x/e.log' }, '/h'), '/tmp/x/e.log');
  assert.strictEqual(defaultLogFile({}, '/h'), path.join('/h', 'Library', 'Logs', 'SSM Tunnels', 'events.log'));
  assert.strictEqual(defaultLogFile({ SSM_TUNNELS_LOG: '' }, '/h'), path.join('/h', 'Library', 'Logs', 'SSM Tunnels', 'events.log'));
});

test('the log directory is created as needed', () => {
  const dir = freshDir();
  const file = path.join(dir, 'a', 'b', 'events.log');
  const logger = createLogger({ file, source: 'app' });
  assert.strictEqual(logger.file, file);
  assert.strictEqual(logger.log('info', 'e', null, 'm'), true);
  assert.ok(nodeFs.existsSync(file));
});

// ---- never throws ---------------------------------------------------------

test('log never throws on an unwritable path and returns false', () => {
  const dir = freshDir();
  const blocker = path.join(dir, 'blocker');
  nodeFs.writeFileSync(blocker, 'a file, not a directory');
  const logger = createLogger({ file: path.join(blocker, 'sub', 'events.log'), source: 'app' });
  assert.doesNotThrow(() => assert.strictEqual(logger.log('error', 'e', 't', 'm'), false));
});

test('log never throws when every fs call throws, or when extra cannot be serialised', () => {
  const boom = () => { throw new Error('EIO'); };
  const fs = { mkdirSync: boom, appendFileSync: boom, statSync: boom, writeFileSync: boom, renameSync: boom, unlinkSync: boom, rmSync: boom };
  const logger = createLogger({ file: '/nope/events.log', source: 'app', fs });
  assert.strictEqual(logger.log('info', 'e', null, 'm'), false);
  const { logger: ok } = setup();
  assert.strictEqual(ok.log('info', 'e', null, 'm', { big: 10n }), false);
  const circular = {};
  circular.self = circular;
  assert.strictEqual(ok.log('info', 'e', null, 'm', { circular }), true, 'depth is bounded, so a cycle is truncated');
});

// ---- rotation -------------------------------------------------------------

const LONG = 'x'.repeat(120);

test('no rotation below maxBytes', () => {
  const { logger, file } = setup({ maxBytes: 100000 });
  for (let i = 0; i < 5; i++) logger.log('info', 'e', null, `m${i}`);
  assert.ok(!nodeFs.existsSync(`${file}.1`));
});

test('reaching maxBytes rotates events.log to .1 and the next append starts a fresh file', () => {
  const { logger, file, lines } = setup({ maxBytes: 100 });
  logger.log('info', 'e', null, `first ${LONG}`);
  assert.ok(nodeFs.statSync(file).size >= 100);
  assert.ok(!nodeFs.existsSync(`${file}.1`), 'rotation happens on the next write');
  logger.log('info', 'e', null, 'second');
  assert.match(nodeFs.readFileSync(`${file}.1`, 'utf8'), /first/);
  assert.strictEqual(lines().length, 1);
  assert.match(lines()[0], /second/);
  assert.ok(!nodeFs.existsSync(`${file}.lock`), 'lock released');
});

test('rotation shifts .1 -> .2 -> ... and drops the oldest beyond keep', () => {
  const { logger, file } = setup({ maxBytes: 50, keep: 3 });
  for (let i = 1; i <= 6; i++) logger.log('info', 'e', null, `msg${i} ${LONG}`);
  const msgOf = (f) => JSON.parse(nodeFs.readFileSync(f, 'utf8').trim()).message.split(' ')[0];
  assert.strictEqual(msgOf(file), 'msg6');
  assert.strictEqual(msgOf(`${file}.1`), 'msg5');
  assert.strictEqual(msgOf(`${file}.2`), 'msg4');
  assert.strictEqual(msgOf(`${file}.3`), 'msg3');
  assert.ok(!nodeFs.existsSync(`${file}.4`), 'keep limit: nothing beyond .3');
});

test('a fresh lock held by another process: append without rotating, never wait, lock untouched', () => {
  const { logger, file, clock } = setup({ maxBytes: 50 });
  logger.log('info', 'e', null, `a ${LONG}`);
  const lock = `${file}.lock`;
  nodeFs.writeFileSync(lock, '999');
  nodeFs.utimesSync(lock, (clock.v - 2000) / 1000, (clock.v - 2000) / 1000);
  assert.strictEqual(logger.log('info', 'e', null, `b ${LONG}`), true);
  assert.ok(!nodeFs.existsSync(`${file}.1`), 'did not rotate');
  assert.strictEqual(nodeFs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  assert.ok(nodeFs.existsSync(lock), 'the other process lock is left alone');
});

test('a lock older than 10s is stale: removed, then rotation proceeds', () => {
  assert.strictEqual(LOCK_STALE_MS, 10000);
  const { logger, file, clock } = setup({ maxBytes: 50 });
  logger.log('info', 'e', null, `a ${LONG}`);
  const lock = `${file}.lock`;
  nodeFs.writeFileSync(lock, '999');
  nodeFs.utimesSync(lock, (clock.v - 11000) / 1000, (clock.v - 11000) / 1000);
  logger.log('info', 'e', null, 'b');
  assert.match(nodeFs.readFileSync(`${file}.1`, 'utf8'), /"message":"a /);
  assert.ok(!nodeFs.existsSync(lock));
});

test('the lock is taken with the exclusive flag', () => {
  const flags = [];
  const fs = { ...nodeFs, writeFileSync: (p, d, o) => { flags.push(o && o.flag); return nodeFs.writeFileSync(p, d, o); } };
  const { logger } = setup({ maxBytes: 50, fs });
  logger.log('info', 'e', null, LONG);
  logger.log('info', 'e', null, 'again');
  assert.ok(flags.includes('wx'));
});

test('a rotation failure still appends the entry', () => {
  const fs = { ...nodeFs, renameSync: () => { throw new Error('EPERM'); } };
  const { logger, file } = setup({ maxBytes: 50, fs });
  logger.log('info', 'e', null, LONG);
  assert.strictEqual(logger.log('info', 'e', null, 'second'), true);
  assert.strictEqual(nodeFs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  assert.ok(!nodeFs.existsSync(`${file}.lock`), 'lock released even when rotation fails');
});

// ---- redaction -------------------------------------------------------------

test('redact strips everything from AWS_SSM_START_SESSION_RESPONSE onward', () => {
  const out = redact(PLUGIN_REAL.trim());
  assert.ok(!out.includes('AWS_SSM_START_SESSION_RESPONSE'));
  assert.ok(!out.includes('StartSession'));
  assert.ok(!out.includes('i-0357e26df0d26b2ae'));
  assert.ok(!out.includes('6379'));
});

test('redact removes aws ssm start-session argument lists', () => {
  const out = redact(AWS_REAL.trim());
  assert.ok(!/start-session\s+--/.test(out));
  assert.ok(!out.includes('--target'));
  assert.ok(!out.includes('i-0357e26df0d26b2ae'));
  assert.ok(!out.includes('amazonaws.com'));
  assert.ok(!out.includes('--parameters'));
  assert.strictEqual(redact('aws ssm start-session --target i-1 --parameters host=h,portNumber=1,localPortNumber=2'), 'aws ssm start-session [redacted]');
});

test('redact removes TokenValue / StreamUrl / SessionId JSON fragments, escaped or not', () => {
  const out = redact(`Cannot perform start session: ${RESPONSE_JSON}`);
  for (const secret of [TOKEN, 'wss://', 'alice-0a1b2c3d4e5f6a7b8']) assert.ok(!out.includes(secret), secret);
  const escaped = redact(JSON.stringify(RESPONSE_JSON));
  for (const secret of [TOKEN, 'wss://', 'alice-0a1b2c3d4e5f6a7b8']) assert.ok(!escaped.includes(secret), secret);
  assert.match(out, /^Cannot perform start session:/);
});

test('redact removes AWS access keys and long base64-looking secrets but keeps normal text', () => {
  const out = redact(`key AKIAIOSFODNN7EXAMPLE and ASIAIOSFODNN7EXAMPLE token ${TOKEN} end`);
  assert.ok(!/AKIA|ASIA/.test(out));
  assert.ok(!out.includes(TOKEN.slice(0, 40)));
  assert.strictEqual(redact('An error occurred (TargetNotConnected) when calling the StartSession operation: i-0abc is not connected.'),
    'An error occurred (TargetNotConnected) when calling the StartSession operation: i-0abc is not connected.');
  assert.strictEqual(redact('/usr/local/aws-cli/some/very-long-lowercase-path-without-any-digits-or-uppercase-chars/x'),
    '/usr/local/aws-cli/some/very-long-lowercase-path-without-any-digits-or-uppercase-chars/x');
  assert.strictEqual(redact(42), 42);
  assert.strictEqual(redact(null), null);
});

test('PRIVACY: no token, command line or plugin argument ever reaches the file (message and extra)', () => {
  const { logger, file } = setup();
  logger.log('error', 'session_ended', 'db-prod', AWS_REAL, { detail: PLUGIN_REAL, nested: { r: RESPONSE_JSON }, list: [RESPONSE_JSON], pid: 4186, local: 16001 });
  logger.log('error', 'session_ended', 'db-prod', `Unable to start: ${RESPONSE_JSON}`);
  logger.log('error', 'session_ended', 'db-prod', `creds AKIAIOSFODNN7EXAMPLE ${TOKEN}`);
  const text = nodeFs.readFileSync(file, 'utf8');
  for (const forbidden of ['AWS_SSM_START_SESSION_RESPONSE', 'TokenValue', 'StreamUrl', 'wss://', TOKEN.slice(0, 30),
    'alice-0a1b2c3d4e5f6a7b8', 'start-session --', '--target', '--parameters', 'AKIAIOSFODNN7EXAMPLE']) {
    assert.ok(!text.includes(forbidden), `leaked: ${forbidden}`);
  }
  assert.strictEqual(JSON.parse(text.split('\n')[0]).pid, 4186, 'numeric extras are kept');
});

// ---- reader ----------------------------------------------------------------

function seed(dir) {
  const file = path.join(dir, 'events.log');
  const e = (t, over) => JSON.stringify({ t: new Date(T0 + t * 1000).toISOString(), source: 'app', level: 'info', tunnel: 'a', event: 'connect', message: 'm', ...over });
  nodeFs.writeFileSync(`${file}.2`, `${e(1, { message: 'oldest' })}\n`);
  nodeFs.writeFileSync(`${file}.1`, `${e(2, { level: 'warn', tunnel: 'b', event: 'reconnect_scheduled', message: 'Retry soon' })}\n${e(3, { source: 'cli', event: 'up' })}\n`);
  nodeFs.writeFileSync(file, `${e(4, { level: 'error', event: 'session_ended', message: 'Connection refused' })}\n${e(5)}\n`);
  return file;
}

test('readEntries merges rotated files and returns newest first', () => {
  const file = seed(freshDir());
  const all = readEntries({ file });
  assert.deepStrictEqual(all.map((x) => x.message), ['m', 'Connection refused', 'm', 'Retry soon', 'oldest']);
  assert.deepStrictEqual(readEntries({ file, limit: 2 }).map((x) => x.message), ['m', 'Connection refused']);
});

test('readEntries applies since, level (minimum), tunnel, source and search filters', () => {
  const file = seed(freshDir());
  assert.strictEqual(readEntries({ file, since: T0 + 4000 }).length, 2);
  assert.deepStrictEqual(readEntries({ file, level: 'warn' }).map((x) => x.level), ['error', 'warn']);
  assert.deepStrictEqual(readEntries({ file, level: 'error' }).map((x) => x.event), ['session_ended']);
  assert.deepStrictEqual(readEntries({ file, tunnel: 'b' }).map((x) => x.event), ['reconnect_scheduled']);
  assert.deepStrictEqual(readEntries({ file, source: 'cli' }).map((x) => x.event), ['up']);
  assert.deepStrictEqual(readEntries({ file, search: 'REFUSED' }).map((x) => x.event), ['session_ended']);
  assert.deepStrictEqual(readEntries({ file, search: 'reconnect_sched' }).map((x) => x.tunnel), ['b']);
  assert.deepStrictEqual(readEntries({ file, level: 'warn', tunnel: 'a' }).map((x) => x.event), ['session_ended']);
});

test('readEntries skips corrupt, non-object and partial lines and tolerates a missing file', () => {
  const dir = freshDir();
  const file = path.join(dir, 'events.log');
  const good = JSON.stringify({ t: new Date(T0).toISOString(), source: 'app', level: 'info', tunnel: null, event: 'app_start', message: 'ok' });
  nodeFs.writeFileSync(file, `garbage\n${good}\n[1,2]\n"str"\n{"t":"nope"}\n{"t":"2026-10-21T10:00:00.000Z","source":"app","lev`);
  assert.deepStrictEqual(readEntries({ file }).map((x) => x.event), ['app_start']);
  assert.deepStrictEqual(readEntries({ file: path.join(dir, 'missing.log') }), []);
});

test('tailEntries returns the last N oldest -> newest', () => {
  const file = seed(freshDir());
  assert.deepStrictEqual(tailEntries({ file, n: 3 }).map((x) => x.event), ['up', 'session_ended', 'connect']);
});

test('readEntries tolerates fs failures', () => {
  const fs = { ...nodeFs, readFileSync: () => { throw new Error('EIO'); } };
  assert.deepStrictEqual(readEntries({ file: '/x/events.log', fs }), []);
});

// ---- follow ----------------------------------------------------------------

function followHarness(steps, opts = {}) {
  const { dir, file, logger } = setup(opts);
  const got = [];
  const ac = new AbortController();
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); const s = steps.shift(); if (s) s({ file, logger, dir }); if (!steps.length) ac.abort(); };
  return { file, logger, got, waits, run: (extra = {}) => followEntries({ file, signal: ac.signal, sleep, onEntries: (es) => got.push(...es.map((x) => x.message)), ...extra }) };
}

test('followEntries polls every 500ms, delivers only new complete lines and stops on abort', async () => {
  const h = followHarness([
    ({ logger }) => logger.log('info', 'e', null, 'one'),
    () => {},
    ({ logger, file }) => { logger.log('info', 'e', null, 'two'); nodeFs.appendFileSync(file, '{"t":"2026-10-21T10:00:00.000Z","source":"app","lev'); },
  ]);
  h.logger.log('info', 'e', null, 'before');
  await h.run();
  assert.deepStrictEqual(h.got, ['one', 'two']);
  assert.ok(h.waits.every((ms) => ms === 500));
});

test('followEntries applies filters and survives rotation without losing or repeating lines', async () => {
  const h = followHarness([
    ({ logger }) => { logger.log('info', 'e', 'a', 'keep1'); logger.log('info', 'e', 'b', 'drop'); },
    ({ logger }) => { logger.log('info', 'e', 'a', `keep2 ${'x'.repeat(200)}`); },
    ({ logger }) => { logger.log('info', 'e', 'a', 'keep3'); },
  ], { maxBytes: 150 });
  await h.run({ filter: { tunnel: 'a' } });
  assert.deepStrictEqual(h.got.map((m) => m.split(' ')[0]), ['keep1', 'keep2', 'keep3']);
});

test('followEntries can start from a given byte offset (tail then follow without a gap)', async () => {
  const h = followHarness([() => {}]);
  h.logger.log('info', 'e', null, 'already');
  await h.run({ offset: 0 });
  assert.deepStrictEqual(h.got, ['already']);
  assert.strictEqual(fileSize(h.file), nodeFs.statSync(h.file).size);
  assert.strictEqual(fileSize(path.join(path.dirname(h.file), 'none')), 0);
});
