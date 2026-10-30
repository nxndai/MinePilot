'use strict';

const { execFile } = require('child_process');
const platform = require('./platform');

/**
 * 跨平台读取单个进程的资源占用。
 * Windows 使用 PowerShell + Win32_Process（无需管理员权限），
 * 其他平台退回 ps；查询失败时返回 available:false，而不是阻塞界面。
 */

const CACHE_MS = 650;
let cache = { pid: 0, at: 0, value: null };

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function run(command, args, timeout = 4500) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, {
        windowsHide: true,
        timeout,
        maxBuffer: 512 * 1024,
      }, (err, stdout) => {
        if (err && !stdout) {
          resolve(null);
          return;
        }
        resolve(String(stdout || ''));
      });
    } catch (err) {
      resolve(null);
    }
  });
}

async function queryWindows(pid) {
  // Get-Process 不需要管理员权限，也不会触发部分系统上的 WMI 访问限制。
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$p = Get-Process -Id ${pid} -ErrorAction Stop`,
    '[pscustomobject]@{ ProcessId = [int]$p.Id; WorkingSetSize = [double]$p.WorkingSet64; CpuSeconds = [double]$p.CPU; ThreadCount = [int]$p.Threads.Count } | ConvertTo-Json -Compress',
  ].join('\n');
  const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!output) return null;
  const text = output.trim();
  if (!text) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return null;
  }
  if (!data || Number(data.ProcessId) !== pid) return null;
  return {
    available: true,
    pid,
    memoryBytes: Math.max(0, Number(data.WorkingSetSize) || 0),
    cpuMs: Math.max(0, (Number(data.CpuSeconds) || 0) * 1000),
    threads: Math.max(0, Number(data.ThreadCount) || 0),
  };
}

function parsePsTime(text) {
  // macOS / Linux 的 TIME 可能是 mm:ss、hh:mm:ss 或 dd-hh:mm:ss
  const parts = String(text || '').trim().split('-');
  let days = 0;
  let clock = parts.pop() || '0';
  if (parts.length) days = Number(parts[0]) || 0;
  const nums = clock.split(':').map((part) => Number(part) || 0);
  let seconds = 0;
  if (nums.length === 3) seconds = nums[0] * 3600 + nums[1] * 60 + nums[2];
  else if (nums.length === 2) seconds = nums[0] * 60 + nums[1];
  else seconds = nums[0] || 0;
  return (days * 86400 + seconds) * 1000;
}

async function queryUnix(pid) {
  // Linux 的 ps 支持 nlwp（线程数）；macOS 的 ps 没有该字段，保持 0 并由界面显示“—”。
  const format = platform.isLinux ? 'rss=,time=,nlwp=' : 'rss=,time=';
  const output = await run('ps', ['-p', String(pid), '-o', format]);
  if (!output) return null;
  const match = /^\s*(\d+)\s+(\S+)(?:\s+(\d+))?\s*$/.exec(output);
  if (!match) return null;
  return {
    available: true,
    pid,
    memoryBytes: Number(match[1]) * 1024,
    cpuMs: parsePsTime(match[2]),
    threads: Number(match[3]) || 0,
  };
}

async function query(pid) {
  const id = Number(pid);
  if (!id || id < 1) return { available: false, alive: false, pid: id };
  const now = Date.now();
  if (cache.pid === id && now - cache.at < CACHE_MS) return Object.assign({}, cache.value);

  const result = process.platform === 'win32' ? await queryWindows(id) : await queryUnix(id);
  const value = result || { available: false, pid: id };
  value.alive = result ? true : alive(id);
  cache = { pid: id, at: now, value };
  return Object.assign({}, value);
}

module.exports = { query, alive };
