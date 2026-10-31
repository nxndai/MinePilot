'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/core/config');
const settings = require('../src/core/settings');
const { effectiveMemoryMb, memoryArgs } = require('../src/core/launcher');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-memory-'));
try {
  config.init(root);

  assert.strictEqual(settings.recommendedMemory(4096), 2048);
  assert.strictEqual(settings.recommendedMemory(8192), 4096);
  assert.strictEqual(settings.recommendedMemory(16384), 8192);
  assert.strictEqual(settings.recommendedMemory(32768), 12288);
  assert.strictEqual(settings.recommendedMemory(2048), 2048);

  assert.strictEqual(settings.defaults().memoryAuto, true);
  assert.strictEqual(settings.defaults().memoryOptimize, true);

  const recommended = settings.recommendedMemory();
  assert.ok(recommended >= 2048, 'recommended memory should be at least 2 GB');
  assert.ok(recommended <= 12288, 'recommended memory should be capped at 12 GB');
  assert.strictEqual(recommended % 512, 0, 'recommended memory should use 512 MB steps');

  assert.strictEqual(effectiveMemoryMb({ memoryAuto: true, memoryMb: 2048 }, 8192), 8192);
  assert.strictEqual(effectiveMemoryMb({ memoryAuto: true, memoryMb: 2048 }, 8192, 32), 1024);
  assert.strictEqual(effectiveMemoryMb({ memoryAuto: false, memoryMb: 6144 }, 8192), 6144);
  assert.strictEqual(effectiveMemoryMb(null, 8192), 8192);

  const optimized = memoryArgs(true, 17);
  assert.ok(optimized.includes('-XX:+UseG1GC'));
  assert.ok(optimized.includes('-XX:MaxGCPauseMillis=200'));
  assert.deepStrictEqual(memoryArgs(true, 7), []);
  assert.deepStrictEqual(memoryArgs(false, 17), []);

  settings.update({ memoryAuto: false, memoryMb: 6144, memoryOptimize: false });
  assert.strictEqual(settings.get().memoryAuto, false);
  assert.strictEqual(settings.get().memoryMb, 6144);
  assert.strictEqual(settings.get().memoryOptimize, false);

  const disk = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.strictEqual(disk.memoryAuto, false);
  assert.strictEqual(disk.memoryMb, 6144);
  assert.strictEqual(disk.memoryOptimize, false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(disk, 'recommendedMemoryMb'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(disk, 'totalMemoryMb'), false);

  settings.update({ memoryAuto: true, memoryOptimize: true });
  assert.strictEqual(settings.get().memoryAuto, true);
  assert.strictEqual(settings.get().memoryOptimize, true);

  console.log('memory tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}