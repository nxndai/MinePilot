'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const USER_AGENT = 'MinePilot/1.10.0';

let fetchImpl = null;

/**
 * 取一个 HTTP 客户端。
 *
 * 桌面版优先用 Electron 的网络栈：它信任系统根证书、跟随系统代理，
 * 能穿过企业代理或网络加速器的 TLS 中间人；Node 自带的 fetch 只认内置 CA，
 * 遇到这类环境会直接报 UNABLE_TO_VERIFY_LEAF_SIGNATURE。
 * 测试和 Web 服务模式下没有 Electron，自动退回全局 fetch。
 */
function httpFetch() {
  if (fetchImpl) return fetchImpl;
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') {
      fetchImpl = (url, options) => electron.net.fetch(url, options);
      return fetchImpl;
    }
  } catch (err) {
    /* 非 Electron 环境，用下面的全局 fetch */
  }
  fetchImpl = (url, options) => fetch(url, options);
  return fetchImpl;
}

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
      const response = await httpFetch()(url, {
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
      const response = await httpFetch()(url, {
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
    idleTimeout = 15000,
    resume = false,
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

  const temp = `${destination}.part`;
  if (!resume) {
    try { fs.rmSync(temp, { force: true }); } catch (err) { /* ignore */ }
  }

  let lastError = null;
  for (let c = 0; c < candidates.length; c += 1) {
    const candidate = candidates[c];
    // 有备用源时，主源只试一次，尽快切换；单独一个源时才多次重试。
    const attempts = c === 0 ? (fallbackUrl ? 1 : retries) : retries;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal && signal.aborted) throw abortError();
      let fd = null;
      let idleTimer = null;
      let idleTimedOut = false;
      const controller = new AbortController();
      const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimedOut = true;
          controller.abort();
        }, idleTimeout);
      };
      const combinedSignal = signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, controller.signal])
        : (signal || controller.signal);
      // 断点续传：已有 .part 就带上 Range，从断点续上，避免大文件重下。
      let startAt = 0;
      if (resume) {
        try { startAt = fs.existsSync(temp) ? fs.statSync(temp).size : 0; } catch (err) { startAt = 0; }
      }
      try {
        bumpIdle();
        const requestHeaders = Object.assign({ 'User-Agent': USER_AGENT }, headers);
        if (startAt > 0) requestHeaders.Range = `bytes=${startAt}-`;
        const response = await httpFetch()(candidate, {
          signal: combinedSignal,
          headers: requestHeaders,
        });
        if (startAt > 0 && response.status === 200) {
          // 服务器不支持断点续传，丢掉旧分片从头来。
          startAt = 0;
          try { fs.rmSync(temp, { force: true }); } catch (e) { /* ignore */ }
        }
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
        const hash = sha1 && startAt === 0 ? crypto.createHash('sha1') : null;
        fd = fs.openSync(temp, startAt > 0 ? 'a' : 'w');
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

        const size = fs.statSync(temp).size;
        if (sha1) {
          // 续传时无法继续累加哈希，改为对整份文件重新计算。
          const digest = startAt > 0 ? await sha1File(temp) : hash.digest('hex');
          if (digest !== sha1) {
            try { fs.rmSync(temp, { force: true }); } catch (e) { /* ignore */ }
            throw new Error('SHA1 校验失败，文件可能已损坏');
          }
        }
        fs.rmSync(destination, { force: true });
        fs.renameSync(temp, destination);
        return { skipped: false, size, source: candidate, resumed: startAt > 0 };
      } catch (err) {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch (e) { /* ignore */ }
        }
        // 续传模式保留分片，下次从断点继续；普通下载失败则清理。
        if (!resume) {
          try { fs.unlinkSync(temp); } catch (e) { /* ignore */ }
        }
        if (signal && signal.aborted) throw abortError();
        lastError = idleTimedOut ? new Error('下载超时，连接长时间没有数据') : err;
        if (attempt < attempts - 1) await sleep(700 * (attempt + 1));
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
    }
  }
  if (resume) {
    try { fs.rmSync(temp, { force: true }); } catch (err) { /* ignore */ }
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