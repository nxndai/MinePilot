'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');
const logger = require('./logger');

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function themeDir() {
  return path.join(config.root(), 'theme');
}

function backgroundFile() {
  return path.join(themeDir(), 'background.bin');
}

function backgroundMeta() {
  return path.join(themeDir(), 'background.json');
}

function ensureDir() {
  fs.mkdirSync(themeDir(), { recursive: true });
}

function clearBackground() {
  try {
    fs.rmSync(backgroundFile(), { force: true });
    fs.rmSync(backgroundMeta(), { force: true });
    return { ok: true };
  } catch (err) {
    logger.warn('清除背景图失败:', err.message);
    return { ok: false, error: err.message };
  }
}

function hasImageSignature(buffer, mime) {
  if (!buffer || buffer.length < 12) return false;
  if (mime === 'image/png') {
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
      && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
  }
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/gif') return buffer.slice(0, 6).toString('ascii') === 'GIF87a' || buffer.slice(0, 6).toString('ascii') === 'GIF89a';
  if (mime === 'image/webp') return buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function setBackgroundData(payload = {}) {
  const raw = String(payload.dataUrl || '');
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(raw);
  if (!match) throw new Error('背景图片仅支持 PNG、JPG、WebP 或 GIF');
  const mime = match[1].toLowerCase();
  const ext = ALLOWED[mime];
  if (!ext) throw new Error('不支持的背景图片格式');
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) throw new Error('背景图片内容为空');
  if (buffer.length > MAX_BYTES) throw new Error('背景图片不能超过 12 MB');
  if (!hasImageSignature(buffer, mime)) throw new Error('图片文件已损坏或格式与扩展名不符');
  ensureDir();
  fs.writeFileSync(backgroundFile(), buffer);
  fs.writeFileSync(backgroundMeta(), JSON.stringify({ mime, ext, bytes: buffer.length, savedAt: Date.now() }, null, 2), 'utf8');
  logger.info('已保存自定义背景图:', `${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
  return background();
}

function background() {
  try {
    if (!fs.existsSync(backgroundFile())) return { ok: true, dataUrl: '', mime: '', bytes: 0 };
    const meta = JSON.parse(fs.readFileSync(backgroundMeta(), 'utf8'));
    const mime = ALLOWED[meta.mime] ? meta.mime : 'image/png';
    const data = fs.readFileSync(backgroundFile());
    return {
      ok: true,
      dataUrl: `data:${mime};base64,${data.toString('base64')}`,
      mime,
      bytes: data.length,
    };
  } catch (err) {
    logger.warn('读取自定义背景图失败:', err.message);
    return { ok: false, dataUrl: '', mime: '', bytes: 0, error: err.message };
  }
}

module.exports = {
  themeDir,
  backgroundFile,
  setBackgroundData,
  clearBackground,
  background,
};
