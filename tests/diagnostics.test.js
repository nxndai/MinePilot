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

  console.log('diagnostics tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}