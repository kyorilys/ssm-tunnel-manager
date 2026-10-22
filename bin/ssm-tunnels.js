#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run } = require('../lib/cli');
const { Store } = require('../lib/store');
const scan = require('../lib/scan');
const { resolveAwsBin, buildEnv } = require('../lib/env');
const { createLogger, defaultLogFile } = require('../lib/logger');
const { version } = require('../package.json');

const file = process.env.SSM_TUNNELS_DATA
  || path.join(os.homedir(), 'Library', 'Application Support', 'SSM Tunnels', 'connections.json');

const logFile = defaultLogFile(process.env);
const abort = new AbortController();
if (process.argv[2] === 'logs') process.on('SIGINT', () => abort.abort()); // ends `logs --follow` cleanly

run(process.argv.slice(2), {
  store: new Store({ file }),
  scan,
  spawn,
  awsBin: resolveAwsBin(fs.existsSync),
  childEnv: buildEnv(process.env),
  now: Date.now,
  isTTY: Boolean(process.stdout.isTTY),
  env: process.env,
  version,
  logger: createLogger({ file: logFile, source: 'cli' }),
  logFile,
  write: (text) => process.stdout.write(text),
  signal: abort.signal,
}).then(({ code, out, err }) => {
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exitCode = code;
});
