'use strict';

(function () {
  const MP = (window.MP = window.MP || {});

  MP.state = {
    settings: null,
    info: null,
    versions: [],
    versionsError: '',
    selectedVersion: '',
    view: 'home',
    javaList: [],
    javaError: '',
    manifest: null,
    manifestFilter: 'release',
    manifestQuery: '',
    installing: false,
    launching: false,
    currentLaunch: null,
  };

  MP.views = {};
  MP.api = window.mp;

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  MP.$ = $;
  MP.$$ = $$;

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  MP.esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

  MP.on = (selector, event, handler, root) => {
    const node = $(selector, root);
    if (node) node.addEventListener(event, handler);
  };

  MP.debounce = function (fn, wait) {
    let timer = null;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  };

  MP.pad = (n) => String(n).padStart(2, '0');

  MP.fmtBytes = function (bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value;
    let index = -1;
    do {
      size /= 1024;
      index += 1;
    } while (size >= 1024 && index < units.length - 1);
    return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
  };

  MP.fmtDate = function (iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return `${date.getFullYear()}-${MP.pad(date.getMonth() + 1)}-${MP.pad(date.getDate())}`;
  };

  MP.fmtRelative = function (timestamp) {
    if (!timestamp) return '从未';
    const diff = Date.now() - Number(timestamp);
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
    const date = new Date(Number(timestamp));
    return `${date.getFullYear()}-${MP.pad(date.getMonth() + 1)}-${MP.pad(date.getDate())}`;
  };

  MP.greeting = function () {
    const hour = new Date().getHours();
    if (hour < 5) return '夜深了';
    if (hour < 9) return '早上好';
    if (hour < 12) return '上午好';
    if (hour < 14) return '中午好';
    if (hour < 18) return '下午好';
    return '晚上好';
  };

  function invokeWithTimeout(channel, ...args) {
    return Promise.race([
      MP.api.invoke(channel, ...args),
      new Promise((_, reject) => setTimeout(() => reject(new Error('系统响应超时（8 秒）')), 8000)),
    ]);
  }

  MP.toast = function (text, type, duration) {
    const root = $('#toasts');
    if (!root) return;
    const node = document.createElement('div');
    node.className = `toast ${type || ''}`;
    node.textContent = MP.t ? MP.t(text) : text;
    root.appendChild(node);
    while (root.children.length > 4) root.removeChild(root.firstElementChild);
    setTimeout(() => {
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 260);
    }, duration || 3400);
  };

  MP.openExternal = async function (url) {
    try {
      const result = await invokeWithTimeout('shell:open-external', url);
      if (result && result.ok === false) throw new Error(result.error || '系统没有响应');
      return result || { ok: true };
    } catch (err) {
      const detail = err && err.message ? err.message : String(err || '未知错误');
      MP.toast(`无法打开链接：${detail}\n${url}`, 'err', 7000);
      return { ok: false, error: detail };
    }
  };

  MP.openPath = async function (target, label) {
    if (!target) {
      MP.toast(`无法打开${label || '目录'}：路径为空`, 'err', 5000);
      return { ok: false, error: '路径为空' };
    }
    try {
      const result = await invokeWithTimeout('shell:open-path', target);
      if (result && result.ok === false) throw new Error(result.error || '系统没有响应');
      return result || { ok: true };
    } catch (err) {
      const detail = err && err.message ? err.message : String(err || '未知错误');
      MP.toast(`无法打开${label || '目录'}：${detail}\n${target}`, 'err', 7000);
      return { ok: false, error: detail };
    }
  };

  MP.openLogs = async function () {
    try {
      const result = await invokeWithTimeout('logs:open-folder');
      if (result && result.ok === false) throw new Error(result.error || '系统没有响应');
      return result || { ok: true };
    } catch (err) {
      const detail = err && err.message ? err.message : String(err || '未知错误');
      MP.toast(`无法打开日志目录：${detail}`, 'err', 7000);
      return { ok: false, error: detail };
    }
  };

  /* ---------------- 头像 ---------------- */
  const SKINS = [
    ['#f2c9a0', '#d9a066'],
    ['#e8b98d', '#cf9463'],
    ['#c98d5f', '#a96f45'],
    ['#9a6540', '#7d4f31'],
    ['#f6d3b2', '#e0b189'],
  ];
  const HAIRS = ['#2a1c15', '#3f2a1c', '#15171d', '#5a3b22', '#7b4b26', '#242b38'];

  function hashString(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  MP.avatarHTML = function (name) {
    const hash = hashString(name || 'Steve');
    const skin = SKINS[hash % SKINS.length];
    const hair = HAIRS[(hash >>> 3) % HAIRS.length];
    const shirt = ['#3b82f6', '#22a06b', '#7c5cf0', '#d97706'][(hash >>> 6) % 4];
    const cells = [];
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        let color = skin[0];
        if (y < 2) color = hair;
        else if (y === 2 && (x < 2 || x > 5)) color = hair;
        else if ((y === 3 || y === 4) && (x === 0 || x === 7)) color = hair;
        else if (y === 5 && (x === 0 || x === 7)) color = skin[1];
        if (y === 4 && (x === 2 || x === 5)) color = '#1d2735';
        if (y === 4 && (x === 1 || x === 6)) color = skin[1];
        if (y === 6 && (x === 3 || x === 4)) color = '#8a5a3b';
        if (y === 7) color = shirt;
        cells.push(`<span style="background:${color}"></span>`);
      }
    }
    return cells.join('');
  };

  MP.setAvatar = function (element, name) {
    if (!element) return;
    if (MP.state.localSkinHead) {
      element.classList.add('local-head');
      element.innerHTML = '';
      element.style.backgroundImage = `url("${MP.state.localSkinHead}")`;
      element.setAttribute('aria-label', `${name || ''} 的本地皮肤头像`);
      return;
    }
    element.classList.remove('local-head');
    element.style.removeProperty('background-image');
    element.innerHTML = MP.avatarHTML(name);
  };

  /* ---------------- 模态框 ---------------- */
  MP.modal = function (options) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      const box = document.createElement('div');
      box.className = 'modal';
      if (options.width) box.style.width = `${options.width}px`;
      box.innerHTML = `<h3>${MP.esc(options.title || '')}</h3>`
        + (options.body ? `<div class="modal-body">${options.body}</div>` : '')
        + '<div class="modal-actions"></div>';

      const actionsEl = box.querySelector('.modal-actions');
      const close = (value) => {
        if (!mask.isConnected) return;
        mask.remove();
        document.removeEventListener('keydown', onKey);
        if (typeof options.onClose === 'function') {
          try { options.onClose(value); } catch (err) { /* ignore */ }
        }
        resolve(value);
      };
      const onKey = (event) => {
        if (event.key === 'Escape' && options.dismissible !== false) close(null);
      };
      document.addEventListener('keydown', onKey);

      const actions = options.actions || [{ label: '知道了', kind: 'primary', value: true }];
      for (const action of actions) {
        const button = document.createElement('button');
        button.className = `btn ${action.kind || 'ghost'}${action.small ? ' small' : ''}`;
        button.textContent = action.label;
        button.addEventListener('click', async () => {
          if (!action.onClick) {
            close(action.value !== undefined ? action.value : true);
            return;
          }
          let result;
          try {
            result = await action.onClick(box, close);
          } catch (err) {
            MP.toast(err.message || '操作失败', 'err');
            return;
          }
          if (result === false) return;
          if (result === undefined) close(action.value !== undefined ? action.value : true);
          else close(result);
        });
        actionsEl.appendChild(button);
      }

      mask.addEventListener('mousedown', (event) => {
        if (event.target === mask && options.dismissible !== false) close(null);
      });

      mask.appendChild(box);
      $('#modal-root').appendChild(mask);
      if (options.onMount) options.onMount(box, close);
      const focusTarget = box.querySelector('input, button');
      if (focusTarget) setTimeout(() => focusTarget.focus(), 40);
    });
  };

  MP.confirm = async function (options) {
    const result = await MP.modal({
      title: options.title || '请确认',
      body: `<p>${MP.esc(options.text || '')}</p>`,
      actions: [
        { label: options.cancelLabel || '取消', value: false },
        { label: options.confirmLabel || '确定', kind: options.danger ? 'danger' : 'primary', value: true },
      ],
    });
    return result === true;
  };

  MP.prompt = function (options) {
    return new Promise((resolve) => {
      const body = `<p class="muted-sm">${MP.esc(options.label || '')}</p>`
        + `<input class="input modal-input" id="mp-prompt-input" maxlength="${options.maxlength || 64}" `
        + `placeholder="${MP.esc(options.placeholder || '')}" value="${MP.esc(options.value || '')}">`
        + '<p class="muted-sm" id="mp-prompt-error" style="color:#ff9d9d;display:none;margin-top:7px"></p>';
      MP.modal({
        title: options.title || '输入',
        body,
        actions: [
          { label: '取消', value: null },
          {
            label: options.confirmLabel || '确定',
            kind: 'primary',
            onClick: (box) => {
              const input = box.querySelector('#mp-prompt-input');
              const error = box.querySelector('#mp-prompt-error');
              const value = input.value.trim();
              const message = options.validate ? options.validate(value) : '';
              if (message) {
                error.textContent = message;
                error.style.display = 'block';
                input.focus();
                return false;
              }
              return value;
            },
          },
        ],
        onMount: (box) => {
          const input = box.querySelector('#mp-prompt-input');
          input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              box.querySelector('.modal-actions .btn.primary').click();
            }
          });
        },
      }).then(resolve);
    });
  };

  MP.progressModal = function (options) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal" style="width:420px">
      <h3>${MP.esc(options.title || '请稍候')}</h3>
      <p class="muted-sm" id="mp-pm-text">${MP.esc(options.text || '准备中…')}</p>
      <div class="progress" style="margin-top:14px"><div class="progress-fill" id="mp-pm-fill"></div></div>
      <div class="install-meta"><span id="mp-pm-percent">0%</span></div>
    </div>`;
    $('#modal-root').appendChild(mask);
    const fill = mask.querySelector('#mp-pm-fill');
    const text = mask.querySelector('#mp-pm-text');
    const percent = mask.querySelector('#mp-pm-percent');
    return {
      update(value, message) {
        const clamped = Math.max(0, Math.min(100, Number(value) || 0));
        if (fill) fill.style.width = `${clamped}%`;
        if (percent) percent.textContent = `${clamped.toFixed(0)}%`;
        if (text && message) text.textContent = message;
      },
      close() {
        mask.remove();
      },
    };
  };

  /* ---------------- 版本与导航 ---------------- */
  MP.go = function (name) {
    const target = document.getElementById(`view-${name}`);
    if (!target || MP.state.view === name) return;
    const previous = MP.views[MP.state.view];
    if (previous && previous.onLeave) {
      try { previous.onLeave(); } catch (err) { /* ignore */ }
    }
    MP.state.view = name;
    $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
    $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
    const main = $('#main');
    if (main) main.scrollTop = 0;
    const module = MP.views[name];
    if (module && module.onShow) setTimeout(() => module.onShow(), 20);
  };

  MP.selectVersion = function (id) {
    MP.state.selectedVersion = id;
    if (MP.views.home) MP.views.home.refresh();
    MP.api.invoke('settings:update', { lastVersion: id });
  };

  MP.refreshVersions = async function () {
    const result = await MP.api.invoke('versions:list');
    MP.state.versions = result.ok ? result.versions : [];
    MP.state.versionsError = result.ok ? '' : result.error;

    const ids = new Set(MP.state.versions.map((version) => version.id));
    let selected = MP.state.selectedVersion;
    if (!selected || !ids.has(selected)) {
      const preferred = MP.state.settings && MP.state.settings.lastVersion;
      selected = preferred && ids.has(preferred)
        ? preferred
        : (MP.state.versions[0] ? MP.state.versions[0].id : '');
    }
    MP.state.selectedVersion = selected;

    if (MP.views.home) MP.views.home.refresh();
    if (MP.views.versions) MP.views.versions.render();
    if (MP.views.mods && MP.views.mods.onVersionsChanged) MP.views.mods.onVersionsChanged();
    return result;
  };

  MP.refreshJava = async function () {
    const result = await MP.api.invoke('java:detect');
    MP.state.javaList = result.ok ? result.list : [];
    MP.state.javaError = result.ok ? '' : result.error;
    if (MP.views.home) MP.views.home.refresh();
    if (MP.views.settings) MP.views.settings.renderJava();
    return MP.state.javaList;
  };

  MP.bestJava = function (major) {
    const required = Number(major) || 0;
    const configured = MP.state.settings && MP.state.settings.javaPath;
    if (configured) {
      const hit = MP.state.javaList.find((item) => item.path === configured && item.major >= required);
      if (hit) return hit;
    }
    const compatible = MP.state.javaList
      .filter((item) => item.major >= required)
      .sort((a, b) => a.major - b.major);
    return compatible[0] || null;
  };

  MP.installJavaFlow = async function (major) {
    const modal = MP.progressModal({ title: `正在安装 Java ${major}`, text: '正在获取 Adoptium 下载信息…' });
    const off = MP.api.on('java:progress', (progress) => {
      modal.update(progress.percent || 0, progress.phase || '');
    });
    try {
      const result = await MP.api.invoke('java:install', major);
      off();
      modal.close();
      if (!result.ok) {
        MP.toast(`Java 安装失败：${result.error}`, 'err', 6000);
        return false;
      }
      MP.toast(`Java ${major} 安装完成`, 'ok');
      await MP.refreshJava();
      return true;
    } catch (err) {
      off();
      modal.close();
      MP.toast(`Java 安装失败：${err.message}`, 'err', 6000);
      return false;
    }
  };

  MP.ensureJava = async function (required, foundMajor) {
    const lines = foundMajor
      ? `<p>当前检测到的最高版本为 <b>Java ${foundMajor}</b>，但这个游戏需要 <b>Java ${required}</b>。</p>`
      : `<p>没有检测到可用的 Java 运行环境，这个游戏需要 <b>Java ${required}</b>。</p>`;
    const choice = await MP.modal({
      title: `需要 Java ${required}`,
      body: `${lines}<p class="muted-sm">MinePilot 可以从 Eclipse Adoptium 自动下载并安装 Temurin JRE。下载大小约 40–50 MB。</p>`,
      actions: [
        { label: '取消', value: false },
        { label: `自动安装 Java ${required}`, kind: 'primary', value: true },
      ],
    });
    if (choice !== true) return false;
    return MP.installJavaFlow(required);
  };
})();