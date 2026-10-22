const BASE_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const AWS_CANDIDATES = ['/opt/homebrew/bin/aws', '/usr/local/bin/aws'];
const TOOL_TIMEOUT_MS = 5000;

const resolveAwsBin = (existsSync) => AWS_CANDIDATES.find((p) => existsSync(p)) || 'aws';

// GUI apps launched at login do not inherit the shell PATH; the aws CLI finds session-manager-plugin through PATH.
function buildEnv(processEnv) {
  const extra = (processEnv.PATH || '').split(':').filter(Boolean);
  return { ...processEnv, PATH: [...new Set([...BASE_PATH, ...extra])].join(':') };
}

// A detached child leads its own process group, so killGroup can take the aws CLI and its plugin child together.
const spawnDetached = (spawn) => (cmd, args, opts) => spawn(cmd, args, { ...opts, detached: true });

const killGroup = (kill = process.kill) => (proc, signal) => {
  try {
    kill(-proc.pid, signal);
  } catch (err) {
    if (err.code === 'ESRCH') return;
    proc.kill(signal);
  }
};

const parseAwsVersion = (text) => /aws-cli\/(\S+)/.exec(text)?.[1] ?? null;
const parsePluginVersion = (text) => /^\s*(\d+(?:\.\d+)+)/.exec(text)?.[1] ?? null;

const probe = (execFile, cmd, args, env, parse) => new Promise((resolve) => {
  try {
    execFile(cmd, args, { env, timeout: TOOL_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve(err ? null : parse(`${stdout || ''}${stderr || ''}`));
    });
  } catch {
    resolve(null);
  }
});

async function readToolVersions({ execFile, awsBin, env }) {
  const [aws, plugin] = await Promise.all([
    probe(execFile, awsBin, ['--version'], env, parseAwsVersion),
    probe(execFile, 'session-manager-plugin', ['--version'], env, parsePluginVersion),
  ]);
  return { aws, plugin, awsPath: awsBin };
}

const displayPath = (abs, home) => (abs === home ? '~' : abs.startsWith(`${home}/`) ? `~${abs.slice(home.length)}` : abs);

// stderr for a tunnel process goes to a file, not a pipe: a session left running after the app quits
// would otherwise die on its next stderr write. Only the tail is read back for the error line.
const STDERR_TAIL = 1000;
const fileStderrSink = ({ dir, fs }) => (name) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = `${dir}/${String(name).replace(/[^A-Za-z0-9._-]/g, '_')}.stderr`;
  const fd = fs.openSync(file, 'w');
  return {
    fd,
    release: () => { try { fs.closeSync(fd); } catch { /* already closed */ } },
    read: () => {
      try {
        const text = fs.readFileSync(file, 'utf8');
        return text.slice(-STDERR_TAIL);
      } catch {
        return '';
      }
    },
  };
};

const findOnPath = (name, pathVar, existsSync) => {
  const dir = (pathVar || '').split(':').filter(Boolean).find((d) => existsSync(`${d}/${name}`));
  return dir ? `${dir}/${name}` : null;
};

module.exports = {
  AWS_CANDIDATES, resolveAwsBin, buildEnv, spawnDetached, killGroup,
  parseAwsVersion, parsePluginVersion, readToolVersions, displayPath, findOnPath, fileStderrSink,
};
