'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const config = require('../src/core/config');
const saves = require('../src/core/saves');
const nbt = require('../src/core/nbt');

function stringTag(value) {
  const text = Buffer.from(String(value), 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(text.length, 0);
  return Buffer.concat([length, text]);
}

function named(type, name, payload) {
  return Buffer.concat([Buffer.from([type]), stringTag(name), payload]);
}

function levelDat(levelName, lastPlayed, version) {
  const data = Buffer.concat([
    named(8, 'LevelName', stringTag(levelName)),
    named(4, 'LastPlayed', (() => {
      const value = Buffer.alloc(8);
      value.writeBigInt64BE(BigInt(lastPlayed), 0);
      return value;
    })()),
    named(10, 'Version', Buffer.concat([
      named(8, 'Name', stringTag(version)),
      Buffer.from([0]),
    ])),
    Buffer.from([0]),
  ]);
  const root = Buffer.concat([
    Buffer.from([10]),
    Buffer.from([0, 0]),
    named(10, 'Data', data),
    Buffer.from([0]),
  ]);
  return zlib.gzipSync(root);
}

function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-saves-test-'));
  const gameDir = path.join(root, 'game');
  const savesDir = path.join(gameDir, 'saves');
  fs.mkdirSync(path.join(savesDir, 'Test World', 'region'), { recursive: true });
  fs.writeFileSync(path.join(savesDir, 'Test World', 'level.dat'), levelDat('Test World', 1700000000000, '1.20.1'));
  fs.writeFileSync(path.join(savesDir, 'Test World', 'region', 'r.0.0.mca'), Buffer.alloc(4096, 1));
  fs.writeFileSync(path.join(savesDir, 'Test World', 'icon.png'), Buffer.alloc(32, 2));
  return { root, gameDir, target: { id: '1.20.1-test', gameDir, mcVersion: '1.20.1' } };
}

const fixture = buildFixture();
try {
  config.init(fixture.root);

  const parsed = nbt.parse(fs.readFileSync(path.join(fixture.gameDir, 'saves', 'Test World', 'level.dat')));
  assert.strictEqual(parsed.Data.LevelName, 'Test World');
  assert.strictEqual(parsed.Data.Version.Name, '1.20.1');
  assert.strictEqual(Number(parsed.Data.LastPlayed), 1700000000000);

  const list = saves.list(fixture.target);
  assert.strictEqual(list.count, 1);
  assert.strictEqual(list.saves[0].name, 'Test World');
  assert.strictEqual(list.saves[0].mcVersion, '1.20.1');
  assert.strictEqual(list.saves[0].lastPlayed, 1700000000000);
  assert.ok(list.saves[0].size > 4096);
  assert.strictEqual(list.saves[0].files, 3);

  assert.throws(() => saves.backup(fixture.target, '../escape'), /不合法/);

  const backed = saves.backup(fixture.target, 'Test World');
  assert.strictEqual(backed.ok, true);
  assert.strictEqual(backed.backups.length, 1);
  const backupFile = backed.backups[0].file;
  assert.ok(backupFile.endsWith('.zip'));

  fs.writeFileSync(path.join(fixture.gameDir, 'saves', 'Test World', 'region', 'r.0.0.mca'), Buffer.alloc(4096, 9));
  const restored = saves.restore(fixture.target, backupFile, { overwrite: true });
  assert.strictEqual(restored.ok, true);
  assert.deepStrictEqual(
    fs.readFileSync(path.join(fixture.gameDir, 'saves', 'Test World', 'region', 'r.0.0.mca')).subarray(0, 4),
    Buffer.alloc(4, 1),
  );

  const exported = path.join(fixture.root, 'export.zip');
  saves.exportWorld(fixture.target, 'Test World', exported);
  fs.rmSync(path.join(fixture.gameDir, 'saves', 'Test World'), { recursive: true, force: true });
  const imported = saves.importWorld(fixture.target, exported);
  assert.strictEqual(imported.folder, 'Test World');
  assert.ok(fs.existsSync(path.join(fixture.gameDir, 'saves', 'Test World', 'level.dat')));

  const removed = saves.remove(fixture.target, 'Test World', { backup: true });
  assert.strictEqual(removed.ok, true);
  assert.ok(removed.backup);
  assert.ok(!fs.existsSync(path.join(fixture.gameDir, 'saves', 'Test World')));
  assert.ok(saves.listBackups(fixture.target).length >= 2);

  console.log('saves tests passed');
} finally {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}