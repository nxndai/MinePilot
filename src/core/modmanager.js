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

function parseToml(text) {
  const lines = String(text || '').split(/\r?\n/);
  let current = null;
  const mods = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/^\s*#.*$/, '').trim();
    if (/^\[\[mods\]\]$/.test(line)) {
      current = {};
      mods.push(current);
      continue;
    }
    if (!current) continue;
    const match = line.match(/^(modId|displayName|version|modLoader)\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    current[match[1]] = unquote(match[2]);
  }
  return mods[0] || null;
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
      result = {
        name: firstString(data.name, data.id),
        version: firstString(data.version),
        modId: firstString(data.id),
      };
    } else if (entries['quilt.mod.json']) {
      const data = JSON.parse(entries['quilt.mod.json'].toString('utf8'));
      const loader = data.quilt_loader || {};
      const metadata = loader.metadata || data.metadata || {};
      result = {
        name: firstString(metadata.name, loader.id, data.id),
        version: firstString(loader.version, data.version),
        modId: firstString(loader.id),
      };
    } else if (entries['META-INF/neoforge.mods.toml'] || entries['META-INF/mods.toml']) {
      const raw = entries['META-INF/neoforge.mods.toml'] || entries['META-INF/mods.toml'];
      const data = parseToml(raw.toString('utf8'));
      if (data) {
        result = {
          name: firstString(data.displayName, data.modId),
          version: firstString(data.version),
          modId: firstString(data.modId),
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
        };
      }
    }
  } catch (err) {
    logger.warn('读取模组元数据失败:', filename, err.message);
  }

  const merged = {
    name: result.name || fallback.name || filename,
    version: result.version || '',
    modId: result.modId || '',
  };
  META_CACHE.set(cacheKey, merged);
  return Object.assign({}, fallback, merged);
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
        enabled,
        size: stat.size,
        mtime: stat.mtimeMs,
        name: fallbackTitle(filename),
        version: '',
        modId: '',
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

module.exports = { list, setEnabled, modDirs, isModFile, baseJarName };
