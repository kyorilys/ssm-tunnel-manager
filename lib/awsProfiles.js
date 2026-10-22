// Reads and edits ~/.aws/config and ~/.aws/credentials. All I/O (fs, execFile, home, clock) is injected.
// Secrets are only ever written straight to the credentials file; they are never returned, logged or put in argv.
const path = require('node:path');

const NAME_RE = /^[A-Za-z0-9_.+=,@-]{1,64}$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const ACCOUNT_RE = /^\d{12}$/;
const ROLE_RE = /^[\w+=,.@-]{1,64}$/;
const KEY_ID_RE = /^(AKIA|ASIA)[A-Z0-9]{16}$/;
const SECRET_RE = /^[A-Za-z0-9/+=]{40}$/;
const BACKUP_INFIX = '.ssm-tunnels-backup-';
const KEEP_BACKUPS = 5;

// ---- INI ----------------------------------------------------------------
// A document keeps every raw line so serialize() round-trips comments, order and unknown keys.
// Comment lines directly above a header belong to that section.
const isComment = (l) => /^\s*[#;]/.test(l);
const isBlank = (l) => l.trim() === '';
const HEADER_RE = /^\s*\[([^\]]*)\]/;

function parseIni(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const sections = [{ name: null, lines: [] }];
  for (const line of lines) {
    const m = HEADER_RE.exec(line);
    if (m) {
      const prev = sections[sections.length - 1];
      let n = prev.lines.length;
      while (n > 0 && isComment(prev.lines[n - 1])) n -= 1;
      sections.push({ name: m[1].trim(), lines: [...prev.lines.splice(n), line] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  const doc = { eol, sections };
  refresh(doc);
  return doc;
}

function readValues(lines) {
  const values = {};
  let nested = false;
  for (const line of lines) {
    if (isBlank(line) || isComment(line) || HEADER_RE.test(line)) continue;
    if (nested && /^\s/.test(line)) continue;
    const eq = line.indexOf('=');
    if (eq < 0) { nested = false; continue; }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    values[key] = value;
    nested = value === '';
  }
  return values;
}

function refresh(doc) {
  for (const s of doc.sections) s.values = readValues(s.lines);
}

const serialize = (doc) => doc.sections.flatMap((s) => s.lines).join(doc.eol);
const findSection = (doc, name) => doc.sections.find((s) => s.name === name);

// Ensures the section before an appended one ends in a blank separator and no stray final newline marker.
function openTail(doc) {
  const last = doc.sections[doc.sections.length - 1];
  if (last.lines.length && last.lines[last.lines.length - 1] === '') last.lines.pop();
  if (last.lines.length && !isBlank(last.lines[last.lines.length - 1])) last.lines.push('');
  return last;
}

function upsertSection(doc, name, values) {
  const sec = findSection(doc, name);
  if (!sec) {
    openTail(doc);
    const lines = [`[${name}]`, ...Object.entries(values).map(([k, v]) => `${k} = ${v}`), ''];
    doc.sections.push({ name, lines });
    // Drop the blank separator when the previous section is empty (e.g. brand new file).
    refresh(doc);
    return doc;
  }
  for (const [k, v] of Object.entries(values)) {
    const keyRe = new RegExp(`^(\\s*)${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
    const at = sec.lines.findIndex((l) => keyRe.test(l));
    if (at >= 0) { sec.lines[at] = `${k} = ${v}`; continue; }
    let lastContent = 0;
    sec.lines.forEach((l, i) => { if (!isBlank(l) && !isComment(l)) lastContent = i; });
    sec.lines.splice(lastContent + 1, 0, `${k} = ${v}`);
  }
  refresh(doc);
  return doc;
}

function removeSection(doc, name) {
  const idx = doc.sections.findIndex((s) => s.name === name);
  if (idx < 0) return false;
  const [gone] = doc.sections.splice(idx, 1);
  if (idx === doc.sections.length && gone.lines[gone.lines.length - 1] === '' && idx > 0) {
    const prev = doc.sections[idx - 1];
    while (prev.lines.length && isBlank(prev.lines[prev.lines.length - 1])) prev.lines.pop();
    prev.lines.push('');
  }
  return true;
}

// ---- files ----------------------------------------------------------------
const awsDir = (home) => path.join(home, '.aws');
const configPath = (home) => path.join(awsDir(home), 'config');
const credentialsPath = (home) => path.join(awsDir(home), 'credentials');
const configSection = (name) => (name === 'default' ? 'default' : `profile ${name}`);

function readDoc(fs, file) {
  try { return parseIni(fs.readFileSync(file, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return parseIni('');
    throw err;
  }
}

function listProfiles({ home, fs, env = {} }) {
  const config = readDoc(fs, configPath(home));
  const creds = readDoc(fs, credentialsPath(home));
  const sessions = {};
  const map = new Map();
  const entry = (name) => {
    if (!map.has(name)) map.set(name, { name, config: null, creds: null });
    return map.get(name);
  };
  for (const s of config.sections) {
    if (s.name === null) continue;
    const session = /^sso-session\s+(.+)$/.exec(s.name);
    const profile = s.name === 'default' ? 'default' : /^profile\s+(.+)$/.exec(s.name)?.[1];
    if (session) sessions[session[1].trim()] = s.values;
    else if (profile) entry(profile.trim()).config = s.values;
  }
  for (const s of creds.sections) if (s.name !== null) entry(s.name).creds = s.values;
  const profiles = [...map.values()].map(({ name, config: c, creds: k }) => {
    const cv = c || {};
    const sess = cv.sso_session ? sessions[cv.sso_session] || {} : {};
    const hasKeys = Boolean((k && k.aws_access_key_id) || cv.aws_access_key_id);
    const isSso = Boolean(cv.sso_start_url || cv.sso_session);
    return {
      name,
      type: isSso ? 'sso' : hasKeys ? 'keys' : 'other',
      region: cv.region || (k && k.region) || null,
      ssoStartUrl: cv.sso_start_url || sess.sso_start_url || null,
      ssoRegion: cv.sso_region || sess.sso_region || null,
      ssoSession: cv.sso_session || null,
      accountId: cv.sso_account_id || null,
      roleName: cv.sso_role_name || null,
      hasKeys,
      sources: [...(c ? ['config'] : []), ...(k ? ['credentials'] : [])],
    };
  });
  return { profiles, envCredentials: Boolean(env.AWS_ACCESS_KEY_ID) };
}

// ---- validation -------------------------------------------------------------
// Messages name the field, never its value, so a secret can not leak through an error.
function checkCommon(input, { existing = [], replace = false } = {}) {
  const errors = [];
  if (typeof input.name !== 'string' || !NAME_RE.test(input.name) || input.name.startsWith('-')) {
    errors.push('Profile name must be 1-64 characters of letters, digits and _.+=,@- and not start with "-".');
  } else if (!replace && existing.includes(input.name)) {
    errors.push(`Profile "${input.name}" already exists.`);
  }
  if (input.region != null && input.region !== '' && !REGION_RE.test(input.region)) {
    errors.push('Default region does not look like an AWS region (for example us-east-1).');
  }
  return errors;
}

function validateSsoProfile(input, opts) {
  const errors = checkCommon(input, opts);
  if (typeof input.startUrl !== 'string' || !/^https:\/\/[^\s/]+/.test(input.startUrl)) errors.push('SSO start URL must start with https://.');
  if (!REGION_RE.test(input.ssoRegion || '')) errors.push('SSO region does not look like an AWS region (for example us-east-1).');
  if (!ACCOUNT_RE.test(input.accountId || '')) errors.push('Account ID must be 12 digits.');
  if (!ROLE_RE.test(input.roleName || '') || input.roleName.startsWith('-')) errors.push('Role name has invalid characters.');
  return errors;
}

function validateKeysProfile(input, opts) {
  const errors = checkCommon(input, opts);
  if (!KEY_ID_RE.test(input.accessKeyId || '')) errors.push('Access key ID must start with AKIA or ASIA followed by 16 uppercase letters or digits.');
  if (!SECRET_RE.test(input.secretAccessKey || '')) errors.push('Secret access key must be 40 characters of letters, digits, / + or =.');
  return errors;
}

const fail = (errors) => Object.assign(new Error(errors.join(' ')), { errors });
const existingNames = (deps) => listProfiles({ home: deps.home, fs: deps.fs, env: {} }).profiles.map((p) => p.name);

// ---- writes -----------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

function backup(deps, file) {
  const { fs } = deps;
  if (!fs.existsSync(file)) return;
  const now = (deps.now || (() => new Date()))();
  const copy = `${file}${BACKUP_INFIX}${stamp(now)}`;
  fs.writeFileSync(copy, fs.readFileSync(file), { mode: 0o600 });
  fs.chmodSync(copy, 0o600);
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}${BACKUP_INFIX}`;
  const old = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().reverse().slice(KEEP_BACKUPS);
  for (const f of old) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* already gone */ } }
}

function ensureDir(fs, home) {
  const dir = awsDir(home);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeAtomic(fs, file, text, mode) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', mode);
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

const existingMode = (fs, file) => { try { return fs.statSync(file).mode & 0o777; } catch { return 0o600; } };

function configSet(deps, name, key, value) {
  const args = ['configure', 'set', key, value, '--profile', name];
  return new Promise((resolve, reject) => {
    deps.execFile(deps.awsBin || 'aws', args, { env: deps.env, timeout: 15000 }, (err, _out, stderr) => {
      if (err) reject(new Error(`aws configure set ${key} failed${stderr ? `: ${String(stderr).trim().slice(0, 200)}` : ''}`));
      else resolve();
    });
  });
}

async function addSsoProfile(input, deps) {
  const errors = validateSsoProfile(input, { existing: existingNames(deps), replace: deps.replace });
  if (errors.length) throw fail(errors);
  ensureDir(deps.fs, deps.home);
  backup(deps, configPath(deps.home));
  const pairs = [
    ['sso_start_url', input.startUrl], ['sso_region', input.ssoRegion],
    ['sso_account_id', input.accountId], ['sso_role_name', input.roleName],
    ...(input.region ? [['region', input.region]] : []), ['output', 'json'],
  ];
  for (const [k, v] of pairs) await configSet(deps, input.name, k, v);
  return { ok: true };
}

async function addKeysProfile(input, deps) {
  const errors = validateKeysProfile(input, { existing: existingNames(deps), replace: deps.replace });
  if (errors.length) throw fail(errors);
  const { fs, home } = deps;
  ensureDir(fs, home);
  const file = credentialsPath(home);
  backup(deps, file);
  const doc = readDoc(fs, file);
  upsertSection(doc, input.name, { aws_access_key_id: input.accessKeyId, aws_secret_access_key: input.secretAccessKey });
  writeAtomic(fs, file, serialize(doc), 0o600);
  if (input.region) {
    backup(deps, configPath(home));
    await configSet(deps, input.name, 'region', input.region);
  }
  return { ok: true };
}

async function removeProfile(name, deps) {
  const { fs, home } = deps;
  const cfgFile = configPath(home);
  const credFile = credentialsPath(home);
  const cfg = readDoc(fs, cfgFile);
  const creds = readDoc(fs, credFile);
  const target = findSection(cfg, configSection(name));
  const session = target?.values.sso_session;
  const inConfig = removeSection(cfg, configSection(name));
  let sessionGone = false;
  if (session) {
    const stillUsed = cfg.sections.some((s) => s.name !== null && s.values.sso_session === session);
    if (!stillUsed) sessionGone = removeSection(cfg, `sso-session ${session}`);
  }
  const inCreds = removeSection(creds, name);
  if (inConfig || sessionGone) {
    backup(deps, cfgFile);
    writeAtomic(fs, cfgFile, serialize(cfg), existingMode(fs, cfgFile));
  }
  if (inCreds) {
    backup(deps, credFile);
    writeAtomic(fs, credFile, serialize(creds), 0o600);
  }
  return inConfig || inCreds ? { removed: true } : { removed: false };
}

module.exports = {
  parseIni, serialize, upsertSection, removeSection,
  listProfiles, validateSsoProfile, validateKeysProfile,
  addSsoProfile, addKeysProfile, removeProfile,
};
