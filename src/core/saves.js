'use strict';

/**
 * 按实例管理 Minecraft saves/ 目录。
 *
 * 备份 zip 默认写到 <实例目录>/backups/，包含世界目录内的全部常规文件，
 * 另外写入 minepilot-save.json 记录世界名、游戏版本和创建时间。恢复和导入
 * 都先解压到临时目录，确认存在 level.dat 后再移动到 saves/，避免把半个世界
 * 直接写进游戏目录。
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const logger = require('./logger');
const nbt = require('./nbt');
const zip = require('./zip');

const MANIFEST = 'minepilot-save.json';
const MAX_MANIFEST = 256 * 1024;
const MAX_LEVEL_DAT = 8 * 1024 * 1024;
const MAX_ZIP_BYTES = 1536 * 1024 * 1024;
const MAX_WORLD_FILES = 200000;
const MAX_WORLD_DEPTH = 40;

function cleanText(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 120);
}

function instanceRoot(target) {
  const root = target && target.gameDir ? String(target.gameDir) : '';
  if (!root) {
    const error = new Error('请先选择目标版本');
    error.code = 'NO_TARGET';
    throw error;
  }
  return path.resolve(root);
}

function savesDir(target) {
  return path.join(instanceRoot(target), 'saves');
}

function backupsDir(target) {
  return path.join(instanceRoot(target), 'backups');
}

function validWorldName(value) {
  const name = String(value || '');
  if (!name || name === '.' || name === '..') return false;
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) return false;
  if (name.length > 180) return false;
  return path.basename(name) === name;
}

function worldPath(target, name) {
  if (!validWorldName(name)) {
    const error = new Error('存档名称不合法');
    error.code = 'BAD_SAVE';
    throw error;
  }
  const dir = savesDir(target);
  const resolved = path.resolve(dir, name);
  const relative = path.relative(dir, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error('存档路径不合法');
    error.code = 'BAD_SAVE';
    throw error;
  }
  return resolved;
}

function isDirectory(file) {
  try {
    return fs.statSync(file).isDirectory();
  } catch (err) {
    return false;
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch (err) {
    return null;
  }
}

function bigintToNumber(value) {
  if (typeof value === 'bigint') {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    return value > max ? Number.MAX_SAFE_INTEGER : Number(value);
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function readLevelDat(worldDir) {
  const file = path.join(worldDir, 'level.dat');
  const stat = safeStat(file);
  if (!stat || !stat.isFile() || stat.size > MAX_LEVEL_DAT) return null;
  try {
    const parsed = nbt.parse(fs.readFileSync(file));
    const data = parsed && parsed.Data ? parsed.Data : parsed;
    if (!data || typeof data !== 'object') return null;
    const version = data.Version && typeof data.Version === 'object' ? data.Version : {};
    return {
      name: cleanText(data.LevelName, 180),
      lastPlayed: bigintToNumber(data.LastPlayed),
      version: cleanText(version.Name || version.Id || version.Snapshot, 80),
      gameMode: Number(data.GameType),
      difficulty: Number(data.Difficulty),
      hardcore: Number(data.Hardcore) === 1,
      locked: Number(data.Locked) === 1,
    };
  } catch (err) {
    logger.warn('读取存档 level.dat 失败:', path.basename(worldDir), err.message);
    return null;
  }
}

function walkFiles(rootDir) {
  const files = [];
  const stack = [{ dir: rootDir, relative: '', depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      // 不跟随符号链接，避免备份到存档目录之外。
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (current.depth >= MAX_WORLD_DEPTH) continue;
        stack.push({ dir: full, relative, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        const stat = safeStat(full);
        if (!stat || !stat.isFile()) continue;
        files.push({ filePath: full, name: relative, mtime: stat.mtime, size: stat.size });
        if (files.length > MAX_WORLD_FILES) {
          const error = new Error('存档文件数量过多，已停止读取');
          error.code = 'SAVE_TOO_LARGE';
          throw error;
        }
      }
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return files;
}

function worldInfo(target, folder) {
  const dir = worldPath(target, folder);
  if (!isDirectory(dir)) return null;
  const level = readLevelDat(dir);
  const levelStat = safeStat(path.join(dir, 'level.dat'));
  const stat = safeStat(dir);
  const files = walkFiles(dir);
  const size = files.reduce((sum, item) => sum + item.size, 0);
  const name = (level && level.name) || folder;
  return {
    folder,
    name,
    lastPlayed: (level && level.lastPlayed) || (stat ? stat.mtimeMs : 0),
    mcVersion: (level && level.version) || (target && target.mcVersion) || '',
    size,
    files: files.length,
    hasLevelDat: Boolean(level) || Boolean(levelStat && levelStat.isFile() && levelStat.size > 0),
    gameMode: level ? level.gameMode : null,
    difficulty: level ? level.difficulty : null,
    hardcore: Boolean(level && level.hardcore),
    locked: Boolean(level && level.locked),
    path: dir,
  };
}

function list(target) {
  const dir = savesDir(target);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return {
      ok: true,
      savesDir: dir,
      backupsDir: backupsDir(target),
      saves: [],
      count: 0,
      totalBytes: 0,
      error: '',
    };
  }

  const saves = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const info = worldInfo(target, entry.name);
      if (info) saves.push(info);
    } catch (err) {
      logger.warn('读取存档失败:', entry.name, err.message);
    }
  }
  saves.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || a.name.localeCompare(b.name, 'zh-CN'));
  return {
    ok: true,
    targetVersionId: target.id,
    savesDir: dir,
    backupsDir: backupsDir(target),
    saves,
    count: saves.length,
    totalBytes: saves.reduce((sum, item) => sum + item.size, 0),
  };
}

function backupName(world) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('') + '-' + [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const base = cleanText(world, 80).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'world';
  return `${base}-${stamp}.zip`;
}

function makeManifest(target, info) {
  return {
    format: 'minepilot-save-backup',
    version: 1,
    createdAt: Date.now(),
    world: info.folder,
    name: info.name,
    mcVersion: info.mcVersion,
    targetVersionId: target.id || '',
    files: info.files,
  };
}

function createWorldZip(target, folder, outputPath) {
  const info = worldInfo(target, folder);
  if (!info) {
    const error = new Error('找不到这个存档');
    error.code = 'SAVE_NOT_FOUND';
    throw error;
  }
  const files = walkFiles(info.path);
  const entries = files
    .filter((item) => String(item.name).toLowerCase() !== MANIFEST)
    .map((item) => ({
      name: item.name,
      filePath: item.filePath,
      mtime: item.mtime,
    }));
  entries.push({
    name: MANIFEST,
    data: JSON.stringify(makeManifest(target, info), null, 2),
  });
  const result = zip.createZip(entries, outputPath);
  return { info, result };
}

function backup(target, folder) {
  const dir = backupsDir(target);
  fs.mkdirSync(dir, { recursive: true });
  let filename = backupName(folder);
  let output = path.join(dir, filename);
  for (let index = 2; fs.existsSync(output); index += 1) {
    output = path.join(dir, filename.replace(/\.zip$/i, `-${index}.zip`));
  }
  const { info, result } = createWorldZip(target, folder, output);
  logger.info('已备份存档:', folder, output, result.bytes);
  return {
    ok: true,
    backup: {
      file: path.basename(output),
      world: info.folder,
      name: info.name,
      mcVersion: info.mcVersion,
      createdAt: Date.now(),
      size: result.bytes,
    },
    backups: listBackups(target),
  };
}

function readManifest(file) {
  try {
    const raw = zip.readZipEntry(file, MANIFEST, { maxBytes: MAX_MANIFEST });
    if (!raw) return null;
    const data = JSON.parse(raw.toString('utf8'));
    if (!data || data.format !== 'minepilot-save-backup') return null;
    return data;
  } catch (err) {
    return null;
  }
}

function fallbackWorldName(file) {
  return path.basename(String(file || '')).replace(/\.zip$/i, '').replace(/-\d{8}-\d{6}(?:-\d+)?$/i, '') || 'world';
}

function backupInfo(file, manifest) {
  const stat = safeStat(file);
  return {
    file: path.basename(file),
    world: cleanText(manifest && manifest.world, 180) || fallbackWorldName(file),
    name: cleanText(manifest && manifest.name, 180) || fallbackWorldName(file),
    mcVersion: cleanText(manifest && manifest.mcVersion, 80),
    createdAt: Number(manifest && manifest.createdAt) || (stat ? stat.mtimeMs : 0),
    size: stat ? stat.size : 0,
    mtime: stat ? stat.mtimeMs : 0,
  };
}

function listBackups(target) {
  const dir = backupsDir(target);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /\.zip$/i.test(name));
  } catch (err) {
    names = [];
  }
  return names
    .map((name) => {
      const file = path.join(dir, name);
      return backupInfo(file, readManifest(file));
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function resolveBackup(target, filename) {
  const name = path.basename(String(filename || ''));
  if (!name || name !== String(filename || '') || !/\.zip$/i.test(name)) {
    const error = new Error('备份文件名不合法');
    error.code = 'BAD_BACKUP';
    throw error;
  }
  const file = path.resolve(backupsDir(target), name);
  const dir = path.resolve(backupsDir(target));
  if (path.dirname(file) !== dir || !safeStat(file)) {
    const error = new Error('找不到这个备份');
    error.code = 'BACKUP_NOT_FOUND';
    throw error;
  }
  return file;
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('清理临时存档目录失败:', dir, err.message);
  }
}

function findWorldDir(rootDir, depth = 0, found = []) {
  if (depth > 4) return found;
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    return found;
  }
  if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === 'level.dat')) {
    found.push(rootDir);
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    findWorldDir(path.join(rootDir, entry.name), depth + 1, found);
  }
  return found;
}

function mergeWorld(target, folder, sourceDir, overwrite) {
  const destination = worldPath(target, folder);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  let old = '';
  if (fs.existsSync(destination)) {
    if (!overwrite) {
      const error = new Error(`存档“${folder}”已存在`);
      error.code = 'SAVE_EXISTS';
      throw error;
    }
    old = `${destination}.minepilot-old-${process.pid}-${Date.now()}`;
    fs.renameSync(destination, old);
  }
  try {
    try {
      fs.renameSync(sourceDir, destination);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.cpSync(sourceDir, destination, { recursive: true, force: true, errorOnExist: false });
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  } catch (err) {
    if (old) {
      try { fs.rmSync(destination, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      try { fs.renameSync(old, destination); } catch (e) { /* ignore */ }
    }
    throw err;
  }
  if (old) removeDir(old);
  return destination;
}

function restoreFromZip(target, zipFile, options = {}) {
  const stat = safeStat(zipFile);
  if (!stat || !stat.isFile()) {
    const error = new Error('找不到备份文件');
    error.code = 'BACKUP_NOT_FOUND';
    throw error;
  }
  if (stat.size > MAX_ZIP_BYTES) {
    const error = new Error('备份文件过大，无法在启动器内恢复；请手动解压到 saves 目录');
    error.code = 'BACKUP_TOO_LARGE';
    throw error;
  }
  const manifest = readManifest(zipFile);
  const temp = fs.mkdtempSync(path.join(config.root(), 'cache', 'restore-'));
  try {
    zip.extractZip(zipFile, temp, {
      maxOutputLength: MAX_ZIP_BYTES,
      filter: (name) => !/(^|\/)minepilot-save\.json$/i.test(name),
    });
    const worlds = findWorldDir(temp);
    if (worlds.length !== 1) {
      const error = new Error(worlds.length ? '压缩包里包含多个存档，无法确定要恢复哪一个' : '压缩包里没有找到 level.dat');
      error.code = 'BAD_SAVE_ARCHIVE';
      throw error;
    }
    const folder = options.folder || (manifest && manifest.world) || fallbackWorldName(zipFile);
    if (!validWorldName(folder)) {
      const error = new Error('备份中的存档名称不合法');
      error.code = 'BAD_SAVE_ARCHIVE';
      throw error;
    }
    const destination = mergeWorld(target, folder, worlds[0], Boolean(options.overwrite));
    logger.info('已恢复存档:', folder, '来自', path.basename(zipFile));
    return {
      ok: true,
      folder,
      destination,
      info: worldInfo(target, folder),
    };
  } finally {
    removeDir(temp);
  }
}

function restore(target, filename, options = {}) {
  const file = resolveBackup(target, filename);
  return restoreFromZip(target, file, options);
}

function remove(target, folder, options = {}) {
  const dir = worldPath(target, folder);
  if (!isDirectory(dir)) {
    const error = new Error('找不到这个存档');
    error.code = 'SAVE_NOT_FOUND';
    throw error;
  }
  let backupResult = null;
  if (options.backup !== false) {
    backupResult = backup(target, folder);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  logger.info('已删除存档:', folder, '备份:', Boolean(backupResult));
  return { ok: true, backup: backupResult ? backupResult.backup : null };
}

function exportWorld(target, folder, outputPath) {
  const file = path.resolve(String(outputPath || ''));
  if (!/\.zip$/i.test(file)) {
    const error = new Error('导出文件必须使用 .zip 扩展名');
    error.code = 'BAD_EXPORT_PATH';
    throw error;
  }
  const { result } = createWorldZip(target, folder, file);
  return { ok: true, path: file, fileName: path.basename(file), size: result.bytes };
}

function importWorld(target, zipFile, options = {}) {
  const source = path.resolve(String(zipFile || ''));
  if (!/\.zip$/i.test(source) || !safeStat(source)) {
    const error = new Error('请选择有效的存档 ZIP 文件');
    error.code = 'BAD_SAVE_ARCHIVE';
    throw error;
  }
  return restoreFromZip(target, source, options);
}

module.exports = {
  list,
  listBackups,
  backup,
  restore,
  remove,
  exportWorld,
  importWorld,
  savesDir,
  backupsDir,
  validWorldName,
};