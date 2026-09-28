'use strict';
// Processo principal do Harmful (Electron).
// Guarda o cofre criptografado em %APPDATA%\Harmful\cofre.json, mantém cópias automáticas
// e oferece diálogos nativos para backup/importação. A criptografia acontece na janela (renderer):
// este processo só recebe e grava o texto já criptografado.
// Única exceção à regra "nada vai para a internet": a busca da skin do Minecraft, feita aqui (não na
// janela) e só quando o usuário clica para buscar. Veja "Minecraft" abaixo.
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, powerMonitor, session, screen, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');

const APP_NAME = 'Harmful';
const MAX_BYTES = 50 * 1024 * 1024;
const SNAPSHOT_KEEP = 30;
const SNAPSHOT_INTERVAL_MS = 30 * 60 * 1000;
const EXTRA_FILE = 'harmful-backup.json';

app.setName(APP_NAME);
if (process.env.COFRE_GAMER_DATA_DIR) app.setPath('userData', path.resolve(process.env.COFRE_GAMER_DATA_DIR));
// Somente em desenvolvimento: permite que os testes automáticos respondam aos diálogos de arquivo.
const E2E_DIR = !app.isPackaged && process.env.COFRE_GAMER_E2E_DIR ? path.resolve(process.env.COFRE_GAMER_E2E_DIR) : null;
const E2E_HIDDEN = !app.isPackaged && process.env.COFRE_GAMER_E2E_HIDDEN === '1';

const paths = {
  get data() { return app.getPath('userData'); },
  get vault() { return path.join(this.data, 'cofre.json'); },
  get snapshots() { return path.join(this.data, 'copias-automaticas'); },
  get config() { return path.join(this.data, 'config.json'); }
};

let win = null;
let config = {};
let extraStatus = { state: 'off', error: '', at: null };
let lastSnapshotAt = 0;
let writeChain = Promise.resolve();
let lastSecretHash = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
function safeFileName(name, fallback) {
  const n = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().slice(0, 120);
  return n || fallback;
}

/* ---------------- Arquivos ---------------- */
async function atomicWrite(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } catch (e) {
    // disco cheio, pendrive removido etc.: não deixa o .tmp parcial para trás (no CSV ele teria senhas em texto)
    await fh.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  await fh.close();
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
      await sleep(60 * (i + 1)); // antivírus/indexador segurando o arquivo por um instante
    }
  }
}
function isEnvelopeText(text) {
  if (typeof text !== 'string' || !text || text.length > MAX_BYTES) return false;
  try {
    const j = JSON.parse(text);
    return !!(j && j.app === 'cofre-gamer' && typeof j.data === 'string' && j.kdf && j.cipher);
  } catch {
    return false;
  }
}
async function exists(file) {
  try { await fsp.access(file); return true; } catch { return false; }
}
async function listSnapshots() {
  let names = [];
  try { names = await fsp.readdir(paths.snapshots); } catch { return []; }
  // ordena pela data no nome (não pelo nome inteiro: "cofre-apagado-…" não pode passar na frente das mais novas)
  const key = n => (n.match(/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.json$/i) || [null, ''])[1];
  return names.filter(n => /^cofre-.*\.json$/i.test(n)).sort((a, b) => key(b).localeCompare(key(a)));
}
async function pruneSnapshots() {
  const names = await listSnapshots();
  for (const n of names.slice(SNAPSHOT_KEEP)) await fsp.rm(path.join(paths.snapshots, n), { force: true }).catch(() => {});
}
async function snapshot(prefix) {
  if (!(await exists(paths.vault))) return;
  await fsp.mkdir(paths.snapshots, { recursive: true });
  await fsp.copyFile(paths.vault, path.join(paths.snapshots, `${prefix}-${stamp(new Date())}.json`));
  lastSnapshotAt = Date.now();
  await pruneSnapshots();
}
async function initSnapshotClock() {
  const names = await listSnapshots();
  if (!names.length) return;
  try { lastSnapshotAt = (await fsp.stat(path.join(paths.snapshots, names[0]))).mtimeMs; } catch { /* ignora */ }
}
async function writeExtra(text) {
  const dir = config.extraBackupDir;
  if (!dir) {
    extraStatus = { state: 'off', error: '', at: null };
    return extraStatus;
  }
  try {
    await atomicWrite(path.join(dir, EXTRA_FILE), text);
    extraStatus = { state: 'ok', error: '', at: new Date().toISOString() };
  } catch (e) {
    extraStatus = { state: 'error', error: e.code === 'ENOENT' ? 'a pasta não foi encontrada (pendrive desconectado?)' : e.message, at: extraStatus.at };
  }
  return extraStatus;
}
function loadConfig() {
  let text = null;
  try { text = fs.readFileSync(paths.config, 'utf8'); } catch { text = null; }
  try {
    config = text ? JSON.parse(text) || {} : {};
  } catch (e) {
    // arquivo corrompido (ex.: desligamento no meio da gravação): guarda uma cópia em vez de perder em silêncio
    try { fs.copyFileSync(paths.config, paths.config + '.bad'); } catch { /* ignora */ }
    console.error('config.json inválido; usando padrões', e);
    config = {};
  }
  if (config.extraBackupDir) extraStatus = { state: 'pending', error: '', at: null };
}
async function saveConfig() {
  try { await atomicWrite(paths.config, JSON.stringify(config, null, 2)); } catch (e) { console.error('config', e); }
}
function queue(fn) {
  const job = writeChain.then(fn);
  writeChain = job.catch(() => {});
  return job;
}

/* ---------------- Diálogos (com atalho para testes em desenvolvimento) ---------------- */
async function askSavePath(opts) {
  if (E2E_DIR) return path.join(E2E_DIR, path.basename(opts.defaultPath));
  const r = await dialog.showSaveDialog(win, opts);
  return r.canceled || !r.filePath ? null : r.filePath;
}
async function askOpenPath(opts) {
  if (E2E_DIR) {
    const dir = opts.defaultPath === paths.snapshots ? paths.snapshots : E2E_DIR;
    const files = (await fsp.readdir(dir).catch(() => [])).filter(n => n.endsWith('.json')).sort().reverse();
    return files.length ? path.join(dir, files[0]) : null;
  }
  const r = await dialog.showOpenDialog(win, opts);
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
}
async function askFolder(opts) {
  if (E2E_DIR) {
    const dir = path.join(E2E_DIR, 'pasta-extra');
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }
  const r = await dialog.showOpenDialog(win, opts);
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
}

/* ---------------- Minecraft: skin pelo nick ---------------- */
// Pergunta aos servidores oficiais da Mojang qual é a skin de um nick (como o NameMC mostra).
// Só o nick sai deste computador: sem cookies, sem credenciais, sem nada do cofre. Nada disto vai para o log.
// A janela nunca fala com a rede; ela recebe a textura pronta como data:image/png;base64.
const MC_NICK_RE = /^[A-Za-z0-9_]{3,16}$/;
const MC_TIMEOUT_MS = 8000;
const MC_MAX_JSON = 64 * 1024;
const MC_MAX_SKIN = 1024 * 1024;
const MC_MAX_DATA_URL = 350000; // mesmo limite que a janela aceita para o avatar
const MC_PROFILE_URLS = [
  'https://api.minecraftservices.com/minecraft/profile/lookup/name/',
  'https://api.mojang.com/users/profiles/minecraft/'
];
const MC_SESSION_URL = 'https://sessionserver.mojang.com/session/minecraft/profile/';
const MC_SKIN_HOST = 'textures.minecraft.net';
// Capa do OptiFine: o servidor deles só responde em http (sem TLS). Só o nick (público) vai nessa consulta,
// e a resposta só é aceita se for um PNG pequeno com as proporções de uma capa.
const OF_CAPE_URL = 'http://s.optifine.net/capes/';
const MC_MAX_CAPE = 256 * 1024;
const MC_MSG = {
  invalid_name: 'Nick inválido: use 3 a 16 letras, números ou _.',
  not_found: 'Nenhuma conta do Minecraft com esse nick.',
  network: 'Não foi possível falar com a Mojang agora. Verifique a internet.',
  rate_limited: 'A Mojang pediu uma pausa nas consultas. Tente de novo em alguns minutos.',
  bad_skin: 'A skin dessa conta veio num formato que o app não aceita.',
  default_skin: 'Essa conta usa a skin padrão.'
};
const mcInFlight = new Map(); // evita consultas repetidas enquanto a mesma ainda está em andamento

class McError extends Error {
  constructor(code, message) { super(message || MC_MSG[code]); this.code = code; }
}
const mcFail = (code, message) => { throw new McError(code, message); };

function mcGet(url) {
  // Pilha de rede do Chromium (respeita o proxy do sistema), sem cookies e sem seguir redirecionamentos.
  return net.fetch(url, {
    method: 'GET',
    headers: { Accept: url.startsWith('https://' + MC_SKIN_HOST) ? 'image/png' : 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(MC_TIMEOUT_MS)
  });
}
function mcDiscard(res) {
  try { if (res.body) res.body.cancel().catch(() => {}); } catch { /* ignora */ }
}
async function mcReadCapped(res, max, code) {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) { mcDiscard(res); mcFail(code); }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { reader.cancel().catch(() => {}); mcFail(code); }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}
async function mcJson(res, code) {
  const buf = await mcReadCapped(res, MC_MAX_JSON, code);
  try { return JSON.parse(buf.toString('utf8')); } catch { return mcFail(code); }
}
function mcCheckStatus(res) {
  if (res.status === 204 || res.status === 404) { mcDiscard(res); mcFail('not_found'); }
  if (res.status === 429) { mcDiscard(res); mcFail('network', MC_MSG.rate_limited); }
  if (!res.ok) { mcDiscard(res); mcFail('network'); }
}
async function mcProfileByName(nick) {
  let lastErr = new McError('network');
  for (const base of MC_PROFILE_URLS) {
    try {
      const res = await mcGet(base + encodeURIComponent(nick));
      mcCheckStatus(res);
      const j = await mcJson(res, 'network');
      const uuid = String((j && j.id) || '').replace(/-/g, '').toLowerCase();
      const name = String((j && j.name) || '');
      if (!/^[0-9a-f]{32}$/.test(uuid) || !/^[A-Za-z0-9_]{1,16}$/.test(name)) mcFail('network');
      return { uuid, name };
    } catch (e) {
      if (e instanceof McError && e.code === 'not_found') throw e; // resposta definitiva: não tenta o outro endereço
      lastErr = e;
    }
  }
  throw lastErr;
}
// Só aceita o servidor de texturas oficial; http vira https.
function mcTextureUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.hostname !== MC_SKIN_HOST || u.port || u.username || u.password || !/^\/texture\/[0-9a-f]+$/i.test(u.pathname)) return null;
  u.protocol = 'https:';
  u.search = '';
  u.hash = '';
  return u.href;
}
async function mcSkinInfo(uuid) {
  const res = await mcGet(MC_SESSION_URL + uuid);
  mcCheckStatus(res);
  const j = await mcJson(res, 'network');
  const name = String((j && j.name) || '');
  const prop = j && Array.isArray(j.properties) ? j.properties.find(p => p && p.name === 'textures') : null;
  if (!prop || typeof prop.value !== 'string') mcFail('bad_skin', MC_MSG.default_skin);
  let tex;
  try { tex = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8')); } catch { mcFail('bad_skin'); }
  const skin = tex && tex.textures && tex.textures.SKIN;
  if (!skin || typeof skin.url !== 'string' || !skin.url) mcFail('bad_skin', MC_MSG.default_skin);
  const url = mcTextureUrl(skin.url);
  if (!url) mcFail('bad_skin');
  const cape = tex.textures.CAPE;
  const capeUrl = cape && typeof cape.url === 'string' ? mcTextureUrl(cape.url) : null;
  return {
    url, capeUrl,
    name: /^[A-Za-z0-9_]{1,16}$/.test(name) ? name : '',
    model: skin.metadata && skin.metadata.model === 'slim' ? 'slim' : 'classic'
  };
}
function pngSize(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) return null;
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function mcCheckPng(buf) {
  const s = pngSize(buf);
  return !!s && s.w === 64 && (s.h === 64 || s.h === 32);
}
// Capas: Mojang usa 64x32; OptiFine usa 46x22 (ou múltiplos em HD, ex.: 92x44). Aceita até 8x.
function capeCheckPng(buf) {
  const s = pngSize(buf);
  if (!s) return false;
  for (const [bw, bh] of [[64, 32], [46, 22]]) {
    const k = s.w / bw;
    if (Number.isInteger(k) && k >= 1 && k <= 8 && s.h === bh * k) return true;
  }
  return false;
}
async function mcDownloadCape(url) {
  try {
    const res = await mcGet(url);
    if (!res.ok) { mcDiscard(res); return null; }
    const buf = await mcReadCapped(res, MC_MAX_CAPE, 'bad_skin');
    if (!capeCheckPng(buf)) return null;
    const src = 'data:image/png;base64,' + buf.toString('base64');
    return src.length <= MC_MAX_DATA_URL ? src : null;
  } catch {
    return null; // capa é opcional: qualquer falha só significa "sem capa"
  }
}
async function mcDownloadSkin(url) {
  const res = await mcGet(url);
  if (res.status === 404) { mcDiscard(res); mcFail('bad_skin'); }
  mcCheckStatus(res);
  const buf = await mcReadCapped(res, MC_MAX_SKIN, 'bad_skin');
  if (!mcCheckPng(buf)) mcFail('bad_skin');
  const src = 'data:image/png;base64,' + buf.toString('base64');
  if (src.length > MC_MAX_DATA_URL) mcFail('bad_skin');
  return src;
}
// Busca completa: skin + capa oficial (Mojang) + capa do OptiFine (se pedida).
async function mcLookup(nick, uuid, opts) {
  try {
    const profile = uuid ? { uuid, name: '' } : await mcProfileByName(nick);
    const info = await mcSkinInfo(profile.uuid);
    const name = info.name || profile.name || nick || '';
    const [src, mojangCape, optifineCape] = await Promise.all([
      mcDownloadSkin(info.url),
      info.capeUrl ? mcDownloadCape(info.capeUrl) : Promise.resolve(null),
      opts.optifine && MC_NICK_RE.test(name) ? mcDownloadCape(OF_CAPE_URL + encodeURIComponent(name) + '.png') : Promise.resolve(null)
    ]);
    return { ok: true, name, uuid: profile.uuid, model: info.model, src, capes: { mojang: mojangCape, optifine: optifineCape } };
  } catch (e) {
    // Falhas esperadas nunca atravessam o IPC como exceção; tempo esgotado e erro de rede viram 'network'.
    if (e instanceof McError) return { ok: false, error: e.code, message: e.message };
    return { ok: false, error: 'network', message: MC_MSG.network };
  }
}
function mcOpts(o) { return { optifine: !(o && o.optifine === false) }; }
function fetchMinecraftSkin(nick, o) {
  const name = typeof nick === 'string' && nick.length <= 64 ? nick.trim() : '';
  if (!MC_NICK_RE.test(name)) return Promise.resolve({ ok: false, error: 'invalid_name', message: MC_MSG.invalid_name });
  const opts = mcOpts(o);
  const key = 'n:' + name.toLowerCase() + ':' + opts.optifine;
  if (mcInFlight.has(key)) return mcInFlight.get(key);
  const job = mcLookup(name, null, opts).finally(() => mcInFlight.delete(key));
  mcInFlight.set(key, job);
  return job;
}
// Atualização automática: pelo UUID (que nunca muda), então um nick trocado no jogo é atualizado aqui também.
function refreshMinecraftProfile(uuid, o) {
  const id = typeof uuid === 'string' ? uuid.replace(/-/g, '').toLowerCase() : '';
  if (!/^[0-9a-f]{32}$/.test(id)) return Promise.resolve({ ok: false, error: 'invalid_name', message: MC_MSG.invalid_name });
  const opts = mcOpts(o);
  const key = 'u:' + id + ':' + opts.optifine;
  if (mcInFlight.has(key)) return mcInFlight.get(key);
  const job = mcLookup('', id, opts).finally(() => mcInFlight.delete(key));
  mcInFlight.set(key, job);
  return job;
}

/* ---------------- Atualização automática (GitHub Releases) ---------------- */
// Só no app instalado: confere ao abrir e a cada 6 h, baixa em segundo plano (o electron-updater confere o
// SHA-512 do latest.yml) e instala ao reiniciar — ou sozinho quando o app fecha. A versão portátil não se atualiza.
let updater = null;
let updateState = { state: 'idle', version: null, error: '' };
function sendUpdateEvent() {
  if (win && !win.isDestroyed()) win.webContents.send('app:event', 'update:' + updateState.state);
}
function initAutoUpdate() {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (e) {
    console.error('updater', e);
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.on('checking-for-update', () => { updateState = Object.assign({}, updateState, { state: 'checking' }); });
  updater.on('update-available', info => { updateState = { state: 'downloading', version: info.version, error: '' }; sendUpdateEvent(); });
  updater.on('update-not-available', () => { updateState = { state: 'latest', version: null, error: '' }; });
  updater.on('update-downloaded', info => { updateState = { state: 'ready', version: info.version, error: '' }; sendUpdateEvent(); });
  updater.on('error', e => { updateState = { state: 'error', version: updateState.version, error: String((e && e.message) || e).slice(0, 200) }; });
  setTimeout(() => updater.checkForUpdates().catch(() => {}), 8000);
  setInterval(() => updater.checkForUpdates().catch(() => {}), 6 * 3600e3);
}

/* ---------------- IPC ---------------- */
function validSender(e) {
  try {
    const u = new URL(e.senderFrame.url);
    return u.protocol === 'file:' && decodeURIComponent(u.pathname).replace(/\\/g, '/').endsWith('/src/index.html');
  } catch {
    return false;
  }
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!validSender(e)) throw new Error('Origem não permitida');
    return fn(...args);
  });
}
function registerIpc() {
  handle('vault:read', async () => {
    try {
      const st = await fsp.stat(paths.vault);
      if (st.size > MAX_BYTES) throw new Error('arquivo do cofre grande demais');
      return { text: await fsp.readFile(paths.vault, 'utf8') };
    } catch (e) {
      if (e.code === 'ENOENT') return { text: null };
      throw e;
    }
  });
  handle('vault:write', text => queue(async () => {
    if (!isEnvelopeText(text)) throw new Error('Conteúdo inválido para o cofre');
    if (Date.now() - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) await snapshot('cofre').catch(e => console.error('snapshot', e));
    await atomicWrite(paths.vault, text);
    const extra = await writeExtra(text);
    return { ok: true, extra };
  }));
  handle('vault:remove', () => queue(async () => {
    await snapshot('cofre-apagado').catch(e => console.error('snapshot', e));
    await fsp.rm(paths.vault, { force: true });
    return { ok: true };
  }));
  handle('backup:save', async (text, name) => {
    if (!isEnvelopeText(text)) throw new Error('Conteúdo inválido para backup');
    const file = await askSavePath({
      title: 'Salvar backup do Harmful',
      defaultPath: path.join(app.getPath('documents'), safeFileName(name, 'harmful-backup.json')),
      filters: [{ name: 'Backup do Harmful', extensions: ['json'] }]
    });
    if (!file) return { canceled: true };
    await atomicWrite(file, text);
    return { ok: true, path: file };
  });
  handle('csv:save', async (text, name) => {
    if (typeof text !== 'string' || text.length > MAX_BYTES) throw new Error('Conteúdo inválido');
    const file = await askSavePath({
      title: 'Exportar planilha (sem criptografia)',
      defaultPath: path.join(app.getPath('documents'), safeFileName(name, 'harmful-contas.csv')),
      filters: [{ name: 'Planilha CSV', extensions: ['csv'] }]
    });
    if (!file) return { canceled: true };
    await atomicWrite(file, text);
    return { ok: true, path: file };
  });
  handle('backup:open', async opts => {
    const fromSnapshots = !!(opts && opts.snapshots);
    if (fromSnapshots) await fsp.mkdir(paths.snapshots, { recursive: true }).catch(() => {});
    const file = await askOpenPath({
      title: fromSnapshots ? 'Escolha uma cópia automática' : 'Escolha o arquivo de backup',
      defaultPath: fromSnapshots ? paths.snapshots : app.getPath('documents'),
      properties: ['openFile'],
      filters: [{ name: 'Backup do Harmful', extensions: ['json'] }, { name: 'Todos os arquivos', extensions: ['*'] }]
    });
    if (!file) return { canceled: true };
    const st = await fsp.stat(file);
    if (st.size > MAX_BYTES) throw new Error('arquivo grande demais para ser um backup');
    return { name: path.basename(file), text: await fsp.readFile(file, 'utf8') };
  });
  handle('clipboard:write', (text, secret) => {
    clipboard.writeText(String(text));
    lastSecretHash = secret ? sha256(text) : null;
    return true;
  });
  handle('clipboard:clear', () => {
    if (lastSecretHash && sha256(clipboard.readText()) === lastSecretHash) clipboard.clear();
    lastSecretHash = null;
    return true;
  });
  handle('app:info', async () => ({
    version: app.getVersion(),
    dataDir: paths.data,
    snapshotsDir: paths.snapshots,
    snapshotCount: (await listSnapshots()).length,
    snapshotKeep: SNAPSHOT_KEEP,
    extraDir: config.extraBackupDir || null,
    extra: extraStatus
  }));
  handle('update:status', async () => Object.assign({ current: app.getVersion(), enabled: !!updater }, updateState));
  handle('update:check', async () => {
    if (!updater) return Object.assign({ current: app.getVersion(), enabled: false }, updateState);
    try { await updater.checkForUpdates(); } catch (e) { updateState = { state: 'error', version: null, error: String((e && e.message) || e).slice(0, 200) }; }
    return Object.assign({ current: app.getVersion(), enabled: true }, updateState);
  });
  handle('update:install', async () => {
    if (!updater || updateState.state !== 'ready') return false;
    setImmediate(() => updater.quitAndInstall(true, true)); // instala em silêncio e abre de novo
    return true;
  });
  handle('folder:open', async which => {
    const dir = which === 'snapshots' ? paths.snapshots : which === 'extra' ? config.extraBackupDir : paths.data;
    if (!dir) return false;
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    const err = await shell.openPath(dir);
    return !err;
  });
  handle('extra:choose', async () => {
    const dir = await askFolder({ title: 'Escolha a pasta para a cópia extra do cofre', properties: ['openDirectory', 'createDirectory'] });
    if (!dir) return { canceled: true, extra: extraStatus, extraDir: config.extraBackupDir || null };
    if (path.resolve(dir) === path.resolve(paths.data)) throw new Error('Escolha uma pasta diferente da pasta do próprio app.');
    config.extraBackupDir = dir;
    await saveConfig();
    const text = await fsp.readFile(paths.vault, 'utf8').catch(() => null);
    if (text) await queue(() => writeExtra(text));
    else extraStatus = { state: 'pending', error: '', at: null };
    return { extra: extraStatus, extraDir: dir };
  });
  handle('window:titlebar', async opts => {
    const hex = v => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
    const color = hex(opts && opts.color), symbolColor = hex(opts && opts.symbolColor);
    const height = Math.round(Math.min(64, Math.max(32, Number(opts && opts.height) || 52)));
    if (!color || !symbolColor || !win || win.isDestroyed()) return false;
    const tb = { color, symbolColor, height };
    const prev = config.titleBar || {};
    if (prev.color === tb.color && prev.symbolColor === tb.symbolColor && prev.height === tb.height) return true;
    try { win.setTitleBarOverlay(tb); } catch { return false; }
    win.setBackgroundColor(color);
    config.titleBar = tb;
    saveConfig();
    return true;
  });
  handle('extra:clear', async () => {
    delete config.extraBackupDir;
    await saveConfig();
    extraStatus = { state: 'off', error: '', at: null };
    return { extra: extraStatus, extraDir: null };
  });
  handle('mc:skin', (nick, opts) => fetchMinecraftSkin(nick, opts));
  handle('mc:refresh', (uuid, opts) => refreshMinecraftProfile(uuid, opts));
}

/* ---------------- Janela ---------------- */
function restoreBounds() {
  const b = config.bounds;
  if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return {};
  const visible = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 20 && b.y < a.y + a.height - 80;
  });
  return visible ? { x: b.x, y: b.y, width: Math.max(380, b.width), height: Math.max(560, b.height) } : { width: b.width, height: b.height };
}
function createWindow() {
  win = new BrowserWindow(Object.assign({
    width: 1280,
    height: 840,
    minWidth: 380,
    minHeight: 560,
    title: APP_NAME,
    backgroundColor: config.titleBar && config.titleBar.color ? config.titleBar.color : '#0a0c11',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: Object.assign({ color: '#0a0c11', symbolColor: '#aeb4c8', height: 52 }, config.titleBar || {}),
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: !E2E_HIDDEN,
      devTools: !app.isPackaged
    }
  }, restoreBounds()));
  if (config.maximized && !E2E_HIDDEN) win.maximize();
  win.once('ready-to-show', () => { if (!E2E_HIDDEN) win.show(); });
  win.on('minimize', () => { if (!win.isDestroyed()) win.webContents.send('app:event', 'minimized'); });
  win.on('close', () => {
    config.bounds = win.getNormalBounds();
    config.maximized = win.isMaximized();
    // gravação atômica e síncrona (a janela está fechando): tmp + fsync + rename
    try {
      const tmp = paths.config + '.close.tmp';
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeSync(fd, JSON.stringify(config, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, paths.config);
    } catch { /* ignora */ }
  });
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, 'index.html'));
}
function buildMenu() {
  const dev = !app.isPackaged;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Editar', submenu: [
      { role: 'undo', label: 'Desfazer' }, { role: 'redo', label: 'Refazer' }, { type: 'separator' },
      { role: 'cut', label: 'Recortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Colar' },
      { role: 'selectAll', label: 'Selecionar tudo' }
    ] },
    { label: 'Exibir', submenu: [
      { role: 'resetZoom', label: 'Tamanho original' }, { role: 'zoomIn', label: 'Aumentar zoom' }, { role: 'zoomOut', label: 'Diminuir zoom' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Tela cheia' }
    ].concat(dev ? [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] : []) },
    { label: 'Ajuda', submenu: [
      { label: 'Abrir pasta dos dados', click: () => shell.openPath(paths.data) },
      { type: 'separator' },
      { label: 'Sobre o Harmful', click: () => dialog.showMessageBox(win, {
        type: 'info', title: 'Sobre', message: `${APP_NAME} ${app.getVersion()}`,
        detail: 'Organizador de contas de jogos.\nSeus dados ficam criptografados (AES-256) neste computador e nunca são enviados para a internet.'
      }) }
    ] }
  ]));
}

/* ---------------- Ciclo de vida ---------------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', e => e.preventDefault());
    contents.on('will-navigate', (e, url) => {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  });
  app.whenReady().then(async () => {
    app.setAppUserModelId('br.harmful.app');
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    loadConfig();
    await initSnapshotClock();
    registerIpc();
    buildMenu();
    createWindow();
    const lockAll = () => { if (win && !win.isDestroyed()) win.webContents.send('app:event', 'system-lock'); };
    powerMonitor.on('lock-screen', lockAll);
    powerMonitor.on('suspend', lockAll);
    initAutoUpdate();
  });
  app.on('before-quit', () => {
    try { if (lastSecretHash && sha256(clipboard.readText()) === lastSecretHash) clipboard.clear(); } catch { /* ignora */ }
  });
  app.on('window-all-closed', () => app.quit());
}
