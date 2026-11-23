'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('runner', {
  playWithUrl: (url) => ipcRenderer.invoke('game:play-with-url', url),
  setGameMode: (enabled) => ipcRenderer.invoke('window:game-mode', enabled),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
});
