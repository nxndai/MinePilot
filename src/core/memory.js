'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const POWERSHELL_TIMEOUT_MS = 30000;
const ELEVATED_TIMEOUT_MS = 120000;
const CLEANUP_WAIT_MS = 1200;

// 这些进程承担桌面合成、字体渲染、音频、登录或安全功能。清理它们
// 容易造成黑屏、音频中断或安全软件异常，因此两种模式都默认跳过。
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

function buildCleanScript(skipPids, tempDir, options = {}) {
  const pids = Array.from(new Set(skipPids.filter((pid) => Number.isInteger(pid) && pid > 0)));
  const names = SKIP_PROCESS_NAMES.map((name) => `'${name.replace(/'/g, "''")}'`).join(',');
  const safeTemp = String(tempDir || path.join(os.tmpdir(), 'minepilot-clean')).replace(/'/g, "''");
  const safeResult = String(options.resultPath || '').replace(/'/g, "''");
  const allowSystemWide = options.allowSystemWide !== false ? '$true' : '$false';
  return `
$ErrorActionPreference = 'Stop'
$env:TEMP = '${safeTemp}'
$env:TMP = $env:TEMP
if (-not (Test-Path -LiteralPath $env:TEMP)) {
    New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
}
$skipPids = @(${pids.join(',')}) + @($PID)
$skipNames = @(${names})
$allowSystemWide = ${allowSystemWide}
$resultPath = '${safeResult}'
$isAdmin = $false
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MinePilotMemory
{
    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_SET_QUOTA = 0x0100;
    private const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint SE_PRIVILEGE_ENABLED = 0x00000002;
    private const int SystemMemoryListInformation = 0x50;
    private const int MemoryEmptyWorkingSets = 2;
    private const int MemoryFlushModifiedList = 3;
    private const int MemoryPurgeStandbyList = 4;

    [StructLayout(LayoutKind.Sequential)]
    private struct LUID
    {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LUID_AND_ATTRIBUTES
    {
        public LUID Luid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_PRIVILEGES
    {
        public uint PrivilegeCount;
        public LUID_AND_ATTRIBUTES Privileges;
    }

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool EmptyWorkingSet(IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool LookupPrivilegeValue(string systemName, string name, out LUID luid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AdjustTokenPrivileges(IntPtr tokenHandle, bool disableAllPrivileges, ref TOKEN_PRIVILEGES newState, uint bufferLength, IntPtr previousState, IntPtr returnLength);

    [DllImport("ntdll.dll")]
    private static extern int NtSetSystemInformation(int informationClass, ref int information, int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetSystemFileCacheSize(IntPtr minimumFileCacheSize, IntPtr maximumFileCacheSize, uint flags);

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

    public static bool EnableProfilePrivilege()
    {
        IntPtr token = IntPtr.Zero;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, out token)) return false;
        try
        {
            LUID luid;
            if (!LookupPrivilegeValue(null, "SeProfileSingleProcessPrivilege", out luid)) return false;
            TOKEN_PRIVILEGES privileges = new TOKEN_PRIVILEGES();
            privileges.PrivilegeCount = 1;
            privileges.Privileges.Luid = luid;
            privileges.Privileges.Attributes = SE_PRIVILEGE_ENABLED;
            bool adjusted = AdjustTokenPrivileges(
                token,
                false,
                ref privileges,
                (uint)Marshal.SizeOf(typeof(TOKEN_PRIVILEGES)),
                IntPtr.Zero,
                IntPtr.Zero);
            return adjusted && Marshal.GetLastWin32Error() == 0;
        }
        finally
        {
            CloseHandle(token);
        }
    }

    public static int EmptyAllWorkingSets()
    {
        int command = MemoryEmptyWorkingSets;
        return NtSetSystemInformation(SystemMemoryListInformation, ref command, sizeof(int));
    }

    public static int FlushModifiedList()
    {
        int command = MemoryFlushModifiedList;
        return NtSetSystemInformation(SystemMemoryListInformation, ref command, sizeof(int));
    }

    public static int PurgeStandbyList()
    {
        int command = MemoryPurgeStandbyList;
        return NtSetSystemInformation(SystemMemoryListInformation, ref command, sizeof(int));
    }

    public static int SetFileCache(IntPtr minimum, IntPtr maximum)
    {
        if (SetSystemFileCacheSize(minimum, maximum, 0)) return 0;
        return Marshal.GetLastWin32Error();
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

$deep = $false
$privilege = $false
$systemWide = $false
$cacheCleared = $false
$systemErrors = @()
if ($isAdmin -and $nativeReady) {
    $privilege = [MinePilotMemory]::EnableProfilePrivilege()
    if ($privilege) {
        if ($allowSystemWide) {
            $status = [MinePilotMemory]::EmptyAllWorkingSets()
            if ($status -eq 0) {
                $systemWide = $true
            } else {
                $systemErrors += ('empty:' + $status)
            }
        }

        $status = [MinePilotMemory]::FlushModifiedList()
        if ($status -ne 0) { $systemErrors += ('flush:' + $status) }

        $status = [MinePilotMemory]::PurgeStandbyList()
        if ($status -ne 0) { $systemErrors += ('standby:' + $status) }

        $cacheStatus = [MinePilotMemory]::SetFileCache([IntPtr]::Zero, [IntPtr]::Zero)
        if ($cacheStatus -eq 0) {
            $cacheCleared = $true
            Start-Sleep -Milliseconds 150
            [void][MinePilotMemory]::SetFileCache([IntPtr](-1), [IntPtr](-1))
        } else {
            $systemErrors += ('cache:' + $cacheStatus)
        }
        $deep = $true
    } else {
        $systemErrors += 'privilege'
    }
}

$payload = [pscustomobject]@{
    trimmed = $trimmed
    failed = $failed
    skipped = $skipped
    mode = $(if ($nativeReady) { 'native' } else { 'dotnet' })
    admin = $isAdmin
    deep = $deep
    privilege = $privilege
    systemWide = $systemWide
    cacheCleared = $cacheCleared
    systemErrors = $systemErrors
}
$json = $payload | ConvertTo-Json -Compress
if ($resultPath) {
    try {
        [IO.File]::WriteAllText($resultPath, $json, (New-Object Text.UTF8Encoding($false)))
    } catch { }
}
$json
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

function runPowerShellRaw(script, timeoutMs = POWERSHELL_TIMEOUT_MS) {
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
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => finish({ ok: false, error: err.message }));
    child.on('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, code, error: stderr.trim() || `PowerShell 退出代码 ${code}`, stderr, stdout });
        return;
      }
      finish({ ok: true, code, stdout, stderr });
    });
  });
}

async function runPowerShell(script) {
  const result = await runPowerShellRaw(script);
  if (!result.ok) return result;
  const parsed = parsePowerShellResult(result.stdout);
  if (!parsed) {
    return { ok: false, error: result.stderr.trim() || '无法解析内存清理结果' };
  }
  return { ok: true, result: parsed };
}

async function runElevatedPowerShell(script, resultPath) {
  try { fs.unlinkSync(resultPath); } catch (err) { /* ignore */ }
  const scriptPath = `${resultPath}.ps1`;
  let written = false;
  try {
    // 深度清理脚本较长，不能把两层 Base64 都塞进命令行；写入临时脚本后
    // 让提升后的 PowerShell 用 -File 执行，避免超过 Windows 命令行上限。
    fs.writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8');
    written = true;
    const safeScriptPath = scriptPath.replace(/'/g, "''");
    const launcher = `
$ErrorActionPreference = 'Stop'
$scriptPath = '${safeScriptPath}'
$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $scriptPath + '"'))
try {
    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
    exit $process.ExitCode
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`;
    const raw = await runPowerShellRaw(launcher, ELEVATED_TIMEOUT_MS);
    if (!raw.ok) return { ok: false, error: raw.error, code: raw.code };
    let text = '';
    try {
      text = fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '');
    } catch (err) {
      return { ok: false, error: '无法读取深度清理结果' };
    }
    try {
      return { ok: true, result: JSON.parse(text) };
    } catch (err) {
      return { ok: false, error: '无法解析深度清理结果' };
    }
  } finally {
    if (written) {
      try { fs.unlinkSync(scriptPath); } catch (err) { /* ignore */ }
    }
  }
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

  const skipPids = options.skipPids || [];
  const allowSystemWide = options.allowSystemWide !== false;
  const allowElevate = options.elevate !== false;
  const resultPath = path.join(tempDir, `deep-memory-${process.pid}-${Date.now()}.json`);
  const base = await runPowerShell(buildCleanScript(skipPids, tempDir, { allowSystemWide }));
  if (!base.ok) {
    return {
      ok: false,
      code: 'CLEAN_FAILED',
      error: base.error || '内存清理失败',
      before,
      after: stats(),
      durationMs: Date.now() - startedAt,
    };
  }

  let payload = base.result;
  let elevated = false;
  let elevationError = '';
  if (payload.admin !== true && allowElevate) {
    const deepScript = buildCleanScript(skipPids, tempDir, {
      allowSystemWide,
      resultPath,
    });
    try {
      const deep = await runElevatedPowerShell(deepScript, resultPath);
      if (deep.ok) {
        payload = deep.result;
        elevated = true;
      } else {
        elevationError = deep.error || '深度清理未执行';
      }
    } catch (err) {
      elevationError = err.message || '深度清理未执行';
    }
  }
  try { fs.unlinkSync(resultPath); } catch (err) { /* ignore */ }

  // 系统级清理会异步回收页面，给 Windows 一点时间再读取数据。
  await delay(CLEANUP_WAIT_MS);
  const after = stats();
  const admin = payload.admin === true;
  const deep = payload.deep === true;
  return {
    ok: true,
    before,
    after,
    freedMb: Math.max(0, before.usedMb - after.usedMb),
    trimmed: Number(payload.trimmed) || 0,
    failed: Number(payload.failed) || 0,
    skipped: Number(payload.skipped) || 0,
    mode: payload.mode || '',
    admin,
    deep,
    elevated,
    needsAdmin: !admin,
    systemWide: payload.systemWide === true,
    cacheCleared: payload.cacheCleared === true,
    elevationError,
    durationMs: Date.now() - startedAt,
  };
}

module.exports = { stats, clean, buildCleanScript };