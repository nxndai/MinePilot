'use strict';

/**
 * 浏览器/Edge 应用窗口模式下的 IPC 兼容层。
 * 如果 preload 已注入 window.mp（Electron 模式），这里什么也不做。
 */
(function () {
  if (window.mp) return;

  document.documentElement.classList.add('web-mode');

  const listeners = new Map();
  let source = null;

  function dispatch(channel, payload) {
    const list = listeners.get(channel);
    if (!list) return;
    for (const callback of list.slice()) {
      try {
        callback(payload);
      } catch (err) {
        console.error('[MinePilot] 事件处理失败', channel, err);
      }
    }
  }

  function connect() {
    try {
      source = new EventSource('/api/events');
      source.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message && message.channel) dispatch(message.channel, message.payload);
        } catch (err) {
          /* 忽略非 JSON 心跳 */
        }
      };
    } catch (err) {
      console.error('[MinePilot] 无法连接本地服务', err);
    }
  }

  async function uploadPack(file) {
    if (!file) return { ok: false, error: '没有选择文件' };
    const response = await fetch(`/api/pack-upload?name=${encodeURIComponent(file.name || 'pack.zip')}`, {
      method: 'POST',
      body: file,
    });
    const payload = await response.json();
    if (!payload || !payload.ok) throw new Error((payload && payload.error) || '上传整合包失败');
    return payload;
  }

  function downloadFile(filePath) {
    if (!filePath) return false;
    const link = document.createElement('a');
    link.href = `/api/download?path=${encodeURIComponent(filePath)}`;
    link.download = String(filePath).split(/[\\/]/).pop() || 'MinePilot-pack.zip';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => { try { link.remove(); } catch (err) { /* ignore */ } }, 1000);
    return true;
  }

  function pickPack() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.mrpack,.zip';
      input.style.display = 'none';
      document.body.appendChild(input);
      const finish = (value) => {
        try { input.remove(); } catch (err) { /* ignore */ }
        resolve(value);
      };
      input.addEventListener('cancel', () => finish({ ok: false, canceled: true }), { once: true });
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) {
          finish({ ok: false, canceled: true });
          return;
        }
        try {
          const uploaded = await uploadPack(file);
          finish({ ok: true, path: uploaded.path, fileName: uploaded.fileName });
        } catch (err) {
          finish({ ok: false, error: err.message });
        }
      }, { once: true });
      input.click();
    });
  }

  async function invoke(channel, ...args) {
    if (channel === 'dialog:pick-folder' || channel === 'dialog:pick-file') {
      if (window.MP && MP.toast) MP.toast('浏览器版请直接在输入框中填写路径', 'info');
      return null;
    }
    const response = await fetch('/api/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args }),
    });
    const payload = await response.json();
    if (!payload || !payload.ok) {
      throw new Error((payload && payload.error) || `请求失败（HTTP ${response.status}）`);
    }
    return payload.result;
  }

  window.mp = {
    invoke,
    pathForFile: () => '',
    pickPack,
    uploadPack,
    downloadFile,
    on(channel, callback) {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(callback);
      return () => {
        const list = listeners.get(channel);
        if (!list) return;
        const index = list.indexOf(callback);
        if (index >= 0) list.splice(index, 1);
      };
    },
    minimize() {},
    toggleMaximize() {},
    close() {
      invoke('app:quit').catch(() => {});
    },
  };

  connect();
})();