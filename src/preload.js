'use strict';
// Ponte segura entre a janela e o processo principal: só estas funções ficam disponíveis.
const { contextBridge, ipcRenderer } = require('electron');

const inv = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  isDesktop: true,
  readVault: () => inv('vault:read'),
  writeVault: (text, opts) => inv('vault:write', String(text), { snapshot: String((opts && opts.snapshot) || '') }),
  removeVault: () => inv('vault:remove'),
  saveBackup: (text, name) => inv('backup:save', String(text), String(name)),
  openBackup: opts => inv('backup:open', { snapshots: !!(opts && opts.snapshots) }),
  saveCSV: (text, name) => inv('csv:save', String(text), String(name)),
  copy: (text, secret) => inv('clipboard:write', String(text), !!secret),
  clearClipboard: () => inv('clipboard:clear'),
  info: () => inv('app:info'),
  openFolder: which => inv('folder:open', String(which)),
  chooseExtraFolder: opts => inv('extra:choose', { current: !!(opts && opts.current) }),
  clearExtraFolder: () => inv('extra:clear'),
  // Consultas à internet: skin/capa do Minecraft (Mojang/OptiFine) e perfil público da Steam. Nada do cofre vai junto.
  systemIdle: () => inv('system:idle'), // local: segundos sem usar o computador (bloqueio automático)
  fetchMinecraftSkin: (nick, opts) => inv('mc:skin', String(nick), { optifine: !(opts && opts.optifine === false) }),
  refreshMinecraftProfile: (uuid, opts) => inv('mc:refresh', String(uuid), { optifine: !(opts && opts.optifine === false) }),
  fetchSteamProfile: ref => inv('steam:profile', String(ref)),
  // Valorant (não oficial): lê a conta logada no Riot Client deste PC, só quando a pessoa clica. Só leitura.
  valorantSnapshot: () => inv('valorant:snapshot'),
  // imagens das skins: do cache em disco; da internet (valorant-api.com) só com { net: true }, depois de um "Atualizar"
  valorantImages: (uuids, opts) => inv('valorant:images', Array.isArray(uuids) ? uuids.slice(0, 48).map(String) : [], { net: !!(opts && opts.net) }),
  valorantPruneImages: keep => inv('valorant:prune', Array.isArray(keep) ? keep.slice(0, 20000).map(String) : []), // apaga do cache as outras
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
