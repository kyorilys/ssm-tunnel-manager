const net = require('node:net');
const path = require('node:path');

const DOC = 'AWS-StartPortForwardingSessionToRemoteHost';
const { REGION_RE } = require('./validate');
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/; // uid pid ppid etime command
const ARGV0_RE = /^(aws|python[\d.]*|Python)$/;

// Seconds from ps etime: [[dd-]hh:]mm:ss.
function parseEtime(str) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(str).trim());
  if (!m) return 0;
  const [, d, h, mi, s] = m;
  return Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(mi) * 60 + Number(s);
}

// Balanced {...} substring starting at text[start] === '{', ignoring braces inside strings.
function balanced(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

const port = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
};

const flag = (cmd, name) => {
  const m = new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)(\\S+)`).exec(cmd);
  return m ? m[1] : null;
};

function awsParameters(cmd) {
  const m = /(?:^|\s)--parameters(?:=|\s+)/.exec(cmd);
  if (!m) return null;
  const at = m.index + m[0].length;
  if (cmd[at] === '{') {
    try {
      const p = JSON.parse(balanced(cmd, at));
      return { host: p.host && p.host[0], portNumber: p.portNumber && p.portNumber[0], localPortNumber: p.localPortNumber && p.localPortNumber[0] };
    } catch { return null; }
  }
  const out = {};
  for (const pair of (/^\S+/.exec(cmd.slice(at)) || [''])[0].split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function build(region, target, host, portNumber, localPortNumber) {
  const p = port(portNumber);
  const local = port(localPortNumber);
  if (typeof target !== 'string' || !target || typeof host !== 'string' || !host || !p || !local) return null;
  return { region: REGION_RE.test(region || '') ? region : null, target, host, port: p, local };
}

function parseAws(cmd) {
  const tokens = cmd.split(/\s+/);
  if (!ARGV0_RE.test(path.basename(tokens[0]))) return null;
  const i = tokens.indexOf('ssm');
  if (i < 1 || path.basename(tokens[i - 1]) !== 'aws' || tokens[i + 1] !== 'start-session') return null;
  if (flag(cmd, 'document-name') !== DOC) return null;
  const params = awsParameters(cmd);
  if (!params) return null;
  return build(flag(cmd, 'region'), flag(cmd, 'target'), params.host, params.portNumber, params.localPortNumber);
}

function parsePlugin(cmd) {
  const tokens = cmd.split(/\s+/);
  if (path.basename(tokens[0]) !== 'session-manager-plugin') return null;
  const start = /\{\s*"Target"/.exec(cmd);
  if (!start) return null;
  let obj;
  try { obj = JSON.parse(balanced(cmd, start.index)); } catch { return null; }
  if (!obj || obj.DocumentName !== DOC || !obj.Parameters) return null;
  const rm = /(\S+)\s+StartSession\s/.exec(cmd);
  const { host, portNumber, localPortNumber } = obj.Parameters;
  return build(rm ? rm[1] : null, obj.Target, host && host[0], portNumber && portNumber[0], localPortNumber && localPortNumber[0]);
}

// Parse `ps -axww -o uid=,pid=,ppid=,etime=,command=` into port-forward sessions.
// Only processes owned by `uid` are considered (other users' look-alikes are dropped before grouping, so
// they can never be matched or signalled); lines without a parsable uid are dropped too.
// The raw command line is never kept.
function parsePs(text, { uid } = {}) {
  if (!Number.isInteger(uid) || uid < 0) throw new TypeError('parsePs needs the uid to keep');
  const aws = new Map();
  const plugins = [];
  for (const line of String(text).split('\n')) {
    const m = PS_LINE.exec(line.replace(/\r$/, ''));
    if (!m || Number(m[1]) !== uid) continue;
    const entry = { pid: Number(m[2]), ppid: Number(m[3]), etimeSec: parseEtime(m[4]) };
    const a = parseAws(m[5]);
    if (a) { aws.set(entry.pid, { ...entry, ...a, order: aws.size + plugins.length }); continue; }
    const p = parsePlugin(m[5]);
    if (p) plugins.push({ ...entry, ...p, order: aws.size + plugins.length });
  }

  const sessions = [];
  for (const a of aws.values()) sessions.push({ ...a, pids: [a.pid], orphan: false });
  for (const p of plugins) {
    const parent = aws.get(p.ppid);
    if (parent) {
      const s = sessions.find((x) => x.pid === parent.pid);
      s.pids.push(p.pid);
      if (!s.region) s.region = p.region;
    } else {
      sessions.push({ ...p, pids: [p.pid], orphan: true });
    }
  }
  return sessions
    .sort((x, y) => x.order - y.order)
    .map(({ pid, ppid, pids, region, target, host, port: pt, local, etimeSec, orphan }) =>
      ({ pid, ppid, pids, region, target, host, port: pt, local, etimeSec, orphan }));
}

function matchSessions(sessions, tunnels, ownedPids = new Set()) {
  const matched = new Map();
  const unmatched = [];
  for (const s of sessions) {
    if (ownedPids.has(s.pid) || ownedPids.has(s.ppid)) continue;
    const t = tunnels.find((x) =>
      x.target === s.target && x.port === s.port && x.local === s.local &&
      String(x.host).toLowerCase() === String(s.host).toLowerCase() &&
      (s.region === null || x.region === s.region));
    if (t && !matched.has(t.name)) matched.set(t.name, s);
    else unmatched.push(s);
  }
  return { matched, unmatched };
}

function runPs({ execFile = require('node:child_process').execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-axww', '-o', 'uid=,pid=,ppid=,etime=,command='], { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

async function scanSessions({ uid = process.getuid(), ...opts } = {}) {
  return parsePs(await runPs(opts), { uid });
}

// 'busy' | 'free' | 'skip' (address family unavailable) | 'error'
function probe(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve('busy');
      else if (host === '::1' && (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')) resolve('skip');
      else resolve('error');
    });
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve('free')));
  });
}

async function isPortInUse(port) {
  for (const host of ['127.0.0.1', '::1']) {
    const r = await probe(port, host);
    if (r === 'busy') return true;
    if (r === 'error') return false;
  }
  return false;
}

// Children (plugin) first, then the aws pid. Returns the pids actually signalled.
function killSession(session, { kill = process.kill, signal = 'SIGTERM' } = {}) {
  const [head, ...rest] = session.pids;
  const order = session.orphan ? session.pids : [...rest, head];
  const done = [];
  for (const pid of order) {
    if (!Number.isInteger(pid) || pid <= 1) continue; // 0 / -1 would signal whole process groups
    try {
      kill(pid, signal);
      done.push(pid);
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  }
  return done;
}

module.exports = { parsePs, parseEtime, matchSessions, runPs, scanSessions, isPortInUse, killSession };
