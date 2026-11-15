'use strict';

/**
 * 跨平台冒烟检查（在 macOS / Linux / Windows 的 CI 上都跑一遍）。
 *
 * 不启动 Electron，只验证"平台相关逻辑 + 数据目录初始化 + 基础模块"在别的系统上也成立：
 * 默认游戏目录、路径拼接、版本扫描、联机地址、ZIP 读写、设置持久化。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const platform = require(path.join(root, 'src', 'core', 'platform'));
const config = require(path.join(root, 'src', 'core', 'config'));
const settings = require(path.join(root, 'src', 'core', 'settings'));
const versions = require(path.join(root, 'src', 'core', 'versions'));
const netplay = require(path.join(root, 'src', 'core', 'netplay'));
const zip = require(path.join(root, 'src', 'core', 'zip'));
const logger = require(path.join(root, 'src', 'core', 'logger'));

(async () => {
  const expected = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform];
  assert.strictEqual(platform.name(), expected, `平台名应为 ${expected}`);
  assert.ok(platform.label().length > 0, '平台显示名不能为空');

  // 默认游戏目录：三个平台都要是绝对路径且指向 Minecraft 目录。
  const gameDir = platform.defaultGameDir();
  assert.ok(path.isAbsolute(gameDir), `默认游戏目录应为绝对路径：${gameDir}`);
  if (process.platform === 'darwin') {
    assert.ok(/Library\/Application Support\/minecraft$/.test(gameDir), `macOS 默认目录不正确：${gameDir}`);
  } else if (process.platform === 'linux') {
    assert.ok(gameDir.endsWith('/.minecraft'), `Linux 默认目录不正确：${gameDir}`);
  } else {
    assert.ok(/\.minecraft$/i.test(gameDir), `Windows 默认目录不正确：${gameDir}`);
  }

  // 数据目录隔离：每个平台都能在临时目录里初始化。
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-platform-'));
  try {
    config.init(dataRoot);
    assert.strictEqual(path.resolve(config.root()), path.resolve(dataRoot));

    const next = settings.update({ language: 'en-US', onlineDownloads: true, gameDir: path.join(dataRoot, 'Minecraft') });
    assert.strictEqual(next.language, 'en-US');
    assert.strictEqual(settings.get().onlineDownloads, true);
    assert.ok(fs.existsSync(config.configFile()), '设置文件应写入数据目录');

    // 空游戏目录扫描：不能抛错，返回空列表。
    const s = settings.get();
    const list = await versions.listVersions(s.gameDir, s.lastPlayed, false, '');
    assert.ok(Array.isArray(list));
    assert.strictEqual(list.length, 0, '空目录不应扫描出版本');

    // 联机地址：跨平台都应返回数组，且端口正确。
    const addresses = netplay.localAddresses(25566);
    assert.ok(Array.isArray(addresses));
    for (const item of addresses) assert.strictEqual(item.port, 25566);

    // 端口检测：跨平台可用（返回结构而不是抛错）。
    const probe = await netplay.checkPorts({ port: 25566 });
    assert.strictEqual(probe.ok, true);
    assert.ok(Array.isArray(probe.addresses));

    // ZIP 往返：验证路径分隔符和文件读写。
    const zipPath = path.join(dataRoot, 'roundtrip.zip');
    const sourceFile = path.join(dataRoot, 'a.txt');
    fs.writeFileSync(sourceFile, 'minepilot');
    zip.createZip([{ name: 'sub/a.txt', filePath: sourceFile }], zipPath);
    const outDir = path.join(dataRoot, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    zip.extractZip(zipPath, outDir);
    assert.strictEqual(fs.readFileSync(path.join(outDir, 'sub', 'a.txt'), 'utf8'), 'minepilot');

    logger.info(`platform smoke ok on ${process.platform}/${process.arch}`);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  console.log(`platform smoke passed: ${process.platform} / ${process.arch} / node ${process.version}`);
})().catch((err) => {
  console.error('platform smoke failed:', err && err.message);
  console.error(err && err.stack);
  process.exit(1);
});