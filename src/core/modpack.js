'use strict';

/**
 * 整合包导入 / 导出。
 *
 * 支持：
 *  - Modrinth .mrpack（modrinth.index.json）
 *  - MinePilot 导出的 .zip（MinePilot-pack.json）
 *  - 直接包含 mods/config 的普通 .zip
 *  - CurseForge 清单 zip 会被识别，但因为没有文件直链，导入会给出明确提示
 *
 * 导入 mrpack 时会自动安装对应 Minecraft / 加载器，并把整合包实例标记为
 * 强制版本隔离，避免不同整合包的 mods 互相污染。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const settings = require('./settings');
const logger = require('./logger');
const net = require('./net');
const zip = require('./zip');
const installer = require('./installer');
const versions = require('./versions');

const LOADER_LABELS = {
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
};

const LOADER_DEP_KEYS = [
  ['fabric-loader', 'fabric'],
  ['quilt-loader', 'quilt'],
  ['forge', 'forge'],
  ['neoforge', 'neoforge'],
];

// 导出/导入时只处理这些游戏内容，避免把存档、日志、账户信息打进整合包。
const CONTENT_DIRS = [
  'mods',
  'config',
  'defaultconfigs',
  'kubejs',
  'scripts',
  'resourcepacks',
  'shaderpacks',
  'datapacks',
];
const CONTENT_FILES = ['options.txt'];

function safeName(value, max) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 60) || '整合包';
}

function displayNameFromPath(filePath) {
  return safeName(path.basename(filePath).replace(/\.(?:mrpack|zip)$/i, ''), 80);
}

function cleanRel(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function assertSafeRel(rel) {
  const text = cleanRel(rel);
  if (!text || text.startsWith('../') || text.split('/').includes('..')) {
    throw new Error(`整合包包含非法路径：${rel}`);
  }
  return text;
}

function targetPath(root, rel) {
  const clean = assertSafeRel(rel);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, clean);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`整合包包含非法路径：${rel}`);
  }
  return target;
}

function readJsonEntry(filePath, entryName) {
  const data = zip.readZipEntry(filePath, entryName, { maxBytes: 16 * 1024 * 1024 });
  if (!data) return null;
  try {
    const text = data.toString('utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`整合包清单不是有效的 JSON：${entryName}`);
  }
}

function findEntryName(entries, wanted) {
  const lower = String(wanted).toLowerCase();
  const hit = entries.find((entry) => cleanRel(entry.name).toLowerCase() === lower);
  return hit ? cleanRel(hit.name) : '';
}

function normalizeLoaderVersion(value, mcVersion) {
  let text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (mcVersion) {
    const prefix = `${mcVersion}-`;
    if (text.startsWith(prefix)) text = text.slice(prefix.length);
  }
  return text;
}

function parseDependencies(deps, mcVersion) {
  const dependencies = deps || {};
  for (const [depKey, loaderKey] of LOADER_DEP_KEYS) {
    if (!dependencies[depKey]) continue;
    return {
      key: loaderKey,
      name: LOADER_LABELS[loaderKey],
      version: normalizeLoaderVersion(dependencies[depKey], mcVersion),
    };
  }
  return null;
}

function parseCurseForgeLoader(id, mcVersion) {
  const text = String(id || '').trim();
  const match = text.match(/^(forge|fabric|neoforge|quilt)(?:-|_)(.+)$/i);
  if (!match) return null;
  const key = match[1].toLowerCase();
  return {
    key,
    name: LOADER_LABELS[key] || match[1],
    version: normalizeLoaderVersion(match[2], mcVersion),
  };
}

function isContentPath(rel) {
  const text = cleanRel(rel);
  if (!text) return false;
  const first = text.split('/')[0];
  return CONTENT_DIRS.includes(first) || CONTENT_FILES.includes(text);
}

function detectRootPrefix(entries) {
  const names = entries.filter((entry) => !entry.name.endsWith('/')).map((entry) => cleanRel(entry.name));
  if (!names.length) return '';
  if (names.some((name) => isContentPath(name))) return '';
  const tops = new Set(names.map((name) => name.split('/')[0]).filter(Boolean));
  if (tops.size === 1) {
    const top = `${Array.from(tops)[0]}/`;
    if (names.some((name) => name.startsWith(top) && isContentPath(name.slice(top.length)))) return top;
  }
  // 有些整合包在根目录放了 README，再把真正的 mods/config 放进一个子文件夹。
  // 只要内容目录只出现在同一个子文件夹里，就把这个子文件夹当作根。
  const contentTops = new Set();
  for (const name of names) {
    const parts = name.split('/');
    if (parts.length < 2) continue;
    if (isContentPath(parts.slice(1).join('/'))) contentTops.add(parts[0]);
  }
  if (contentTops.size === 1) return `${Array.from(contentTops)[0]}/`;
  return '';
}

function countContent(entries, prefix) {
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    let rel = cleanRel(entry.name);
    if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
    else if (prefix) continue;
    if (!isContentPath(rel)) continue;
    files += 1;
    bytes += Number(entry.size) || 0;
  }
  return { files, bytes };
}

function baseInfo(filePath, kind) {
  return {
    ok: true,
    path: filePath,
    fileName: path.basename(filePath),
    kind,
    name: displayNameFromPath(filePath),
    minecraft: '',
    loader: null,
    action: 'current',
    files: 0,
    overrides: 0,
    bytes: 0,
    rootPrefix: '',
    supported: true,
    warnings: [],
  };
}

async function inspect(filePath) {
  const file = path.resolve(String(filePath || ''));
  if (!/\.(?:mrpack|zip)$/i.test(file)) {
    const error = new Error('只支持 .mrpack 或 .zip 整合包');
    error.code = 'BAD_PACK_TYPE';
    throw error;
  }
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('选择的整合包不是文件');
  const entries = zip.listZipEntries(file);
  const rootIndex = findEntryName(entries, 'modrinth.index.json');
  if (rootIndex) {
    const index = readJsonEntry(file, rootIndex);
    if (!index || typeof index !== 'object') throw new Error('mrpack 缺少有效的 modrinth.index.json');
    if (Number(index.formatVersion) !== 1) {
      throw new Error(`不支持的 mrpack 版本：${index.formatVersion || '未知'}`);
    }
    if (index.game && String(index.game).toLowerCase() !== 'minecraft') {
      throw new Error(`不支持的整合包类型：${index.game}`);
    }
    const deps = index.dependencies || {};
    const mcVersion = String(deps.minecraft || '').trim();
    const loader = parseDependencies(deps, mcVersion);
    const info = baseInfo(file, 'mrpack');
    info.name = safeName(index.name || info.name, 90);
    info.minecraft = mcVersion;
    info.loader = loader;
    info.action = mcVersion && loader && loader.version ? 'new' : 'current';
    info.overrides = entries.filter((entry) => cleanRel(entry.name).startsWith('overrides/') && !entry.name.endsWith('/')).length;
    const files = Array.isArray(index.files) ? index.files : [];
    info.files = files.length;
    info.bytes = files.reduce((sum, item) => sum + (Number(item && item.fileSize) || 0), 0);
    info.summary = String(index.summary || '').slice(0, 300);
    if (!mcVersion) info.warnings.push('整合包没有写 Minecraft 版本，将导入到当前实例。');
    if (!loader || !loader.version) info.warnings.push('整合包没有写加载器版本，将导入到当前实例；建议先确认当前实例的加载器。');
    if (!files.length && !info.overrides) info.warnings.push('整合包清单里没有文件。');
    return info;
  }

  const rootMeta = findEntryName(entries, 'MinePilot-pack.json');
  if (rootMeta) {
    const meta = readJsonEntry(file, rootMeta);
    const info = baseInfo(file, 'minepilot');
    info.name = safeName(meta && meta.name ? meta.name : info.name, 90);
    info.minecraft = String((meta && meta.minecraft) || '').trim();
    const loader = meta && meta.loader && meta.loader.key
      ? {
        key: String(meta.loader.key),
        name: LOADER_LABELS[meta.loader.key] || String(meta.loader.key),
        version: normalizeLoaderVersion(meta.loader.version, info.minecraft),
      }
      : null;
    info.loader = loader;
    info.action = info.minecraft && loader && loader.version ? 'new' : 'current';
    info.rootPrefix = detectRootPrefix(entries);
    const counted = countContent(entries, info.rootPrefix);
    info.files = counted.files;
    info.bytes = counted.bytes;
    if (!info.files) info.warnings.push('压缩包里没有找到 mods / config 等内容。');
    return info;
  }

  const rootManifest = findEntryName(entries, 'manifest.json');
  if (rootManifest) {
    const manifest = readJsonEntry(file, rootManifest);
    if (manifest && manifest.minecraft && (manifest.minecraft.version || Array.isArray(manifest.minecraft.modLoaders))) {
      const mcVersion = String(manifest.minecraft.version || '').trim();
      const modLoaders = Array.isArray(manifest.minecraft.modLoaders) ? manifest.minecraft.modLoaders : [];
      const primary = modLoaders.find((item) => item && item.primary) || modLoaders[0] || null;
      const loader = primary ? parseCurseForgeLoader(primary.id, mcVersion) : null;
      const info = baseInfo(file, 'curseforge');
      info.name = safeName(manifest.name || info.name, 90);
      info.minecraft = mcVersion;
      info.loader = loader;
      info.action = 'none';
      info.supported = false;
      info.files = Array.isArray(manifest.files) ? manifest.files.length : 0;
      info.bytes = 0;
      info.warnings.push('这是 CurseForge 清单整合包。清单只记录项目 ID，不包含文件直链；当前版本不会猜测下载地址，请使用 .mrpack 或包含 mods 的离线 ZIP。');
      return info;
    }
  }

  const info = baseInfo(file, 'zip');
  info.rootPrefix = detectRootPrefix(entries);
  const counted = countContent(entries, info.rootPrefix);
  info.files = counted.files;
  info.bytes = counted.bytes;
  info.action = 'current';
  if (!counted.files) {
    info.warnings.push('压缩包里没有找到 mods / config 等内容；可以检查是否把整个 .minecraft 文件夹打包了。');
  }
  return info;
}

function mapProgress(onProgress, from, to, prefix) {
  return (payload) => {
    if (!onProgress || !payload) return;
    const percent = from + ((Number(payload.percent) || 0) / 100) * (to - from);
    onProgress(Object.assign({}, payload, {
      percent: Math.max(0, Math.min(100, percent)),
      phase: prefix ? `${prefix}${payload.phase || ''}` : payload.phase,
      message: payload.message || payload.phase || '',
    }));
  };
}

function snapshotVersions() {
  const dir = path.join(settings.get().gameDir, 'versions');
  try {
    return new Set(fs.readdirSync(dir));
  } catch (err) {
    return new Set();
  }
}

function makeInstanceId(name) {
  const base = settings.get().gameDir;
  const stem = safeName(name, 32).replace(/\s+/g, '-');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const suffix = `${Date.now().toString(36)}${attempt ? `-${attempt}` : ''}`;
    const candidate = `${stem}-${suffix}`;
    if (!fs.existsSync(path.join(base, 'versions', candidate))) return candidate;
  }
  return `${stem}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
}

function copyVersionJson(sourceId, targetId) {
  const base = settings.get().gameDir;
  const sourceDir = path.join(base, 'versions', sourceId);
  const targetDir = path.join(base, 'versions', targetId);
  const files = fs.readdirSync(sourceDir).filter((name) => name.toLowerCase().endsWith('.json'));
  if (!files.length) throw new Error('加载器版本缺少 JSON 配置，无法创建整合包实例');
  const preferred = files.find((name) => name.toLowerCase() === `${sourceId}.json`.toLowerCase()) || files[0];
  const sourceFile = path.join(sourceDir, preferred);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  } catch (err) {
    throw new Error('加载器版本配置不是有效的 JSON，无法创建整合包实例');
  }
  if (!data || typeof data !== 'object') throw new Error('加载器版本配置格式不正确');
  data.id = targetId;
  fs.mkdirSync(targetDir, { recursive: true });
  // Forge/NeoForge 的版本目录里除 JSON 外还有安装器生成的 client jar、natives 等，
  // 只复制 JSON 会让新实例启动时找不到主文件，所以整个目录一起复制。
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(targetDir, `${targetId}.json`), JSON.stringify(data, null, 2), 'utf8');
}

function markInstance(versionId, info) {
  const base = settings.get().gameDir;
  const folder = path.join(base, 'versions', versionId);
  fs.mkdirSync(folder, { recursive: true });
  const markerPath = path.join(folder, '.minepilot.json');
  let marker = {};
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (err) {
    marker = {};
  }
  marker.versionId = versionId;
  marker.installedAt = marker.installedAt || Date.now();
  marker.newLauncher = true;
  marker.isolated = true;
  marker.packName = info.name;
  marker.packSource = info.kind;
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');
}

async function createInstance(info, options) {
  if (!info.minecraft || !info.loader || !info.loader.version) {
    throw new Error('整合包缺少 Minecraft 或加载器版本，无法自动创建实例');
  }
  const base = settings.get().gameDir;
  const before = snapshotVersions();
  const onProgress = options.onProgress || null;
  const result = await installer.installVersion(info.minecraft, {
    loader: info.loader.key,
    loaderVersion: info.loader.version,
    signal: options.signal || null,
    onProgress: mapProgress(onProgress, 4, 55, '安装实例：'),
  });
  let versionId = String(result.versionId || '');
  if (!versionId) throw new Error('加载器安装完成，但没有生成版本 ID');
  if (before.has(versionId)) {
    const newId = makeInstanceId(info.name);
    copyVersionJson(versionId, newId);
    versionId = newId;
  }
  markInstance(versionId, info);
  const isolatedDir = versions.effectiveDir(base, versionId, true, settings.get().gameDataDir);
  logger.info('整合包实例已创建:', versionId, '目录:', isolatedDir);
  return { versionId, gameDir: isolatedDir };
}

function hashFile(file, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function downloadPackFiles(filePath, gameDir, options) {
  const index = readJsonEntry(filePath, 'modrinth.index.json');
  const files = Array.isArray(index && index.files) ? index.files : [];
  const tasks = [];
  const warnings = [];
  for (const item of files) {
    if (!item || typeof item !== 'object') continue;
    const env = item.env && typeof item.env === 'object' ? item.env : {};
    if (env.client === 'unsupported') continue;
    const rel = assertSafeRel(item.path);
    const urls = Array.isArray(item.downloads) ? item.downloads.filter((url) => /^https?:\/\//i.test(String(url || ''))) : [];
    if (!urls.length) {
      warnings.push(`跳过没有下载地址的文件：${rel}`);
      continue;
    }
    tasks.push({
      url: urls[0],
      path: targetPath(gameDir, rel),
      sha1: item.hashes && item.hashes.sha1 ? String(item.hashes.sha1).toLowerCase() : null,
      sha512: item.hashes && item.hashes.sha512 ? String(item.hashes.sha512).toLowerCase() : null,
      size: Number(item.fileSize) || 0,
      label: rel,
    });
  }
  if (!tasks.length) {
    options.onProgress({ phase: '下载整合包文件', percent: 56, message: tasks.length ? '' : '没有需要下载的清单文件' });
    return { count: 0, bytes: 0, warnings };
  }
  const totalBytes = tasks.reduce((sum, item) => sum + (item.size || 0), 0);
  await net.downloadMany(tasks, {
    threads: settings.get().downloadThreads,
    signal: options.signal || null,
    onProgress: (progress) => {
      const ratio = totalBytes ? (Number(progress.receivedBytes) || 0) / totalBytes : (progress.doneFiles / Math.max(1, progress.totalFiles));
      options.onProgress({
        phase: '下载整合包文件',
        percent: 55 + Math.min(37, Math.max(0, ratio) * 37),
        message: `正在下载 ${progress.doneFiles}/${progress.totalFiles} 个文件`,
        index: progress.doneFiles,
        total: progress.totalFiles,
        bytes: progress.totalBytes,
        received: progress.receivedBytes,
      });
    },
  });
  for (const task of tasks) {
    if (!task.sha512) continue;
    const actual = await hashFile(task.path, 'sha512');
    if (actual !== task.sha512) {
      const error = new Error(`文件校验失败：${task.label}`);
      error.code = 'PACK_HASH_MISMATCH';
      throw error;
    }
  }
  return { count: tasks.length, bytes: totalBytes, warnings };
}

function packTempDir() {
  const dir = path.join(config.cacheDir(), `modpack-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function copyTree(source, destination) {
  if (!fs.existsSync(source)) return 0;
  let count = 0;
  const walk = (src, dest) => {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        walk(srcPath, destPath);
      } else if (entry.isFile()) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
        count += 1;
      }
    }
  };
  fs.mkdirSync(destination, { recursive: true });
  walk(source, destination);
  return count;
}

function extractOverrides(filePath, gameDir, onProgress) {
  const temp = packTempDir();
  try {
    onProgress({ phase: '解压整合包覆盖文件', percent: 94, message: '正在解压 overrides…' });
    zip.extractZip(filePath, temp, {
      filter: (name) => {
        const clean = cleanRel(name);
        return clean.startsWith('overrides/') && !clean.endsWith('/');
      },
    });
    const source = path.join(temp, 'overrides');
    const count = copyTree(source, gameDir);
    onProgress({ phase: '解压整合包覆盖文件', percent: 98, message: `已覆盖 ${count} 个文件` });
    return count;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function extractGeneric(filePath, info, gameDir, onProgress) {
  const temp = packTempDir();
  try {
    const prefix = info.rootPrefix || '';
    onProgress({ phase: '解压整合包', percent: 92, message: '正在解压 mods / config…' });
    zip.extractZip(filePath, temp, {
      filter: (name) => {
        const clean = cleanRel(name);
        if (!clean || clean.startsWith('__MACOSX/') || clean.endsWith('/')) return false;
        let rel = clean;
        if (prefix) {
          if (!rel.startsWith(prefix)) return false;
          rel = rel.slice(prefix.length);
        }
        return isContentPath(rel);
      },
    });
    const source = prefix ? path.join(temp, ...prefix.split('/').filter(Boolean)) : temp;
    let count = 0;
    for (const dir of CONTENT_DIRS) {
      const src = path.join(source, dir);
      if (fs.existsSync(src)) count += copyTree(src, path.join(gameDir, dir));
    }
    for (const file of CONTENT_FILES) {
      const src = path.join(source, file);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
      fs.mkdirSync(path.dirname(path.join(gameDir, file)), { recursive: true });
      fs.copyFileSync(src, path.join(gameDir, file));
      count += 1;
    }
    onProgress({ phase: '解压整合包', percent: 98, message: `已导入 ${count} 个文件` });
    return count;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function importPack(filePath, options = {}) {
  const info = options.info || await inspect(filePath);
  if (!info.supported) {
    const error = new Error(info.warnings[0] || '当前不支持这种整合包');
    error.code = 'PACK_UNSUPPORTED';
    throw error;
  }
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const signal = options.signal || null;
  let target = options.target || null;
  let versionId = '';
  let gameDir = '';
  let mode = 'current';
  const warnings = Array.isArray(info.warnings) ? info.warnings.slice() : [];

  onProgress({ phase: '准备导入', percent: 2, message: `正在读取 ${info.name}` });

  if (info.action === 'new' && options.mode !== 'current') {
    const created = await createInstance(info, { onProgress, signal });
    versionId = created.versionId;
    gameDir = created.gameDir;
    mode = 'new';
  } else {
    if (!target || !target.id || !target.gameDir) {
      const error = new Error('请先选择一个要导入的实例');
      error.code = 'NO_TARGET';
      throw error;
    }
    versionId = target.id;
    gameDir = target.gameDir;
    if (info.minecraft && target.mcVersion && info.minecraft !== target.mcVersion) {
      warnings.push(`整合包要求 Minecraft ${info.minecraft}，当前实例是 ${target.mcVersion}；可能无法启动。`);
    }
    if (info.loader && target.loaders && target.loaders.length) {
      const current = target.loaders[0];
      if (current && current.key !== info.loader.key) {
        warnings.push(`整合包要求 ${info.loader.name}，当前实例是 ${current.name || current.key}；模组可能无法加载。`);
      }
    }
    onProgress({ phase: '准备导入', percent: 5, message: `将导入到 ${versionId}` });
  }

  fs.mkdirSync(gameDir, { recursive: true });
  let downloaded = 0;
  let overrides = 0;
  if (info.kind === 'mrpack') {
    const result = await downloadPackFiles(filePath, gameDir, { onProgress, signal });
    downloaded = result.count;
    warnings.push(...result.warnings);
    overrides = extractOverrides(filePath, gameDir, onProgress);
  } else {
    overrides = extractGeneric(filePath, info, gameDir, onProgress);
  }

  onProgress({ phase: '完成', percent: 100, message: '整合包导入完成' });
  logger.info('整合包导入完成:', info.name, '实例:', versionId, '下载:', downloaded, '覆盖:', overrides);
  return {
    ok: true,
    kind: info.kind,
    name: info.name,
    versionId,
    gameDir,
    mode,
    downloaded,
    overrides,
    warnings,
    minecraft: info.minecraft,
    loader: info.loader,
  };
}

function collectFiles(root) {
  const files = [];
  const addFile = (file, rel) => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      files.push({ rel: rel.replace(/\\/g, '/'), path: file, size: stat.size, mtime: stat.mtimeMs });
    } catch (err) {
      /* 忽略读取失败的文件 */
    }
  };
  const walk = (dir, prefix) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(file, rel);
      else if (entry.isFile()) addFile(file, rel);
    }
  };
  for (const dir of CONTENT_DIRS) {
    const full = path.join(root, dir);
    if (fs.existsSync(full)) walk(full, dir);
  }
  for (const file of CONTENT_FILES) {
    const full = path.join(root, file);
    if (fs.existsSync(full)) addFile(full, file);
  }
  return files;
}

function loaderForTarget(target) {
  const list = Array.isArray(target.loaders) ? target.loaders : [];
  const order = ['fabric', 'quilt', 'neoforge', 'forge'];
  for (const key of order) {
    const hit = list.find((item) => item && item.key === key);
    if (hit) return hit;
  }
  return null;
}

async function exportPack(target, options = {}) {
  if (!target || !target.id || !target.gameDir) {
    const error = new Error('请先选择要导出的实例');
    error.code = 'NO_TARGET';
    throw error;
  }
  const format = options.format === 'zip' ? 'zip' : 'mrpack';
  let outputPath = String(options.outputPath || '').trim();
  if (!outputPath) throw new Error('缺少导出路径');
  if (!new RegExp(`\\.${format}$`, 'i').test(outputPath)) {
    outputPath = `${outputPath.replace(/\.(?:mrpack|zip)$/i, '')}.${format}`;
  }
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  onProgress({ phase: '收集实例文件', percent: 2, message: '正在扫描 mods / config…' });
  const files = collectFiles(target.gameDir);
  const loader = loaderForTarget(target);
  const name = safeName(options.name || target.id, 90);
  const prefix = format === 'mrpack' ? 'overrides/' : '';
  const entries = files.map((file) => ({
    name: `${prefix}${file.rel}`,
    filePath: file.path,
    mtime: file.mtime,
  }));
  const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);

  if (format === 'mrpack') {
    const dependencies = { minecraft: String(target.mcVersion || '') };
    if (loader && loader.version) {
      if (loader.key === 'fabric') dependencies['fabric-loader'] = loader.version;
      else if (loader.key === 'quilt') dependencies['quilt-loader'] = loader.version;
      else if (loader.key === 'forge') dependencies.forge = loader.version;
      else if (loader.key === 'neoforge') dependencies.neoforge = loader.version;
    }
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: `${safeName(target.id, 48)}-${Date.now().toString(36)}`,
      name,
      summary: '由 MinePilot 导出的整合包，包含 mods、config、资源包与光影配置。',
      files: [],
      dependencies,
    };
    entries.unshift({ name: 'modrinth.index.json', data: JSON.stringify(index, null, 2) });
  } else {
    const meta = {
      format: 1,
      launcher: 'MinePilot',
      name,
      minecraft: String(target.mcVersion || ''),
      loader: loader && loader.version ? { key: loader.key, version: loader.version } : null,
      exportedAt: Date.now(),
      files: files.length,
    };
    entries.unshift({ name: 'MinePilot-pack.json', data: JSON.stringify(meta, null, 2) });
  }

  onProgress({ phase: '写入整合包', percent: 8, message: `正在打包 ${files.length} 个文件`, total: files.length });
  const result = zip.createZip(entries, outputPath, {
    onEntry: (index, total, entryName) => {
      const percent = 8 + (index / Math.max(1, total)) * 89;
      onProgress({ phase: '写入整合包', percent, message: `正在写入 ${entryName}`, index, total });
    },
  });
  onProgress({ phase: '完成', percent: 100, message: '整合包导出完成' });
  logger.info('整合包导出完成:', outputPath, '文件:', files.length, '字节:', result.bytes);
  return {
    ok: true,
    format,
    path: outputPath,
    name,
    files: files.length,
    bytes: result.bytes || totalBytes,
    versionId: target.id,
  };
}

/**
 * 从 Modrinth 下载 .mrpack 并直接导入为独立实例。
 * 仅允许 Modrinth CDN，避免把任意 URL 变成启动器下载器。
 */
async function installFromUrl(options = {}) {
  const rawUrl = String(options.url || '').trim();
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    const error = new Error('整合包下载地址无效');
    error.code = 'BAD_PACK_URL';
    throw error;
  }
  if (parsed.protocol !== 'https:' || !['cdn.modrinth.com', 'cdn-raw.modrinth.com'].includes(parsed.hostname)) {
    const error = new Error('只支持从 Modrinth 官方 CDN 下载整合包');
    error.code = 'BAD_PACK_URL';
    throw error;
  }

  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const signal = options.signal || null;
  const tempDir = packTempDir();
  const originalName = String(options.filename || 'modpack.mrpack');
  const extension = /\.zip$/i.test(originalName) ? '.zip' : '.mrpack';
  const baseName = safeName(originalName.replace(/\.(?:mrpack|zip)$/i, ''), 80);
  const filePath = path.join(tempDir, `${baseName}${extension}`);
  const totalBytes = Number(options.size) || 0;

  try {
    onProgress({ phase: '下载整合包', percent: 1, message: `正在下载 ${baseName}${extension}` });
    await net.downloadFile(rawUrl, filePath, {
      sha1: options.sha1 || null,
      signal,
      retries: 3,
      onBytes: (received) => {
        const percent = totalBytes
          ? Math.min(45, Math.max(1, Math.floor((received / totalBytes) * 45)))
          : 5;
        onProgress({
          phase: '下载整合包',
          percent,
          message: `正在下载 ${baseName}${extension}`,
          received,
          bytes: totalBytes,
        });
      },
    });
    onProgress({ phase: '导入整合包', percent: 48, message: '下载完成，正在解压并安装…' });
    const result = await importPack(filePath, {
      mode: 'new',
      signal,
      onProgress: mapProgress(onProgress, 50, 100, '导入整合包'),
    });
    return Object.assign({ downloaded: true }, result);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (err) { /* 忽略清理失败 */ }
  }
}

module.exports = {
  inspect,
  importPack,
  installFromUrl,
  exportPack,
  CONTENT_DIRS,
  CONTENT_FILES,
};
