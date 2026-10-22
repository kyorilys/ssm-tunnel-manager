const { inferEnv } = require('./validate');
const { buildArgs } = require('./tunnelManager');
const { DAY } = require('./archive');
const { tailEntries, followEntries, fileSize, LEVELS } = require('./logger');

const USAGE = `Usage: ssm-tunnels <command> [options]

Manage the same saved connections as the SSM Tunnels app and start them from a terminal.

Commands:
  list [--json]                     Saved connections with state (active/idle)
  status [--json]                   Active aws ssm sessions, saved or not
  up <name...> | --auto | all       Start tunnels in the background
  down <name...> | all              Stop the matching sessions
  kill                              Stop every port-forward SSM session
  add <name> --region R --target i-... --host H --port P --local L
      [--desc D] [--env production|staging|other] [--auto] [--profile NAME]
  edit <name> [--name N] [--region R] [--target T] [--host H] [--port P]
      [--local L] [--desc D] [--env E] [--auto | --no-auto]
      [--profile NAME | --default-profile]
  (--profile sets the AWS CLI profile for the tunnel; --default-profile on edit clears it)
  remove <name>                     Delete a connection
  archived [--json]                 Archived connections and days until purge
  restore <name>                    Bring an archived connection back
  import <script>                   Import from an ssm-connect style bash script
  logs [-n N] [-f|--follow] [--tunnel NAME] [--level info|warn|error]
      [--source app|cli] [--since 1h|24h|today|7d] [--json]
                                    Show the event log shared with the app (default last 50)

Options:
  -h, --help                        Show this help
  --version                         Show the version

Notes:
  up starts each tunnel as a detached aws process and exits, so the CLI does not reconnect:
  a dropped session stays down until you run up again. The app reconnects dropped
  Auto tunnels while it is running.
  Data file: ~/Library/Application Support/SSM Tunnels/connections.json
  (override with SSM_TUNNELS_DATA). A running app picks up changes made here within a few seconds.
  Event log: ~/Library/Logs/SSM Tunnels/events.log (override with SSM_TUNNELS_LOG).
  Colour is used only on a terminal and is disabled by NO_COLOR.
  Exit codes: 0 success, 1 operational failure, 2 bad usage.
`;

const EDIT_FIELDS = ['name', 'region', 'target', 'host', 'port', 'local', 'desc', 'env', 'profile'];
const FIELD_FLAGS = ['region', 'target', 'host', 'port', 'local', 'desc', 'env', 'profile'];

const COMMANDS = {
  list: { spec: { boolean: ['json'] }, max: 0 },
  status: { spec: { boolean: ['json'] }, max: 0 },
  up: { spec: { boolean: ['auto'] } },
  down: { spec: {} },
  kill: { spec: {}, max: 0 },
  add: { spec: { boolean: ['auto'], string: FIELD_FLAGS }, min: 1, max: 1 },
  edit: { spec: { boolean: ['auto', 'no-auto', 'default-profile'], string: ['name', ...FIELD_FLAGS] }, min: 1, max: 1 },
  remove: { spec: {}, min: 1, max: 1 },
  archived: { spec: { boolean: ['json'] }, max: 0 },
  restore: { spec: {}, min: 1, max: 1 },
  import: { spec: {}, min: 1, max: 1 },
  logs: { spec: { boolean: ['follow', 'json'], string: ['n', 'tunnel', 'level', 'source', 'since'], alias: { f: 'follow', n: 'n' } }, max: 0 },
};

// Hand-written option parser: `--flag value`, `--flag=value`, `--` ends options.
function parseArgs(argv, spec = {}) {
  const bool = new Set(spec.boolean || []);
  const str = new Set(spec.string || []);
  const alias = spec.alias || {};
  const positionals = [];
  const flags = {};
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    const short = /^-([A-Za-z])(.*)$/.exec(arg);
    if (short && spec.alias) {
      const key = alias[short[1]];
      if (!key) { errors.push(`unknown option -${short[1]}`); continue; }
      if (bool.has(key)) {
        if (short[2]) errors.push(`-${short[1]} does not take a value`);
        else flags[key] = true;
      } else if (short[2]) flags[key] = short[2].replace(/^=/, '');
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else errors.push(`-${short[1]} needs a value`);
      continue;
    }
    if (!arg.startsWith('--') || arg.length === 2) { positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    if (bool.has(key)) {
      if (eq !== -1) errors.push(`--${key} does not take a value`);
      else flags[key] = true;
    } else if (str.has(key)) {
      if (eq !== -1) flags[key] = arg.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
      else errors.push(`--${key} needs a value`);
    } else {
      errors.push(`unknown option --${key}`);
    }
  }
  return { positionals, flags, errors };
}

const ANSI = { green: '32', red: '31', dim: '2', bold: '1', yellow: '33' };

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}

const forward = (t) => `${t.local} -> ${t.host}:${t.port}`;

// rows are string arrays; `paint[col]` colours a cell after padding so widths stay aligned.
function table(headers, rows, paint = {}, c = (_, s) => s) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells, isHeader) => cells.map((cell, i) => {
    const padded = i === cells.length - 1 ? cell : cell.padEnd(widths[i]);
    if (isHeader) return c('bold', padded);
    return paint[i] ? c(paint[i](cell), padded) : padded;
  }).join('  ').trimEnd();
  return `${[line(headers, true), ...rows.map((r) => line(r, false))].join('\n')}\n`;
}

const SINCE = /^(\d{1,4})([mhd])$/;
const SINCE_UNIT = { m: 60000, h: 3600000, d: DAY };
const LEVEL_COLOR = { info: 'dim', warn: 'yellow', error: 'red' };
const pad2 = (n) => String(n).padStart(2, '0');

function parseSince(value, at) {
  if (value === 'today') {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const m = SINCE.exec(value);
  return m && Number(m[1]) > 0 ? at - Number(m[1]) * SINCE_UNIT[m[2]] : null;
}

// HH:MM:SS for today, date + time for older entries.
function formatTime(ms, at) {
  const d = new Date(ms);
  const n = new Date(at);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? time : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

async function runLogs(flags, { deps, now, c, out, usageError, done }) {
  const at = now();
  const file = deps.logFile;
  const count = flags.n === undefined ? 50 : /^\d{1,5}$/.test(flags.n) ? Number(flags.n) : 0;
  if (!count) return usageError('logs: -n needs a positive whole number');
  if (flags.level !== undefined && !LEVELS.includes(flags.level)) return usageError('logs: --level must be info, warn or error');
  if (flags.source !== undefined && !['app', 'cli'].includes(flags.source)) return usageError('logs: --source must be app or cli');
  let since;
  if (flags.since !== undefined) {
    since = parseSince(flags.since, at);
    if (since === null) return usageError('logs: --since must be like 30m, 1h, 24h, 7d or today');
  }
  const filter = { since, level: flags.level, tunnel: flags.tunnel, source: flags.source };
  const emit = deps.write ? (text) => deps.write(text) : (text) => out.push(text);
  const render = (e) => {
    if (flags.json) return `${JSON.stringify(e)}\n`;
    const level = c(LEVEL_COLOR[e.level] || 'dim', e.level.padEnd(5));
    const time = c('dim', formatTime(Date.parse(e.t), at));
    return `${time}  ${level}  ${(e.source || '').padEnd(3)}  ${e.tunnel || '-'}  ${c('bold', e.event)}  ${e.message}\n`;
  };

  const offset = fileSize(file, deps.logFs);
  const entries = tailEntries({ file, n: count, fs: deps.logFs, ...filter });
  if (!entries.length && !flags.json && !flags.follow) emit('No log entries.\n');
  for (const e of entries) emit(render(e));
  if (flags.follow) {
    await followEntries({
      file, offset, filter, signal: deps.signal, fs: deps.logFs, sleep: deps.sleep,
      onEntries: (batch) => batch.forEach((e) => emit(render(e))),
    });
  }
  return done(0);
}

async function run(argv, deps) {
  const { store, scan, spawn, awsBin = 'aws', childEnv, now = Date.now, isTTY = false, env = {}, version = '0.0.0', logger } = deps;
  const out = [];
  const err = [];
  const useColor = Boolean(isTTY) && !env.NO_COLOR;
  const c = (name, text) => (useColor ? `\x1b[${ANSI[name]}m${text}\x1b[0m` : text);
  const done = (code) => ({ code, out: out.join(''), err: err.join('') });
  const usageError = (msg) => {
    return { code: 2, out: '', err: `${msg ? `ssm-tunnels: ${msg}\n\n` : ''}${USAGE}` };
  };
  const fail = (msg) => { err.push(`ssm-tunnels: ${msg}\n`); return done(1); };
  // Written before killing, so a running app treats the exit as intended instead of reconnecting.
  const recordStops = (names) => {
    if (!names.length) return;
    try { store.requestStop(names, now()); } catch (e) { err.push(`ssm-tunnels: could not record the stop for the app: ${e.message}\n`); }
  };
  // The event log must never change what a command does or returns.
  const log = (level, event, tunnel, message, extra) => {
    try { if (logger) logger.log(level, event, tunnel, message, extra); } catch { /* ignore */ }
  };

  if (argv.includes('--help') || argv.includes('-h')) return { code: 0, out: USAGE, err: '' };
  if (argv[0] === '--version') return { code: 0, out: `${version}\n`, err: '' };
  const [command, ...rest] = argv;
  if (!command) return usageError();
  const def = COMMANDS[command];
  if (!def) return usageError(`unknown command "${command}"`);

  const { positionals, flags, errors } = parseArgs(rest, def.spec);
  if (errors.length) return usageError(`${command}: ${errors[0]}`);
  const min = def.min ?? 0;
  if (positionals.length < min || (def.max !== undefined && positionals.length > def.max)) {
    return usageError(`${command}: ${min ? `expected ${def.max === 1 ? 'one name' : 'arguments'}` : 'unexpected arguments'}`);
  }

  if (command === 'logs') return runLogs(flags, { deps, now, c, out, usageError, done });

  try {
    store.load();
  } catch (e) {
    return fail(`cannot read connections: ${e.message}`);
  }
  if (store.recoveredFrom) err.push(`warning: connections file was unreadable; the old one was kept as ${store.recoveredFrom}\n`);

  const live = () => store.list().filter((t) => !t.archived);
  const envColor = (e) => (e === 'production' ? 'red' : e === 'staging' ? 'yellow' : 'dim');
  const stateColor = (s) => (s === 'active' ? 'green' : 'dim');

  async function scanSessions() {
    try {
      return { sessions: await scan.scanSessions() };
    } catch (e) {
      return { error: `could not scan processes: ${e.message}` };
    }
  }

  const unknownName = (name) => `no saved connection named "${name}"`;

  function reportErrors(prefix, errs) {
    err.push(`ssm-tunnels: ${prefix}\n`);
    for (const [field, msg] of Object.entries(errs)) err.push(`  ${field}: ${msg}\n`);
  }

  function warnClashes(clashes, local) {
    for (const k of clashes || []) err.push(`warning: local port ${local} is also used by ${k.name}${k.auto ? ' (auto)' : ''}; only one can run at a time\n`);
  }

  // ---- read-only views ---------------------------------------------------

  if (command === 'list') {
    const scanned = await scanSessions();
    if (scanned.error) err.push(`warning: ${scanned.error}; states unknown\n`);
    const matched = scanned.sessions ? scan.matchSessions(scanned.sessions, live()).matched : new Map();
    const rows = live().map((t) => {
      const s = matched.get(t.name);
      return { ...t, state: scanned.error ? 'unknown' : s ? 'active' : 'idle', pid: s ? s.pid : null };
    });
    if (flags.json) {
      out.push(`${JSON.stringify(rows.map((t) => ({
        name: t.name, env: t.env, region: t.region, target: t.target, host: t.host, port: t.port,
        local: t.local, desc: t.desc, auto: t.auto, profile: t.profile || '', state: t.state, pid: t.pid,
      })), null, 2)}\n`);
    } else if (!rows.length) {
      out.push('No saved connections.\n');
    } else {
      const withProfile = rows.some((t) => t.profile);
      out.push(withProfile
        ? table(['NAME', 'ENV', 'FORWARD', 'PROFILE', 'AUTO', 'STATE'],
          rows.map((t) => [t.name, t.env, forward(t), t.profile || '-', t.auto ? 'auto' : '-', t.state]),
          { 1: envColor, 5: stateColor }, c)
        : table(['NAME', 'ENV', 'FORWARD', 'AUTO', 'STATE'],
          rows.map((t) => [t.name, t.env, forward(t), t.auto ? 'auto' : '-', t.state]),
          { 1: envColor, 4: stateColor }, c));
    }
    return done(0);
  }

  if (command === 'status') {
    const scanned = await scanSessions();
    if (scanned.error) return fail(scanned.error);
    const { matched } = scan.matchSessions(scanned.sessions, live());
    const names = new Map([...matched].map(([name, s]) => [s, name]));
    const rows = scanned.sessions.map((s) => ({ name: names.get(s) || null, managed: names.has(s), s }));
    if (flags.json) {
      out.push(`${JSON.stringify(rows.map(({ name, managed, s }) => ({
        name, managed, pid: s.pid, region: s.region, target: s.target, host: s.host,
        port: s.port, local: s.local, uptimeSec: s.etimeSec,
      })), null, 2)}\n`);
    } else if (!rows.length) {
      out.push('No active SSM sessions.\n');
    } else {
      out.push(table(['NAME', 'FORWARD', 'PID', 'UPTIME'],
        rows.map(({ name, s }) => [name || 'terminal/unmanaged', forward(s), `pid ${s.pid}`, formatDuration(s.etimeSec)]),
        { 0: (v) => (v === 'terminal/unmanaged' ? 'yellow' : 'green') }, c));
    }
    return done(0);
  }

  if (command === 'archived') {
    const { purgeDays } = store.data.settings;
    const rows = store.list().filter((t) => t.archived).map((t) => {
      const daysUntilPurge = !purgeDays ? null
        : t.archivedAt == null ? purgeDays
          : Math.max(0, Math.ceil((t.archivedAt + purgeDays * DAY - now()) / DAY));
      return { t, daysUntilPurge };
    });
    if (flags.json) {
      out.push(`${JSON.stringify(rows.map(({ t, daysUntilPurge }) => ({
        name: t.name, env: t.env, region: t.region, target: t.target, host: t.host, port: t.port,
        local: t.local, desc: t.desc, archivedAt: t.archivedAt, daysUntilPurge,
      })), null, 2)}\n`);
    } else if (!rows.length) {
      out.push('No archived connections.\n');
    } else {
      out.push(table(['NAME', 'ENV', 'FORWARD', 'PURGED IN'],
        rows.map(({ t, daysUntilPurge }) => [t.name, t.env, forward(t),
          daysUntilPurge === null ? 'never' : `${daysUntilPurge} day${daysUntilPurge === 1 ? '' : 's'}`]),
        { 1: envColor }, c));
    }
    return done(0);
  }

  // ---- processes ---------------------------------------------------------

  if (command === 'up') {
    if (flags.auto && positionals.length) return usageError('up: --auto cannot be combined with names');
    if (!flags.auto && !positionals.length) return usageError('up: give tunnel names, --auto or all');
    let targets;
    let failed = false;
    if (flags.auto) targets = live().filter((t) => t.auto);
    else if (positionals.length === 1 && positionals[0] === 'all') targets = live();
    else {
      targets = [];
      for (const name of positionals) {
        const t = store.get(name);
        if (!t) { err.push(`ssm-tunnels: ${unknownName(name)}\n`); failed = true; } else targets.push(t);
      }
    }
    if (!targets.length && !failed) out.push('Nothing to start.\n');
    const scanned = targets.length ? await scanSessions() : { sessions: [] };
    if (scanned.error) return fail(scanned.error);
    const { matched } = scan.matchSessions(scanned.sessions, live());
    const claimed = new Map();
    for (const t of targets) {
      if (t.archived) {
        err.push(`ssm-tunnels: ${t.name}: archived; run "ssm-tunnels restore ${t.name}" first\n`);
        failed = true;
      } else if (matched.has(t.name)) {
        out.push(`${t.name}: already active (pid ${matched.get(t.name).pid})\n`);
      } else if (claimed.has(t.local)) {
        err.push(`ssm-tunnels: ${t.name}: local port ${t.local} is used by ${claimed.get(t.local)}, started in this run\n`);
        failed = true;
      } else if (await scan.isPortInUse(t.local)) {
        err.push(`ssm-tunnels: ${t.name}: local port ${t.local} is already in use\n`);
        failed = true;
      } else {
        let proc;
        try {
          proc = spawn(awsBin, buildArgs(t), { detached: true, stdio: 'ignore', env: childEnv });
          if (proc && typeof proc.on === 'function') proc.on('error', () => {});
        } catch (e) {
          proc = null;
          err.push(`ssm-tunnels: ${t.name}: could not start aws: ${e.message}\n`);
          failed = true;
          continue;
        }
        if (!proc || !proc.pid) {
          err.push(`ssm-tunnels: ${t.name}: could not start aws (is it installed and on PATH?)\n`);
          failed = true;
          continue;
        }
        if (typeof proc.unref === 'function') proc.unref();
        claimed.set(t.local, t.name);
        log('info', 'up', t.name, 'Started', { pid: proc.pid, local: t.local });
        out.push(`${t.name}: started (pid ${proc.pid}), localhost:${t.local}; run "ssm-tunnels status" to confirm\n`);
      }
    }
    return done(failed ? 1 : 0);
  }

  if (command === 'down') {
    if (!positionals.length) return usageError('down: give tunnel names or all');
    const all = positionals.length === 1 && positionals[0] === 'all';
    let failed = false;
    const targets = [];
    if (all) targets.push(...store.list());
    else {
      for (const name of positionals) {
        const t = store.get(name);
        if (!t) { err.push(`ssm-tunnels: ${unknownName(name)}\n`); failed = true; } else targets.push(t);
      }
    }
    const scanned = await scanSessions();
    if (scanned.error) return fail(scanned.error);
    const { matched } = scan.matchSessions(scanned.sessions, store.list());
    recordStops(targets.filter((t) => matched.has(t.name)).map((t) => t.name));
    let stopped = 0;
    for (const t of targets) {
      const s = matched.get(t.name);
      if (!s) { if (!all) out.push(`${t.name}: not running\n`); continue; }
      try {
        scan.killSession(s);
        stopped++;
        log('info', 'down', t.name, 'Stopped', { pid: s.pid, local: t.local });
        out.push(`${t.name}: stopped (pid ${s.pid})\n`);
      } catch (e) {
        err.push(`ssm-tunnels: ${t.name}: ${e.message}\n`);
        failed = true;
      }
    }
    if (all && !stopped && !failed) out.push('No saved tunnels were running.\n');
    return done(failed ? 1 : 0);
  }

  if (command === 'kill') {
    const scanned = await scanSessions();
    if (scanned.error) return fail(scanned.error);
    if (!scanned.sessions.length) { out.push('No active SSM sessions.\n'); return done(0); }
    recordStops([...scan.matchSessions(scanned.sessions, store.list()).matched.keys()]);
    let stopped = 0;
    let failed = false;
    for (const s of scanned.sessions) {
      try {
        scan.killSession(s);
        stopped++;
      } catch (e) {
        err.push(`ssm-tunnels: pid ${s.pid}: ${e.message}\n`);
        failed = true;
      }
    }
    if (stopped) log('info', 'kill', null, `Stopped ${stopped} session${stopped === 1 ? '' : 's'}`, { count: stopped });
    out.push(`Stopped ${stopped} session${stopped === 1 ? '' : 's'}.\n`);
    return done(failed ? 1 : 0);
  }

  // ---- changes to the saved connections ----------------------------------

  if (command === 'add') {
    const missing = ['region', 'target', 'host', 'port', 'local'].filter((k) => flags[k] === undefined);
    if (missing.length) return usageError(`add: missing ${missing.map((k) => `--${k}`).join(', ')}`);
    const name = positionals[0];
    const result = store.add({
      name, region: flags.region, target: flags.target, host: flags.host, port: flags.port, local: flags.local,
      desc: flags.desc || '', env: flags.env === undefined ? inferEnv(name) : flags.env, auto: Boolean(flags.auto), profile: flags.profile,
    });
    if (!result.ok) { reportErrors(`could not add "${name}"`, result.errors); return done(1); }
    warnClashes(result.clashes, result.tunnel.local);
    const t = result.tunnel;
    log('info', 'added', t.name, 'Added', { local: t.local, port: t.port });
    out.push(`Saved ${t.name}: ${t.env}, ${forward(t)}, region ${t.region}, ${t.target}${t.auto ? ', auto' : ''}${t.desc ? `, "${t.desc}"` : ''}\n`);
    return done(0);
  }

  if (command === 'edit') {
    if (flags.auto && flags['no-auto']) return usageError('edit: use either --auto or --no-auto');
    if (flags['default-profile'] && flags.profile !== undefined) return usageError('edit: use either --profile or --default-profile');
    const changes = {};
    for (const k of EDIT_FIELDS) if (flags[k] !== undefined) changes[k] = flags[k];
    if (flags['default-profile']) changes.profile = '';
    if (flags.auto) changes.auto = true;
    if (flags['no-auto']) changes.auto = false;
    if (!Object.keys(changes).length) return usageError('edit: nothing to change');
    const name = positionals[0];
    const existing = store.get(name);
    if (!existing) return fail(unknownName(name));
    const result = store.update(name, { ...existing, ...changes });
    if (!result.ok) { reportErrors(`could not edit "${name}"`, result.errors); return done(1); }
    warnClashes(result.clashes, result.tunnel.local);
    const t = result.tunnel;
    log('info', 'edited', t.name, 'Edited', { local: t.local, port: t.port });
    out.push(`Updated ${t.name}: ${t.env}, ${forward(t)}, region ${t.region}, ${t.target}${t.auto ? ', auto' : ''}\n`);
    return done(0);
  }

  if (command === 'remove') {
    const r = store.remove(positionals[0]);
    if (!r.ok) return fail(unknownName(positionals[0]));
    log('info', 'removed', r.tunnel.name, 'Removed', { local: r.tunnel.local });
    out.push(`Removed ${r.tunnel.name}\n`);
    return done(0);
  }

  if (command === 'restore') {
    const t = store.get(positionals[0]);
    if (!t) return fail(unknownName(positionals[0]));
    if (!t.archived) return fail(`${t.name} is not archived`);
    store.restore(t.name);
    log('info', 'restored', t.name, 'Restored from the archive', {});
    out.push(`Restored ${t.name}\n`);
    return done(0);
  }

  // import
  const r = store.importFromScript(positionals[0]);
  if (!r.ok) return fail(`cannot import: ${r.error}`);
  log('info', 'imported', null, `Imported ${r.added.length} tunnel${r.added.length === 1 ? '' : 's'}`, { count: r.added.length, skipped: r.skipped.length });
  out.push(`Added ${r.added.length}${r.added.length ? `: ${r.added.join(', ')}` : ''}\n`);
  if (r.skipped.length) {
    out.push(`Skipped ${r.skipped.length}:\n`);
    for (const s of r.skipped) out.push(`  ${s.name}: ${Object.entries(s.errors).map(([f, m]) => `${f}: ${m}`).join('; ')}\n`);
  }
  return done(0);
}

module.exports = { parseArgs, run, USAGE };
