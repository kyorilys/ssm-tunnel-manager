const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseIni, serialize, upsertSection, removeSection,
  listProfiles, validateSsoProfile, validateKeysProfile,
  addSsoProfile, addKeysProfile, removeProfile,
} = require('../lib/awsProfiles');

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const TOKEN = 'FwoGZXIvYXdzEXAMPLETOKENVALUE';

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'awsprof-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const mode = (p) => fs.statSync(p).mode & 0o777;
function seed(home, { config, credentials }) {
  fs.mkdirSync(path.join(home, '.aws'), { recursive: true, mode: 0o700 });
  if (config !== undefined) fs.writeFileSync(path.join(home, '.aws', 'config'), config);
  if (credentials !== undefined) fs.writeFileSync(path.join(home, '.aws', 'credentials'), credentials, { mode: 0o600 });
}
const fakeExec = (calls, fail) => (cmd, args, opts, cb) => {
  calls.push({ cmd, args, opts });
  if (fail) cb(Object.assign(new Error('boom'), { code: 1 }), '', 'bad'); else cb(null, '', '');
};
const clock = (start) => { let t = start; return () => new Date(t++ * 1000); };
const T0 = Date.UTC(2026, 9, 22, 10, 0, 0) / 1000;

test('parseIni/serialize round-trips comments, order, unknown keys and CRLF', () => {
  const samples = [
    '# top\n[default]\nregion = us-east-1\n; note\nfoo=bar\n\n[profile a]\n  x  =  y  \ns3 =\n  max = 10\n',
    '[default]\r\nregion=eu-west-1\r\n# c\r\n\r\n[profile b]\r\nk = v\r\n',
    '', '\n', '[x]', 'orphan = 1\n[x]\n',
  ];
  for (const s of samples) assert.strictEqual(serialize(parseIni(s)), s);
  const doc = parseIni(samples[0]);
  assert.deepStrictEqual(doc.sections.map((s) => s.name), [null, 'default', 'profile a']);
  assert.strictEqual(doc.sections[1].values.region, 'us-east-1');
  assert.strictEqual(doc.sections[1].values.foo, 'bar');
  assert.strictEqual(doc.sections[2].values.x, 'y');
  assert.ok(!('max' in doc.sections[2].values), 'nested block is not a top-level key');
});

test('upsertSection keeps unrelated content and line endings', () => {
  const text = '# keep me\r\n[default]\r\nregion = us-east-1\r\n# trailing\r\n\r\n[profile b]\r\nk = v\r\n';
  const doc = parseIni(text);
  upsertSection(doc, 'profile b', { k: 'w', extra: '1' });
  upsertSection(doc, 'profile c', { a: 'b' });
  assert.strictEqual(serialize(doc),
    '# keep me\r\n[default]\r\nregion = us-east-1\r\n# trailing\r\n\r\n[profile b]\r\nk = w\r\nextra = 1\r\n\r\n[profile c]\r\na = b\r\n');
  const empty = parseIni('');
  upsertSection(empty, 'x', { a: '1' });
  assert.strictEqual(serialize(empty), '[x]\na = 1\n');
});

test('removeSection removes only the target (with its leading comment)', () => {
  const text = '[a]\nk=1\n\n# about b\n[b]\nk=2\n\n[c]\nk=3\n';
  const doc = parseIni(text);
  assert.strictEqual(removeSection(doc, 'b'), true);
  assert.strictEqual(serialize(doc), '[a]\nk=1\n\n[c]\nk=3\n', 'comment directly above a header goes with it');
  assert.strictEqual(removeSection(doc, 'nope'), false);
  const last = parseIni('[a]\nk=1\n\n[b]\nk=2\n');
  removeSection(last, 'b');
  assert.strictEqual(serialize(last), '[a]\nk=1\n');
});

const CONFIG = [
  '[default]', 'region = us-west-2', '',
  '[profile legacy]', 'sso_start_url = https://legacy.awsapps.com/start', 'sso_region = us-east-1',
  'sso_account_id = 111122223333', 'sso_role_name = Admin', 'region = us-east-1', '',
  '[profile modern]', 'sso_session = corp', 'sso_account_id = 444455556666', 'sso_role_name = Dev', '',
  '[sso-session corp]', 'sso_start_url = https://corp.awsapps.com/start', 'sso_region = eu-west-1', '',
  '[profile keysonly]', 'region = eu-central-1', '',
].join('\n');
const CREDS = [
  '[default]', `aws_access_key_id = ${KEY_ID}`, `aws_secret_access_key = ${SECRET}`, `aws_session_token = ${TOKEN}`, '',
  '[keysonly]', `aws_access_key_id = ${KEY_ID}`, `aws_secret_access_key = ${SECRET}`, '',
  '[credsonly]', `aws_access_key_id = ${KEY_ID}`, `aws_secret_access_key = ${SECRET}`, '',
].join('\n');

test('listProfiles covers keys, legacy SSO, sso-session, credentials-only and never leaks secrets', () => {
  const home = tmpHome();
  try {
    seed(home, { config: CONFIG, credentials: CREDS });
    const res = listProfiles({ home, fs, env: { AWS_ACCESS_KEY_ID: KEY_ID } });
    const by = Object.fromEntries(res.profiles.map((p) => [p.name, p]));
    assert.strictEqual(res.envCredentials, true);
    assert.deepStrictEqual(by.default, {
      name: 'default', type: 'keys', region: 'us-west-2', ssoStartUrl: null, ssoRegion: null, ssoSession: null,
      accountId: null, roleName: null, hasKeys: true, sources: ['config', 'credentials'],
    });
    assert.strictEqual(by.legacy.type, 'sso');
    assert.strictEqual(by.legacy.ssoStartUrl, 'https://legacy.awsapps.com/start');
    assert.strictEqual(by.legacy.accountId, '111122223333');
    assert.strictEqual(by.legacy.roleName, 'Admin');
    assert.strictEqual(by.legacy.hasKeys, false);
    assert.strictEqual(by.modern.type, 'sso');
    assert.strictEqual(by.modern.ssoSession, 'corp');
    assert.strictEqual(by.modern.ssoStartUrl, 'https://corp.awsapps.com/start');
    assert.strictEqual(by.modern.ssoRegion, 'eu-west-1');
    assert.strictEqual(by.keysonly.type, 'keys');
    assert.deepStrictEqual(by.credsonly.sources, ['credentials']);
    assert.strictEqual(by.credsonly.type, 'keys');
    assert.ok(!res.profiles.some((p) => p.name === 'corp'), 'sso-session is not a profile');
    const json = JSON.stringify(res);
    for (const s of [SECRET, TOKEN, KEY_ID]) assert.ok(!json.includes(s), 'no secret in output');
    assert.strictEqual(listProfiles({ home, fs, env: {} }).envCredentials, false);
  } finally { rm(home); }
});

test('listProfiles with no ~/.aws returns empty and other-type profiles', () => {
  const home = tmpHome();
  try {
    assert.deepStrictEqual(listProfiles({ home, fs, env: {} }), { profiles: [], envCredentials: false });
    seed(home, { config: '[profile role]\nrole_arn = arn:aws:iam::1:role/x\n' });
    assert.strictEqual(listProfiles({ home, fs, env: {} }).profiles[0].type, 'other');
  } finally { rm(home); }
});

const sso = { name: 'dev', startUrl: 'https://corp.awsapps.com/start', ssoRegion: 'us-east-1', accountId: '123456789012', roleName: 'Admin', region: 'eu-west-1' };
const keys = { name: 'ci', accessKeyId: KEY_ID, secretAccessKey: SECRET, region: 'us-east-1' };

test('validateSsoProfile accepts good input and rejects each bad field', () => {
  assert.deepStrictEqual(validateSsoProfile(sso), []);
  assert.deepStrictEqual(validateSsoProfile({ ...sso, name: 'default' }), []);
  const bad = (patch, opts) => validateSsoProfile({ ...sso, ...patch }, opts);
  assert.ok(bad({ name: 'a b' }).length);
  assert.ok(bad({ name: '-x' }).length);
  assert.ok(bad({ name: 'x'.repeat(65) }).length);
  assert.ok(bad({ startUrl: 'http://corp.awsapps.com/start' }).length);
  assert.ok(bad({ ssoRegion: 'mars' }).length);
  assert.ok(bad({ region: 'US_EAST' }).length);
  assert.ok(bad({ accountId: '12345' }).length);
  assert.ok(bad({ roleName: 'a b' }).length);
  assert.ok(bad({ name: 'dev' }, { existing: ['dev'] }).length, 'refuses to overwrite');
  assert.deepStrictEqual(bad({ name: 'dev' }, { existing: ['dev'], replace: true }), []);
});

test('validateKeysProfile rejects bad keys and never echoes the secret', () => {
  assert.deepStrictEqual(validateKeysProfile(keys), []);
  assert.ok(validateKeysProfile({ ...keys, accessKeyId: 'AKIAshort' }).length);
  assert.ok(validateKeysProfile({ ...keys, accessKeyId: 'XXXXIOSFODNN7EXAMPLE' }).length);
  const badSecret = `${SECRET}!!`;
  const errs = validateKeysProfile({ ...keys, name: 'bad name', secretAccessKey: badSecret, accessKeyId: 'nope' });
  assert.ok(errs.length >= 3);
  const text = JSON.stringify(errs);
  assert.ok(!text.includes(SECRET) && !text.includes(badSecret) && !text.includes('wJalr'));
  assert.ok(validateKeysProfile({ ...keys, name: 'ci' }, { existing: ['ci'] }).length);
});

test('addKeysProfile writes credentials 0600 atomically, makes ~/.aws 0700, no secret in argv', async () => {
  const home = tmpHome();
  try {
    const log = [];
    const rec = {
      ...fs,
      openSync: (p, f, m) => { log.push(['open', p, m]); return fs.openSync(p, f, m); },
      renameSync: (a, b) => { log.push(['rename', a, b]); return fs.renameSync(a, b); },
    };
    const calls = [];
    await addKeysProfile(keys, { home, fs: rec, execFile: fakeExec(calls), env: {}, now: clock(T0) });
    const creds = path.join(home, '.aws', 'credentials');
    assert.strictEqual(mode(path.join(home, '.aws')), 0o700);
    assert.strictEqual(mode(creds), 0o600);
    const text = fs.readFileSync(creds, 'utf8');
    assert.ok(text.includes('[ci]') && text.includes(`aws_secret_access_key = ${SECRET}`));
    const ren = log.find((l) => l[0] === 'rename');
    assert.ok(ren && ren[2] === creds && ren[1] !== creds && path.dirname(ren[1]) === path.dirname(creds));
    assert.ok(log.some((l) => l[0] === 'open' && l[1] === ren[1] && l[2] === 0o600));
    assert.deepStrictEqual(fs.readdirSync(path.join(home, '.aws')), ['credentials'], 'no temp left');
    assert.deepStrictEqual(calls.map((c) => c.args), [['configure', 'set', 'region', 'us-east-1', '--profile', 'ci']]);
    for (const c of calls) assert.ok(!JSON.stringify(c).includes(SECRET) && !JSON.stringify(c).includes(KEY_ID));
  } finally { rm(home); }
});

test('addKeysProfile backs up first, keeps other sections, refuses overwrite without replace', async () => {
  const home = tmpHome();
  try {
    seed(home, { credentials: '# mine\n[old]\naws_access_key_id = AKIAOLDOLDOLDOLDOLD1\n' });
    const deps = { home, fs, execFile: fakeExec([]), env: {}, now: clock(T0) };
    await addKeysProfile({ ...keys, region: undefined }, deps);
    const dir = path.join(home, '.aws');
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('credentials.ssm-tunnels-backup-'));
    assert.strictEqual(backups.length, 1);
    assert.match(backups[0], /^credentials\.ssm-tunnels-backup-\d{8}-\d{6}$/);
    assert.strictEqual(mode(path.join(dir, backups[0])), 0o600);
    assert.strictEqual(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '# mine\n[old]\naws_access_key_id = AKIAOLDOLDOLDOLDOLD1\n');
    const now = fs.readFileSync(path.join(dir, 'credentials'), 'utf8');
    assert.ok(now.startsWith('# mine\n[old]\n') && now.includes('[ci]'));
    await assert.rejects(() => addKeysProfile(keys, deps), (e) => !e.message.includes(SECRET) && /exist/i.test(e.message));
    await addKeysProfile({ ...keys, region: undefined }, { ...deps, replace: true });
    assert.strictEqual((fs.readFileSync(path.join(dir, 'credentials'), 'utf8').match(/\[ci\]/g) || []).length, 1);
  } finally { rm(home); }
});

test('backups are pruned to the newest 5 per file', async () => {
  const home = tmpHome();
  try {
    seed(home, { credentials: '[a]\naws_access_key_id = AKIAOLDOLDOLDOLDOLD1\n' });
    const dir = path.join(home, '.aws');
    for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(dir, `credentials.ssm-tunnels-backup-20200101-00000${i}`), 'x');
    fs.writeFileSync(path.join(dir, 'config.ssm-tunnels-backup-20200101-000001'), 'x');
    await addKeysProfile({ ...keys, region: undefined }, { home, fs, execFile: fakeExec([]), env: {}, now: clock(T0) });
    const left = fs.readdirSync(dir).filter((f) => f.startsWith('credentials.ssm-tunnels-backup-')).sort();
    assert.strictEqual(left.length, 5);
    assert.ok(!left.includes('credentials.ssm-tunnels-backup-20200101-000001'));
    assert.ok(left.some((f) => f.startsWith('credentials.ssm-tunnels-backup-2026')), 'newest kept');
    assert.ok(fs.existsSync(path.join(dir, 'config.ssm-tunnels-backup-20200101-000001')), 'other file untouched');
  } finally { rm(home); }
});

test('addSsoProfile issues configure set calls via argv array and backs up config', async () => {
  const home = tmpHome();
  try {
    seed(home, { config: '[default]\nregion = us-east-1\n' });
    const calls = [];
    await addSsoProfile(sso, { home, fs, execFile: fakeExec(calls), awsBin: '/x/aws', env: { PATH: '/bin' }, now: clock(T0) });
    assert.deepStrictEqual(calls.map((c) => [c.cmd, ...c.args]), [
      ['sso_start_url', 'https://corp.awsapps.com/start'], ['sso_region', 'us-east-1'], ['sso_account_id', '123456789012'],
      ['sso_role_name', 'Admin'], ['region', 'eu-west-1'], ['output', 'json'],
    ].map(([k, v]) => ['/x/aws', 'configure', 'set', k, v, '--profile', 'dev']));
    assert.strictEqual(calls[0].opts.env.PATH, '/bin');
    assert.strictEqual(fs.readdirSync(path.join(home, '.aws')).filter((f) => f.startsWith('config.ssm-tunnels-backup-')).length, 1);
    await assert.rejects(() => addSsoProfile({ ...sso, startUrl: 'http://x' }, { home, fs, execFile: fakeExec([]), env: {}, now: clock(T0) }), /https/);
    seed(home, { config: '[profile dev]\nregion=us-east-1\n' });
    await assert.rejects(() => addSsoProfile(sso, { home, fs, execFile: fakeExec([]), env: {}, now: clock(T0) }), /exist/i);
    await assert.rejects(() => addSsoProfile({ ...sso }, { home, fs, execFile: fakeExec([], true), env: {}, now: clock(T0), replace: true }), /configure/);
  } finally { rm(home); }
});

test('removeProfile removes from both files, keeps unrelated content and shared sso-session', async () => {
  const home = tmpHome();
  try {
    const config = '# header\n[default]\nregion = us-west-2\n\n[profile a]\nsso_session = corp\n\n[profile b]\nsso_session = corp\n\n[sso-session corp]\nsso_start_url = https://c.awsapps.com/start\n\n# tail\n[profile z]\nregion = x\n';
    const creds = `# my keys\n\n[a]\naws_access_key_id = ${KEY_ID}\naws_secret_access_key = ${SECRET}\n\n[z]\naws_access_key_id = ${KEY_ID}\n`;
    seed(home, { config, credentials: creds });
    const dir = path.join(home, '.aws');
    const deps = { home, fs, env: {}, now: clock(T0) };
    const r = await removeProfile('a', deps);
    assert.strictEqual(r.removed, true);
    const c1 = fs.readFileSync(path.join(dir, 'config'), 'utf8');
    assert.ok(!c1.includes('[profile a]') && c1.includes('[sso-session corp]') && c1.includes('# header') && c1.includes('# tail'));
    const k1 = fs.readFileSync(path.join(dir, 'credentials'), 'utf8');
    assert.ok(!k1.includes('[a]') && !k1.includes(SECRET) && k1.includes('# my keys') && k1.includes('[z]'));
    assert.strictEqual(mode(path.join(dir, 'credentials')), 0o600);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('credentials.ssm-tunnels-backup-')));
    await removeProfile('b', deps);
    assert.ok(!fs.readFileSync(path.join(dir, 'config'), 'utf8').includes('sso-session corp'), 'unused session removed');
    assert.deepStrictEqual(await removeProfile('ghost', deps), { removed: false });
    assert.ok(fs.readFileSync(path.join(dir, 'config'), 'utf8').includes('[default]'));
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
  } finally { rm(home); }
});
