'use strict';
// Processo principal do Harmful (Electron).
// Guarda o cofre criptografado em %APPDATA%\Harmful\cofre.json, mantém cópias automáticas
// e oferece diálogos nativos para backup/importação. A criptografia acontece na janela (renderer):
// este processo só recebe e grava o texto já criptografado.
// Exceções à regra "nada vai para a internet": a skin do Minecraft e o perfil público da Steam, buscados
// aqui (não na janela), e o Valorant pelo Riot Client (só quando a pessoa clica). Veja "Minecraft", "Steam" e "Valorant" abaixo.
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
// Cópias automáticas: "cofre-<data>.json" no máximo a cada 30 min (ficam as SNAPSHOT_KEEP mais novas) e as
// especiais, "cofre-apagado-…" e "cofre-antes-…", tiradas antes de trocar o cofre inteiro: fora da contagem, por 90 dias.
const SNAPSHOT_SPECIAL_MS = 90 * 864e5;
const SNAPSHOT_FORCED = ['antes-restaurar', 'antes-importar', 'antes-senha']; // as que a janela pode pedir
const SNAPSHOT_RE = /^cofre-(?:(.+)-)?(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.json$/i;
// Data pelo nome, não pelo mtime: no Windows o copyFile mantém o mtime do cofre de origem.
function snapshotInfo(name) {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) return null;
  return { special: !!m[1], at: new Date(+m[2], m[3] - 1, +m[4], +m[5], +m[6], +m[7]).getTime() };
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
  const info = n => snapshotInfo(n) || { special: null }; // sem data no nome: não foi o app que gravou, fica
  const old = Date.now() - SNAPSHOT_SPECIAL_MS;
  const drop = names.filter(n => info(n).special === false).slice(SNAPSHOT_KEEP)
    .concat(names.filter(n => info(n).special && info(n).at < old));
  for (const n of drop) await fsp.rm(path.join(paths.snapshots, n), { force: true }).catch(() => {});
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
  const last = names.length ? snapshotInfo(names[0]) : null;
  if (last) lastSnapshotAt = Math.min(last.at, Date.now());
}
// Sal do KDF de um envelope: identifica o cofre (só muda quando a senha mestra muda)
function envelopeSalt(text) {
  if (!isEnvelopeText(text)) return null;
  const s = JSON.parse(text).kdf.salt;
  return typeof s === 'string' && s ? s : null;
}
function extraFileName() {
  const f = config.extraFile;
  return typeof f === 'string' && /^harmful-backup-[a-z0-9-]{1,40}\.json$/i.test(f) ? f : EXTRA_FILE;
}
// No Windows "D:\Backup" e "d:\backup" são a mesma pasta
function samePath(a, b) {
  const n = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return n(a) === n(b);
}
// De quem é o arquivo que já está na pasta extra: null (não existe), 'own', 'unknown' (não é um cofre)
// ou 'other' (cofre de outro PC ou de outra instalação: nunca é sobrescrito sem perguntar).
async function extraOwner(file, own) {
  let text;
  try {
    if ((await fsp.stat(file)).size > MAX_BYTES) return 'unknown';
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const salt = envelopeSalt(text);
  return !salt ? 'unknown' : own.includes(salt) ? 'own' : 'other';
}
// "Manter os dois": o primeiro harmful-backup-N.json livre (ou que já seja deste cofre)
async function freeExtraName(dir, own) {
  for (let i = 2; i < 100; i++) {
    const name = 'harmful-backup-' + i + '.json';
    const who = await extraOwner(path.join(dir, name), own).catch(() => 'other');
    if (who === null || who === 'own') return name;
  }
  return 'harmful-backup-' + crypto.randomBytes(4).toString('hex') + '.json';
}
// Somente em desenvolvimento: resposta automática ao aviso abaixo (substituir | manter | cancelar).
const E2E_ANSWER = !app.isPackaged ? String(process.env.COFRE_GAMER_E2E_ANSWER || '') : '';
async function askOtherVault(file, alt) {
  const answers = ['substituir', 'manter', 'cancelar'];
  if (E2E_DIR || E2E_ANSWER) return answers.includes(E2E_ANSWER) ? E2E_ANSWER : 'cancelar';
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Cópia extra',
    message: 'Esta pasta já tem a cópia de outro cofre',
    detail: 'O arquivo ' + file + ' é de outro cofre (de outro PC ou de uma instalação anterior). Substituir apaga essa cópia.\n\nManter os dois grava a deste cofre como ' + alt + '.',
    buttons: ['Substituir', 'Manter os dois', 'Cancelar'],
    defaultId: 1,
    cancelId: 2,
    noLink: true
  });
  return answers[r.response] || 'cancelar';
}
// opts.force: o usuário mandou substituir a cópia de outro cofre; opts.prevSalt: sal do cofre antes desta gravação
async function writeExtra(text, opts) {
  opts = opts || {};
  const dir = config.extraBackupDir;
  if (!dir) {
    extraStatus = { state: 'off', error: '', at: null };
    return extraStatus;
  }
  try {
    const file = path.join(dir, extraFileName());
    const salt = envelopeSalt(text);
    // outro PC ou outra instalação apontando para a mesma pasta (OneDrive etc.): para aqui em vez de apagar a cópia dele
    if (!opts.force && await extraOwner(file, [salt, config.extraSalt, opts.prevSalt]) === 'other') {
      extraStatus = { state: 'error', code: 'other-vault', error: 'Outro cofre está usando esta pasta', at: extraStatus.at };
      return extraStatus;
    }
    await atomicWrite(file, text);
    extraStatus = { state: 'ok', error: '', at: new Date().toISOString() };
    // o sal muda com a senha mestra: guarda o último gravado para reconhecer a própria cópia na próxima vez
    if (salt && salt !== config.extraSalt) { config.extraSalt = salt; await saveConfig(); }
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
// Somente em desenvolvimento: os testes automáticos trocam os servidores por um servidor local (http://127.0.0.1:porta).
const MC_MOCK = !app.isPackaged && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(process.env.COFRE_GAMER_MC_MOCK || '') ? process.env.COFRE_GAMER_MC_MOCK : null;
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
  return net.fetch(MC_MOCK ? MC_MOCK + '/' + url.replace(/^https?:\/\//, '') : url, {
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
  // Sem textura de skin = skin padrão do jogo. O nick vai junto: a atualização automática corrige o nick e
  // registra a consulta (sem isso perguntaria de novo a cada abertura).
  const noSkin = () => {
    const e = new McError('bad_skin', MC_MSG.default_skin);
    e.defaultSkin = true;
    e.nick = /^[A-Za-z0-9_]{1,16}$/.test(name) ? name : '';
    throw e;
  };
  if (!prop || typeof prop.value !== 'string') noSkin();
  let tex;
  try { tex = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8')); } catch { mcFail('bad_skin'); }
  const skin = tex && tex.textures && tex.textures.SKIN;
  if (!skin || typeof skin.url !== 'string' || !skin.url) noSkin();
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
// Devolve a capa (data URL) ou null quando o servidor responde que não há capa (404, ou imagem que não é capa).
// Lança quando não deu para saber (tempo esgotado, sem rede, 5xx, resposta que nem é PNG): quem chama mantém a
// capa que já tinha, em vez de apagar a capa e a escolha da pessoa por causa de uma falha passageira.
async function mcDownloadCape(url) {
  const res = await mcGet(url);
  if (res.status === 404) { mcDiscard(res); return null; }
  if (!res.ok) { mcDiscard(res); mcFail('network'); }
  let buf;
  try { buf = await mcReadCapped(res, MC_MAX_CAPE, 'bad_skin'); } catch (e) {
    // imagem grande demais não é capa; página grande (proxy/Wi-Fi) ou conexão caída no meio = não deu para saber
    if (e instanceof McError && /^image\//i.test(res.headers.get('content-type') || '')) return null;
    throw e;
  }
  if (!pngSize(buf)) mcFail('network'); // página de proxy/Wi-Fi no lugar da imagem
  if (!capeCheckPng(buf)) return null;
  const src = 'data:image/png;base64,' + buf.toString('base64');
  return src.length <= MC_MAX_DATA_URL ? src : null;
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
    // capeErrors[lado] = true: não deu para saber se tem capa (a janela mantém a que já estava guardada)
    const cape = url => url ? mcDownloadCape(url).then(c => ({ src: c, error: false }), () => ({ src: null, error: true })) : { src: null, error: false };
    const [src, mojang, optifine] = await Promise.all([
      mcDownloadSkin(info.url),
      cape(info.capeUrl),
      cape(opts.optifine && MC_NICK_RE.test(name) ? OF_CAPE_URL + encodeURIComponent(name) + '.png' : null)
    ]);
    return {
      ok: true, name, uuid: profile.uuid, model: info.model, src,
      capes: { mojang: mojang.src, optifine: optifine.src }, capeErrors: { mojang: mojang.error, optifine: optifine.error }
    };
  } catch (e) {
    // Falhas esperadas nunca atravessam o IPC como exceção; tempo esgotado e erro de rede viram 'network'.
    if (e instanceof McError && e.defaultSkin) return { ok: false, error: e.code, message: e.message, defaultSkin: true, name: e.nick };
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

/* ---------------- Steam: perfil público ---------------- */
// Foto, nome e situação (VAC, trade ban, conta limitada) do perfil público, pelo XML que o próprio
// steamcommunity.com oferece (sem chave de API). Só o link/SteamID do perfil sai deste computador.
const STEAM_BASE = 'https://steamcommunity.com/';
const STEAM_ID64_BASE = 76561197960265728n;
const STEAM_VANITY_RE = /^[A-Za-z0-9_-]{2,32}$/;
const STEAM_AVATAR_HOST_RE = /^avatars(\.(akamai|fastly|cloudflare))?\.steamstatic\.com$/;
const STEAM_MAX_XML = 64 * 1024;
const STEAM_MAX_AVATAR = 256 * 1024;
const STEAM_MSG = {
  invalid: 'Cole o link do perfil da Steam (steamcommunity.com/id/… ou /profiles/…) ou o SteamID64.',
  not_found: 'Nenhum perfil da Steam encontrado nesse link.',
  network: 'Não foi possível falar com a Steam agora. Verifique a internet.',
  rate_limited: 'A Steam pediu uma pausa nas consultas. Tente de novo em alguns minutos.',
  bad: 'O perfil da Steam veio num formato que o app não aceita.'
};
const steamInFlight = new Map();

// SteamID64 de conta individual: base + accountId de 32 bits (vai além de 7656119…, contas novas já chegam perto)
function steamId64Ok(s) {
  if (typeof s !== 'string' || !/^\d{17}$/.test(s)) return false;
  const n = BigInt(s) - STEAM_ID64_BASE;
  return n >= 1n && n < 4294967296n;
}
function steamFromAccountId(n) {
  return n >= 1n && n < 4294967296n ? { kind: 'profiles', id: String(STEAM_ID64_BASE + n) } : null;
}
// Aceita: link /id/<nome> ou /profiles/<id64> (com ou sem subpágina), SteamID64, STEAM_0:X:Y e [U:1:N].
function steamRef(input) {
  const s = typeof input === 'string' && input.length <= 300 ? input.trim() : '';
  if (!s) return null;
  if (steamId64Ok(s)) return { kind: 'profiles', id: s };
  let m = /^STEAM_[0-5]:([01]):(\d{1,10})$/i.exec(s);
  if (m) return steamFromAccountId(BigInt(m[2]) * 2n + BigInt(m[1]));
  m = /^\[U:1:(\d{1,10})\]$/i.exec(s);
  if (m) return steamFromAccountId(BigInt(m[1]));
  m = /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/(profiles|id)\/([^/?#\s]+)(?:[/?#]\S*)?$/i.exec(s);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  let id;
  try { id = decodeURIComponent(m[2]); } catch { return null; }
  if (kind === 'profiles' ? !steamId64Ok(id) : !STEAM_VANITY_RE.test(id)) return null;
  return { kind, id };
}
function steamGet(url, accept) {
  return net.fetch(url, {
    method: 'GET',
    headers: { Accept: accept },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(MC_TIMEOUT_MS)
  });
}
function steamCheckStatus(res) {
  if (res.status === 404) { mcDiscard(res); mcFail('not_found'); }
  if (res.status === 429 || res.status === 503) { mcDiscard(res); mcFail('rate_limited'); }
  if (!res.ok) { mcDiscard(res); mcFail('network'); }
}
// Os campos usados ficam nos primeiros ~2 KB; o resto (resumo, grupos, jogos) é ignorado, sem falhar se for grande.
async function steamReadHead(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      total += value.byteLength;
      if (total >= STEAM_MAX_XML || Buffer.concat(chunks, total).includes('</isLimitedAccount>')) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total).subarray(0, STEAM_MAX_XML).toString('utf8');
}
// Leitor de tags que ignora o conteúdo de CDATA: o nome do perfil pode conter texto parecido com uma tag
// (ex.: "<vacBanned>0</vacBanned>") e não pode falsificar os outros campos.
function xmlReader(xml) {
  const masked = xml.replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, m => ' '.repeat(m.length));
  const read = t => {
    const m = new RegExp('<' + t + '>[^<]*</' + t + '>').exec(masked);
    if (!m) return null;
    const raw = xml.slice(m.index + t.length + 2, m.index + m[0].length - t.length - 3);
    const c = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
    return (c ? c[1] : raw).trim();
  };
  read.root = masked.replace(/^\s*(?:<\?xml[^>]*\?>\s*)?/, '');
  return read;
}
// Só aceita o servidor de avatares da Steam; http vira https.
function steamAvatarUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !STEAM_AVATAR_HOST_RE.test(u.hostname) || u.port || u.username || u.password || !/^\/[A-Za-z0-9/_-]+\.(jpe?g|png)$/i.test(u.pathname)) return null;
  u.protocol = 'https:';
  u.search = '';
  u.hash = '';
  return u.href;
}
async function steamDownloadAvatar(url) {
  const res = await steamGet(url, 'image/jpeg,image/png');
  steamCheckStatus(res);
  const buf = await mcReadCapped(res, STEAM_MAX_AVATAR, 'bad');
  const type = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff ? 'jpeg' : pngSize(buf) ? 'png' : '';
  if (!type) mcFail('bad');
  const src = 'data:image/' + type + ';base64,' + buf.toString('base64');
  if (src.length > MC_MAX_DATA_URL) mcFail('bad');
  return src;
}
async function steamLookup(ref) {
  try {
    const res = await steamGet(STEAM_BASE + ref.kind + '/' + encodeURIComponent(ref.id) + '/?xml=1', 'text/xml,application/xml');
    steamCheckStatus(res);
    const tag = xmlReader(await steamReadHead(res));
    if (/^<response>\s*<error>/i.test(tag.root)) mcFail('not_found');
    if (!/^<profile>/i.test(tag.root)) mcFail('bad');
    const id64 = tag('steamID64');
    const vac = tag('vacBanned');
    if (!steamId64Ok(id64) || vac == null || !/^\d+$/.test(vac)) mcFail('bad');
    const avatarUrl = steamAvatarUrl(tag('avatarFull') || '') || steamAvatarUrl(tag('avatarMedium') || '');
    if (!avatarUrl) mcFail('bad');
    const src = await steamDownloadAvatar(avatarUrl);
    const trade = (tag('tradeBanState') || '').toLowerCase();
    return {
      ok: true, id64, src,
      name: (tag('steamID') || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64),
      vac: Number(vac) > 0,
      trade: !!trade && trade !== 'none',
      limited: tag('isLimitedAccount') === '1'
    };
  } catch (e) {
    const code = e instanceof McError && STEAM_MSG[e.code] ? e.code : 'network';
    return { ok: false, error: code, message: STEAM_MSG[code] };
  }
}
function fetchSteamProfile(input) {
  const ref = steamRef(input);
  if (!ref) return Promise.resolve({ ok: false, error: 'invalid', message: STEAM_MSG.invalid });
  const key = ref.kind + ':' + ref.id.toLowerCase();
  if (steamInFlight.has(key)) return steamInFlight.get(key);
  const job = steamLookup(ref).finally(() => steamInFlight.delete(key));
  steamInFlight.set(key, job);
  return job;
}

/* ---------------- Valorant: rank, loja e skins pelo Riot Client ---------------- */
// NÃO OFICIAL (a janela pede confirmação no primeiro uso) e só leitura, sempre por clique: lê a conta que está logada
// no Riot Client deste PC. A senha da Riot nunca passa por aqui; o token vem do próprio cliente em 127.0.0.1 e só
// existe durante a consulta. Endereços permitidos, limites e cache ficam em valorant.js (testável fora do Electron).
const VAL_DEV = !app.isPackaged; // servidores falsos para os testes: só em desenvolvimento
const valorantLib = require('./valorant');
const valorant = valorantLib.create({
  fetch: (url, opts) => net.fetch(url, Object.assign({ credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }, opts)),
  lockfile: (VAL_DEV && process.env.COFRE_GAMER_RIOT_LOCKFILE) ||
    path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), 'Riot Games', 'Riot Client', 'Config', 'lockfile'),
  pdBase: (VAL_DEV && process.env.COFRE_GAMER_RIOT_PD) || null,
  vapiBase: (VAL_DEV && process.env.COFRE_GAMER_VAPI) || null,
  mediaBase: (VAL_DEV && process.env.COFRE_GAMER_VMEDIA) || null,
  // Fora do cofre: nomes das skins (conteúdo público) e as imagens já vistas, que mostram as skins e lojas das contas;
  // por isso elas saem do disco ao desvincular uma conta (valorant:prune) e ao apagar o cofre (vault:remove).
  cacheDir: () => path.join(paths.data, 'valorant-cache'),
  // as imagens chegam com ~500 px de largura; 320 px bastam para a janela e ocupam bem menos. Só decodifica PNG com
  // largura e altura conferidas no cabeçalho (valorant.js já recusa as grandes demais; aqui, de novo, por garantia).
  shrink: buf => {
    if (!valorantLib.pngOk(buf)) throw new Error('PNG recusado');
    const img = require('electron').nativeImage.createFromBuffer(buf);
    if (img.isEmpty() || img.getSize().width <= 320) return buf;
    return img.resize({ width: 320, quality: 'good' }).toPNG();
  }
});

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
  handle('vault:write', (text, opts) => queue(async () => {
    if (!isEnvelopeText(text)) throw new Error('Conteúdo inválido para o cofre');
    const forced = opts && SNAPSHOT_FORCED.includes(opts.snapshot) ? opts.snapshot : null;
    if (forced) {
      // restaurar, importar ou trocar a senha: sem a cópia do cofre atual, não grava por cima dele
      await snapshot('cofre-' + forced).catch(e => {
        console.error('snapshot', e);
        throw new Error('a cópia de segurança do cofre atual falhou' + (e && e.code ? ' (' + e.code + ')' : ''));
      });
    } else if (Date.now() - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) await snapshot('cofre').catch(e => console.error('snapshot', e));
    // cópia extra de antes da 1.0.8 (sem o sal guardado): o cofre ainda no disco tem o sal do arquivo que o app gravou lá
    const prevSalt = config.extraBackupDir && !config.extraSalt ? envelopeSalt(await fsp.readFile(paths.vault, 'utf8').catch(() => null)) : null;
    await atomicWrite(paths.vault, text);
    const extra = await writeExtra(text, { prevSalt });
    return { ok: true, extra };
  }));
  handle('vault:remove', () => queue(async () => {
    await snapshot('cofre-apagado').catch(e => console.error('snapshot', e));
    await fsp.rm(paths.vault, { force: true });
    await valorant.prune([]).catch(e => console.error('valorant', e)); // imagens do Valorant (skins e lojas vistas) saem junto com o cofre
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
    extraFile: config.extraBackupDir ? extraFileName() : null,
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
  handle('extra:choose', async opts => {
    // "Resolver…" (outro cofre na pasta): a mesma pasta, sem abrir o seletor
    const dir = opts && opts.current && config.extraBackupDir ? config.extraBackupDir : await askFolder(Object.assign(
      { title: 'Escolha a pasta para a cópia extra do cofre', properties: ['openDirectory', 'createDirectory'] },
      config.extraBackupDir ? { defaultPath: config.extraBackupDir } : {}));
    if (!dir) return { canceled: true, extra: extraStatus, extraDir: config.extraBackupDir || null };
    if (samePath(dir, paths.data)) throw new Error('Escolha uma pasta diferente da pasta do próprio app.');
    const same = !!config.extraBackupDir && samePath(config.extraBackupDir, dir);
    let file = same ? extraFileName() : EXTRA_FILE;
    let force = false;
    const text = await fsp.readFile(paths.vault, 'utf8').catch(() => null);
    const own = [envelopeSalt(text), same ? config.extraSalt : null];
    if (text && await extraOwner(path.join(dir, file), own).catch(() => null) === 'other') {
      const alt = await freeExtraName(dir, own);
      const answer = await askOtherVault(file, alt);
      if (answer === 'cancelar') return { canceled: true, extra: extraStatus, extraDir: config.extraBackupDir || null };
      if (answer === 'manter') file = alt;
      else force = true;
    }
    if (!same || file !== extraFileName()) delete config.extraSalt;
    config.extraBackupDir = dir;
    if (file === EXTRA_FILE) delete config.extraFile;
    else config.extraFile = file;
    await saveConfig();
    if (text) await queue(async () => writeExtra(await fsp.readFile(paths.vault, 'utf8').catch(() => text), { force }));
    else extraStatus = { state: 'pending', error: '', at: null };
    return { extra: extraStatus, extraDir: dir, extraFile: file };
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
    delete config.extraFile;
    delete config.extraSalt;
    await saveConfig();
    extraStatus = { state: 'off', error: '', at: null };
    return { extra: extraStatus, extraDir: null };
  });
  // Bloqueio automático: segundos sem usar o computador (teclado/mouse em qualquer programa, até jogo em tela cheia).
  // Só nos testes (app não instalado), COFRE_GAMER_E2E_IDLE finge esse tempo.
  handle('system:idle', () => {
    const fake = app.isPackaged ? '' : process.env.COFRE_GAMER_E2E_IDLE;
    return fake ? Math.max(0, Number(fake) || 0) : powerMonitor.getSystemIdleTime();
  });
  handle('mc:skin', (nick, opts) => fetchMinecraftSkin(nick, opts));
  handle('mc:refresh', (uuid, opts) => refreshMinecraftProfile(uuid, opts));
  handle('steam:profile', ref => fetchSteamProfile(ref));
  handle('valorant:snapshot', () => valorant.snapshot());
  handle('valorant:images', (uuids, opts) => valorant.images(uuids, { net: !!(opts && opts.net) }));
  handle('valorant:prune', keep => valorant.prune(keep));
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
