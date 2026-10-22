const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { registerIpc, CHANNELS } = require('../lib/ipc');

const SECTION7 = ['getState', 'connect', 'disconnect', 'reconnect', 'retry', 'setAuto', 'saveTunnel',
  'addTunnel', 'deleteTunnel', 'restoreArchived', 'dismissNotice', 'disconnectAll', 'disconnectEnv',
  'killTerminal', 'checkPort', 'updateSettings', 'importTunnels', 'copy', 'openMain', 'resizePopover',
  'logs:read', 'logs:info', 'logs:open',
  'aws:profiles', 'aws:test', 'aws:signIn', 'aws:cancelSignIn', 'aws:addSso', 'aws:addKeys', 'aws:removeProfile'];

function setup({ trusted = true, logs, shell } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const calls = [];
  const controller = new Proxy({ snapshot: () => ({ snap: true }) }, {
    get: (target, m) => (m in target ? target[m]
      : (...args) => { calls.push([m, args]); return Promise.resolve({ ok: true, via: m }); }),
  });
  const ui = {
    openMain: (o) => { calls.push(['ui.openMain', [o]]); },
    resizePopover: (h) => { calls.push(['ui.resizePopover', [h]]); },
  };
  registerIpc({ ipcMain, controller, ui, isTrustedSender: () => trusted, logs, shell });
  const call = (m, ...args) => handlers.get('ssm:' + m)({ senderFrame: {} }, ...args);
  return { handlers, calls, call, controller };
}

const TUNNEL = { name: 'a', region: 'us-west-2', target: 'i-0abc12345', host: 'h', port: 1, local: 2, desc: '', env: 'other', auto: false };

test('CHANNELS lists exactly the window.ssm commands and each is registered', () => {
  assert.deepStrictEqual([...CHANNELS].sort(), [...SECTION7].sort());
  const { handlers } = setup();
  assert.deepStrictEqual([...handlers.keys()].sort(), SECTION7.map((m) => 'ssm:' + m).sort());
});

test('preload.js mentions every CHANNELS name', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  for (const name of CHANNELS) assert.ok(text.includes(name), `preload.js is missing ${name}`);
  assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(text));
});

test('getState returns controller.snapshot()', async () => {
  const { call } = setup();
  assert.deepStrictEqual(await call('getState'), { snap: true });
});

test('valid calls are forwarded to the controller with their arguments', async () => {
  const { call, calls } = setup();
  assert.deepStrictEqual(await call('connect', 'onyx-prod'), { ok: true, via: 'connect' });
  await call('setAuto', 'x', true);
  await call('saveTunnel', TUNNEL, null);
  await call('saveTunnel', TUNNEL, 'old');
  await call('addTunnel', TUNNEL, 3);
  await call('disconnectEnv', 'production');
  await call('killTerminal', '4186');
  await call('checkPort', 8080);
  await call('updateSettings', { archiveDays: 7 });
  await call('importTunnels', { a: 1500 });
  await call('copy', 'localhost:15002');
  await call('dismissNotice');
  await call('disconnectAll');
  assert.deepStrictEqual(calls.map((c) => c[0]), ['connect', 'setAuto', 'saveTunnel', 'saveTunnel', 'addTunnel',
    'disconnectEnv', 'killTerminal', 'checkPort', 'updateSettings', 'importTunnels', 'copy', 'dismissNotice', 'disconnectAll']);
  assert.deepStrictEqual(calls[1][1], ['x', true]);
  assert.deepStrictEqual(calls[2][1], [TUNNEL, null]);
});

test('saveTunnel accepts an omitted original name for a new tunnel', async () => {
  const { call, calls } = setup();
  assert.deepStrictEqual(await call('saveTunnel', TUNNEL), { ok: true, via: 'saveTunnel' });
  assert.deepStrictEqual(calls[0], ['saveTunnel', [TUNNEL]]);
});

test('openMain and resizePopover go to the ui object', async () => {
  const { call, calls } = setup();
  assert.deepStrictEqual(await call('openMain', { view: 'archived', sheet: 'settings' }), { ok: true });
  assert.deepStrictEqual(await call('openMain'), { ok: true });
  assert.deepStrictEqual(await call('resizePopover', 300), { ok: true });
  assert.deepStrictEqual(calls, [
    ['ui.openMain', [{ view: 'archived', sheet: 'settings' }]],
    ['ui.openMain', [{}]],
    ['ui.resizePopover', [300]]]);
});

test('invalid arguments never reach the controller', async () => {
  const { call, calls } = setup();
  const bad = [
    ['connect'], ['connect', ''], ['connect', 42], ['connect', 'x'.repeat(65)],
    ['setAuto', 'a', 'yes'], ['setAuto', 'a'],
    ['saveTunnel', 'str', null], ['saveTunnel', [], null], ['saveTunnel', TUNNEL, 7], ['saveTunnel', TUNNEL, ''],
    ['addTunnel', TUNNEL, -1], ['addTunnel', TUNNEL, 1.5], ['addTunnel', null, 0],
    ['disconnectEnv', 'dev'], ['disconnectEnv'],
    ['killTerminal', '12a'], ['killTerminal', 12], ['killTerminal', ''],
    ['checkPort', 0], ['checkPort', 65536], ['checkPort', '80'], ['checkPort', 1.2],
    ['updateSettings', null], ['updateSettings', [1]],
    ['importTunnels', 'x'], ['importTunnels', [1]],
    ['copy', 5], ['copy', 'x'.repeat(10001)],
    ['deleteTunnel', ' '.repeat(0)], ['restoreArchived', {}], ['retry', null], ['reconnect', undefined], ['disconnect', 1],
    ['openMain', { view: 'trash' }], ['openMain', { sheet: 'x' }], ['openMain', 'settings'],
    ['resizePopover', 'tall'], ['resizePopover', 1.5], ['resizePopover', -5], ['resizePopover', 1e9],
  ];
  for (const [m, ...args] of bad) {
    assert.deepStrictEqual(await call(m, ...args), { ok: false, error: 'Invalid arguments' }, `${m}(${JSON.stringify(args)})`);
  }
  assert.deepStrictEqual(calls, []);
});

test('boundary values are accepted', async () => {
  const { call } = setup();
  assert.strictEqual((await call('connect', 'x'.repeat(64))).ok, true);
  assert.strictEqual((await call('checkPort', 1)).ok, true);
  assert.strictEqual((await call('checkPort', 65535)).ok, true);
  assert.strictEqual((await call('copy', 'x'.repeat(10000))).ok, true);
  assert.strictEqual((await call('copy', '')).ok, true);
});

test('untrusted senders are rejected for every channel', async () => {
  const { handlers, calls } = setup({ trusted: false });
  for (const ch of handlers.keys()) {
    assert.deepStrictEqual(await handlers.get(ch)({ senderFrame: {} }, 'a'), { ok: false, error: 'Untrusted sender' }, ch);
  }
  assert.deepStrictEqual(calls, []);
});

test('controller exceptions become {ok:false,error}', async () => {
  const handlers = new Map();
  const controller = { snapshot() { throw new Error('snap broke'); }, connect() { return Promise.reject(new Error('nope')); } };
  registerIpc({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, controller, ui: {}, isTrustedSender: () => true });
  assert.deepStrictEqual(await handlers.get('ssm:connect')({}, 'a'), { ok: false, error: 'nope' });
  assert.deepStrictEqual(await handlers.get('ssm:getState')({}), { ok: false, error: 'snap broke' });
});

// ---- logs channels ---------------------------------------------------------------

function logSetup({ exists = true, size = 1234 } = {}) {
  const read = [];
  const opened = [];
  const logs = {
    file: '/tmp/x/events.log', maxBytes: 1048576, keep: 5,
    readEntries: (opts) => { read.push(opts); return [{ event: 'connect' }]; },
    fs: { statSync: () => { if (!exists) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return { size }; },
      existsSync: () => exists },
  };
  const shell = {
    showItemInFolder: (p) => opened.push(['show', p]),
    openPath: async (p) => { opened.push(['open', p]); return ''; },
  };
  return { ...setup({ logs, shell }), read, opened };
}

test('logs:read forwards validated filters to the reader and returns entries', async () => {
  const { call, read } = logSetup();
  assert.deepStrictEqual(await call('logs:read'), { ok: true, entries: [{ event: 'connect' }] });
  const f = { since: 1700000000000, level: 'warn', tunnel: 'db', source: 'cli', search: 'refused', limit: 50 };
  assert.deepStrictEqual(await call('logs:read', f), { ok: true, entries: [{ event: 'connect' }] });
  assert.deepStrictEqual(read.at(-1), { file: '/tmp/x/events.log', ...f });
});

test('logs:read caps limit at 2000 and rejects bad filters without reading', async () => {
  const { call, read } = logSetup();
  await call('logs:read', { limit: 99999 });
  assert.strictEqual(read.at(-1).limit, 2000);
  read.length = 0;
  const bad = [{ limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: '5' }, { since: -1 }, { since: 'yesterday' }, { since: 1.5 },
    { level: 'debug' }, { level: 3 }, { tunnel: '' }, { tunnel: 'x'.repeat(65) }, { tunnel: 5 }, { source: 'web' },
    { search: 5 }, { search: 'x'.repeat(201) }, { file: '/etc/passwd' }, { extra: 1 }, 'str', [1], null, 5];
  for (const f of bad) {
    assert.deepStrictEqual(await call('logs:read', f), { ok: false, error: 'Invalid arguments' }, JSON.stringify(f));
  }
  assert.deepStrictEqual(await call('logs:read', {}, {}), { ok: false, error: 'Invalid arguments' });
  assert.deepStrictEqual(read, []);
});

test('a client cannot choose the file: logs:read always uses the configured path', async () => {
  const { call, read } = logSetup();
  await call('logs:read', { search: '../../etc/passwd' });
  assert.strictEqual(read[0].file, '/tmp/x/events.log');
});

test('logs:info reports path, size and rotation settings; a missing file has size 0', async () => {
  assert.deepStrictEqual(await logSetup({ size: 4096 }).call('logs:info'),
    { ok: true, path: '/tmp/x/events.log', size: 4096, maxBytes: 1048576, keep: 5 });
  assert.strictEqual((await logSetup({ exists: false }).call('logs:info')).size, 0);
  assert.deepStrictEqual(await logSetup().call('logs:info', 'x'), { ok: false, error: 'Invalid arguments' });
});

test('logs:open reveals the file in Finder through the injected shell; a missing file opens its folder', async () => {
  const a = logSetup();
  assert.deepStrictEqual(await a.call('logs:open'), { ok: true });
  assert.deepStrictEqual(a.opened, [['show', '/tmp/x/events.log']]);
  const b = logSetup({ exists: false });
  assert.deepStrictEqual(await b.call('logs:open'), { ok: true });
  assert.deepStrictEqual(b.opened, [['open', '/tmp/x']]);
  assert.deepStrictEqual(await a.call('logs:open', '/etc'), { ok: false, error: 'Invalid arguments' });
});

test('logs channels without a configured log report unavailable instead of throwing', async () => {
  const { call } = setup();
  assert.deepStrictEqual(await call('logs:read'), { ok: false, error: 'Logs unavailable' });
  assert.deepStrictEqual(await call('logs:info'), { ok: false, error: 'Logs unavailable' });
  assert.deepStrictEqual(await call('logs:open'), { ok: false, error: 'Logs unavailable' });
});

test('logs channels: reader or shell failures become {ok:false,error}', async () => {
  const logs = { file: '/f', maxBytes: 1, keep: 1, readEntries: () => { throw new Error('read broke'); }, fs: { statSync: () => ({ size: 1 }), existsSync: () => true } };
  const shell = { showItemInFolder: () => { throw new Error('no finder'); }, openPath: async () => '' };
  const { call } = setup({ logs, shell });
  assert.deepStrictEqual(await call('logs:read'), { ok: false, error: 'read broke' });
  assert.deepStrictEqual(await call('logs:open'), { ok: false, error: 'no finder' });
});

test('logs channels never reach the controller', async () => {
  const { call, calls } = logSetup();
  await call('logs:read'); await call('logs:info'); await call('logs:open');
  assert.deepStrictEqual(calls, []);
});

// ---- aws channels ------------------------------------------------------------------

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const SSO = { name: 'dev', startUrl: 'https://acme.awsapps.com/start', ssoRegion: 'us-east-1', accountId: '123456789012', roleName: 'Admin', region: 'us-west-2' };
const KEYS = { name: 'ci', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: SECRET, region: 'us-east-1' };

test('aws channels forward valid calls to the controller methods', async () => {
  const { call, calls } = setup();
  await call('aws:profiles');
  await call('aws:test', 'dev');
  await call('aws:signIn', 'default');
  await call('aws:cancelSignIn', 'dev');
  await call('aws:addSso', SSO);
  await call('aws:addKeys', KEYS);
  await call('aws:removeProfile', 'dev');
  await call('aws:removeProfile', 'dev', { force: true });
  assert.deepStrictEqual(calls.map((c) => c[0]), ['awsProfiles', 'awsTest', 'awsSignIn', 'awsCancelSignIn',
    'awsAddSso', 'awsAddKeys', 'awsRemoveProfile', 'awsRemoveProfile']);
  assert.deepStrictEqual(calls[4][1], [SSO]);
  assert.deepStrictEqual(calls[7][1], ['dev', { force: true }]);
});

test('aws channels reject bad arguments and never leak the secret', async () => {
  const { call, calls } = setup();
  const bad = [
    ['aws:profiles', 'x'], ['aws:test'], ['aws:test', ''], ['aws:test', 5], ['aws:test', 'has space'], ['aws:test', 'x'.repeat(65)],
    ['aws:signIn', '--profile'], ['aws:signIn', 'a b'], ['aws:cancelSignIn', null],
    ['aws:addSso', null], ['aws:addSso', []], ['aws:addSso', 'x'], ['aws:addSso', { ...SSO, extra: 1 }],
    ['aws:addSso', { ...SSO, name: 5 }], ['aws:addSso', { ...SSO, startUrl: undefined }], ['aws:addSso', { ...SSO, region: 5 }],
    ['aws:addKeys', { ...KEYS, extra: SECRET }], ['aws:addKeys', { ...KEYS, secretAccessKey: 5 }],
    ['aws:addKeys', { ...KEYS, secretAccessKey: SECRET.repeat(10) }], ['aws:addKeys', { name: 'ci', accessKeyId: 'x' }],
    ['aws:addKeys', { ...KEYS, accessKeyId: undefined }], ['aws:addKeys', KEYS, 'x'],
    ['aws:removeProfile'], ['aws:removeProfile', 'dev', { force: 'yes' }], ['aws:removeProfile', 'dev', { force: true, x: 1 }],
    ['aws:removeProfile', 'dev', true], ['aws:removeProfile', 'dev', {}, 1],
  ];
  for (const [m, ...args] of bad) {
    const r = await call(m, ...args);
    assert.deepStrictEqual(r, { ok: false, error: 'Invalid arguments' }, `${m}(${JSON.stringify(args)})`);
    assert.ok(!JSON.stringify(r).includes(SECRET));
  }
  assert.deepStrictEqual(calls, []);
});

test('aws add channels accept an optional { replace } so an existing profile can be edited', async () => {
  const { call, calls } = setup();
  await call('aws:addSso', SSO, { replace: true });
  await call('aws:addKeys', KEYS, { replace: false });
  assert.deepStrictEqual(calls.map((c) => c[1]), [[SSO, { replace: true }], [KEYS, { replace: false }]]);
  for (const opts of [{ replace: 'yes' }, { replace: true, x: 1 }, true, 'replace']) {
    assert.deepStrictEqual(await call('aws:addSso', SSO, opts), { ok: false, error: 'Invalid arguments' }, JSON.stringify(opts));
    assert.deepStrictEqual(await call('aws:addKeys', KEYS, opts), { ok: false, error: 'Invalid arguments' }, JSON.stringify(opts));
  }
  assert.strictEqual(calls.length, 2);
});

test('aws channels never echo controller errors (they may carry payload text)', async () => {
  const handlers = new Map();
  const controller = { awsAddKeys() { throw new Error(`boom ${SECRET}`); } };
  registerIpc({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, controller, ui: {}, isTrustedSender: () => true });
  const r = await handlers.get('ssm:aws:addKeys')({}, KEYS);
  assert.strictEqual(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(SECRET));
});
