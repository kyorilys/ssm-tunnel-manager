const { EventEmitter } = require('node:events');
const nodeFs = require('node:fs');
const path = require('node:path');
const { parseScript } = require('./store');
const { STABLE_MS, FAILING } = require('./validate');
const awsProfilesLib = require('./awsProfiles');
const awsAuthLib = require('./awsAuth');

const EMIT_DEBOUNCE_MS = 100;
const RENAME_BLOCKED = 'Disconnect to rename';
const RUNNING = new Set(['connecting', 'active', 'reconnecting']);
const UNKNOWN = { ok: false, error: 'Unknown tunnel' };
const STATUS_TTL_MS = 5 * 60 * 1000;
const AWS_FILES = { config: '~/.aws/config', credentials: '~/.aws/credentials' };
const maskAccount = (id) => (id ? `••••${String(id).slice(-4)}` : null);
const profileKey = (t) => t.profile || 'default'; // a tunnel without a profile uses the AWS default

class Controller extends EventEmitter {
  constructor({ store, manager, scan, archive, importPath, displayPath, dataPath, tools, loginItem,
    notify, clipboard, logger, aws = null, fs = nodeFs, now = Date.now,
    setInterval: setIntervalFn = setInterval, clearInterval: clearIntervalFn = clearInterval,
    setTimeout: setTimeoutFn = setTimeout, clearTimeout: clearTimeoutFn = clearTimeout,
    pollMs = 5000, tickMs = 3600000 }) {
    super();
    Object.assign(this, { store, manager, scan, archive, importPath, displayPath, dataPath, toolsSource: tools,
      loginItem, notify, clipboard, logger, fs, now, setIntervalFn, clearIntervalFn, setTimeoutFn, clearTimeoutFn,
      pollMs, tickMs });
    // aws: { home, fs, execFile, spawn, awsBin, env } (all injected); without it the AWS features see no profiles.
    this.awsDeps = aws;
    this.awsList = { profiles: [], envCredentials: false };
    this.awsStatus = new Map(); // profile name -> Status
    this.awsInflight = new Map(); // profile name -> Promise<Status>
    this.awsSigning = null; // { name, cancel }
    this.awsWaitLogged = new Set();
    this.tools = null;
    this.importOffer = null;
    this.notice = new Set();
    this.suppressed = new Set(); // names the user stopped through the app: never auto-reconnected after leaving Terminal
    this.matched = new Map();
    this.unmatched = [];
    this.previouslyMatched = new Set();
    this.lastTickAt = 0;
    this.pollTimer = null;
    this.tickTimer = null;
    this.emitTimer = null;
    this.stopped = false;
    this.lastState = new Map(); // manager state last seen per tunnel, so only transitions are logged
    this.lastPid = new Map();
    this.origin = new Map(); // why a spawn is about to happen: user | auto | retry | wake
    this.stopSeen = new Map(); // stopRequestedAt already acted on, per tunnel
    this.manager.shouldRetry = (name) => this._shouldRetry(name);
  }

  // Asked by the manager before treating an exit as a drop: the CLI may have stopped it on purpose.
  _shouldRetry(name) {
    this._refreshStore();
    const t = this.store.get(name);
    return Boolean(t) && !t.archived && !this.suppressed.has(name);
  }

  // The event log must never affect behaviour: a missing or throwing logger is ignored.
  _log(level, event, tunnel, message, extra) {
    try {
      this.logger?.log(level, event, tunnel, message, extra);
    } catch {
      // ignore
    }
  }

  get settings() { return this.store.data.settings; }

  // ---- lifecycle ---------------------------------------------------------

  async start() {
    this.store.load();
    // Stops recorded while the app was not running do not block this launch's auto-connect.
    for (const t of this.store.list()) if (t.stopRequestedAt) this.stopSeen.set(t.name, t.stopRequestedAt);
    this._log('info', 'app_start', null, `Started with ${this.store.list().length} saved tunnels`, { tunnels: this.store.list().length });
    if (this.store.recoveredFrom) {
      this.notify('SSM Tunnels', `connections.json could not be read; the old file was kept as ${path.basename(this.store.recoveredFrom)}`);
    }
    Promise.resolve(this.toolsSource).then((tools) => { this.tools = tools; this.scheduleEmit(); }, () => {});
    this.importOffer = this._readImportOffer();
    this.manager.on('change', (name, state) => this._onManagerChange(name, state));

    this._awsRefreshList();
    this._awsRefreshInUse();

    await this.poll(); // scan first: a tunnel already running must not be spawned again and burn its retries
    this.manager.connectAuto(this._live().filter((t) => !this.matched.has(t.name)));
    this.runArchive(0);
    this.lastTickAt = this.now();

    this.pollTimer = this.setIntervalFn(() => this.poll(), this.pollMs);
    this.tickTimer = this.setIntervalFn(() => this.hourly(), this.tickMs);
    if (this.loginItem.supported) this.loginItem.set(this.settings.openAtLogin);
  }

  async shutdown() {
    this._log('info', 'app_quit', null, 'Quitting', { stopOnQuit: Boolean(this.settings.stopOnQuit) });
    this.stopped = true;
    this.clearIntervalFn(this.pollTimer);
    this.clearIntervalFn(this.tickTimer);
    if (this.emitTimer) this.clearTimeoutFn(this.emitTimer);
    this.emitTimer = null;
    if (this.settings.stopOnQuit) await this.manager.shutdown({ timeoutMs: 3000 });
    this.store.save();
  }

  onWake() {
    this.lastTickAt = this.now(); // time asleep is not charged to failing tunnels
    const waiting = this.store.list().filter((t) => this.manager.get(t.name).state === 'reconnecting');
    for (const t of waiting) this.origin.set(t.name, 'wake');
    this.manager.onWake();
    for (const t of waiting) this._log('info', 'wake_retry', t.name, 'Retrying now after wake', { local: t.local });
    return this.poll();
  }

  _readImportOffer() {
    const { fs, importPath } = this;
    if (this.store.list().length || this.settings.importedFrom || !fs.existsSync(importPath)) return null;
    try {
      return { path: this.displayPath(importPath), tunnels: parseScript(fs.readFileSync(importPath, 'utf8')) };
    } catch {
      return null;
    }
  }

  _onManagerChange(name, state) {
    const t = this.store.get(name);
    this._awsOnManagerChange(t, state);
    if (t && FAILING.has(state.state) && state.error && state.error !== t.lastError) {
      t.lastError = state.error;
      this.store.save();
    }
    this._logTransition(name, state);
    this.scheduleEmit();
  }

  // Logs session state transitions only (never the steady state seen on every poll).
  _logTransition(name, s) {
    const prev = this.lastState.get(name) || 'idle';
    this.lastState.set(name, s.state);
    if (s.state === prev) return;
    const t = this.store.get(name);
    const local = t ? t.local : undefined;
    const wasRunning = prev === 'active' || prev === 'connecting';

    if (s.state === 'connecting') {
      if (prev === 'reconnecting' && this.origin.get(name) !== 'wake') this.origin.set(name, 'retry');
    } else if (s.state === 'active') {
      const by = this.origin.get(name) || 'auto';
      this.origin.delete(name);
      this.lastPid.set(name, s.pid);
      this._log('info', 'connect', name, by === 'retry' || by === 'wake' ? 'Reconnected' : 'Connected', { pid: s.pid, by, local });
    } else if (s.state === 'reconnecting' || s.state === 'failed') {
      if (wasRunning) {
        const last = String(s.error || '').replace(/^Gave up after \d+ attempts: /, '');
        const hasError = Boolean(last) && last !== 'Session ended';
        this._log(hasError ? 'error' : 'info', 'session_ended', name, last || 'Session ended', { pid: this.lastPid.get(name), local });
      }
      if (s.state === 'reconnecting') {
        this._log('warn', 'reconnect_scheduled', name, `Reconnecting (attempt ${s.attempt} of ${s.maxAttempts})`,
          { attempt: s.attempt, delayMs: Math.max(0, s.nextAt - this.now()), local });
      } else if (s.gaveUp) {
        this._log('error', 'gave_up', name, s.error, { attempt: s.attempt, local });
      }
    } else if (s.state === 'idle') {
      this.origin.delete(name);
      this.lastPid.delete(name);
    }
  }

  // ---- state -------------------------------------------------------------

  _live() { return this.store.list().filter((t) => !t.archived); }

  _merged(t) {
    const m = this.manager.get(t.name);
    if (RUNNING.has(m.state)) return { ...t, ...m, origin: 'app' };
    const s = this.matched.get(t.name);
    if (s) {
      return { ...t, ...m, state: 'active', origin: 'terminal', pid: s.pid, since: this.now() - s.etimeSec * 1000,
        error: null, gaveUp: false, nextAt: null };
    }
    return { ...t, ...m, origin: null };
  }

  snapshot() {
    const { archiveDays, purgeDays, openAtLogin, stopOnQuit, importedFrom } = this.settings;
    const offerVisible = this.importOffer && !this.store.list().length && !importedFrom;
    return {
      tunnels: this.store.list().map((t) => this._merged(t)),
      terminal: this.unmatched.map((s) => ({ id: String(s.pid), pid: s.pid, region: s.region, target: s.target,
        host: s.host, port: s.port, local: s.local, since: this.now() - s.etimeSec * 1000 })),
      settings: { openAtLogin, archiveDays, purgeDays, stopOnQuit },
      notice: [...this.notice],
      aws: this._awsSnapshot(),
      tools: this.tools,
      dataPath: this.displayPath(this.dataPath),
      loginItem: { supported: this.loginItem.supported },
      importOffer: offerVisible ? this.importOffer : null,
      now: this.now(),
    };
  }

  scheduleEmit() {
    if (this.stopped || this.emitTimer) return;
    this.emitTimer = this.setTimeoutFn(() => {
      this.emitTimer = null;
      this.emit('state', this.snapshot());
    }, EMIT_DEBOUNCE_MS);
  }

  // ---- scanning ----------------------------------------------------------

  async _scan() {
    let sessions = [];
    try {
      sessions = await this.scan.scanSessions();
    } catch {
      // ps failing must not take the app down: treat it as "nothing running"
    }
    const owned = new Set(this.manager.ownedPids());
    return { sessions, owned, ...this.scan.matchSessions(sessions, this._live(), owned) };
  }

  // Picks up edits the CLI made to the shared file. New tunnels are not auto-connected. A stop recorded by
  // `ssm-tunnels down`/`kill` is honoured, and a session whose tunnel was renamed, removed or archived is
  // stopped, since it would otherwise keep running unseen and unstoppable from the app.
  _refreshStore() {
    if (!this.store.reloadIfChanged()) return false;
    this._log('info', 'external_reload', null, 'Connections file was changed outside the app and reloaded', { tunnels: this.store.list().length });
    for (const t of this.store.list()) {
      if (t.stopRequestedAt && t.stopRequestedAt > (this.stopSeen.get(t.name) ?? 0)) {
        this.stopSeen.set(t.name, t.stopRequestedAt);
        this.suppressed.add(t.name);
        if (this.manager.get(t.name).state !== 'idle') this.manager.disconnect(t.name);
        this._log('info', 'disconnect', t.name, 'Stopped from the command line', { local: t.local });
      }
      this.manager.update(t);
    }
    for (const name of this.manager.names()) {
      const t = this.store.get(name);
      if ((!t || t.archived) && this.manager.get(name).state !== 'idle') {
        this.manager.disconnect(name);
        this._log('info', 'disconnect', name, t ? 'Stopped: archived outside the app' : 'Stopped: renamed or removed outside the app');
      }
    }
    this.scheduleEmit();
    return true;
  }

  async poll() {
    this._refreshStore();
    const { matched, unmatched } = await this._scan();
    const before = this.previouslyMatched;
    this.matched = matched;
    this.unmatched = unmatched;
    this.previouslyMatched = new Set(matched.keys());

    // A tunnel that was running in Terminal and vanished (not by the user's hand) is taken over by the app.
    for (const t of this._live()) {
      if (t.auto && before.has(t.name) && !matched.has(t.name) && !this.suppressed.has(t.name)
        && this.manager.get(t.name).state === 'idle') this.manager.connect(t);
    }

    let changed = false;
    for (const t of this._live()) {
      const m = this._merged(t);
      if (m.state === 'active' && m.since <= this.now() - STABLE_MS && t.failingMs > 0) {
        t.failingMs = 0;
        changed = true;
      }
    }
    if (changed) this.store.save();
    this.scheduleEmit();
  }

  // ---- archive / purge ---------------------------------------------------

  hourly() {
    const at = this.now();
    const dt = Math.min(at - this.lastTickAt, this.tickMs);
    this.lastTickAt = at;
    this._awsRefreshInUse();
    this.runArchive(dt);
  }

  runArchive(dt) {
    this._refreshStore();
    const { archiveDays, purgeDays } = this.settings;
    const stateOf = (name) => {
      const m = this._merged(this.store.get(name));
      // A session younger than STABLE_MS is neither charged nor cleared: a fresh spawn reports 'active' before it can fail.
      const young = m.state === 'active' && m.since > this.now() - STABLE_MS;
      return { state: young ? 'connecting' : m.state, error: m.error };
    };
    const archived = this.archive.tick(this.store.list(), stateOf, dt, archiveDays, this.now());
    for (const name of archived) {
      this.manager.disconnect(name);
      this.notice.add(name);
      this._log('info', 'auto_archived', name, `Archived after failing for ${archiveDays} days`, { days: archiveDays });
    }
    if (archived.length) {
      this.notify(`Auto-archived ${archived.join(', ')}`,
        `Failed for ${archiveDays} days. ${purgeDays ? `Deleted permanently in ${purgeDays} days unless restored.` : 'Kept until you delete it.'}`);
      this.emit('event', { type: 'archived', names: archived });
    }
    const purged = this.archive.purge(this.store.list(), this.now(), purgeDays);
    for (const name of purged) {
      this.notice.delete(name);
      this.manager.disconnect(name);
    }
    if (purged.length) {
      this.notify(`Deleted ${purged.join(', ')} permanently`, `Archived longer than ${purgeDays} days.`);
      this.emit('event', { type: 'purged', names: purged });
      this._log('info', 'purged', null, `Deleted ${purged.length} archived tunnel${purged.length === 1 ? '' : 's'} permanently: ${purged.join(', ')}`,
        { names: purged, count: purged.length });
    }
    if (archived.length || purged.length) {
      this._log('info', 'archive_sweep', null, `Archived ${archived.length}, purged ${purged.length}`, { archived: archived.length, purged: purged.length });
    }
    this.store.save();
    this.scheduleEmit();
  }

  // ---- AWS profiles ------------------------------------------------------

  _awsRefreshList() {
    if (!this.awsDeps) return this.awsList;
    try {
      const { home, fs, env } = this.awsDeps;
      this.awsList = awsProfilesLib.listProfiles({ home, fs, env });
    } catch {
      // unreadable aws files: keep the last known list
    }
    return this.awsList;
  }

  _awsProfile(name) { return this.awsList.profiles.find((p) => p.name === name); }

  _awsUsedBy(name) { return this._live().filter((t) => profileKey(t) === name).map((t) => t.name); }

  _awsStale(name) {
    const s = this.awsStatus.get(name);
    return !s || this.now() - s.checkedAt >= STATUS_TTL_MS;
  }

  // Profiles worth checking: every one a saved tunnel uses (default included, it may come from env credentials).
  _awsRefreshInUse() {
    if (!this.awsDeps) return;
    const used = new Set(this._live().map(profileKey));
    for (const name of used) if (this._awsStale(name)) this._awsCheck(name).catch(() => {});
  }

  // Runs `aws sts get-caller-identity` for a profile. One check per profile at a time; force skips the TTL.
  _awsCheck(name, { force = false } = {}) {
    if (this.awsInflight.has(name)) return this.awsInflight.get(name);
    if (!force && !this._awsStale(name)) return Promise.resolve(this.awsStatus.get(name));
    if (!force && this.awsStatus.has(name)) { /* stale: refreshed quietly, the old value stays visible meanwhile */ } else {
      this.awsStatus.set(name, { state: 'checking', checkedAt: this.now() });
    }
    const d = this.awsDeps;
    const run = awsAuthLib.checkProfile(name === 'default' ? null : name, d)
      .catch(() => ({ state: 'error', message: 'Could not check the profile.' }))
      .then((r) => {
        const status = { state: r.state, checkedAt: this.now() };
        if (r.identity) status.identity = r.identity;
        if (r.account) status.account = r.account;
        if (r.message) status.message = r.message;
        this.awsStatus.set(name, status);
        this.awsInflight.delete(name);
        this.scheduleEmit();
        return status;
      });
    this.awsInflight.set(name, run);
    this.scheduleEmit();
    return run;
  }

  _awsWaiting() {
    const groups = new Map();
    for (const t of this._live()) {
      if (this.manager.get(t.name).state !== 'waiting') continue;
      const key = profileKey(t);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t.name);
    }
    return [...groups].map(([profile, tunnels]) => ({ profile, type: this._awsProfile(profile)?.type || 'other', tunnels }));
  }

  _awsSnapshot() {
    const { profiles, envCredentials } = this.awsList;
    return {
      profiles: profiles.map((p) => ({ name: p.name, type: p.type, status: this.awsStatus.get(p.name) || null })),
      waiting: this._awsWaiting(),
      signingIn: this.awsSigning ? this.awsSigning.name : null,
      noCredentials: !profiles.length && !envCredentials,
    };
  }

  // A tunnel went into 'waiting' (sign-in expired): that profile's status is stale, and the user hears about it once.
  _awsOnManagerChange(t, state) {
    if (!t) return;
    const key = profileKey(t);
    if (state.state === 'waiting') {
      this.awsStatus.set(key, { state: 'expired', message: 'The session has expired. Sign in again.', checkedAt: this.now() });
      if (!this.awsWaitLogged.has(key)) {
        this.awsWaitLogged.add(key);
        const count = this._awsWaiting().find((w) => w.profile === key)?.tunnels.length || 1;
        this._log('warn', 'aws_signin_needed', null,
          `Sign-in needed for AWS profile ${key}: ${count} tunnel${count === 1 ? '' : 's'} waiting`, { profile: key, count });
      }
    } else if (this.awsWaitLogged.has(key) && !this._awsWaiting().some((w) => w.profile === key)) {
      this.awsWaitLogged.delete(key);
    }
  }

  async awsProfiles() {
    const { profiles, envCredentials } = this._awsRefreshList();
    for (const p of profiles) if (this._awsStale(p.name)) this._awsCheck(p.name).catch(() => {});
    return {
      profiles: profiles.map(({ sources, accountId, ...p }) => ({
        ...p, accountId: maskAccount(accountId), tunnels: this._awsUsedBy(p.name).length, status: this.awsStatus.get(p.name) || null })),
      envCredentials,
      files: { ...AWS_FILES },
    };
  }

  async awsTest(name) {
    this._awsRefreshList();
    if (name !== 'default' && !this._awsProfile(name)) return { state: 'error', message: 'Unknown profile', checkedAt: this.now() };
    return this._awsCheck(name, { force: true });
  }

  // Everyone who signs in through the same SSO login: the profile's sso_session, else its start URL, else just itself.
  _awsGroup(profile) {
    const same = (p) => (profile.ssoSession ? p.ssoSession === profile.ssoSession
      : profile.ssoStartUrl ? p.ssoStartUrl === profile.ssoStartUrl : p.name === profile.name);
    return new Set(this.awsList.profiles.filter(same).map((p) => p.name).concat(profile.name));
  }

  _awsSignInEvent(profile, phase, message) {
    this.emit('event', { type: 'aws-signin', profile, phase, ...(message && { message }) });
  }

  async awsSignIn(name) {
    if (this.awsSigning) return { ok: false, message: 'A sign-in is already in progress' };
    this._awsRefreshList();
    const profile = this._awsProfile(name);
    if (!this.awsDeps || !profile) return { ok: false, message: 'Unknown profile' };
    if (profile.type !== 'sso') return { ok: false, message: 'Only SSO profiles can sign in' };
    const slot = { name, cancel: () => {} };
    this.awsSigning = slot;
    this.scheduleEmit();
    const login = awsAuthLib.signIn(name, { ...this.awsDeps, onProgress: (phase) => this._awsSignInEvent(name, phase) });
    slot.cancel = login.cancel;
    let result;
    try {
      result = await login.promise;
    } catch {
      result = { ok: false, message: 'Sign-in failed.' };
    }
    try {
      if (result.ok) await this._awsAfterSignIn(profile);
      else this._awsSignInFailed(name, result);
    } finally {
      this.awsSigning = null;
      this.scheduleEmit();
    }
    return result.ok ? { ok: true } : { ok: false, ...(result.cancelled && { cancelled: true }), message: result.message };
  }

  async _awsAfterSignIn(profile) {
    const group = this._awsGroup(profile);
    await this._awsCheck(profile.name, { force: true });
    for (const other of group) if (other !== profile.name) this._awsCheck(other, { force: true }).catch(() => {});
    const resumed = this.manager.resumeWaiting((t) => {
      const hit = group.has(profileKey(t));
      if (hit) this.origin.set(t.name, 'retry');
      return hit;
    });
    this._log('info', 'aws_signin', null, `Signed in to AWS profile ${profile.name}${resumed.length ? `; resumed ${resumed.length} tunnel${resumed.length === 1 ? '' : 's'}` : ''}`,
      { profile: profile.name, resumed: resumed.length });
    this._awsSignInEvent(profile.name, 'done');
  }

  _awsSignInFailed(name, result) {
    const cancelled = Boolean(result.cancelled);
    const message = result.message || 'Sign-in failed.';
    this._log('warn', 'aws_signin', null, `Sign-in for AWS profile ${name} ${cancelled ? 'was cancelled' : `failed: ${message}`}`, { profile: name, cancelled });
    this._awsSignInEvent(name, cancelled ? 'cancelled' : 'failed', message);
  }

  async awsCancelSignIn(name) {
    if (!this.awsSigning || this.awsSigning.name !== name) return { ok: false };
    this.awsSigning.cancel();
    return { ok: true };
  }

  // The secret is only ever in `input` for the duration of this call: it goes straight to the credentials file.
  // replace: true only when editing that same profile; otherwise an existing name is refused.
  async _awsAdd(kind, input, { replace = false } = {}) {
    if (!this.awsDeps) return { ok: false, errors: ['AWS is not available'] };
    const add = kind === 'keys' ? awsProfilesLib.addKeysProfile : awsProfilesLib.addSsoProfile;
    try {
      await add(input, { ...this.awsDeps, replace });
    } catch (err) {
      return { ok: false, errors: Array.isArray(err.errors) ? err.errors : [kind === 'keys' ? 'Could not save the profile.' : String(err.message).slice(0, 200)] };
    }
    const name = input.name;
    this._awsRefreshList();
    this.awsStatus.delete(name);
    this._log('info', 'aws_profile_added', null, `Added AWS profile ${name}`, { profile: name, type: kind });
    if (kind === 'keys') this._awsCheck(name, { force: true }).catch(() => {});
    return this._finish({ ok: true });
  }

  async awsAddSso(input, opts) { return this._awsAdd('sso', input, opts); }

  async awsAddKeys(input, opts) { return this._awsAdd('keys', input, opts); }

  async awsRemoveProfile(name, { force = false } = {}) {
    if (!this.awsDeps) return { ok: false, error: 'AWS is not available' };
    const usedBy = this._awsUsedBy(name);
    if (usedBy.length && !force) return { ok: false, usedBy };
    let removed;
    try {
      ({ removed } = await awsProfilesLib.removeProfile(name, this.awsDeps));
    } catch {
      return { ok: false, error: 'Could not remove the profile' };
    }
    this._awsRefreshList();
    if (!removed) return { ok: false, error: 'Unknown profile' };
    this.awsStatus.delete(name);
    this._log('info', 'aws_profile_removed', null, `Removed AWS profile ${name}`, { profile: name });
    return this._finish({ ok: true });
  }

  // ---- helpers for commands ---------------------------------------------

  _sleep(ms) { return new Promise((resolve) => this.setTimeoutFn(resolve, ms)); }

  async _waitFor(predicate, capMs, stepMs) {
    const rounds = Math.ceil(capMs / stepMs);
    for (let i = 0; i <= rounds; i++) {
      if (await predicate()) return true;
      if (i < rounds) await this._sleep(stepMs);
    }
    return false;
  }

  _waitIdle(name) {
    if (this.manager.get(name).state === 'idle') return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        this.manager.off('change', onChange);
        if (timer) this.clearTimeoutFn(timer);
        resolve();
      };
      const onChange = (n, state) => { if (n === name && state.state === 'idle') done(); };
      this.manager.on('change', onChange);
      timer = this.setTimeoutFn(() => { timer = null; done(); }, 5000);
    });
  }

  // Stops a tunnel wherever it runs. Returns true when something was running.
  async _stop(name) {
    const state = this.manager.get(name).state;
    if (state !== 'idle') {
      this.manager.disconnect(name);
      if (RUNNING.has(state)) return true;
    }
    const live = this.matched.get(name);
    if (!live) return false;
    const current = (await this._scan()).matched.get(name);
    if (!current || current.pid !== live.pid) return false;
    await this.scan.killSession(current);
    return true;
  }

  async _finish(result) {
    this.scheduleEmit();
    return result;
  }

  // ---- commands ----------------------------------------------------------

  async connect(name) {
    const t = this.store.get(name);
    if (!t) return UNKNOWN;
    if (t.archived) return { ok: false, error: 'Restore it first' };
    this.suppressed.delete(name);
    if (!this.matched.has(name)) {
      this.origin.set(name, 'user');
      this.manager.connect(t);
    }
    return this._finish({ ok: true });
  }

  async disconnect(name) {
    if (!this.store.get(name)) return UNKNOWN;
    const stopped = await this._stop(name);
    this.suppressed.add(name);
    if (stopped) this._log('info', 'disconnect', name, 'Disconnected', { local: this.store.get(name).local });
    await this.poll();
    return this._finish({ ok: true });
  }

  async reconnect(name) {
    const t = this.store.get(name);
    if (!t) return UNKNOWN;
    if (t.archived) return { ok: false, error: 'Restore it first' };
    this.suppressed.delete(name);
    if (this.manager.get(name).state !== 'idle') {
      this.manager.disconnect(name);
      await this._waitIdle(name);
    } else if (this.matched.has(name)) {
      await this._stop(name);
      await this._waitFor(async () => !(await this.scan.isPortInUse(t.local)), 3000, 250);
    }
    this.origin.set(name, 'user');
    this.manager.connect(this.store.get(name));
    return this._finish({ ok: true });
  }

  async retry(name) {
    if (FAILING.has(this.manager.get(name).state)) {
      this.suppressed.delete(name);
      this.origin.set(name, 'user');
      this.manager.retry(name);
      return this._finish({ ok: true });
    }
    return this.connect(name);
  }

  async setAuto(name, on) {
    const r = this.store.setAuto(name, on);
    if (!r.ok) return UNKNOWN;
    this.manager.update(this.store.get(name));
    this._log('info', 'edited', name, `Auto-connect turned ${on ? 'on' : 'off'}`, { auto: Boolean(on) });
    return this._finish({ ok: true });
  }

  async saveTunnel(data, originalName) {
    const renaming = Boolean(originalName) && data.name !== originalName;
    if (renaming && RUNNING.has(this.manager.get(originalName).state)) {
      return { ok: false, errors: { name: RENAME_BLOCKED } };
    }
    const result = originalName ? this.store.update(originalName, data) : this.store.add(data);
    if (result.ok) {
      this.manager.update(result.tunnel);
      if (renaming) this.manager.disconnect(originalName); // clears the stale entry; it is idle or failed anyway
      const t = result.tunnel;
      this._log('info', originalName ? 'edited' : 'added', t.name,
        renaming ? `Renamed from ${originalName}` : originalName ? 'Edited' : 'Added', { local: t.local, port: t.port });
    }
    return this._finish(result);
  }

  async addTunnel(tunnel, index) {
    const result = this.store.add(tunnel, index);
    if (result.ok) this._log('info', 'added', result.tunnel.name, 'Added', { local: result.tunnel.local, port: result.tunnel.port });
    return this._finish(result);
  }

  async deleteTunnel(name) {
    if (!this.store.get(name)) return UNKNOWN;
    await this._stop(name);
    this.suppressed.add(name);
    const result = this.store.remove(name);
    this.notice.delete(name);
    if (result.ok) this._log('info', 'removed', name, 'Removed', { local: result.tunnel.local });
    return this._finish(result);
  }

  async restoreArchived(name) {
    const result = this.store.restore(name);
    this.notice.delete(name);
    if (result.ok) this._log('info', 'restored', name, 'Restored from the archive', {});
    return this._finish(result);
  }

  async dismissNotice() {
    this.notice.clear();
    return this._finish({ ok: true });
  }

  // Stops every given tunnel (app sessions via the manager, matched Terminal ones by kill).
  async _stopTunnels(tunnels, { sweep }) {
    let stopped = 0;
    const logged = [];
    for (const t of tunnels) {
      if (RUNNING.has(this.manager.get(t.name).state)) { stopped++; logged.push(t.name); }
      if (this.manager.get(t.name).state !== 'idle') this.manager.disconnect(t.name);
      this.suppressed.add(t.name);
    }
    // The stopped procs are still exiting; ownedPids keeps them out of the scan result.
    const { matched, unmatched } = await this._scan();
    const targets = tunnels.filter((t) => matched.has(t.name)).map((t) => matched.get(t.name));
    const failed = [];
    for (const s of sweep ? [...matched.values(), ...unmatched] : targets) {
      try {
        await this.scan.killSession(s);
        stopped++;
      } catch (e) {
        // e.g. EPERM: keep stopping the rest and report this one
        const error = (e && e.message) || String(e);
        failed.push({ pid: s.pid, error });
        this._log('warn', 'disconnect', null, `Could not stop session pid ${s.pid}: ${error}`, { pid: s.pid });
      }
    }
    for (const [name] of matched) if (sweep) this.suppressed.add(name);
    const names = new Set(tunnels.map((t) => t.name));
    for (const name of matched.keys()) if (names.has(name) && !logged.includes(name)) logged.push(name);
    for (const name of logged) this._log('info', 'disconnect', name, 'Disconnected', { bulk: true });
    await this.poll();
    return { stopped, failed };
  }

  async disconnectAll() {
    const { stopped, failed } = await this._stopTunnels(this.store.list(), { sweep: true });
    return this._finish({ ok: true, stopped, ...(failed.length ? { failed } : {}) });
  }

  async disconnectEnv(env) {
    const { stopped, failed } = await this._stopTunnels(this._live().filter((t) => t.env === env), { sweep: false });
    return this._finish({ ok: true, stopped, ...(failed.length ? { failed } : {}) });
  }

  async killTerminal(id) {
    const { unmatched } = await this._scan();
    const session = unmatched.find((s) => s.pid === Number(id));
    if (!session) return { ok: false, error: 'Session not found' };
    await this.scan.killSession(session);
    await this.poll();
    return this._finish({ ok: true });
  }

  async checkPort(port) {
    return { inUse: await this.scan.isPortInUse(port) };
  }

  async updateSettings(patch) {
    const result = this.store.updateSettings(patch);
    if (!result.ok) return result;
    this._log('info', 'settings_changed', null, `Changed ${Object.keys(patch).join(', ')}`, { changes: patch });
    if ('openAtLogin' in patch && this.loginItem.supported) this.loginItem.set(patch.openAtLogin);
    if ('archiveDays' in patch || 'purgeDays' in patch) this.runArchive(0);
    return this._finish(result);
  }

  async importTunnels(overrides) {
    if (this.settings.importedFrom) return { ok: false, error: 'Already imported' };
    const result = this.store.importFromScript(this.importPath, overrides || {});
    if (result.ok) {
      this._log('info', 'imported', null, `Imported ${result.added.length} tunnel${result.added.length === 1 ? '' : 's'}`,
        { count: result.added.length, skipped: result.skipped.length });
    }
    return this._finish(result);
  }

  async copy(text) {
    this.clipboard.writeText(String(text));
    return { ok: true };
  }
}

module.exports = { Controller };
