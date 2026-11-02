'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const logger = require('./logger');
const auth = require('./auth');
const microsoft = require('./microsoft');

/**
 * 账户持久化。
 *
 * 1.11 起支持多个离线 / Microsoft 账户，并把访问令牌交给宿主提供的
 * 安全存储（Electron 桌面版使用 safeStorage / 系统钥匙串）。没有安全
 * 存储时仍可工作，但会在界面上明确提示令牌是明文保存的，浏览器版不会
 * 假装拥有系统钥匙串。
 */

const STORE_VERSION = 2;
const MAX_NOTE = 80;

let secureStore = null;

function setSecureStore(adapter) {
  secureStore = adapter && typeof adapter === 'object' ? adapter : null;
}

function encryptionInfo() {
  let available = false;
  let backend = 'none';
  try {
    available = Boolean(secureStore && secureStore.isAvailable && secureStore.isAvailable());
    backend = available ? (secureStore.backend || 'safeStorage') : 'none';
  } catch (err) {
    available = false;
    backend = 'none';
  }
  return {
    available,
    backend,
    warning: available
      ? ''
      : '当前环境没有可用的系统安全存储，Microsoft 令牌会以明文保存在 accounts.json；请勿把该文件分享给他人。',
  };
}

function accountFile() {
  return path.join(config.root(), 'accounts.json');
}

function emptyStore() {
  return { version: STORE_VERSION, activeId: '', accounts: [] };
}

function randomId(type) {
  return `${type}:${crypto.randomBytes(12).toString('hex')}`;
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeNote(value) {
  return cleanText(value, MAX_NOTE);
}

function sealSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  const info = encryptionInfo();
  if (info.available) {
    try {
      return { enc: 'safeStorage', data: secureStore.encrypt(text) };
    } catch (err) {
      logger.warn('加密账户令牌失败，退回明文存储:', err.message);
    }
  }
  return { enc: 'plaintext', data: text };
}

function openSecret(sealed) {
  if (!sealed) return { value: '', error: '' };
  if (typeof sealed === 'string') return { value: sealed, error: '' };
  if (sealed.enc === 'plaintext') return { value: String(sealed.data || ''), error: '' };
  if (sealed.enc === 'safeStorage') {
    if (!secureStore || !encryptionInfo().available) {
      return { value: '', error: '当前环境无法解密系统安全存储中的令牌，请在这台设备上重新登录' };
    }
    try {
      return { value: String(secureStore.decrypt(String(sealed.data || '')) || ''), error: '' };
    } catch (err) {
      return { value: '', error: '系统安全存储中的令牌无法解密，请重新登录' };
    }
  }
  return { value: '', error: '未知的令牌存储格式' };
}

function normalizeMicrosoft(raw, index) {
  const uuid = cleanText(raw.uuid, 64);
  const access = openSecret(raw.accessToken);
  const refresh = openSecret(raw.refreshToken);
  return {
    id: raw.id || (uuid ? `microsoft:${uuid}` : randomId('microsoft')),
    type: 'microsoft',
    name: cleanText(raw.name, 32) || `Microsoft ${index + 1}`,
    uuid,
    note: normalizeNote(raw.note),
    avatar: cleanText(raw.avatar, 300),
    xuid: cleanText(raw.xuid, 64),
    skin: typeof raw.skin === 'string' ? raw.skin.slice(0, 1000) : '',
    capes: Array.isArray(raw.capes) ? raw.capes.filter((item) => typeof item === 'string').slice(0, 10) : [],
    expiresAt: Number(raw.expiresAt) || 0,
    accessToken: access.value,
    refreshToken: refresh.value,
    tokenError: access.error || refresh.error || '',
    createdAt: Number(raw.createdAt) || Date.now(),
    lastUsedAt: Number(raw.lastUsedAt) || 0,
    encrypted: Boolean(raw.accessToken && typeof raw.accessToken === 'object' && raw.accessToken.enc === 'safeStorage'),
  };
}

function normalizeOffline(raw) {
  const name = auth.isValidName(raw.name) ? raw.name : '';
  if (!name) return null;
  return {
    id: raw.id || randomId('offline'),
    type: 'offline',
    name,
    uuid: auth.offlineUuid(name),
    note: normalizeNote(raw.note),
    avatar: cleanText(raw.avatar, 300),
    createdAt: Number(raw.createdAt) || Date.now(),
    lastUsedAt: Number(raw.lastUsedAt) || 0,
  };
}

function normalizeStore(raw) {
  if (!raw || typeof raw !== 'object') return emptyStore();
  const store = emptyStore();
  if (Array.isArray(raw.accounts)) {
    raw.accounts.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      const account = item.type === 'offline' ? normalizeOffline(item) : normalizeMicrosoft(item, index);
      if (account && !store.accounts.some((entry) => entry.id === account.id)) store.accounts.push(account);
    });
  } else if (raw.microsoft && typeof raw.microsoft === 'object') {
    // 1.10 及更早版本只有一个 Microsoft 账户，读取时无损迁移。
    const account = normalizeMicrosoft(Object.assign({}, raw.microsoft, { id: 'microsoft:legacy' }), 0);
    store.accounts.push(account);
    store.activeId = account.id;
  }
  const requestedActive = String(raw.activeId || '');
  store.activeId = store.accounts.some((item) => item.id === requestedActive)
    ? requestedActive
    : (store.accounts[0] ? store.accounts[0].id : '');
  return store;
}

function readRaw() {
  try {
    const raw = fs.readFileSync(accountFile(), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch (err) {
    return null;
  }
}

function serializedAccount(account) {
  if (account.type === 'offline') {
    return {
      id: account.id,
      type: 'offline',
      name: account.name,
      note: account.note || '',
      avatar: account.avatar || '',
      createdAt: account.createdAt || Date.now(),
      lastUsedAt: account.lastUsedAt || 0,
    };
  }
  return {
    id: account.id,
    type: 'microsoft',
    name: account.name,
    uuid: account.uuid,
    note: account.note || '',
    avatar: account.avatar || '',
    xuid: account.xuid || '',
    skin: account.skin || '',
    capes: Array.isArray(account.capes) ? account.capes : [],
    expiresAt: account.expiresAt || 0,
    createdAt: account.createdAt || Date.now(),
    lastUsedAt: account.lastUsedAt || 0,
    accessToken: sealSecret(account.accessToken),
    refreshToken: sealSecret(account.refreshToken),
  };
}

function writeStore(store) {
  const file = accountFile();
  const tmp = `${file}.tmp`;
  const data = {
    version: STORE_VERSION,
    activeId: store.activeId || '',
    accounts: store.accounts.map(serializedAccount),
  };
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.error('保存账户信息失败:', err.message);
    throw new Error('无法保存账户信息，请检查数据目录权限');
  }
}

function needsMigration(raw, store) {
  if (!raw || raw.version !== STORE_VERSION || !Array.isArray(raw.accounts)) return true;
  const encrypted = encryptionInfo().available;
  return store.accounts.some((account) => account.type === 'microsoft'
    && account.accessToken
    && !account.encrypted
    && encrypted);
}

function loadStore() {
  const raw = readRaw();
  const store = normalizeStore(raw);
  if (needsMigration(raw, store)) {
    try { writeStore(store); } catch (err) { /* 读取仍可继续，下一次修改时再尝试写入 */ }
  }
  return store;
}

function saveStore(store) {
  writeStore(store);
}

function publicAccount(account, activeId) {
  return {
    id: account.id,
    type: account.type,
    name: account.name,
    uuid: account.uuid || '',
    note: account.note || '',
    avatar: account.avatar || '',
    active: account.id === activeId,
    expiresAt: account.expiresAt || 0,
    expired: Boolean(account.expiresAt && Date.now() > account.expiresAt - 60 * 1000),
    tokenError: account.tokenError || '',
    createdAt: account.createdAt || 0,
    lastUsedAt: account.lastUsedAt || 0,
  };
}

function list() {
  const store = loadStore();
  return store.accounts
    .map((account) => publicAccount(account, store.activeId))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name, 'zh-CN'));
}

function active(store) {
  const data = store || loadStore();
  return data.accounts.find((item) => item.id === data.activeId) || data.accounts[0] || null;
}

function activeMicrosoft(store) {
  const account = active(store);
  if (account && account.type === 'microsoft') return account;
  return (store || loadStore()).accounts.find((item) => item.type === 'microsoft') || null;
}

function select(id) {
  const store = loadStore();
  const account = store.accounts.find((item) => item.id === id);
  if (!account) throw new Error('账户不存在');
  store.activeId = account.id;
  account.lastUsedAt = Date.now();
  saveStore(store);
  return publicAccount(account, store.activeId);
}

function addOffline(name, note) {
  const cleanName = String(name || '').trim();
  if (!auth.isValidName(cleanName)) {
    const error = new Error('离线玩家名需要 3–16 位字母、数字或下划线');
    error.code = 'BAD_NAME';
    throw error;
  }
  const store = loadStore();
  let account = store.accounts.find((item) => item.type === 'offline' && item.name.toLowerCase() === cleanName.toLowerCase());
  if (!account) {
    account = {
      id: randomId('offline'),
      type: 'offline',
      name: cleanName,
      uuid: auth.offlineUuid(cleanName),
      note: normalizeNote(note),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    store.accounts.push(account);
  } else {
    account.note = normalizeNote(note);
  }
  store.activeId = account.id;
  saveStore(store);
  return publicAccount(account, store.activeId);
}

function updateAccount(id, patch = {}) {
  const store = loadStore();
  const account = store.accounts.find((item) => item.id === id);
  if (!account) throw new Error('账户不存在');
  if (Object.prototype.hasOwnProperty.call(patch, 'note')) account.note = normalizeNote(patch.note);
  saveStore(store);
  return publicAccount(account, store.activeId);
}

function removeAccount(id) {
  const store = loadStore();
  const account = store.accounts.find((item) => item.id === id);
  if (!account) return { ok: false, error: '账户不存在' };
  store.accounts = store.accounts.filter((item) => item.id !== id);
  if (store.activeId === id) {
    const next = store.accounts[0];
    store.activeId = next ? next.id : '';
    if (next) next.lastUsedAt = Date.now();
  }
  saveStore(store);
  return { ok: true, activeId: store.activeId, account: store.accounts.find((item) => item.id === store.activeId) || null };
}

function upsertMicrosoft(account, options = {}) {
  const store = loadStore();
  const uuid = String(account.uuid || '').trim();
  let existing = store.accounts.find((item) => item.type === 'microsoft' && uuid && item.uuid === uuid);
  if (!existing) {
    existing = {
      id: options.id || randomId('microsoft'),
      type: 'microsoft',
      createdAt: Date.now(),
    };
    store.accounts.push(existing);
  }
  existing.name = cleanText(account.name, 32) || existing.name || 'Microsoft';
  existing.uuid = uuid || existing.uuid || '';
  existing.accessToken = String(account.accessToken || '');
  existing.refreshToken = String(account.refreshToken || existing.refreshToken || '');
  existing.expiresAt = Number(account.expiresAt) || existing.expiresAt || 0;
  existing.xuid = String(account.xuid || existing.xuid || '');
  existing.skin = account.skin || existing.skin || '';
  existing.capes = Array.isArray(account.capes) ? account.capes : existing.capes || [];
  existing.tokenError = '';
  existing.encrypted = false;
  if (Object.prototype.hasOwnProperty.call(account, 'note')) existing.note = normalizeNote(account.note);
  if (options.active !== false) {
    store.activeId = existing.id;
    existing.lastUsedAt = Date.now();
  }
  saveStore(store);
  return publicAccount(existing, store.activeId);
}

function setMicrosoft(account) {
  if (!account || !account.accessToken) throw new Error('Microsoft 账户数据不完整');
  return upsertMicrosoft(account);
}

function clearMicrosoft() {
  const store = loadStore();
  const account = active(store);
  if (!account || account.type !== 'microsoft') return { ok: true, removed: false };
  return removeAccount(account.id);
}

function summary() {
  const store = loadStore();
  const selected = active(store);
  const info = encryptionInfo();
  if (!selected || selected.type !== 'microsoft') {
    return {
      authenticated: false,
      name: '',
      uuid: '',
      expiresAt: 0,
      expired: false,
      activeId: store.activeId || '',
      activeType: selected ? selected.type : '',
      activeName: selected ? selected.name : '',
      encryption: info,
      accounts: store.accounts.map((account) => publicAccount(account, store.activeId)),
    };
  }
  return {
    authenticated: true,
    name: selected.name,
    uuid: selected.uuid,
    expiresAt: selected.expiresAt,
    expiresInMs: selected.expiresAt ? Math.max(0, selected.expiresAt - Date.now()) : 0,
    expired: Boolean(selected.expiresAt && Date.now() > selected.expiresAt - 60 * 1000),
    skin: selected.skin || '',
    capes: Array.isArray(selected.capes) ? selected.capes : [],
    tokenError: selected.tokenError || '',
    activeId: store.activeId,
    activeType: selected.type,
    activeName: selected.name,
    encryption: info,
    accounts: store.accounts.map((account) => publicAccount(account, store.activeId)),
  };
}

function profileFromAccount(account) {
  return {
    name: account.name,
    uuid: account.uuid,
    accessToken: account.accessToken,
    userType: 'msa',
    mode: 'microsoft',
    xuid: account.xuid || '',
    expiresAt: account.expiresAt,
  };
}

/**
 * 返回启动游戏使用的账户。Microsoft 模式下会按需刷新令牌；
 * 未登录或刷新失败时抛出明确错误，而不是静默切回离线账户。
 */
async function profileFor(settings) {
  if (!settings || settings.authMode !== 'microsoft') {
    const store = loadStore();
    const selected = active(store);
    const name = selected && selected.type === 'offline' ? selected.name : (settings ? settings.offlineName : 'Steve');
    return auth.offlineProfile(name);
  }
  const store = loadStore();
  const account = activeMicrosoft(store);
  if (!account) {
    const error = new Error('尚未登录 Microsoft 账户');
    error.code = 'NO_ACCOUNT';
    throw error;
  }
  if (account.tokenError && (!account.expiresAt || Date.now() < account.expiresAt - 60 * 1000)) {
    const error = new Error(account.tokenError);
    error.code = 'AUTH_DECRYPT';
    throw error;
  }
  if (!account.expiresAt || Date.now() < account.expiresAt - 60 * 1000) {
    return profileFromAccount(account);
  }
  try {
    logger.info('Microsoft 令牌即将过期，正在刷新');
    const refreshed = await microsoft.refresh(account.refreshToken);
    upsertMicrosoft(Object.assign({}, refreshed, { note: account.note }), { id: account.id });
    return profileFromAccount(refreshed);
  } catch (err) {
    logger.warn('Microsoft 令牌刷新失败:', err.message);
    const error = new Error('Microsoft 登录已失效，请重新登录');
    error.code = 'AUTH_EXPIRED';
    throw error;
  }
}

async function refreshActive() {
  const store = loadStore();
  const account = activeMicrosoft(store);
  if (!account) {
    const error = new Error('尚未登录 Microsoft 账户');
    error.code = 'NO_ACCOUNT';
    throw error;
  }
  const refreshed = await microsoft.refresh(account.refreshToken);
  const summaryValue = upsertMicrosoft(Object.assign({}, refreshed, { note: account.note }), { id: account.id });
  return { ok: true, account: summaryValue };
}

/**
 * 把本地皮肤上传到当前 Microsoft 账户的 Mojang 档案。
 * 只有正版账户能在原版客户端里显示自定义皮肤；离线账户没有可写入的
 * Mojang 档案，调用方应在此之前拦截并说明原因。
 */
async function uploadSkin(accessToken, buffer, model) {
  if (!accessToken) throw new Error('缺少 Microsoft 访问令牌，请重新登录');
  if (typeof FormData !== 'function' || typeof Blob !== 'function') {
    throw new Error('当前运行环境不支持上传皮肤');
  }
  const form = new FormData();
  form.append('variant', model === 'slim' ? 'slim' : 'classic');
  form.append('file', new Blob([buffer], { type: 'image/png' }), 'skin.png');
  const response = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'MinePilot',
    },
    body: form,
  });
  let data = {};
  try {
    const text = await response.text();
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(
      data.errorMessage
      || data.error
      || (response.status === 401
        ? 'Microsoft 登录已失效，请重新登录后再上传皮肤'
        : `皮肤上传失败（HTTP ${response.status}）`)
    );
    error.code = response.status === 401 ? 'AUTH_EXPIRED' : 'SKIN_UPLOAD_FAILED';
    throw error;
  }
  const skins = Array.isArray(data.skins) ? data.skins : [];
  const capes = Array.isArray(data.capes) ? data.capes : [];
  const activeSkin = skins.find((item) => item && item.state === 'ACTIVE') || skins[0] || null;
  return {
    skin: activeSkin && activeSkin.url ? String(activeSkin.url) : '',
    capes,
  };
}

/** 把上传结果写回当前 Microsoft 账户，供界面显示“正版皮肤可用”。 */
function updateActiveSkin(payload = {}) {
  const store = loadStore();
  const account = activeMicrosoft(store);
  if (!account) throw new Error('当前没有可更新的 Microsoft 账户');
  if (typeof payload.skin === 'string') account.skin = payload.skin.slice(0, 1000);
  if (Array.isArray(payload.capes)) account.capes = payload.capes;
  saveStore(store);
  return summary();
}

function displayName(settings) {
  if (settings && settings.authMode === 'microsoft') {
    const current = summary();
    if (current.authenticated) return current.name;
  }
  const store = loadStore();
  const selected = active(store);
  if (selected && selected.type === 'offline') return selected.name;
  return (settings && settings.offlineName) || 'Steve';
}

module.exports = {
  load: loadStore,
  summary,
  list,
  select,
  addOffline,
  updateAccount,
  removeAccount,
  setMicrosoft,
  clearMicrosoft,
  refreshActive,
  profileFor,
  uploadSkin,
  updateActiveSkin,
  displayName,
  accountFile,
  setSecureStore,
  encryptionInfo,
};