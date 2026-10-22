const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { checkProfile, signIn, classifyStderr, parseIdentity } = require('../lib/awsAuth');

const ARN_OUT = (arn) => JSON.stringify({ UserId: 'AIDAXXXX', Account: '123456789012', Arn: arn });
const exec = (err, stdout = '', stderr = '', calls = []) => (cmd, args, opts, cb) => { calls.push({ cmd, args, opts }); cb(err, stdout, stderr); };

test('parseIdentity extracts role or user name', () => {
  assert.strictEqual(parseIdentity('arn:aws:iam::123456789012:role/Admin'), 'Admin');
  assert.strictEqual(parseIdentity('arn:aws:sts::123456789012:assumed-role/R/session'), 'R');
  assert.strictEqual(parseIdentity('arn:aws:iam::123456789012:user/alice'), 'alice');
  assert.strictEqual(parseIdentity('arn:aws:iam::123456789012:user/path/bob'), 'bob');
  assert.strictEqual(parseIdentity('arn:aws:iam::123456789012:root'), 'root');
});

test('checkProfile ok masks the account and builds the argv', async () => {
  const calls = [];
  const r = await checkProfile('dev', { execFile: exec(null, ARN_OUT('arn:aws:sts::123456789012:assumed-role/Admin/me'), '', calls), awsBin: '/x/aws', env: { A: '1' } });
  assert.strictEqual(r.state, 'ok');
  assert.strictEqual(r.identity, 'Admin');
  assert.strictEqual(r.account, '••••9012');
  assert.ok(!JSON.stringify(r).includes('123456789012'));
  assert.deepStrictEqual(calls[0].args, ['sts', 'get-caller-identity', '--output', 'json', '--profile', 'dev']);
  assert.strictEqual(calls[0].cmd, '/x/aws');
  assert.strictEqual(calls[0].opts.timeout, 15000);
  assert.strictEqual(calls[0].opts.env.A, '1');
  const d = [];
  await checkProfile('', { execFile: exec(null, ARN_OUT('arn:aws:iam::123456789012:user/alice'), '', d) });
  assert.ok(!d[0].args.includes('--profile'), 'empty name uses the default chain');
  assert.strictEqual(d[0].cmd, 'aws');
  const dflt = [];
  await checkProfile('default', { execFile: exec(null, ARN_OUT('arn:aws:iam::123456789012:user/alice'), '', dflt) });
  assert.deepStrictEqual(dflt[0].args.slice(-2), ['--profile', 'default']);
});

const TABLE = [
  ['Error loading SSO Token: Token for https://x.awsapps.com/start does not exist', 'signed-out'],
  ['The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login', 'expired'],
  ['An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired', 'expired'],
  ['An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation', 'invalid'],
  ['An error occurred (SignatureDoesNotMatch) when calling the GetCallerIdentity operation', 'invalid'],
  ['Unable to locate credentials. You can configure credentials by running "aws configure".', 'no-credentials'],
  ['Could not connect to the endpoint URL: "https://sts.us-east-1.amazonaws.com/"', 'network'],
  ['Could not resolve host: sts.amazonaws.com getaddrinfo ENOTFOUND', 'network'],
  ['something odd happened for account 123456789012', 'error'],
];
test('checkProfile classifies stderr', async () => {
  for (const [stderr, state] of TABLE) {
    assert.strictEqual(classifyStderr(stderr), state, stderr);
    const r = await checkProfile('p', { execFile: exec(Object.assign(new Error('x'), { code: 254 }), '', stderr) });
    assert.strictEqual(r.state, state);
    assert.ok(r.message && !/\d{12}/.test(r.message) && !/https?:\/\//.test(r.message), `safe message: ${r.message}`);
  }
});

test('checkProfile handles timeout, spawn failure and unparsable output', async () => {
  const t = await checkProfile('p', { execFile: exec(Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM' })) });
  assert.strictEqual(t.state, 'network');
  const e = await checkProfile('p', { execFile: exec(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) });
  assert.strictEqual(e.state, 'error');
  assert.match(e.message, /aws/i);
  const j = await checkProfile('p', { execFile: exec(null, 'not json') });
  assert.strictEqual(j.state, 'error');
  const th = await checkProfile('p', { execFile: () => { throw new Error('sync'); } });
  assert.strictEqual(th.state, 'error');
});

function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.killed = false;
    c.kill = (sig) => { c.killed = true; c.killSignal = sig; setImmediate(() => c.emit('close', null, sig || 'SIGTERM')); return true; };
    calls.push({ cmd, args, opts, child: c });
    return c;
  };
  return { spawn, calls };
}

test('signIn reports progress and resolves ok on exit 0', async () => {
  const { spawn, calls } = fakeSpawn();
  const seen = [];
  const h = signIn('dev', { spawn, awsBin: '/x/aws', env: {}, onProgress: (s) => seen.push(s) });
  assert.deepStrictEqual(calls[0].args, ['sso', 'login', '--profile', 'dev']);
  assert.strictEqual(calls[0].cmd, '/x/aws');
  assert.notStrictEqual(calls[0].opts.shell, true);
  assert.notStrictEqual(calls[0].opts.detached, true);
  assert.deepStrictEqual(seen, ['opening']);
  calls[0].child.stdout.emit('data', Buffer.from('Attempting to automatically open the SSO authorization page in your default browser.\n'));
  calls[0].child.stdout.emit('data', Buffer.from('https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH\n'));
  assert.deepStrictEqual(seen, ['opening', 'waiting'], 'waiting emitted once');
  calls[0].child.emit('close', 0, null);
  assert.deepStrictEqual(await h.promise, { ok: true });
});

test('signIn failure returns a message without URLs carrying tokens', async () => {
  const { spawn, calls } = fakeSpawn();
  const h = signIn('dev', { spawn, env: {} });
  calls[0].child.stderr.emit('data', Buffer.from('Open https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH failed\nerror: denied\n'));
  calls[0].child.emit('close', 1, null);
  const r = await h.promise;
  assert.strictEqual(r.ok, false);
  assert.ok(r.message.includes('denied'));
  assert.ok(!r.message.includes('user_code') && !r.message.includes('ABCD'));
});

test('signIn spawn error resolves not ok', async () => {
  const { spawn, calls } = fakeSpawn();
  const h = signIn('dev', { spawn, env: {} });
  calls[0].child.emit('error', Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' }));
  const r = await h.promise;
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /aws/i);
});

test('signIn cancel kills the child and reports cancelled', async () => {
  const { spawn, calls } = fakeSpawn();
  const h = signIn('dev', { spawn, env: {} });
  h.cancel();
  const r = await h.promise;
  assert.strictEqual(calls[0].child.killed, true);
  assert.deepStrictEqual(r, { ok: false, cancelled: true, message: 'Sign-in cancelled' });
});

test('signIn times out and kills the child', async () => {
  const { spawn, calls } = fakeSpawn();
  const h = signIn('dev', { spawn, env: {}, timeoutMs: 20 });
  const r = await h.promise;
  assert.strictEqual(calls[0].child.killed, true);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /timed out/i);
});
