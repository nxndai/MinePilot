'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/core/config');
const modmanager = require('../src/core/modmanager');
const versions = require('../src/core/versions');
const { createZip } = require('../src/core/zip');

function jar(dir, filename, metadata) {
  fs.mkdirSync(dir, { recursive: true });
  createZip([{ name: 'fabric.mod.json', data: Buffer.from(JSON.stringify(metadata)) }], path.join(dir, filename));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-mods-test-'));
try {
  config.init(root);
  const gameDir = path.join(root, 'game');
  const modsDir = path.join(gameDir, 'mods');
  const target = { id: '1.20.1-fabric', gameDir, mcVersion: '1.20.1' };

  jar(modsDir, 'fabric-api.jar', {
    id: 'fabric-api',
    name: 'Fabric API',
    version: '0.92.0',
    depends: { minecraft: '1.20.x', java: '>=17' },
  });
  jar(modsDir, 'cool-mod.jar', {
    id: 'coolmod',
    name: 'Cool Mod',
    version: '2.0.0',
    environment: 'client',
    depends: { 'fabric-api': '>=0.90.0', missinglib: '>=1.2.0', minecraft: '1.20.x' },
  });
  jar(modsDir, 'server-tool.jar', {
    id: 'servertool',
    name: 'Server Tool',
    version: '1.0.0',
    environment: 'server',
  });

  const list = modmanager.list(target);
  assert.strictEqual(list.count, 3);
  assert.strictEqual(list.health.errorCount, 1);
  assert.ok(list.health.issues.some((issue) => issue.type === 'missing-dependency' && issue.title.includes('missinglib')));
  assert.ok(list.health.issues.some((issue) => issue.type === 'side-mix'));
  const cool = list.mods.find((mod) => mod.modId === 'coolmod');
  assert.strictEqual(cool.side, 'client');
  assert.ok(cool.dependencies.some((dep) => dep.id === 'fabric-api' && dep.type === 'required'));

  assert.strictEqual(modmanager.satisfiesRange('0.92.0', '>=0.90.0'), true);
  assert.strictEqual(modmanager.satisfiesRange('0.80.0', '>=0.90.0'), false);
  assert.strictEqual(modmanager.satisfiesRange('1.20.1', '1.20.x'), true);
  assert.strictEqual(modmanager.satisfiesRange('1.19.4', '1.20.x'), false);
  assert.strictEqual(modmanager.satisfiesRange('1.5', '[1.0,2.0)'), true);
  assert.strictEqual(modmanager.satisfiesRange('2.0', '[1.0,2.0)'), false);

  // 禁用前置后，依赖它的模组应得到“已安装但被禁用”的提示。
  modmanager.setEnabled(target, 'fabric-api.jar', false);
  const disabled = modmanager.list(target);
  assert.ok(disabled.health.issues.some((issue) => issue.type === 'disabled-dependency'));

  // 重复 modid 应被识别。
  jar(modsDir, 'fabric-api-old.jar', { id: 'fabric-api', name: 'Fabric API Old', version: '0.80.0' });
  const duplicate = modmanager.list(target);
  assert.ok(duplicate.health.issues.some((issue) => issue.type === 'duplicate-modid'));

  // 启用/禁用只改文件名，不删除内容。
  const enabled = modmanager.setEnabled(target, 'cool-mod.jar', false);
  assert.strictEqual(enabled.changed, true);
  assert.ok(fs.existsSync(path.join(modsDir, 'cool-mod.jar.disabled')));
  assert.strictEqual(modmanager.setEnabled(target, 'cool-mod.jar.disabled', true).changed, true);
  assert.ok(fs.existsSync(path.join(modsDir, 'cool-mod.jar')));

  // Forge/NeoForge: [[dependencies.<ownModId>]] 的小节名不是依赖 id。
  const forgeGame = path.join(root, 'forge-game');
  const forgeMods = path.join(forgeGame, 'mods');
  fs.mkdirSync(forgeMods, { recursive: true });
  createZip([{
    name: 'META-INF/mods.toml',
    data: Buffer.from([
      'modLoader="javafml"',
      '[[mods]]',
      'modId="forge-mod"',
      'displayName="Forge Mod"',
      'version="1.0.0"',
      '[[dependencies.forge-mod]]',
      'modId="minecraft"',
      'mandatory=true',
      'versionRange="[1.20.1,1.20.2)"',
      '[[dependencies.forge-mod]]',
      'modId="missing-forge-lib"',
      'mandatory=true',
      'versionRange="[2.0,3.0)"',
      '[[dependencies.forge-mod]]',
      'modId="optional-lib"',
      'mandatory=false',
      'versionRange="*"',
    ].join('\n')),
  }], path.join(forgeMods, 'forge-mod.jar'));
  const forgeList = modmanager.list({ id: 'forge', gameDir: forgeGame, mcVersion: '1.20.1' });
  const forgeDeps = forgeList.mods[0].dependencies;
  assert.deepStrictEqual(forgeDeps.map((dep) => dep.id), ['minecraft', 'missing-forge-lib', 'optional-lib']);
  assert.strictEqual(forgeDeps[2].type, 'optional');
  assert.ok(forgeList.health.issues.some((issue) => issue.type === 'missing-dependency' && issue.title.includes('missing-forge-lib')));

  // PCL 等启动器把整合包模组放在 versions/<id>/mods；即使全局未开隔离，
  // 也要自动识别并把该目录作为游戏目录，否则界面会显示 0 个模组。
  const localGame = path.join(root, 'local-versions');
  const localId = '1.20.1-pcl-forge';
  const localDir = path.join(localGame, 'versions', localId);
  fs.mkdirSync(localDir, { recursive: true });
  jar(path.join(localDir, 'mods'), 'pcl-mod.jar', { id: 'pclmod', name: 'PCL Mod', version: '1.0.0' });
  assert.strictEqual(versions.isolateFor(localGame, localId, false), true);
  const localEffective = versions.effectiveDir(localGame, localId, true, '');
  assert.strictEqual(localEffective, localDir);
  assert.strictEqual(versions.countMods(localEffective).count, 1);

  // 显式写入的隔离标记优先于目录自动识别。
  fs.writeFileSync(path.join(localDir, '.minepilot.json'), JSON.stringify({ isolated: false }));
  assert.strictEqual(versions.isolateFor(localGame, localId, false), false);

  // Modrinth 搜索/版本解析：纯服务端项目不能被当成客户端首选，
  // 搜索结果要带介绍页 URL，纯 Paper 文件不能出现在客户端安装候选里。
  const runModrinthChecks = async () => {
    const net = require('../src/core/net');
    const mods = require('../src/core/mods');
    const originalFetchJson = net.fetchJson;
    try {
    net.fetchJson = async (url) => {
      if (String(url).includes('/search?')) {
        return {
          total_hits: 2,
          hits: [
            {
              project_id: 'paperplugin',
              slug: 'paper-plugin',
              project_type: 'mod',
              title: 'Paper Plugin',
              description: 'server only',
              client_side: 'unsupported',
              server_side: 'required',
              downloads: 999999,
              versions: ['1.20.1'],
            },
            {
              project_id: 'clientmod',
              slug: 'client-mod',
              project_type: 'mod',
              title: 'Client Mod',
              description: 'client',
              client_side: 'required',
              server_side: 'optional',
              downloads: 10,
              versions: ['1.20.1'],
            },
          ],
        };
      }
      return [
        {
          id: 'paper-version',
          project_id: 'clientmod',
          name: 'Paper build',
          version_number: '9.9',
          date_published: '2026-01-02T00:00:00Z',
          loaders: ['paper'],
          game_versions: ['1.20.1'],
          files: [{ primary: true, filename: 'clientmod-paper.jar', url: 'https://example.invalid/paper.jar' }],
        },
        {
          id: 'fabric-version',
          project_id: 'clientmod',
          name: 'Fabric build',
          version_number: '1.0',
          date_published: '2026-01-01T00:00:00Z',
          loaders: ['fabric'],
          game_versions: ['1.20.1'],
          files: [{ primary: true, filename: 'clientmod-fabric.jar', url: 'https://example.invalid/fabric.jar' }],
        },
      ];
    };

    const search = await mods.search({ gameVersion: '1.20.1', query: 'test' });
    assert.strictEqual(search.hits[0].title, 'Client Mod');
    assert.strictEqual(search.hits[1].title, 'Paper Plugin');
    assert.strictEqual(search.hits[0].externalUrl, 'https://modrinth.com/mod/client-mod');
    assert.strictEqual(search.hits[1].clientSide, 'unsupported');

    const clientVersions = await mods.getVersions({
      projectId: 'clientmod',
      gameVersion: '1.20.1',
      clientOnly: true,
    });
    assert.deepStrictEqual(clientVersions.versions.map((version) => version.id), ['fabric-version']);

    let noLoaderError = null;
    try {
      await mods.install({
        target: { id: 'vanilla', gameDir, mcVersion: '1.20.1', loaders: [] },
        projectId: 'clientmod',
        gameVersion: '1.20.1',
      });
    } catch (err) {
      noLoaderError = err;
    }
    assert.strictEqual(noLoaderError && noLoaderError.code, 'NO_LOADER');
  } finally {
    net.fetchJson = originalFetchJson;
  }

  };

  runModrinthChecks()
    .then(() => console.log('mods tests passed'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}