'use strict';
// Ponte segura entre a janela e o processo principal: só estas funções ficam disponíveis.
const { contextBridge, ipcRenderer } = require('electron');

const inv = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  isDesktop: true,
  readVault: () => inv('vault:read'),
  writeVault: text => inv('vault:write', String(text)),
  removeVault: () => inv('vault:remove'),
  saveBackup: (text, name) => inv('backup:save', String(text), String(name)),
  openBackup: opts => inv('backup:open', { snapshots: !!(opts && opts.snapshots) }),
  saveCSV: (text, name) => inv('csv:save', String(text), String(name)),
  copy: (text, secret) => inv('clipboard:write', String(text), !!secret),
  clearClipboard: () => inv('clipboard:clear'),
  info: () => inv('app:info'),
  openFolder: which => inv('folder:open', String(which)),
  chooseExtraFolder: () => inv('extra:choose'),
  clearExtraFolder: () => inv('extra:clear'),
  // Consultas à internet: skin/capa do Minecraft (Mojang/OptiFine) e perfil público da Steam. Nada do cofre vai junto.
  fetchMinecraftSkin: (nick, opts) => inv('mc:skin', String(nick), { optifine: !(opts && opts.optifine === false) }),
  refreshMinecraftProfile: (uuid, opts) => inv('mc:refresh', String(uuid), { optifine: !(opts && opts.optifine === false) }),
  fetchSteamProfile: ref => inv('steam:profile', String(ref)),
  updateStatus: () => inv('update:status'),
  checkUpdate: () => inv('update:check'),
  installUpdate: () => inv('update:install'),
  setTitleBar: opts => inv('window:titlebar', {
    color: String(opts && opts.color), symbolColor: String(opts && opts.symbolColor), height: Number(opts && opts.height)
  }),
  onEvent: callback => {
    const listener = (_e, name) => callback(String(name));
    ipcRenderer.on('app:event', listener);
    return () => ipcRenderer.removeListener('app:event', listener);
  }
}));
