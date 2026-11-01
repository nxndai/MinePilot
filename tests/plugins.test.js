'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/core/config');
const plugins = require('../src/core/plugins');
const net = require('../src/core/net');
const zip = require('../src/core/zip');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-plugins-test-'));

function makePlugin(file, manifest, main = 'minepilot.toast("ok")') {
  zip.createZip([
    { name: 'plugin.json', data: JSON.stringify(manifest) },
    { name: 'main.js', data: main },
  ], file);
}

async function run() {
  config.init(root);
  const pluginPath = path.join(root, 'demo.zip');
  makePlugin(pluginPath, {
    id: 'demo.plugin',
    name: 'Demo Plugin',
    version: '1.0.0',
    description: '测试插件',
    author: 'Test',
    main: 'main.js',
    permissions: { network: ['api.example.com', '*.github.com'] },
  });

  const inspected = plugins.inspect(pluginPath);
  assert.strictEqual(inspected.manifest.id, 'demo.plugin');
  assert.deepStrictEqual(inspected.manifest.permissions.network, ['api.example.com', '*.github.com']);
  assert.strictEqual(inspected.manifest.permissionsDeclared, true);

  const installed = plugins.install(pluginPath);
  assert.strictEqual(installed.ok, true);
  const list = plugins.list();
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(list[0].permissions.network, ['api.example.com', '*.github.com']);
  assert.strictEqual(plugins.setEnabled('demo.plugin', false).ok, true);
  assert.strictEqual(plugins.list()[0].enabled, false);

  const legacyPath = path.join(root, 'legacy.zip');
  makePlugin(legacyPath, { id: 'legacy.plugin', name: 'Legacy', version: '1.0.0', main: 'main.js' });
  const legacy = plugins.inspect(legacyPath);
  assert.deepStrictEqual(legacy.manifest.permissions.network, []);
  assert.strictEqual(legacy.manifest.permissionsDeclared, false);

  const badPath = path.join(root, 'bad.zip');
  makePlugin(badPath, {
    id: 'bad.plugin', name: 'Bad', version: '1.0.0', main: 'main.js',
    permissions: { network: ['https://bad.example.com/path?x=1'] },
  });
  const bad = plugins.inspect(badPath);
  assert.deepStrictEqual(bad.manifest.permissions.network, ['bad.example.com']);

  const hash = await net.sha256File(pluginPath);
  const originalFetchJson = net.fetchJson;
  const originalDownload = net.downloadFile;
  net.fetchJson = async () => ({
    updatedAt: '2026-10-31T00:00:00Z',
    plugins: [
      {
        id: 'demo.plugin',
        name: 'Market Plugin',
        version: '2.0.0',
        download: 'https://example.com/market.zip',
        sha256: hash,
        permissions: { network: ['api.example.com', '*.github.com'] },
      },
      { id: 'broken', download: 'http://example.com/x.zip' },
    ],
  });
  net.downloadFile = async (url, destination) => {
    fs.copyFileSync(pluginPath, destination);
    return { skipped: false, size: fs.statSync(destination).size };
  };
  try {
    const market = await plugins.marketIndex('https://example.com/plugins.json');
    assert.strictEqual(market.ok, true);
    assert.strictEqual(market.plugins.length, 1);
    assert.strictEqual(market.skipped, 1);
    const result = await plugins.installFromMarket(market.plugins[0], { overwrite: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(plugins.list().some((item) => item.id === 'demo.plugin'), true);
    await assert.rejects(
      () => plugins.installFromMarket(Object.assign({}, market.plugins[0], {
        permissions: { network: [] },
      }), { overwrite: true }),
      /权限与索引不一致/,
    );
  } finally {
    net.fetchJson = originalFetchJson;
    net.downloadFile = originalDownload;
  }

  await assert.rejects(() => plugins.marketIndex('http://example.com/plugins.json'), /https/);
  console.log('plugins tests passed');
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });