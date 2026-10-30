'use strict';

const fs = require('fs');
const path = require('path');

const os = require('os');

const config = require('./config');
const net = require('./net');
const logger = require('./logger');
const platform = require('./platform');

const MANIFEST_URLS = [
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
  'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
];
const MANIFEST_TTL = 10 * 60 * 1000;

const DEFAULT_FEATURES = {
  is_demo_user: false,
  has_custom_resolution: true,
  has_quick_plays_support: false,
  is_quick_play_singleplayer: false,
  is_quick_play_multiplayer: false,
  is_quick_play_realms: false,
};

function cacheFile() {
  return path.join(config.cacheDir(), 'version_manifest_v2.json');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function getManifest(force = false, source = 'auto') {
  const file = cacheFile();
  if (!force && fs.existsSync(file)) {
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs < MANIFEST_TTL) return readJson(file);
    } catch (err) {
      /* 缓存损坏则重新获取 */
    }
  }

  const officialUrls = MANIFEST_URLS.filter((url) => !url.includes('bmclapi'));
  const mirrorUrlList = MANIFEST_URLS.filter((url) => url.includes('bmclapi'));
  const urls = source === 'official'
    ? officialUrls
    : source === 'bmclapi'
      ? [...mirrorUrlList, ...officialUrls]
      : MANIFEST_URLS;

  let lastError = null;
  for (const url of urls) {
    try {
      const data = await net.fetchJson(url, { timeout: 30000 });
      if (!data || !Array.isArray(data.versions)) throw new Error('版本列表格式不正确');
      fs.writeFileSync(file, JSON.stringify(data), 'utf8');
      logger.info('已更新版本列表，共', data.versions.length, '个版本');
      return data;
    } catch (err) {
      lastError = err;
      logger.warn('获取版本列表失败:', url, err.message);
    }
  }

  if (fs.existsSync(file)) {
    logger.warn('使用本地缓存的版本列表（可能已过期）');
    return readJson(file);
  }
  throw new Error(`无法获取 Minecraft 版本列表：${lastError ? lastError.message : '网络错误'}`);
}

async function fetchVersionJson(entry, source = 'auto') {
  const mirrored = `https://bmclapi2.bangbang93.com/version/${encodeURIComponent(entry.id)}/json`;
  const urls = source === 'official'
    ? [entry.url]
    : source === 'bmclapi'
      ? [mirrored, entry.url]
      : [entry.url, mirrored];
  let lastError = null;
  for (const url of urls) {
    try {
      return await net.fetchJson(url, { timeout: 30000 });
    } catch (err) {
      lastError = err;
      logger.warn('版本信息获取失败:', url, err.message);
    }
  }
  throw lastError || new Error('版本信息获取失败');
}

function libPathFromName(name) {
  const parts = String(name).split(':');
  const group = parts[0];
  const artifact = parts[1];
  const version = parts[2];
  const classifier = parts[3];
  if (!group || !artifact || !version) return null;
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

function normalizeLibrary(raw) {
  const downloads = raw.downloads || {};
  let artifact = null;
  if (downloads.artifact && downloads.artifact.url) {
    artifact = {
      url: downloads.artifact.url,
      sha1: downloads.artifact.sha1 || '',
      size: downloads.artifact.size || 0,
      path: downloads.artifact.path || libPathFromName(raw.name),
    };
  } else if (raw.name) {
    // Fabric 等加载器的版本 JSON 只给 Maven 根地址和坐标。
    const relative = libPathFromName(raw.name);
    let base = raw.url ? String(raw.url) : '';
    if (!base && /^net\.fabricmc:/i.test(String(raw.name))) {
      base = 'https://maven.fabricmc.net/';
    }
    if (!base && /^org\.quiltmc:/i.test(String(raw.name))) {
      base = 'https://maven.quiltmc.org/repository/release/';
    }
    if (relative && base) {
      if (!base.endsWith('/')) base += '/';
      try {
        artifact = {
          url: new URL(relative, base).toString(),
          sha1: '',
          size: 0,
          path: relative,
        };
      } catch (err) {
        artifact = null;
      }
    }
  }
  const classifiers = {};
  for (const [key, value] of Object.entries(downloads.classifiers || {})) {
    if (!value || !value.url) continue;
    const basePath = libPathFromName(raw.name);
    const classifierPath = basePath ? basePath.replace(/-([^/-]+)\.jar$/, `-${key}.jar`) : null;
    classifiers[key] = {
      url: value.url,
      sha1: value.sha1 || '',
      size: value.size || 0,
      path: value.path || classifierPath,
    };
  }
  return {
    name: raw.name || '',
    rules: raw.rules || null,
    natives: raw.natives || null,
    extract: raw.extract || null,
    artifact,
    classifiers,
  };
}

function normalizeVersion(raw, fallbackId) {
  const args = raw.arguments || {};
  return {
    id: raw.id || fallbackId,
    type: raw.type || 'release',
    mainClass: raw.mainClass || '',
    assets: raw.assets || '',
    assetIndex: raw.assetIndex || null,
    inheritsFrom: raw.inheritsFrom || '',
    jar: raw.jar || '',
    jarId: raw.jar || '',
    libraries: Array.isArray(raw.libraries) ? raw.libraries.map(normalizeLibrary) : [],
    gameArgs: Array.isArray(args.game) ? args.game.map(copyArgNode) : [],
    jvmArgs: Array.isArray(args.jvm) ? args.jvm.map(copyArgNode) : [],
    legacyArgs: typeof raw.minecraftArguments === 'string' ? raw.minecraftArguments : '',
    javaMajor: raw.javaVersion && raw.javaVersion.majorVersion ? raw.javaVersion.majorVersion : 0,
    releaseTime: raw.releaseTime || raw.time || '',
    downloads: {
      client: raw.downloads && raw.downloads.client ? copyDownload(raw.downloads.client) : null,
    },
    logging: raw.logging && raw.logging.client ? {
      argument: raw.logging.client.argument || '',
      file: raw.logging.client.file ? copyDownload(raw.logging.client.file) : null,
      type: raw.logging.client.type || '',
    } : null,
    complianceLevel: raw.complianceLevel || 0,
  };
}

function copyArgNode(node) {
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object') {
    return {
      rules: node.rules || null,
      value: Array.isArray(node.value) ? node.value.slice() : node.value,
    };
  }
  return null;
}

function copyDownload(item) {
  return {
    url: item.url,
    sha1: item.sha1 || '',
    size: item.size || 0,
    path: item.path || '',
    id: item.id || (item.path ? path.basename(item.path) : ''),
  };
}

function normalizedOsName(value) {
  const name = String(value || '').toLowerCase();
  return name === 'macos' || name === 'mac' ? 'osx' : name;
}

function systemVersion() {
  if (typeof process.getSystemVersion === 'function') {
    try { return String(process.getSystemVersion()); } catch (err) { /* ignore */ }
  }
  return String(os.release() || '');
}

function ruleMatches(rule, features) {
  if (!rule || typeof rule !== 'object') return false;
  if (rule.os) {
    if (rule.os.name && normalizedOsName(rule.os.name) !== normalizedOsName(platform.name())) return false;
    if (rule.os.arch) {
      const archMap = { x64: ['x64', 'x86_64', 'amd64'], ia32: ['x86', 'i386'], arm64: ['arm64', 'aarch64'] };
      const allowed = archMap[process.arch] || [process.arch];
      if (!allowed.includes(String(rule.os.arch).toLowerCase())) return false;
    }
    if (rule.os.version) {
      try {
        if (!new RegExp(rule.os.version).test(systemVersion())) return false;
      } catch (err) {
        /* 忽略无法解析的版本规则 */
      }
    }
  }
  if (rule.features) {
    for (const [key, expected] of Object.entries(rule.features)) {
      if (Boolean(features[key]) !== Boolean(expected)) return false;
    }
  }
  return true;
}

function rulesAllow(rules, features) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (ruleMatches(rule, features)) allowed = rule.action === 'allow';
  }
  return allowed;
}

function mergeLibraries(parentLibs, childLibs) {
  const merged = [];
  const indexByName = new Map();
  for (const lib of parentLibs || []) {
    indexByName.set(lib.name, merged.length);
    merged.push(lib);
  }
  for (const lib of childLibs || []) {
    if (indexByName.has(lib.name)) merged[indexByName.get(lib.name)] = lib;
    else {
      indexByName.set(lib.name, merged.length);
      merged.push(lib);
    }
  }
  return merged;
}

function mergeVersions(parent, child) {
  return {
    id: child.id,
    type: child.type || parent.type,
    mainClass: child.mainClass || parent.mainClass,
    assets: child.assets || parent.assets,
    assetIndex: child.assetIndex || parent.assetIndex,
    inheritsFrom: '',
    jar: child.jar || parent.jar,
    jarId: child.jar || parent.jarId,
    libraries: mergeLibraries(parent.libraries, child.libraries),
    gameArgs: parent.gameArgs.concat(child.gameArgs),
    jvmArgs: parent.jvmArgs.concat(child.jvmArgs),
    legacyArgs: child.legacyArgs || parent.legacyArgs,
    javaMajor: child.javaMajor || parent.javaMajor,
    releaseTime: child.releaseTime || parent.releaseTime,
    downloads: { client: child.downloads.client || parent.downloads.client },
    logging: child.logging || parent.logging,
    complianceLevel: child.complianceLevel || parent.complianceLevel,
  };
}

function versionFolder(gameDir, id) {
  return path.join(gameDir, 'versions', id);
}

function findVersionJson(gameDir, id) {
  const folder = versionFolder(gameDir, id);
  const direct = path.join(folder, `${id}.json`);
  if (fs.existsSync(direct)) return direct;
  try {
    const files = fs.readdirSync(folder).filter((name) => name.toLowerCase().endsWith('.json'));
    if (files.length) return path.join(folder, files[0]);
  } catch (err) {
    /* 目录不存在 */
  }
  return null;
}

async function loadVersion(gameDir, id, seen = new Set()) {
  if (seen.has(id)) throw new Error('版本继承关系存在循环');
  seen.add(id);

  const jsonFile = findVersionJson(gameDir, id);
  if (!jsonFile) throw new Error(`未找到版本 ${id} 的配置文件`);

  let raw;
  try {
    raw = readJson(jsonFile);
  } catch (err) {
    throw new Error(`版本 ${id} 的配置文件损坏：${err.message}`);
  }
  raw.id = raw.id || id;

  let meta = normalizeVersion(raw, id);
  meta.id = id;

  if (raw.inheritsFrom) {
    const parent = await loadVersion(gameDir, raw.inheritsFrom, seen);
    meta = mergeVersions(parent, meta);
    meta.id = id;
  } else if (!meta.jarId) {
    meta.jarId = raw.jar || id;
  }

  if (!meta.jarId) meta.jarId = id;
  return meta;
}

function expandArguments(nodes, features) {
  const out = [];
  for (const node of nodes || []) {
    if (typeof node === 'string') {
      out.push(node);
    } else if (node && typeof node === 'object' && node.value != null) {
      if (rulesAllow(node.rules, features)) {
        if (Array.isArray(node.value)) out.push(...node.value.filter((item) => typeof item === 'string'));
        else if (typeof node.value === 'string') out.push(node.value);
      }
    }
  }
  return out;
}

function substitute(value, vars) {
  return String(value).replace(/\$\{([^}]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  ));
}

function splitArgs(input) {
  const result = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(input || ''))) !== null) {
    result.push(match[1] != null ? match[1] : (match[2] != null ? match[2] : match[3]));
  }
  return result;
}

function mirrorUrl(url, source = 'auto') {
  if (!source || source === false || source === 'official' || !url) return url;
  if (url.startsWith('https://libraries.minecraft.net/')) {
    return `https://bmclapi2.bangbang93.com/maven/${url.slice('https://libraries.minecraft.net/'.length)}`;
  }
  if (url.startsWith('https://maven.fabricmc.net/')) {
    return `https://bmclapi2.bangbang93.com/maven/${url.slice('https://maven.fabricmc.net/'.length)}`;
  }
  if (url.startsWith('https://maven.minecraftforge.net/')) {
    return `https://bmclapi2.bangbang93.com/maven/${url.slice('https://maven.minecraftforge.net/'.length)}`;
  }
  if (url.startsWith('https://resources.download.minecraft.net/')) {
    return `https://bmclapi2.bangbang93.com/assets/${url.slice('https://resources.download.minecraft.net/'.length)}`;
  }
  return url;
}

module.exports = {
  DEFAULT_FEATURES,
  getManifest,
  fetchVersionJson,
  loadVersion,
  findVersionJson,
  versionFolder,
  libPathFromName,
  rulesAllow,
  expandArguments,
  substitute,
  splitArgs,
  mirrorUrl,
  readJson,
};