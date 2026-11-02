'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/core/config');
const diagnostics = require('../src/core/diagnostics');
const settings = require('../src/core/settings');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-diagnostics-test-'));
try {
  config.init(root);
  const gameDir = path.join(root, 'game');
  fs.mkdirSync(path.join(gameDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(gameDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'mods', 'OptiFine_1.20.1_HD_U_I6.jar'), 'fixture');
  const logPath = path.join(gameDir, 'logs', 'latest.log');
  fs.writeFileSync(logPath, [
    '[main/INFO] Loading Minecraft 1.20.1 with Fabric Loader',
    '[main/ERROR] Mixin apply failed: optifine.mixins.json',
    'java.lang.NoClassDefFoundError: net/optifine/Config',
    '--accessToken secret-token-value',
    '--username RealPlayerName',
    'C:\\Users\\Alice\\AppData\\Roaming\\.minecraft\\mods',
    'Server address: 203.0.113.42:25565',
  ].join('\n'));

  settings.update({ gameDir });
  const record = diagnostics.analyze({
    gameDir,
    logPath,
    code: 1,
    duration: 2400,
    versionId: '1.20.1-fabric',
    startedAt: Date.now() - 3000,
  });
  assert.ok(record.causes.some((cause) => cause.id === 'optifine-fabric'));
  const optifine = record.causes.find((cause) => cause.id === 'optifine-fabric');
  assert.ok(optifine.actions.some((action) => action.id === 'disable-optifine'));
  diagnostics.save(record);

  const shared = diagnostics.shareMarkdown(record);
  assert.ok(!shared.includes('secret-token-value'));
  assert.ok(!shared.includes('RealPlayerName'));
  assert.ok(!shared.includes('Alice'));
  assert.ok(!shared.includes('203.0.113.42'));
  assert.ok(shared.includes('OptiFine 与 Fabric 不兼容'));

  const sanitized = diagnostics.sanitizeShareText('C:\\Users\\Bob\\x --uuid abc123 Authorization: Bearer xyz');
  assert.ok(!sanitized.includes('Bob'));
  assert.ok(!sanitized.includes('abc123'));
  assert.ok(!sanitized.includes('xyz'));
  assert.ok(diagnostics.sanitizeShareText('connect 203.0.113.42:25565').includes('<IP>'));

  // 正常退出时，命令行里的 lwjgl-glfw-...-natives 路径不能被误判成
  // “本机运行库加载失败”；退出码 0 且没有崩溃报告就是正常退出。
  const cleanGame = path.join(root, 'clean-game');
  fs.mkdirSync(path.join(cleanGame, 'logs'), { recursive: true });
  const cleanLog = path.join(cleanGame, 'logs', 'latest.log');
  fs.writeFileSync(cleanLog, [
    'C:\\Users\\these\\AppData\\Roaming\\.minecraft\\libraries\\org\\lwjgl\\lwjgl-glfw\\3.3.1\\lwjgl-glfw-3.3.1-natives-windows.jar',
    '[Render thread/ERROR] [net.minecraft.class_310] Failed to verify authentication',
    '[Render thread/INFO] [net.minecraft.class_310] Stopping!',
  ].join('\n'));
  const clean = diagnostics.analyze({
    gameDir: cleanGame,
    logPath: cleanLog,
    code: 0,
    duration: 263000,
    versionId: 'fabric-loader-1.20.1',
    startedAt: Date.now() - 264000,
  });
  assert.strictEqual(clean.crashed, false);
  assert.strictEqual(clean.title, '游戏正常退出');
  assert.ok(!clean.causes.some((cause) => cause.id === 'natives'));
  assert.ok(diagnostics.latest());
  diagnostics.clearLatest();
  assert.strictEqual(diagnostics.latest(), null);

  console.log('diagnostics tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}