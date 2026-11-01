'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'i18n.js'), 'utf8');
const sandbox = {
  window: {},
  document: {
    documentElement: { lang: '' },
    body: null,
  },
};
vm.runInNewContext(source, sandbox, { filename: 'renderer/js/i18n.js' });
const MP = sandbox.window.MP;
assert(MP && MP.i18n && typeof MP.i18n.t === 'function', 'i18n module should expose t()');
MP.i18n.apply('en-US');
assert.strictEqual(MP.i18n.language, 'en-US');
assert.strictEqual(sandbox.document.documentElement.lang, 'en');

// 静态标签：四项新功能的核心入口必须能切换到英文。
for (const [zh, en] of [
  ['存档', 'Saves'],
  ['存档管理', 'Save management'],
  ['备份列表', 'Backups'],
  ['按加载器筛选', 'Filter by loader'],
  ['检查问题', 'Check issues'],
  ['检查更新', 'Check updates'],
  ['缺少 Fabric API', 'Fabric API is missing'],
  ['OptiFine 与 Fabric 不兼容', 'OptiFine is incompatible with Fabric'],
  ['Java 管理', 'Java management'],
  ['导出目录', 'Export folder'],
  ['内容', 'Content'],
  ['联机', 'Play together'],
  ['插件市场', 'Plugin marketplace'],
  ['账户', 'Accounts'],
  ['一键开房间', 'Start a room'],
  ['资源包', 'Resource packs'],
  ['光影', 'Shaders'],
  ['数据包', 'Data packs'],
  ['搜索资源包、光影或数据包；下载后可以直接启用。', 'Search resource packs, shaders or data packs; downloaded content can be enabled directly.'],
  ['新建配置后保存；支持 {gameDir}、{player}、{address} 占位符。', 'Save a new profile; placeholders {gameDir}, {player} and {address} are supported.'],
  ['系统安全存储', 'System secure storage'],
  ['联网：任意域名（高风险）', 'Network: any domain (high risk)'],
  ['自定义', 'Custom'],
]) {
  assert.strictEqual(MP.t(zh), en, `expected ${zh} -> ${en}`);
}

assert.strictEqual(MP.t('读取内容失败：文件损坏'), 'Failed to read content: 文件损坏');
assert.strictEqual(MP.t('（已过期）'), ' (expired)');

// 动态文本：存档、模组健康检查和诊断详情由 JS 模板生成，不能只依赖静态 HTML。
assert.strictEqual(MP.t('3 个文件'), '3 files');
assert.strictEqual(MP.t('1.20.1 的存档'), '1.20.1 saves');
assert.strictEqual(MP.t('2 个世界 · 1 个备份 · saves/'), '2 worlds · 1 backup · saves/');
assert.strictEqual(MP.t('1 个存档'), '1 save');
assert.strictEqual(MP.t('最后游玩：2026/10/31（刚刚）'), 'Last played: 2026/10/31 (Just now)');
assert.strictEqual(MP.t('example.jar · 12 KB · 便携目录 · FABRIC · 仅客户端'), 'example.jar · 12 KB · Portable folder · FABRIC · Client only');
assert.strictEqual(MP.t('发现 2 个问题'), 'Found 2 issues');
assert.strictEqual(MP.t('缺少前置：fabric-api'), 'Missing dependency: fabric-api');
assert.strictEqual(MP.t('前置已安装但被禁用：fabric-api'), 'Dependency installed but disabled: fabric-api');
assert.strictEqual(MP.t('重复的 modid：example'), 'Duplicate modid: example');
assert.strictEqual(MP.t('模组冲突：Example 与 Other'), 'Mod conflict: Example and Other');
assert.strictEqual(MP.t('备份失败：磁盘已满'), 'Backup failed: 磁盘已满');
assert.strictEqual(MP.t('3 秒'), '3 sec');
assert.strictEqual(MP.t('没有可用的日志内容。'), 'No log content available.');

// 找不到译文时保留原文，避免把模组名或日志误翻译。
assert.strictEqual(MP.t('Example Mod 1.2.3'), 'Example Mod 1.2.3');
assert.strictEqual(MP.t('Some mod log line'), 'Some mod log line');

console.log('i18n tests passed');