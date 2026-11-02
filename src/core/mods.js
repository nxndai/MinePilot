'use strict';

/**
 * Modrinth 模组搜索与安装。
 *
 * 只使用 Modrinth 官方公开 API；不抓取 CurseForge，也不内置第三方下载站。
 * 安装时会读取版本依赖，自动补齐 required 前置模组。
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const net = require('./net');
const logger = require('./logger');
const curseforge = require('./curseforge');

const API = 'https://api.modrinth.com/v2';
const LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt']);
// 这些是服务端插件/数据包平台。客户端实例的 mods 目录不能加载它们，
// 不能因为项目同时发布了 Paper/Spigot 文件就被“最新版本”选中。
const SERVER_ONLY_LOADERS = new Set(['paper', 'spigot', 'bukkit', 'folia', 'purpur', 'velocity', 'bungeecord', 'waterfall', 'datapack']);
const SEARCH_TTL = 120000;
const VERSION_TTL = 120000;
const cache = new Map();

const CATEGORIES = [
  { id: 'utility', slug: 'utility', name: 'utility', label: '功能' },
  { id: 'optimization', slug: 'optimization', name: 'optimization', label: '优化' },
  { id: 'technology', slug: 'technology', name: 'technology', label: '科技' },
  { id: 'magic', slug: 'magic', name: 'magic', label: '魔法' },
  { id: 'adventure', slug: 'adventure', name: 'adventure', label: '冒险' },
  { id: 'decoration', slug: 'decoration', name: 'decoration', label: '装饰' },
  { id: 'worldgen', slug: 'worldgen', name: 'worldgen', label: '世界生成' },
  { id: 'library', slug: 'library', name: 'library', label: '库/API' },
  { id: 'storage', slug: 'storage', name: 'storage', label: '存储' },
  { id: 'equipment', slug: 'equipment', name: 'equipment', label: '装备' },
  { id: 'mobs', slug: 'mobs', name: 'mobs', label: '生物' },
  { id: 'transportation', slug: 'transportation', name: 'transportation', label: '运输' },
  { id: 'food', slug: 'food', name: 'food', label: '食物' },
  { id: 'game-mechanics', slug: 'game-mechanics', name: 'game-mechanics', label: '游戏机制' },
  { id: 'management', slug: 'management', name: 'management', label: '管理' },
  { id: 'minigame', slug: 'minigame', name: 'minigame', label: '小游戏' },
  { id: 'social', slug: 'social', name: 'social', label: '社交' },
];

const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((item) => [item.id, item.label]));

function normalizeLoader(value) {
  const loader = String(value || '').toLowerCase();
  return LOADERS.has(loader) ? loader : '';
}

function loaderForVersion(version) {
  const list = version && Array.isArray(version.loaders) ? version.loaders : [];
  const found = list.find((item) => item && LOADERS.has(item.key));
  return found ? found.key : '';
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max || 500);
}

function versionLoaders(version) {
  return (version && Array.isArray(version.loaders) ? version.loaders : [])
    .map((item) => String(item || '').toLowerCase())
    .filter(Boolean);
}

function isClientVersion(version) {
  const loaders = versionLoaders(version);
  if (!loaders.length) return true;
  return loaders.some((loader) => LOADERS.has(loader))
    && !loaders.every((loader) => SERVER_ONLY_LOADERS.has(loader));
}

function clientSideRank(value) {
  // 只把纯服务端项目沉底，保留 Modrinth 的相关度/下载量顺序；不要因为
  // “客户端必需”就把 Hotkey 之类的附属模组排到主模组前面。
  return value === 'unsupported' ? 1 : 0;
}

function validateId(value, label) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    const error = new Error(`${label || '项目'} ID 不合法`);
    error.code = 'BAD_PROJECT';
    throw error;
  }
  return id;
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

async function getJson(url, signal) {
  return net.fetchJson(url, { signal, timeout: 20000, retries: 2 });
}

function primaryFile(files) {
  const list = Array.isArray(files) ? files : [];
  return list.find((file) => file && file.primary) || list[0] || null;
}

function mapVersion(raw) {
  if (!raw || !raw.id) return null;
  const file = primaryFile(raw.files);
  return {
    id: String(raw.id),
    projectId: String(raw.project_id || ''),
    name: cleanText(raw.name, 180),
    versionNumber: cleanText(raw.version_number, 100),
    versionType: raw.version_type || 'release',
    gameVersions: Array.isArray(raw.game_versions) ? raw.game_versions.slice(0, 30) : [],
    loaders: Array.isArray(raw.loaders) ? raw.loaders.slice(0, 10) : [],
    datePublished: raw.date_published || '',
    downloads: Number(raw.downloads) || 0,
    file: file ? {
      filename: cleanText(file.filename, 240),
      url: String(file.url || ''),
      size: Number(file.size) || 0,
      sha1: file.hashes && file.hashes.sha1 ? String(file.hashes.sha1) : '',
      primary: Boolean(file.primary),
    } : null,
    dependencies: (Array.isArray(raw.dependencies) ? raw.dependencies : []).map((dep) => ({
      versionId: dep.version_id ? String(dep.version_id) : '',
      projectId: dep.project_id ? String(dep.project_id) : '',
      dependencyType: dep.dependency_type || 'required',
    })),
  };
}

async function search(options = {}) {
  const query = cleanText(options.query, 120).trim();
  const gameVersion = cleanText(options.gameVersion, 40).trim();
  const loader = normalizeLoader(options.loader);
  const category = cleanText(options.category, 40).trim();
  const projectType = ['mod', 'resourcepack', 'shader', 'datapack', 'modpack'].includes(String(options.projectType || ''))
    ? String(options.projectType)
    : 'mod';
  const limit = Math.max(1, Math.min(30, Number(options.limit) || 20));
  const offset = Math.max(0, Math.min(1000, Number(options.offset) || 0));

  const facets = [[`project_type:${projectType}`]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  // 资源包 / 光影 / 数据包不使用 Fabric/Forge 加载器分类，避免把结果过滤空。
  if (projectType === 'mod' && loader) facets.push([`categories:${loader}`]);
  if (/^[a-z0-9-]+$/.test(category)) facets.push([`categories:${category}`]);

  const params = new URLSearchParams({
    query,
    limit: String(limit),
    offset: String(offset),
    index: query ? 'relevance' : 'downloads',
    facets: JSON.stringify(facets),
  });
  const key = `search:${params.toString()}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const data = await getJson(`${API}/search?${params.toString()}`);
  const hits = (Array.isArray(data.hits) ? data.hits : []).map((hit) => ({
    source: 'Modrinth',
    projectId: String(hit.project_id || ''),
    projectType: cleanText(hit.project_type, 20) || projectType,
    slug: cleanText(hit.slug, 100),
    title: cleanText(hit.title, 160),
    description: cleanText(hit.description, 500),
    author: cleanText(hit.author, 100),
    iconUrl: String(hit.icon_url || ''),
    downloads: Number(hit.downloads) || 0,
    follows: Number(hit.follows) || 0,
    categories: Array.isArray(hit.categories)
      ? hit.categories.slice(0, 12).map((item) => CATEGORY_LABELS[item] || item)
      : [],
    versions: Array.isArray(hit.versions) ? hit.versions.slice(-8) : [],
    dateModified: hit.date_modified || '',
    latestVersion: String(hit.latest_version || ''),
    license: cleanText(hit.license, 80),
    clientSide: cleanText(hit.client_side, 20) || 'unknown',
    serverSide: cleanText(hit.server_side, 20) || 'unknown',
    externalUrl: `https://modrinth.com/${cleanText(hit.project_type, 20) || projectType}/${encodeURIComponent(cleanText(hit.slug, 100) || String(hit.project_id || ''))}`,
    installable: true,
  })).filter((hit) => hit.projectId);

  // 搜索结果里把纯客户端/客户端可选的项目排在前面；纯服务端插件仍然保留，
  // 但会在卡片上标记，并禁止安装到客户端实例。
  hits.sort((a, b) => clientSideRank(a.clientSide) - clientSideRank(b.clientSide));

  const result = {
    source: 'Modrinth',
    totalHits: Number(data.total_hits) || hits.length,
    offset,
    limit,
    query,
    gameVersion,
    loader,
    projectType,
    category,
    hits,
  };
  cacheSet(key, result, SEARCH_TTL);
  return result;
}

async function getVersions(options = {}) {
  const projectId = validateId(options.projectId, '项目');
  const gameVersion = cleanText(options.gameVersion, 40).trim();
  const loader = normalizeLoader(options.loader);
  // 没有加载器时也必须只返回客户端可用的文件，避免把 Paper 插件下载到 mods。
  const clientOnly = options.clientOnly === true || !loader;
  const key = `versions:${projectId}:${gameVersion}:${loader}:${clientOnly ? 'client' : 'any'}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const params = new URLSearchParams();
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
  if (loader) params.set('loaders', JSON.stringify([loader]));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const raw = await getJson(`${API}/project/${encodeURIComponent(projectId)}/version${suffix}`);
  const versions = (Array.isArray(raw) ? raw : [])
    .map(mapVersion)
    .filter(Boolean)
    .filter((version) => (loader
      ? versionLoaders(version).includes(loader)
      : (!clientOnly || isClientVersion(version))))
    .sort((a, b) => String(b.datePublished).localeCompare(String(a.datePublished)));

  const result = { source: 'Modrinth', projectId, gameVersion, loader, versions };
  cacheSet(key, result, VERSION_TTL);
  return result;
}

async function getVersion(versionId) {
  const id = validateId(versionId, '版本');
  const key = `version:${id}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const raw = await getJson(`${API}/version/${encodeURIComponent(id)}`);
  const version = mapVersion(raw);
  if (!version) {
    const error = new Error('Modrinth 没有返回有效的版本文件');
    error.code = 'NO_VERSION';
    throw error;
  }
  cacheSet(key, version, VERSION_TTL);
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
      const text = `${version.name || version.versionNumber || version.id} 没有可下载文件`;
      if (task.required) warnings.push(text);
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
      if (dep.dependencyType !== 'required') continue;
      if (onProgress) {
        onProgress({
          phase: 'resolve',
          message: `正在解析前置：${dep.projectId || dep.versionId || '未知项目'}`,
          current: plan.length,
        });
      }
      try {
        let dependencyVersion = null;
        if (dep.versionId) {
          dependencyVersion = await getVersion(dep.versionId);
        } else if (dep.projectId) {
          const result = await getVersions({
            projectId: dep.projectId,
            gameVersion,
            loader,
            clientOnly: !loader,
          });
          dependencyVersion = result.versions[0] || null;
        }
        if (!dependencyVersion) {
          warnings.push(`找不到必需前置 ${dep.projectId || dep.versionId} 的兼容版本`);
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
        warnings.push(`前置 ${dep.projectId || dep.versionId} 解析失败：${err.message}`);
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
 * 只解析依赖，不下载文件。供安装前的“依赖检查”界面展示依赖树。
 */
async function previewDependencies(options = {}) {
  const target = options.target || {};
  if (!target.id || !target.gameDir) {
    const error = new Error('没有找到要检查依赖的目标版本');
    error.code = 'NO_TARGET';
    throw error;
  }
  const projectId = validateId(options.projectId, '项目');
  const gameVersion = cleanText(options.gameVersion || target.mcVersion, 40).trim();
  const loader = normalizeLoader(options.loader || loaderForVersion(target));
  const signal = options.signal || null;

  let initial = null;
  if (options.versionId) {
    initial = await getVersion(options.versionId);
  } else {
    const result = await getVersions({ projectId, gameVersion, loader });
    initial = result.versions.find((item) => item.file && item.file.url) || null;
  }
  if (!initial) {
    const error = new Error('该模组没有适用于当前版本/加载器的文件');
    error.code = 'NO_VERSION';
    throw error;
  }

  const { plan, warnings } = await resolvePlan(initial, { gameVersion, loader, signal, onProgress: null });
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
    source: 'Modrinth',
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
    optionalCount: initial.dependencies.filter((dep) => dep.dependencyType !== 'required').length,
    missingCount: nodes.filter((node) => !node.installed).length,
    totalBytes: nodes.reduce((sum, node) => sum + (node.size || 0), 0),
  };
}

/**
 * 安装模组。target 必须包含 id、gameDir；loader/gameVersion 来自目标版本。
 */
async function install(options = {}) {
  const target = options.target || {};
  if (!target.id || !target.gameDir) {
    const error = new Error('没有找到要安装模组的目标版本');
    error.code = 'NO_TARGET';
    throw error;
  }
  const projectId = validateId(options.projectId, '项目');
  const gameVersion = cleanText(options.gameVersion || target.mcVersion, 40).trim();
  const loader = normalizeLoader(options.loader || loaderForVersion(target));
  const signal = options.signal || null;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  // 没有加载器也允许先下载客户端文件：模组页会明确提示它暂时不会生效，
  // 但不要用“先装加载器”把下载入口彻底锁死。
  let initial = null;
  if (options.versionId) {
    initial = await getVersion(options.versionId);
  } else {
    const result = await getVersions({ projectId, gameVersion, loader, clientOnly: true });
    initial = result.versions[0] || null;
  }
  if (!initial) {
    const error = new Error('该模组没有适用于当前版本/加载器的文件');
    error.code = 'NO_VERSION';
    throw error;
  }
  if (!loader && !isClientVersion(initial)) {
    const error = new Error('该模组只有服务端文件，不能安装到原版客户端的 mods 目录');
    error.code = 'NO_CLIENT_VERSION';
    throw error;
  }

  if (onProgress) {
    onProgress({ phase: 'resolve', message: `正在解析 ${initial.name || projectId}…` });
  }
  const { plan, warnings } = await resolvePlan(initial, { gameVersion, loader, signal, onProgress });

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
    // 与原目录写入被拒绝时保持和启动器一致：退回程序自己的便携数据目录。
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

  logger.info('模组安装完成:', projectId, '目录:', modsDir, '文件:', installed.length + skipped.length);
  return {
    ok: true,
    source: 'Modrinth',
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

async function lookupBySha1(filePath) {
  try {
    const hash = await net.sha1File(filePath);
    if (!hash) return null;
    const raw = await net.fetchJson(`${API}/version_file/${encodeURIComponent(hash)}?algorithm=sha1`, {
      timeout: 20000,
      retries: 1,
    });
    return mapVersion(raw);
  } catch (err) {
    // 404 表示这个 JAR 没有发布到 Modrinth，属于正常情况。
    if (err && (err.status === 404 || /HTTP 404|Not Found/i.test(err.message))) return null;
    throw err;
  }
}

/**
 * 已安装模组更新检查：先用 JAR 的 SHA1 反查 Modrinth 版本，再按当前
 * 游戏版本和加载器拿最新版本。没有发布到 Modrinth 的模组会被跳过。
 */
async function checkUpdates(options = {}) {
  const target = options.target || {};
  const mods = Array.isArray(options.mods) ? options.mods : [];
  const gameVersion = String(options.gameVersion || target.mcVersion || '').trim();
  const loader = normalizeLoader(options.loader || loaderForVersion(target));
  const limit = Math.max(1, Math.min(80, Number(options.limit) || 40));
  const enabled = mods.filter((mod) => mod && mod.enabled && mod.filePath && /\.jar$/i.test(mod.filename || ''));
  const selected = enabled.slice(0, limit);
  const updates = [];
  const errors = [];
  let checked = 0;
  let skipped = 0;

  async function inspectOne(mod) {
    try {
      const current = await lookupBySha1(mod.filePath);
      if (!current) {
        skipped += 1;
        return;
      }
      checked += 1;
      if (!current.projectId) {
        skipped += 1;
        return;
      }
      const result = await getVersions({
        projectId: current.projectId,
        gameVersion,
        loader,
      });
      const latest = result.versions && result.versions[0];
      if (!latest) return;
      const sameVersion = String(latest.versionNumber || '') === String(mod.version || '');
      if (sameVersion || (current.id && latest.id === current.id)) return;
      updates.push({
        filename: mod.filename,
        name: mod.name || mod.filename,
        currentVersion: mod.version || current.versionNumber || '',
        latestVersion: latest.versionNumber || latest.name || '',
        projectId: current.projectId,
        versionId: latest.id,
        downloadUrl: latest.file && latest.file.url ? latest.file.url : '',
        pageUrl: `https://modrinth.com/project/${encodeURIComponent(current.projectId)}`,
        source: 'Modrinth',
      });
    } catch (err) {
      errors.push(`${mod.filename}: ${err.message}`);
    }
  }

  for (let index = 0; index < selected.length; index += 3) {
    await Promise.all(selected.slice(index, index + 3).map(inspectOne));
  }

  updates.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return {
    source: 'Modrinth',
    gameVersion,
    loader,
    checked,
    skipped,
    errors,
    updates,
  };
}

async function dispatchSearch(options = {}) {
  if (options.source === 'curseforge') return curseforge.search(options);
  return search(options);
}

async function dispatchGetVersions(options = {}) {
  if (options.source === 'curseforge') return curseforge.getVersions(options);
  return getVersions(options);
}

async function dispatchInstall(options = {}) {
  if (options.source === 'curseforge') return curseforge.install(options);
  return install(options);
}

async function categories(options = {}) {
  if (options.source === 'curseforge') {
    return curseforge.getCategories(options);
  }
  return { source: 'Modrinth', categories: CATEGORIES };
}

module.exports = {
  search: dispatchSearch,
  getVersions: dispatchGetVersions,
  getVersion,
  install: dispatchInstall,
  dependencies: (options = {}) => (options.source === 'curseforge'
    ? curseforge.preview(options)
    : previewDependencies(options)),
  previewDependencies,
  categories,
  checkUpdates,
  loaderForVersion,
  normalizeLoader,
  formatBytes,
};