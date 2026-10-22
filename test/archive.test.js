const test = require('node:test');
const assert = require('node:assert');
const { tick, purge, failingDays, DAY, CREDENTIAL_ERROR } = require('../lib/archive');

const tn = (name, over = {}) => ({ name, archived: false, failingMs: 0, ...over });
const states = (o) => (n) => ({ state: o[n] || 'idle' });

test('a failing tunnel accumulates time while others stay healthy', () => {
  const ts = [tn('a'), tn('b')];
  tick(ts, states({ a: 'failed', b: 'active' }), DAY, 7);
  assert.strictEqual(ts[0].failingMs, DAY);
  assert.strictEqual(failingDays(ts[0]), 1);
});

test('archives after 7 continuous days of failure', () => {
  const ts = [tn('a', { failingMs: 6 * DAY }), tn('b')];
  const archived = tick(ts, states({ a: 'reconnecting', b: 'active' }), DAY, 7);
  assert.deepStrictEqual(archived, ['a']);
  assert.strictEqual(ts[0].archived, true);
});

test('a healthy connection resets the clock', () => {
  const ts = [tn('a', { failingMs: 5 * DAY })];
  tick(ts, states({ a: 'active' }), 1000, 7);
  assert.strictEqual(ts[0].failingMs, 0);
});

test('time when every tunnel is failing does not count (expired login / no network)', () => {
  const ts = [tn('a'), tn('b')];
  tick(ts, states({ a: 'failed', b: 'reconnecting' }), 3 * DAY, 7);
  assert.strictEqual(ts[0].failingMs, 0);
  assert.strictEqual(ts[1].failingMs, 0);
});

test('a single saved tunnel is never judged on its own (cannot tell it from a global outage)', () => {
  const ts = [tn('a')];
  tick(ts, states({ a: 'failed' }), 10 * DAY, 7);
  assert.strictEqual(ts[0].archived, false);
  assert.strictEqual(ts[0].failingMs, 0);
});

test('idle tunnels the user is not using are left alone', () => {
  const ts = [tn('a', { failingMs: 2 * DAY }), tn('b')];
  tick(ts, states({ a: 'idle', b: 'active' }), DAY, 7);
  assert.strictEqual(ts[0].failingMs, 2 * DAY);
});

test('archived tunnels are ignored', () => {
  const ts = [tn('a', { archived: true }), tn('b')];
  const out = tick(ts, states({ a: 'failed', b: 'active' }), 9 * DAY, 7);
  assert.deepStrictEqual(out, []);
});

const withErr = (o, errs) => (n) => ({ state: o[n] || 'idle', error: errs[n] });

test('tick stamps archivedAt with now when it archives', () => {
  const ts = [tn('a', { failingMs: 6 * DAY }), tn('b')];
  tick(ts, states({ a: 'failed', b: 'active' }), DAY, 7, 123456);
  assert.strictEqual(ts[0].archived, true);
  assert.strictEqual(ts[0].archivedAt, 123456);
});

test('archiveDays 0 means never: time accrues but nothing is archived', () => {
  const ts = [tn('a'), tn('b')];
  const out = tick(ts, states({ a: 'failed', b: 'active' }), DAY, 0);
  assert.deepStrictEqual(out, []);
  assert.strictEqual(ts[0].archived, false);
  assert.strictEqual(ts[0].failingMs, DAY);
});

test('an undefined archiveDays never archives either', () => {
  const ts = [tn('a'), tn('b')];
  assert.deepStrictEqual(tick(ts, states({ a: 'failed', b: 'active' }), DAY, undefined), []);
});

test('credential and endpoint errors are not charged and not reset', () => {
  const errs = [
    'An error occurred (ExpiredTokenException) when calling the StartSession operation: The security token included in the request is expired',
    'Could not connect to the endpoint URL: "https://ssm.us-west-2.amazonaws.com/"',
    'Gave up after 5 attempts: Unable to locate credentials. You can configure credentials by running "aws configure".',
    'Name or service not known',
  ];
  for (const error of errs) {
    const ts = [tn('a', { failingMs: 2 * DAY }), tn('b')];
    tick(ts, withErr({ a: 'failed', b: 'active' }, { a: error }), 10 * DAY, 7);
    assert.strictEqual(ts[0].failingMs, 2 * DAY, error);
    assert.strictEqual(ts[0].archived, false);
  }
});

test('other errors are charged normally', () => {
  const ts = [tn('a'), tn('b')];
  tick(ts, withErr({ a: 'failed', b: 'active' }, { a: 'TargetNotConnected' }), DAY, 7);
  assert.strictEqual(ts[0].failingMs, DAY);
});

test('CREDENTIAL_ERROR is case-insensitive', () => {
  assert.ok(CREDENTIAL_ERROR.test('could not CONNECT TO THE ENDPOINT url'));
  assert.ok(!CREDENTIAL_ERROR.test('Session ended'));
});

const arch = (name, archivedAt, over = {}) => ({ name, archived: true, archivedAt, ...over });

test('purge removes archived tunnels old enough and returns their names', () => {
  const ts = [arch('old', 0), tn('live'), arch('older', -DAY)];
  const out = purge(ts, 7 * DAY, 7);
  assert.deepStrictEqual(out, ['old', 'older']);
  assert.deepStrictEqual(ts.map((t) => t.name), ['live']);
});

test('purge keeps archived tunnels younger than purgeDays', () => {
  const ts = [arch('a', DAY)];
  assert.deepStrictEqual(purge(ts, 7 * DAY, 7), []);
  assert.strictEqual(ts.length, 1);
});

test('purge boundary is inclusive', () => {
  const ts = [arch('a', 0)];
  assert.deepStrictEqual(purge(ts, 7 * DAY, 7), ['a']);
});

test('purgeDays 0 keeps everything', () => {
  const ts = [arch('a', 0)];
  assert.deepStrictEqual(purge(ts, 1000 * DAY, 0), []);
  assert.strictEqual(ts.length, 1);
});

test('purge stamps legacy archived rows with now and does not purge them', () => {
  const ts = [arch('a', null), arch('b', undefined)];
  assert.deepStrictEqual(purge(ts, 9 * DAY, 7), []);
  assert.strictEqual(ts[0].archivedAt, 9 * DAY);
  assert.strictEqual(ts[1].archivedAt, 9 * DAY);
  assert.deepStrictEqual(purge(ts, 16 * DAY, 7), ['a', 'b']);
});

test('purge never touches non-archived tunnels', () => {
  const ts = [tn('a', { archivedAt: 0 }), tn('b')];
  assert.deepStrictEqual(purge(ts, 100 * DAY, 7), []);
  assert.strictEqual(ts.length, 2);
  assert.strictEqual(ts[1].archivedAt, undefined);
});
