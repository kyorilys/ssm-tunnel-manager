const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { inferEnv, normalizeTunnel, validateTunnel, ENVS } = require('./validate');

const VERSION = 1;
const DEFAULT_SETTINGS = { openAtLogin: true, archiveDays: 7, purgeDays: 7, stopOnQuit: true, importedFrom: null };
const BOOLEAN_SETTINGS = ['openAtLogin', 'stopOnQuit'];
const DAY_SETTINGS = ['archiveDays', 'purgeDays'];

// Config fields come from the validated form; runtime fields belong to the controller.
function withRuntime(config, source) {
  const s = source || {};
  return {
    ...config,
    archived: Boolean(s.archived),
    failingMs: Number(s.failingMs) || 0,
    archivedAt: s.archivedAt == null ? null : s.archivedAt,
    lastError: s.lastError == null ? null : s.lastError,
    // Set by `ssm-tunnels down`/`kill` so a running app treats the exit as intended, not as a drop.
    stopRequestedAt: Number.isFinite(s.stopRequestedAt) ? s.stopRequestedAt : null,
  };
}

// A TCP port as an integer 1-65535; numeric strings ("5432") are coerced. Anything else is null.
function toPort(v) {
  const n = typeof v === 'string' && /^\s*\d{1,5}\s*$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

// Fill a stored row (possibly from an older version) with defaults.
// Returns null when port/local cannot be repaired; the caller quarantines such rows.
function hydrateTunnel(row) {
  const r = row && typeof row === 'object' ? row : {};
  const port = toPort(r.port);
  const local = toPort(r.local);
  if (port === null || local === null) return null;
  return withRuntime({
    name: r.name,
    region: r.region,
    target: r.target,
    host: r.host,
    port,
    local,
    desc: typeof r.desc === 'string' ? r.desc : '',
    env: ENVS.includes(r.env) ? r.env : inferEnv(r.name),
    auto: Boolean(r.auto),
    profile: typeof r.profile === 'string' ? r.profile.trim() : '',
  }, r);
}

function hydrateSettings(s) {
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!s || typeof s !== 'object') continue;
    const v = s[key];
    if (BOOLEAN_SETTINGS.includes(key)) {
      if (typeof v === 'boolean') out[key] = v;
    } else if (DAY_SETTINGS.includes(key)) {
      if (Number.isInteger(v) && v >= 0 && v <= 365) out[key] = v;
    } else if (key === 'importedFrom') {
      if (typeof v === 'string') out[key] = v;
    }
  }
  return out;
}

// Rows that fail the port/local check or the same rules as add/update (safe host, valid and unique name)
// are returned in `quarantine` untouched so save() can write them back.
function hydrateData(parsed) {
  const tunnels = [];
  const quarantine = [];
  for (const row of Array.isArray(parsed.tunnels) ? parsed.tunnels : []) {
    const t = hydrateTunnel(row);
    if (t && !Object.keys(validateTunnel(t, tunnels).errors).length) tunnels.push(t);
    else quarantine.push(row);
  }
  return { data: { version: VERSION, settings: hydrateSettings(parsed.settings), tunnels }, quarantine };
}

// Returns the parsed object, or null when the text is not a JSON object.
function parseData(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// A content hash, not mtime+size: two writes inside one mtime tick with equal length would go unnoticed.
const fingerprint = (text) => crypto.createHash('sha1').update(text).digest('hex');

const defaults = () => ({ version: VERSION, settings: { ...DEFAULT_SETTINGS }, tunnels: [] });

// Parse the `TUNNELS=( "name|region|target|host|port|local|desc" ... )` bash array.
function parseScript(text) {
  const rows = [];
  let inside = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!inside) {
      if (/^TUNNELS=\(/.test(line)) inside = true;
      continue;
    }
    if (line.startsWith(')')) break;
    if (!line || line.startsWith('#')) continue;
    const m = /^"(.*)"$/.exec(line) || /^'(.*)'$/.exec(line);
    if (!m) continue;
    const parts = m[1].split('|');
    if (parts.length < 6) continue;
    const [name, region, target, host, port, local, ...desc] = parts;
    rows.push({
      name: name.trim(),
      region: region.trim(),
      target: target.trim(),
      host: host.trim(),
      port: Number(port),
      local: Number(local),
      desc: desc.join('|').trim(),
      env: inferEnv(name),
      auto: false,
    });
  }
  return rows;
}

class Store {
  constructor({ file }) {
    this.file = file;
    this.data = defaults();
    this.recoveredFrom = null;
    this._quarantine = []; // raw rows with an unusable port/local: hidden from list(), kept in the file
    this.seen = null; // fingerprint of the file as this store last read or wrote it; null = no file
  }

  load() {
    this.recoveredFrom = null;
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.seen = null;
      this._quarantine = [];
      this.data = defaults();
      return this.data;
    }
    const parsed = parseData(text);
    if (!parsed) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, aside);
      this.recoveredFrom = aside;
      this.seen = null;
      this._quarantine = [];
      this.data = defaults();
      return this.data;
    }
    this.seen = fingerprint(text);
    this._adopt(hydrateData(parsed));
    return this.data;
  }

  _adopt({ data, quarantine }) {
    this.data = data;
    this._quarantine = quarantine;
  }

  // Rows from the file that were not loaded because port/local is not an integer 1-65535 (copies).
  quarantined() { return this._quarantine.map((r) => JSON.parse(JSON.stringify(r))); }

  // Another process (the CLI) may have rewritten the file since we last read or wrote it.
  // Returns true when it did and memory was replaced by the disk contents (disk wins).
  // A missing, unreadable or corrupt file leaves memory untouched and returns false; unlike load()
  // this never renames a corrupt file aside, because a refresh must not move files around.
  reloadIfChanged() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return false;
    }
    const hash = fingerprint(text);
    if (hash === this.seen) return false;
    const parsed = parseData(text);
    if (!parsed) return false;
    this._adopt(hydrateData(parsed));
    this.seen = hash;
    return true;
  }

  // Returns true when written. If the file changed externally, it is reloaded instead and the write is
  // skipped (false): overwriting would erase the other process's edit. Skipping is safe because memory is
  // now the disk state, and only derived bookkeeping (failingMs, lastError, archive flags) is lost; the
  // controller re-derives those on later ticks. Callers that ignore the result keep working.
  // Known gap: a write landing between this check and the rename below is still overwritten.
  save() {
    if (this.reloadIfChanged()) return false;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const text = JSON.stringify({ ...this.data, tunnels: [...this.data.tunnels, ...this._quarantine] }, null, 2);
    const tmp = `${this.file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    this.seen = fingerprint(text);
    return true;
  }

  list() { return this.data.tunnels; }

  get(name) { return this.data.tunnels.find((t) => t.name === name); }

  // Validate and insert without saving; shared by add() and importFromScript().
  _insert(t, index) {
    const { errors, clashes } = validateTunnel(t, this.data.tunnels);
    if (Object.keys(errors).length) return { ok: false, errors };
    const tunnel = withRuntime(normalizeTunnel(t), t);
    const at = Number.isInteger(index) && index >= 0 && index <= this.data.tunnels.length ? index : this.data.tunnels.length;
    this.data.tunnels.splice(at, 0, tunnel);
    return { ok: true, tunnel, clashes };
  }

  add(t, index) {
    this.reloadIfChanged();
    const r = this._insert(t, index);
    if (r.ok) this.save();
    return r;
  }

  update(oldName, t) {
    this.reloadIfChanged();
    const existing = this.get(oldName);
    if (!existing) return { ok: false, errors: { name: `“${oldName}” not found` } };
    const others = this.data.tunnels.filter((x) => x !== existing);
    const { errors, clashes } = validateTunnel(t, others);
    if (Object.keys(errors).length) return { ok: false, errors };
    Object.assign(existing, normalizeTunnel(t));
    this.save();
    return { ok: true, tunnel: existing, clashes };
  }

  remove(name) {
    this.reloadIfChanged();
    const index = this.data.tunnels.findIndex((t) => t.name === name);
    if (index === -1) return { ok: false };
    const [tunnel] = this.data.tunnels.splice(index, 1);
    this.save();
    return { ok: true, tunnel, index };
  }

  requestStop(names, at = Date.now()) {
    this.reloadIfChanged();
    for (const name of names) {
      const t = this.get(name);
      if (t) t.stopRequestedAt = at;
    }
    this.save();
  }

  setAuto(name, on) {
    this.reloadIfChanged();
    const t = this.get(name);
    if (!t) return { ok: false };
    t.auto = Boolean(on);
    this.save();
    return { ok: true };
  }

  restore(name) {
    this.reloadIfChanged();
    const t = this.get(name);
    if (!t) return { ok: false };
    t.archived = false;
    t.archivedAt = null;
    t.failingMs = 0;
    this.save();
    return { ok: true };
  }

  updateSettings(patch) {
    this.reloadIfChanged();
    const errors = {};
    const next = {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (BOOLEAN_SETTINGS.includes(key)) {
        if (typeof value === 'boolean') next[key] = value;
        else errors[key] = 'Must be true or false';
      } else if (DAY_SETTINGS.includes(key)) {
        if (Number.isInteger(value) && value >= 0 && value <= 365) next[key] = value;
        else errors[key] = 'Enter a whole number of days from 0 to 365';
      } else {
        errors[key] = 'Unknown setting';
      }
    }
    if (Object.keys(errors).length) return { ok: false, errors };
    Object.assign(this.data.settings, next);
    this.save();
    return { ok: true, settings: this.data.settings };
  }

  importFromScript(file, localOverrides = {}) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      return { ok: false, error: err.message };
    }
    this.reloadIfChanged();
    const added = [];
    const skipped = [];
    for (const row of parseScript(text)) {
      if (Object.prototype.hasOwnProperty.call(localOverrides, row.name)) row.local = Number(localOverrides[row.name]);
      const r = this._insert(row);
      if (r.ok) added.push(row.name);
      else skipped.push({ name: row.name, errors: r.errors });
    }
    this.data.settings.importedFrom = file;
    this.save();
    return { ok: true, added, skipped };
  }
}

module.exports = { Store, parseScript, DEFAULT_SETTINGS };
