'use strict';

/**
 * 已安装模组的可视化读取与启用/禁用。
 *
 * 禁用模组不移动文件，只把 `xxx.jar` 重命名为 `xxx.jar.disabled`，
 * 这样启动器/游戏不会加载它，用户随时可以勾选恢复。
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const logger = require('./logger');
const zip = require('./zip');

const META_CACHE = new Map();
const META_CACHE_LIMIT = 1500;

function safeId(value) {
  return String(value || 'default').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'default';
}

function modDirs(target) {
  const base = target && target.gameDir ? target.gameDir : '';
  const list = [];
  if (base) list.push({ path: path.join(base, 'mods'), label: '游戏目录', portable: false });
  list.push({
    path: path.join(config.root(), 'game', safeId(target && target.id), 'mods'),
    label: '便携目录',
    portable: true,
  });
  const seen = new Set();
  return list.filter((item) => {
    const resolved = path.resolve(item.path);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    item.path = resolved;
    try {
      return fs.statSync(resolved).isDirectory();
    } catch (err) {
      return false;
    }
  });
}

function isModFile(name) {
  return /\.jar(?:\.disabled)?$/i.test(String(name || ''));
}

function baseJarName(name) {
  return String(name || '').replace(/\.disabled$/i, '');
}

function cleanText(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 120);
}

function unquote(value) {
  const text = String(value == null ? '' : value).trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return text;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function normalizeSide(value) {
  const text = String(value || '').toLowerCase();
  if (text === 'client') return 'client';
  if (text === 'server' || text === 'dedicated_server') return 'server';
  return 'both';
}

function normalizeDependency(raw, type) {
  const id = firstString(raw && (raw.id || raw.modId || raw.module), raw && typeof raw === 'string' ? raw : '');
  if (!id) return null;
  const range = firstString(raw && (raw.versionRange || raw.version || (Array.isArray(raw.versions) ? raw.versions[0] : raw.versions)));
  const explicit = String((raw && raw.type) || '').toLowerCase();
  let kind = type || 'required';
  if (explicit === 'required' || explicit === 'optional') kind = explicit;
  else if (explicit === 'incompatible' || explicit === 'conflict' || explicit === 'breaks') kind = 'conflict';
  return { id, range, type: kind };
}

/**
 * Forge/NeoForge 的 mods.toml 同时包含 [[mods]] 和 [[dependencies.<modid>]]。
 * 这里保留原有的主模组字段解析，并补上依赖、客户端/服务端标记。
 */
function parseToml(text) {
  const lines = String(text || '').split(/\r?\n/);
  let current = null;
  let currentDep = null;
  let section = '';
  const mods = [];
  const dependencies = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/^\s*#.*$/, '').trim();
    if (!line) continue;
    let match = line.match(/^\[\[mods\]\]$/i);
    if (match) {
      current = {};
      currentDep = null;
      section = 'mods';
      mods.push(current);
      continue;
    }
    match = line.match(/^\[\[dependencies\.([^\]]+)\]\]$/i);
    if (match) {
      current = null;
      // `[[dependencies.<ownModId>]]` 的小节名是“声明依赖的模组”，
      // 真正的依赖 id 在下一行的 `modId = "..."` 里，不能把小节名当依赖 id。
      currentDep = {};
      section = 'dependencies';
      dependencies.push(currentDep);
      continue;
    }
    match = line.match(/^\[\[dependencies\]\]$/i);
    if (match) {
      current = null;
      currentDep = {};
      section = 'dependencies';
      dependencies.push(currentDep);
      continue;
    }
    if (/^\[/.test(line)) {
      // 其他 section（mixins、features 等）不影响主模组与依赖解析。
      current = null;
      currentDep = null;
      section = '';
      continue;
    }
    if (section === 'mods' && current) {
      match = line.match(/^(modId|displayName|version|modLoader|description|license|clientSideOnly|serverSideOnly|displayTest)\s*=\s*(.+?)\s*$/);
      if (match) current[match[1]] = unquote(match[2]);
      continue;
    }
    if (section === 'dependencies' && currentDep) {
      match = line.match(/^(modId|mandatory|versionRange|ordering|side|type)\s*=\s*(.+?)\s*$/);
      if (match) currentDep[match[1]] = unquote(match[2]);
    }
  }

  const first = mods[0] || {};
  const parsedDependencies = dependencies
    .map((dep) => normalizeDependency(dep, String(dep.mandatory).toLowerCase() === 'false' ? 'optional' : 'required'))
    .filter(Boolean);
  const side = first.clientSideOnly === 'true'
    ? 'client'
    : first.serverSideOnly === 'true'
      ? 'server'
      : 'both';
  return {
    modId: first.modId || '',
    displayName: first.displayName || '',
    version: first.version || '',
    description: first.description || '',
    license: first.license || '',
    side,
    dependencies: parsedDependencies,
  };
}

function firstString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = typeof value === 'object' ? '' : cleanText(value, 160);
    if (text) return text;
  }
  return '';
}

function readModMeta(file, filename, fallback) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    return fallback;
  }
  const cacheKey = `${path.resolve(file)}|${stat.size}|${stat.mtimeMs}`;
  const cached = META_CACHE.get(cacheKey);
  if (cached) return Object.assign({}, fallback, cached);
  if (META_CACHE.size > META_CACHE_LIMIT) META_CACHE.clear();

  const names = [
    'fabric.mod.json',
    'quilt.mod.json',
    'META-INF/neoforge.mods.toml',
    'META-INF/mods.toml',
    'mcmod.info',
  ];
  let result = {};
  try {
    const entries = zip.readZipEntries(file, names, { maxBytes: 2 * 1024 * 1024 });
    if (entries['fabric.mod.json']) {
      const data = JSON.parse(entries['fabric.mod.json'].toString('utf8'));
      const dependencies = [];
      for (const [id, value] of Object.entries(data.depends || {})) {
        const range = Array.isArray(value) ? value[0] : value;
        dependencies.push({ id, range: firstString(range), type: 'required' });
      }
      for (const [id, value] of Object.entries(data.breaks || data.conflicts || {})) {
        const range = Array.isArray(value) ? value[0] : value;
        dependencies.push({ id, range: firstString(range), type: 'conflict' });
      }
      for (const [id, value] of Object.entries(data.recommends || data.suggests || {})) {
        const range = Array.isArray(value) ? value[0] : value;
        dependencies.push({ id, range: firstString(range), type: 'optional' });
      }
      result = {
        name: firstString(data.name, data.id),
        version: firstString(data.version),
        modId: firstString(data.id),
        loader: 'fabric',
        side: normalizeSide(data.environment),
        provides: asArray(data.provides).map((item) => firstString(item)).filter(Boolean),
        dependencies: dependencies.filter((dep) => dep.id),
      };
    } else if (entries['quilt.mod.json']) {
      const data = JSON.parse(entries['quilt.mod.json'].toString('utf8'));
      const loader = data.quilt_loader || {};
      const metadata = loader.metadata || data.metadata || {};
      const dependencies = [];
      for (const raw of asArray(loader.depends || (loader.quilt_loader && loader.quilt_loader.depends))) {
        const dep = normalizeDependency(raw, 'required');
        if (dep) dependencies.push(dep);
      }
      for (const raw of asArray(loader.breaks || (loader.quilt_loader && loader.quilt_loader.breaks))) {
        const dep = normalizeDependency(raw, 'conflict');
        if (dep) dependencies.push(dep);
      }
      result = {
        name: firstString(metadata.name, loader.id, data.id),
        version: firstString(loader.version, data.version),
        modId: firstString(loader.id),
        loader: 'quilt',
        side: normalizeSide(loader.environment || metadata.environment),
        provides: asArray(loader.provides).map((item) => firstString(item)).filter(Boolean),
        dependencies,
      };
    } else if (entries['META-INF/neoforge.mods.toml'] || entries['META-INF/mods.toml']) {
      const raw = entries['META-INF/neoforge.mods.toml'] || entries['META-INF/mods.toml'];
      const data = parseToml(raw.toString('utf8'));
      if (data) {
        result = {
          name: firstString(data.displayName, data.modId),
          version: firstString(data.version),
          modId: firstString(data.modId),
          loader: entries['META-INF/neoforge.mods.toml'] ? 'neoforge' : 'forge',
          side: data.side || 'both',
          provides: [],
          dependencies: data.dependencies || [],
        };
      }
    } else if (entries['mcmod.info']) {
      const data = JSON.parse(entries['mcmod.info'].toString('utf8'));
      const item = Array.isArray(data) ? data[0] : data && (data.modList || data)[0];
      if (item) {
        result = {
          name: firstString(item.name, item.modid),
          version: firstString(item.version),
          modId: firstString(item.modid),
          loader: 'forge',
          side: 'both',
          provides: [],
          dependencies: [],
        };
      }
    }
  } catch (err) {
    logger.warn('读取模组元数据失败:', filename, err.message);
  }

  const merged = Object.assign({}, fallback, result, {
    name: result.name || fallback.name || filename,
    version: result.version || fallback.version || '',
    modId: result.modId || fallback.modId || '',
    loader: result.loader || fallback.loader || '',
    side: result.side || fallback.side || 'both',
    provides: Array.isArray(result.provides) ? result.provides : (fallback.provides || []),
    dependencies: Array.isArray(result.dependencies) ? result.dependencies : (fallback.dependencies || []),
  });
  META_CACHE.set(cacheKey, merged);
  return Object.assign({}, merged);
}

function fallbackTitle(filename) {
  return cleanText(baseJarName(filename).replace(/\.jar$/i, '').replace(/[-_]+/g, ' '), 180)
    || filename;
}

function list(target) {
  if (!target || !target.id) {
    const error = new Error('请先选择目标版本');
    error.code = 'NO_TARGET';
    throw error;
  }
  const dirs = modDirs(target);
  const mods = [];
  const seen = new Set();

  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir.path);
    } catch (err) {
      continue;
    }
    for (const filename of names.sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
      if (!isModFile(filename)) continue;
      const key = filename.toLowerCase();
      if (seen.has(key)) continue;
      const file = path.join(dir.path, filename);
      let stat;
      try {
        stat = fs.statSync(file);
        if (!stat.isFile()) continue;
      } catch (err) {
        continue;
      }
      seen.add(key);
      const enabled = !/\.disabled$/i.test(filename);
      const fallback = {
        filename,
        filePath: file,
        enabled,
        size: stat.size,
        mtime: stat.mtimeMs,
        name: fallbackTitle(filename),
        version: '',
        modId: '',
        loader: '',
        side: 'both',
        provides: [],
        dependencies: [],
        location: dir.label,
        portable: dir.portable,
      };
      // 只读取元数据，不把 jar 内容解压到磁盘。
      mods.push(readModMeta(file, filename, fallback));
    }
  }

  mods.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  const enabledCount = mods.filter((item) => item.enabled).length;
  return {
    ok: true,
    targetVersionId: target.id,
    dirs: dirs.map((dir) => ({ label: dir.label, portable: dir.portable })),
    mods,
    count: mods.length,
    enabledCount,
    disabledCount: mods.length - enabledCount,
    totalBytes: mods.reduce((sum, item) => sum + (item.size || 0), 0),
    health: healthFromList(mods),
  };
}

function findActualFile(target, filename) {
  const wanted = String(filename || '').toLowerCase();
  for (const dir of modDirs(target)) {
    let names = [];
    try {
      names = fs.readdirSync(dir.path);
    } catch (err) {
      continue;
    }
    const actual = names.find((name) => name.toLowerCase() === wanted);
    if (actual) return { dir, file: path.join(dir.path, actual), filename: actual };
  }
  return null;
}

function setEnabled(target, filename, enabled) {
  if (!target || !target.id) {
    const error = new Error('请先选择目标版本');
    error.code = 'NO_TARGET';
    throw error;
  }
  const name = path.basename(String(filename || ''));
  if (!name || name !== filename || !isModFile(name)) {
    const error = new Error('模组文件名不合法');
    error.code = 'BAD_MOD_FILE';
    throw error;
  }
  const found = findActualFile(target, name);
  if (!found) {
    const error = new Error('找不到该模组文件，请刷新列表');
    error.code = 'MOD_NOT_FOUND';
    throw error;
  }
  const base = baseJarName(found.filename);
  const desired = enabled ? base : `${base}.disabled`;
  if (desired === found.filename) {
    return { changed: false, list: list(target) };
  }
  const destination = path.join(found.dir.path, desired);
  if (fs.existsSync(destination)) {
    const error = new Error(`无法切换：同目录已存在 ${desired}`);
    error.code = 'MOD_NAME_CONFLICT';
    throw error;
  }
  try {
    fs.renameSync(found.file, destination);
  } catch (err) {
    const error = new Error(`无法${enabled ? '启用' : '禁用'} ${found.filename}：${err.message}`);
    error.code = 'MOD_TOGGLE_FAILED';
    throw error;
  }
  logger.info('模组状态切换:', target.id, found.filename, '->', desired);
  return {
    changed: true,
    filename: desired,
    enabled,
    list: list(target),
  };
}

const BUILTIN_DEPENDENCIES = new Set([
  'minecraft', 'java', 'fabricloader', 'fabric-loader', 'fabric',
  'quilt_loader', 'quilt-loader', 'quilt', 'forge', 'neoforge', 'fml',
  'modlauncher', 'securejarhandler', 'bootstraplauncher', 'ashiming',
  'optifine', 'mcp', 'mixinextras', 'mixinsquared',
]);

function versionParts(value) {
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((part) => {
      const match = String(part).match(/^\d+/);
      return match ? Number(match[0]) : null;
    });
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index] == null ? 0 : a[index];
    const y = b[index] == null ? 0 : b[index];
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 只支持模组元数据里最常见的版本范围写法：
 * - `*`、空范围
 * - `>=1.2`、`<2.0`、`=1.2`
 * - `1.20.x`、`1.20.*`
 * - Maven 区间 `[1.0,2.0)`、`[1.0,)`
 * 解析不了的范围按“通过”处理，避免把未知格式误报成缺失。
 */
function satisfiesRange(version, range) {
  const raw = String(range == null ? '' : range).trim();
  if (!raw || raw === '*' || raw === 'any') return true;
  const actual = String(version || '').trim();
  if (!actual) return true;

  if (/^[\[(]/.test(raw)) {
    const match = raw.match(/^([\[(])([^,]*),?([^)\]]*)([)\]])$/);
    if (!match) return true;
    const lower = match[2].trim();
    const upper = match[3].trim();
    const lowerInclusive = match[1] === '[';
    const upperInclusive = match[4] === ']';
    if (lower) {
      const cmp = compareVersions(actual, lower);
      if (cmp < 0 || (cmp === 0 && !lowerInclusive)) return false;
    }
    if (upper) {
      const cmp = compareVersions(actual, upper);
      if (cmp > 0 || (cmp === 0 && !upperInclusive)) return false;
    }
    return true;
  }

  const constraints = raw.split(/\s+/).filter(Boolean);
  for (const constraint of constraints) {
    const match = constraint.match(/^(>=|<=|>|<|=|~|\^)?\s*(.+)$/);
    if (!match) continue;
    const operator = match[1] || '=';
    const target = match[2].trim();
    if (/[xX*]/.test(target)) {
      const prefix = target.split(/[xX*]/)[0].replace(/\.$/, '');
      if (prefix && !actual.startsWith(prefix)) return false;
      continue;
    }
    const cmp = compareVersions(actual, target);
    if (operator === '>' && cmp <= 0) return false;
    if (operator === '>=' && cmp < 0) return false;
    if (operator === '<' && cmp >= 0) return false;
    if (operator === '<=' && cmp > 0) return false;
    if (operator === '=' && cmp !== 0) return false;
    if (operator === '~' || operator === '^') {
      const targetParts = versionParts(target);
      const actualParts = versionParts(actual);
      if (cmp < 0) return false;
      if (operator === '~' && targetParts[0] != null && actualParts[0] !== targetParts[0]) return false;
      if (operator === '^' && targetParts[0] != null && actualParts[0] !== targetParts[0]) return false;
      if (operator === '~' && targetParts[1] != null && actualParts[1] !== targetParts[1]) return false;
    }
  }
  return true;
}

function dependencyLabel(dep) {
  return dep.range ? `${dep.id}（${dep.range}）` : dep.id;
}

function healthFromList(mods) {
  const issues = [];
  const byId = new Map();
  const enabled = mods.filter((mod) => mod.enabled);
  const addProvider = (id, mod) => {
    const key = String(id || '').trim().toLowerCase();
    if (!key) return;
    if (!byId.has(key)) byId.set(key, []);
    if (!byId.get(key).includes(mod)) byId.get(key).push(mod);
  };
  for (const mod of mods) {
    if (mod.modId) addProvider(mod.modId, mod);
    for (const provided of mod.provides || []) addProvider(provided, mod);
  }

  // 同一个 modid 出现多个文件时，Fabric/Forge 可能只加载其中一个，
  // 版本冲突和“明明装了却找不到前置”往往都由此产生。
  const duplicateIds = [];
  for (const [id, list] of byId.entries()) {
    if (id !== id.toLowerCase()) continue;
    const unique = Array.from(new Set(list.map((mod) => mod.modId || id)));
    if (unique.length && list.length > 1) {
      const names = Array.from(new Set(list.map((mod) => mod.modId || id)));
      if (names.length === 1 && list.length > 1) {
        duplicateIds.push({ id: names[0], mods: list.map((mod) => mod.filename) });
        issues.push({
          type: 'duplicate-modid',
          severity: 'error',
          title: `重复的 modid：${names[0]}`,
          detail: `同目录有 ${list.length} 个文件提供 ${names[0]}，游戏可能只加载其中一个。`,
          files: list.map((mod) => mod.filename),
        });
      }
    }
  }

  const missing = [];
  for (const mod of enabled) {
    for (const dep of mod.dependencies || []) {
      const id = String(dep.id || '').trim();
      if (!id || BUILTIN_DEPENDENCIES.has(id.toLowerCase())) continue;
      const candidates = byId.get(id.toLowerCase()) || [];
      if (dep.type === 'conflict') {
        if (candidates.some((candidate) => candidate.enabled)) {
          issues.push({
            type: 'conflict',
            severity: 'error',
            title: `模组冲突：${mod.name || mod.filename} 与 ${id}`,
            detail: `该模组声明与 ${dependencyLabel(dep)} 冲突，但后者已启用。`,
            files: [mod.filename].concat(candidates.filter((candidate) => candidate.enabled).map((candidate) => candidate.filename)),
          });
        }
        continue;
      }
      if (dep.type !== 'required') continue;
      if (!candidates.length) {
        missing.push({ id, range: dep.range || '', requiredBy: mod.name || mod.filename, filename: mod.filename });
        issues.push({
          type: 'missing-dependency',
          severity: 'error',
          title: `缺少前置：${id}`,
          detail: `${mod.name || mod.filename} 需要 ${dependencyLabel(dep)}，但当前实例没有提供它的模组。`,
          files: [mod.filename],
        });
        continue;
      }
      const active = candidates.filter((candidate) => candidate.enabled);
      if (!active.length) {
        missing.push({ id, range: dep.range || '', requiredBy: mod.name || mod.filename, filename: mod.filename, disabled: true });
        issues.push({
          type: 'disabled-dependency',
          severity: 'warning',
          title: `前置已安装但被禁用：${id}`,
          detail: `${mod.name || mod.filename} 需要 ${dependencyLabel(dep)}；找到 ${candidates.map((candidate) => candidate.filename).join('、')}，但当前是禁用状态。`,
          files: [mod.filename].concat(candidates.map((candidate) => candidate.filename)),
        });
        continue;
      }
      const compatible = active.find((candidate) => satisfiesRange(candidate.version, dep.range));
      if (!compatible) {
        issues.push({
          type: 'dependency-version',
          severity: 'warning',
          title: `前置版本不匹配：${id}`,
          detail: `${mod.name || mod.filename} 需要 ${dependencyLabel(dep)}，当前启用的是 ${active.map((candidate) => candidate.version || '未知版本').join('、')}。`,
          files: [mod.filename].concat(active.map((candidate) => candidate.filename)),
        });
      }
    }
  }

  const clientOnly = enabled.filter((mod) => mod.side === 'client');
  const serverOnly = enabled.filter((mod) => mod.side === 'server');
  if (clientOnly.length && serverOnly.length) {
    issues.push({
      type: 'side-mix',
      severity: 'warning',
      title: '客户端与服务端模组混装',
      detail: `检测到 ${clientOnly.length} 个仅客户端模组和 ${serverOnly.length} 个仅服务端模组；请确认这个实例是客户端还是服务端，服务端专用模组通常会导致客户端启动失败。`,
      files: serverOnly.map((mod) => mod.filename).slice(0, 8),
    });
  } else if (serverOnly.length) {
    issues.push({
      type: 'server-only',
      severity: 'warning',
      title: '检测到仅服务端模组',
      detail: `有 ${serverOnly.length} 个模组声明仅用于服务端；在客户端实例中启用它们可能导致启动失败。`,
      files: serverOnly.map((mod) => mod.filename).slice(0, 8),
    });
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  return {
    issues,
    missing,
    duplicateIds,
    errorCount,
    warningCount,
    clientOnly: clientOnly.length,
    serverOnly: serverOnly.length,
  };
}

module.exports = {
  list,
  setEnabled,
  healthFromList,
  satisfiesRange,
  modDirs,
  isModFile,
  baseJarName,
};
