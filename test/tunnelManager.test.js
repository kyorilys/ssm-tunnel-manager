const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { TunnelManager, backoffMs, buildArgs, MAX_RETRIES } = require('../lib/tunnelManager');

const T = (over = {}) => ({
  name: 'glacier-prod', region: 'us-west-2', target: 'i-123',
  host: 'db.example', port: 5432, local: 15003, auto: true, ...over,
});

function harness(opts = {}) {
  const procs = [];
  const timers = [];
  const spawn = (cmd, args) => {
    const p = new EventEmitter();
    p.pid = 1000 + procs.length;
    p.stderr = new EventEmitter();
    p.killed = false;
    p.kill = () => { p.killed = true; p.emit('close', null, 'SIGTERM'); };
    p.cmd = cmd; p.args = args;
    procs.push(p);
    return p;
  };
  const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; };
  const clearTimer = (t) => { t.cleared = true; };
  const now = { v: 0 };
  const m = new TunnelManager({ spawn, setTimer, clearTimer, now: () => now.v, ...opts });
  return { m, procs, timers, now };
}

test('backoff doubles from 2s and caps at 60s', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 9].map(backoffMs), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
});

test('buildArgs matches the ssm-connect command', () => {
  assert.deepStrictEqual(buildArgs(T()), [
    'ssm', 'start-session', '--region', 'us-west-2', '--target', 'i-123',
    '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
    '--parameters', 'host=db.example,portNumber=5432,localPortNumber=15003',
  ]);
});

test('connect spawns aws and reports active with pid', () => {
  const { m, procs } = harness();
  m.connect(T());
  assert.strictEqual(procs.length, 1);
  assert.strictEqual(m.get('glacier-prod').state, 'active');
  assert.strictEqual(m.get('glacier-prod').pid, 1000);
});

test('unexpected exit of an auto tunnel schedules a reconnect with backoff', () => {
  const { m, procs, timers } = harness();
  m.connect(T());
  procs[0].emit('close', 1, null);
  assert.strictEqual(m.get('glacier-prod').state, 'reconnecting');
  assert.strictEqual(timers.at(-1).ms, 2000);
  timers.at(-1).fn();
  assert.strictEqual(procs.length, 2);
  procs[1].emit('close', 1, null);
  assert.strictEqual(timers.at(-1).ms, 4000);
});

test('user disconnect does not reconnect', () => {
  const { m, procs, timers } = harness();
  m.connect(T());
  m.disconnect('glacier-prod');
  assert.strictEqual(procs[0].killed, true);
  assert.strictEqual(m.get('glacier-prod').state, 'idle');
  assert.strictEqual(timers.filter(t => !t.cleared).length, 0);
});

test('non-auto tunnel that dies is marked failed, not retried', () => {
  const { m, procs, timers } = harness();
  m.connect(T({ auto: false }));
  procs[0].stderr.emit('data', Buffer.from('An error occurred (TargetNotConnected)\n'));
  procs[0].emit('close', 254, null);
  assert.strictEqual(m.get('glacier-prod').state, 'failed');
  assert.match(m.get('glacier-prod').error, /TargetNotConnected/);
  assert.strictEqual(timers.length, 0);
});

test('a session that stayed up 10s+ resets the backoff', () => {
  const { m, procs, timers, now } = harness();
  m.connect(T());
  procs[0].emit('close', 1, null); // attempt 0 -> 2000
  timers.at(-1).fn();
  now.v = 15000;                  // second session lived 15s
  procs[1].emit('close', 1, null);
  assert.strictEqual(timers.at(-1).ms, 2000);
});

test('wake from sleep retries waiting tunnels immediately', () => {
  const { m, procs, timers } = harness();
  m.connect(T());
  procs[0].emit('close', 1, null);
  const pending = timers.at(-1);
  m.onWake();
  assert.strictEqual(pending.cleared, true);
  assert.strictEqual(procs.length, 2);
  assert.strictEqual(m.get('glacier-prod').state, 'active');
});

test('connectAuto only starts tunnels flagged auto', () => {
  const { m, procs } = harness();
  m.connectAuto([T(), T({ name: 'x', auto: false, local: 9 })]);
  assert.strictEqual(procs.length, 1);
});

test('emits change events for the UI', () => {
  const { m, procs } = harness();
  const seen = [];
  m.on('change', (n, s) => seen.push(`${n}:${s.state}`));
  m.connect(T());
  procs[0].emit('close', 1, null);
  assert.deepStrictEqual(seen, ['glacier-prod:connecting', 'glacier-prod:active', 'glacier-prod:reconnecting']);
});

// Drive an auto tunnel through `n` unexpected exits, firing each retry timer.
const crash = ({ m, procs, timers }, n, line) => {
  for (let i = 0; i < n; i++) {
    const p = procs.at(-1);
    if (line) p.stderr.emit('data', Buffer.from(`${line}\n`));
    p.emit('close', 1, null);
    const t = timers.at(-1);
    if (m.get('glacier-prod').state === 'reconnecting' && !t.cleared) t.fn();
  }
};

test('MAX_RETRIES is 5', () => {
  assert.strictEqual(MAX_RETRIES, 5);
});

test('an auto tunnel gives up after 5 retries (6 spawns) with no further timer', () => {
  const h = harness();
  h.m.connect(T());
  crash(h, 5);
  assert.deepStrictEqual(h.timers.map((t) => t.ms), [2000, 4000, 8000, 16000, 32000]);
  assert.strictEqual(h.procs.length, 6);
  h.procs[5].stderr.emit('data', Buffer.from('boom\n'));
  h.procs[5].emit('close', 1, null);
  const s = h.m.get('glacier-prod');
  assert.strictEqual(s.state, 'failed');
  assert.strictEqual(s.gaveUp, true);
  assert.match(s.error, /^Gave up after 5 attempts: /);
  assert.strictEqual(s.error, 'Gave up after 5 attempts: boom');
  assert.strictEqual(s.nextAt, null);
  assert.strictEqual(h.timers.length, 5);
  assert.strictEqual(h.procs.length, 6);
});

test('non-auto tunnel goes straight to failed with gaveUp false', () => {
  const { m, procs, timers } = harness();
  m.connect(T({ auto: false }));
  procs[0].emit('close', 1, null);
  assert.strictEqual(m.get('glacier-prod').state, 'failed');
  assert.strictEqual(m.get('glacier-prod').gaveUp, false);
  assert.strictEqual(timers.length, 0);
});

test('the backoff timer does not reset the attempt counter', () => {
  const h = harness();
  h.m.connect(T());
  h.procs[0].emit('close', 1, null);
  assert.strictEqual(h.m.get('glacier-prod').attempt, 1);
  h.timers.at(-1).fn();
  assert.strictEqual(h.m.get('glacier-prod').attempt, 1);
  h.procs[1].emit('close', 1, null);
  assert.strictEqual(h.m.get('glacier-prod').attempt, 2);
});

test('user connect on a failed (gave up) tunnel resets attempts and gaveUp', () => {
  const h = harness();
  h.m.connect(T());
  crash(h, 6);
  assert.strictEqual(h.m.get('glacier-prod').gaveUp, true);
  h.m.connect(T());
  const s = h.m.get('glacier-prod');
  assert.strictEqual(s.state, 'active');
  assert.strictEqual(s.gaveUp, false);
  assert.strictEqual(s.attempt, 0);
  assert.strictEqual(s.failingSince, null);
  h.procs.at(-1).emit('close', 1, null);
  assert.strictEqual(h.timers.at(-1).ms, 2000);
});

test('user connect on a reconnecting tunnel clears the pending timer and spawns', () => {
  const h = harness();
  h.m.connect(T());
  h.procs[0].emit('close', 1, null);
  const pending = h.timers.at(-1);
  h.m.connect(T());
  assert.strictEqual(pending.cleared, true);
  assert.strictEqual(h.procs.length, 2);
  assert.strictEqual(h.m.get('glacier-prod').attempt, 0);
});

test('connect while a process is running is a no-op', () => {
  const { m, procs } = harness();
  m.connect(T());
  m.connect(T());
  assert.strictEqual(procs.length, 1);
});

test('get reports unknown names as idle with null/0/false fields', () => {
  const { m } = harness();
  assert.deepStrictEqual(m.get('nope'), {
    state: 'idle', pid: null, since: null, error: null, errorAt: null, failingSince: null,
    attempt: 0, maxAttempts: 5, nextAt: null, gaveUp: false,
  });
});

test('get exposes attempt, nextAt and errorAt while reconnecting', () => {
  const { m, procs, now } = harness();
  m.connect(T());
  now.v = 5000;
  procs[0].emit('close', 1, null);
  const s = m.get('glacier-prod');
  assert.strictEqual(s.state, 'reconnecting');
  assert.strictEqual(s.attempt, 1);
  assert.strictEqual(s.maxAttempts, 5);
  assert.strictEqual(s.nextAt, 7000);
  assert.strictEqual(s.errorAt, 5000);
  assert.strictEqual(s.failingSince, 5000);
});

test('nextAt clears once the retry spawns', () => {
  const h = harness();
  h.m.connect(T());
  h.procs[0].emit('close', 1, null);
  h.timers.at(-1).fn();
  assert.strictEqual(h.m.get('glacier-prod').nextAt, null);
});

test('failingSince keeps the first failure of a streak, restarts after a stable session, clears on disconnect', () => {
  const h = harness();
  h.m.connect(T());
  h.now.v = 1000;
  h.procs[0].emit('close', 1, null);
  h.timers.at(-1).fn();
  h.now.v = 3000;
  h.procs[1].emit('close', 1, null);
  assert.strictEqual(h.m.get('glacier-prod').failingSince, 1000);
  assert.strictEqual(h.m.get('glacier-prod').errorAt, 3000);
  h.timers.at(-1).fn();
  h.now.v = 20000; // third session lived 17s
  h.procs[2].emit('close', 1, null);
  assert.strictEqual(h.m.get('glacier-prod').failingSince, 20000);
  assert.strictEqual(h.m.get('glacier-prod').attempt, 1);
  h.m.disconnect('glacier-prod');
  assert.strictEqual(h.m.get('glacier-prod').failingSince, null);
  assert.strictEqual(h.m.get('glacier-prod').attempt, 0);
});

test('retry on a gave-up tunnel resets and spawns now', () => {
  const h = harness();
  h.m.connect(T());
  crash(h, 6);
  h.m.retry('glacier-prod');
  const s = h.m.get('glacier-prod');
  assert.strictEqual(h.procs.length, 7);
  assert.strictEqual(s.state, 'active');
  assert.strictEqual(s.gaveUp, false);
  assert.strictEqual(s.attempt, 0);
});

test('retry on a reconnecting tunnel clears its timer', () => {
  const h = harness();
  h.m.connect(T());
  h.procs[0].emit('close', 1, null);
  const pending = h.timers.at(-1);
  h.m.retry('glacier-prod');
  assert.strictEqual(pending.cleared, true);
  assert.strictEqual(h.procs.length, 2);
});

test('retry is a no-op for unknown names and running tunnels', () => {
  const { m, procs } = harness();
  m.retry('nope');
  m.connect(T());
  m.retry('glacier-prod');
  assert.strictEqual(procs.length, 1);
  assert.strictEqual(m.get('nope').state, 'idle');
});

test('update turning auto on for a failed tunnel enters the retry loop', () => {
  const h = harness();
  h.m.connect(T({ auto: false }));
  h.now.v = 100;
  h.procs[0].emit('close', 1, null);
  h.m.update(T({ auto: true }));
  const s = h.m.get('glacier-prod');
  assert.strictEqual(s.state, 'reconnecting');
  assert.strictEqual(s.attempt, 1);
  assert.strictEqual(s.gaveUp, false);
  assert.strictEqual(s.nextAt, 2100);
  assert.strictEqual(h.timers.at(-1).ms, 2000);
  h.timers.at(-1).fn();
  assert.strictEqual(h.procs.length, 2);
});

test('update turning auto on revives a gave-up tunnel', () => {
  const h = harness();
  h.m.connect(T());
  crash(h, 6);
  h.m.update(T({ auto: false })); // the user switches Auto off ...
  h.m.update(T({ auto: true })); // ... and on again
  assert.strictEqual(h.m.get('glacier-prod').state, 'reconnecting');
  assert.strictEqual(h.m.get('glacier-prod').gaveUp, false);
  assert.strictEqual(h.m.get('glacier-prod').attempt, 1);
});

test('update turning auto off while reconnecting clears the timer and fails, keeping the error', () => {
  const h = harness();
  h.m.connect(T());
  h.procs[0].stderr.emit('data', Buffer.from('nope\n'));
  h.procs[0].emit('close', 1, null);
  const pending = h.timers.at(-1);
  h.m.update(T({ auto: false }));
  const s = h.m.get('glacier-prod');
  assert.strictEqual(pending.cleared, true);
  assert.strictEqual(s.state, 'failed');
  assert.strictEqual(s.error, 'nope');
  assert.strictEqual(s.nextAt, null);
});

test('update replaces the stored config for the next spawn and ignores unknown names', () => {
  const h = harness();
  h.m.update(T());
  assert.strictEqual(h.m.get('glacier-prod').state, 'idle');
  h.m.connect(T());
  h.m.update(T({ local: 9999 }));
  h.procs[0].emit('close', 1, null);
  h.timers.at(-1).fn();
  assert.match(h.procs[1].args.join(' '), /localPortNumber=9999/);
});

test('update emits change only when state changes', () => {
  const h = harness();
  h.m.connect(T());
  const seen = [];
  h.m.on('change', (n, s) => seen.push(s.state));
  h.m.update(T({ desc: 'x' }));
  assert.deepStrictEqual(seen, []);
});

test('disconnect uses the injected kill with (proc, SIGTERM)', () => {
  const calls = [];
  const h = harness({ kill: (proc, signal) => { calls.push([proc, signal]); proc.emit('close', null, signal); } });
  h.m.connect(T());
  h.m.disconnect('glacier-prod');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], h.procs[0]);
  assert.strictEqual(calls[0][1], 'SIGTERM');
  assert.strictEqual(h.m.get('glacier-prod').state, 'idle');
});

test('ownedPids lists running procs only', () => {
  const { m, procs } = harness();
  m.connect(T());
  m.connect(T({ name: 'b', local: 2, auto: false }));
  assert.deepStrictEqual(m.ownedPids(), [1000, 1001]);
  procs[1].emit('close', 1, null);
  assert.deepStrictEqual(m.ownedPids(), [1000]);
});

test('connectAuto skips archived tunnels', () => {
  const { m, procs } = harness();
  m.connectAuto([T({ archived: true }), T({ name: 'y', local: 5 })]);
  assert.strictEqual(procs.length, 1);
  assert.strictEqual(m.get('glacier-prod').state, 'idle');
});

test('wake does not retry failed or gave-up tunnels', () => {
  const h = harness();
  h.m.connect(T());
  crash(h, 6);
  const spawned = h.procs.length;
  h.m.onWake();
  assert.strictEqual(h.procs.length, spawned);
  assert.strictEqual(h.m.get('glacier-prod').state, 'failed');
});

test('wake keeps the failing streak start', () => {
  const h = harness();
  h.m.connect(T());
  h.now.v = 700;
  h.procs[0].emit('close', 1, null);
  h.m.onWake();
  assert.strictEqual(h.m.get('glacier-prod').failingSince, 700);
});

test('shutdown resolves immediately when nothing runs', async () => {
  const { m, timers } = harness();
  await m.shutdown();
  assert.strictEqual(timers.length, 0);
});

test('shutdown terminates every proc, cancels retry timers and resolves on exit', async () => {
  const calls = [];
  const h = harness({ kill: (p, sig) => { calls.push(sig); p.emit('close', null, sig); } });
  h.m.connect(T());
  h.m.connect(T({ name: 'b', local: 2 }));
  h.procs[1].emit('close', 1, null); // b is reconnecting
  const pending = h.timers.at(-1);
  await h.m.shutdown();
  assert.deepStrictEqual(calls, ['SIGTERM']);
  assert.strictEqual(pending.cleared, true);
  assert.strictEqual(h.m.get('glacier-prod').state, 'idle');
  assert.strictEqual(h.m.get('b').state, 'idle');
  assert.deepStrictEqual(h.m.ownedPids(), []);
});

test('shutdown SIGKILLs procs that ignore SIGTERM after timeoutMs', async () => {
  const calls = [];
  const h = harness({ kill: (p, sig) => { calls.push([p.pid, sig]); } });
  h.m.connect(T());
  h.m.connect(T({ name: 'b', local: 2 }));
  const done = h.m.shutdown({ timeoutMs: 1234 });
  assert.deepStrictEqual(calls, [[1000, 'SIGTERM'], [1001, 'SIGTERM']]);
  const deadline = h.timers.at(-1);
  assert.strictEqual(deadline.ms, 1234);
  h.procs[0].emit('close', null, 'SIGTERM'); // a exits, b hangs
  deadline.fn();
  await done;
  assert.deepStrictEqual(calls.slice(2), [[1001, 'SIGKILL']]);
});

// ---- live-test findings ----------------------------------------------------

test('the reported error skips the outdated-plugin warning that aws prints at session start', () => {
  const h = harness({ shouldRetry: () => true });
  h.m.connect(T({ auto: false }));
  h.procs[0].stderr.emit('data', Buffer.from([
    'WARNING: An outdated SessionManagerPlugin version detected. Please upgrade it to the latest version. ',
    'For more information, refer:',
    '  https://docs.aws.amazon.com/systems-manager/latest/userguide/plugin-version-history.html',
    '',
  ].join('\n')));
  h.procs[0].emit('close', 255, null);
  assert.strictEqual(h.m.get('glacier-prod').error, 'Session ended');
});

test('a real error after the warning is the one reported', () => {
  const h = harness();
  h.m.connect(T({ auto: false }));
  h.procs[0].stderr.emit('data', Buffer.from([
    'WARNING: An outdated SessionManagerPlugin version detected. Please upgrade it to the latest version. ',
    'For more information, refer:',
    '  https://docs.aws.amazon.com/systems-manager/latest/userguide/plugin-version-history.html',
    'An error occurred (TargetNotConnected) when calling the StartSession operation: i-0357e26df0d26b2ae is not connected.',
    '',
  ].join('\n')));
  h.procs[0].emit('close', 254, null);
  assert.match(h.m.get('glacier-prod').error, /^An error occurred \(TargetNotConnected\)/);
});

// ---- review findings -------------------------------------------------------

test('#3 re-applying unchanged config to a tunnel that gave up does not restart its retries', () => {
  const h = harness();
  h.m.connect(T());
  for (let i = 0; i < 5; i++) { h.procs.at(-1).emit('close', 1, null); h.timers.at(-1).fn(); }
  h.procs.at(-1).emit('close', 1, null);
  assert.strictEqual(h.m.get('glacier-prod').gaveUp, true);
  const timersBefore = h.timers.length;
  h.m.update(T()); // what a reload of the shared file does
  assert.strictEqual(h.m.get('glacier-prod').state, 'failed');
  assert.strictEqual(h.timers.length, timersBefore, 'no new retry round');
});

test('#6 turning Auto on keeps the original failing-since time', () => {
  const h = harness();
  h.m.connect(T({ auto: false }));
  h.now.v = 1000;
  h.procs[0].emit('close', 1, null);
  assert.strictEqual(h.m.get('glacier-prod').failingSince, 1000);
  h.now.v = 50000;
  h.m.update(T({ auto: true }));
  assert.strictEqual(h.m.get('glacier-prod').failingSince, 1000);
});

test('#5 connect while the previous session is still exiting restarts once it closes', () => {
  const procs = [];
  const spawn = () => {
    const p = new EventEmitter();
    p.pid = 1000 + procs.length;
    p.stderr = new EventEmitter();
    p.kill = () => {}; // SIGTERM sent, process takes its time
    procs.push(p);
    return p;
  };
  const m = new TunnelManager({ spawn, setTimer: () => ({}), clearTimer: () => {}, now: () => 0 });
  m.connect(T());
  m.disconnect('glacier-prod');
  m.connect(T());
  assert.strictEqual(procs.length, 1, 'no second spawn while the old one still holds the port');
  procs[0].emit('close', null, 'SIGTERM');
  assert.strictEqual(procs.length, 2, 'restarted after the old session closed');
  assert.strictEqual(m.get('glacier-prod').state, 'active');
});

test('#5 a disconnect after that pending restart cancels it', () => {
  const procs = [];
  const spawn = () => { const p = new EventEmitter(); p.pid = 1; p.stderr = new EventEmitter(); p.kill = () => {}; procs.push(p); return p; };
  const m = new TunnelManager({ spawn, setTimer: () => ({}), clearTimer: () => {}, now: () => 0 });
  m.connect(T());
  m.disconnect('glacier-prod');
  m.connect(T());
  m.disconnect('glacier-prod');
  procs[0].emit('close', null, 'SIGTERM');
  assert.strictEqual(procs.length, 1);
  assert.strictEqual(m.get('glacier-prod').state, 'idle');
});

test('#8 with a stderr sink, the child writes to a file descriptor, not a pipe back to the app', () => {
  const opts = [];
  const procs = [];
  const sinks = [];
  const spawn = (cmd, args, o) => { const p = new EventEmitter(); p.pid = 7; p.kill = () => {}; opts.push(o); procs.push(p); return p; };
  const stderrSink = (name) => {
    const s = { name, fd: 99, released: false, release() { this.released = true; }, read() { return 'noise\nAn error occurred (TargetNotConnected)\n'; } };
    sinks.push(s);
    return s;
  };
  const m = new TunnelManager({ spawn, stderrSink, setTimer: () => ({}), clearTimer: () => {}, now: () => 0 });
  m.connect(T({ auto: false }));
  assert.deepStrictEqual(opts[0].stdio, ['ignore', 'ignore', 99]);
  assert.strictEqual(sinks[0].released, true, 'the app closes its copy right after spawning');
  procs[0].emit('close', 255, null);
  assert.strictEqual(m.get('glacier-prod').error, 'An error occurred (TargetNotConnected)');
});

test('#1 shouldRetry hook can veto a reconnect after an unexpected exit', () => {
  const h = harness({ shouldRetry: () => false });
  h.m.connect(T());
  h.procs[0].emit('close', null, 'SIGTERM'); // killed from outside, e.g. by the CLI
  assert.strictEqual(h.m.get('glacier-prod').state, 'idle');
  assert.strictEqual(h.timers.length, 0, 'no reconnect scheduled');
});
