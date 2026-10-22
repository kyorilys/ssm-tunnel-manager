const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEVELS = ['info', 'warn', 'error'];
const LEVEL_RANK = { info: 0, warn: 1, error: 2 };
const LOCK_STALE_MS = 10000;
const MAX_MESSAGE = 500;
const CORE_KEYS = new Set(['t', 'source', 'level', 'tunnel', 'event', 'message']);

function defaultLogFile(env = process.env, home = os.homedir()) {
  if (env && env.SSM_TUNNELS_LOG) return env.SSM_TUNNELS_LOG;
  return path.join(home, 'Library', 'Logs', 'SSM Tunnels', 'events.log');
}

// ---- privacy ---------------------------------------------------------------

const REDACTED = '[redacted]';
const SECRET_FIELD = /\\?"?(?:TokenValue|StreamUrl|SessionId)\\?"?\s*[:=]\s*(?:\\?"[^"]*"|[^\s,}]+)/gi;
const CREDENTIAL_FIELD = /(?:secret[_-]?access[_-]?key|session[_-]?token|aws[_-]?session[_-]?token)\s*[:=]\s*\S+/gi;
const ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const SSM_URL = /wss?:\/\/\S+/gi;
const START_SESSION = /\baws\s+ssm\s+start-session\b[^\n]*/g;
const PLUGIN_ARGS = /\bsession-manager-plugin\b[^\n]*/g;
const LONG_RUN = /[A-Za-z0-9+/_=-]{40,}/g;

const looksLikeSecret = (run) => /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run);

// Removes anything that could let a reader open or replay an SSM session. Applied to every message and extra string.
function redact(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  const marker = out.indexOf('AWS_SSM_START_SESSION_RESPONSE');
  if (marker !== -1) out = `${out.slice(0, marker)}${REDACTED}`;
  return out
    .replace(START_SESSION, `aws ssm start-session ${REDACTED}`)
    .replace(PLUGIN_ARGS, `session-manager-plugin ${REDACTED}`)
    .replace(SECRET_FIELD, REDACTED)
    .replace(CREDENTIAL_FIELD, REDACTED)
    .replace(SSM_URL, REDACTED)
    .replace(ACCESS_KEY, REDACTED)
    .replace(LONG_RUN, (run) => (looksLikeSecret(run) ? REDACTED : run));
}

const cap = (s) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE - 1)}…` : s);
const clean = (s) => cap(redact(s));

// Redacts every string inside an extra value (arrays and plain objects included).
function sanitize(value, depth = 0) {
  if (typeof value === 'string') return clean(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[truncated]'; // deeper than any real extra: never pass unredacted strings through
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, depth + 1);
  return out;
}

// ---- writing ---------------------------------------------------------------

function createLogger({ file = defaultLogFile(), source = 'app', now = Date.now, fs = nodeFs, maxBytes = 1048576, keep = 5 } = {}) {
  const lock = `${file}.lock`;

  function takeLock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
        return true;
      } catch (err) {
        if (!err || err.code !== 'EEXIST') return false;
        try {
          if (now() - fs.statSync(lock).mtimeMs <= LOCK_STALE_MS) return false;
          fs.unlinkSync(lock); // stale: its owner died or hung
        } catch {
          return false;
        }
      }
    }
    return false;
  }

  const sizeOf = () => {
    try { return fs.statSync(file).size; } catch { return 0; }
  };

  function shift() {
    const rm = (p) => { try { fs.unlinkSync(p); } catch { /* already gone */ } };
    rm(`${file}.${keep}`);
    for (let i = keep - 1; i >= 1; i--) {
      try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    fs.renameSync(file, `${file}.1`);
  }

  // Never waits: a process that cannot take the lock just appends, the lock holder does the work.
  function rotateIfNeeded() {
    if (sizeOf() < maxBytes || !takeLock()) return;
    try {
      if (sizeOf() >= maxBytes) shift(); // re-check: the other process may have rotated meanwhile
    } catch {
      // rotation is best effort; the entry is still appended
    } finally {
      try { fs.unlinkSync(lock); } catch { /* ignore */ }
    }
  }

  function log(level, event, tunnel, message, extra) {
    try {
      const entry = {
        t: new Date(now()).toISOString(),
        source,
        level: LEVELS.includes(level) ? level : 'info',
        tunnel: typeof tunnel === 'string' && tunnel ? clean(tunnel) : null,
        event: String(event),
        message: clean(String(message ?? '')),
      };
      for (const [k, v] of Object.entries(extra || {})) if (!CORE_KEYS.has(k) && v !== undefined) entry[k] = sanitize(v);
      const line = `${JSON.stringify(entry)}\n`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotateIfNeeded();
      fs.appendFileSync(file, line);
      return true;
    } catch {
      return false;
    }
  }

  return { log, file, maxBytes, keep, source };
}

// ---- reading ---------------------------------------------------------------

function parseLine(line) {
  if (!line) return null;
  try {
    const e = JSON.parse(line);
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    const ms = Date.parse(e.t);
    if (Number.isNaN(ms) || typeof e.event !== 'string') return null;
    return { ...e, ms };
  } catch {
    return null; // corrupt or partially written line
  }
}

function matcher({ since, level, tunnel, source, search } = {}) {
  const min = LEVEL_RANK[level] ?? 0;
  const needle = typeof search === 'string' && search ? search.toLowerCase() : null;
  return (e) => {
    if (since != null && e.ms < since) return false;
    if ((LEVEL_RANK[e.level] ?? 0) < min) return false;
    if (tunnel && e.tunnel !== tunnel) return false;
    if (source && e.source !== source) return false;
    if (needle && !`${e.message} ${e.event} ${e.tunnel ?? ''}`.toLowerCase().includes(needle)) return false;
    return true;
  };
}

const strip = ({ ms, ...entry }) => entry; // eslint-disable-line no-unused-vars

// Newest first. Reads events.log and its rotated siblings; unreadable files and bad lines are skipped.
function readEntries({ file, since, level, tunnel, source, search, limit = 1000, fs = nodeFs, keep = 5 } = {}) {
  const ok = matcher({ since, level, tunnel, source, search });
  const found = [];
  const files = [file, ...Array.from({ length: keep }, (_, i) => `${file}.${i + 1}`)];
  files.forEach((f, fileIndex) => {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { return; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const e = parseLine(lines[i]);
      if (e && ok(e)) found.push({ e, order: fileIndex * 1e9 + (lines.length - i) });
    }
  });
  found.sort((a, b) => b.e.ms - a.e.ms || a.order - b.order);
  return found.slice(0, limit).map((x) => strip(x.e));
}

// The last `n` matching entries, oldest first (what `ssm-tunnels logs` prints).
function tailEntries({ n = 50, ...filters } = {}) {
  return readEntries({ ...filters, limit: n }).reverse();
}

function fileSize(file, fs = nodeFs) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

// Polls the file every intervalMs (no fs.watch) and hands new complete lines to onEntries until `signal` aborts.
// Starts at `offset` (default: the current end). A rotated file (new inode or shrunk) is followed by reading the
// unread rest of events.log.1 first, then the new file from the start.
async function followEntries({ file, onEntries, filter, signal, offset, intervalMs = 500, fs = nodeFs,
  sleep = (ms, sig) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (sig) sig.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  }) } = {}) {
  const ok = matcher(filter);
  const stat = () => { try { return fs.statSync(file); } catch { return null; } };
  const first = stat();
  let pos = offset ?? (first ? first.size : 0);
  let ino = first ? first.ino : null;

  const readFrom = (f, from) => {
    let buf;
    try { buf = fs.readFileSync(f); } catch { return from; }
    if (buf.length <= from) return buf.length;
    const end = buf.lastIndexOf(0x0a);
    if (end < from) return from; // only a partial line so far
    const entries = buf.subarray(from, end + 1).toString('utf8').split('\n').map(parseLine).filter((e) => e && ok(e)).map(strip);
    if (entries.length) onEntries(entries);
    return end + 1;
  };

  const poll = () => {
    const s = stat();
    if (!s) return;
    if ((ino !== null && s.ino !== ino) || s.size < pos) {
      readFrom(`${file}.1`, pos);
      pos = 0;
    }
    ino = s.ino;
    pos = readFrom(file, pos);
  };

  while (true) {
    await sleep(intervalMs, signal);
    try { poll(); } catch { /* keep following */ }
    if (signal && signal.aborted) break;
  }
}

module.exports = {
  createLogger, defaultLogFile, redact, readEntries, tailEntries, followEntries, fileSize,
  LEVELS, LOCK_STALE_MS,
};
