const { EventEmitter } = require('node:events');
const { spawn: nodeSpawn } = require('node:child_process');

const BASE_MS = 2000;
const MAX_MS = 60000;
const MAX_RETRIES = 5;
const { STABLE_MS, SIGNIN_ERROR } = require('./validate');
// aws prints this warning (and a docs link) at the start of every session with an older plugin; it is never the error.
const NOISE = /^(WARNING: An outdated SessionManagerPlugin|For more information, refer|https?:\/\/)/;

const backoffMs = (attempt) => Math.min(BASE_MS * 2 ** attempt, MAX_MS);

const buildArgs = (t) => [
  'ssm', 'start-session',
  '--region', t.region,
  '--target', t.target,
  '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
  '--parameters', `host=${t.host},portNumber=${t.port},localPortNumber=${t.local}`,
  ...(t.profile ? ['--profile', t.profile] : []),
];

class TunnelManager extends EventEmitter {
  constructor({ awsBin = 'aws', env = process.env, spawn = nodeSpawn,
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
    kill = (proc, signal) => proc.kill(signal), stderrSink = null, shouldRetry = () => true } = {}) {
    super();
    // shouldRetry(name) -> false marks an unexpected exit as intended (e.g. `ssm-tunnels down`), so it is not retried.
    Object.assign(this, { awsBin, env, spawn, setTimer, clearTimer, now, kill, stderrSink, shouldRetry });
    this.entries = new Map();
  }

  get(name) {
    const e = this.entries.get(name);
    if (!e) {
      return { state: 'idle', pid: null, since: null, error: null, errorAt: null, failingSince: null,
        attempt: 0, maxAttempts: MAX_RETRIES, nextAt: null, gaveUp: false };
    }
    return { state: e.state, pid: e.pid, since: e.since, error: e.error, errorAt: e.errorAt,
      failingSince: e.failingSince, attempt: e.attempts, maxAttempts: MAX_RETRIES,
      nextAt: e.nextAt, gaveUp: e.gaveUp };
  }

  _set(name, patch) {
    const e = this.entries.get(name);
    Object.assign(e, patch);
    this.emit('change', name, this.get(name));
  }

  _clearTimer(e) {
    if (e.timer) { this.clearTimer(e.timer); e.timer = null; }
    e.nextAt = null;
  }

  _reset(e) {
    this._clearTimer(e);
    Object.assign(e, { attempts: 0, gaveUp: false, failingSince: null });
  }

  // User action: wipes the retry bookkeeping, then spawns. Running entries are left alone.
  connect(tunnel) {
    let e = this.entries.get(tunnel.name);
    if (e && e.proc) {
      // Still exiting after a disconnect: start again once it has closed and freed the port.
      if (!e.wanted) { e.tunnel = tunnel; e.appliedAuto = Boolean(tunnel.auto); e.restartOnExit = true; }
      return;
    }
    if (!e) {
      e = { tunnel, state: 'idle', pid: null, since: null, error: null, errorAt: null, failingSince: null,
        attempts: 0, nextAt: null, gaveUp: false, proc: null, timer: null, wanted: true, restartOnExit: false };
      this.entries.set(tunnel.name, e);
    }
    e.tunnel = tunnel;
    e.appliedAuto = Boolean(tunnel.auto);
    this._reset(e);
    this._start(e);
  }

  retry(name) {
    const e = this.entries.get(name);
    if (!e || e.proc) return;
    this._reset(e);
    this._start(e);
  }

  // Spawns without touching the retry counters (used by the backoff timer and wake).
  _start(e) {
    const { tunnel } = e;
    const name = tunnel.name;
    e.wanted = true;
    this._set(name, { state: 'connecting', error: null, nextAt: null });

    let stderr = '';
    // A file sink keeps the session alive if the app quits first: a pipe to a closed app kills it on its next write.
    const sink = this.stderrSink ? this.stderrSink(name) : null;
    let proc;
    try {
      proc = this.spawn(this.awsBin, buildArgs(tunnel), { env: this.env, stdio: ['ignore', 'ignore', sink ? sink.fd : 'pipe'] });
    } finally {
      if (sink) sink.release();
    }
    e.proc = proc;
    proc.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-1000); });
    proc.on('error', (err) => { stderr = String(err.message); });
    // 'close' (not 'exit'): fires after stdio ends, so late stderr is kept, and also after a spawn 'error'.
    proc.on('close', () => this._onExit(name, proc, sink ? `${stderr}\n${sink.read()}` : stderr));
    this._set(name, { state: 'active', pid: proc.pid, since: this.now() });
  }

  _onExit(name, proc, stderr) {
    const e = this.entries.get(name);
    if (!e || e.proc !== proc) return; // stale process
    e.proc = null;
    if (!e.wanted) {
      if (e.restartOnExit) {
        e.restartOnExit = false;
        e.wanted = true;
        this._reset(e);
        return this._start(e);
      }
      return this._set(name, { state: 'idle', pid: null, since: null, nextAt: null });
    }
    if (!this.shouldRetry(name)) return this._stopped(e);

    const at = this.now();
    if (at - e.since >= STABLE_MS) { e.attempts = 0; e.failingSince = null; }
    const error = stderr.split('\n').map((l) => l.trim()).filter((l) => l && !NOISE.test(l)).pop() || 'Session ended';
    const failure = { pid: null, error, errorAt: at, failingSince: e.failingSince ?? at };

    // Expired sign-in: retrying cannot help and would burn the budget. Wait for resumeWaiting() after a new login.
    if (SIGNIN_ERROR.test(error)) return this._set(name, { ...failure, state: 'waiting', gaveUp: false, nextAt: null });

    if (!e.tunnel.auto) return this._set(name, { ...failure, state: 'failed', gaveUp: false });
    if (e.attempts >= MAX_RETRIES) {
      return this._set(name, { ...failure, state: 'failed', gaveUp: true, nextAt: null,
        error: `Gave up after ${MAX_RETRIES} attempts: ${error}` });
    }
    this._scheduleRetry(e, failure);
  }

  _scheduleRetry(e, patch = {}) {
    const delay = backoffMs(e.attempts++);
    e.timer = this.setTimer(() => {
      e.timer = null;
      if (!this.shouldRetry(e.tunnel.name)) return this._stopped(e);
      this._start(e);
    }, delay);
    this._set(e.tunnel.name, { ...patch, state: 'reconnecting', pid: null, nextAt: this.now() + delay });
  }

  // Replace the stored config; it applies from the next spawn. Toggling Auto moves failed/reconnecting entries.
  update(tunnel) {
    const e = this.entries.get(tunnel.name);
    if (!e) return;
    // The store mutates tunnel objects in place, so compare with the Auto value this manager last applied.
    const wasAuto = e.appliedAuto;
    e.tunnel = tunnel;
    e.appliedAuto = Boolean(tunnel.auto);
    // Only switching Auto on revives a failed tunnel; re-applying the same config (a file reload) must not.
    if (e.state === 'failed' && tunnel.auto && !wasAuto) {
      const since = e.failingSince;
      this._reset(e);
      e.failingSince = since ?? this.now();
      this._scheduleRetry(e);
    } else if (e.state === 'reconnecting' && !tunnel.auto) {
      this._clearTimer(e);
      this._set(tunnel.name, { state: 'failed', nextAt: null });
    }
  }

  disconnect(name) {
    const e = this.entries.get(name);
    if (!e) return;
    e.wanted = false;
    e.restartOnExit = false;
    this._reset(e);
    if (e.proc) this.kill(e.proc, 'SIGTERM'); // exit handler moves it to idle
    else this._set(name, { state: 'idle', pid: null, since: null });
  }

  connectAuto(tunnels) {
    tunnels.filter((t) => t.auto && !t.archived).forEach((t) => this.connect(t));
  }

  // After sleep the backoff timers are stale, so retry waiting tunnels right away.
  onWake() {
    for (const e of this.entries.values()) {
      if (e.state !== 'reconnecting') continue;
      this._clearTimer(e);
      e.attempts = 0;
      this._start(e);
    }
  }

  // After a fresh sign-in: restart every waiting entry whose tunnel passes filter, with a full retry budget.
  // Returns the names resumed.
  resumeWaiting(filter = () => true) {
    const resumed = [];
    for (const e of [...this.entries.values()]) {
      if (e.state !== 'waiting' || e.proc || !filter(e.tunnel)) continue;
      this._reset(e);
      this._start(e);
      resumed.push(e.tunnel.name);
    }
    return resumed;
  }

  disconnectAll() {
    [...this.entries.keys()].forEach((n) => this.disconnect(n));
  }

  // An exit that was meant to happen outside the app: idle, no retry.
  _stopped(e) {
    e.wanted = false;
    this._reset(e);
    return this._set(e.tunnel.name, { state: 'idle', pid: null, since: null, nextAt: null });
  }

  names() { return [...this.entries.keys()]; }

  ownedPids() {
    return [...this.entries.values()].filter((e) => e.proc).map((e) => e.proc.pid);
  }

  // Stop everything; SIGKILL whatever is still alive after timeoutMs.
  shutdown({ timeoutMs = 3000 } = {}) {
    const alive = new Set([...this.entries.values()].map((e) => e.proc).filter(Boolean));
    if (!alive.size) { this.disconnectAll(); return Promise.resolve(); }
    return new Promise((resolve) => {
      let timer = null;
      const settle = () => { if (timer) this.clearTimer(timer); resolve(); };
      for (const p of alive) {
        p.once('close', () => { alive.delete(p); if (!alive.size) settle(); });
      }
      timer = this.setTimer(() => { timer = null; alive.forEach((p) => this.kill(p, 'SIGKILL')); resolve(); }, timeoutMs);
      this.disconnectAll();
    });
  }
}

module.exports = { TunnelManager, backoffMs, buildArgs, MAX_RETRIES };
