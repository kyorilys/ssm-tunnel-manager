// A window that exists only while it is open: it is built on first show and released when closed, so a
// closed window costs no memory. Messages that must reach the page (navigate, menu commands) wait until a
// freshly built page has loaded; state broadcasts are simply skipped, because the page asks for state on load.
// activate() brings the app to the front: a menu-bar app is not the active app when its window appears
// a moment later (after loading), so without it the window opens behind whatever app is in front.
function createLazyWindow({ create, activate = () => {} }) {
  let win = null;
  let loaded = false;
  let showWhenReady = false;
  let pending = [];

  const alive = () => Boolean(win) && !win.isDestroyed();

  function build() {
    const w = create();
    win = w;
    loaded = false;
    pending = [];
    w.webContents.once('did-finish-load', () => {
      if (win !== w) return;
      loaded = true;
      for (const [channel, payload] of pending.splice(0)) w.webContents.send(channel, payload);
    });
    w.once('ready-to-show', () => {
      if (win !== w || !showWhenReady) return;
      showWhenReady = false;
      activate();
      w.show();
      w.focus();
    });
    w.on('closed', () => {
      if (win !== w) return;
      win = null;
      loaded = false;
      showWhenReady = false;
      pending = [];
    });
    return w;
  }

  return {
    get: () => (alive() ? win : null),

    show() {
      if (!alive()) build();
      if (!loaded) { showWhenReady = true; return; }
      activate();
      win.show();
      win.focus();
    },

    send(channel, payload) {
      if (alive() && loaded) win.webContents.send(channel, payload);
    },

    sendWhenReady(channel, payload) {
      if (!alive()) return;
      if (loaded) win.webContents.send(channel, payload);
      else pending.push([channel, payload]);
    },
  };
}

module.exports = { createLazyWindow };
