'use strict';

/**
 * CurseForge 模组搜索与安装。
 *
 * CurseForge 官方 API 要求开发者申请 API Key，且不允许把 Key 内置到公开
 * 客户端里。因此这里由用户在「设置 → 模组来源」中填入自己的 Key，Key 只
 * 保存在本机配置文件中，不发送到除 api.curseforge.com 以外的地方。
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const net = require('./net');
const logger = require('./logger');

const API = 'https://api.curseforge.com/v1';
const GAME_ID = 432;        // Minecraft
const CLASS_ID = 6;         // Mods
const LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt']);
const LOADER_TYPES = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const SEARCH_TTL = 120000;
const VERSION_TTL = 120000;
const CATEGORY_TTL = 600000;
const cache = new Map();

const CATEGORY_LABELS = {
  'API and Library': '库/API',
  'Adventure and RPG': '冒险',
  'Armor, Tools, and Weapons': '装备',
  'Biomes': '生物群系',
  'Cosmetic': '装饰',
  'Decoration': '装饰',
  'Dimensions': '维度',
  'Economy': '经济',
  'Education': '教育',
  'Energy': '能源',
  'Food': '食物',
  'Genetics': '基因',
  'Magic': '魔法',
  'Map and Information': '信息/地图',
  'Miscellaneous': '杂项',
  'Mobs': '生物',
  'Optimization': '优化',
  'Performance': '优化',
  'Ores and Resources': '矿物资源',
  'Player Transport': '运输',
  'Processing': '处理',
  'Redstone': '红石',
  'Server': '服务器',
  'Server Utility': '服务器',
  'Storage': '存储',
  'Structures': '结构',
  'Technology': '科技',
  'Tinkering': '工匠',
  'Utility': '功能',
  'Utility & QoL': '功能',
  'World Gen': '世界生成',
  'Addons': '附属',
  'Automation': '自动化',
  'Bug Fixes': '修复',
  'Farming': '农业',
};

// 只保留常用的根分类，避免把 Create、Twilight Forest 这类
// 「模组专属分类」也铺成筛选按钮。
const ROOT_CATEGORY_ORDER = [
  'utility-qol',
  'performance',
  'technology',
  'magic',
  'adventure-rpg',
  'world-gen',
  'library-api',
  'storage',
  'armor-weapons-tools',
  'world-mobs',
  'technology-player-transport',
  'mc-food',
  'redstone',
  'technology-automation',
  'cosmetic',
  'server-utility',
  'map-information',
  'mc-addons',
  'bug-fixes',
  'mc-miscellaneous',
];

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max || 500);
}

function normalizeLoader(value) {
  const loader = String(value || '').toLowerCase();
  return LOADERS.has(loader) ? loader : '';
}

function loaderForVersion(version) {
  const list = version && Array.isArray(version.loaders) ? version.loaders : [];
  const found = list.find((item) => item && LOADERS.has(item.key));
  return found ? found.key : '';
}

function validateModId(value) {
  const id = String(value || '').trim();
  if (!/^\d{1,12}$/.test(id)) {
    const error = new Error('CurseForge 项目 ID 不合法');
    error.code = 'BAD_PROJECT';
    throw error;
  }
  return id;
}

function getKey(options = {}) {
  const key = String(options.apiKey || '').trim();
  if (!key) {
    const error = new Error('尚未配置 CurseForge API Key，请在「设置 → 模组来源」中填写');
    error.code = 'CF_NO_KEY';
    throw error;
  }
  return key;
}

function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > item.ttl) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function cacheSet(key, value, ttl) {
  cache.set(key, { time: Date.now(), value, ttl });
  if (cache.size > 80) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

async function cfJson(pathname, options = {}) {
  const key = getKey({ apiKey: options.apiKey || options.key });
  const { signal, retries = 2 } = options;
  const url = `${API}${pathname}`;
  try {
    return await net.fetchJson(url, {
      headers: { 'x-api-key': key },
      signal,
      timeout: 20000,
      retries,
    });
  } catch (err) {
    if (/HTTP (401|403)/.test(err.message)) {
      const error = new Error('CurseForge API Key 无效或没有权限，请到「设置 → 模组来源」检查');
      error.code = 'CF_BAD_KEY';
      throw error;
    }
    if (/HTTP 429/.test(err.message)) {
      const error = new Error('CurseForge 请求过于频繁，请稍后再试');
      error.code = 'CF_RATE_LIMIT';
      throw error;
    }
    throw err;
  }
}

function mapMod(raw) {
  if (!raw || raw.id == null) return null;
  const authors = (Array.isArray(raw.authors) ? raw.authors : [])
    .map((item) => cleanText(item && item.name, 60))
    .filter(Boolean);
  const categories = (Array.isArray(raw.categories) ? raw.categories : [])
    .map((item) => {
      const name = cleanText(item && item.name, 80);
      return CATEGORY_LABELS[name] || name;
    })
    .filter(Boolean);
  const logo = raw.logo || {};
  return {
    source: 'CurseForge',
    projectId: String(raw.id),
    slug: cleanText(raw.slug, 100),
    title: cleanText(raw.name, 160),
    description: cleanText(raw.summary, 500),
    author: authors.join(', ') || '未知作者',
    iconUrl: String(logo.thumbnailUrl || logo.url || ''),
    downloads: Number(raw.downloadCount) || 0,
    follows: 0,
    categories,
    versions: [],
    dateModified: raw.dateModified || '',
    latestVersion: '',
    license: '',
    externalUrl: raw.links && raw.links.websiteUrl ? String(raw.links.websiteUrl) : '',
    installable: raw.allowModDistribution !== false,
  };
}

function mapFile(raw, fallbackProjectId) {
  if (!raw || raw.id == null) return null;
  const gameVersions = Array.isArray(raw.gameVersions) ? raw.gameVersions.slice(0, 40) : [];
  const loaders = gameVersions
    .map((item) => String(item).toLowerCase())
    .filter((item) => LOADERS.has(item));
  const sha1 = (Array.isArray(raw.hashes) ? raw.hashes : [])
    .find((item) => Number(item && item.algo) === 1);
  const releaseType = Number(raw.releaseType) === 2 ? 'beta' : Number(raw.releaseType) === 3 ? 'alpha' : 'release';
  const dependencies = (Array.isArray(raw.dependencies) ? raw.dependencies : [])
    .filter((dep) => Number(dep && dep.relationType) === 3 && dep.modId != null)
    .map((dep) => ({
      versionId: '',
      projectId: String(dep.modId),
      dependencyType: 'required',
    }));

  return {
    id: String(raw.id),
    projectId: String(raw.modId || fallbackProjectId || ''),
    name: cleanText(raw.displayName || raw.fileName, 180),
    versionNumber: cleanText(raw.displayName || raw.fileName, 120),
    versionType: releaseType,
    gameVersions,
    loaders,
    datePublished: raw.fileDate || '',
    downloads: 0,
    file: {
      filename: cleanText(raw.fileName, 240),
      url: String(raw.downloadUrl || ''),
      size: Number(raw.fileLength) || 0,
      sha1: sha1 ? String(sha1.value || '').toLowerCase() : '',
      primary: true,
    },
    dependencies,
  };
}

async function search(options = {}) {
  const key = getKey(options);
  const query = cleanText(options.query, 120).trim();
  const gameVersion = cleanText(options.gameVersion, 40).trim();
  const loader = normalizeLoader(options.loader);
  const category = String(options.category || '').trim();
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 20));
  const offset = Math.max(0, Math.min(1000, Number(options.offset) || 0));

  const params = new URLSearchParams({
    gameId: String(GAME_ID),
    classId: String(CLASS_ID),
    index: String(offset),
    pageSize: String(limit),
    sortField: '2',
    sortOrder: 'desc',
  });
  if (query) params.set('searchFilter', query);
  if (gameVersion) params.set('gameVersion', gameVersion);
  if (loader && LOADER_TYPES[loader]) params.set('modLoaderType', String(LOADER_TYPES[loader]));
  if (/^\d+$/.test(category)) params.set('categoryId', category);

  const cacheKey = `search:${params.toString()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await cfJson(`/mods/search?${params.toString()}`, { key, signal: options.signal });
  const hits = (Array.isArray(data && data.data) ? data.data : [])
    .map(mapMod)
    .filter(Boolean);
  const pagination = (data && data.pagination) || {};
  const result = {
    source: 'CurseForge',
    totalHits: Number(pagination.totalCount) || hits.length,
    offset,
    limit,
    query,
    gameVersion,
    loader,
    category,
    hits,
  };
  cacheSet(cacheKey, result, SEARCH_TTL);
  return result;
}

async function getCategories(options = {}) {
  const key = getKey(options);
  const cacheKey = 'categories';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await cfJson(`/categories?gameId=${GAME_ID}&classId=${CLASS_ID}`, { key, signal: options.signal });
  const list = (Array.isArray(data && data.data) ? data.data : [])
    .filter((item) => item && item.id != null)
    .map((item) => {
      const name = cleanText(item.name, 80);
      return {
        id: String(item.id),
        slug: cleanText(item.slug, 80),
        name,
        label: CATEGORY_LABELS[name] || name,
      };
    })
    .filter((item) => item.name && ROOT_CATEGORY_ORDER.includes(item.slug))
    .sort((a, b) => ROOT_CATEGORY_ORDER.indexOf(a.slug) - ROOT_CATEGORY_ORDER.indexOf(b.slug));

  const result = { source: 'CurseForge', categories: list };
  cacheSet(cacheKey, result, CATEGORY_TTL);
  return result;
}

async function getAllVersions(options = {}) {
  const key = getKey(options);
  const projectId = validateModId(options.projectId);
  const gameVersion = cleanText(options.gameVersion, 40).trim();
  const loader = normalizeLoader(options.loader);

  const params = new URLSearchParams({
    index: '0',
    pageSize: '50',
  });
  if (gameVersion) params.set('gameVersion', gameVersion);
  if (loader && LOADER_TYPES[loader]) params.set('modLoaderType', String(LOADER_TYPES[loader]));

  const cacheKey = `versions:${projectId}:${gameVersion}:${loader}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await cfJson(`/mods/${projectId}/files?${params.toString()}`, { key, signal: options.signal });
  const versions = (Array.isArray(data && data.data) ? data.data : [])
    .map((file) => mapFile(file, projectId))
    .filter(Boolean)
    .sort((a, b) => String(b.datePublished).localeCompare(String(a.datePublished)));

  const result = { source: 'CurseForge', projectId, gameVersion, loader, versions };
  cacheSet(cacheKey, result, VERSION_TTL);
  return result;
}

async function getVersions(options = {}) {
  const result = await getAllVersions(options);
  return result;
}

async function getFile(options = {}) {
  const key = getKey(options);
  const projectId = validateModId(options.projectId);
  const fileId = validateModId(options.versionId);
  const cacheKey = `file:${projectId}:${fileId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await cfJson(`/mods/${projectId}/files/${fileId}`, { key, signal: options.signal });
  const version = mapFile(data && data.data, projectId);
  if (!version) {
    const error = new Error('CurseForge 没有返回有效的文件');
    error.code = 'NO_VERSION';
    throw error;
  }
  cacheSet(cacheKey, version, VERSION_TTL);
  return version;
}

function safeFilename(name) {
  let base = path.basename(String(name || 'mod.jar'));
  base = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  if (!base) base = 'mod.jar';
  if (!/\.(jar|zip)$/i.test(base)) base += '.jar';
  return base.slice(0, 180);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function resolvePlan(initial, options) {
  const { gameVersion, loader, signal, onProgress } = options;
  const plan = [];
  const warnings = [];
  const seenVersions = new Set();
  const seenProjects = new Set();
  const queue = [{ version: initial, required: false, depth: 0, parentKey: '', parentName: '' }];

  while (queue.length && plan.length < 30) {
    if (signal && signal.aborted) throw new Error('已取消');
    const task = queue.shift();
    const version = task.version;
    if (!version || !version.id || seenVersions.has(version.id)) continue;
    if (version.projectId && seenProjects.has(version.projectId)) continue;

    const file = version.file;
    if (!file || !file.url) {
      const message = version.projectId
        ? `项目 ${version.projectId} 的作者关闭了第三方下载`
        : 'CurseForge 没有返回可下载文件';
      if (task.required) warnings.push(message);
      else {
        const error = new Error(`${version.name || version.id}：${message}，请到 CurseForge 页面手动下载`);
        error.code = 'CF_DOWNLOAD_DISABLED';
        throw error;
      }
      continue;
    }
    if (gameVersion && version.gameVersions.length && !version.gameVersions.includes(gameVersion)) {
      warnings.push(`${version.name || version.id} 标注不支持 Minecraft ${gameVersion}`);
    }

    seenVersions.add(version.id);
    if (version.projectId) seenProjects.add(version.projectId);
    const currentKey = version.projectId || version.id;
    plan.push({
      version,
      file,
      required: Boolean(task.required),
      depth: task.depth || 0,
      parentKey: task.parentKey || '',
      parentName: task.parentName || '',
    });

    for (const dep of version.dependencies) {
      if (dep.dependencyType !== 'required' || !dep.projectId) continue;
      if (onProgress) {
        onProgress({
          phase: 'resolve',
          message: `正在解析前置：${dep.projectId}`,
          current: plan.length,
        });
      }
      try {
        const result = await getVersions({
          projectId: dep.projectId,
          gameVersion,
          loader,
          apiKey: options.apiKey,
          signal,
        });
        const dependencyVersion = result.versions.find((item) => item.file && item.file.url) || null;
        if (!dependencyVersion) {
          warnings.push(`找不到必需前置 ${dep.projectId} 的兼容版本`);
          continue;
        }
        if (dependencyVersion.projectId && seenProjects.has(dependencyVersion.projectId)) continue;
        queue.push({
          version: dependencyVersion,
          required: true,
          depth: (task.depth || 0) + 1,
          parentKey: currentKey,
          parentName: version.name || version.versionNumber || currentKey,
        });
      } catch (err) {
        if (signal && signal.aborted) throw err;
        warnings.push(`前置 ${dep.projectId} 解析失败：${err.message}`);
      }
    }
  }

  if (!plan.length) {
    const error = new Error('没有找到与该游戏版本/加载器兼容的模组文件');
    error.code = 'NO_VERSION';
    throw error;
  }
  return { plan, warnings };
}

function installedFilenames(target) {
  const dirs = [
    path.join(target.gameDir, 'mods'),
    path.join(config.root(), 'game', String(target.id || 'default'), 'mods'),
  ];
  const names = new Set();
  for (const dir of dirs) {
    try {
      for (const name of fs.readdirSync(dir)) names.add(String(name).toLowerCase());
    } catch (err) {
      /* 目录不存在 */
    }
  }
  return names;
}

/**
 * 只解析 CurseForge 依赖，不下载文件，供安装前依赖树使用。
 */
async function preview(options = {}) {
  const target = options.target || {};
  if (!target.id || !target.gameDir) {
    const error = new Error('没有找到要检查依赖的目标版本');
    error.code = 'NO_TARGET';
    throw error;
  }
  const projectId = validateModId(options.projectId);
  const gameVersion = cleanText(options.gameVersion || target.mcVersion, 40).trim();
  const loader = normalizeLoader(options.loader || loaderForVersion(target));
  const signal = options.signal || null;

  let initial = null;
  if (options.versionId) {
    initial = await getFile({ projectId, versionId: options.versionId, apiKey: options.apiKey, signal });
  } else {
    const result = await getVersions({
      projectId,
      gameVersion,
      loader,
      apiKey: options.apiKey,
      signal,
    });
    initial = result.versions.find((item) => item.file && item.file.url) || null;
  }
  if (!initial) {
    const error = new Error('该模组没有适用于当前版本/加载器的文件');
    error.code = 'NO_VERSION';
    throw error;
  }

  const { plan, warnings } = await resolvePlan(initial, {
    gameVersion,
    loader,
    signal,
    apiKey: options.apiKey,
    onProgress: null,
  });
  const present = installedFilenames(target);
  const nodes = plan.map((item) => {
    const key = item.version.projectId || item.version.id;
    const filename = item.file.filename || '';
    return {
      key,
      projectId: item.version.projectId || '',
      versionId: item.version.id,
      name: item.version.name || item.version.versionNumber || filename || key,
      versionNumber: item.version.versionNumber || '',
      filename,
      size: item.file.size || 0,
      required: Boolean(item.required),
      depth: item.depth || 0,
      parentKey: item.parentKey || null,
      parentName: item.parentName || '',
      optional: false,
      installed: filename ? present.has(filename.toLowerCase()) : false,
    };
  });
  const keys = new Set(nodes.map((node) => node.key));
  const edges = nodes
    .filter((node) => node.parentKey && keys.has(node.parentKey))
    .map((node) => ({ from: node.parentKey, to: node.key, required: node.required }));

  return {
    source: 'CurseForge',
    projectId,
    title: cleanText(options.title || initial.name || projectId, 180),
    targetVersionId: target.id,
    gameVersion,
    loader,
    rootKey: initial.projectId || initial.id,
    root: {
      key: initial.projectId || initial.id,
      projectId: initial.projectId || projectId,
      versionId: initial.id,
      name: initial.name || initial.versionNumber || projectId,
      filename: initial.file && initial.file.filename ? initial.file.filename : '',
      installed: Boolean(initial.file && initial.file.filename && present.has(initial.file.filename.toLowerCase())),
    },
    nodes,
    edges,
    warnings,
    requiredCount: nodes.filter((node) => node.required).length,
    optionalCount: 0,
    missingCount: nodes.filter((node) => !node.installed).length,
    totalBytes: nodes.reduce((sum, node) => sum + (node.size || 0), 0),
  };
}

function prepareModsDir(target) {
  let modsDir = path.join(target.gameDir, 'mods');
  let portable = false;
  const writable = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.minepilot-mod-${process.pid}-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.unlinkSync(probe);
    } catch (err) {
      try { fs.unlinkSync(probe); } catch (e) { /* ignore */ }
      throw err;
    }
  };
  try {
    writable(modsDir);
  } catch (err) {
    const fallbackRoot = path.join(config.root(), 'game', String(target.id || 'default'));
    modsDir = path.join(fallbackRoot, 'mods');
    try {
      writable(modsDir);
      portable = true;
    } catch (fallbackError) {
      const error = new Error(`无法创建模组目录：${modsDir}（${fallbackError.code || fallbackError.message}）`);
      error.code = 'MOD_INSTALL_DENIED';
      throw error;
    }
  }
  return { modsDir, portable };
}

async function install(options = {}) {
  const target = options.target || {};
  if (!target.id || !target.gameDir) {
    const error = new Error('没有找到要安装模组的目标版本');
    error.code = 'NO_TARGET';
    throw error;
  }

  const key = getKey(options);
  const projectId = validateModId(options.projectId);
  const gameVersion = cleanText(options.gameVersion || target.mcVersion, 40).trim();
  const loader = normalizeLoader(options.loader || loaderForVersion(target));
  const signal = options.signal || null;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  let initial = null;
  if (options.versionId) {
    initial = await getFile({
      projectId,
      versionId: options.versionId,
      apiKey: key,
      signal,
    });
  } else {
    const result = await getVersions({
      projectId,
      gameVersion,
      loader,
      apiKey: key,
      signal,
    });
    initial = result.versions.find((item) => item.file && item.file.url) || result.versions[0] || null;
  }
  if (!initial) {
    const error = new Error('该模组没有适用于当前版本/加载器的文件');
    error.code = 'NO_VERSION';
    throw error;
  }

  if (onProgress) {
    onProgress({ phase: 'resolve', message: `正在解析 ${initial.name || projectId}…` });
  }
  const { plan, warnings } = await resolvePlan(initial, {
    gameVersion,
    loader,
    apiKey: key,
    signal,
    onProgress,
  });

  const { modsDir, portable } = prepareModsDir(target);
  const totalBytes = plan.reduce((sum, item) => sum + (item.file.size || 0), 0);
  let doneBytes = 0;
  let lastEmit = 0;
  const installed = [];
  const skipped = [];
  const emit = (payload) => {
    if (!onProgress) return;
    const now = Date.now();
    if (payload.phase !== 'download' || now - lastEmit > 120 || payload.percent >= 100) {
      lastEmit = now;
      onProgress(payload);
    }
  };

  for (let index = 0; index < plan.length; index += 1) {
    if (signal && signal.aborted) throw new Error('已取消');
    const item = plan[index];
    const filename = safeFilename(item.file.filename || `${projectId}-${item.version.versionNumber}.jar`);
    const destination = path.join(modsDir, filename);
    const fileBase = doneBytes;
    let received = 0;

    emit({
      phase: 'download',
      message: `正在下载 ${filename}`,
      file: filename,
      index: index + 1,
      total: plan.length,
      percent: totalBytes ? Math.floor((fileBase / totalBytes) * 100) : 0,
      received: 0,
      bytes: item.file.size || 0,
      sizeText: formatBytes(item.file.size || 0),
    });

    try {
      const result = await net.downloadFile(item.file.url, destination, {
        sha1: item.file.sha1 || null,
        signal,
        retries: 3,
        onBytes: (bytes) => {
          received += bytes;
          const percent = totalBytes
            ? Math.min(99, Math.floor(((fileBase + received) / totalBytes) * 100))
            : 0;
          emit({
            phase: 'download',
            message: `正在下载 ${filename}`,
            file: filename,
            index: index + 1,
            total: plan.length,
            percent,
            received: fileBase + received,
            bytes: totalBytes,
            sizeText: formatBytes(totalBytes),
          });
        },
      });
      const entry = {
        projectId: item.version.projectId || projectId,
        versionId: item.version.id,
        name: item.version.name || filename,
        filename,
        size: result.size || item.file.size || 0,
        path: destination,
        skipped: Boolean(result.skipped),
      };
      if (result.skipped) skipped.push(entry);
      else installed.push(entry);
    } catch (err) {
      if (signal && signal.aborted) throw new Error('已取消');
      err.message = `下载 ${filename} 失败：${err.message}`;
      throw err;
    }
    doneBytes = fileBase + (item.file.size || received);
  }

  emit({
    phase: 'done',
    message: `已安装 ${installed.length + skipped.length} 个文件`,
    percent: 100,
    received: totalBytes,
    bytes: totalBytes,
  });

  logger.info('CurseForge 模组安装完成:', projectId, '目录:', modsDir, '文件:', installed.length + skipped.length);
  return {
    ok: true,
    source: 'CurseForge',
    projectId,
    targetVersionId: target.id || '',
    gameVersion,
    loader,
    modsDir,
    portable,
    installed,
    skipped,
    warnings,
    count: installed.length + skipped.length,
  };
}

module.exports = {
  search,
  getVersions,
  getCategories,
  install,
  preview,
  loaderForVersion,
  normalizeLoader,
  formatBytes,
};