'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld(
  'rooms',
  Object.freeze({
    detectAgents: () => ipcRenderer.invoke('rooms:detect-agents'),
    chooseDirectory: () => ipcRenderer.invoke('rooms:choose-directory'),
    createSession: (options) => ipcRenderer.invoke('rooms:create-session', options),
    writeSession: (options) => ipcRenderer.invoke('rooms:write-session', options),
    resizeSession: (options) => ipcRenderer.invoke('rooms:resize-session', options),
    closeSession: (id) => ipcRenderer.invoke('rooms:close-session', id),
    onOutput: (callback) => subscribe('rooms:output', callback),
    onExit: (callback) => subscribe('rooms:exit', callback),
    loadState: () => ipcRenderer.invoke('rooms:load-state'),
    saveState: (state) => ipcRenderer.invoke('rooms:save-state', state),
  }),
);
