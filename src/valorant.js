'use strict';
// Valorant pelo Riot Client: NÃO OFICIAL e só leitura (usado pelo main.js; a pessoa confirma no app antes do 1º uso).
// Lê a conta que está logada no Riot Client deste PC: rank, nível, carteira, loja do dia, mercado noturno e skins.
// - A senha da Riot nunca passa por aqui: o token vem do próprio Riot Client em 127.0.0.1 (porta e senha do lockfile)
//   e só existe durante a consulta (variáveis locais; nada vai para disco nem para o log).
// - Só endpoints da própria conta (store/mmr/account-xp no pd.*.a.pvp.net). Nada de partida, pré-jogo ou outros jogadores.
// - Nomes, ranks e imagens das skins vêm do valorant-api.com (site da comunidade, não da Riot), com cache em disco.
//   Os nomes são conteúdo público; já as imagens guardadas mostram as skins e as lojas que a conta viu: só vão à
//   internet quando a janela pede (conta atualizada pelo botão) e saem do disco ao desvincular ou apagar o cofre.
// Sem Electron aqui: fetch, https, fs e caminhos chegam por create() para os testes rodarem com servidores falsos.
const nodePath = require('node:path');

const LOCAL_HOST = '127.0.0.1'; // o Riot Client só é consultado neste endereço, nunca em outro
const LOCAL_TIMEOUT_MS = 5000;
const LOCAL_MAX = 256 * 1024;
const PD_TIMEOUT_MS = 10000;
const PD_MAX = 4 * 1024 * 1024;
const VAPI_TIMEOUT_MS = 20000;
const VAPI_MAX_SKINS = 24 * 1024 * 1024;
const VAPI_MAX_SMALL = 2 * 1024 * 1024;
const IMG_TIMEOUT_MS = 10000;
const IMG_MAX = 2 * 1024 * 1024;
const IMG_MAX_OUT = 700 * 1024;
const IMG_BATCH = 48;
const IMG_MAX_SIDE = 2048; // largura/altura máximas do PNG, lidas do cabeçalho ANTES de decodificar ("bomba" de pixels)
const IMG_MAX_PIXELS = 4 * 1024 * 1024;
const CONTENT_TTL_MS = 24 * 3600e3;
const VERSION_TTL_MS = 3600e3; // a versão muda a cada patch do jogo
const RETRY_AFTER_FAIL_MS = 15 * 60e3; // valorant-api.com fora do ar ou com formato novo: 15 min sem tentar de novo
const STALE_WAIT_MS = 8000; // leitura com nomes/versão vencidos: espera a renovação até aqui; depois segue com o velho
const VER_RE = /^[A-Za-z0-9._-]{3,80}$/;
const LANG = 'pt-BR';
const VAPI_BASE = 'https://valorant-api.com';
const MEDIA_HOST = 'media.valorant-api.com';
const MEDIA_BASE = 'https://' + MEDIA_HOST;
const SHARDS = ['na', 'eu', 'ap', 'kr', 'pbe'];
// região do Riot Client → shard do Valorant (Brasil e América Latina jogam no shard "na")
const REGION_SHARD = {
  na: 'na', latam: 'na', br: 'na', br1: 'na', la1: 'na', la2: 'na', lan: 'na', las: 'na', pbe: 'pbe', pbe1: 'pbe',
  eu: 'eu', euw: 'eu', euw1: 'eu', eune: 'eu', eun1: 'eu', tr: 'eu', tr1: 'eu', ru: 'eu', me: 'eu', me1: 'eu',
  ap: 'ap', oce: 'ap', oc1: 'ap', jp: 'ap', jp1: 'ap', sg: 'ap', sg2: 'ap', ph: 'ap', ph2: 'ap', th: 'ap', th2: 'ap',
  tw: 'ap', tw2: 'ap', vn: 'ap', vn2: 'ap', kr: 'kr'
};
const SKIN_LEVEL_TYPE = 'e7c63390-eda7-46e0-bb7a-a6abdacd2433';
const CUR = { vp: '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741', rad: 'e59aa87c-4cbf-517a-5983-6e81511be9b7', kc: '85ca954a-41f2-ce94-9b45-8ca3dd39a00d' };
// {"platformType":"PC","platformOS":"Windows","platformOSVersion":"10.0.19042.1.256.64bit","platformChipset":"Unknown"}
const PLATFORM = 'ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ICON_RE = /^\/(weaponskins|weaponskinlevels|weaponskinchromas)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(displayicon|fullrender)\.png$/;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MSG = {
  no_client: 'Abra o Riot Client e entre na conta.',
  not_logged: 'Entre na sua conta no Riot Client e tente de novo.',
  network: 'Não foi possível falar com a Riot agora. Verifique a internet.',
  rate_limited: 'A Riot pediu uma pausa nas consultas. Tente de novo em alguns minutos.',
  bad: 'A resposta da Riot veio num formato que o app não aceita.'
};

class ValError extends Error {
  constructor(code) { super(MSG[code] || MSG.bad); this.code = MSG[code] ? code : 'bad'; }
}
const fail = code => { throw new ValError(code); };
const arr = x => (Array.isArray(x) ? x : []);
const obj = x => (x && typeof x === 'object' && !Array.isArray(x) ? x : null);
const lc = x => (typeof x === 'string' ? x.toLowerCase() : '');
const uuidOf = x => (UUID_RE.test(lc(x)) ? lc(x) : '');
const clean = (s, max) => (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const count = x => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : null);
// "IMORTAL 1" → "Imortal 1" (o valorant-api.com manda os ranks em maiúsculas)
function sentence(s) {
  const t = String(s || '').toLocaleLowerCase('pt-BR');
  return t ? t[0].toLocaleUpperCase('pt-BR') + t.slice(1) : '';
}

/* ---------- Lockfile e API local do Riot Client ---------- */
// Formato: nome:pid:porta:senha:protocolo
function parseLockfile(text) {
  const parts = String(text || '').trim().split(':');
  if (parts.length < 5) return null;
  const protocol = parts.pop(), password = parts.pop(), port = Number(parts.pop());
  if (protocol !== 'https' || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[\x21-\x7e]{1,256}$/.test(password)) return null;
  return { port, password };
}
function shardFor(region) {
  return REGION_SHARD[lc(region).trim()] || '';
}
// Só o nome#tag da própria conta (Riot ID): nome até 16, tag até 5
function riotIdOf(name, tag) {
  const n = clean(name, 16), t = clean(tag, 5).replace(/^#/, '');
  return n && t ? n + '#' + t : '';
}

/* ---------- Leitura das respostas (funções puras, testadas à parte) ---------- */
function parseWallet(j) {
  const b = obj(j && j.Balances);
  if (!b) fail('bad');
  return { vp: count(b[CUR.vp]) || 0, rad: count(b[CUR.rad]) || 0, kc: count(b[CUR.kc]) || 0 };
}
function parseLevel(j) {
  const p = obj(j && j.Progress);
  const level = p ? count(p.Level) : null;
  if (level == null) fail('bad');
  return level;
}
function parseRank(j, content) {
  if (!obj(j)) fail('bad');
  const u = obj(j.LatestCompetitiveUpdate);
  let tier = u && u.MatchID ? count(u.TierAfterUpdate) || 0 : 0;
  let rr = u && u.MatchID ? count(u.RankedRatingAfterUpdate) : null;
  if (tier > 99) { tier = 0; rr = null; }
  const names = (content && content.tiers) || {};
  return { tier, name: names[tier] || '', rr: tier ? rr : null }; // sem a tabela de nomes: fica só o número
}
// Skins que a conta tem: a Riot lista os NÍVEIS das skins; aqui viram a skin (sem repetir), com nome em português.
function parseOwned(j, content) {
  if (!obj(j)) fail('bad');
  let list = j.Entitlements;
  if (!Array.isArray(list)) {
    const byType = arr(j.EntitlementsByTypes).find(t => t && lc(t.ItemTypeID) === SKIN_LEVEL_TYPE);
    list = byType ? byType.Entitlements : null;
  }
  if (!Array.isArray(list)) fail('bad');
  const seen = new Set(), out = [];
  for (const e of list.slice(0, 20000)) {
    const level = uuidOf(e && e.ItemID);
    const skin = level && content.levels[level];
    if (!skin || seen.has(skin) || !content.skins[skin]) continue;
    seen.add(skin);
    out.push({ uuid: skin, name: content.skins[skin][0] });
    if (out.length >= 3000) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}
function offerOf(offer, content) {
  const o = obj(offer);
  const reward = o && arr(o.Rewards)[0];
  const level = uuidOf(reward && reward.ItemID);
  if (!level) return null;
  const skin = (content && content.levels[level]) || level;
  const info = content && content.skins[skin];
  return { uuid: skin, name: info ? info[0] : '', cost: count(obj(o.Cost) && o.Cost[CUR.vp]) };
}
const endsAt = (sec, now) => (count(sec) != null ? new Date(now + count(sec) * 1000).toISOString() : '');
// Loja do dia (4 skins) e mercado noturno (só quando está aberto)
function parseStore(j, content, now) {
  const panel = obj(j && j.SkinsPanelLayout);
  if (!panel) fail('bad');
  let offers = arr(panel.SingleItemStoreOffers).map(o => offerOf(o, content)).filter(Boolean);
  if (!offers.length) offers = arr(panel.SingleItemOffers).map(id => offerOf({ Rewards: [{ ItemID: id }] }, content)).filter(Boolean);
  const store = { offers: offers.slice(0, 8), endsAt: endsAt(panel.SingleItemOffersRemainingDurationInSeconds, now) };
  const bonus = obj(j.BonusStore);
  let night = null;
  if (bonus && arr(bonus.BonusStoreOffers).length) {
    const list = arr(bonus.BonusStoreOffers).slice(0, 8).map(b => {
      const x = b && offerOf(b.Offer, content);
      if (!x) return null;
      const paid = count(obj(b.DiscountCosts) && b.DiscountCosts[CUR.vp]);
      if (paid != null) x.cost = paid;
      x.discount = Math.min(100, count(b.DiscountPercent) || 0);
      return x;
    }).filter(Boolean);
    if (list.length) night = { offers: list, endsAt: endsAt(bonus.BonusStoreRemainingDurationInSeconds, now) };
  }
  return { store, night };
}
// Endereço da imagem só no servidor de mídia do valorant-api.com (fica só o caminho; o host é fixo)
function iconPath(raw) {
  if (typeof raw !== 'string' || raw.length > 300) return '';
  let u;
  try { u = new URL(raw); } catch { return ''; }
  if (u.protocol !== 'https:' || u.hostname !== MEDIA_HOST || u.port || u.username || u.password || u.search || !ICON_RE.test(u.pathname)) return '';
  return u.pathname;
}
// Resumo das skins e ranks do valorant-api.com: { skins: {skin: [nome, ícone]}, levels: {nível: skin}, tiers: {n: nome} }
function compactContent(skinsJson, tiersJson, at) {
  const skins = {}, levels = {}, tiers = {};
  for (const s of arr(skinsJson && skinsJson.data).slice(0, 20000)) {
    const id = uuidOf(s && s.uuid);
    if (!id) continue;
    const lv = arr(s.levels), ch = arr(s.chromas);
    const icon = iconPath(s.displayIcon) || iconPath(lv[0] && lv[0].displayIcon) || iconPath(ch[0] && ch[0].displayIcon) || iconPath(ch[0] && ch[0].fullRender);
    skins[id] = [clean(s.displayName, 80), icon];
    for (const l of lv.slice(0, 50)) { const lid = uuidOf(l && l.uuid); if (lid) levels[lid] = id; }
  }
  const eps = arr(tiersJson && tiersJson.data);
  const last = eps[eps.length - 1];
  for (const t of arr(last && last.tiers)) {
    if (t && Number.isInteger(t.tier) && t.tier >= 0 && t.tier < 100 && !/^unused/i.test(t.tierName || '')) tiers[t.tier] = sentence(clean(t.tierName, 40));
  }
  if (!Object.keys(skins).length || !Object.keys(tiers).length) fail('bad');
  return { v: 1, at, lang: LANG, skins, levels, tiers };
}
// PNG conferido sem decodificar: assinatura, IHDR e largura/altura (bytes 16-23) dentro do limite. Um PNG pequeno
// que se diz 20000x20000 ocuparia GBs ao ser aberto: nunca chega ao nativeImage nem à janela.
function pngOk(buf) {
  if (!Buffer.isBuffer(buf) || buf.length <= 33 || !buf.subarray(0, 8).equals(PNG_SIG) || buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return false;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  return w > 0 && h > 0 && w <= IMG_MAX_SIDE && h <= IMG_MAX_SIDE && w * h <= IMG_MAX_PIXELS;
}

function create(deps) {
  const fetchFn = deps.fetch;
  const https = deps.https || require('node:https');
  const fsp = deps.fs || require('node:fs').promises;
  const now = deps.now || Date.now;
  const vapiBase = String(deps.vapiBase || VAPI_BASE).replace(/\/+$/, '');
  const mediaBase = String(deps.mediaBase || MEDIA_BASE).replace(/\/+$/, '');
  const pdBase = deps.pdBase ? String(deps.pdBase).replace(/\/+$/, '') : null;
  const cacheDir = () => deps.cacheDir();
  const staleWait = deps.staleWaitMs != null ? deps.staleWaitMs : STALE_WAIT_MS;
  let content = null; // resumo em memória (também em disco por 24 h)
  let contentJob = null, diskJob = null, versionJob = null, snapJob = null;
  let version = null;
  let contentFailAt = 0, versionFailAt = 0; // última renovação que falhou (pausa de RETRY_AFTER_FAIL_MS)
  const imgJobs = new Map(); // 'n' (pode ir à internet) ou 'c' (só o disco) + uuid → promessa

  /* ---- cache em disco: nomes (conteúdo público) e imagens (mostram as skins e lojas vistas; ver prune) ---- */
  async function readCache(name) {
    try { return JSON.parse(await fsp.readFile(nodePath.join(cacheDir(), name), 'utf8')); } catch { return null; }
  }
  async function writeFileAtomic(file, data) {
    const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
    try {
      await fsp.mkdir(nodePath.dirname(file), { recursive: true });
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, file);
    } catch {
      await fsp.rm(tmp, { force: true }).catch(() => {}); // cache é opcional
    }
  }

  /* ---- API local do Riot Client (https em 127.0.0.1, certificado próprio do cliente) ---- */
  async function readLock() {
    let text;
    try { text = await fsp.readFile(deps.lockfile, 'utf8'); } catch { return fail('no_client'); }
    const lock = text.length <= 4096 ? parseLockfile(text) : null;
    return lock || fail('no_client');
  }
  function localGet(lock, p) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        host: LOCAL_HOST, port: lock.port, path: p, method: 'GET', agent: false,
        rejectUnauthorized: false, // certificado autoassinado do Riot Client: só aceito porque o host é sempre 127.0.0.1
        headers: { Authorization: 'Basic ' + Buffer.from('riot:' + lock.password).toString('base64'), Accept: 'application/json' },
        timeout: LOCAL_TIMEOUT_MS
      }, res => {
        const chunks = [];
        let total = 0;
        res.on('data', c => {
          total += c.length;
          if (total > LOCAL_MAX) { res.destroy(); req.destroy(); reject(new ValError('bad')); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
          resolve({ status: res.statusCode, json });
        });
        res.on('error', () => reject(new ValError('no_client')));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => reject(new ValError('no_client'))); // cliente fechado, porta velha no lockfile etc.
      req.end();
    });
  }
  async function localJson(lock, p) {
    const r = await localGet(lock, p);
    return r.status === 200 && obj(r.json) ? r.json : null;
  }
  async function shardOf(lock) {
    const rl = await localJson(lock, '/riotclient/region-locale');
    const s = shardFor(rl && rl.region);
    if (s) return s;
    // plano B: argumentos do Valorant aberto (-ares-deployment=na)
    const ss = await localJson(lock, '/product-session/v1/external-sessions').catch(() => null);
    for (const k of Object.keys(ss || {}).slice(0, 20)) {
      const sess = obj(ss[k]);
      const args = sess && obj(sess.launchConfiguration) ? arr(sess.launchConfiguration.arguments) : [];
      for (const a of args.slice(0, 100)) {
        const m = typeof a === 'string' && /^-ares-deployment=([a-z]+)$/.exec(a);
        if (m && SHARDS.includes(m[1])) return m[1];
      }
    }
    return fail('bad');
  }
  async function riotIdFor(lock, puuid) {
    const chat = await localJson(lock, '/chat/v1/session').catch(() => null);
    if (chat && lc(chat.puuid) === puuid) {
      const id = riotIdOf(chat.game_name, chat.game_tag);
      if (id) return id;
    }
    const alias = await localJson(lock, '/player-account/aliases/v1/active').catch(() => null);
    return alias ? riotIdOf(alias.game_name, alias.tag_line) : '';
  }

  /* ---- internet: pd.*.a.pvp.net e valorant-api.com (sem redirecionamentos, com limite de tamanho) ---- */
  function discard(res) {
    try { if (res.body) res.body.cancel().catch(() => {}); } catch { /* ignora */ }
  }
  async function readCapped(res, max) {
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > max) { discard(res); fail('bad'); }
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { reader.cancel().catch(() => {}); fail('bad'); }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return Buffer.concat(chunks, total);
  }
  async function getJson(url, opts, max, timeout) {
    let res;
    try {
      res = await fetchFn(url, Object.assign({ method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeout) }, opts));
    } catch {
      return fail('network');
    }
    if (res.status === 401 || res.status === 403) { discard(res); fail('not_logged'); }
    if (res.status === 429 || res.status === 503) { discard(res); fail('rate_limited'); }
    if (!res.ok) { discard(res); const e = new ValError(res.status === 400 ? 'bad' : 'network'); e.status = res.status; throw e; }
    let buf;
    try { buf = await readCapped(res, max); } catch (e) { if (e instanceof ValError) throw e; return fail('network'); }
    try { return JSON.parse(buf.toString('utf8')); } catch { return fail('bad'); }
  }
  async function vapi(p, max) {
    let j;
    try {
      j = await getJson(vapiBase + p, { headers: { Accept: 'application/json' } }, max, VAPI_TIMEOUT_MS);
    } catch (e) {
      throw e instanceof ValError && e.code === 'bad' ? e : new ValError('network'); // site fora do ar: não é a Riot pedindo pausa
    }
    if (!obj(j) || j.status !== 200 || j.data == null) fail('bad');
    return j;
  }
  const resting = at => !!at && now() - at < RETRY_AFTER_FAIL_MS;
  // Renovação com o valor velho em mãos: espera no máximo `ms` (0: nada); se demorar ou falhar, fica o velho
  async function orStale(job, stale, ms) {
    job.catch(() => {}); // a falha já ficou anotada (pausa)
    if (!(ms > 0)) return stale;
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(resolve, ms, stale); });
    try { return await Promise.race([job, late]); } catch { return stale; } finally { clearTimeout(timer); }
  }
  function refreshVersion() {
    if (versionJob) return versionJob;
    versionJob = (async () => {
      try {
        const j = await vapi('/v1/version', 64 * 1024);
        const v = String(j.data.riotClientVersion || '');
        if (!VER_RE.test(v)) fail('bad');
        version = { at: now(), v };
        versionFailAt = 0;
        writeFileAtomic(nodePath.join(cacheDir(), 'version.json'), JSON.stringify(version));
        return v;
      } catch (e) {
        versionFailAt = now();
        throw e;
      }
    })().finally(() => { versionJob = null; });
    return versionJob;
  }
  // Versão do cliente (vai para o PD): memória → disco (1 h) → valorant-api.com. Vencida, a velha serve se a renovação
  // falhar ou demorar; depois de uma falha, 15 min sem perguntar de novo. Sem nenhuma, só a internet resolve.
  async function clientVersion() {
    if (!version) {
      const disk = await readCache('version.json');
      if (!version && obj(disk) && typeof disk.at === 'number' && disk.at <= now() && typeof disk.v === 'string' && VER_RE.test(disk.v)) version = { at: disk.at, v: disk.v };
    }
    if (version && (now() - version.at < VERSION_TTL_MS || resting(versionFailAt))) return version.v;
    return version ? orStale(refreshVersion(), version.v, staleWait) : refreshVersion();
  }
  const CONTENT_FILE = 'content-' + LANG + '.json';
  const fresh = c => !!c && now() - c.at < CONTENT_TTL_MS;
  function refreshContent() {
    if (contentJob) return contentJob;
    contentJob = (async () => {
      try {
        const [skins, tiers] = await Promise.all([
          vapi('/v1/weapons/skins?language=' + LANG, VAPI_MAX_SKINS),
          vapi('/v1/competitivetiers?language=' + LANG, VAPI_MAX_SMALL)
        ]);
        content = compactContent(skins, tiers, now());
        contentFailAt = 0;
        writeFileAtomic(nodePath.join(cacheDir(), CONTENT_FILE), JSON.stringify(content));
        return content;
      } catch (e) {
        contentFailAt = now();
        throw e;
      }
    })().finally(() => { contentJob = null; });
    return contentJob;
  }
  // Nomes das skins e dos ranks: memória → disco (24 h) → valorant-api.com. Vencidos, os velhos servem na hora (a
  // leitura espera a renovação só até opts.wait) e quando a internet falha; depois de uma falha, 15 min sem baixar de
  // novo (sem nada em mãos, só o clique em "Atualizar" — opts.click — tenta antes disso).
  async function loadContent(opts) {
    opts = opts || {};
    if (fresh(content)) return content;
    if (!content) {
      if (!diskJob) diskJob = readCache(CONTENT_FILE).finally(() => { diskJob = null; });
      const c = await diskJob;
      if (!content && obj(c) && c.v === 1 && c.lang === LANG && typeof c.at === 'number' && obj(c.skins) && obj(c.levels) && obj(c.tiers)) content = c;
      if (fresh(content)) return content;
    }
    if (content) return resting(contentFailAt) ? content : orStale(refreshContent(), content, opts.wait);
    return resting(contentFailAt) && !opts.click ? fail('network') : refreshContent();
  }

  async function run() {
    const lock = await readLock();
    const ent = await localGet(lock, '/entitlements/v1/token');
    const tok = ent.status === 200 ? obj(ent.json) : null;
    const puuid = uuidOf(tok && tok.subject);
    const access = tok && typeof tok.accessToken === 'string' ? tok.accessToken : '';
    const jwt = tok && typeof tok.token === 'string' ? tok.token : '';
    if (!puuid || access.length < 20 || jwt.length < 20 || access.length > 16384 || jwt.length > 16384 || /[\r\n]/.test(access + jwt)) fail('not_logged');
    const cont = loadContent({ wait: staleWait, click: true }).catch(() => null); // em paralelo com a versão
    const [shard, riotId, ver] = await Promise.all([shardOf(lock), riotIdFor(lock, puuid), clientVersion()]);
    const base = pdBase || 'https://pd.' + shard + '.a.pvp.net';
    const headers = {
      Accept: 'application/json',
      Authorization: 'Bearer ' + access,
      'X-Riot-Entitlements-JWT': jwt,
      'X-Riot-ClientPlatform': PLATFORM,
      'X-Riot-ClientVersion': ver
    };
    const pd = (p, opts) => getJson(base + p, Object.assign({ headers }, opts), PD_MAX, PD_TIMEOUT_MS);
    const storefront = () => pd('/store/v3/storefront/' + puuid, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: '{}' })
      .catch(e => { if (e.status === 404 || e.status === 405) return pd('/store/v2/storefront/' + puuid); throw e; });
    const at = now();
    const [wallet, owned, store, mmr, xp] = await Promise.allSettled([
      pd('/store/v1/wallet/' + puuid).then(parseWallet),
      Promise.all([pd('/store/v1/entitlements/' + puuid + '/' + SKIN_LEVEL_TYPE), cont]).then(([j, c]) => c ? parseOwned(j, c) : fail('network')),
      Promise.all([storefront(), cont]).then(([j, c]) => parseStore(j, c, at)),
      Promise.all([pd('/mmr/v1/players/' + puuid), cont]).then(([j, c]) => parseRank(j, c)),
      pd('/account-xp/v1/players/' + puuid).then(parseLevel)
    ]);
    const parts = { wallet, skins: owned, store, rank: mmr, level: xp };
    const missing = Object.keys(parts).filter(k => parts[k].status !== 'fulfilled');
    if (missing.length === 5) {
      const codes = missing.map(k => (parts[k].reason instanceof ValError ? parts[k].reason.code : 'network'));
      fail(['not_logged', 'rate_limited', 'bad', 'network'].find(c => codes.includes(c)) || 'network');
    }
    const val = k => (parts[k].status === 'fulfilled' ? parts[k].value : null);
    const s = val('store');
    return {
      ok: true, puuid, riotId, shard, at: new Date(at).toISOString(),
      rank: val('rank'), level: val('level'), wallet: val('wallet'),
      store: s ? s.store : null, night: s ? s.night : null, skins: val('skins'),
      missing // partes que falharam agora (a janela mantém o que já tinha delas)
    };
  }
  function snapshot() {
    if (snapJob) return snapJob;
    snapJob = run().catch(e => {
      const code = e instanceof ValError ? e.code : 'network';
      return { ok: false, error: code, message: MSG[code] };
    }).finally(() => { snapJob = null; });
    return snapJob;
  }

  /* ---- imagens das skins: cache em disco → media.valorant-api.com (só quando a janela pede a internet) ---- */
  const imgFile = id => nodePath.join(cacheDir(), 'img', id + '.png');
  async function downloadImage(id, c) {
    const skin = c.skins[id] ? id : c.levels[id];
    const icon = skin && c.skins[skin] ? c.skins[skin][1] : '';
    if (!icon || !ICON_RE.test(icon)) return null;
    let res;
    try {
      res = await fetchFn(mediaBase + icon, { method: 'GET', headers: { Accept: 'image/png' }, redirect: 'error', signal: AbortSignal.timeout(IMG_TIMEOUT_MS) });
    } catch { return null; }
    if (!res.ok) { discard(res); return null; }
    let buf = await readCapped(res, IMG_MAX).catch(() => null);
    if (!pngOk(buf)) return null;
    if (deps.shrink) { try { const small = deps.shrink(buf); if (pngOk(small)) buf = small; } catch { /* fica a original */ } }
    if (buf.length > IMG_MAX_OUT) return null;
    await writeFileAtomic(imgFile(id), buf);
    return buf;
  }
  async function imageFor(id, net) {
    try {
      const b = await fsp.readFile(imgFile(id));
      if (b.length <= IMG_MAX_OUT && pngOk(b)) return b;
    } catch { /* ainda não está no cache */ }
    if (!net) return null; // só o disco: nada de internet
    const c = await loadContent().catch(() => null);
    return c ? downloadImage(id, c) : null;
  }
  // opts.net: pode baixar o que falta (a janela só pede isso para contas atualizadas pelo botão nesta sessão).
  // Sem ele, só o que já está no cache em disco, sem nenhum acesso à internet.
  async function images(list, opts) {
    const net = !!(opts && opts.net);
    const ids = [...new Set(arr(list).slice(0, IMG_BATCH).map(uuidOf).filter(Boolean))];
    const out = {};
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++], key = (net ? 'n' : 'c') + id;
        if (!imgJobs.has(key)) imgJobs.set(key, imageFor(id, net).catch(() => null).finally(() => imgJobs.delete(key)));
        const buf = await imgJobs.get(key);
        if (buf) out[id] = 'data:image/png;base64,' + buf.toString('base64');
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out;
  }
  // Apaga do disco as imagens fora de `keep` (as que as outras contas ligadas ainda mostram): ao desvincular uma conta
  // e, com a lista vazia, junto com o cofre. Espera os downloads em andamento (senão um deles gravaria de novo).
  async function prune(keep) {
    const k = new Set(arr(keep).slice(0, 20000).map(uuidOf).filter(Boolean));
    await Promise.all([...imgJobs.values()]);
    const dir = nodePath.join(cacheDir(), 'img');
    if (!k.size) { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); return { ok: true }; }
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return { ok: true }; }
    for (const f of names) {
      if (!f.endsWith('.png') || !k.has(f.slice(0, -4))) await fsp.rm(nodePath.join(dir, f), { force: true }).catch(() => {});
    }
    return { ok: true };
  }

  return { snapshot, images, prune };
}

module.exports = { create, pngOk, parseLockfile, shardFor, sentence, riotIdOf, parseWallet, parseLevel, parseRank, parseOwned, parseStore, compactContent, iconPath, MSG, PLATFORM, CUR, SKIN_LEVEL_TYPE };
