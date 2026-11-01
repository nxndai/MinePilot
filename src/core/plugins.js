'use strict';

/**
 * 本地插件管理。
 *
 * 插件是用户主动放进 plugins/<id>/ 的本地文件，不是从网络自动下载的。
 * 插件主脚本在 Web Worker 中运行，拿不到页面的 DOM、localStorage 或账户
 * 令牌；但 Worker 仍然可以联网，因此安装前必须确认来源可信。
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const logger = require('./logger');
const net = require('./net');
const { extractZip, listZipEntries } = require('./zip');

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const MAX_FILES = 300;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_MAIN_BYTES = 512 * 1024;
const API_VERSION = 1;

function pluginsDir() {
  const dir = path.join(config.root(), 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stateFile() {
  return path.join(pluginsDir(), 'plugins.json');
}

function readState() {
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return data && typeof data === 'object' ? data : { enabled: {} };
  } catch (err) {
    return { enabled: {} };
  }
}

function writeState(state) {
  fs.mkdirSync(pluginsDir(), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8');
}

function enabledState() {
  const state = readState();
  return state.enabled && typeof state.enabled === 'object' ? state.enabled : {};
}

function normalizeNetwork(value) {
  if (value == null) return { list: [], error: '' };
  if (!Array.isArray(value)) return { list: [], error: 'permissions.network 必须是域名数组' };
  const list = [];
  for (const raw of value.slice(0, 40)) {
    let text = String(raw || '').trim().toLowerCase();
    if (!text) continue;
    if (text === '*') {
      if (!list.includes('*')) list.push('*');
      continue;
    }
    text = text.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (!/^(\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(text) || text.includes('..')) {
      return { list: [], error: `联网权限域名不合法：${raw}` };
    }
    if (!list.includes(text)) list.push(text);
    if (list.length >= 20) break;
  }
  return { list, error: '' };
}

function normalizePermissions(raw) {
  const declared = Boolean(raw && Object.prototype.hasOwnProperty.call(raw, 'permissions'));
  const source = raw && raw.permissions && typeof raw.permissions === 'object' ? raw.permissions : {};
  const network = normalizeNetwork(source.network);
  return {
    permissions: {
      network: network.list,
      storage: source.storage === true,
      notifications: source.notifications === true,
    },
    permissionsDeclared: declared,
    permissionsError: network.error,
  };
}

function readManifest(dir, folderId, options = {}) {
  const file = path.join(dir, 'plugin.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { error: 'plugin.json 无法读取或不是有效 JSON' };
  }
  const id = String(raw.id || folderId || '').trim().toLowerCase();
  if (!ID_PATTERN.test(id)) return { error: '插件 id 只能包含小写字母、数字、点、下划线和短横线（2–64 位）' };
  if (folderId && options.enforceFolder !== false && id !== folderId) {
    return { error: `插件 id（${id}）必须与文件夹名（${folderId}）一致` };
  }
  if (Number(raw.apiVersion || 1) !== API_VERSION) return { error: `不支持的插件 API 版本：${raw.apiVersion}` };
  const main = String(raw.main || 'main.js').replace(/\\/g, '/');
  if (!/^[a-z0-9._/-]+\.js$/i.test(main) || main.includes('..') || main.startsWith('/')) {
    return { error: '插件入口必须是插件目录内的 .js 文件' };
  }
  const mainPath = path.resolve(dir, main);
  if (!mainPath.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(mainPath)) {
    return { error: `插件入口不存在：${main}` };
  }
  const permissions = normalizePermissions(raw);
  if (permissions.permissionsError) return { error: permissions.permissionsError };
  return {
    manifest: {
      id,
      name: String(raw.name || id).slice(0, 80),
      version: String(raw.version || '0.0.0').slice(0, 32),
      description: String(raw.description || '').slice(0, 300),
      author: String(raw.author || '匿名作者').slice(0, 80),
      homepage: String(raw.homepage || '').slice(0, 300),
      apiVersion: API_VERSION,
      main,
      permissions: permissions.permissions,
      permissionsDeclared: permissions.permissionsDeclared,
    },
    mainPath,
  };
}

function list() {
  const root = pluginsDir();
  const enabled = enabledState();
  const result = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  } catch (err) {
    return result;
  }
  for (const entry of entries) {
    if (!ID_PATTERN.test(entry.name)) continue;
    const info = readManifest(path.join(root, entry.name), entry.name);
    if (info.error) {
      result.push({
        id: entry.name,
        name: entry.name,
        version: '—',
        description: '',
        author: '',
        enabled: false,
        permissions: { network: [] },
        permissionsDeclared: false,
        error: info.error,
        installedAt: 0,
      });
      continue;
    }
    result.push(Object.assign({}, info.manifest, {
      enabled: enabled[info.manifest.id] !== false,
      installedAt: 0,
    }));
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function safeId(id) {
  const value = String(id || '').trim().toLowerCase();
  if (!ID_PATTERN.test(value)) throw new Error('插件 id 无效');
  return value;
}

function setEnabled(id, enabled) {
  const pluginId = safeId(id);
  const state = readState();
  if (!state.enabled || typeof state.enabled !== 'object') state.enabled = {};
  state.enabled[pluginId] = Boolean(enabled);
  writeState(state);
  return { ok: true, id: pluginId, enabled: Boolean(enabled) };
}

function remove(id) {
  const pluginId = safeId(id);
  const dir = path.join(pluginsDir(), pluginId);
  if (!fs.existsSync(dir)) return { ok: false, error: '插件不存在' };
  fs.rmSync(dir, { recursive: true, force: true });
  const state = readState();
  if (state.enabled) delete state.enabled[pluginId];
  writeState(state);
  logger.info('已移除插件:', pluginId);
  return { ok: true, id: pluginId };
}

function source(id) {
  const pluginId = safeId(id);
  const dir = path.join(pluginsDir(), pluginId);
  const info = readManifest(dir, pluginId);
  if (info.error) throw new Error(info.error);
  const stat = fs.statSync(info.mainPath);
  if (stat.size > MAX_MAIN_BYTES) throw new Error('插件入口文件过大（上限 512 KB）');
  return {
    ok: true,
    id: pluginId,
    manifest: info.manifest,
    source: fs.readFileSync(info.mainPath, 'utf8'),
  };
}

function walkSize(root) {
  let bytes = 0;
  let files = 0;
  const visit = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        files += 1;
        try { bytes += fs.statSync(file).size; } catch (err) { /* ignore */ }
      }
    }
  };
  visit(root);
  return { bytes, files };
}

function findPluginRoot(entries) {
  const files = entries.filter((entry) => !entry.name.endsWith('/'));
  const direct = files.find((entry) => entry.name === 'plugin.json');
  if (direct) return '';
  const candidates = files.filter((entry) => /^[^/]+\/plugin\.json$/.test(entry.name));
  if (candidates.length !== 1) return null;
  const prefix = candidates[0].name.slice(0, -'plugin.json'.length);
  if (!files.every((entry) => entry.name.startsWith(prefix))) return null;
  return prefix;
}

function install(zipPath, options = {}) {
  const sourceFile = path.resolve(String(zipPath || ''));
  if (!fs.existsSync(sourceFile)) throw new Error('插件压缩包不存在');
  const stat = fs.statSync(sourceFile);
  if (!stat.isFile()) throw new Error('插件路径不是文件');
  if (stat.size > MAX_TOTAL_BYTES) throw new Error('插件压缩包过大（上限 25 MB）');

  const entries = listZipEntries(sourceFile);
  if (!entries.length) throw new Error('插件压缩包是空的');
  if (entries.length > MAX_FILES) throw new Error(`插件文件过多（上限 ${MAX_FILES} 个）`);
  const totalBytes = entries.reduce((sum, entry) => sum + (entry.size || 0), 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error('插件解压后体积过大（上限 25 MB）');

  const prefix = findPluginRoot(entries);
  if (prefix === null) throw new Error('插件包根目录必须包含 plugin.json');
  const manifestEntry = entries.find((entry) => entry.name === `${prefix}plugin.json`);
  if (!manifestEntry) throw new Error('插件包缺少 plugin.json');

  const temp = path.join(pluginsDir(), `.install-${process.pid}-${Date.now()}`);
  fs.mkdirSync(temp, { recursive: true });
  let target = '';
  try {
    extractZip(sourceFile, temp, {
      maxOutputLength: MAX_TOTAL_BYTES,
      filter: (name) => {
        const normalized = name.replace(/\\/g, '/');
        if (!normalized.startsWith(prefix)) return false;
        const rel = normalized.slice(prefix.length);
        return Boolean(rel) && !rel.startsWith('/') && !rel.includes('../') && !rel.endsWith('/');
      },
    });
    const rootDir = prefix ? path.join(temp, prefix.replace(/\/$/, '')) : temp;
    const extracted = walkSize(rootDir);
    if (extracted.bytes > MAX_TOTAL_BYTES || extracted.files > MAX_FILES) {
      throw new Error('插件解压后体积或文件数量超过限制');
    }
    const info = readManifest(rootDir, '', { enforceFolder: false });
    if (info.error) throw new Error(info.error);
    const id = info.manifest.id;
    target = path.join(pluginsDir(), id);
    if (fs.existsSync(target) && !options.overwrite) {
      const error = new Error(`插件 ${info.manifest.name} 已经安装，是否覆盖？`);
      error.code = 'PLUGIN_EXISTS';
      error.plugin = info.manifest;
      throw error;
    }

    const backup = `${target}.old-${Date.now()}`;
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    try {
      fs.renameSync(rootDir, target);
    } catch (err) {
      if (fs.existsSync(backup)) fs.renameSync(backup, target);
      throw err;
    }
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });

    setEnabled(id, options.enabled !== false);
    logger.info('已安装插件:', id, info.manifest.version);
    return { ok: true, plugin: Object.assign({}, info.manifest, { enabled: options.enabled !== false, installedAt: Date.now() }) };
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  }
}

function inspect(zipPath) {
  const sourceFile = path.resolve(String(zipPath || ''));
  if (!fs.existsSync(sourceFile)) throw new Error('插件压缩包不存在');
  const stat = fs.statSync(sourceFile);
  if (!stat.isFile()) throw new Error('插件路径不是文件');
  if (stat.size > MAX_TOTAL_BYTES) throw new Error('插件压缩包过大（上限 25 MB）');
  const entries = listZipEntries(sourceFile);
  if (!entries.length) throw new Error('插件压缩包是空的');
  if (entries.length > MAX_FILES) throw new Error(`插件文件过多（上限 ${MAX_FILES} 个）`);
  const prefix = findPluginRoot(entries);
  if (prefix === null) throw new Error('插件包根目录必须包含 plugin.json');
  const temp = path.join(pluginsDir(), `.inspect-${process.pid}-${Date.now()}`);
  fs.mkdirSync(temp, { recursive: true });
  try {
    extractZip(sourceFile, temp, {
      maxOutputLength: MAX_TOTAL_BYTES,
      filter: (name) => {
        const normalized = name.replace(/\\/g, '/');
        if (!normalized.startsWith(prefix)) return false;
        const rel = normalized.slice(prefix.length);
        return Boolean(rel) && !rel.startsWith('/') && !rel.includes('../') && !rel.endsWith('/');
      },
    });
    const rootDir = prefix ? path.join(temp, prefix.replace(/\/$/, '')) : temp;
    const info = readManifest(rootDir, '', { enforceFolder: false });
    if (info.error) throw new Error(info.error);
    return {
      ok: true,
      manifest: info.manifest,
      filePath: sourceFile,
      size: stat.size,
    };
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (err) { /* ignore */ }
  }
}

function safeHttpsUrl(value) {
  const text = String(value || '').trim();
  if (!/^https:\/\//i.test(text)) return '';
  try {
    const parsed = new URL(text);
    if (!parsed.hostname || parsed.username || parsed.password) return '';
    return parsed.toString();
  } catch (err) {
    return '';
  }
}

function marketEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().toLowerCase();
  if (!ID_PATTERN.test(id)) return null;
  const download = safeHttpsUrl(raw.download);
  const sha256 = String(raw.sha256 || '').trim().toLowerCase();
  if (!download || !/^[a-f0-9]{64}$/.test(sha256)) return null;
  const permissionInfo = normalizePermissions(raw);
  if (permissionInfo.permissionsError) return null;
  return {
    id,
    name: String(raw.name || id).slice(0, 80),
    version: String(raw.version || '0.0.0').slice(0, 32),
    description: String(raw.description || '').slice(0, 300),
    author: String(raw.author || '匿名作者').slice(0, 80),
    homepage: safeHttpsUrl(raw.homepage),
    download,
    sha256,
    size: Math.max(0, Number(raw.size) || 0),
    permissions: permissionInfo.permissions,
    permissionsDeclared: permissionInfo.permissionsDeclared,
  };
}

async function marketIndex(indexUrl) {
  const url = safeHttpsUrl(indexUrl);
  if (!url) throw new Error('插件索引地址必须是 https:// 链接');
  const data = await net.fetchJson(url, { timeout: 20000, retries: 2 });
  const raw = Array.isArray(data) ? data : (data && Array.isArray(data.plugins) ? data.plugins : null);
  if (!raw) throw new Error('插件索引格式错误：需要 plugins 数组');
  if (raw.length > 200) throw new Error('插件索引条数过多（上限 200）');
  const plugins = raw.map(marketEntry).filter(Boolean);
  return {
    ok: true,
    indexUrl: url,
    updatedAt: data && data.updatedAt ? String(data.updatedAt).slice(0, 40) : '',
    plugins,
    skipped: raw.length - plugins.length,
  };
}

async function installFromMarket(entry, options = {}) {
  const normalized = marketEntry(entry);
  if (!normalized) throw new Error('插件索引条目无效，或缺少 SHA-256 校验值');
  const cache = path.join(config.cacheDir(), 'plugin-market');
  fs.mkdirSync(cache, { recursive: true });
  const zipFile = path.join(cache, `${normalized.id}-${Date.now()}.zip`);
  try {
    await net.downloadFile(normalized.download, zipFile, { retries: 2 });
    const actual = await net.sha256File(zipFile);
    if (!actual || actual.toLowerCase() !== normalized.sha256) {
      throw new Error('插件包 SHA-256 校验失败，已拒绝安装');
    }
    // 索引里的权限声明只是安装前的展示；下载后必须以插件包里的
    // plugin.json 为准。若两者不一致，拒绝安装，避免“展示 A、实际 B”。
    const inspected = inspect(zipFile);
    const actualNetwork = Array.isArray(inspected.manifest.permissions && inspected.manifest.permissions.network)
      ? inspected.manifest.permissions.network.slice().sort()
      : [];
    const expectedNetwork = normalized.permissions.network.slice().sort();
    if (inspected.manifest.id !== normalized.id || JSON.stringify(actualNetwork) !== JSON.stringify(expectedNetwork)) {
      throw new Error('插件包声明的 id 或联网权限与索引不一致，已拒绝安装');
    }
    const installed = install(zipFile, { overwrite: Boolean(options.overwrite), enabled: options.enabled !== false });
    return Object.assign({ ok: true }, installed, {
      market: {
        id: normalized.id,
        version: normalized.version,
        permissions: normalized.permissions,
        permissionsDeclared: normalized.permissionsDeclared,
      },
    });
  } finally {
    try { fs.rmSync(zipFile, { force: true }); } catch (err) { /* ignore */ }
  }
}

function openDir() {
  return pluginsDir();
}

module.exports = {
  list,
  install,
  inspect,
  setEnabled,
  remove,
  source,
  pluginsDir,
  openDir,
  marketIndex,
  installFromMarket,
  API_VERSION,
};