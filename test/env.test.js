const test = require('node:test');
const assert = require('node:assert');
const {
  AWS_CANDIDATES, resolveAwsBin, buildEnv, spawnDetached, killGroup,
  parseAwsVersion, parsePluginVersion, readToolVersions, displayPath, findOnPath, fileStderrSink,
} = require('../lib/env');

test('#8 fileStderrSink gives the child a file descriptor and reads back the tail', () => {
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssm-sink-'));
  try {
    const make = fileStderrSink({ dir: `${dir}/sessions`, fs });
    const s = make('a/b');
    assert.ok(Number.isInteger(s.fd));
    fs.writeSync(s.fd, `${'x'.repeat(3000)}\nlast line\n`);
    s.release();
    assert.ok(s.read().endsWith('last line\n'));
    assert.ok(s.read().length <= 1000, 'only the tail is read');
    assert.deepStrictEqual(fs.readdirSync(`${dir}/sessions`), ['a_b.stderr'], 'name is made file-safe');
    const again = make('a/b'); // a new session truncates the old output
    again.release();
    assert.strictEqual(again.read(), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#8 fileStderrSink read never throws when the file is gone', () => {
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ssm-sink-'));
  const s = fileStderrSink({ dir, fs })('x');
  s.release();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(s.read(), '');
});

test('findOnPath returns the first PATH entry holding the file, else null', () => {
  const has = new Set(['/b/ssm-connect', '/c/ssm-connect']);
  assert.strictEqual(findOnPath('ssm-connect', '/a::/b:/c', (p) => has.has(p)), '/b/ssm-connect');
  assert.strictEqual(findOnPath('ssm-connect', '/a:/b', () => false), null);
  assert.strictEqual(findOnPath('ssm-connect', undefined, () => true), null);
});

test('resolveAwsBin picks the first existing candidate, else bare aws', () => {
  assert.deepStrictEqual(AWS_CANDIDATES, ['/opt/homebrew/bin/aws', '/usr/local/bin/aws']);
  assert.strictEqual(resolveAwsBin(() => true), '/opt/homebrew/bin/aws');
  assert.strictEqual(resolveAwsBin((p) => p === '/usr/local/bin/aws'), '/usr/local/bin/aws');
  assert.strictEqual(resolveAwsBin(() => false), 'aws');
});

test('buildEnv prepends the Homebrew/system PATH and dedupes existing entries in order', () => {
  const env = buildEnv({ HOME: '/h', PATH: '/usr/bin:/custom/bin:/opt/homebrew/bin:/another' });
  assert.strictEqual(env.PATH,
    '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/custom/bin:/another');
  assert.strictEqual(env.HOME, '/h');
});

test('buildEnv works without a PATH and does not mutate its input', () => {
  const input = { A: '1' };
  const env = buildEnv(input);
  assert.strictEqual(env.PATH, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.deepStrictEqual(input, { A: '1' });
  assert.strictEqual(buildEnv({ PATH: '' }).PATH, env.PATH);
});

test('spawnDetached forces detached:true and keeps other options', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push([cmd, args, opts]); return 'proc'; };
  const out = spawnDetached(spawn)('aws', ['x'], { env: { A: 1 }, detached: false });
  assert.strictEqual(out, 'proc');
  assert.deepStrictEqual(calls[0], ['aws', ['x'], { env: { A: 1 }, detached: true }]);
});

test('killGroup signals the negative pid (process group)', () => {
  const sent = [];
  killGroup((pid, sig) => sent.push([pid, sig]))({ pid: 321, kill() { throw new Error('no'); } }, 'SIGTERM');
  assert.deepStrictEqual(sent, [[-321, 'SIGTERM']]);
});

test('killGroup ignores ESRCH and falls back to proc.kill on other errors', () => {
  const fallback = [];
  const proc = { pid: 5, kill: (s) => fallback.push(s) };
  killGroup(() => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); })(proc, 'SIGKILL');
  assert.deepStrictEqual(fallback, []);
  killGroup(() => { throw Object.assign(new Error('x'), { code: 'EPERM' }); })(proc, 'SIGKILL');
  assert.deepStrictEqual(fallback, ['SIGKILL']);
});

test('version parsers', () => {
  assert.strictEqual(parseAwsVersion('aws-cli/2.37.5 Python/3.14.7 Darwin/25.0.0 source/arm64'), '2.37.5');
  assert.strictEqual(parseAwsVersion('garbage'), null);
  assert.strictEqual(parsePluginVersion('1.2.553.0\n'), '1.2.553.0');
  assert.strictEqual(parsePluginVersion(''), null);
});

test('readToolVersions runs both tools with a 5s timeout and the given env', async () => {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    if (cmd === '/opt/homebrew/bin/aws') cb(null, 'aws-cli/2.37.5 Python/3.14.7 Darwin/25.0.0 source/arm64\n', '');
    else cb(null, '1.2.553.0\n', '');
  };
  const env = { PATH: '/x' };
  const out = await readToolVersions({ execFile, awsBin: '/opt/homebrew/bin/aws', env });
  assert.deepStrictEqual(out, { aws: '2.37.5', plugin: '1.2.553.0', awsPath: '/opt/homebrew/bin/aws' });
  assert.deepStrictEqual(calls.map((c) => [c.cmd, c.args]), [
    ['/opt/homebrew/bin/aws', ['--version']], ['session-manager-plugin', ['--version']]]);
  assert.ok(calls.every((c) => c.opts.timeout === 5000 && c.opts.env === env));
});

test('readToolVersions maps a failure to null for that tool only', async () => {
  const execFile = (cmd, args, opts, cb) => {
    if (cmd === 'session-manager-plugin') cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    else cb(null, 'aws-cli/2.1.0 Python/3 x', '');
  };
  assert.deepStrictEqual(await readToolVersions({ execFile, awsBin: 'aws', env: {} }),
    { aws: '2.1.0', plugin: null, awsPath: 'aws' });
  const allFail = (c, a, o, cb) => cb(new Error('boom'));
  assert.deepStrictEqual(await readToolVersions({ execFile: allFail, awsBin: 'aws', env: {} }),
    { aws: null, plugin: null, awsPath: 'aws' });
});

test('displayPath replaces a leading home directory with ~', () => {
  assert.strictEqual(displayPath('/Users/a/Library/x.json', '/Users/a'), '~/Library/x.json');
  assert.strictEqual(displayPath('/Users/a', '/Users/a'), '~');
  assert.strictEqual(displayPath('/Users/ab/x', '/Users/a'), '/Users/ab/x');
  assert.strictEqual(displayPath('/opt/x', '/Users/a'), '/opt/x');
});
