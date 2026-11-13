'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const netplay = require('../src/core/netplay');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-netplay-test-'));

try {
  const exe = path.join(root, 'tool.exe');
  fs.writeFileSync(exe, 'not a real executable; only path validation is tested');
  const script = path.join(root, 'tool.bat');
  fs.writeFileSync(script, '@echo off');

  const profile = netplay.validateProfile({
    id: 'room-1',
    name: '测试房间',
    tool: 'terracotta',
    executable: exe,
    args: ['--room', 'my-room', ''],
    cwd: root,
    autoCopy: true,
  });
  assert.strictEqual(profile.id, 'room-1');
  assert.strictEqual(profile.name, '测试房间');
  assert.strictEqual(profile.executable, path.resolve(exe));
  assert.deepStrictEqual(profile.args, ['--room', 'my-room']);

  const expanded = netplay.expandArgs(['--dir', '{gameDir}', '--name', '{player}', '{address}'], {
    gameDir: 'C:\\Games\\instance',
    player: 'Steve',
    address: '192.168.1.10:25565',
  });
  assert.deepStrictEqual(expanded, ['--dir', 'C:\\Games\\instance', '--name', 'Steve', '192.168.1.10:25565']);

  assert.throws(() => netplay.validateProfile({ id: 'bad id', executable: exe }), /id/);
  assert.throws(() => netplay.validateProfile({ id: 'room-2', executable: path.join(root, 'missing.exe') }), /不存在/);
  assert.throws(() => netplay.validateProfile({ id: 'room-3', executable: script }), /shell/);
  assert.throws(() => netplay.validateProfile({ id: 'room-4', executable: exe, cwd: path.join(root, 'nope') }), /工作目录/);

  const addresses = netplay.localAddresses();
  assert.ok(Array.isArray(addresses));
  for (const item of addresses) {
    assert.match(item.address, /^\d{1,3}(?:\.\d{1,3}){3}$/);
    assert.strictEqual(item.port, 25565);
    assert.strictEqual(item.text, `${item.address}:25565`);
  }

  assert.strictEqual(netplay.guides().length, 3);
  assert.strictEqual(netplay.profiles({ netplayProfiles: [profile] }).length, 1);
  assert.deepStrictEqual(netplay.snapshot(), []);

  // 端口：默认 25565，越界或非法值回落，自定义端口要带进地址。
  assert.strictEqual(netplay.normalizePort(99999), 25565);
  assert.strictEqual(netplay.normalizePort('abc'), 25565);
  assert.strictEqual(netplay.normalizePort(25566), 25566);
  for (const item of netplay.localAddresses(25566)) {
    assert.strictEqual(item.port, 25566);
    assert.strictEqual(item.text, `${item.address}:25566`);
  }

  // 配置导出 / 导入：两端用同一套 id 规则，坏 id 不应出现在导出结果里。
  const exported = netplay.exportProfiles([
    { id: 'room-1', name: profile.name, tool: 'terracotta', executable: exe, args: ['--room', 'my room'], autoCopy: true },
    { id: 'bad id!', name: 'bad', executable: exe },
  ]);
  assert.strictEqual(exported.profiles.length, 1);
  assert.strictEqual(exported.profiles[0].id, 'room-1');
  const imported = netplay.importProfiles(JSON.stringify(exported));
  assert.strictEqual(imported.profiles.length, 1);
  assert.deepStrictEqual(imported.profiles[0].args, ['--room', 'my room']);
  assert.throws(() => netplay.importProfiles('{"profiles":[]}'), /没有可导入的配置/);
  const partial = netplay.importProfiles(JSON.stringify({
    profiles: [{ id: 'ok-1', name: 'A', executable: exe }, { id: 'no-exe', name: 'B' }],
  }));
  assert.strictEqual(partial.profiles.length, 1);
  assert.strictEqual(partial.warnings.length, 1);

  // 联机信息：带空格的参数要加引号，并且要包含地址。
  const share = netplay.buildShareText(
    { id: 'room-1', name: profile.name, tool: 'terracotta', executable: exe, args: ['--room', 'my room'] },
    { port: 25565 },
  );
  assert.match(share.text, /"my room"/);
  assert.match(share.text, /:25565/);

  console.log('netplay tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}