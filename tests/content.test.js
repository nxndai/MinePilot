'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/core/config');
const content = require('../src/core/content');
const zip = require('../src/core/zip');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-content-test-'));
const gameDir = path.join(root, 'game');
const target = { id: '1.20.1-test', gameDir, mcVersion: '1.20.1' };

function packZip(file, description, extra = []) {
  zip.createZip([
    { name: 'pack.mcmeta', data: JSON.stringify({ pack: { pack_format: 15, description } }) },
    { name: 'pack.png', data: Buffer.from([137, 80, 78, 71]) },
    ...extra,
  ], file);
}

try {
  config.init(root);
  fs.mkdirSync(path.join(gameDir, 'resourcepacks'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'options.txt'), 'version:3465\nresourcePacks:["vanilla"]\nlang:zh_cn\n', 'utf8');

  packZip(path.join(gameDir, 'resourcepacks', 'MyPack.zip'), '测试资源包');
  packZip(path.join(gameDir, 'shaderpacks', 'SoftShaders.zip'), '柔和光影', [
    { name: 'shaders/shader.properties', data: 'name=Soft\n' },
  ]);
  fs.mkdirSync(path.join(gameDir, 'datapacks', 'GlobalPack'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'datapacks', 'GlobalPack', 'pack.mcmeta'), JSON.stringify({ pack: { pack_format: 15, description: '全局包' } }));
  fs.mkdirSync(path.join(gameDir, 'saves', 'World A'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'saves', 'World A', 'level.dat'), Buffer.from([0]));
  fs.mkdirSync(path.join(gameDir, 'saves', 'World A', 'datapacks'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'saves', 'World A', 'datapacks', 'WorldPack.zip'), 'not a real zip');

  const packs = content.list(target, 'resourcepack');
  assert.strictEqual(packs.length, 1);
  assert.strictEqual(packs[0].name, 'MyPack');
  assert.strictEqual(packs[0].enabled, false);
  assert.strictEqual(packs[0].description, '测试资源包');
  const preview = content.preview(target, 'resourcepack', packs[0].id);
  assert.ok(preview.icon.startsWith('data:image/png;base64,'));

  content.setEnabled(target, 'resourcepack', packs[0].id, true);
  assert.strictEqual(content.list(target, 'resourcepack')[0].enabled, true);
  const options = fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8');
  assert.ok(options.includes('file/MyPack.zip'));
  assert.ok(options.includes('lang:zh_cn'));
  content.setEnabled(target, 'resourcepack', packs[0].id, false);
  assert.strictEqual(content.list(target, 'resourcepack')[0].enabled, false);

  const shaders = content.list(target, 'shaderpack');
  assert.strictEqual(shaders.length, 1);
  assert.strictEqual(shaders[0].enabled, false);
  content.setEnabled(target, 'shaderpack', shaders[0].id, true);
  assert.strictEqual(content.list(target, 'shaderpack')[0].enabled, true);
  assert.ok(fs.readFileSync(path.join(gameDir, 'config', 'iris.properties'), 'utf8').includes('SoftShaders.zip'));

  const datapacks = content.list(target, 'datapack');
  assert.strictEqual(datapacks.length, 2);
  const global = datapacks.find((item) => item.name === 'GlobalPack');
  assert.ok(global && global.enabled);
  content.setEnabled(target, 'datapack', global.id, false);
  assert.ok(!content.list(target, 'datapack').find((item) => item.name === 'GlobalPack').enabled);
  content.setEnabled(target, 'datapack', global.id, true);
  assert.ok(content.list(target, 'datapack').find((item) => item.name === 'GlobalPack').enabled);

  const imported = content.importBuffer(target, 'resourcepack', Buffer.from('zip'), 'Imported.zip');
  assert.strictEqual(imported.fileName, 'Imported.zip');
  assert.throws(() => content.importBuffer(target, 'resourcepack', Buffer.from('zip'), 'Imported.zip'), /已经存在/);
  const overwritten = content.importBuffer(target, 'resourcepack', Buffer.from('zip2'), 'Imported.zip', { overwrite: true });
  assert.strictEqual(overwritten.fileName, 'Imported.zip');
  const removed = content.remove(target, 'resourcepack', 'Imported.zip');
  assert.ok(fs.existsSync(removed.trashedTo));
  assert.ok(!fs.existsSync(path.join(gameDir, 'resourcepacks', 'Imported.zip')));

  console.log('content tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}