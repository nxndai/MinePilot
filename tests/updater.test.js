'use strict';

/**
 * 更新源解析的单元测试（不联网）：
 * - GitHub 仓库地址 → Releases API
 * - 红石中继站资源页 → 内部标记 mczwlt:<shortId>
 * - 任意 HTTPS manifest 原样保留
 * - 版本名里提取可比较的版本号
 */

const assert = require('assert');
const path = require('path');

const updater = require(path.join(__dirname, '..', 'src', 'core', 'updater'));

// GitHub：仓库页 / releases 页都要转成 API
assert.strictEqual(updater.resolveFeed('https://github.com/nxndai/MinePilot'), 'https://api.github.com/repos/nxndai/MinePilot/releases/latest');
assert.strictEqual(updater.resolveFeed('https://github.com/nxndai/MinePilot/'), 'https://api.github.com/repos/nxndai/MinePilot/releases/latest');
assert.strictEqual(updater.resolveFeed('https://github.com/nxndai/MinePilot/releases'), 'https://api.github.com/repos/nxndai/MinePilot/releases/latest');

// 红石中继站资源页 → 内部标记
assert.strictEqual(updater.resolveFeed('https://www.mczwlt.net/resource/m4bdnro8'), 'mczwlt:m4bdnro8');
assert.strictEqual(updater.resolveFeed('https://mczwlt.net/resource/m4bdnro8/'), 'mczwlt:m4bdnro8');
assert.strictEqual(updater.resolveFeed('https://www.mczwlt.net/resource/m4bdnro8?from=home'), 'mczwlt:m4bdnro8');
// 资源页的其它路径（比如版本页）不当作更新源
assert.notStrictEqual(updater.resolveFeed('https://www.mczwlt.net/resource/m4bdnro8/version/1'), 'mczwlt:m4bdnro8');

// 自定义 manifest 原样保留
assert.strictEqual(updater.resolveFeed('https://example.com/minepilot/latest.json'), 'https://example.com/minepilot/latest.json');
assert.strictEqual(updater.resolveFeed(''), '');

// 版本号提取
assert.strictEqual(updater.versionFromName('1.11.9'), '1.11.9');
assert.strictEqual(updater.versionFromName('v1.11.9'), '1.11.9');
assert.strictEqual(updater.versionFromName('天圆地方 v0.2.7'), '0.2.7');
assert.strictEqual(updater.versionFromName('MinePilot 2.0.0-beta'), '2.0.0-beta');
assert.strictEqual(updater.versionFromName('no version here'), 'no version here');

// 版本比较仍然可用（被 download 用来判断是否需要更新）
assert.strictEqual(updater.compareVersions('1.11.9', '1.11.8'), 1);
assert.strictEqual(updater.compareVersions('1.11.8', '1.11.9'), -1);
assert.strictEqual(updater.compareVersions('v1.11.9', '1.11.9'), 0);

// GitHub API 不可用时，按固定命名规则也能构造下载地址
const guess = updater.guessReleaseAsset('1.11.9');
assert.strictEqual(guess.name, 'MinePilot_Setup_1.11.9.exe');
assert.strictEqual(guess.url, 'https://github.com/nxndai/MinePilot/releases/download/v1.11.9/MinePilot_Setup_1.11.9.exe');
assert.strictEqual(updater.guessReleaseAsset('not-a-version'), null);
assert.strictEqual(updater.guessReleaseAsset('1.11'), null);

console.log('updater tests passed');