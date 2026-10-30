'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const logger = require('./logger');
const accounts = require('./accounts');

/**
 * 本地皮肤 / 披风库。
 * 图片只保存在启动器数据目录，不上传到任何服务器；
 * 离线账户也可以导入、预览和切换本地形象。
 */

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_ITEMS = 60;

function libraryDir() {
  return path.join(config.root(), 'skins');
}

function fileFor(file) {
  return path.join(libraryDir(), path.basename(String(file || '')));
}

function indexFile() {
  return path.join(libraryDir(), 'index.json');
}

function ensureDir() {
  fs.mkdirSync(libraryDir(), { recursive: true });
}

function emptyIndex() {
  return { version: 1, activeSkin: '', activeCape: '', items: [] };
}

function safeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind !== 'skin' && raw.kind !== 'cape') return null;
  const id = String(raw.id || '').replace(/[^a-f0-9]/gi, '').slice(0, 32);
  const file = path.basename(String(raw.file || ''));
  if (!id || !file || !/\.png$/i.test(file)) return null;
  return {
    id,
    kind: raw.kind,
    name: String(raw.name || '').slice(0, 48) || (raw.kind === 'skin' ? '未命名皮肤' : '未命名披风'),
    file,
    width: Number(raw.width) || 64,
    height: Number(raw.height) || (raw.kind === 'cape' ? 32 : 64),
    model: raw.kind === 'skin' && raw.model === 'slim' ? 'slim' : 'classic',
    createdAt: Number(raw.createdAt) || Date.now(),
    bytes: Number(raw.bytes) || 0,
  };
}

function readIndex() {
  ensureDir();
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    const result = emptyIndex();
    result.activeSkin = String(raw.activeSkin || '');
    result.activeCape = String(raw.activeCape || '');
    result.items = Array.isArray(raw.items) ? raw.items.map(safeItem).filter(Boolean) : [];
    return result;
  } catch (err) {
    return emptyIndex();
  }
}

function writeIndex(data) {
  ensureDir();
  const file = indexFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function parseDataUrl(value) {
  const text = String(value || '');
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(text);
  if (!match) throw new Error('请选择 PNG 格式的皮肤或披风图片');
  const buffer = Buffer.from(match[1].replace(/\s/g, ''), 'base64');
  if (!buffer.length) throw new Error('图片内容为空');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图片不能超过 6 MB');
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('文件不是有效的 PNG 图片');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { buffer, width, height };
}

function validateDimensions(kind, width, height) {
  if (kind === 'skin') {
    const ok = (width === 64 && (height === 64 || height === 32))
      || (width === 128 && height === 128);
    if (!ok) throw new Error('皮肤尺寸应为 64×64（推荐）或 64×32，支持 128×128 高清皮肤');
    return;
  }
  const ok = (width === 64 && (height === 32 || height === 64)) || (width === 128 && height === 64);
  if (!ok) throw new Error('披风尺寸应为 64×32，支持 128×64 高清披风');
}

function publicItems(items, kind) {
  return items
    .filter((item) => item.kind === kind)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((item) => {
      let dataUrl = '';
      try {
        const file = fileFor(item.file);
        if (fs.existsSync(file)) {
          const stat = fs.statSync(file);
          if (stat.size <= MAX_IMAGE_BYTES) {
            dataUrl = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
          }
        }
      } catch (err) {
        logger.warn('读取皮肤图片失败:', item.file, err.message);
      }
      return Object.assign({}, item, { dataUrl });
    });
}

function accountSkin() {
  try {
    const state = accounts.summary();
    if (!state || !state.authenticated) return null;
    return {
      name: state.name || '',
      uuid: state.uuid || '',
      skin: state.skin || '',
      capes: Array.isArray(state.capes) ? state.capes : [],
    };
  } catch (err) {
    return null;
  }
}

function list() {
  const data = readIndex();
  const skins = publicItems(data.items, 'skin');
  const capes = publicItems(data.items, 'cape');
  const activeSkin = skins.find((item) => item.id === data.activeSkin) || null;
  const activeCape = capes.find((item) => item.id === data.activeCape) || null;
  return {
    ok: true,
    skins,
    capes,
    activeSkin: activeSkin ? activeSkin.id : '',
    activeCape: activeCape ? activeCape.id : '',
    activeSkinModel: activeSkin ? activeSkin.model : 'classic',
    account: accountSkin(),
  };
}

function importData(payload = {}) {
  const kind = payload.kind === 'cape' ? 'cape' : 'skin';
  const parsed = parseDataUrl(payload.dataUrl);
  validateDimensions(kind, parsed.width, parsed.height);

  const data = readIndex();
  if (data.items.length >= MAX_ITEMS) throw new Error('本地图库已满，请先删除一些皮肤或披风');

  const id = crypto.randomBytes(8).toString('hex');
  const rawName = String(payload.name || '').replace(/\.[^.]+$/, '').trim();
  const item = {
    id,
    kind,
    name: (rawName || (kind === 'skin' ? '本地皮肤' : '本地披风')).slice(0, 48),
    file: `${kind}-${id}.png`,
    width: parsed.width,
    height: parsed.height,
    model: kind === 'skin' && payload.model === 'slim' ? 'slim' : 'classic',
    createdAt: Date.now(),
    bytes: parsed.buffer.length,
  };
  ensureDir();
  fs.writeFileSync(fileFor(item.file), parsed.buffer);
  data.items.push(item);
  if (kind === 'skin') data.activeSkin = item.id;
  else data.activeCape = item.id;
  writeIndex(data);
  logger.info('已导入本地形象:', kind, item.name, `${parsed.width}x${parsed.height}`);
  return Object.assign(list(), { imported: item });
}

function setActive(kind, id, model) {
  const type = kind === 'cape' ? 'cape' : 'skin';
  const data = readIndex();
  const item = data.items.find((candidate) => candidate.kind === type && candidate.id === id);
  if (!item) throw new Error(type === 'skin' ? '找不到这个皮肤' : '找不到这个披风');
  if (type === 'skin' && model === 'slim') item.model = 'slim';
  if (type === 'skin' && model === 'classic') item.model = 'classic';
  if (type === 'skin') data.activeSkin = item.id;
  else data.activeCape = item.id;
  writeIndex(data);
  return list();
}

function clearActive(kind) {
  const type = kind === 'cape' ? 'cape' : 'skin';
  const data = readIndex();
  if (type === 'skin') data.activeSkin = '';
  else data.activeCape = '';
  writeIndex(data);
  return list();
}

function remove(kind, id) {
  const type = kind === 'cape' ? 'cape' : 'skin';
  const data = readIndex();
  const item = data.items.find((candidate) => candidate.kind === type && candidate.id === id);
  if (!item) throw new Error('找不到要删除的形象');
  data.items = data.items.filter((candidate) => candidate !== item);
  try {
    fs.rmSync(fileFor(item.file), { force: true });
  } catch (err) {
    logger.warn('删除皮肤文件失败:', err.message);
  }
  if (type === 'skin' && data.activeSkin === id) data.activeSkin = '';
  if (type === 'cape' && data.activeCape === id) data.activeCape = '';
  writeIndex(data);
  return list();
}

function rename(kind, id, name) {
  const type = kind === 'cape' ? 'cape' : 'skin';
  const value = String(name || '').replace(/[\r\n]/g, ' ').trim().slice(0, 48);
  if (!value) throw new Error('名称不能为空');
  const data = readIndex();
  const item = data.items.find((candidate) => candidate.kind === type && candidate.id === id);
  if (!item) throw new Error('找不到这个形象');
  item.name = value;
  writeIndex(data);
  return list();
}

module.exports = {
  list,
  importData,
  setActive,
  clearActive,
  remove,
  rename,
  libraryDir,
};
