'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/core/config');
const settings = require('../src/core/settings');
const { applyGameLanguage, gameLanguageCode } = require('../src/core/launcher');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-language-'));
try {
  config.init(root);

  assert.strictEqual(settings.get().language, 'zh-CN');
  settings.update({ language: 'en-US' });
  assert.strictEqual(settings.get().language, 'en-US');
  settings.update({ language: 'fr-FR' });
  assert.strictEqual(settings.get().language, 'zh-CN');
  settings.update({ language: 'en-US' });
  const disk = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.strictEqual(disk.language, 'en-US');

  assert.strictEqual(gameLanguageCode('zh-CN'), 'zh_cn');
  assert.strictEqual(gameLanguageCode('en-US'), 'en_us');
  assert.strictEqual(gameLanguageCode(undefined), 'zh_cn');

  const gameDir = path.join(root, 'game');
  fs.mkdirSync(gameDir, { recursive: true });
  const options = path.join(gameDir, 'options.txt');
  fs.writeFileSync(options, 'version:3465\r\nlang:en_us\r\nfov:0.0\r\n', 'utf8');
  assert.strictEqual(applyGameLanguage(gameDir, 'zh-CN'), true);
  assert.strictEqual(fs.readFileSync(options, 'utf8'), 'version:3465\r\nlang:zh_cn\r\nfov:0.0\r\n');
  assert.strictEqual(applyGameLanguage(gameDir, 'zh-CN'), false);

  fs.writeFileSync(options, 'version:3465\nfov:0.0', 'utf8');
  assert.strictEqual(applyGameLanguage(gameDir, 'en-US'), true);
  assert.strictEqual(fs.readFileSync(options, 'utf8'), 'version:3465\nfov:0.0\nlang:en_us\n');

  const fresh = path.join(gameDir, 'fresh');
  fs.mkdirSync(fresh, { recursive: true });
  assert.strictEqual(applyGameLanguage(fresh, 'en-US'), true);
  assert.strictEqual(fs.readFileSync(path.join(fresh, 'options.txt'), 'utf8'), 'lang:en_us\n');

  console.log('language tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}