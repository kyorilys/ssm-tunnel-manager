const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preloads cannot require local files, so this list mirrors CHANNELS in lib/ipc.js (test/ipc.test.js checks it).
const METHODS = [
  'getState', 'connect', 'disconnect', 'reconnect', 'retry', 'setAuto', 'saveTunnel', 'addTunnel',
  'deleteTunnel', 'restoreArchived', 'dismissNotice', 'disconnectAll', 'disconnectEnv', 'killTerminal',
  'checkPort', 'updateSettings', 'importTunnels', 'copy', 'openMain', 'resizePopover',
  'logs:read', 'logs:info', 'logs:open',
  'aws:profiles', 'aws:test', 'aws:signIn', 'aws:cancelSignIn', 'aws:addSso', 'aws:addKeys', 'aws:removeProfile',
];

const subscribe = (channel) => (cb) => {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api = { onState: subscribe('ssm:state'), onEvent: subscribe('ssm:event') };
// 'logs:read' is exposed as window.ssm.logsRead, 'aws:signIn' as window.ssm.awsSignIn.
for (const name of METHODS) api[name.replace(/:(\w)/, (_, c) => c.toUpperCase())] = (...args) => ipcRenderer.invoke(`ssm:${name}`, ...args);

contextBridge.exposeInMainWorld('ssm', api);
