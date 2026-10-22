const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, parseScript, DEFAULT_SETTINGS } = require('../lib/store');
const { validateTunnel } = require('../lib/validate');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ssmt-'));
  dirs.push(d);
  return d;
};
const fresh = () => {
  const dir = tmpDir();
  const file = path.join(dir, 'connections.json');
  const store = new Store({ file });
  store.load();
  return { dir, file, store };
};
const tun = (over = {}) => ({
  name: 'a', region: 'us-west-2', target: 'i-0357e26df0d26b2ae',
  host: 'db.example.com', port: 5432, local: 15002, desc: 'd', env: 'production', auto: false, ...over,
});
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('DEFAULT_SETTINGS has the documented defaults', () => {
  assert.deepStrictEqual(DEFAULT_SETTINGS, { openAtLogin: true, archiveDays: 7, purgeDays: 7, stopOnQuit: true, importedFrom: null });
});

test('load: missing file gives defaults and does not write', () => {
  const { file, store } = fresh();
  assert.deepStrictEqual(store.data, { version: 1, settings: DEFAULT_SETTINGS, tunnels: [] });
  assert.strictEqual(fs.existsSync(file), false);
});

test('save creates a missing parent dir, leaves no tmp file and round-trips', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'deep', 'er', 'connections.json');
  const store = new Store({ file });
  store.load();
  store.add(tun());
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-'));
  assert.deepStrictEqual(leftovers, []);
  const again = new Store({ file });
  again.load();
  assert.deepStrictEqual(again.data, store.data);
  assert.strictEqual(again.list()[0].name, 'a');
});

test('load: invalid JSON is renamed aside, defaults used, recoveredFrom set', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'connections.json');
  fs.writeFileSync(file, '{ not json');
  const store = new Store({ file });
  store.load();
  assert.ok(store.recoveredFrom.startsWith(`${file}.corrupt-`));
  assert.strictEqual(fs.readFileSync(store.recoveredFrom, 'utf8'), '{ not json');
  assert.strictEqual(fs.existsSync(file), false);
  assert.deepStrictEqual(store.data.tunnels, []);
  assert.deepStrictEqual(store.data.settings, DEFAULT_SETTINGS);
});

test('load: legacy rows and settings get defaults', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'connections.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, settings: { archiveDays: 14 },
    tunnels: [{ name: 'glacier-stg-redis', region: 'us-west-2', target: 'i-0357e26df0d26b2ae', host: 'h', port: 6379, local: 16004 },
      { name: 'x-prod', region: 'us-west-2', target: 'i-0357e26df0d26b2ae', host: 'h', port: 1, local: 2, env: 'bogus' }],
  }));
  const store = new Store({ file });
  store.load();
  assert.deepStrictEqual(store.data.settings, { ...DEFAULT_SETTINGS, archiveDays: 14 });
  assert.deepStrictEqual(store.get('glacier-stg-redis'), {
    name: 'glacier-stg-redis', region: 'us-west-2', target: 'i-0357e26df0d26b2ae', host: 'h', port: 6379, local: 16004,
    desc: '', env: 'staging', auto: false, archived: false, failingMs: 0, archivedAt: null, lastError: null,
    stopRequestedAt: null, profile: '',
  });
  assert.strictEqual(store.get('x-prod').env, 'production');
});

test('add stores defaults, saves, and reports clashes', () => {
  const { file, store } = fresh();
  const r1 = store.add(tun({ name: 'one', local: 443 }));
  assert.strictEqual(r1.ok, true);
  assert.deepStrictEqual(r1.clashes, []);
  assert.deepStrictEqual({ a: r1.tunnel.archived, f: r1.tunnel.failingMs, at: r1.tunnel.archivedAt, e: r1.tunnel.lastError },
    { a: false, f: 0, at: null, e: null });
  const r2 = store.add(tun({ name: 'two', local: 443 }));
  assert.strictEqual(r2.ok, true);
  assert.deepStrictEqual(r2.clashes, [{ name: 'one', auto: false }]);
  assert.deepStrictEqual(onDisk(file).tunnels.map((t) => t.name), ['one', 'two']);
});

test('add rejects invalid and duplicate input without saving', () => {
  const { file, store } = fresh();
  store.add(tun());
  const before = fs.readFileSync(file, 'utf8');
  const bad = store.add(tun({ region: 'nope' }));
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.errors.region, 'Expected an AWS region like us-east-1');
  const dup = store.add(tun());
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.errors.name, '“a” already exists');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.strictEqual(store.list().length, 1);
});

test('add at an index keeps supplied runtime fields (undo of delete)', () => {
  const { store } = fresh();
  store.add(tun({ name: 'a', local: 1 }));
  store.add(tun({ name: 'c', local: 3 }));
  const r = store.add({ ...tun({ name: 'b', local: 2 }), archived: true, failingMs: 99, archivedAt: 5, lastError: 'boom' }, 1);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(store.list().map((t) => t.name), ['a', 'b', 'c']);
  assert.deepStrictEqual(
    { a: r.tunnel.archived, f: r.tunnel.failingMs, at: r.tunnel.archivedAt, e: r.tunnel.lastError },
    { a: true, f: 99, at: 5, e: 'boom' });
});

test('add of an archived duplicate reports the archived suffix', () => {
  const { store } = fresh();
  store.add(tun());
  store.get('a').archived = true;
  assert.strictEqual(store.add(tun()).errors.name, '“a” already exists (archived)');
});

test('update edits config, keeps runtime fields, and supports rename', () => {
  const { file, store } = fresh();
  store.add(tun({ name: 'a' }));
  store.add(tun({ name: 'b', local: 2000 }));
  Object.assign(store.get('a'), { archived: true, failingMs: 10, archivedAt: 7, lastError: 'e' });
  const r = store.update('a', tun({ name: 'renamed', desc: 'new', local: 1500 }));
  assert.strictEqual(r.ok, true);
  const t = store.get('renamed');
  assert.strictEqual(store.get('a'), undefined);
  assert.deepStrictEqual({ d: t.desc, l: t.local, a: t.archived, f: t.failingMs, at: t.archivedAt, e: t.lastError },
    { d: 'new', l: 1500, a: true, f: 10, at: 7, e: 'e' });
  assert.deepStrictEqual(store.list().map((x) => x.name), ['renamed', 'b']);
  assert.strictEqual(onDisk(file).tunnels[0].name, 'renamed');
});

test('update: renaming onto an existing name fails; keeping own name is fine; unknown name fails', () => {
  const { store } = fresh();
  store.add(tun({ name: 'a' }));
  store.add(tun({ name: 'b', local: 2 }));
  assert.strictEqual(store.update('a', tun({ name: 'b' })).errors.name, '“b” already exists');
  assert.strictEqual(store.update('a', tun({ name: 'a', desc: 'same' })).ok, true);
  assert.strictEqual(store.update('nope', tun({ name: 'z' })).ok, false);
});

test('remove returns the tunnel and index, and saves', () => {
  const { file, store } = fresh();
  store.add(tun({ name: 'a' }));
  store.add(tun({ name: 'b', local: 2 }));
  const r = store.remove('b');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.index, 1);
  assert.strictEqual(r.tunnel.name, 'b');
  assert.deepStrictEqual(onDisk(file).tunnels.map((t) => t.name), ['a']);
  assert.deepStrictEqual(store.remove('b'), { ok: false });
});

test('setAuto and restore save', () => {
  const { file, store } = fresh();
  store.add(tun());
  assert.deepStrictEqual(store.setAuto('a', true), { ok: true });
  assert.strictEqual(onDisk(file).tunnels[0].auto, true);
  assert.strictEqual(store.setAuto('nope', true).ok, false);
  Object.assign(store.get('a'), { archived: true, archivedAt: 9, failingMs: 5 });
  assert.deepStrictEqual(store.restore('a'), { ok: true });
  const t = onDisk(file).tunnels[0];
  assert.deepStrictEqual({ a: t.archived, at: t.archivedAt, f: t.failingMs }, { a: false, at: null, f: 0 });
  assert.strictEqual(store.restore('nope').ok, false);
});

test('updateSettings validates, rejects unknown keys, and saves only on success', () => {
  const { file, store } = fresh();
  const ok = store.updateSettings({ archiveDays: 14, openAtLogin: false });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.settings, { ...DEFAULT_SETTINGS, archiveDays: 14, openAtLogin: false });
  assert.strictEqual(onDisk(file).settings.archiveDays, 14);
  const before = fs.readFileSync(file, 'utf8');
  const bad = store.updateSettings({ archiveDays: 366, purgeDays: 1.5, stopOnQuit: 'yes', mystery: 1, importedFrom: 'x' });
  assert.strictEqual(bad.ok, false);
  assert.deepStrictEqual(Object.keys(bad.errors).sort(), ['archiveDays', 'importedFrom', 'mystery', 'purgeDays', 'stopOnQuit']);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.strictEqual(store.data.settings.archiveDays, 14);
  assert.strictEqual(store.updateSettings({ archiveDays: 0, purgeDays: 365 }).ok, true);
});

const FIXTURE = `#!/bin/bash
TUNNELS_OLD=(
    "ignored|x|y|z|1|2|nope"
)
# Format: name|region|target|host|port|localPort|description

TUNNELS=(
    # a comment inside
    "onyx-prod|us-west-2|i-0357e26df0d26b2ae|db.example.com|5432|15002|Onyx DB"

    'glacier-stg-redis|us-west-2|i-0357e26df0d26b2ae|redis.example.com|6379|16004|Glacier Staging Redis'
    "kelp-1|eu-central-1|i-0b0bdc12cc7c09e42|10.0.0.10|443|443|Desc | with pipe"
)
OTHER=(
    "stray|a|b|c|1|2|d"
)
`;

test('parseScript reads only the TUNNELS array, both quote styles, skipping comments and blanks', () => {
  const rows = parseScript(FIXTURE);
  assert.deepStrictEqual(rows.map((r) => r.name), ['onyx-prod', 'glacier-stg-redis', 'kelp-1']);
  assert.deepStrictEqual(rows[0], {
    name: 'onyx-prod', region: 'us-west-2', target: 'i-0357e26df0d26b2ae', host: 'db.example.com',
    port: 5432, local: 15002, desc: 'Onyx DB', env: 'production', auto: false,
  });
  assert.strictEqual(rows[1].env, 'staging');
  assert.strictEqual(rows[2].env, 'other');
  assert.strictEqual(rows[2].desc, 'Desc | with pipe');
  assert.strictEqual(typeof rows[2].port, 'number');
});

test('parseScript returns [] when there is no TUNNELS array', () => {
  assert.deepStrictEqual(parseScript('echo hi\n'), []);
});

test('importFromScript applies overrides, skips bad rows, sets importedFrom, saves once', () => {
  const { dir, file, store } = fresh();
  const script = path.join(dir, 'script.sh');
  fs.writeFileSync(script, `TUNNELS=(
  "a|us-west-2|i-0357e26df0d26b2ae|h|1|10|A"
  "a|us-west-2|i-0357e26df0d26b2ae|h|1|11|dup"
  "BAD|us-west-2|i-0357e26df0d26b2ae|h|1|12|bad name"
  "c|us-west-2|i-0357e26df0d26b2ae|h|1|10|clash allowed"
)
`);
  const r = store.importFromScript(script, { a: 2000 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.added, ['a', 'c']);
  assert.deepStrictEqual(r.skipped.map((s) => s.name), ['a', 'BAD']);
  assert.strictEqual(r.skipped[0].errors.name, '“a” already exists');
  assert.ok(r.skipped[1].errors.name);
  assert.strictEqual(store.get('a').local, 2000);
  assert.strictEqual(store.data.settings.importedFrom, script);
  assert.strictEqual(onDisk(file).settings.importedFrom, script);
  assert.deepStrictEqual(onDisk(file).tunnels.map((t) => t.name), ['a', 'c']);
});

test('importFromScript returns ok:false for an unreadable file', () => {
  const { dir, store } = fresh();
  const r = store.importFromScript(path.join(dir, 'missing.sh'));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

const SAMPLE = path.join(__dirname, 'fixtures', 'ssm-connect.sample');
test('a full 10-tunnel script imports cleanly (read-only)', () => {
  const { store } = fresh();
  const r = store.importFromScript(SAMPLE);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added.length, 10);
  assert.deepStrictEqual(r.skipped, []);
  const dp = store.get('onyx-prod');
  assert.deepStrictEqual({ l: dp.local, p: dp.port, r: dp.region, t: dp.target },
    { l: 15002, p: 5432, r: 'us-west-2', t: 'i-0357e26df0d26b2ae' });
  for (const n of ['glacier-stg-redis', 'onyx-stg']) assert.strictEqual(store.get(n).env, 'staging', n);
  for (const n of ['onyx-prod', 'zephyr-prod', 'glacier-prod', 'glacier-prod-redis']) {
    assert.strictEqual(store.get(n).env, 'production', n);
  }
  for (const n of ['glacier-cache', 'glacier-jobs-redis', 'kelp-1', 'kelp-2']) {
    assert.strictEqual(store.get(n).env, 'other', n);
  }
  for (const n of ['kelp-1', 'kelp-2']) assert.strictEqual(store.get(n).local, 443, n);
  const two = store.get('kelp-2');
  const others = store.list().filter((x) => x.name !== 'kelp-2');
  const v = validateTunnel(two, others);
  assert.deepStrictEqual(v.errors, {});
  assert.deepStrictEqual(v.clashes, [{ name: 'kelp-1', auto: false }]);
});

// ---- external changes (CLI and app share one file) ---------------------

const cli = (file) => { const s = new Store({ file }); s.load(); return s; };

test('external add by another store survives a later save of this store', () => {
  const { file, store } = fresh();
  store.add(tun({ name: 'a', local: 1001 }));
  cli(file).add(tun({ name: 'b', local: 1002 }));
  assert.strictEqual(store.save(), false);
  assert.deepStrictEqual(onDisk(file).tunnels.map((t) => t.name), ['a', 'b']);
  assert.deepStrictEqual(store.list().map((t) => t.name), ['a', 'b']);
});

test('external remove is not resurrected by a later save', () => {
  const { file, store } = fresh();
  store.add(tun({ name: 'a', local: 1001 }));
  store.add(tun({ name: 'b', local: 1002 }));
  cli(file).remove('a');
  assert.strictEqual(store.save(), false);
  assert.deepStrictEqual(onDisk(file).tunnels.map((t) => t.name), ['b']);
  assert.deepStrictEqual(store.list().map((t) => t.name), ['b']);
});

test('save returns true when nothing changed externally', () => {
  const { store } = fresh();
  store.add(tun());
  assert.strictEqual(store.save(), true);
});

test('reloadIfChanged: false when untouched, true once after an external edit, disk wins on config and settings', () => {
  const { file, store } = fresh();
  store.add(tun({ name: 'a', local: 1001 }));
  assert.strictEqual(store.reloadIfChanged(), false);
  const other = cli(file);
  other.update('a', tun({ name: 'a', local: 1999, desc: 'edited' }));
  other.updateSettings({ archiveDays: 30 });
  assert.strictEqual(store.reloadIfChanged(), true);
  assert.strictEqual(store.get('a').local, 1999);
  assert.strictEqual(store.get('a').desc, 'edited');
  assert.strictEqual(store.data.settings.archiveDays, 30);
  assert.strictEqual(store.reloadIfChanged(), false);
});

test('mutators apply on top of an external change', () => {
  const { file, store } = fresh();
  store.add(tun({ name: 'a', local: 1001 }));
  cli(file).add(tun({ name: 'b', local: 1002 }));
  assert.strictEqual(store.add(tun({ name: 'c', local: 1003 })).ok, true);
  assert.deepStrictEqual(onDisk(file).tunnels.map((t) => t.name), ['a', 'b', 'c']);

  cli(file).add(tun({ name: 'd', local: 1004 }));
  assert.strictEqual(store.update('b', tun({ name: 'b', local: 1222 })).ok, true);
  assert.deepStrictEqual(onDisk(file).tunnels.map((t) => t.name), ['a', 'b', 'c', 'd']);

  cli(file).add(tun({ name: 'e', local: 1005 }));
  assert.strictEqual(store.remove('a').ok, true);
  assert.deepStrictEqual(onDisk(file).tunnels.map((t) => t.name), ['b', 'c', 'd', 'e']);

  cli(file).add(tun({ name: 'f', local: 1006 }));
  assert.strictEqual(store.setAuto('b', true).ok, true);
  assert.ok(onDisk(file).tunnels.some((t) => t.name === 'f'));

  cli(file).add(tun({ name: 'g', local: 1007 }));
  assert.strictEqual(store.updateSettings({ purgeDays: 3 }).ok, true);
  assert.ok(onDisk(file).tunnels.some((t) => t.name === 'g'));

  cli(file).add(tun({ name: 'h', local: 1008 }));
  assert.strictEqual(store.restore('b').ok, true);
  assert.ok(onDisk(file).tunnels.some((t) => t.name === 'h'));
});

test('a mutator sees a name added externally (duplicate rejected) and a name removed externally (not found)', () => {
  const { file, store } = fresh();
  store.add(tun({ name: 'a', local: 1001 }));
  cli(file).add(tun({ name: 'b', local: 1002 }));
  const dup = store.add(tun({ name: 'b', local: 1003 }));
  assert.strictEqual(dup.ok, false);
  cli(file).remove('a');
  assert.strictEqual(store.remove('a').ok, false);
});

test('importFromScript applies on top of an external change', () => {
  const { dir, file, store } = fresh();
  store.add(tun({ name: 'a', local: 1001 }));
  cli(file).add(tun({ name: 'b', local: 1002 }));
  const script = path.join(dir, 'ssm');
  fs.writeFileSync(script, 'TUNNELS=(\n  "c|us-west-2|i-0357e26df0d26b2ae|h.example|5432|1003|d"\n)\n');
  assert.deepStrictEqual(store.importFromScript(script).added, ['c']);
  assert.deepStrictEqual(onDisk(file).tunnels.map((t) => t.name), ['a', 'b', 'c']);
});

test('reloadIfChanged: file deleted externally keeps memory, no throw', () => {
  const { file, store } = fresh();
  store.add(tun());
  fs.rmSync(file);
  assert.strictEqual(store.reloadIfChanged(), false);
  assert.strictEqual(store.list().length, 1);
  assert.strictEqual(store.save(), true, 'a missing file is recreated from memory');
  assert.strictEqual(onDisk(file).tunnels.length, 1);
});

test('reloadIfChanged: corrupt file keeps memory, is not renamed, does not throw', () => {
  const { dir, file, store } = fresh();
  store.add(tun());
  fs.writeFileSync(file, '{ broken');
  assert.strictEqual(store.reloadIfChanged(), false);
  assert.strictEqual(store.list().length, 1);
  assert.strictEqual(store.recoveredFrom, null);
  assert.deepStrictEqual(fs.readdirSync(dir), ['connections.json']);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ broken');
});

test('reloadIfChanged: a file that appears after a missing-file load is picked up', () => {
  const { file, store } = fresh();
  cli(file).add(tun({ name: 'x', local: 1001 }));
  assert.strictEqual(store.reloadIfChanged(), true);
  assert.deepStrictEqual(store.list().map((t) => t.name), ['x']);
});

test('save over a corrupt file writes memory and leaves no tmp file', () => {
  const { dir, file, store } = fresh();
  store.add(tun());
  fs.writeFileSync(file, '{ broken');
  assert.strictEqual(store.save(), true);
  assert.strictEqual(onDisk(file).tunnels.length, 1);
  assert.deepStrictEqual(fs.readdirSync(dir), ['connections.json']);
});

test('reserved name "all" is rejected by add and import', () => {
  const { dir, store } = fresh();
  const r = store.add(tun({ name: 'all' }));
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.name, /reserved/i);
  const script = path.join(dir, 'ssm');
  fs.writeFileSync(script, 'TUNNELS=(\n  "all|us-west-2|i-0357e26df0d26b2ae|h.example|5432|1003|d"\n)\n');
  const imp = store.importFromScript(script);
  assert.deepStrictEqual(imp.added, []);
  assert.strictEqual(imp.skipped[0].name, 'all');
  assert.ok(imp.skipped[0].errors.name);
});

// ---- load-time type checks and quarantine ----
const writeRaw = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2));
const rawRow = (over = {}) => ({ name: 'x', region: 'us-west-2', target: 'i-0357e26df0d26b2ae', host: 'h.example.com', port: 5432, local: 15002, desc: '', env: 'production', auto: false, ...over });
const loaded = (obj) => {
  const dir = tmpDir();
  const file = path.join(dir, 'connections.json');
  writeRaw(file, obj);
  const store = new Store({ file });
  store.load();
  return { file, store };
};

test('load: numeric-string ports are coerced to integers', () => {
  const { store } = loaded({ version: 1, settings: {}, tunnels: [rawRow({ port: '5432', local: ' 15002 ' })] });
  assert.strictEqual(store.list()[0].port, 5432);
  assert.strictEqual(store.list()[0].local, 15002);
  assert.deepStrictEqual(store.quarantined(), []);
});

test('load: unrepairable port/local rows are quarantined, hidden and not counted', () => {
  const bad = [
    rawRow({ name: 'b1', port: 70000 }), rawRow({ name: 'b2', local: 0 }), rawRow({ name: 'b3', port: '<img src=x onerror=1>' }),
    rawRow({ name: 'b4', local: 1.5 }), rawRow({ name: 'b5', port: null }), rawRow({ name: 'b6', local: {} }), rawRow({ name: 'b7', port: '12 3' }),
  ];
  const { store } = loaded({ version: 1, settings: {}, tunnels: [rawRow({ name: 'ok' }), ...bad] });
  assert.deepStrictEqual(store.list().map((t) => t.name), ['ok']);
  assert.deepStrictEqual(store.quarantined(), bad);
});

test('save keeps quarantined rows unchanged in the file; load/save/load round trip is stable', () => {
  const bad = { name: 'weird', port: '<b>x</b>', local: 99999, extra: [1, 2], desc: 'keep me' };
  const { file, store } = loaded({ version: 1, settings: {}, tunnels: [bad, rawRow({ name: 'ok' })] });
  assert.strictEqual(store.setAuto('ok', true).ok, true);
  const disk = onDisk(file);
  assert.deepStrictEqual(disk.tunnels.filter((t) => t.name === 'weird'), [bad]);
  assert.strictEqual(disk.tunnels.find((t) => t.name === 'ok').auto, true);
  const again = new Store({ file });
  again.load();
  assert.deepStrictEqual(again.quarantined(), [bad]);
  assert.strictEqual(again.save(), true);
  assert.deepStrictEqual(onDisk(file).tunnels.filter((t) => t.name === 'weird'), [bad]);
});

test('reloadIfChanged refreshes the quarantine list', () => {
  const { file, store } = loaded({ version: 1, settings: {}, tunnels: [rawRow({ name: 'bad', port: 'x' })] });
  assert.strictEqual(store.quarantined().length, 1);
  writeRaw(file, { version: 1, settings: {}, tunnels: [rawRow({ name: 'bad', port: 5432 })] });
  assert.strictEqual(store.reloadIfChanged(), true);
  assert.deepStrictEqual(store.quarantined(), []);
  assert.strictEqual(store.list().length, 1);
});

test('quarantined() returns a copy', () => {
  const { store } = loaded({ version: 1, settings: {}, tunnels: [rawRow({ port: 'x' })] });
  store.quarantined().push({});
  assert.strictEqual(store.quarantined().length, 1);
});

test('load: bad settings fall back to defaults, valid ones are kept', () => {
  const { store } = loaded({ version: 1, settings: {
    archiveDays: '<script>', purgeDays: 400, openAtLogin: 'yes', stopOnQuit: false, importedFrom: 5,
  }, tunnels: [] });
  assert.deepStrictEqual(store.data.settings, { ...DEFAULT_SETTINGS, stopOnQuit: false });
  const ok = loaded({ version: 1, settings: { archiveDays: 0, purgeDays: 365, importedFrom: '/a/b.sh' }, tunnels: [] });
  assert.deepStrictEqual(ok.store.data.settings, { ...DEFAULT_SETTINGS, archiveDays: 0, purgeDays: 365, importedFrom: '/a/b.sh' });
  for (const v of [-1, 1.5, NaN, null, '7', true]) {
    const r = loaded({ version: 1, settings: { archiveDays: v }, tunnels: [] });
    assert.strictEqual(r.store.data.settings.archiveDays, 7, String(v));
  }
});

// ---- review findings -------------------------------------------------------

test('#9 rows with an unsafe host, a bad name or a duplicate name are quarantined on load, and kept in the file', () => {
  const rows = [
    tun({ name: 'a' }),
    tun({ name: 'b', local: 15003, host: 'db,localPortNumber=22' }),
    tun({ name: 'Bad Name!', local: 15004 }),
    tun({ name: 'a', local: 15005, desc: 'duplicate' }),
  ];
  const { file, store } = loaded({ version: 1, settings: {}, tunnels: rows });
  assert.deepStrictEqual(store.list().map((t) => t.name), ['a']);
  assert.deepStrictEqual(store.quarantined().map((r) => r.name), ['b', 'Bad Name!', 'a']);
  store.save();
  assert.strictEqual(onDisk(file).tunnels.length, 4, 'nothing deleted from the file');
});

test('#1 requestStop stamps the named tunnels in the shared file and survives a reload', () => {
  const { file, store } = fresh();
  store.add(tun({ name: 'a' }));
  store.add(tun({ name: 'b', local: 15003 }));
  store.requestStop(['a'], 123);
  assert.strictEqual(onDisk(file).tunnels.find((t) => t.name === 'a').stopRequestedAt, 123);
  const again = new Store({ file });
  again.load();
  assert.strictEqual(again.get('a').stopRequestedAt, 123);
  assert.strictEqual(again.get('b').stopRequestedAt ?? null, null);
});
