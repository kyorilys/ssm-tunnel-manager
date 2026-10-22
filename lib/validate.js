// UMD: require() in Node, window.SSMValidate in the sandboxed renderer. Pure, no Node APIs.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SSMValidate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ENVS = ['production', 'staging', 'other'];

  const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
  const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;
  // AWS commercial regions for the region pickers, AWS's default first. Any region matching REGION_RE is accepted.
  const AWS_REGIONS = [
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'ca-west-1', 'mx-central-1', 'sa-east-1',
    'eu-central-1', 'eu-central-2', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-south-1', 'eu-south-2', 'eu-north-1',
    'il-central-1', 'me-south-1', 'me-central-1', 'af-south-1',
    'ap-east-1', 'ap-east-2', 'ap-south-1', 'ap-south-2', 'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3',
    'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-6', 'ap-southeast-7', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  ];
  // Shared by the app, the CLI and the renderer, so they cannot drift apart.
  const STABLE_MS = 10000; // a session up this long counts as healthy: backoff and the failure clock reset
  const FAILING = new Set(['failed', 'reconnecting']);
  const HOST_RE = /^[A-Za-z0-9._:-]+$/; // DNS names, IPv4, bare IPv6; keeps shell metacharacters out of the copied aws command
  const TARGET_RE = /^i-[0-9a-f]{8,17}$/;
  const RESERVED_NAMES = ['all']; // CLI keyword (`up all`, `down all`): a tunnel with this name could never be addressed
  const PROFILE_RE = /^[A-Za-z0-9_.+=,@-]{1,64}$/; // AWS CLI profile name; no spaces or shell metacharacters
  // Errors that mean "sign in again" (expired or missing SSO login), as opposed to a broken tunnel.
  const SIGNIN_ERROR = /Error loading SSO Token|Token for .+ does not exist|SSO session\b.*\bhas expired|UnauthorizedSSOToken|ExpiredToken|security token included in the request is expired/i;
  const PORT_MSG = 'Enter a port from 1 to 65535';

  function inferEnv(name) {
    const n = String(name == null ? '' : name);
    if (/stg|staging/i.test(n)) return 'staging';
    if (/prod/i.test(n)) return 'production';
    return 'other';
  }

  const str = (v) => (v == null ? '' : String(v).trim());
  const num = (v) => (typeof v === 'string' ? Number(v.trim() === '' ? NaN : v) : Number(v == null ? NaN : v));

  function normalizeTunnel(t) {
    const src = t || {};
    return {
      name: str(src.name),
      region: str(src.region),
      target: str(src.target),
      host: str(src.host),
      port: num(src.port),
      local: num(src.local),
      desc: str(src.desc),
      env: typeof src.env === 'string' ? src.env.trim() : src.env,
      auto: Boolean(src.auto),
      profile: str(src.profile),
    };
  }

  const isPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;

  function validateTunnel(t, others) {
    const n = normalizeTunnel(t);
    const list = others || [];
    const errors = {};

    if (!n.name) errors.name = 'Required';
    else if (n.name.length > 64 || !NAME_RE.test(n.name)) errors.name = 'Use lowercase letters, digits, - . _';
    else if (RESERVED_NAMES.includes(n.name)) errors.name = `“${n.name}” is reserved`;
    else {
      const dup = list.find((o) => o.name === n.name);
      if (dup) errors.name = `“${n.name}” already exists${dup.archived ? ' (archived)' : ''}`;
    }

    if (!REGION_RE.test(n.region)) errors.region = 'Expected an AWS region like us-east-1';
    if (!TARGET_RE.test(n.target)) errors.target = 'Expected an EC2 instance ID like i-0357e26df0d26b2ae';
    if (!n.host) errors.host = 'Required';
    else if (!HOST_RE.test(n.host)) errors.host = 'Host may only contain letters, digits, . _ : -';
    if (!isPort(n.port)) errors.port = PORT_MSG;
    if (!isPort(n.local)) errors.local = PORT_MSG;
    if (ENVS.indexOf(n.env) === -1) errors.env = 'Pick an environment';
    if (n.profile && !PROFILE_RE.test(n.profile)) errors.profile = 'Profile may only contain letters, digits and _ . + = , @ - (up to 64)';

    const clashes = list
      .filter((o) => !o.archived && Number(o.local) === n.local)
      .map((o) => ({ name: o.name, auto: Boolean(o.auto) }));

    return { errors, clashes };
  }

  return { inferEnv, normalizeTunnel, validateTunnel, ENVS, REGION_RE, AWS_REGIONS, STABLE_MS, FAILING, SIGNIN_ERROR };
});
