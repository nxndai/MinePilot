'use strict';

const assert = require('assert');
const memory = require('../src/core/memory');

(async () => {
  const stats = memory.stats();
  assert.strictEqual(stats.supported, process.platform === 'win32');
  assert.ok(stats.totalMb > 0, 'total memory should be positive');
  assert.ok(stats.usedMb >= 0, 'used memory should not be negative');
  assert.ok(stats.usedMb <= stats.totalMb + 1, 'used memory should not exceed total');
  assert.ok(stats.percent >= 0 && stats.percent <= 100, 'memory percentage should be in range');

  const script = memory.buildCleanScript([123, 456, 0, 'x'], "C:\\tmp\\a'b");
  assert.match(script, /\$skipPids = @\(123,456\)/, 'numeric skip PIDs should be included');
  assert.ok(script.includes("C:\\tmp\\a''b"), 'temp path should be single-quote escaped');
  assert.ok(script.includes('EmptyWorkingSet'), 'native cleanup API should be used');

  if (process.platform !== 'win32') {
    const result = await memory.clean();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'UNSUPPORTED');
  }

  console.log('memory cleaner tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});