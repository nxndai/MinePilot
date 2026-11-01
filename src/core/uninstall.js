'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeDir(value, label) {
  if (!value) throw new Error(`${label}不能为空`);
  const resolved = path.resolve(String(value));
  if (resolved.length <= 3) throw new Error(`${label}不能是磁盘根目录`);
  return resolved;
}

function validateAppDir(value) {
  const appDir = normalizeDir(value, '启动器目录');
  if (!fs.existsSync(path.join(appDir, 'MinePilot.exe'))) {
    throw new Error('没有找到 MinePilot.exe，已取消删除');
  }
  return appDir;
}

/**
 * 生成一个在启动器退出后执行的清理脚本。
 *
 * 只删除程序目录、快捷方式和卸载登记；设置、账户、缓存与游戏数据默认保留。
 * 便携版的 data 目录位于程序目录内，因此删除程序目录的子项时必须跳过它，
 * 不能直接递归删除整个程序目录。
 */
function buildRemovalScript(options) {
  const appDir = normalizeDir(options.appDir, '启动器目录');
  const dataDir = options.dataDir ? normalizeDir(options.dataDir, '数据目录') : '';
  const pid = Number(options.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('启动器进程号无效');
  const cleanShell = options.cleanShell !== false;
  const logFile = path.join(os.tmpdir(), 'MinePilot-uninstall.log');

  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$parentPid = ${pid}`,
    `$appDir = ${quote(appDir)}`,
    `$dataDir = ${quote(dataDir)}`,
    `$cleanShell = $${cleanShell ? 'true' : 'false'}`,
    `$logFile = ${quote(logFile)}`,
    '',
    'function Write-Log([string]$text) {',
    '  try { Add-Content -LiteralPath $logFile -Value ((Get-Date).ToString("yyyy-MM-dd HH:mm:ss") + " " + $text) -Encoding UTF8 } catch { }',
    '}',
    '',
    'function Remove-Tree([string]$target) {',
    '  if ([string]::IsNullOrWhiteSpace($target)) { return $true }',
    '  $full = [IO.Path]::GetFullPath($target).TrimEnd("\\")',
    '  for ($i = 0; $i -lt 20; $i++) {',
    '    if (-not (Test-Path -LiteralPath $full)) { return $true }',
    '    try {',
    '      Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop',
    '      if (-not (Test-Path -LiteralPath $full)) { return $true }',
    '    } catch { }',
    '    Start-Sleep -Milliseconds 300',
    '  }',
    '  try { & cmd.exe /d /c ("rd /s /q " + [char]34 + $full + [char]34) | Out-Null } catch { }',
    '  return -not (Test-Path -LiteralPath $full)',
    '}',
    '',
    '# 等待启动器完全退出，避免 exe / dll / Chromium 子进程占用文件。',
    '$deadline = (Get-Date).AddSeconds(30)',
    'while ((Get-Date) -lt $deadline) {',
    '  $running = Get-Process -Id $parentPid -ErrorAction SilentlyContinue',
    '  if (-not $running) { break }',
    '  Start-Sleep -Milliseconds 250',
    '}',
    'if (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) {',
    '  Write-Log "主进程 30 秒内未退出，尝试强制结束"',
    '  try { Stop-Process -Id $parentPid -Force -ErrorAction SilentlyContinue } catch { }',
    '  Start-Sleep -Milliseconds 800',
    '}',
    'Start-Sleep -Milliseconds 350',
    '',
    'if ($cleanShell) {',
    '  $desktop = [Environment]::GetFolderPath("Desktop")',
    '  Remove-Tree (Join-Path $desktop "MinePilot.lnk") | Out-Null',
    '  $programs = [Environment]::GetFolderPath("Programs")',
    '  try {',
    '    Get-ChildItem -LiteralPath $programs -Filter "*MinePilot*.lnk" -File -ErrorAction SilentlyContinue | ForEach-Object { Remove-Tree $_.FullName | Out-Null }',
    '  } catch { }',
    '  Remove-Tree (Join-Path $programs "MinePilot") | Out-Null',
    '  Remove-Item -LiteralPath "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MinePilot" -Recurse -Force -ErrorAction SilentlyContinue',
    '}',
    '',
    '$appFull = [IO.Path]::GetFullPath($appDir).TrimEnd("\\")',
    '$dataFull = ""',
    'if (-not [string]::IsNullOrWhiteSpace($dataDir)) { $dataFull = [IO.Path]::GetFullPath($dataDir).TrimEnd("\\") }',
    '$dataInside = $false',
    'if ($dataFull) {',
    '  $dataInside = ($dataFull -eq $appFull) -or $dataFull.StartsWith($appFull + "\\", [StringComparison]::OrdinalIgnoreCase)',
    '}',
    '',
    'if (Test-Path -LiteralPath $appFull) {',
    '  if ($dataInside -and ($dataFull -ne $appFull)) {',
    '    Write-Log "删除程序目录内容，保留数据目录: $dataFull"',
    '    Get-ChildItem -LiteralPath $appFull -Force -ErrorAction SilentlyContinue | ForEach-Object {',
    '      $childFull = $_.FullName',
    '      if ($childFull -eq $dataFull) { return }',
    '      if ($dataFull.StartsWith($childFull + "\\", [StringComparison]::OrdinalIgnoreCase)) { return }',
    '      Remove-Tree $childFull | Out-Null',
    '    }',
    '  } elseif ($dataFull -eq $appFull) {',
    '    Write-Log "数据目录与程序目录相同，取消删除程序目录"',
    '  } else {',
    '    Write-Log "删除程序目录: $appFull"',
    '    Remove-Tree $appFull | Out-Null',
    '  }',
    '}',
    '',
    'Write-Log "清理完成"',
    'try { Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue } catch { }',
  ].join('\r\n');
}

/**
 * 启动后台清理进程。调用方随后应退出当前启动器。
 * 返回脚本路径便于测试和排查，不会等待删除完成。
 */
function scheduleRemoval(options) {
  if (process.platform !== 'win32') {
    return { ok: false, code: 'UNSUPPORTED', error: '仅 Windows 支持删除启动器' };
  }
  const appDir = validateAppDir(options.appDir);
  const dataDir = options.dataDir ? normalizeDir(options.dataDir, '数据目录') : '';
  const scriptDir = options.scriptDir ? normalizeDir(options.scriptDir, '脚本目录') : os.tmpdir();
  const script = buildRemovalScript({
    appDir,
    dataDir,
    pid: options.pid,
    cleanShell: options.cleanShell,
  });
  fs.mkdirSync(scriptDir, { recursive: true });
  const scriptPath = path.join(scriptDir, `minepilot-remove-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8');

  const child = spawn(POWERSHELL, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  // 启动失败时不要让未处理的 error 事件中断主进程；调用方会按返回结果退出。
  child.once('error', () => {});
  child.unref();
  return { ok: true, scriptPath, appDir, dataDir };
}

module.exports = {
  buildRemovalScript,
  scheduleRemoval,
  validateAppDir,
};