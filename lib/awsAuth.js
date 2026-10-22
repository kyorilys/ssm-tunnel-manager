// AWS CLI backed sign-in status and SSO login. spawn/execFile are injected; nothing here touches the network itself.
const CHECK_TIMEOUT_MS = 15000;
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

// Strips URLs that carry a query (device codes) and any 12-digit account number.
const sanitize = (text, max = 200) => String(text)
  .replace(/https?:\/\/\S*\?\S*/g, '[link removed]')
  .replace(/\b\d{12}\b/g, '••••')
  .replace(/\s+/g, ' ').trim().slice(0, max);

const mask = (account) => `••••${String(account).slice(-4)}`;
const maskArn = (arn) => String(arn).replace(/:(\d{12}):/, (_, a) => `:${mask(a)}:`);

function parseIdentity(arn) {
  const resource = String(arn).split(':').slice(5).join(':');
  const parts = resource.split('/');
  if (parts[0] === 'assumed-role' && parts[1]) return parts[1];
  return parts[parts.length - 1] || resource;
}

const RULES = [
  [/Error loading SSO Token|Token for .* does not exist/i, 'signed-out', 'Not signed in. Sign in to continue.'],
  [/expired|refresh.*fail|SSO session.*invalid/i, 'expired', 'The session has expired. Sign in again.'],
  [/InvalidClientTokenId|SignatureDoesNotMatch/i, 'invalid', 'The credentials are not valid.'],
  [/Unable to locate credentials/i, 'no-credentials', 'No credentials found for this profile.'],
  [/Could not connect|Could not resolve|getaddrinfo|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|Name or service not known|Connect timeout|endpoint/i, 'network', 'Could not reach AWS. Check your connection.'],
];

function classify(stderr) {
  const hit = RULES.find(([re]) => re.test(stderr));
  return hit ? { state: hit[1], message: hit[2] } : null;
}
const classifyStderr = (stderr) => (classify(String(stderr)) || { state: 'error' }).state;

function checkProfile(name, deps) {
  const args = ['sts', 'get-caller-identity', '--output', 'json', ...(name ? ['--profile', name] : [])];
  return new Promise((resolve) => {
    const done = (v) => resolve(v);
    try {
      deps.execFile(deps.awsBin || 'aws', args, { env: deps.env, timeout: CHECK_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err) {
          if (err.killed) return done({ state: 'network', message: 'Timed out reaching AWS.' });
          if (err.code === 'ENOENT') return done({ state: 'error', message: 'The aws CLI was not found.' });
          const hit = classify(String(stderr || ''));
          return done(hit || { state: 'error', message: sanitize(stderr || err.message) || 'Could not check the profile.' });
        }
        try {
          const out = JSON.parse(stdout);
          if (!out.Arn || !out.Account) throw new Error('missing fields');
          return done({ state: 'ok', arn: maskArn(out.Arn), identity: parseIdentity(out.Arn), account: mask(out.Account) });
        } catch {
          return done({ state: 'error', message: 'Unexpected response from the aws CLI.' });
        }
      });
    } catch (err) {
      done({ state: 'error', message: sanitize(err.message) });
    }
  });
}

function signIn(name, deps) {
  const onProgress = deps.onProgress || (() => {});
  let child;
  let settle;
  const promise = new Promise((r) => { settle = r; });
  let finished = false;
  let waiting = false;
  let timer;
  let tail = '';
  const finish = (result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    settle(result);
  };
  const kill = () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } };
  try {
    child = deps.spawn(deps.awsBin || 'aws', ['sso', 'login', '--profile', name], { env: deps.env, shell: false, detached: false });
  } catch (err) {
    finish({ ok: false, message: sanitize(err.message) });
    return { promise, cancel() {} };
  }
  onProgress('opening');
  const onData = (buf) => {
    const text = String(buf);
    tail = (tail + text).slice(-2000);
    if (!waiting && /browser|https?:\/\//i.test(text)) { waiting = true; onProgress('waiting'); }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (err) => finish({ ok: false, message: err.code === 'ENOENT' ? 'The aws CLI was not found.' : sanitize(err.message) }));
  child.on('close', (code) => {
    if (code === 0) return finish({ ok: true });
    const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const last = lines.filter((l) => !/^https?:\/\/\S*\?/.test(l)).slice(-2).join(' ');
    return finish({ ok: false, message: sanitize(last) || 'Sign-in failed.' });
  });
  timer = setTimeout(() => { kill(); finish({ ok: false, message: 'Sign-in timed out.' }); }, deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
  const cancel = () => {
    if (finished) return;
    kill();
    finish({ ok: false, cancelled: true, message: 'Sign-in cancelled' });
  };
  return { promise, cancel };
}

module.exports = { checkProfile, signIn, classifyStderr, parseIdentity };
