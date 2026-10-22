const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, run } = require('../lib/cli');
const { Store } = require('../lib/store');
const scanLib = require('../lib/scan');
const { buildArgs } = require('../lib/tunnelManager');

const NOW = Date.UTC(2026, 0, 10);
const DAY = 86400000;
const T = (name, local, extra = {}) => ({
  name, region: 'eu-west-1', target: 'i-0357e26df0d26b2ae', host: `${name}.internal`,
  port: 5432, local, desc: '', env: 'staging', auto: false, archived: false,
  failingMs: 0, archivedAt: null, lastError: null, ...extra,
});
const session = (t, pid, extra = {}) => ({
  pid, ppid: 1, pids: [pid, pid + 1], region: t.region, target: t.target, host: t.host,
  port: t.port, local: t.local, etimeSec: 90, orphan: false, ...extra,
});

// Real Store on a temp file; scan/spawn are injected fakes. Returns a runner plus recorders.
function setup(tunnels = [], { sessions = [], busy = [], settings = {}, isTTY = false, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-cli-'));
  const file = path.join(dir, 'connections.json');
  if (tunnels.length || Object.keys(settings).length) {
    fs.writeFileSync(file, JSON.stringify({ version: 1, settings, tunnels }));
  }
  const spawned = [];
  const killed = [];
  const state = { sessions, busy: new Set(busy), pid: 5000, noPid: false };
  const deps = {
    store: new Store({ file }),
    scan: {
      scanSessions: async () => state.sessions,
      matchSessions: scanLib.matchSessions,
      isPortInUse: async (p) => state.busy.has(p),
      killSession: (s) => { killed.push(s); return s.pids; },
    },
    spawn: (cmd, args, opts) => {
      const proc = { pid: state.noPid ? undefined : state.pid++, unrefCalled: false, unref() { this.unrefCalled = true; } };
      spawned.push({ cmd, args, opts, proc });
      return proc;
    },
    awsBin: 'fake-aws',
    childEnv: { PATH: '/x' },
    now: () => NOW,
    isTTY,
    env,
    version: '9.9.9',
  };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const exec = (argv, over = {}) => run(argv, { ...deps, ...over });
  return { exec, spawned, killed, state, read, file, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const withSetup = (tunnels, opts, fn) => async () => {
  const s = setup(tunnels, opts);
  try { await fn(s); } finally { s.cleanup(); }
};

// ---- parseArgs ---------------------------------------------------------

const SPEC = { boolean: ['json', 'auto'], string: ['region', 'desc'] };

test('parseArgs supports --flag value and --flag=value', () => {
  const r = parseArgs(['a', '--region', 'eu-west-1', '--desc=hello world', 'b'], SPEC);
  assert.deepStrictEqual(r.positionals, ['a', 'b']);
  assert.deepStrictEqual(r.flags, { region: 'eu-west-1', desc: 'hello world' });
  assert.deepStrictEqual(r.errors, []);
});

test('parseArgs: booleans do not swallow the next positional', () => {
  const r = parseArgs(['--auto', 'name'], SPEC);
  assert.deepStrictEqual(r.flags, { auto: true });
  assert.deepStrictEqual(r.positionals, ['name']);
});

test('parseArgs reports unknown flags, missing values and values on booleans', () => {
  assert.match(parseArgs(['--nope'], SPEC).errors[0], /unknown option --nope/);
  assert.match(parseArgs(['--region'], SPEC).errors[0], /--region needs a value/);
  assert.match(parseArgs(['--region', '--json'], SPEC).errors[0], /--region needs a value/);
  assert.match(parseArgs(['--json=1'], SPEC).errors[0], /--json does not take a value/);
});

test('parseArgs: -- ends option parsing and = values may start with dashes', () => {
  const r = parseArgs(['--desc=--x', '--', '--json'], SPEC);
  assert.strictEqual(r.flags.desc, '--x');
  assert.deepStrictEqual(r.positionals, ['--json']);
});

// ---- usage, help, exit codes -------------------------------------------

test('--help and -h print usage on stdout with code 0 and state the no-reconnect limit', async () => {
  const s = setup();
  for (const flag of ['--help', '-h']) {
    const r = await s.exec([flag]);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /Usage: ssm-tunnels/);
    assert.match(r.out, /does not reconnect/i);
    assert.strictEqual(r.err, '');
  }
  s.cleanup();
});

test('--version prints the injected version', async () => {
  const s = setup();
  const r = await s.exec(['--version']);
  assert.deepStrictEqual(r, { code: 0, out: '9.9.9\n', err: '' });
  s.cleanup();
});

test('no command, unknown command and bad options give usage on stderr with code 2', async () => {
  const s = setup();
  for (const argv of [[], ['frobnicate'], ['list', '--bogus'], ['up'], ['down'], ['remove'], ['import']]) {
    const r = await s.exec(argv);
    assert.strictEqual(r.code, 2, argv.join(' '));
    assert.match(r.err, /Usage: ssm-tunnels/);
    assert.strictEqual(r.out, '');
  }
  s.cleanup();
});

test('a store that cannot be read is an operational failure (code 1)', async () => {
  const s = setup();
  const r = await s.exec(['list'], { store: { load() { throw new Error('EACCES: nope'); } } });
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /EACCES/);
  s.cleanup();
});

// ---- list / status -----------------------------------------------------

const TUNNELS = () => [
  T('stg-db', 5433, { auto: true }),
  T('prod-db', 5434, { env: 'production' }),
  T('old-one', 5435, { archived: true, archivedAt: NOW - 2 * DAY }),
];

test('list shows saved tunnels with state, hides archived', withSetup(TUNNELS(), {}, async (s) => {
  s.state.sessions = [session(T('stg-db', 5433), 4100)];
  const r = await s.exec(['list']);
  assert.strictEqual(r.code, 0);
  const lines = r.out.trim().split('\n');
  assert.match(lines[0], /NAME\s+ENV\s+FORWARD\s+AUTO\s+STATE/);
  assert.match(lines[1], /stg-db\s+staging\s+5433 -> stg-db\.internal:5432\s+auto\s+active/);
  assert.match(lines[2], /prod-db\s+production\s+5434 -> prod-db\.internal:5432\s+-\s+idle/);
  assert.ok(!r.out.includes('old-one'));
}));

test('list --json emits machine-readable rows including state and pid', withSetup(TUNNELS(), {}, async (s) => {
  s.state.sessions = [session(T('stg-db', 5433), 4100)];
  const r = await s.exec(['list', '--json']);
  const rows = JSON.parse(r.out);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0], {
    name: 'stg-db', env: 'staging', region: 'eu-west-1', target: 'i-0357e26df0d26b2ae',
    host: 'stg-db.internal', port: 5432, local: 5433, desc: '', auto: true, profile: '', state: 'active', pid: 4100,
  });
  assert.strictEqual(rows[1].state, 'idle');
  assert.strictEqual(rows[1].pid, null);
}));

test('list on an empty store says so', async () => {
  const s = setup();
  const r = await s.exec(['list']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /No saved connections/);
  assert.deepStrictEqual(JSON.parse((await s.exec(['list', '--json'])).out), []);
  s.cleanup();
});

test('colour only when stdout is a TTY and NO_COLOR is unset', async () => {
  const mk = async (opts) => {
    const s = setup(TUNNELS(), opts);
    const r = await s.exec(['list']);
    s.cleanup();
    return r.out;
  };
  assert.ok(!(await mk({ isTTY: false })).includes('\x1b['));
  assert.ok((await mk({ isTTY: true })).includes('\x1b['));
  assert.ok(!(await mk({ isTTY: true, env: { NO_COLOR: '1' } })).includes('\x1b['));
});

test('status matches sessions to saved names and labels the rest', withSetup(TUNNELS(), {}, async (s) => {
  const stray = { ...session(T('x', 9999), 4300), target: 'i-0aaaaaaaaaaaaaaaa', host: 'other.internal' };
  s.state.sessions = [session(T('stg-db', 5433), 4100), stray];
  const r = await s.exec(['status']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /stg-db\s+5433 -> stg-db\.internal:5432\s+pid 4100/);
  assert.match(r.out, /terminal\/unmanaged\s+9999 -> other\.internal:5432\s+pid 4300/);
  const j = JSON.parse((await s.exec(['status', '--json'])).out);
  assert.deepStrictEqual(j.map((x) => [x.name, x.managed]), [['stg-db', true], [null, false]]);
}));

test('status with nothing running', async () => {
  const s = setup(TUNNELS());
  const r = await s.exec(['status']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /No active SSM sessions/);
  s.cleanup();
});

test('a failing ps scan makes status exit 1', async () => {
  const s = setup(TUNNELS());
  const scan = { scanSessions: async () => { throw new Error('ps failed'); }, matchSessions: scanLib.matchSessions };
  const r = await s.exec(['status'], { scan });
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /ps failed/);
  s.cleanup();
});

// ---- up ----------------------------------------------------------------

test('up spawns the injected aws detached with buildArgs and prints the pid', withSetup(TUNNELS(), {}, async (s) => {
  const r = await s.exec(['up', 'prod-db']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(s.spawned.length, 1);
  const call = s.spawned[0];
  assert.strictEqual(call.cmd, 'fake-aws'); // only the injected spawn is ever used
  assert.deepStrictEqual(call.args, buildArgs(T('prod-db', 5434)));
  assert.strictEqual(call.opts.detached, true);
  assert.strictEqual(call.opts.stdio, 'ignore');
  assert.deepStrictEqual(call.opts.env, { PATH: '/x' });
  assert.strictEqual(call.proc.unrefCalled, true);
  assert.match(r.out, /prod-db.*started.*pid 5000/);
}));

test('up skips tunnels already active per scan', withSetup(TUNNELS(), {}, async (s) => {
  s.state.sessions = [session(T('stg-db', 5433), 4100)];
  s.state.busy.add(5433); // the live session holds the port; must not be reported as a port clash
  const r = await s.exec(['up', 'stg-db']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(s.spawned.length, 0);
  assert.match(r.out, /stg-db.*already active.*pid 4100/);
}));

test('up refuses archived tunnels with a restore hint', withSetup(TUNNELS(), {}, async (s) => {
  const r = await s.exec(['up', 'old-one']);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(s.spawned.length, 0);
  assert.match(r.err, /old-one.*archived.*restore old-one/);
}));

test('up refuses when the local port is in use and still starts the others', withSetup(TUNNELS(), {}, async (s) => {
  s.state.busy.add(5433);
  const r = await s.exec(['up', 'stg-db', 'prod-db']);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(s.spawned.length, 1);
  assert.deepStrictEqual(s.spawned[0].args, buildArgs(T('prod-db', 5434)));
  assert.match(r.err, /stg-db.*local port 5433 is already in use/);
  assert.match(r.out, /prod-db.*started/);
}));

test('up with an unknown name fails with code 1 and spawns nothing', withSetup(TUNNELS(), {}, async (s) => {
  const r = await s.exec(['up', 'nope']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /no saved connection named "nope"/);
  assert.strictEqual(s.spawned.length, 0);
}));

test('up --auto starts only auto, non-archived tunnels', withSetup(
  [...TUNNELS(), T('auto-arch', 5436, { auto: true, archived: true, archivedAt: NOW })], {}, async (s) => {
    const r = await s.exec(['up', '--auto']);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(s.spawned.length, 1);
    assert.deepStrictEqual(s.spawned[0].args, buildArgs(T('stg-db', 5433)));
  }));

test('up all starts every non-archived tunnel', withSetup(TUNNELS(), {}, async (s) => {
  const r = await s.exec(['up', 'all']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(s.spawned.length, 2);
}));

test('up all does not fail on archived tunnels, they are just not selected', withSetup(TUNNELS(), {}, async (s) => {
  const r = await s.exec(['up', 'all']);
  assert.strictEqual(r.err, '');
}));

test('up does not start two tunnels that share a local port in one run', withSetup(
  [T('a-1', 443), T('a-2', 443)], {}, async (s) => {
    const r = await s.exec(['up', 'a-1', 'a-2']);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(s.spawned.length, 1);
    assert.match(r.err, /a-2.*local port 443.*a-1/);
  }));

test('up reports a spawn that yields no pid as a failure', withSetup(TUNNELS(), {}, async (s) => {
  s.state.noPid = true;
  const r = await s.exec(['up', 'prod-db']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /prod-db.*could not start aws/);
}));

test('up --auto combined with names is a usage error', async () => {
  const s = setup(TUNNELS());
  assert.strictEqual((await s.exec(['up', '--auto', 'prod-db'])).code, 2);
  s.cleanup();
});

// ---- down / kill -------------------------------------------------------

test('down stops only the named matched session', withSetup(TUNNELS(), {}, async (s) => {
  const a = session(T('stg-db', 5433), 4100);
  const b = session(T('prod-db', 5434), 4200);
  s.state.sessions = [a, b];
  const r = await s.exec(['down', 'stg-db']);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(s.killed, [a]);
  assert.match(r.out, /stg-db.*stopped/);
}));

test('down on an idle tunnel reports not running and exits 0', withSetup(TUNNELS(), {}, async (s) => {
  const r = await s.exec(['down', 'stg-db']);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(s.killed, []);
  assert.match(r.out, /stg-db.*not running/);
}));

test('down all stops saved sessions but leaves unmanaged ones alone; unknown name is code 1', withSetup(TUNNELS(), {}, async (s) => {
  const a = session(T('stg-db', 5433), 4100);
  const stray = { ...session(T('x', 9999), 4300), target: 'i-0aaaaaaaaaaaaaaaa' };
  s.state.sessions = [a, stray];
  const r = await s.exec(['down', 'all']);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(s.killed, [a]);
  assert.strictEqual((await s.exec(['down', 'nope'])).code, 1);
}));

test('kill stops every session including unmanaged ones', withSetup(TUNNELS(), {}, async (s) => {
  const a = session(T('stg-db', 5433), 4100);
  const stray = { ...session(T('x', 9999), 4300), target: 'i-0aaaaaaaaaaaaaaaa' };
  s.state.sessions = [a, stray];
  const r = await s.exec(['kill']);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(s.killed, [a, stray]);
  assert.match(r.out, /Stopped 2 session/);
}));

test('kill with nothing running exits 0', async () => {
  const s = setup();
  const r = await s.exec(['kill']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /No active SSM sessions/);
  s.cleanup();
});

test('a kill failure is reported with code 1', withSetup(TUNNELS(), {}, async (s) => {
  s.state.sessions = [session(T('stg-db', 5433), 4100)];
  const scan = { scanSessions: async () => s.state.sessions, matchSessions: scanLib.matchSessions,
    killSession: () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; } };
  const r = await s.exec(['down', 'stg-db'], { scan });
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /stg-db.*operation not permitted/);
}));

// ---- add ---------------------------------------------------------------

const ADD = ['add', 'stg-cache', '--region', 'eu-west-1', '--target', 'i-0357e26df0d26b2ae',
  '--host', 'cache.internal', '--port', '6379', '--local', '6380'];

test('add saves to the shared file and prints what was saved, env inferred', async () => {
  const s = setup();
  const r = await s.exec([...ADD, '--desc=Cache', '--auto']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Saved stg-cache/);
  assert.match(r.out, /6380 -> cache\.internal:6379/);
  assert.match(r.out, /staging/);
  const saved = s.read().tunnels[0];
  assert.strictEqual(saved.name, 'stg-cache');
  assert.strictEqual(saved.env, 'staging');
  assert.strictEqual(saved.auto, true);
  assert.strictEqual(saved.desc, 'Cache');
  assert.strictEqual(saved.port, 6379);
  assert.strictEqual(saved.archived, false);
  s.cleanup();
});

test('add honours an explicit --env and rejects an invalid one', async () => {
  const s = setup();
  assert.strictEqual((await s.exec([...ADD, '--env', 'production'])).code, 0);
  assert.strictEqual(s.read().tunnels[0].env, 'production');
  const bad = await s.exec(['add', 'other-1', ...ADD.slice(2), '--env', 'prd']);
  assert.strictEqual(bad.code, 1);
  assert.match(bad.err, /env: Pick an environment/);
  s.cleanup();
});

test('add reports every validation error, exits 1 and writes nothing', async () => {
  const s = setup();
  const r = await s.exec(['add', 'Bad Name', '--region', 'moon', '--target', 'x', '--host', 'a b',
    '--port', '0', '--local', 'abc']);
  assert.strictEqual(r.code, 1);
  for (const f of ['name', 'region', 'target', 'host', 'port', 'local']) assert.match(r.err, new RegExp(`${f}: `));
  assert.ok(!fs.existsSync(s.file));
  s.cleanup();
});

test('add rejects a duplicate name, including an archived one', withSetup(TUNNELS(), {}, async (s) => {
  const dup = await s.exec(['add', 'stg-db', ...ADD.slice(2)]);
  assert.strictEqual(dup.code, 1);
  assert.match(dup.err, /already exists/);
  const arch = await s.exec(['add', 'old-one', ...ADD.slice(2)]);
  assert.match(arch.err, /already exists \(archived\)/);
  assert.strictEqual(s.read().tunnels.length, 3);
}));

test('add warns about a local-port clash but still saves', withSetup(TUNNELS(), {}, async (s) => {
  const r = await s.exec(['add', 'stg-new', ...ADD.slice(2, 10), '--local', '5433']);
  assert.strictEqual(r.code, 0);
  assert.match(r.err, /warning.*local port 5433.*stg-db/);
  assert.strictEqual(s.read().tunnels.length, 4);
}));

test('add without required options is a usage error (code 2)', async () => {
  const s = setup();
  const r = await s.exec(['add', 'x', '--region', 'eu-west-1']);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /missing --target, --host, --port, --local/);
  assert.strictEqual((await s.exec(['add'])).code, 2);
  s.cleanup();
});

// ---- edit / remove / archived / restore --------------------------------

test('edit changes only the given fields and toggles auto', withSetup(TUNNELS(), {}, async (s) => {
  const r = await s.exec(['edit', 'prod-db', '--host', 'new.internal', '--local=6000', '--auto']);
  assert.strictEqual(r.code, 0);
  const t = s.read().tunnels.find((x) => x.name === 'prod-db');
  assert.strictEqual(t.host, 'new.internal');
  assert.strictEqual(t.local, 6000);
  assert.strictEqual(t.auto, true);
  assert.strictEqual(t.env, 'production');
  assert.strictEqual(t.port, 5432);
  assert.match(r.out, /Updated prod-db/);
  await s.exec(['edit', 'prod-db', '--no-auto']);
  assert.strictEqual(s.read().tunnels.find((x) => x.name === 'prod-db').auto, false);
}));

test('edit can rename and validates like the app', withSetup(TUNNELS(), {}, async (s) => {
  assert.strictEqual((await s.exec(['edit', 'prod-db', '--name', 'prod-db2'])).code, 0);
  assert.ok(s.read().tunnels.some((x) => x.name === 'prod-db2'));
  const bad = await s.exec(['edit', 'prod-db2', '--port', '99999']);
  assert.strictEqual(bad.code, 1);
  assert.match(bad.err, /port: Enter a port from 1 to 65535/);
  const clash = await s.exec(['edit', 'prod-db2', '--name', 'stg-db']);
  assert.match(clash.err, /already exists/);
}));

test('edit usage and unknown names', withSetup(TUNNELS(), {}, async (s) => {
  assert.strictEqual((await s.exec(['edit', 'prod-db'])).code, 2);
  assert.strictEqual((await s.exec(['edit', 'prod-db', '--auto', '--no-auto'])).code, 2);
  assert.strictEqual((await s.exec(['edit', '--host', 'x'])).code, 2);
  const r = await s.exec(['edit', 'nope', '--host', 'x']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /no saved connection named "nope"/);
}));

test('remove deletes and reports; unknown is code 1', withSetup(TUNNELS(), {}, async (s) => {
  const r = await s.exec(['remove', 'prod-db']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Removed prod-db/);
  assert.ok(!s.read().tunnels.some((x) => x.name === 'prod-db'));
  assert.strictEqual((await s.exec(['remove', 'prod-db'])).code, 1);
}));

test('archived lists archived tunnels with days until purge', withSetup(TUNNELS(), { settings: { purgeDays: 7 } }, async (s) => {
  const r = await s.exec(['archived']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /old-one\s+.*5 days/);
  assert.ok(!r.out.includes('prod-db'));
  const j = JSON.parse((await s.exec(['archived', '--json'])).out);
  assert.deepStrictEqual(j.map((x) => [x.name, x.daysUntilPurge]), [['old-one', 5]]);
}));

test('archived with purgeDays 0 says never; none archived says so', async () => {
  const a = setup(TUNNELS(), { settings: { purgeDays: 0 } });
  assert.match((await a.exec(['archived'])).out, /old-one\s+.*never/);
  a.cleanup();
  const b = setup([T('x', 1)]);
  assert.match((await b.exec(['archived'])).out, /No archived connections/);
  b.cleanup();
});

test('restore un-archives; refuses unarchived and unknown', withSetup(TUNNELS(), {}, async (s) => {
  const r = await s.exec(['restore', 'old-one']);
  assert.strictEqual(r.code, 0);
  const t = s.read().tunnels.find((x) => x.name === 'old-one');
  assert.strictEqual(t.archived, false);
  assert.strictEqual(t.archivedAt, null);
  assert.strictEqual((await s.exec(['restore', 'old-one'])).code, 1);
  assert.strictEqual((await s.exec(['restore', 'nope'])).code, 1);
}));

// ---- import ------------------------------------------------------------

test('import reports added and skipped rows', async () => {
  const s = setup([T('stg-db', 5433)]);
  const script = path.join(s.dir, 'legacy.sh');
  fs.writeFileSync(script, [
    'TUNNELS=(',
    '  "stg-db|eu-west-1|i-0357e26df0d26b2ae|h.internal|5432|5433|dup"',
    '  "prod-new|eu-west-1|i-0357e26df0d26b2ae|h.internal|5432|5440|fresh"',
    ')',
  ].join('\n'));
  const r = await s.exec(['import', script]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /Added 1: prod-new/);
  assert.match(r.out, /Skipped 1/);
  assert.match(r.out, /stg-db.*already exists/);
  assert.ok(s.read().tunnels.some((x) => x.name === 'prod-new'));
  const missing = await s.exec(['import', path.join(s.dir, 'nope.sh')]);
  assert.strictEqual(missing.code, 1);
  s.cleanup();
});

test('add rejects the reserved name "all" and writes nothing', async () => {
  const s = setup();
  const r = await s.exec(['add', 'all', ...ADD.slice(2)]);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /name: .*reserved/i);
  assert.ok(!fs.existsSync(s.file));
  s.cleanup();
});

// ---- event log: writing (source cli) ---------------------------------------

const recorder = (throws = false) => {
  const logs = [];
  return {
    logs,
    log: (level, event, tunnel, message, extra) => {
      if (throws) throw new Error('logger exploded');
      logs.push({ level, event, tunnel, message, extra });
      return true;
    },
  };
};
const brief = (rec) => rec.logs.map((l) => `${l.level}:${l.event}${l.tunnel ? `:${l.tunnel}` : ''}`);
const NEW_ARGS = ['add', 'new-db', '--region', 'eu-west-1', '--target', 'i-0357e26df0d26b2ae', '--host', 'h.internal', '--port', '5432', '--local', '5450'];

test('cli logs add, edit, remove, restore and import', async () => {
  const s = setup([T('prod-db', 5434), T('old-one', 5435, { archived: true, archivedAt: NOW - DAY })]);
  const rec = recorder();
  const script = path.join(s.dir, 'legacy.sh');
  fs.writeFileSync(script, 'TUNNELS=(\n  "imp-one|eu-west-1|i-0357e26df0d26b2ae|h.internal|5432|5460|d"\n)\n');
  assert.strictEqual((await s.exec(NEW_ARGS, { logger: rec })).code, 0);
  assert.strictEqual((await s.exec(['edit', 'new-db', '--desc', 'x'], { logger: rec })).code, 0);
  assert.strictEqual((await s.exec(['remove', 'new-db'], { logger: rec })).code, 0);
  assert.strictEqual((await s.exec(['restore', 'old-one'], { logger: rec })).code, 0);
  assert.strictEqual((await s.exec(['import', script], { logger: rec })).code, 0);
  assert.deepStrictEqual(brief(rec), ['info:added:new-db', 'info:edited:new-db', 'info:removed:new-db', 'info:restored:old-one', 'info:imported']);
  assert.strictEqual(rec.logs[0].extra.local, 5450);
  assert.strictEqual(rec.logs.at(-1).extra.count, 1);
  assert.ok(!JSON.stringify(rec.logs).includes('i-0357e26df0d26b2ae'));
  s.cleanup();
});

test('cli logs nothing for failed commands', async () => {
  const s = setup([T('prod-db', 5434)]);
  const rec = recorder();
  await s.exec(['add', 'prod-db', ...NEW_ARGS.slice(2)], { logger: rec });
  await s.exec(['remove', 'ghost'], { logger: rec });
  await s.exec(['restore', 'prod-db'], { logger: rec });
  await s.exec(['edit', 'ghost', '--desc', 'x'], { logger: rec });
  await s.exec(['list'], { logger: rec });
  assert.deepStrictEqual(rec.logs, []);
  s.cleanup();
});

test('cli logs up (name, pid), down (name, pid) and kill', async () => {
  const a = T('stg-db', 5433);
  const b = T('prod-db', 5434);
  const s = setup([a, b], { sessions: [session(b, 777), session(a, 778)] });
  const rec = recorder();
  const s2 = setup([a, b]);
  await s2.exec(['up', 'stg-db'], { logger: rec });
  assert.deepStrictEqual(brief(rec), ['info:up:stg-db']);
  assert.strictEqual(rec.logs[0].extra.pid, 5000);
  assert.strictEqual(rec.logs[0].extra.local, 5433);
  rec.logs.length = 0;
  await s.exec(['down', 'prod-db'], { logger: rec });
  assert.deepStrictEqual(brief(rec), ['info:down:prod-db']);
  assert.strictEqual(rec.logs[0].extra.pid, 777);
  rec.logs.length = 0;
  await s.exec(['kill'], { logger: rec });
  assert.deepStrictEqual(brief(rec), ['info:kill']);
  assert.strictEqual(rec.logs[0].extra.count, 2);
  s.cleanup();
  s2.cleanup();
});

test('cli: a throwing logger never changes results or exit codes', async () => {
  const a = T('stg-db', 5433);
  const s = setup([a], { sessions: [session(a, 777)] });
  const boom = recorder(true);
  assert.strictEqual((await s.exec(NEW_ARGS, { logger: boom })).code, 0);
  assert.ok(s.read().tunnels.some((t) => t.name === 'new-db'));
  assert.strictEqual((await s.exec(['down', 'stg-db'], { logger: boom })).code, 0);
  assert.strictEqual((await s.exec(['kill'], { logger: boom })).code, 0);
  assert.strictEqual((await s.exec(['remove', 'new-db'], { logger: boom })).code, 0);
  s.cleanup();
});

// ---- logs command -------------------------------------------------------------

const LOCAL_NOW = new Date(2026, 0, 10, 12, 0, 0).getTime();
const at = (y, mo, d, h, mi, sec) => new Date(y, mo, d, h, mi, sec).getTime();
function logSetup(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-cli-logs-'));
  const file = path.join(dir, 'events.log');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify({
    t: new Date(e.ms).toISOString(), source: 'app', level: 'info', tunnel: null, event: 'x', message: 'm', ...e.f,
  })).join('\n') + '\n');
  const exec = (argv, over = {}) => run(argv, {
    store: { load() { throw new Error('logs must not read connections'); } },
    now: () => LOCAL_NOW, version: '9.9.9', logFile: file, env: {}, ...over,
  });
  return { dir, file, exec, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const SEED = () => [
  { ms: at(2026, 0, 8, 23, 59, 1), f: { message: 'two days ago', event: 'old' } },
  { ms: at(2026, 0, 10, 9, 5, 7), f: { tunnel: 'db-prod', event: 'connect', message: 'Connected', pid: 42 } },
  { ms: at(2026, 0, 10, 10, 0, 0), f: { level: 'warn', tunnel: 'db-prod', event: 'reconnect_scheduled', message: 'Retry in 2s' } },
  { ms: at(2026, 0, 10, 11, 30, 0), f: { source: 'cli', tunnel: 'cache', event: 'up', message: 'Started' } },
  { ms: at(2026, 0, 10, 11, 45, 0), f: { level: 'error', tunnel: 'cache', event: 'session_ended', message: 'Connection refused' } },
];

test('logs prints oldest -> newest, one line each: HH:MM:SS today, date+time when older', async () => {
  const l = logSetup(SEED());
  const r = await l.exec(['logs']);
  assert.strictEqual(r.code, 0);
  const lines = r.out.trimEnd().split('\n');
  assert.strictEqual(lines.length, 5);
  assert.match(lines[0], /^2026-01-08 23:59:01\s+info\s+app\s+-\s+old\s+two days ago$/);
  assert.match(lines[1], /^09:05:07\s+info\s+app\s+db-prod\s+connect\s+Connected$/);
  assert.match(lines[2], /^10:00:00\s+warn\s+app\s+db-prod\s+reconnect_scheduled\s+Retry in 2s$/);
  assert.match(lines[3], /^11:30:00\s+info\s+cli\s+cache\s+up\s+Started$/);
  assert.match(lines[4], /^11:45:00\s+error\s+app\s+cache\s+session_ended\s+Connection refused$/);
  assert.ok(!r.out.includes('\x1b['));
  l.cleanup();
});

test('logs -n limits to the newest N (still oldest -> newest); default is 50', async () => {
  const l = logSetup(SEED());
  const r = await l.exec(['logs', '-n', '2']);
  assert.deepStrictEqual(r.out.trimEnd().split('\n').map((x) => x.split(/\s+/)[4]), ['up', 'session_ended']);
  const many = logSetup(Array.from({ length: 80 }, (_, i) => ({ ms: LOCAL_NOW - (80 - i) * 1000, f: { message: `n${i}` } })));
  const d = await many.exec(['logs']);
  const out = d.out.trimEnd().split('\n');
  assert.strictEqual(out.length, 50);
  assert.match(out.at(-1), /n79$/);
  assert.strictEqual((await many.exec(['logs', '-n=3'])).out.trimEnd().split('\n').length, 3);
  l.cleanup();
  many.cleanup();
});

test('logs filters: --tunnel, --level (minimum), --source, --since', async () => {
  const l = logSetup(SEED());
  const events = async (argv) => (await l.exec(['logs', ...argv])).out.trimEnd().split('\n').filter(Boolean).map((x) => x.split(/\s+/).slice(-3)[0]);
  assert.deepStrictEqual((await l.exec(['logs', '--tunnel', 'cache'])).out.trimEnd().split('\n').length, 2);
  assert.deepStrictEqual((await l.exec(['logs', '--level', 'warn'])).out.trimEnd().split('\n').length, 2);
  assert.deepStrictEqual((await l.exec(['logs', '--level=error'])).out.trimEnd().split('\n').length, 1);
  assert.deepStrictEqual((await l.exec(['logs', '--source', 'cli'])).out.trimEnd().split('\n').length, 1);
  assert.strictEqual((await l.exec(['logs', '--since', 'today'])).out.trimEnd().split('\n').length, 4);
  assert.strictEqual((await l.exec(['logs', '--since', '1h'])).out.trimEnd().split('\n').length, 2);
  assert.strictEqual((await l.exec(['logs', '--since', '24h'])).out.trimEnd().split('\n').length, 4);
  assert.strictEqual((await l.exec(['logs', '--since', '7d'])).out.trimEnd().split('\n').length, 5);
  assert.strictEqual((await l.exec(['logs', '--tunnel', 'nope'])).out, 'No log entries.\n');
  assert.ok(events);
  l.cleanup();
});

test('logs --json prints one raw JSON object per line, oldest -> newest', async () => {
  const l = logSetup(SEED());
  const r = await l.exec(['logs', '--json', '-n', '2']);
  const rows = r.out.trimEnd().split('\n').map((x) => JSON.parse(x));
  assert.deepStrictEqual(rows.map((x) => x.event), ['up', 'session_ended']);
  assert.strictEqual(rows[0].source, 'cli');
  l.cleanup();
});

test('logs colours only on a TTY and not with NO_COLOR', async () => {
  const l = logSetup(SEED());
  assert.match((await l.exec(['logs'], { isTTY: true })).out, /\x1b\[/);
  assert.ok(!(await l.exec(['logs'], { isTTY: true, env: { NO_COLOR: '1' } })).out.includes('\x1b['));
  assert.ok(!(await l.exec(['logs'], { isTTY: false })).out.includes('\x1b['));
  l.cleanup();
});

test('logs with no file prints a friendly line (code 0); json prints nothing', async () => {
  const l = logSetup([]);
  fs.rmSync(l.file);
  assert.deepStrictEqual(await l.exec(['logs']), { code: 0, out: 'No log entries.\n', err: '' });
  assert.deepStrictEqual(await l.exec(['logs', '--json']), { code: 0, out: '', err: '' });
  l.cleanup();
});

test('logs bad flags and values are usage errors (code 2) that mention the problem', async () => {
  const l = logSetup(SEED());
  const bad = [['--bogus'], ['-x'], ['--level', 'debug'], ['--source', 'web'], ['--since', 'yesterday'], ['--since', '0h'],
    ['-n', '0'], ['-n', 'abc'], ['-n'], ['--tunnel'], ['extra'], ['--json=1']];
  for (const argv of bad) {
    const r = await l.exec(['logs', ...argv]);
    assert.strictEqual(r.code, 2, argv.join(' '));
    assert.match(r.err, /Usage: ssm-tunnels/);
    assert.strictEqual(r.out, '');
  }
  l.cleanup();
});

test('logs --follow prints the tail, then new entries as they arrive, until aborted (code 0)', async () => {
  const l = logSetup(SEED());
  const ac = new AbortController();
  const chunks = [];
  let waits = 0;
  const sleep = async (ms) => {
    assert.strictEqual(ms, 500);
    waits++;
    if (waits === 1) {
      fs.appendFileSync(l.file, `${JSON.stringify({ t: new Date(LOCAL_NOW).toISOString(), source: 'app', level: 'error', tunnel: 'cache', event: 'gave_up', message: 'Gave up' })}\n`);
    }
    if (waits === 2) ac.abort();
  };
  const r = await l.exec(['logs', '-f', '-n', '1'], { write: (s) => chunks.push(s), signal: ac.signal, sleep });
  assert.strictEqual(r.code, 0);
  const text = chunks.join('');
  const lines = text.trimEnd().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /session_ended/);
  assert.match(lines[1], /gave_up\s+Gave up$/);
  const r2 = await l.exec(['logs', '--follow', '--level', 'error'], { signal: AbortSignal.abort(), sleep: async () => {} });
  assert.strictEqual(r2.code, 0);
  assert.match(r2.out, /session_ended/);
  l.cleanup();
});

test('--help documents the logs command and its flags', async () => {
  const r = await run(['--help'], {});
  for (const needle of ['logs', '--follow', '--tunnel', '--level', '--source', '--since', '--json', 'SSM_TUNNELS_LOG']) {
    assert.ok(r.out.includes(needle), needle);
  }
});

// ---- own processes only; partial failures --------------------------------

const eperm = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; return e; };

test('kill tries every session when one throws EPERM, reports it, exits 1', withSetup(TUNNELS(), {}, async (s) => {
  const ss = [session(T('a', 1111), 4100), session(T('b', 2222), 4200), session(T('c', 3333), 4300)];
  s.state.sessions = ss;
  const killedPids = [];
  const scan = { scanSessions: async () => ss, matchSessions: scanLib.matchSessions,
    killSession: (x) => { if (x.pid === 4200) throw eperm(); killedPids.push(x.pid); } };
  const r = await s.exec(['kill'], { scan });
  assert.deepStrictEqual(killedPids, [4100, 4300]);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /pid 4200: operation not permitted/);
  assert.match(r.out, /Stopped 2 sessions/);
}));

test('down all tries every tunnel when one throws EPERM, exits 1', withSetup([T('a', 1111), T('b', 2222), T('c', 3333)], {}, async (s) => {
  const ss = [session(T('a', 1111), 4100), session(T('b', 2222), 4200), session(T('c', 3333), 4300)];
  const killedPids = [];
  const scan = { scanSessions: async () => ss, matchSessions: scanLib.matchSessions,
    killSession: (x) => { if (x.pid === 4200) throw eperm(); killedPids.push(x.pid); } };
  const r = await s.exec(['down', 'all'], { scan });
  assert.deepStrictEqual(killedPids, [4100, 4300]);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /b: operation not permitted/);
  assert.match(r.out, /a: stopped/);
  assert.match(r.out, /c: stopped/);
}));

test('kill with every session stopped exits 0', withSetup(TUNNELS(), {}, async (s) => {
  s.state.sessions = [session(T('a', 1111), 4100), session(T('b', 2222), 4200)];
  const r = await s.exec(['kill']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.err, '');
}));

test('other-uid look-alike sessions are not "already active" for up, and never killed', withSetup([T('stg-db', 5433)], {}, async (s) => {
  const t = T('stg-db', 5433);
  const line = (uid) => ` ${uid} 900 1 00:05 /opt/homebrew/bin/aws ssm start-session --region ${t.region} --target ${t.target} --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host=${t.host},portNumber=${t.port},localPortNumber=${t.local}`;
  const killedPids = [];
  const scan = { ...scanLib,
    scanSessions: () => scanLib.scanSessions({ uid: 501, execFile: (f, a, o, cb) => cb(null, line(0), '') }),
    isPortInUse: async () => false,
    killSession: (x) => { killedPids.push(x.pid); } };
  const up = await s.exec(['up', 'stg-db'], { scan });
  assert.doesNotMatch(up.out, /already active/);
  assert.strictEqual(s.spawned.length, 1);
  const kill = await s.exec(['kill'], { scan });
  assert.match(kill.out, /No active SSM sessions/);
  assert.deepStrictEqual(killedPids, []);
}));

// ---- review findings -------------------------------------------------------

test('#1 down records the stop in the shared file before killing, so a running app does not restart it', async () => {
  const x = T('x-db', 15002);
  const s = setup([x], { sessions: [session(x, 700)] });
  try {
    let atKill = null;
    const scan = { ...scanLib, scanSessions: async () => s.state.sessions, matchSessions: scanLib.matchSessions,
      killSession: () => { atKill = s.read().tunnels.find((t) => t.name === 'x-db').stopRequestedAt; } };
    const r = await s.exec(['down', 'x-db'], { scan });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(atKill, NOW, 'request written before the kill');
  } finally { s.cleanup(); }
});

test('#1 kill records a stop for every saved tunnel it stops', async () => {
  const x = T('x-db', 15002);
  const y = T('y-db', 15003);
  const s = setup([x, y], { sessions: [session(x, 700), session(y, 800)] });
  try {
    const r = await s.exec(['kill']);
    assert.strictEqual(r.code, 0);
    assert.deepStrictEqual(s.read().tunnels.map((t) => t.stopRequestedAt), [NOW, NOW]);
  } finally { s.cleanup(); }
});
