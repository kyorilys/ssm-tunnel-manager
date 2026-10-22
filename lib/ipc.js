const path = require('node:path');

const isStr = (v, max = 64) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const name = (v) => isStr(v);
const bool = (v) => typeof v === 'boolean';
const optObj = (v) => v === undefined || isObj(v);

const ENVS = ['production', 'staging', 'other'];
const LOG_LEVELS = ['info', 'warn', 'error'];
const LOG_LIMIT_MAX = 2000;
const LOG_FILTER_KEYS = ['since', 'level', 'tunnel', 'source', 'search', 'limit'];

// logs:read filters. The log file itself is never client-chosen; unknown keys are rejected.
const logFilter = (v) => v === undefined || (isObj(v)
  && Object.keys(v).every((k) => LOG_FILTER_KEYS.includes(k))
  && (v.since === undefined || (Number.isInteger(v.since) && v.since >= 0))
  && (v.level === undefined || LOG_LEVELS.includes(v.level))
  && (v.tunnel === undefined || isStr(v.tunnel))
  && (v.source === undefined || v.source === 'app' || v.source === 'cli')
  && (v.search === undefined || (typeof v.search === 'string' && v.search.length <= 200))
  && (v.limit === undefined || (Number.isInteger(v.limit) && v.limit >= 1)));

// AWS profile names: same charset as lib/awsProfiles.js (no spaces, no leading dash so it can never read as a flag).
const profileName = (v) => typeof v === 'string' && /^[A-Za-z0-9_.+=,@-]{1,64}$/.test(v) && !v.startsWith('-');

// Exact-key object of strings: unknown keys are rejected, required ones must be present, optional ones may be omitted.
const strictForm = (required, optional, max) => (v) => isObj(v)
  && Object.keys(v).every((k) => required.includes(k) || optional.includes(k))
  && required.every((k) => typeof v[k] === 'string' && v[k].length > 0 && v[k].length <= max)
  && optional.every((k) => v[k] === undefined || (typeof v[k] === 'string' && v[k].length <= max));
// Optional second argument of the add-profile channels: { replace: boolean } when editing that profile.
const replaceOpt = (v) => v === undefined || (isObj(v) && Object.keys(v).every((k) => k === 'replace') && (v.replace === undefined || bool(v.replace)));

// Argument validators per command (the window.ssm API exposed by preload.js); a call must pass every one.
const SPEC = {
  getState: [],
  connect: [name],
  disconnect: [name],
  reconnect: [name],
  retry: [name],
  setAuto: [name, bool],
  saveTunnel: [isObj, (v) => v == null || isStr(v)],
  addTunnel: [isObj, (v) => isInt(v, 0, 1e6)],
  deleteTunnel: [name],
  restoreArchived: [name],
  dismissNotice: [],
  disconnectAll: [],
  disconnectEnv: [(v) => ENVS.includes(v)],
  killTerminal: [(v) => typeof v === 'string' && /^\d{1,10}$/.test(v)],
  checkPort: [(v) => isInt(v, 1, 65535)],
  updateSettings: [isObj],
  importTunnels: [optObj],
  copy: [(v) => typeof v === 'string' && v.length <= 10000],
  openMain: [(v) => v === undefined || (isObj(v)
    && (v.view === undefined || v.view === 'all' || v.view === 'archived')
    && (v.sheet === undefined || v.sheet === 'settings'))],
  resizePopover: [(v) => isInt(v, 0, 10000)],
  'logs:read': [logFilter],
  'logs:info': [],
  'logs:open': [],
  'aws:profiles': [],
  'aws:test': [profileName],
  'aws:signIn': [profileName],
  'aws:cancelSignIn': [profileName],
  'aws:addSso': [strictForm(['name', 'startUrl', 'ssoRegion', 'accountId', 'roleName'], ['region'], 2048), replaceOpt],
  'aws:addKeys': [strictForm(['name', 'accessKeyId', 'secretAccessKey'], ['region'], 128), replaceOpt],
  'aws:removeProfile': [profileName, (v) => v === undefined || (isObj(v)
    && Object.keys(v).every((k) => k === 'force') && (v.force === undefined || bool(v.force)))],
};

const CHANNELS = Object.keys(SPEC);

const INVALID = { ok: false, error: 'Invalid arguments' };

// logs: { file, maxBytes, keep, readEntries, fs }, shell: Electron's shell (both injected so this stays testable).
function registerIpc({ ipcMain, controller, ui, isTrustedSender, logs, shell }) {
  const needLogs = (fn) => (...args) => (logs ? fn(...args) : { ok: false, error: 'Logs unavailable' });
  const sizeOf = () => {
    try { return logs.fs.statSync(logs.file).size; } catch { return 0; }
  };
  const dispatch = {
    'logs:read': needLogs((filters = {}) => ({
      ok: true,
      entries: logs.readEntries({ file: logs.file, ...filters, ...(filters.limit !== undefined && { limit: Math.min(filters.limit, LOG_LIMIT_MAX) }) }),
    })),
    'logs:info': needLogs(() => ({ ok: true, path: logs.file, size: sizeOf(), maxBytes: logs.maxBytes, keep: logs.keep })),
    'logs:open': needLogs(async () => {
      if (logs.fs.existsSync(logs.file)) shell.showItemInFolder(logs.file);
      else await shell.openPath(path.dirname(logs.file));
      return { ok: true };
    }),
    'aws:profiles': () => controller.awsProfiles(),
    'aws:test': (n) => controller.awsTest(n),
    'aws:signIn': (n) => controller.awsSignIn(n),
    'aws:cancelSignIn': (n) => controller.awsCancelSignIn(n),
    'aws:addSso': (...args) => controller.awsAddSso(...args),
    'aws:addKeys': (...args) => controller.awsAddKeys(...args),
    'aws:removeProfile': (n, opts) => controller.awsRemoveProfile(n, opts),
    getState: () => controller.snapshot(),
    openMain: (opts = {}) => { ui.openMain(opts); return { ok: true }; },
    resizePopover: (h) => { ui.resizePopover(h); return { ok: true }; },
  };
  for (const method of CHANNELS) {
    const checks = SPEC[method];
    ipcMain.handle(`ssm:${method}`, async (event, ...args) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'Untrusted sender' };
      if (args.length > checks.length || !checks.every((check, i) => check(args[i]))) return INVALID;
      try {
        return await (dispatch[method] ? dispatch[method](...args) : controller[method](...args));
      } catch (err) {
        // AWS payloads can hold credentials: never echo an error that might quote them.
        return { ok: false, error: method.startsWith('aws:') ? 'AWS request failed' : err.message };
      }
    });
  }
}

module.exports = { registerIpc, CHANNELS };
