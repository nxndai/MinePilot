'use strict';

/**
 * 模组冲突自动修复的规划逻辑测试：
 * - 重复 modid 只保留版本最高的一个
 * - 前置被禁用 → 启用
 * - 缺少前置 → 加入待补装
 * - 版本不匹配 / 互斥冲突 → 只提示，不自动处理
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const modfix = require(path.join(root, 'src', 'core', 'modfix'));
const modmanager = require(path.join(root, 'src', 'core', 'modmanager'));
const zip = require(path.join(root, 'src', 'core', 'zip'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-modfix-'));
// modmanager 会读写启动器数据目录，先初始化到临时目录，避免碰真实数据。
require(path.join(root, 'src', 'core', 'config')).init(tmp);
const modsDir = path.join(tmp, 'mods');
fs.mkdirSync(modsDir, { recursive: true });

function makeJar(filename, meta) {
  const jarPath = path.join(modsDir, filename);
  zip.createZip([
    { name: 'fabric.mod.json', data: JSON.stringify(meta, null, 2) },
  ], jarPath);
  return jarPath;
}

try {
  // 两个同 modid 的旅行背包（一旧一新）
  makeJar('travelersbackpack-1.20.1-8.2.0.jar', {
    id: 'travelersbackpack',
    name: 'Travelers Backpack',
    version: '1.20.1-8.2.0',
    depends: { 'fabric-api': '*' },
  });
  makeJar('travelersbackpack-1.20.1-9.1.0.jar', {
    id: 'travelersbackpack',
    name: 'Travelers Backpack',
    version: '1.20.1-9.1.0',
    depends: { 'fabric-api': '*' },
  });

  // 一个被禁用的前置
  makeJar('fabric-api-0.92.0.jar.disabled', {
    id: 'fabric-api',
    name: 'Fabric API',
    version: '0.92.0',
  });

  const target = { id: 'test-instance', gameDir: tmp, mcVersion: '1.20.1' };
  const list = modmanager.list(target).mods;
  const health = modmanager.healthFromList(list);
  const plan = modfix.planFixes(list, health);

  // 1) 重复 modid：禁用旧版本，保留 9.1.0
  const disabled = plan.disables.map((item) => item.filename);
  assert.ok(disabled.includes('travelersbackpack-1.20.1-8.2.0.jar'), '旧版本应被禁用');
  assert.ok(!disabled.includes('travelersbackpack-1.20.1-9.1.0.jar'), '新版本不应被禁用');

  // 2) 被禁用的前置应被启用
  const enabled = plan.enables.map((item) => item.filename);
  assert.ok(enabled.includes('fabric-api-0.92.0.jar.disabled'), '被禁用的前置应被启用');

  // 3) 版本号比较：9.1.0 > 8.2.0
  const older = { version: '1.20.1-8.2.0', enabled: true, filename: 'a.jar' };
  const newer = { version: '1.20.1-9.1.0', enabled: true, filename: 'b.jar' };
  assert.ok(modfix.compareModVersion(newer, older) < 0, '新版本应排在前面');

  // 4) 缺少前置 → 进入待补装列表
  const missingList = [{
    filename: 'solo.jar',
    modId: 'solo',
    name: 'Solo',
    version: '1.0.0',
    enabled: true,
    dependencies: [{ id: 'cloth-config', type: 'required', range: '>=11.0.0' }],
  }];
  const missingHealth = modmanager.healthFromList(missingList);
  const missingPlan = modfix.planFixes(missingList, missingHealth);
  assert.strictEqual(missingPlan.installs.length, 1);
  assert.strictEqual(missingPlan.installs[0].id, 'cloth-config');

  // 5) 版本不匹配只给提示
  const rangeList = [
    { filename: 'api.jar', modId: 'fabric-api', name: 'Fabric API', version: '0.80.0', enabled: true, dependencies: [] },
    {
      filename: 'user.jar',
      modId: 'user',
      name: 'User',
      version: '1.0.0',
      enabled: true,
      dependencies: [{ id: 'fabric-api', type: 'required', range: '>=0.90.0' }],
    },
  ];
  const rangePlan = modfix.planFixes(rangeList, modmanager.healthFromList(rangeList));
  assert.ok(rangePlan.notes.some((note) => /版本/.test(note)), '版本不匹配应给出提示');
  assert.strictEqual(rangePlan.installs.length, 0, '版本不匹配不能自动补装');

  console.log('modfix tests passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}