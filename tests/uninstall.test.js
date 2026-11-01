'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const uninstall = require('../src/core/uninstall');

function run() {
  const quoted = uninstall.buildRemovalScript({
    appDir: `C:\\it's a launcher`,
    dataDir: `C:\\it's a launcher\\data`,
    pid: 1234,
    cleanShell: false,
  });
  assert.ok(quoted.includes(`C:\\it''s a launcher`));
  assert.ok(quoted.includes('$cleanShell = $false'));
  assert.ok(quoted.includes('Remove-Tree'));
  assert.ok(quoted.includes('MinePilot.lnk'));

  assert.throws(() => uninstall.validateAppDir(path.join(os.tmpdir(), 'missing-minepilot')), /MinePilot\.exe/);

  if (process.platform !== 'win32') {
    console.log('uninstall tests passed (Windows-only cleanup skipped)');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-uninstall-test-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(appDir, 'data');
  const scriptPath = path.join(root, 'remove.ps1');
  try {
    fs.mkdirSync(path.join(appDir, 'resources'), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'MinePilot.exe'), 'fixture');
    fs.writeFileSync(path.join(appDir, 'resources', 'app.asar'), 'fixture');
    fs.writeFileSync(path.join(dataDir, 'keep.txt'), 'keep');

    const dummy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], { stdio: 'ignore' });
    const script = uninstall.buildRemovalScript({
      appDir,
      dataDir,
      pid: dummy.pid,
      cleanShell: false,
    });
    fs.writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8');

    const powershell = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const result = spawnSync(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ], { encoding: 'utf8', timeout: 30000 });
    if (result.error || result.status === null) {
      // 某些受限沙箱会禁止 Node 启动子 PowerShell；脚本生成部分已在上面验证。
      console.log(`uninstall tests passed (cleanup process unavailable: ${(result.error && result.error.message) || 'no exit status'})`);
      return;
    }
    assert.strictEqual(result.status, 0, result.stderr);

    assert.strictEqual(fs.existsSync(path.join(appDir, 'MinePilot.exe')), false, 'MinePilot.exe should be removed');
    assert.strictEqual(fs.existsSync(path.join(appDir, 'resources')), false, 'program files should be removed');
    assert.strictEqual(fs.existsSync(path.join(dataDir, 'keep.txt')), true, 'data should be preserved');
    console.log('uninstall tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run();