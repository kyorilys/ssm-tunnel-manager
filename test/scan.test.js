const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const {
  parsePs: parsePsRaw, parseEtime, matchSessions, runPs, scanSessions, isPortInUse, killSession,
} = require('../lib/scan');

const AWS_REAL = ' 501 4186 1 08:47 /opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python /opt/homebrew/bin/aws ssm start-session --region us-west-2 --target i-0357e26df0d26b2ae --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host=master.glacier-jobs.28i723.usw2.cache.amazonaws.com,portNumber=6379,localPortNumber=16001';
const PLUGIN_REAL = ' 501 4200 4186 08:47 session-manager-plugin AWS_SSM_START_SESSION_RESPONSE us-west-2 StartSession  {"Target": "i-0357e26df0d26b2ae", "DocumentName": "AWS-StartPortForwardingSessionToRemoteHost", "Parameters": {"host": ["master.glacier-jobs.28i723.usw2.cache.amazonaws.com"], "portNumber": ["6379"], "localPortNumber": ["16001"]}} https://ssm.us-west-2.amazonaws.com';
const DOC = 'AWS-StartPortForwardingSessionToRemoteHost';
const UID = 501;
const parsePs = (text, opts = { uid: UID }) => parsePsRaw(text, opts);

const pluginLine = (pid, ppid, region, params, doc = DOC, target = 'i-0357e26df0d26b2ae') =>
  ` 501 ${pid}  ${ppid}    00:05 session-manager-plugin AWS_SSM_START_SESSION_RESPONSE ${region} StartSession  ` +
  JSON.stringify({ Target: target, DocumentName: doc, Parameters: params }) +
  ` https://ssm.${region}.amazonaws.com`;

test('parseEtime handles mm:ss, hh:mm:ss and dd-hh:mm:ss', () => {
  assert.strictEqual(parseEtime('00:05'), 5);
  assert.strictEqual(parseEtime('08:47'), 527);
  assert.strictEqual(parseEtime('1:02:03'), 3723);
  assert.strictEqual(parseEtime('2-01:02:03'), 2 * 86400 + 3723);
  assert.strictEqual(parseEtime(' 08:47 '), 527);
});

test('parsePs groups the real aws line with its plugin child', () => {
  const s = parsePs([AWS_REAL, PLUGIN_REAL].join('\n'));
  assert.deepStrictEqual(s, [{
    pid: 4186, ppid: 1, pids: [4186, 4200], region: 'us-west-2',
    target: 'i-0357e26df0d26b2ae',
    host: 'master.glacier-jobs.28i723.usw2.cache.amazonaws.com',
    port: 6379, local: 16001, etimeSec: 527, orphan: false,
  }]);
});

test('parsePs groups regardless of line order (plugin listed before aws)', () => {
  const s = parsePs([PLUGIN_REAL, AWS_REAL].join('\n'));
  assert.strictEqual(s.length, 1);
  assert.deepStrictEqual(s[0].pids, [4186, 4200]);
});

test('parsePs accepts the official installer path as argv0', () => {
  const line = ' 501 500 1 1:02:03 /usr/local/aws-cli/aws ssm start-session --region us-east-1 --target i-0abc12345 --document-name ' + DOC + ' --parameters host=db.x,portNumber=5432,localPortNumber=15002';
  const [s] = parsePs(line);
  assert.strictEqual(s.pid, 500);
  assert.strictEqual(s.region, 'us-east-1');
  assert.strictEqual(s.port, 5432);
  assert.strictEqual(s.local, 15002);
  assert.strictEqual(s.etimeSec, 3723);
});

test('parsePs reads JSON-form --parameters and equals-form flags', () => {
  const line = ' 501 501 1 2-01:02:03 /usr/local/aws-cli/aws ssm start-session --region=eu-central-1 --target=i-0abc12345 --document-name=' + DOC + ' --parameters {"host":["db.x"],"portNumber":["5432"],"localPortNumber":["15002"]}';
  const [s] = parsePs(line);
  assert.strictEqual(s.region, 'eu-central-1');
  assert.strictEqual(s.target, 'i-0abc12345');
  assert.strictEqual(s.host, 'db.x');
  assert.strictEqual(s.port, 5432);
  assert.strictEqual(s.local, 15002);
  assert.strictEqual(s.etimeSec, 2 * 86400 + 3723);
});

test('parsePs reads JSON --parameters containing spaces', () => {
  const line = ' 501 502 1 00:05 /opt/homebrew/bin/aws ssm start-session --target i-0abc12345 --document-name ' + DOC + ' --parameters {"host": ["db.x"], "portNumber": ["5432"], "localPortNumber": ["15002"]} --region eu-central-1';
  const [s] = parsePs(line);
  assert.strictEqual(s.host, 'db.x');
  assert.strictEqual(s.local, 15002);
  assert.strictEqual(s.region, 'eu-central-1');
});

test('parsePs fills a missing region from the plugin child', () => {
  const aws = ' 501 600 1 00:05 /opt/homebrew/bin/aws ssm start-session --target i-0abc12345 --document-name ' + DOC + ' --parameters host=db.x,portNumber=5432,localPortNumber=15002';
  const plugin = pluginLine(601, 600, 'eu-west-1', { host: ['db.x'], portNumber: ['5432'], localPortNumber: ['15002'] });
  const [s] = parsePs([aws, plugin].join('\n'));
  assert.strictEqual(s.region, 'eu-west-1');
  assert.deepStrictEqual(s.pids, [600, 601]);
});

test('parsePs leaves region null when neither aws nor plugin gives one', () => {
  const aws = ' 501 600 1 00:05 /opt/homebrew/bin/aws ssm start-session --target i-0abc12345 --document-name ' + DOC + ' --parameters host=db.x,portNumber=5432,localPortNumber=15002';
  assert.strictEqual(parsePs(aws)[0].region, null);
});

test('a plugin without an aws parent is an orphan session', () => {
  const [s] = parsePs(PLUGIN_REAL);
  assert.deepStrictEqual(s, {
    pid: 4200, ppid: 4186, pids: [4200], region: 'us-west-2',
    target: 'i-0357e26df0d26b2ae',
    host: 'master.glacier-jobs.28i723.usw2.cache.amazonaws.com',
    port: 6379, local: 16001, etimeSec: 527, orphan: true,
  });
});

test('plugin JSON tolerates whitespace after the brace', () => {
  const line = ' 501 700 1 00:05 session-manager-plugin X eu-west-1 StartSession  { "Target" : "i-0abc12345", "DocumentName": "' + DOC + '", "Parameters": {"host": ["h"], "portNumber": ["22"], "localPortNumber": ["2222"]}} https://ssm.eu-west-1.amazonaws.com';
  const [s] = parsePs(line);
  assert.strictEqual(s.local, 2222);
  assert.strictEqual(s.orphan, true);
});

test('plugin JSON with braces inside strings is balanced correctly', () => {
  const line = ' 501 701 1 00:05 session-manager-plugin X eu-west-1 StartSession  {"Target": "i-0abc12345", "Note": "a } b {", "DocumentName": "' + DOC + '", "Parameters": {"host": ["h"], "portNumber": ["22"], "localPortNumber": ["2222"]}} https://x';
  assert.strictEqual(parsePs(line).length, 1);
});

test('interactive sessions and their plugin child are ignored', () => {
  const aws = ' 501 800 1 00:05 /opt/homebrew/bin/aws ssm start-session --region eu-central-1 --target i-0abc12345';
  const plugin = pluginLine(801, 800, 'eu-central-1', {}, 'SSM-SessionManagerRunShell');
  assert.deepStrictEqual(parsePs([aws, plugin].join('\n')), []);
});

test('shells, grep and wrapper scripts are ignored', () => {
  const lines = [
    ' 501 900 1 00:05 zsh -c aws ssm start-session --target i-0abc12345 --document-name ' + DOC + ' --parameters host=h,portNumber=1,localPortNumber=2',
    ' 501 901 1 00:05 grep aws ssm start-session --document-name ' + DOC + ' --parameters host=h,portNumber=1,localPortNumber=2',
    ' 501 902 1 00:05 bash /Users/x/bin/ssm-connect onyx-prod',
    ' 501 903 1 00:05 /usr/bin/python3 /opt/tool.py ssm start-session --document-name ' + DOC + ' --parameters host=h,portNumber=1,localPortNumber=2',
  ];
  assert.deepStrictEqual(parsePs(lines.join('\n')), []);
});

test('other documents and unparseable local ports are ignored', () => {
  const lines = [
    ' 501 910 1 00:05 /opt/homebrew/bin/aws ssm start-session --target i-0abc12345 --document-name AWS-StartPortForwardingSession --parameters portNumber=80,localPortNumber=8080',
    ' 501 911 1 00:05 /opt/homebrew/bin/aws ssm start-session --target i-0abc12345 --document-name ' + DOC + ' --parameters host=h,portNumber=80',
    ' 501 912 1 00:05 /opt/homebrew/bin/aws ssm start-session --target i-0abc12345 --document-name ' + DOC + ' --parameters host=h,portNumber=80,localPortNumber=abc',
    ' 501 913 1 00:05 /opt/homebrew/bin/aws ssm start-session --target i-0abc12345 --document-name ' + DOC + ' --parameters host=h,portNumber=80,localPortNumber=70000',
  ];
  assert.deepStrictEqual(parsePs(lines.join('\n')), []);
});

test('garbage, blank lines and CRLF do not throw', () => {
  const text = ['', 'not a ps line', ' 1 2', AWS_REAL + '\r', ''].join('\n');
  assert.strictEqual(parsePs(text).length, 1);
  assert.deepStrictEqual(parsePs(''), []);
});

test('output never contains the raw command line', () => {
  const out = JSON.stringify(parsePs([AWS_REAL, PLUGIN_REAL].join('\n')));
  assert.ok(!out.includes('AWS_SSM_START_SESSION_RESPONSE'));
  assert.ok(!out.includes('--parameters'));
  assert.ok(!out.includes('DocumentName'));
});

// matchSessions

const tun = (name, over = {}) => ({
  name, region: 'us-west-2', target: 'i-0357e26df0d26b2ae',
  host: 'master.glacier-jobs.28i723.usw2.cache.amazonaws.com', port: 6379, local: 16001, ...over,
});
const sess = (pid, over = {}) => ({
  pid, ppid: 1, pids: [pid], region: 'us-west-2', target: 'i-0357e26df0d26b2ae',
  host: 'master.glacier-jobs.28i723.usw2.cache.amazonaws.com', port: 6379, local: 16001,
  etimeSec: 1, orphan: false, ...over,
});

test('matchSessions matches on target/port/local, host case-insensitive', () => {
  const s = sess(1, { host: 'MASTER.GLACIER-JOBS.28i723.usw2.cache.amazonaws.com' });
  const { matched, unmatched } = matchSessions([s], [tun('redis')]);
  assert.strictEqual(matched.get('redis'), s);
  assert.deepStrictEqual(unmatched, []);
});

test('matchSessions ignores region when the session region is null', () => {
  const s = sess(1, { region: null });
  assert.strictEqual(matchSessions([s], [tun('redis', { region: 'eu-west-1' })]).matched.size, 1);
});

test('matchSessions requires region equality when the session has one', () => {
  const s = sess(1);
  const r = matchSessions([s], [tun('redis', { region: 'eu-west-1' })]);
  assert.strictEqual(r.matched.size, 0);
  assert.deepStrictEqual(r.unmatched, [s]);
});

test('matchSessions leaves non-matching sessions unmatched', () => {
  for (const over of [{ target: 'i-0other' }, { port: 1 }, { local: 1 }, { host: 'other' }]) {
    const s = sess(1, over);
    const r = matchSessions([s], [tun('redis')]);
    assert.strictEqual(r.matched.size, 0);
    assert.deepStrictEqual(r.unmatched, [s]);
  }
});

test('matchSessions excludes owned sessions by pid or ppid from both outputs', () => {
  const a = sess(10);
  const b = sess(20, { ppid: 99, local: 9999 });
  const r = matchSessions([a, b], [tun('redis')], new Set([10, 99]));
  assert.strictEqual(r.matched.size, 0);
  assert.deepStrictEqual(r.unmatched, []);
});

test('matchSessions: the second session for the same tunnel goes to unmatched', () => {
  const a = sess(1);
  const b = sess(2);
  const r = matchSessions([a, b], [tun('redis')]);
  assert.strictEqual(r.matched.get('redis'), a);
  assert.deepStrictEqual(r.unmatched, [b]);
});

// runPs / scanSessions

test('runPs calls /bin/ps with the expected args and resolves stdout', async () => {
  let seen;
  const execFile = (file, args, opts, cb) => { seen = { file, args, opts }; cb(null, 'out', ''); };
  assert.strictEqual(await runPs({ execFile }), 'out');
  assert.strictEqual(seen.file, '/bin/ps');
  assert.deepStrictEqual(seen.args, ['-axww', '-o', 'uid=,pid=,ppid=,etime=,command=']);
  assert.strictEqual(seen.opts.maxBuffer, 16 * 1024 * 1024);
});

test('runPs rejects when execFile errors', async () => {
  const execFile = (f, a, o, cb) => cb(new Error('boom'));
  await assert.rejects(runPs({ execFile }), /boom/);
});

test('scanSessions parses the output of the injected execFile', async () => {
  const execFile = (f, a, o, cb) => cb(null, [AWS_REAL, PLUGIN_REAL].join('\n'), '');
  const s = await scanSessions({ execFile });
  assert.strictEqual(s.length, 1);
  assert.deepStrictEqual(s[0].pids, [4186, 4200]);
});

test('real ps (read-only) resolves to a non-empty string', async () => {
  const out = await runPs();
  assert.strictEqual(typeof out, 'string');
  assert.ok(out.length > 0);
});

// isPortInUse

test('isPortInUse is true while a server holds the port and false after it closes', async () => {
  const server = net.createServer();
  await new Promise((res) => server.listen({ port: 0, host: '127.0.0.1' }, res));
  const { port } = server.address();
  assert.strictEqual(await isPortInUse(port), true);
  await new Promise((res) => server.close(res));
  assert.strictEqual(await isPortInUse(port), false);
});

// killSession

test('killSession signals plugin children first, then the aws pid', () => {
  const calls = [];
  const kill = (pid, sig) => { calls.push([pid, sig]); };
  const done = killSession({ pid: 10, pids: [10, 11, 12], orphan: false }, { kill });
  assert.deepStrictEqual(done, [11, 12, 10]);
  assert.deepStrictEqual(calls, [[11, 'SIGTERM'], [12, 'SIGTERM'], [10, 'SIGTERM']]);
});

test('killSession on an orphan signals only its plugin pid and honours signal', () => {
  const calls = [];
  const done = killSession({ pid: 20, pids: [20], orphan: true }, { kill: (p, s) => calls.push([p, s]), signal: 'SIGKILL' });
  assert.deepStrictEqual(done, [20]);
  assert.deepStrictEqual(calls, [[20, 'SIGKILL']]);
});

test('killSession ignores ESRCH, omits that pid, and continues', () => {
  const kill = (pid) => { if (pid === 11) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
  assert.deepStrictEqual(killSession({ pid: 10, pids: [10, 11], orphan: false }, { kill }), [10]);
});

test('killSession rethrows other errors', () => {
  const kill = () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); };
  assert.throws(() => killSession({ pid: 10, pids: [10], orphan: false }, { kill }), /nope/);
});

test('killSession never signals pids that could hit process groups', () => {
  const calls = [];
  const done = killSession({ pid: 10, pids: [10, 0, -1, 1, NaN], orphan: false }, { kill: (p) => calls.push(p) });
  assert.deepStrictEqual(done, [10]);
  assert.deepStrictEqual(calls, [10]);
});

// ---- ownership: only the current user's processes ----------------------

const asUser = (line, uid) => line.replace(/^ 501 /, ` ${uid} `);

test('parsePs drops sessions owned by another uid, before grouping', () => {
  const mine = [AWS_REAL, PLUGIN_REAL];
  const theirs = [asUser(AWS_REAL, 0), asUser(PLUGIN_REAL, 0)].map((l) => l.replace('4186', '9186').replace('4200', '9200'));
  const out = parsePs([...theirs, ...mine].join('\n'));
  assert.deepStrictEqual(out.map((s) => s.pid), [4186]);
  assert.deepStrictEqual(parsePs(theirs.join('\n')), []);
});

test('a foreign plugin child is not attached to my aws session', () => {
  const foreignPlugin = asUser(PLUGIN_REAL, 0).replace('4200', '9200');
  const [s] = parsePs([AWS_REAL, foreignPlugin].join('\n'));
  assert.deepStrictEqual(s.pids, [4186]);
});

test('parsePs drops lines whose uid is missing or not numeric', () => {
  const noUid = AWS_REAL.replace(/^ 501 /, ' ');
  const lines = [noUid, asUser(AWS_REAL, 'root'), asUser(AWS_REAL, '-1'), asUser(AWS_REAL, '50x')];
  assert.deepStrictEqual(parsePs(lines.join('\n')), []);
});

test('parsePs requires an injected uid', () => {
  assert.throws(() => parsePsRaw(AWS_REAL), TypeError);
  assert.throws(() => parsePsRaw(AWS_REAL, { uid: 'x' }), TypeError);
  assert.strictEqual(parsePsRaw(AWS_REAL, { uid: 0 }).length, 0);
});

test('a look-alike session of another uid is neither matched nor listed', () => {
  const fake = asUser(AWS_REAL, 1234);
  const sessions = parsePs(fake);
  const r = matchSessions(sessions, [tun('redis')]);
  assert.strictEqual(r.matched.size, 0);
  assert.deepStrictEqual(r.unmatched, []);
});

test('scanSessions keeps only the injected uid and asks ps for the uid column', async () => {
  const execFile = (f, a, o, cb) => cb(null, [AWS_REAL, asUser(AWS_REAL, 7).replace('4186', '4187')].join('\n'), '');
  assert.deepStrictEqual((await scanSessions({ execFile, uid: 501 })).map((s) => s.pid), [4186]);
  assert.deepStrictEqual((await scanSessions({ execFile, uid: 7 })).map((s) => s.pid), [4187]);
});

test('scanSessions defaults to the real process uid', async () => {
  const uid = process.getuid();
  const line = AWS_REAL.replace(/^ 501 /, ` ${uid} `);
  const execFile = (f, a, o, cb) => cb(null, line, '');
  assert.strictEqual((await scanSessions({ execFile })).length, 1);
});
