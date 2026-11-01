'use strict';

/**
 * 游戏内容管理：资源包 / 光影 / 数据包。
 *
 * - 资源包启用状态来自 options.txt 的 resourcePacks 列表。
 * - 光影启用状态来自 config/iris.properties 的 shaderPack。
 * - 数据包按目录管理：datapacks 为启用，datapacks-disabled 为停用。
 *
 * 所有路径都以启动器解析出的实例 gameDir 为根，渲染进程不能直接传任意
 * 路径。删除内容会移动到数据目录的 content-trash，而不是直接抹掉。
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const logger = require('./logger');
const net = require('./net');
const mods = require('./mods');
const zip = require('./zip');

const TYPES = {
  resourcepack: { dir: 'resourcepacks', label: '资源包', modrinth: 'resourcepack' },
  shaderpack: { dir: 'shaderpacks', label: '光影', modrinth: 'shader' },
  datapack: { dir: 'datapacks', label: '数据包', modrinth: 'datapack' },
};

const MAX_PREVIEW_BYTES = 512 * 1024;
const MAX_NAME = 180;
const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

function typeInfo(type) {
  const info = TYPES[String(type || '')];
  if (!info) throw new Error('未知的内容类型');
  return info;
}

function safeName(value, fallback) {
  let base = path.basename(String(value || '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  if (!base) base = fallback || 'content.zip';
  return base.slice(0, MAX_NAME);
}

function rootOf(target) {
  if (!target || !target.gameDir) {
    const error = new Error('没有找到目标实例');
    error.code = 'NO_TARGET';
    throw error;
  }
  return path.resolve(String(target.gameDir));
}

function dirFor(target, type) {
  const info = typeInfo(type);
  const dir = path.join(rootOf(target), info.dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function relativeInside(base, value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel || rel.startsWith('../') || rel.split('/').includes('..') || path.isAbsolute(rel)) {
    throw new Error('非法的内容路径');
  }
  return rel;
}

function readOptions(root) {
  const file = path.join(root, 'options.txt');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { /* 新实例可能还没有 options.txt */ }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  let index = -1;
  let ids = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^resourcePacks:(.*)$/.exec(lines[i]);
    if (!match) continue;
    index = i;
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) ids = parsed.filter((item) => typeof item === 'string');
    } catch (err) { /* 忽略损坏的字段，按空列表处理 */ }
    break;
  }
  return { file, lines, index, ids, newline };
}

function writeResourcePacks(root, ids) {
  const options = readOptions(root);
  const line = `resourcePacks:${JSON.stringify(ids)}`;
  if (options.index >= 0) options.lines[options.index] = line;
  else options.lines.push(line);
  const text = options.lines.filter((item, index, list) => item !== '' || index < list.length - 1).join(options.newline);
  fs.writeFileSync(options.file, `${text}${options.newline}`, 'utf8');
}

function resourcePackId(name) {
  return `file/${String(name || '').replace(/\\/g, '/')}`;
}

function parsePackMeta(root, fileName) {
  const file = path.join(root, fileName);
  let meta = null;
  let icon = null;
  try {
    if (fs.statSync(file).isDirectory()) {
      const metaFile = path.join(file, 'pack.mcmeta');
      if (fs.existsSync(metaFile)) meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      const iconFile = path.join(file, 'pack.png');
      if (fs.existsSync(iconFile) && fs.statSync(iconFile).size <= MAX_PREVIEW_BYTES) icon = iconFile;
    } else if (/\.zip$/i.test(fileName)) {
      const entries = zip.readZipEntries(file, ['pack.mcmeta', 'pack.png'], { maxBytes: MAX_PREVIEW_BYTES });
      if (entries['pack.mcmeta']) {
        try { meta = JSON.parse(entries['pack.mcmeta'].toString('utf8')); } catch (err) { meta = null; }
      }
      if (entries['pack.png'] && entries['pack.png'].length <= MAX_PREVIEW_BYTES) icon = entries['pack.png'];
    }
  } catch (err) {
    meta = null;
  }
  const pack = meta && meta.pack && typeof meta.pack === 'object' ? meta.pack : {};
  let description = '';
  if (typeof pack.description === 'string') description = pack.description;
  else if (pack.description && typeof pack.description === 'object') {
    description = String(pack.description.text || pack.description.translate || '').trim();
  }
  return {
    description: description.slice(0, 300),
    packFormat: Number(pack.pack_format) || 0,
    icon,
  };
}

function iconDataUrl(icon) {
  if (!icon) return '';
  if (Buffer.isBuffer(icon)) {
    if (icon.length > MAX_PREVIEW_BYTES) return '';
    return `data:image/png;base64,${icon.toString('base64')}`;
  }
  try {
    if (fs.statSync(icon).size > MAX_PREVIEW_BYTES) return '';
    return `data:image/png;base64,${fs.readFileSync(icon).toString('base64')}`;
  } catch (err) {
    return '';
  }
}

function shaderInfo(filePath, fileName) {
  let hasShaders = false;
  try {
    const entries = zip.listZipEntries(filePath);
    const names = Array.isArray(entries) ? entries.map((item) => (typeof item === 'string' ? item : item.name || '')) : [];
    hasShaders = names.some((name) => /^shaders\//i.test(name) || /^shaders$/i.test(name));
  } catch (err) { /* 损坏的 zip 仍然可以显示，只是无法识别类型 */ }
  return {
    description: hasShaders ? 'Iris / OptiFine 光影包' : '未检测到 shaders/ 目录，可能不是光影包',
    packFormat: 0,
    icon: null,
  };
}

function readIrisConfig(root) {
  const file = path.join(root, 'config', 'iris.properties');
  let values = {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^([^=:#\s]+)\s*=\s*(.*)$/.exec(line);
      if (match) values[match[1]] = match[2];
    }
  } catch (err) { values = {}; }
  return { file, values };
}

function writeIrisShader(root, fileName) {
  const config = readIrisConfig(root);
  const file = config.file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const values = Object.assign({}, config.values);
  values.shaderPack = fileName || '';
  values.enableShaders = fileName ? 'true' : 'false';
  const order = ['shaderPack', 'enableShaders', ...Object.keys(values).filter((key) => key !== 'shaderPack' && key !== 'enableShaders')];
  const lines = order.filter((key) => Object.prototype.hasOwnProperty.call(values, key)).map((key) => `${key}=${values[key]}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function scanEntries(dir, options = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  return entries
    .filter((entry) => !entry.name.startsWith('.'))
    .filter((entry) => entry.isDirectory() || /\.(zip|jar)(\.disabled)?$/i.test(entry.name) || /\.(zip|jar)(\.disabled)?$/i.test(entry.name))
    .filter((entry) => options.allowDisabled || !/\.disabled$/i.test(entry.name))
    .map((entry) => {
      const filePath = path.join(dir, entry.name);
      let stat = null;
      try { stat = fs.statSync(filePath); } catch (err) { stat = null; }
      return {
        fileName: entry.name,
        baseName: entry.name.replace(/\.disabled$/i, ''),
        disabledByName: /\.disabled$/i.test(entry.name),
        isDirectory: entry.isDirectory(),
        path: filePath,
        size: stat ? (entry.isDirectory() ? 0 : stat.size) : 0,
        modified: stat ? stat.mtimeMs : 0,
      };
    })
    .filter((entry) => entry.isDirectory || /\.(zip|jar)$/i.test(entry.baseName))
    .sort((a, b) => a.baseName.localeCompare(b.baseName, 'zh-CN'));
}

function resourcepackList(target) {
  const root = rootOf(target);
  const dir = ensureDir(path.join(root, 'resourcepacks'));
  const options = readOptions(root);
  const enabledIds = new Set(options.ids.map((item) => String(item).replace(/\\/g, '/')));
  return scanEntries(dir, { allowDisabled: true }).map((entry) => {
    const id = resourcePackId(entry.baseName);
    const meta = parsePackMeta(dir, entry.baseName);
    return {
      type: 'resourcepack',
      id: entry.baseName,
      name: entry.baseName.replace(/\.zip$/i, ''),
      fileName: entry.fileName,
      baseName: entry.baseName,
      path: entry.path,
      kind: entry.isDirectory ? 'directory' : 'file',
      enabled: !entry.disabledByName && (enabledIds.has(id) || enabledIds.has(entry.baseName)),
      canToggle: true,
      size: entry.size,
      modified: entry.modified,
      description: meta.description,
      packFormat: meta.packFormat,
      icon: iconDataUrl(meta.icon),
      scope: 'instance',
      world: '',
    };
  });
}

function shaderpackList(target) {
  const root = rootOf(target);
  const dir = ensureDir(path.join(root, 'shaderpacks'));
  const iris = readIrisConfig(root);
  const selected = String(iris.values.shaderPack || '').trim();
  const hasConfig = fs.existsSync(iris.file);
  return scanEntries(dir, { allowDisabled: true }).map((entry) => {
    const meta = shaderInfo(entry.path, entry.baseName);
    return {
      type: 'shaderpack',
      id: entry.baseName,
      name: entry.baseName.replace(/\.zip$/i, ''),
      fileName: entry.fileName,
      baseName: entry.baseName,
      path: entry.path,
      kind: entry.isDirectory ? 'directory' : 'file',
      enabled: !entry.disabledByName && Boolean(selected) && (selected === entry.baseName || selected === entry.fileName),
      canToggle: true,
      hasConfig,
      size: entry.size,
      modified: entry.modified,
      description: meta.description,
      packFormat: meta.packFormat,
      icon: iconDataUrl(meta.icon),
      scope: 'instance',
      world: '',
    };
  });
}

function datapackSources(root, world) {
  const sources = [];
  const base = world ? path.join(root, 'saves', world) : root;
  if (world) {
    const saveDir = path.join(root, 'saves', world);
    if (!fs.existsSync(saveDir)) throw new Error('世界存档不存在');
  }
  sources.push({
    scope: world ? 'world' : 'instance',
    world: world || '',
    enabledDir: path.join(base, 'datapacks'),
    disabledDir: path.join(base, 'datapacks-disabled'),
    label: world ? `世界“${world}”` : '实例全局',
  });
  return sources;
}

function listWorlds(root) {
  const dir = path.join(root, 'saves');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return []; }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .filter((entry) => fs.existsSync(path.join(dir, entry.name, 'level.dat')))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function datapackList(target, options = {}) {
  const root = rootOf(target);
  const worlds = options.world ? [String(options.world)] : listWorlds(root);
  const sources = [{ scope: 'instance', world: '', enabledDir: path.join(root, 'datapacks'), disabledDir: path.join(root, 'datapacks-disabled'), label: '实例全局' }];
  for (const world of worlds) {
    sources.push({
      scope: 'world',
      world,
      enabledDir: path.join(root, 'saves', world, 'datapacks'),
      disabledDir: path.join(root, 'saves', world, 'datapacks-disabled'),
      label: `世界“${world}”`,
    });
  }
  const result = [];
  for (const source of sources) {
    for (const state of ['enabled', 'disabled']) {
      const dir = state === 'enabled' ? source.enabledDir : source.disabledDir;
      const entries = scanEntries(ensureDir(dir), { allowDisabled: true });
      for (const entry of entries) {
        const meta = parsePackMeta(dir, entry.baseName);
        result.push({
          type: 'datapack',
          id: `${source.scope}:${source.world}:${entry.baseName}`,
          name: entry.baseName.replace(/\.zip$/i, ''),
          fileName: entry.fileName,
          baseName: entry.baseName,
          path: entry.path,
          kind: entry.isDirectory ? 'directory' : 'file',
          enabled: state === 'enabled' && !entry.disabledByName,
          canToggle: true,
          size: entry.size,
          modified: entry.modified,
          description: meta.description,
          packFormat: meta.packFormat,
          icon: iconDataUrl(meta.icon),
          scope: source.scope,
          world: source.world,
          scopeLabel: source.label,
          dir,
        });
      }
    }
  }
  return result.sort((a, b) => a.scopeLabel.localeCompare(b.scopeLabel, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN'));
}

function list(target, type, options = {}) {
  if (type === 'resourcepack') return resourcepackList(target);
  if (type === 'shaderpack') return shaderpackList(target);
  if (type === 'datapack') return datapackList(target, options);
  throw new Error('未知的内容类型');
}

function findEntry(target, type, id, options = {}) {
  const items = list(target, type, options);
  const item = items.find((entry) => entry.id === id || entry.fileName === id || entry.name === id);
  if (!item) throw new Error('内容不存在，请刷新列表');
  return item;
}

function setEnabled(target, type, id, enabled, options = {}) {
  const root = rootOf(target);
  const items = list(target, type, options);
  const matches = items.filter((entry) => entry.id === id || entry.fileName === id || entry.name === id);
  const item = matches.find((entry) => Boolean(entry.enabled) !== Boolean(enabled)) || matches[0];
  if (!item) throw new Error('内容不存在，请刷新列表');
  if (type === 'resourcepack') {
    const optionsFile = readOptions(root);
    let fileName = item.fileName;
    if (enabled && item.fileName.endsWith('.disabled')) {
      const next = path.join(path.dirname(item.path || path.join(root, 'resourcepacks')), item.baseName);
      fs.renameSync(item.path, next);
      fileName = item.baseName;
    } else if (!enabled && !fileName.endsWith('.disabled')) {
      const next = `${item.path}.disabled`;
      fs.renameSync(item.path, next);
      fileName = `${fileName}.disabled`;
    }
    const ids = new Set(optionsFile.ids);
    ids.delete(resourcePackId(item.baseName));
    ids.delete(item.baseName);
    if (enabled) ids.add(resourcePackId(fileName.replace(/\.disabled$/i, '')));
    writeResourcePacks(root, Array.from(ids));
    return { ok: true, enabled: Boolean(enabled) };
  }
  if (type === 'shaderpack') {
    const fileName = item.baseName;
    writeIrisShader(root, enabled ? fileName : '');
    return { ok: true, enabled: Boolean(enabled), file: path.join(root, 'config', 'iris.properties') };
  }
  if (type === 'datapack') {
    if (item.scope !== 'instance' && item.scope !== 'world') throw new Error('不支持的数据包来源');
    const base = item.scope === 'world' ? path.join(root, 'saves', item.world) : root;
    const from = enabled ? path.join(base, 'datapacks-disabled', item.fileName) : path.join(base, 'datapacks', item.fileName);
    const toDir = enabled ? path.join(base, 'datapacks') : path.join(base, 'datapacks-disabled');
    const to = path.join(toDir, item.fileName);
    if (!fs.existsSync(from)) throw new Error('数据包文件不存在，请刷新列表');
    ensureDir(toDir);
    if (fs.existsSync(to)) throw new Error('目标目录已经有同名数据包');
    fs.renameSync(from, to);
    return { ok: true, enabled: Boolean(enabled), path: to };
  }
  throw new Error('未知的内容类型');
}

function importBuffer(target, type, buffer, fileName, options = {}) {
  const info = typeInfo(type);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('内容文件为空');
  if (buffer.length > MAX_IMPORT_BYTES) throw new Error('内容文件不能超过 200 MB');
  const name = safeName(fileName, 'content.zip');
  if (!/\.zip$/i.test(name)) throw new Error('请选择 .zip 格式的内容包');
  const dir = dirFor(target, type);
  const destination = path.join(dir, name);
  if (fs.existsSync(destination) && !options.overwrite) {
    const error = new Error(`“${name}”已经存在`);
    error.code = 'CONTENT_EXISTS';
    throw error;
  }
  if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
  fs.writeFileSync(destination, buffer);
  logger.info('导入内容包:', info.label, name);
  return { ok: true, fileName: name, path: destination };
}

function importFile(target, type, sourcePath, options = {}) {
  const source = path.resolve(String(sourcePath || ''));
  let stat;
  try { stat = fs.statSync(source); } catch (err) { throw new Error('选择的文件不存在'); }
  if (!stat.isFile()) throw new Error('请选择文件而不是文件夹');
  if (stat.size > MAX_IMPORT_BYTES) throw new Error('内容文件不能超过 200 MB');
  const buffer = fs.readFileSync(source);
  return importBuffer(target, type, buffer, options.name || path.basename(source), options);
}

function preview(target, type, id, options = {}) {
  const item = findEntry(target, type, id, options);
  const dir = type === 'resourcepack'
    ? path.join(rootOf(target), 'resourcepacks')
    : type === 'shaderpack'
      ? path.join(rootOf(target), 'shaderpacks')
      : path.dirname(item.path || path.join(rootOf(target), 'datapacks'));
  const meta = parsePackMeta(dir, item.baseName);
  return {
    ok: true,
    name: item.name,
    description: meta.description,
    packFormat: meta.packFormat,
    icon: iconDataUrl(meta.icon),
    path: item.path || '',
  };
}

function trashDir() {
  const dir = path.join(config.root(), 'content-trash');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function remove(target, type, id, options = {}) {
  const item = findEntry(target, type, id, options);
  if (!item.path || !fs.existsSync(item.path)) throw new Error('内容文件不存在，请刷新列表');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const targetDir = path.join(trashDir(), `${stamp}-${type}`);
  fs.mkdirSync(targetDir, { recursive: true });
  const destination = path.join(targetDir, item.fileName);
  try {
    fs.renameSync(item.path, destination);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // 游戏目录可能在另一个磁盘，跨卷 rename 会失败；先完整复制再删除。
    if (fs.statSync(item.path).isDirectory()) {
      fs.cpSync(item.path, destination, { recursive: true, errorOnExist: true });
      fs.rmSync(item.path, { recursive: true, force: false });
    } else {
      fs.copyFileSync(item.path, destination, fs.constants.COPYFILE_EXCL);
      fs.rmSync(item.path, { force: false });
    }
  }
  return { ok: true, trashedTo: destination, name: item.name };
}

function openDir(target, type) {
  const info = typeInfo(type);
  const dir = path.join(rootOf(target), info.dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function searchModrinth(target, type, options = {}) {
  const info = typeInfo(type);
  const result = await mods.search({
    query: options.query,
    gameVersion: options.gameVersion || target.mcVersion || '',
    projectType: info.modrinth,
    limit: options.limit,
    offset: options.offset,
  });
  return Object.assign(result, { contentLabel: info.label });
}

async function installModrinth(target, type, options = {}, hooks = {}) {
  const info = typeInfo(type);
  const projectId = String(options.projectId || '').trim();
  if (!projectId) throw new Error('缺少 Modrinth 项目 ID');
  const gameVersion = String(options.gameVersion || target.mcVersion || '').trim();
  let version = null;
  if (options.versionId) {
    version = await mods.getVersion(String(options.versionId));
  } else {
    const found = await mods.getVersions({ projectId, gameVersion });
    version = found.versions.find((entry) => /\.zip$/i.test((entry.file && entry.file.filename) || '')) || found.versions[0] || null;
  }
  if (!version || !version.file || !version.file.url) throw new Error('该内容没有可下载的文件');
  const fileName = safeName(version.file.filename || `${version.projectId || projectId}.zip`, 'content.zip');
  if (!/\.zip$/i.test(fileName)) throw new Error('Modrinth 返回的文件不是 .zip，无法作为游戏内容安装');
  const dir = dirFor(target, type);
  const destination = path.join(dir, fileName);
  if (hooks.onProgress) hooks.onProgress({ phase: 'download', message: `正在下载 ${fileName}`, percent: 0 });
  await net.downloadFile(version.file.url, destination, {
    sha1: version.file.sha1 || null,
    retries: 2,
    onBytes: (bytes) => {
      if (!hooks.onProgress) return;
      const total = Number(version.file.size) || 0;
      hooks.onProgress({
        phase: 'download',
        message: `正在下载 ${fileName}`,
        received: bytes,
        bytes: total,
        percent: total ? Math.min(99, Math.floor((bytes / total) * 100)) : 0,
      });
    },
  });
  if (hooks.onProgress) hooks.onProgress({ phase: 'done', message: `已安装 ${fileName}`, percent: 100 });
  let enabled = false;
  if (options.enable && (type === 'resourcepack' || type === 'shaderpack')) {
    const listItems = list(target, type);
    const item = listItems.find((entry) => entry.fileName === fileName);
    if (item) {
      setEnabled(target, type, item.id, true);
      enabled = true;
    }
  }
  return {
    ok: true,
    fileName,
    path: destination,
    enabled,
    projectId,
    versionId: version.id,
    title: version.name || projectId,
    type,
    label: info.label,
  };
}

module.exports = {
  TYPES,
  list,
  setEnabled,
  importFile,
  importBuffer,
  preview,
  remove,
  openDir,
  searchModrinth,
  installModrinth,
  listWorlds,
};