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
  console.log('netplay tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}