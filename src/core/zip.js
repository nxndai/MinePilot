'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function safeJoin(root, name) {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.includes('../')) {
    throw new Error(`压缩包内包含非法路径：${name}`);
  }
  const target = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new Error(`压缩包内包含非法路径：${name}`);
  }
  return target;
}

/**
 * 轻量 ZIP 解压（支持 store / deflate，足够用于游戏依赖与 JRE）。
 */
function extractZip(zipPath, targetDir, options = {}) {
  const { filter = null, onEntry = null, maxOutputLength = 1024 * 1024 * 1024 } = options;
  const buffer = fs.readFileSync(zipPath);
  let eocd = -1;
  const minPos = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minPos; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  let pointer = centralOffset;
  let extracted = 0;

  fs.mkdirSync(targetDir, { recursive: true });

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('ZIP 目录结构损坏');
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    pointer += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/') || name.endsWith('\\')) {
      fs.mkdirSync(safeJoin(targetDir, name), { recursive: true });
      continue;
    }
    if (filter && !filter(name)) continue;

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = zlib.inflateRawSync(compressed, { maxOutputLength });
    else throw new Error(`不支持的压缩方式：${method}`);

    if (uncompressedSize && data.length !== uncompressedSize) {
      // 某些压缩包未写入正确大小，忽略此校验
    }

    const target = safeJoin(targetDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    extracted += 1;
    if (onEntry) onEntry(name, extracted);
  }
  return extracted;
}

module.exports = { extractZip };


/* ---------------------------------------------------------------------------
 * ZIP 读取辅助：不把整个压缩包解压到磁盘即可读取根目录清单。
 * ------------------------------------------------------------------------- */

function findEocd(buffer) {
  const minPos = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minPos; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function zipEntriesFromBuffer(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  let pointer = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== 0x02014b50) {
      throw new Error('ZIP 目录结构损坏');
    }
    const flags = buffer.readUInt16LE(pointer + 8);
    const method = buffer.readUInt16LE(pointer + 10);
    const crc = buffer.readUInt32LE(pointer + 16);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readRange(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (!read) throw new Error('ZIP 文件被截断');
    offset += read;
  }
  return buffer;
}

function centralEntriesFromFile(fd, fileSize) {
  const tailLength = Math.min(fileSize, 65557);
  const tail = readRange(fd, fileSize - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const entryCount = tail.readUInt16LE(eocd + 10);
  const centralSize = tail.readUInt32LE(eocd + 12);
  const centralOffset = tail.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > fileSize) throw new Error('ZIP 目录结构损坏');
  const central = readRange(fd, centralOffset, centralSize);
  const entries = [];
  let pointer = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (pointer + 46 > central.length || central.readUInt32LE(pointer) !== 0x02014b50) {
      throw new Error('ZIP 目录结构损坏');
    }
    const flags = central.readUInt16LE(pointer + 8);
    const method = central.readUInt16LE(pointer + 10);
    const crc = central.readUInt32LE(pointer + 16);
    const compressedSize = central.readUInt32LE(pointer + 20);
    const uncompressedSize = central.readUInt32LE(pointer + 24);
    const nameLength = central.readUInt16LE(pointer + 28);
    const extraLength = central.readUInt16LE(pointer + 30);
    const commentLength = central.readUInt16LE(pointer + 32);
    const localOffset = central.readUInt32LE(pointer + 42);
    const name = central.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function listZipEntries(zipPath) {
  const stat = fs.statSync(zipPath);
  const fd = fs.openSync(zipPath, 'r');
  try {
    return centralEntriesFromFile(fd, stat.size).map((entry) => ({
      name: entry.name,
      size: entry.uncompressedSize,
      method: entry.method,
    }));
  } finally {
    fs.closeSync(fd);
  }
}

function readZipEntry(zipPath, entryName, options = {}) {
  const maxBytes = Number(options.maxBytes) || 8 * 1024 * 1024;
  const wanted = String(entryName || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const stat = fs.statSync(zipPath);
  const fd = fs.openSync(zipPath, 'r');
  try {
    const entries = centralEntriesFromFile(fd, stat.size);
    const entry = entries.find((item) => item.name.replace(/^\.\//, '') === wanted);
    if (!entry) return null;
    if (entry.uncompressedSize > maxBytes) throw new Error(`ZIP 内文件过大：${entryName}`);
    if (entry.compressedSize > maxBytes * 4 + 1024 * 1024) throw new Error(`ZIP 内文件过大：${entryName}`);
    const local = readRange(fd, entry.localOffset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏');
    const localNameLength = local.readUInt16LE(26);
    const localExtraLength = local.readUInt16LE(28);
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
    const compressed = readRange(fd, dataStart, entry.compressedSize);
    if (entry.method === 0) return Buffer.from(compressed);
    if (entry.method === 8) return zlib.inflateRawSync(compressed);
    throw new Error(`不支持的压缩方式：${entry.method}`);
  } finally {
    fs.closeSync(fd);
  }
}

function readZipEntries(zipPath, names, options = {}) {
  const wanted = new Set((names || []).map((name) => String(name).replace(/^\.\//, '')));
  const maxBytes = Number(options.maxBytes) || 8 * 1024 * 1024;
  const stat = fs.statSync(zipPath);
  const fd = fs.openSync(zipPath, 'r');
  const result = {};
  try {
    const entries = centralEntriesFromFile(fd, stat.size);
    for (const entry of entries) {
      const name = entry.name.replace(/^\.\//, '');
      if (!wanted.has(name) || result[name]) continue;
      if (entry.uncompressedSize > maxBytes) continue;
      if (entry.compressedSize > maxBytes * 4 + 1024 * 1024) continue;
      const local = readRange(fd, entry.localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏');
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
      const compressed = readRange(fd, dataStart, entry.compressedSize);
      if (entry.method === 0) result[name] = Buffer.from(compressed);
      else if (entry.method === 8) result[name] = zlib.inflateRawSync(compressed);
    }
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------------------------------------------------------------------------
 * ZIP 写入：store 模式（不压缩），用于导出整合包，避免引入第三方依赖。
 * ------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Buffer(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(value) {
  const d = value ? new Date(value) : new Date();
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

function normalizeZipName(value) {
  const name = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!name || name.includes('\0')) throw new Error('压缩包条目名不能为空');
  const parts = name.split('/');
  if (parts.some((part) => part === '..')) throw new Error(`压缩包条目包含非法路径：${name}`);
  return parts.filter((part) => part && part !== '.').join('/');
}

function crc32FileChunks(filePath, onChunk) {
  const fd = fs.openSync(filePath, 'r');
  let crc = 0xffffffff;
  let size = 0;
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!read) break;
      size += read;
      const slice = chunk.subarray(0, read);
      for (let i = 0; i < slice.length; i += 1) crc = CRC_TABLE[(crc ^ slice[i]) & 0xff] ^ (crc >>> 8);
      if (onChunk) onChunk(slice);
    }
  } finally {
    fs.closeSync(fd);
  }
  return { crc: (crc ^ 0xffffffff) >>> 0, size };
}

function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function localHeader(entry) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(entry.method || 0, 8);
  header.writeUInt16LE(entry.time, 10);
  header.writeUInt16LE(entry.date, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressedSize, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, entry.nameBuffer]);
}

function centralHeader(entry) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(entry.method || 0, 10);
  header.writeUInt16LE(entry.time, 12);
  header.writeUInt16LE(entry.date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([header, entry.nameBuffer]);
}

/**
 * 创建一个 ZIP。entries: [{name, filePath, data, mtime}]
 * 默认 store 模式；options.compress=true 时使用 deflate（安装包用）。
 */
function createZip(entries, outputPath, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const onEntry = typeof options.onEntry === 'function' ? options.onEntry : null;
  const compress = options.compress === true;
  const outDir = path.dirname(path.resolve(outputPath));
  fs.mkdirSync(outDir, { recursive: true });
  const temp = `${outputPath}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w');
  const central = [];
  const seen = new Set();
  let offset = 0;
  let totalBytes = 0;
  try {
    for (const raw of list) {
      const name = normalizeZipName(raw && raw.name);
      if (seen.has(name)) throw new Error(`压缩包条目重复：${name}`);
      seen.add(name);
      const nameBuffer = Buffer.from(name, 'utf8');
      const dt = dosDateTime(raw && raw.mtime);
      let content = null;
      if (raw && raw.data != null) {
        content = Buffer.isBuffer(raw.data) ? raw.data : Buffer.from(String(raw.data), 'utf8');
      } else if (raw && raw.filePath) {
        // 压缩时必须先读入内存；store 模式仍使用流式读取。
        if (compress) content = fs.readFileSync(raw.filePath);
      } else {
        throw new Error(`压缩包条目没有内容：${name}`);
      }
      let crc = 0;
      let size = 0;
      if (content) {
        crc = crc32Buffer(content);
        size = content.length;
      } else {
        const computed = crc32FileChunks(raw.filePath);
        crc = computed.crc;
        size = computed.size;
      }
      const stored = compress ? zlib.deflateRawSync(content, { level: 9 }) : content;
      const method = compress ? 8 : 0;
      const entry = {
        nameBuffer,
        crc,
        size,
        compressedSize: stored ? stored.length : size,
        method,
        time: dt.time,
        date: dt.date,
        offset,
      };
      writeAll(fd, localHeader(entry));
      if (stored) {
        writeAll(fd, stored);
      } else {
        const srcFd = fs.openSync(raw.filePath, 'r');
        try {
          const chunk = Buffer.allocUnsafe(1024 * 1024);
          for (;;) {
            const read = fs.readSync(srcFd, chunk, 0, chunk.length, null);
            if (!read) break;
            writeAll(fd, chunk.subarray(0, read));
          }
        } finally {
          fs.closeSync(srcFd);
        }
      }
      offset += 30 + nameBuffer.length + entry.compressedSize;
      totalBytes += size;
      central.push(entry);
      if (onEntry) onEntry(central.length, list.length, name);
    }
    const centralOffset = offset;
    for (const entry of central) {
      const header = centralHeader(entry);
      writeAll(fd, header);
      offset += header.length;
    }
    const centralSize = offset - centralOffset;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    eocd.writeUInt16LE(0, 20);
    writeAll(fd, eocd);
  } catch (err) {
    try { fs.closeSync(fd); } catch (e) { /* ignore */ }
    try { fs.rmSync(temp, { force: true }); } catch (e) { /* ignore */ }
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.rmSync(outputPath, { force: true });
    fs.renameSync(temp, outputPath);
  } catch (err) {
    try { fs.rmSync(temp, { force: true }); } catch (e) { /* ignore */ }
    throw err;
  }
  return { path: outputPath, entries: list.length, bytes: totalBytes };
}

module.exports = { extractZip, listZipEntries, readZipEntry, readZipEntries, createZip };
