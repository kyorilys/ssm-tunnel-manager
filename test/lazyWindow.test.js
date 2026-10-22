const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createLazyWindow } = require('../lib/lazyWindow');

// A stand-in for BrowserWindow with just what lazyWindow uses.
function fakeWindow(log) {
  const w = new EventEmitter();
  w.webContents = new EventEmitter();
  w.webContents.sent = [];
  w.webContents.send = (channel, payload) => w.webContents.sent.push([channel, payload]);
  w.destroyed = false;
  w.visible = false;
  w.isDestroyed = () => w.destroyed;
  w.isVisible = () => w.visible;
  w.show = () => { w.visible = true; log.push('show'); };
  w.focus = () => log.push('focus');
  w.load = () => { w.webContents.emit('did-finish-load'); w.emit('ready-to-show'); };
  w.close = () => { w.destroyed = true; w.emit('closed'); };
  return w;
}

function setup() {
  const log = [];
  const made = [];
  const lazy = createLazyWindow({ create: () => { const w = fakeWindow(log); made.push(w); log.push('create'); return w; } });
  return { lazy, made, log };
}

test('nothing is created until the window is first shown', () => {
  const { lazy, made } = setup();
  assert.strictEqual(lazy.get(), null);
  assert.strictEqual(made.length, 0);
});

test('show creates the window and shows it once the page is ready', () => {
  const { lazy, made, log } = setup();
  lazy.show();
  assert.strictEqual(made.length, 1);
  assert.deepStrictEqual(log, ['create'], 'not shown before ready-to-show');
  made[0].load();
  assert.deepStrictEqual(log, ['create', 'show', 'focus']);
});

test('closing releases the window; showing again builds a new one', () => {
  const { lazy, made } = setup();
  lazy.show();
  made[0].load();
  made[0].close();
  assert.strictEqual(lazy.get(), null);
  lazy.show();
  assert.strictEqual(made.length, 2);
  made[1].load();
  assert.strictEqual(made[1].visible, true);
});

test('show on a loaded window just shows it, without rebuilding', () => {
  const { lazy, made, log } = setup();
  lazy.show();
  made[0].load();
  made[0].visible = false;
  lazy.show();
  assert.strictEqual(made.length, 1);
  assert.deepStrictEqual(log.slice(-2), ['show', 'focus']);
});

test('sendWhenReady queues messages until a new window has loaded, in order', () => {
  const { lazy, made } = setup();
  lazy.show();
  lazy.sendWhenReady('ssm:event', { type: 'navigate', sheet: 'settings' });
  lazy.sendWhenReady('ssm:event', { type: 'command', command: 'new' });
  assert.deepStrictEqual(made[0].webContents.sent, []);
  made[0].load();
  assert.deepStrictEqual(made[0].webContents.sent.map(([, p]) => p.type), ['navigate', 'command']);
});

test('sendWhenReady on a loaded window sends at once', () => {
  const { lazy, made } = setup();
  lazy.show();
  made[0].load();
  lazy.sendWhenReady('ssm:event', { type: 'navigate', view: 'logs' });
  assert.strictEqual(made[0].webContents.sent.length, 1);
});

test('send (state broadcasts) is dropped when there is no loaded window; the page asks for state on load', () => {
  const { lazy, made } = setup();
  lazy.send('ssm:state', { n: 1 }); // no window
  lazy.show();
  lazy.send('ssm:state', { n: 2 }); // still loading
  made[0].load();
  lazy.send('ssm:state', { n: 3 });
  assert.deepStrictEqual(made[0].webContents.sent.map(([, p]) => p.n), [3]);
});

test('showing brings the app to the front first, for a new window and for a loaded one', () => {
  const log = [];
  const made = [];
  const lazy = createLazyWindow({
    create: () => { const w = fakeWindow(log); made.push(w); return w; },
    activate: () => log.push('activate'),
  });
  lazy.show();
  made[0].load(); // a freshly built window appears only after loading
  assert.deepStrictEqual(log, ['activate', 'show', 'focus']);
  made[0].visible = false;
  lazy.show(); // already loaded
  assert.deepStrictEqual(log.slice(3), ['activate', 'show', 'focus']);
});

test('messages queued for a window that closes before loading are discarded', () => {
  const { lazy, made } = setup();
  lazy.show();
  lazy.sendWhenReady('ssm:event', { type: 'navigate' });
  made[0].close();
  lazy.show();
  made[1].load();
  assert.deepStrictEqual(made[1].webContents.sent, []);
});
