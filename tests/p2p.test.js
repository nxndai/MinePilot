'use strict';

/**
 * P2P 模块的纯逻辑测试（不联网、不建 DHT）：
 * 房间码清洗/校验、默认端口、初始状态。
 */

const assert = require('assert');
const path = require('path');

const p2p = require(path.join(__dirname, '..', 'src', 'core', 'p2p'));

const key = 'a'.repeat(64);

// 清洗：去掉空格、短横线、大写统一
assert.strictEqual(p2p.normalizeRoomCode(key), key);
assert.strictEqual(p2p.normalizeRoomCode(key.toUpperCase()), key);
assert.strictEqual(p2p.normalizeRoomCode('ab cd-ef'), 'abcdef');
assert.strictEqual(p2p.normalizeRoomCode(null), '');
assert.strictEqual(p2p.normalizeRoomCode('  '), '');

// 校验：必须正好 64 位十六进制
assert.strictEqual(p2p.isValidRoomCode(key), true);
assert.strictEqual(p2p.isValidRoomCode(key.toUpperCase()), true);
assert.strictEqual(p2p.isValidRoomCode('a'.repeat(63)), false);
assert.strictEqual(p2p.isValidRoomCode('a'.repeat(65)), false);
assert.strictEqual(p2p.isValidRoomCode('z'.repeat(64)), false);

// 默认端口
assert.strictEqual(p2p.DEFAULT_GAME_PORT, 25565);
assert.strictEqual(p2p.DEFAULT_LOCAL_PORT, 25566);

// 初始状态：未连接
const initial = p2p.snapshot();
assert.strictEqual(initial.mode, '');
assert.strictEqual(initial.peers, 0);
assert.strictEqual(initial.host, false);

// 非法房间码直接返回错误，不会抛异常
(async () => {
  const bad = await p2p.join({ roomCode: 'abc', localPort: 25666 });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /64 位/);
  console.log('p2p tests passed');
})().catch((err) => {
  console.error('p2p tests failed:', err.message);
  process.exit(1);
});