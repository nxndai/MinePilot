'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const POWERSHELL_TIMEOUT_MS = 30000;
const CLEANUP_WAIT_MS = 600;

// 这些进程承担系统外壳、登录、桌面合成或安全功能。清理它们通常只会
// 造成桌面卡顿，释放的内存也很有限，因此默认跳过。
const SKIP_PROCESS_NAMES = [
  'system',
  'idle',
  'registry',
  'memory compression',
  'smss',
  'csrss',
  'wininit',
  'winlogon',
  'services',
  'lsass',
  'dwm',
  'fontdrvhost',
  'sihost',
  'taskhostw',
  'explorer',
  'startmenuexperiencehost',
  'shellexperiencehost',
  'searchhost',
  'textinputhost',
  'audiodg',
  'msmpeng',
  'nissrv',
  'securityhealthservice',
];

function stats() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const totalMb = Math.round(totalBytes / 1048576);
  const freeMb = Math.round(freeBytes / 1048576);
  const usedMb = Math.max(0, totalMb - freeMb);
  const percent = totalBytes > 0
    ? Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10
    : 0;
  return {
    supported: process.platform === 'win32',
    totalMb,
    freeMb,
    usedMb,
    percent: Math.max(0, Math.min(100, percent)),
  };
}

function buildCleanScript(skipPids, tempDir) {
  const pids = Array.from(new Set(skipPids.filter((pid) => Number.isInteger(pid) && pid > 0)));
  const names = SKIP_PROCESS_NAMES.map((name) => `'${name.replace(/'/g, "''")}'`).join(',');
  const safeTemp = String(tempDir || path.join(os.tmpdir(), 'minepilot-clean')).replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
$env:TEMP = '${safeTemp}'
$env:TMP = $env:TEMP
if (-not (Test-Path -LiteralPath $env:TEMP)) {
    New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
}
$skipPids = @(${pids.join(',')}) + @($PID)
$skipNames = @(${names})
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MinePilotMemory
{
    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_SET_QUOTA = 0x0100;

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool EmptyWorkingSet(IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    public static bool Trim(int processId)
    {
        IntPtr handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA, false, processId);
        if (handle == IntPtr.Zero) return false;
        try
        {
            return EmptyWorkingSet(handle);
        }
        finally
        {
            CloseHandle(handle);
        }
    }
}
'@
$nativeReady = $true
} catch {
    # 某些受限环境不允许 Add-Type 写临时文件。此时退回 .NET 的
    # MaxWorkingSet 临时限制，同样会触发 Windows 回收工作集。
    $nativeReady = $false
}

$trimmed = 0
$failed = 0
$skipped = 0
foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
    try {
        if ($skipPids -contains $process.Id -or $skipNames -contains $process.ProcessName.ToLowerInvariant()) {
            $skipped += 1
            continue
        }
        if ($nativeReady) {
            if ([MinePilotMemory]::Trim($process.Id)) {
                $trimmed += 1
            } else {
                $failed += 1
            }
            continue
        }

        $min = [int64]$process.MinWorkingSet
        $max = [int64]$process.MaxWorkingSet
        $target = [int64](1MB)
        if ($target -lt $min) { $target = $min }
        if ($max -le $target -or $process.WorkingSet64 -le $target) {
            $skipped += 1
            continue
        }
        $changed = $false
        try {
            $process.MaxWorkingSet = [IntPtr]$target
            $changed = $true
            Start-Sleep -Milliseconds 20
        } finally {
            if ($changed) {
                try { $process.MaxWorkingSet = [IntPtr]$max } catch { }
            }
        }
        $trimmed += 1
    } catch {
        $failed += 1
    }
}
[pscustomobject]@{
    trimmed = $trimmed
    failed = $failed
    skipped = $skipped
    mode = $(if ($nativeReady) { 'native' } else { 'dotnet' })
} | ConvertTo-Json -Compress
`;
}

function parsePowerShellResult(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      return JSON.parse(line);
    } catch (err) {
      // 继续尝试上一行，PowerShell 可能输出额外的警告信息。
    }
  }
  return null;
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (err) { /* ignore */ }
      finish({ ok: false, error: '内存清理超时' });
    }, POWERSHELL_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => finish({ ok: false, error: err.message }));
    child.on('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, error: stderr.trim() || `PowerShell 退出代码 ${code}` });
        return;
      }
      const parsed = parsePowerShellResult(stdout);
      if (!parsed) {
        finish({ ok: false, error: stderr.trim() || '无法解析内存清理结果' });
        return;
      }
      finish({ ok: true, result: parsed });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clean(options = {}) {
  const before = stats();
  if (!before.supported) {
    return {
      ok: false,
      code: 'UNSUPPORTED',
      error: '当前系统不支持这项内存清理功能',
      before,
      after: before,
    };
  }

  const startedAt = Date.now();
  const tempDir = options.tempDir || path.join(os.tmpdir(), 'minepilot-clean');
  try {
    fs.mkdirSync(tempDir, { recursive: true });
  } catch (err) {
    // PowerShell 仍会尝试创建目录；失败时退回不需要临时文件的方式。
  }
  const result = await runPowerShell(buildCleanScript(options.skipPids || [], tempDir));
  if (!result.ok) {
    return {
      ok: false,
      code: 'CLEAN_FAILED',
      error: result.error || '内存清理失败',
      before,
      after: stats(),
      durationMs: Date.now() - startedAt,
    };
  }

  // 给 Windows 一点时间回收工作集，再读取清理后的数据。
  await delay(CLEANUP_WAIT_MS);
  const after = stats();
  return {
    ok: true,
    before,
    after,
    freedMb: Math.max(0, before.usedMb - after.usedMb),
    trimmed: Number(result.result.trimmed) || 0,
    failed: Number(result.result.failed) || 0,
    skipped: Number(result.result.skipped) || 0,
    mode: result.result.mode || '',
    durationMs: Date.now() - startedAt,
  };
}

module.exports = { stats, clean, buildCleanScript };