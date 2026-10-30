'use strict';

(function () {
  const { $ } = MP;

  const state = {
    plugins: [],
    workers: new Map(),
    workerUrls: new Map(),
    commands: [],
    errors: new Map(),
    loaded: false,
    installing: false,
  };

  const ALLOWED_EVENTS = new Set(['settings:changed', 'launch:exit', 'crash:detected']);
  const ALLOWED_INVOKE = new Set(['app:info', 'settings:get', 'versions:list', 'monitor:state', 'diagnostics:latest', 'java:detect']);

  function esc(value) {
    return MP.esc ? MP.esc(String(value == null ? '' : value)) : String(value == null ? '' : value);
  }

  function sanitizeSettings(value) {
    if (!value || typeof value !== 'object') return value;
    const copy = Object.assign({}, value);
    delete copy.curseforgeApiKey;
    delete copy.updateFeedUrl;
    return copy;
  }

  function workerBootstrap(plugin, source) {
    return `
'use strict';
const PLUGIN_ID = ${JSON.stringify(plugin.id)};
const PLUGIN_NAME = ${JSON.stringify(plugin.name || plugin.id)};
const ALLOWED_EVENTS = ${JSON.stringify(Array.from(ALLOWED_EVENTS))};
const commands = new Map();
const handlers = new Map();
const listeners = new Map();
const pending = new Map();
let sequence = 0;
function post(message) { self.postMessage(message); }
function safeText(value, max) { return String(value == null ? '' : value).slice(0, max || 500); }
self.minepilot = {
  apiVersion: 1,
  pluginId: PLUGIN_ID,
  pluginName: PLUGIN_NAME,
  toast(text, tone) {
    post({ type: 'toast', text: safeText(text, 400), tone: tone === 'err' ? 'err' : tone === 'ok' ? 'ok' : '' });
  },
  registerCommand(id, title, handler) {
    const commandId = safeText(id, 48);
    if (!/^[a-z0-9][a-z0-9._-]{0,47}$/i.test(commandId)) throw new Error('命令 id 只能包含字母、数字、点、下划线和短横线');
    if (typeof handler !== 'function') throw new Error('命令处理函数必须是函数');
    commands.set(commandId, { id: commandId, title: safeText(title || commandId, 80) });
    handlers.set(commandId, handler);
    post({ type: 'commands', commands: Array.from(commands.values()) });
  },
  on(event, handler) {
    const name = safeText(event, 60);
    if (!ALLOWED_EVENTS.includes(name)) throw new Error('不支持监听事件：' + name);
    if (typeof handler !== 'function') throw new Error('事件处理函数必须是函数');
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(handler);
  },
  invoke(channel, args) {
    return new Promise((resolve, reject) => {
      const requestId = ++sequence;
      pending.set(requestId, { resolve, reject });
      post({ type: 'invoke', requestId, channel: safeText(channel, 80), args: Array.isArray(args) ? args : [] });
    });
  },
};
self.addEventListener('message', async (event) => {
  const data = event.data || {};
  if (data.type === 'run-command') {
    const handler = handlers.get(data.id);
    if (!handler) { post({ type: 'command-result', id: data.id, ok: false, error: '命令不存在' }); return; }
    try {
      const result = await handler();
      post({ type: 'command-result', id: data.id, ok: true, result: result == null ? '' : safeText(result, 500) });
    } catch (err) {
      post({ type: 'command-result', id: data.id, ok: false, error: safeText(err && err.message || err, 400) });
    }
    return;
  }
  if (data.type === 'event') {
    const list = listeners.get(data.name) || [];
    for (const handler of list) {
      try { await handler(data.payload); } catch (err) { post({ type: 'toast', text: PLUGIN_NAME + '：' + safeText(err && err.message || err, 300), tone: 'err' }); }
    }
    return;
  }
  if (data.type === 'invoke-result') {
    const item = pending.get(data.requestId);
    if (!item) return;
    pending.delete(data.requestId);
    if (data.ok) item.resolve(data.result);
    else item.reject(new Error(data.error || '调用失败'));
  }
});
try {
(function () {
${source}
}).call(self);
} catch (err) {
  post({ type: 'load-error', error: safeText(err && err.message || err, 500) });
}
post({ type: 'ready', commands: Array.from(commands.values()) });
`;
  }

  function stopPlugin(id) {
    const worker = state.workers.get(id);
    if (worker) {
      try { worker.terminate(); } catch (err) { /* ignore */ }
      state.workers.delete(id);
    }
    const url = state.workerUrls.get(id);
    if (url) {
      try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ }
      state.workerUrls.delete(id);
    }
  }

  function stopAll() {
    for (const id of Array.from(state.workers.keys())) stopPlugin(id);
    state.commands = [];
  }

  function broadcastEvent(name, payload) {
    for (const worker of state.workers.values()) {
      try { worker.postMessage({ type: 'event', name, payload }); } catch (err) { /* ignore */ }
    }
  }

  function commandList() {
    const result = [];
    for (const plugin of state.plugins) {
      if (!plugin.enabled || state.errors.has(plugin.id)) continue;
      for (const command of state.commands.filter((item) => item.pluginId === plugin.id)) result.push(command);
    }
    return result;
  }

  function renderCommands() {
    const root = $('#plugin-commands');
    if (!root) return;
    const commands = commandList();
    if (!commands.length) {
      root.innerHTML = '<p class="muted-sm">已启用的插件还没有注册命令。插件可以在 main.js 中调用 <code>minepilot.registerCommand()</code>。</p>';
      return;
    }
    root.innerHTML = commands.map((command) => `
      <button class="plugin-command" data-plugin-command="${esc(command.pluginId)}:${esc(command.id)}">
        <span>${esc(command.title)}</span>
        <small>${esc(command.pluginName)}</small>
      </button>
    `).join('');
  }

  function renderList() {
    const root = $('#plugin-list');
    if (!root) return;
    if (!state.plugins.length) {
      root.innerHTML = '<p class="muted-sm">还没有安装插件。插件是本地 ZIP 包，不会自动从网络下载。</p>';
      renderCommands();
      return;
    }
    root.innerHTML = state.plugins.map((plugin) => {
      const error = state.errors.get(plugin.id) || plugin.error || '';
      return `
        <div class="plugin-row ${error ? 'has-error' : ''}">
          <div class="plugin-mark">${esc((plugin.name || plugin.id).slice(0, 1).toUpperCase())}</div>
          <div class="plugin-main">
            <div class="plugin-name">${esc(plugin.name || plugin.id)} <span>v${esc(plugin.version || '—')}</span>${plugin.enabled ? '' : '<span class="plugin-off">已停用</span>'}</div>
            <p>${esc(plugin.description || '没有填写说明。')}${plugin.author ? ` · ${esc(plugin.author)}` : ''}</p>
            ${error ? `<p class="plugin-error">${esc(error)}</p>` : ''}
          </div>
          <div class="plugin-actions">
            <label class="switch" title="${plugin.enabled ? '停用' : '启用'}"><input type="checkbox" data-plugin-toggle="${esc(plugin.id)}" ${plugin.enabled ? 'checked' : ''}><span></span></label>
            <button class="btn small ghost" data-plugin-remove="${esc(plugin.id)}">移除</button>
          </div>
        </div>
      `;
    }).join('');
    renderCommands();
  }

  async function loadAll() {
    stopAll();
    state.errors.clear();
    state.plugins = [];
    try {
      const result = await MP.api.invoke('plugins:list');
      if (!result || !result.ok) {
        if (result && result.error) MP.toast(`读取插件失败：${result.error}`, 'err');
        renderList();
        return;
      }
      state.plugins = result.plugins || [];
      renderList();
      for (const plugin of state.plugins) {
        if (!plugin.enabled || plugin.error) continue;
        await loadPlugin(plugin);
      }
      state.loaded = true;
      renderList();
    } catch (err) {
      MP.toast(`读取插件失败：${err.message}`, 'err');
      renderList();
    }
  }

  async function loadPlugin(plugin) {
    let source;
    try {
      source = await MP.api.invoke('plugins:source', plugin.id);
    } catch (err) {
      state.errors.set(plugin.id, err.message);
      return;
    }
    if (!source || !source.ok) {
      state.errors.set(plugin.id, (source && source.error) || '读取插件入口失败');
      return;
    }
    let worker;
    let url;
    try {
      const code = workerBootstrap(source.manifest || plugin, source.source);
      const blob = new Blob([code], { type: 'text/javascript' });
      url = URL.createObjectURL(blob);
      worker = new Worker(url);
    } catch (err) {
      state.errors.set(plugin.id, `插件启动失败：${err.message}`);
      if (url) URL.revokeObjectURL(url);
      return;
    }
    const pluginId = plugin.id;
    const pluginName = plugin.name || plugin.id;
    worker.onmessage = async (event) => {
      const data = event.data || {};
      if (data.type === 'ready') {
        mergeCommands(pluginId, pluginName, data.commands || []);
        state.errors.delete(pluginId);
        renderList();
        return;
      }
      if (data.type === 'commands') {
        mergeCommands(pluginId, pluginName, data.commands || []);
        renderList();
        return;
      }
      if (data.type === 'toast') {
        MP.toast(`${pluginName}：${data.text || ''}`, data.tone || 'ok', 4200);
        return;
      }
      if (data.type === 'load-error') {
        state.errors.set(pluginId, data.error || '插件加载失败');
        renderList();
        return;
      }
      if (data.type === 'command-result') {
        if (!data.ok) MP.toast(`${pluginName}：${data.error || '命令执行失败'}`, 'err', 5000);
        else if (data.result) MP.toast(`${pluginName}：${data.result}`, 'ok', 4200);
        return;
      }
      if (data.type === 'invoke') {
        const channel = String(data.channel || '');
        if (!ALLOWED_INVOKE.has(channel)) {
          worker.postMessage({ type: 'invoke-result', requestId: data.requestId, ok: false, error: '插件无权调用该接口' });
          return;
        }
        try {
          let result = await MP.api.invoke(channel, ...(Array.isArray(data.args) ? data.args : []));
          if (channel === 'settings:get') result = sanitizeSettings(result);
          worker.postMessage({ type: 'invoke-result', requestId: data.requestId, ok: true, result });
        } catch (err) {
          worker.postMessage({ type: 'invoke-result', requestId: data.requestId, ok: false, error: err.message });
        }
      }
    };
    worker.onerror = (event) => {
      state.errors.set(pluginId, `插件运行出错：${event.message || '未知错误'}`);
      renderList();
    };
    state.workers.set(pluginId, worker);
    state.workerUrls.set(pluginId, url);
  }

  function mergeCommands(pluginId, pluginName, commands) {
    state.commands = state.commands.filter((item) => item.pluginId !== pluginId);
    for (const command of commands) {
      state.commands.push({
        pluginId,
        pluginName,
        id: command.id,
        title: command.title || command.id,
      });
    }
  }

  function runCommand(pluginId, commandId) {
    const worker = state.workers.get(pluginId);
    if (!worker) {
      MP.toast('插件没有运行，请重新启用插件', 'err');
      return;
    }
    worker.postMessage({ type: 'run-command', id: commandId });
  }

  function isWeb() {
    return Boolean(MP.state.info && MP.state.info.mode === 'web');
  }

  async function installFromFile(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name || '')) {
      MP.toast('请选择 .zip 格式的插件包', 'err');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      MP.toast('插件包不能超过 25 MB', 'err');
      return;
    }
    state.installing = true;
    try {
      const data = await readFileBase64(file);
      const result = await MP.api.invoke('plugins:install-base64', { data, overwrite: false });
      await handleInstallResult(result, { data, overwrite: true });
    } catch (err) {
      MP.toast(`安装插件失败：${err.message}`, 'err', 6000);
    } finally {
      state.installing = false;
      const input = $('#plugin-file-input');
      if (input) input.value = '';
    }
  }

  function readFileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.includes(',') ? result.split(',')[1] : result);
      };
      reader.onerror = () => reject(new Error('读取插件文件失败'));
      reader.readAsDataURL(file);
    });
  }

  async function installFromDialog() {
    if (isWeb()) {
      const input = $('#plugin-file-input');
      if (input) input.click();
      return;
    }
    try {
      const result = await MP.api.invoke('plugins:install', { overwrite: false });
      await handleInstallResult(result, null);
    } catch (err) {
      MP.toast(`安装插件失败：${err.message}`, 'err', 6000);
    }
  }

  async function handleInstallResult(result, retry) {
    if (!result || !result.ok) {
      if (result && result.canceled) return;
      if (result && result.code === 'PLUGIN_EXISTS' && retry) {
        const plugin = result.plugin || {};
        const ok = await MP.confirm({
          title: '插件已经安装',
          text: `是否用新文件覆盖「${plugin.name || plugin.id}」？覆盖后请重新加载插件。`,
          confirmLabel: '覆盖安装',
          danger: true,
        });
        if (ok) {
          const next = retry.filePath
            ? await MP.api.invoke('plugins:install', { filePath: retry.filePath, overwrite: true })
            : await MP.api.invoke('plugins:install-base64', { data: retry.data, overwrite: true });
          return handleInstallResult(next, null);
        }
        return;
      }
      MP.toast((result && result.error) || '安装插件失败', 'err', 6000);
      return;
    }
    MP.toast(`插件「${(result.plugin && result.plugin.name) || ''}」已安装`, 'ok');
    await loadAll();
  }

  function bind() {
    MP.on('#btn-plugin-install', 'click', installFromDialog);
    MP.on('#btn-plugin-open-folder', 'click', async () => {
      const result = await MP.api.invoke('plugins:open-folder');
      if (result && result.ok === false) MP.toast(result.error || '无法打开插件目录', 'err');
    });
    MP.on('#plugin-file-input', 'change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) installFromFile(file);
    });
    MP.on('#plugin-list', 'click', async (event) => {
      const remove = event.target.closest('[data-plugin-remove]');
      if (remove) {
        const id = remove.dataset.pluginRemove;
        const plugin = state.plugins.find((item) => item.id === id);
        const ok = await MP.confirm({
          title: '移除插件',
          text: `确定移除「${(plugin && plugin.name) || id}」吗？插件文件夹会被删除。`,
          confirmLabel: '移除',
          danger: true,
        });
        if (!ok) return;
        const result = await MP.api.invoke('plugins:remove', id);
        if (!result || !result.ok) MP.toast((result && result.error) || '移除失败', 'err');
        else MP.toast('插件已移除', 'ok');
        await loadAll();
        return;
      }
    });
    MP.on('#plugin-list', 'change', async (event) => {
      const toggle = event.target.closest('[data-plugin-toggle]');
      if (!toggle) return;
      const id = toggle.dataset.pluginToggle;
      const result = await MP.api.invoke('plugins:set-enabled', id, toggle.checked);
      if (!result || !result.ok) {
        toggle.checked = !toggle.checked;
        MP.toast((result && result.error) || '切换插件状态失败', 'err');
        return;
      }
      await loadAll();
    });
    MP.on('#plugin-commands', 'click', (event) => {
      const button = event.target.closest('[data-plugin-command]');
      if (!button) return;
      const [pluginId, ...rest] = button.dataset.pluginCommand.split(':');
      runCommand(pluginId, rest.join(':'));
    });
    ALLOWED_EVENTS.forEach((name) => {
      MP.api.on(name, (payload) => broadcastEvent(name, payload));
    });
  }

  MP.plugins = {
    init() {
      bind();
      setTimeout(loadAll, 150);
    },
    loadAll,
    render: renderList,
    rerender: renderList,
  };
})();