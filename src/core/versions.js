'use strict';

const fs = require('fs');
const path = require('path');

const mojang = require('./mojang');
const javaCore = require('./java');
const logger = require('./logger');

const LOADER_PATTERNS = [
  { key: 'fabric', label: 'Fabric', regex: /fabric-loader|fabricmc/i },
  { key: 'quilt', label: 'Quilt', regex: /quilt-loader|quiltmc/i },
  { key: 'neoforge', label: 'NeoForge', regex: /neoforged|neoforge/i },
  { key: 'forge', label: 'Forge', regex: /minecraftforge|forge:/i },
  { key: 'optifine', label: 'OptiFine', regex: /optifine/i },
  { key: 'liteloader', label: 'LiteLoader', regex: /liteloader/i },
];

function readRaw(jsonFile) {
  return mojang.readJson(jsonFile);
}

function exactLoaderVersion(key, name) {
  const parts = String(name || '').split(':');
  const version = parts[2] || '';
  if (key === 'fabric' && /^net\.fabricmc:fabric-loader:/i.test(name)) return version;
  if (key === 'quilt' && /^org\.quiltmc:quilt-loader:/i.test(name)) return version;
  if (key === 'neoforge' && /^net\.neoforged:neoforge:/i.test(name)) return version;
  if (key === 'forge' && /^net\.minecraftforge:forge:/i.test(name)) return version.replace(/^\d+\.\d+(?:\.\d+)?-/, '');
  if (key === 'forge' && /^net\.minecraftforge:fmlloader:/i.test(name)) return version.replace(/^\d+\.\d+(?:\.\d+)?-/, '');
  return '';
}

function loaderVersionFromId(key, id) {
  if (key !== 'forge' && key !== 'neoforge') return '';
  const pattern = key === 'neoforge' ? /(?:neoforge)[-_ ]?([0-9][^_ ]*)$/i : /(?:forge)[-_ ]?([0-9][^_ ]*)$/i;
  const match = String(id || '').match(pattern);
  return match ? match[1] : '';
}

function detectLoaders(rawList) {
  const found = new Map();
  for (const raw of rawList) {
    const libraries = Array.isArray(raw.libraries) ? raw.libraries : [];
    const names = libraries.map((lib) => String(lib.name || ''));

    // 先找加载器本体的精确坐标。Forge 的依赖里还有 accesstransformers 等
    // 同样带 "forge" 的库，先匹配它们会把 8.0.4 当成加载器版本。
    for (const pattern of LOADER_PATTERNS) {
      if (found.has(pattern.key)) continue;
      const exact = names.find((name) => exactLoaderVersion(pattern.key, name));
      if (!exact) continue;
      found.set(pattern.key, {
        key: pattern.key,
        name: pattern.label,
        version: exactLoaderVersion(pattern.key, exact),
      });
    }

    for (const lib of libraries) {
      const name = String(lib.name || '');
      for (const pattern of LOADER_PATTERNS) {
        if (found.has(pattern.key) || !pattern.regex.test(name)) continue;
        // NeoForge 1.20.1 的坐标是 net.neoforged:forge，不能再算成普通 Forge。
        if (pattern.key === 'forge' && /neoforged/i.test(name)) continue;
        const parts = name.split(':');
        found.set(pattern.key, {
          key: pattern.key,
          name: pattern.label,
          version: exactLoaderVersion(pattern.key, name) || parts[2] || '',
        });
      }
    }
    const mainClass = String(raw.mainClass || '');
    for (const pattern of LOADER_PATTERNS) {
      if (found.has(pattern.key) || !pattern.regex.test(mainClass)) continue;
      found.set(pattern.key, { key: pattern.key, name: pattern.label, version: '' });
    }
  }
  // NeoForge 会同时带 net.neoforged 和 net.minecraftforge 两组依赖，
  // 检测到 NeoForge 时不应再显示成“Forge + NeoForge”两个加载器。
  if (found.has('neoforge')) found.delete('forge');
  // Forge / NeoForge 的依赖里有很多同组件的不同版本号；优先从版本 ID
  // （例如 1.20.1-Forge_47.4.16）还原真正的加载器版本。
  const primaryId = rawList[0] && rawList[0].id ? rawList[0].id : '';
  for (const key of ['forge', 'neoforge']) {
    const hit = found.get(key);
    if (!hit) continue;
    const fromId = loaderVersionFromId(key, primaryId);
    if (fromId) hit.version = fromId;
  }
  const order = ['fabric', 'quilt', 'neoforge', 'forge', 'liteloader', 'optifine'];
  return order.filter((key) => found.has(key)).map((key) => found.get(key));
}

function countMods(gameDir) {
  const dir = path.join(gameDir, 'mods');
  try {
    const files = fs.readdirSync(dir).filter((name) => /\.jar(\.disabled)?$/i.test(name));
    return { count: files.length, dir };
  } catch (err) {
    return { count: 0, dir };
  }
}

/**
 * 版本隔离：游戏运行目录放到 versions/<id>/，版本 JSON、libraries、
 * assets 仍由基础游戏目录提供。这样每个版本有独立的 mods/saves/options。
 */
/**
 * 读取版本目录里的 MinePilot 标记。整合包导入的实例会强制隔离，
 * 即使全局没有开启版本隔离，也不会把不同整合包混在同一个 mods 目录。
 */
function readMarker(gameDir, versionId) {
  try {
    const folder = mojang.versionFolder(gameDir, versionId);
    const file = path.join(folder, '.minepilot.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function isolateFor(gameDir, versionId, globalIsolation) {
  if (globalIsolation) return true;
  const marker = readMarker(gameDir, versionId);
  return Boolean(marker && marker.isolated);
}

function gameDirFor(gameDir, versionId, isolation) {
  if (!isolation || !versionId) return gameDir;
  const id = String(versionId);
  if (id === '.' || id === '..' || id.includes('/') || id.includes('\\')) return gameDir;
  return path.join(gameDir, 'versions', id);
}

/**
 * 实际游戏数据目录。gameDataDir 是“便携数据根目录”，优先级高于 gameDir；
 * 这样游戏和模组安装会落在同一个可写位置。
 */
function effectiveDir(gameDir, versionId, isolation, gameDataDir) {
  if (gameDataDir) {
    const root = path.resolve(String(gameDataDir));
    if (!isolation || !versionId) return root;
    const id = String(versionId);
    if (id === '.' || id === '..' || id.includes('/') || id.includes('\\')) return root;
    return path.join(root, id);
  }
  return gameDirFor(gameDir, versionId, isolation);
}

function loadChain(gameDir, id) {
  const chain = [];
  let current = id;
  const seen = new Set();
  for (let depth = 0; depth < 6; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const file = mojang.findVersionJson(gameDir, current);
    if (!file) break;
    let raw;
    try {
      raw = readRaw(file);
    } catch (err) {
      logger.warn('读取版本配置失败:', file, err.message);
      break;
    }
    raw.id = raw.id || current;
    chain.push(raw);
    if (!raw.inheritsFrom) break;
    current = raw.inheritsFrom;
  }
  return chain;
}

async function listVersions(gameDir, lastPlayed = {}, isolation = false, gameDataDir = '') {
  const versionsDir = path.join(gameDir, 'versions');
  let entries = [];
  try {
    entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  } catch (err) {
    return [];
  }

  const rows = [];
  for (const entry of entries) {
    let id = entry.name;
    let jsonFile = null;

    if (entry.isDirectory()) {
      jsonFile = mojang.findVersionJson(gameDir, id);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      id = entry.name.replace(/\.json$/i, '');
      jsonFile = path.join(versionsDir, entry.name);
    }
    if (!jsonFile || !fs.existsSync(jsonFile)) continue;

    const chain = loadChain(gameDir, id);
    if (!chain.length) continue;
    const raw = chain[0];
    const root = chain[chain.length - 1];
    const isolated = isolateFor(gameDir, id, isolation);
    const effectiveGameDir = effectiveDir(gameDir, id, isolated, gameDataDir);
    const loaders = detectLoaders(chain);
    // 有些 Forge/NeoForge 安装器生成的版本不写 inheritsFrom，只把
    // Minecraft 版本拼在 ID 前面（例如 1.20.1-Forge_47.4.16）。
    // 这里从 ID 前缀还原真实游戏版本，模组筛选和 Java 判断才正确。
    let mcVersion = root.id || id;
    if (!raw.inheritsFrom) {
      const prefix = String(id).match(/^(\d+\.\d+(?:\.\d+)?)(?:[-_]|$)/);
      if (prefix) {
        mcVersion = prefix[1];
      } else if (mcVersion === id) {
        // 整合包/加载器版本可能完全自定义 ID，只能从 fmlloader 等
        // 依赖的版本号里找 Minecraft 版本，例如 1.20.1-47.3.22。
        for (const entry of chain) {
          for (const lib of entry.libraries || []) {
            const match = String(lib.name || '').match(/(?:fmlloader|forge|neoforge):(\d+\.\d+(?:\.\d+)?)[-+]/);
            if (match) {
              mcVersion = match[1];
              break;
            }
          }
          if (mcVersion !== id) break;
        }
      }
    }
    const meta = {
      id,
      mcVersion,
      type: raw.type || root.type || 'release',
      loaders,
      mods: countMods(effectiveGameDir),
      lastPlayed: lastPlayed[id] || 0,
      installedAt: fs.statSync(jsonFile).mtimeMs,
      javaMajor: raw.javaVersion && raw.javaVersion.majorVersion
        ? raw.javaVersion.majorVersion
        : (root.javaVersion && root.javaVersion.majorVersion) || 0,
      inheritsFrom: raw.inheritsFrom || '',
      jarId: raw.jar || (chain.length > 1 ? root.id : id),
      folder: entry.isDirectory() ? path.join(versionsDir, id) : versionsDir,
      gameDir: effectiveGameDir,
      isolation: isolated,
      hasClientJar: false,
      incomplete: false,
    };

    const jarPath = path.join(gameDir, 'versions', meta.jarId, `${meta.jarId}.jar`);
    meta.hasClientJar = fs.existsSync(jarPath);
    meta.incomplete = !meta.hasClientJar;
    meta.requiredJava = javaCore.requiredJava(meta.mcVersion, meta.javaMajor);
    rows.push(meta);
  }

  rows.sort((a, b) => (b.lastPlayed || b.installedAt) - (a.lastPlayed || a.installedAt));
  return rows;
}

function deleteVersion(gameDir, versionId) {
  const base = path.resolve(gameDir, 'versions');
  const folder = path.resolve(mojang.versionFolder(gameDir, versionId));
  const relative = path.relative(base, folder);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('非法的版本路径');
  }
  fs.rmSync(folder, { recursive: true, force: true });
  logger.info('已删除版本:', versionId);
}

module.exports = { listVersions, deleteVersion, detectLoaders, countMods, gameDirFor, effectiveDir, isolateFor, readMarker };