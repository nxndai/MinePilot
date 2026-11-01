'use strict';

/**
 * 最小 NBT 读取器，只用于 level.dat 里的世界名称、最后游玩时间和版本。
 *
 * 支持 gzip / zlib 压缩与未压缩 NBT，支持所有基础标签类型。为了避免
 * 恶意或损坏的 level.dat 消耗过多内存，数组长度和读取位置都做了限制。
 */

const zlib = require('zlib');

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

const MAX_DEPTH = 24;
const MAX_STRING = 1024 * 1024;
const MAX_COLLECTION = 1024 * 1024;
const MAX_INPUT = 8 * 1024 * 1024;

function decompress(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('NBT 数据为空');
  if (buffer.length > MAX_INPUT) throw new Error('level.dat 过大');
  // gzip: 1f 8b；zlib: 78 xx。未压缩的 NBT 直接从根标签开始。
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return zlib.gunzipSync(buffer, { maxOutputLength: MAX_INPUT });
  }
  if (buffer[0] === 0x78) {
    return zlib.inflateSync(buffer, { maxOutputLength: MAX_INPUT });
  }
  return buffer;
}

class Reader {
  constructor(buffer) {
    this.buf = buffer;
    this.pos = 0;
  }

  need(bytes) {
    if (this.pos + bytes > this.buf.length) throw new Error('NBT 数据不完整');
  }

  u8() {
    this.need(1);
    const value = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return value;
  }

  i8() {
    this.need(1);
    const value = this.buf.readInt8(this.pos);
    this.pos += 1;
    return value;
  }

  i16() {
    this.need(2);
    const value = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return value;
  }

  i32() {
    this.need(4);
    const value = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return value;
  }

  i64() {
    this.need(8);
    const value = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return value;
  }

  f32() {
    this.need(4);
    const value = this.buf.readFloatBE(this.pos);
    this.pos += 4;
    return value;
  }

  f64() {
    this.need(8);
    const value = this.buf.readDoubleBE(this.pos);
    this.pos += 8;
    return value;
  }

  string() {
    const length = this.i16();
    if (length < 0 || length > MAX_STRING) throw new Error('NBT 字符串长度异常');
    this.need(length);
    const value = this.buf.toString('utf8', this.pos, this.pos + length);
    this.pos += length;
    return value;
  }

  payload(type, depth) {
    if (depth > MAX_DEPTH) throw new Error('NBT 嵌套过深');
    switch (type) {
      case TAG_BYTE:
        return this.i8();
      case TAG_SHORT:
        return this.i16();
      case TAG_INT:
        return this.i32();
      case TAG_LONG:
        return this.i64();
      case TAG_FLOAT:
        return this.f32();
      case TAG_DOUBLE:
        return this.f64();
      case TAG_BYTE_ARRAY: {
        const length = this.i32();
        if (length < 0 || length > MAX_COLLECTION) throw new Error('NBT 字节数组长度异常');
        this.need(length);
        const value = Buffer.from(this.buf.subarray(this.pos, this.pos + length));
        this.pos += length;
        return value;
      }
      case TAG_STRING:
        return this.string();
      case TAG_LIST: {
        const itemType = this.u8();
        const length = this.i32();
        if (length < 0 || length > MAX_COLLECTION) throw new Error('NBT 列表长度异常');
        const list = [];
        for (let index = 0; index < length; index += 1) {
          list.push(this.payload(itemType, depth + 1));
        }
        return list;
      }
      case TAG_COMPOUND: {
        const object = {};
        for (;;) {
          const childType = this.u8();
          if (childType === TAG_END) break;
          const name = this.string();
          // 防止 __proto__ 等特殊键污染普通对象。
          Object.defineProperty(object, name, {
            value: this.payload(childType, depth + 1),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        return object;
      }
      case TAG_INT_ARRAY: {
        const length = this.i32();
        if (length < 0 || length > MAX_COLLECTION) throw new Error('NBT 整数数组长度异常');
        this.need(length * 4);
        const list = [];
        for (let index = 0; index < length; index += 1) {
          list.push(this.i32());
        }
        return list;
      }
      case TAG_LONG_ARRAY: {
        const length = this.i32();
        if (length < 0 || length > MAX_COLLECTION) throw new Error('NBT 长整数数组长度异常');
        this.need(length * 8);
        const list = [];
        for (let index = 0; index < length; index += 1) {
          list.push(this.i64());
        }
        return list;
      }
      default:
        throw new Error(`未知 NBT 标签类型：${type}`);
    }
  }
}

function parse(buffer) {
  const data = decompress(buffer);
  const reader = new Reader(data);
  const type = reader.u8();
  if (type === TAG_END) return {};
  reader.string(); // 根标签名通常为空
  return reader.payload(type, 0);
}

module.exports = { parse };