'use strict';

const crypto = require('crypto');

/**
 * 生成 Java 版离线模式 UUID（与 UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes()) 一致）。
 */
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isValidName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(name);
}

function offlineProfile(name) {
  const safeName = isValidName(name) ? name : 'Steve';
  return {
    name: safeName,
    uuid: offlineUuid(safeName),
    accessToken: crypto.randomBytes(16).toString('hex'),
    userType: 'legacy',
    mode: 'offline',
  };
}

module.exports = { offlineUuid, offlineProfile, isValidName };