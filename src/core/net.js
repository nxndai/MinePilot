'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const USER_AGENT = 'MinePilot/1.8.0';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  return timeout;
}

async function fetchJson(url, options = {}) {
  const { timeout = 25000, signal, headers = {}, retries = 3 } = options;
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (signal && signal.aborted) throw new Error('已取消');
    try {
      const response = await fetch(url, {
        signal: combineSignals(signal, timeout),
        headers: Object.assign({ 'User-Agent': USER_AGENT, Accept: 'application/json' }, headers),
      });
      if (!response.ok) {
        const error = new Error(`请求失败（HTTP ${response.status}）`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (err) {
      lastError = err;
      if (signal && signal.aborted) throw new Error('已取消');
      if (err.status === 404) break;
      if (attempt < retries - 1) await sleep(400 * (attempt + 1));
    }
  }
  throw new Error(`${shortUrl(url)} 请求失败：${lastError ? lastError.message : '未知错误'}`);
}

async function fetchText(url, options = {}) {
  const { timeout = 25000, signal, headers = {}, retries = 3 } = options;
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: combineSignals(signal, timeout),
        headers: Object.assign({ 'User-Agent': USER_AGENT }, headers),
      });
      if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
      return await response.text();
    } catch (err) {
      lastError = err;
      if (signal && signal.aborted) throw new Error('已取消');
      if (attempt < retries - 1) await sleep(400 * (attempt + 1));
    }
  }
  throw lastError || new Error('请求失败');
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch (err) {
    return url;
  }
}

function hashFile(file, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function sha1File(file) {
  return hashFile(file, 'sha1');
}

function sha256File(file) {
  return hashFile(file, 'sha256');
}

/**
 * 下载单个文件，支持 SHA1 校验、断点续传（重下）、重试与取消。
 */
async function downloadFile(url, destination, options = {}) {
  const {
    sha1 = null,
    onBytes = null,
    signal = null,
    retries = 3,
    headers = {},
    fallbackUrl = null,
  } = options;

  fs.mkdirSync(path.dirname(destination), { recursive: true });

  if (sha1 && fs.existsSync(destination)) {
    try {
      if ((await sha1File(destination)) === sha1) {
        return { skipped: true, size: fs.statSync(destination).size };
      }
    } catch (err) {
      /* 文件损坏则重新下载 */
    }
  }

  const candidates = [url];
  if (fallbackUrl && fallbackUrl !== url) candidates.push(fallbackUrl);

  let lastError = null;
  for (let c = 0; c < candidates.length; c += 1) {
    const candidate = candidates[c];
    // 有备用源时，主源只试一次，尽快切换；单独一个源时才多次重试。
    const attempts = c === 0 ? (fallbackUrl ? 1 : retries) : retries;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal && signal.aborted) throw abortError();
      const temp = `${destination}.part`;
      let fd = null;
      let idleTimer = null;
      let idleTimedOut = false;
      const controller = new AbortController();
      const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimedOut = true;
          controller.abort();
        }, 15000);
      };
      const combinedSignal = signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, controller.signal])
        : (signal || controller.signal);
      try {
        bumpIdle();
        const response = await fetch(candidate, {
          signal: combinedSignal,
          headers: Object.assign({ 'User-Agent': USER_AGENT }, headers),
        });
        if (!response.ok) {
          if (response.body) {
            try { await response.body.cancel(); } catch (e) { /* ignore */ }
          }
          const error = new Error(`HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        if (!response.body) throw new Error('响应为空');

        const reader = response.body.getReader();
        const hash = sha1 ? crypto.createHash('sha1') : null;
        fd = fs.openSync(temp, 'w');
        let written = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bumpIdle();
          if (signal && signal.aborted) throw abortError();
          const buffer = Buffer.from(value);
          fs.writeSync(fd, buffer);
          if (hash) hash.update(buffer);
          written += buffer.length;
          if (onBytes) onBytes(buffer.length);
        }
        fs.closeSync(fd);
        fd = null;

        if (hash) {
          const digest = hash.digest('hex');
          if (digest !== sha1) throw new Error('SHA1 校验失败，文件可能已损坏');
        }
        fs.rmSync(destination, { force: true });
        fs.renameSync(temp, destination);
        return { skipped: false, size: written, source: candidate };
      } catch (err) {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch (e) { /* ignore */ }
        }
        try { fs.unlinkSync(temp); } catch (e) { /* ignore */ }
        if (signal && signal.aborted) throw abortError();
        lastError = idleTimedOut ? new Error('下载超时，连接长时间没有数据') : err;
        if (attempt < attempts - 1) await sleep(700 * (attempt + 1));
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
    }
  }
  throw new Error(`下载失败：${shortUrl(url)}（${lastError ? lastError.message : '未知错误'}）`);
}

function abortError() {
  const error = new Error('操作已取消');
  error.code = 'ABORTED';
  return error;
}

/**
 * 并发下载一组文件。items: { url, path, sha1, size, label }
 */
async function downloadMany(items, options = {}) {
  const {
    threads = 8,
    signal = null,
    onProgress = null,
    onItem = null,
  } = options;

  const totalFiles = items.length;
  const totalBytes = items.reduce((sum, item) => sum + (item.size || 0), 0);
  let nextIndex = 0;
  let doneFiles = 0;
  let doneBytes = 0;
  let liveBytes = 0;
  let active = 0;
  let aborted = false;
  const failures = [];
  let lastEmit = 0;

  const emit = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < 120) return;
    lastEmit = now;
    onProgress({
      totalFiles,
      doneFiles,
      totalBytes,
      doneBytes,
      receivedBytes: doneBytes + liveBytes,
      active,
    });
  };

  const workerCount = Math.max(1, Math.min(threads, totalFiles || 1));
  const workers = [];
  for (let w = 0; w < workerCount; w += 1) {
    workers.push((async () => {
      for (;;) {
        if (aborted || (signal && signal.aborted)) { aborted = true; return; }
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        const item = items[index];
        active += 1;
        let itemBytes = 0;
        try {
          const result = await downloadFile(item.url, item.path, {
            sha1: item.sha1,
            signal,
            fallbackUrl: item.fallbackUrl || null,
            onBytes: (count) => {
              itemBytes += count;
              liveBytes += count;
              emit();
            },
          });
          liveBytes = Math.max(0, liveBytes - itemBytes);
          doneFiles += 1;
          doneBytes += result.size || item.size || 0;
          if (onItem) onItem(item, result);
        } catch (err) {
          liveBytes = Math.max(0, liveBytes - itemBytes);
          if (signal && signal.aborted) { aborted = true; return; }
          failures.push({ item, error: err.message });
          if (failures.length >= 20) { aborted = true; return; }
        } finally {
          active -= 1;
          emit();
        }
      }
    })());
  }

  await Promise.all(workers);
  emit(true);

  if (signal && signal.aborted) throw abortError();
  if (aborted) {
    const error = new Error('下载失败的文件过多，已停止');
    error.failures = failures;
    throw error;
  }
  if (failures.length) {
    const error = new Error(`有 ${failures.length} 个文件下载失败：${failures[0].error}`);
    error.failures = failures;
    throw error;
  }
}

module.exports = {
  USER_AGENT,
  fetchJson,
  fetchText,
  downloadFile,
  downloadMany,
  sha1File,
  sha256File,
  abortError,
};