'use strict';

(function () {
  const { $, esc } = MP;

  const state = {
    profiles: [],
    processes: [],
    addresses: [],
    guides: [],
    logs: new Map(),
    currentId: '',
    desktopOnly: false,
    loaded: false,
  };

  function profileById(id) {
    return state.profiles.find((item) => item.id === id) || null;
  }

  function currentProcess() {
    return state.processes.find((item) => item.id === state.currentId) || null;
  }

  function targetVersion() {
    const select = $('#netplay-target');
    const id = select ? select.value : MP.state.selectedVersion;
    return (MP.state.versions || []).find((version) => version.id === id) || null;
  }

  function populateTargets() {
    const select = $('#netplay-target');
    if (!select) return;
    const versions = MP.state.versions || [];
    const previous = select.value || MP.state.selectedVersion || '';
    if (!versions.length) {
      select.innerHTML = '<option value="">没有已安装版本</option>';
      select.disabled = true;
      return;
    }
    select.disabled = false;
    select.innerHTML = versions.map((version) => `<option value="${esc(version.id)}">${esc(version.id)}${version.mcVersion ? ` · ${esc(version.mcVersion)}` : ''}</option>`).join('');
    select.value = versions.some((item) => item.id === previous) ? previous : versions[0].id;
  }

  function renderProfiles() {
    const select = $('#netplay-profile-select');
    if (!select) return;
    const previous = state.currentId || select.value;
    if (!state.profiles.length) {
      select.innerHTML = '<option value="">还没有配置，先在右侧添加</option>';
      select.disabled = true;
      state.currentId = '';
      fillForm(null);
      renderProcess();
      return;
    }
    select.disabled = false;
    select.innerHTML = state.profiles.map((profile) => `<option value="${esc(profile.id)}">${esc(profile.name || profile.id)} · ${esc(profile.tool || 'custom')}</option>`).join('');
    const next = state.profiles.some((item) => item.id === previous) ? previous : state.profiles[0].id;
    state.currentId = next;
    select.value = next;
    fillForm(profileById(next));
    renderProcess();
  }

  function fillForm(profile) {
    $('#np-name').value = profile ? profile.name || '' : '';
    $('#np-tool').value = profile ? profile.tool || 'custom' : 'terracotta';
    $('#np-exe').value = profile ? profile.executable || '' : '';
    $('#np-args').value = profile && Array.isArray(profile.args) ? profile.args.join('\n') : '';
    $('#np-cwd').value = profile ? profile.cwd || '' : '';
    $('#np-autocopy').checked = profile ? profile.autoCopy !== false : true;
    const hint = $('#netplay-form-hint');
    if (hint) hint.textContent = profile ? `配置 id：${profile.id}` : '新建配置后保存；支持 {gameDir}、{player}、{address} 占位符。';
  }

  function formatTime(value) {
    if (!value) return '';
    try { return new Date(value).toLocaleTimeString(); } catch (err) { return ''; }
  }

  function renderProcess() {
    const badge = $('#netplay-state-badge');
    const text = $('#netplay-status-text');
    const head = $('#netplay-head-status');
    const process = currentProcess();
    const running = Boolean(process && process.running);
    if (badge) {
      badge.textContent = running ? '运行中' : (process && process.exitCode != null ? '已退出' : '未运行');
      badge.className = `badge ${running ? 'success' : 'gray'}`;
    }
    if (text) {
      if (!state.currentId) text.textContent = '先保存一个联机配置。';
      else if (running) text.textContent = `PID ${process.pid || '—'} · 启动于 ${formatTime(process.startedAt)}`;
      else if (process && process.error) text.textContent = process.error;
      else if (process && process.exitCode != null) text.textContent = `进程已退出，退出码 ${process.exitCode}`;
      else text.textContent = '选择配置后启动；不会自动启动 Minecraft。';
    }
    if (head) head.textContent = running ? '联机工具运行中' : (process ? '联机工具已退出' : '尚未启动');
    const start = $('#btn-netplay-start');
    const stop = $('#btn-netplay-stop');
    if (start) start.disabled = !state.currentId || state.desktopOnly;
    if (stop) stop.disabled = !running;
    renderAddresses();
    renderLogs();
  }

  function renderAddresses() {
    const root = $('#netplay-addresses');
    if (!root) return;
    if (!state.addresses.length) {
      root.innerHTML = '<span class="muted-sm">没有检测到可用的局域网 IPv4 地址。仍可通过联机工具分配虚拟地址。</span>';
      return;
    }
    root.innerHTML = state.addresses.map((item) => `<button class="netplay-address" data-netplay-address="${esc(item.text)}" title="复制 ${esc(item.name)}">
      <strong>${esc(item.text)}</strong><span>${esc(item.name)}</span>
    </button>`).join('');
  }

  function renderLogs() {
    const root = $('#netplay-log');
    if (!root) return;
    const lines = state.logs.get(state.currentId) || [];
    root.textContent = lines.length ? lines.slice(-120).join('\n') : '启动后这里显示联机工具输出（最多保留 160 行）。';
    root.scrollTop = root.scrollHeight;
  }

  function applyState(payload) {
    if (!payload) return;
    state.processes = Array.isArray(payload.processes) ? payload.processes : state.processes;
    state.addresses = Array.isArray(payload.addresses) ? payload.addresses : state.addresses;
    for (const process of state.processes) {
      if (Array.isArray(process.logs) && process.logs.length) {
        state.logs.set(process.id, process.logs.slice(-160));
      }
    }
    renderProcess();
  }

  async function loadState() {
    let result;
    try {
      result = await MP.api.invoke('netplay:state');
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (!result || !result.ok) {
      MP.toast(`读取联机状态失败：${(result && result.error) || '未知错误'}`, 'err', 6000);
      return;
    }
    state.profiles = Array.isArray(result.profiles) ? result.profiles : [];
    state.guides = Array.isArray(result.guides) ? result.guides : [];
    state.desktopOnly = Boolean(result.desktopOnly);
    state.addresses = Array.isArray(result.addresses) ? result.addresses : [];
    state.processes = Array.isArray(result.processes) ? result.processes : [];
    const warning = $('#netplay-warning');
    if (warning && state.desktopOnly) {
      warning.innerHTML = MP.i18n && MP.i18n.language === 'en-US'
        ? '<strong>Browser version only provides guidance</strong><span>Browsers cannot start local programs. Use the desktop app or follow the official instructions below.</span>'
        : '<strong>浏览器版仅提供引导</strong><span>浏览器不能启动本机程序。请使用桌面版，或按下方官方说明手动运行联机工具。</span>';
    }
    renderGuides();
    renderProfiles();
    state.loaded = true;
  }

  function renderGuides() {
    const root = $('#netplay-guides');
    if (!root) return;
    root.innerHTML = state.guides.map((guide) => `<div class="netplay-guide">
      <div>
        <strong>${esc(guide.name)}</strong>
        <p>${esc(guide.summary)}</p>
        <p class="muted-sm">${esc(guide.setup)}</p>
      </div>
      <a class="btn small ghost" href="${esc(guide.url)}" target="_blank" rel="noopener noreferrer">官方页面</a>
    </div>`).join('');
  }

  async function saveProfile() {
    const name = $('#np-name').value.trim();
    const executable = $('#np-exe').value.trim();
    if (!executable) {
      MP.toast('请填写联机工具的可执行文件路径', 'err');
      return;
    }
    const existing = profileById(state.currentId);
    const profile = {
      id: existing ? existing.id : `net-${Date.now()}`,
      name: name || (existing ? existing.name : '我的联机配置'),
      tool: $('#np-tool').value || 'custom',
      executable,
      args: $('#np-args').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      cwd: $('#np-cwd').value.trim(),
      autoCopy: $('#np-autocopy').checked,
    };
    const next = existing
      ? state.profiles.map((item) => (item.id === existing.id ? profile : item))
      : state.profiles.concat(profile);
    const saved = await MP.api.invoke('settings:update', { netplayProfiles: next });
    MP.state.settings = saved;
    state.profiles = Array.isArray(saved.netplayProfiles) ? saved.netplayProfiles : next;
    state.currentId = profile.id;
    renderProfiles();
    MP.toast('联机配置已保存', 'ok');
  }

  async function removeProfile() {
    const profile = profileById(state.currentId);
    if (!profile) {
      MP.toast('没有可删除的配置', 'warn');
      return;
    }
    const ok = await MP.confirm({
      title: '删除联机配置',
      text: `确定删除「${profile.name || profile.id}」吗？正在运行的工具会先停止。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    await MP.api.invoke('netplay:stop', profile.id);
    const next = state.profiles.filter((item) => item.id !== profile.id);
    const saved = await MP.api.invoke('settings:update', { netplayProfiles: next });
    MP.state.settings = saved;
    state.profiles = Array.isArray(saved.netplayProfiles) ? saved.netplayProfiles : next;
    state.processes = state.processes.filter((item) => item.id !== profile.id);
    state.logs.delete(profile.id);
    state.currentId = '';
    renderProfiles();
    MP.toast('配置已删除', 'ok');
  }

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      MP.toast('地址已复制', 'ok');
    } catch (err) {
      MP.toast(`复制失败，请手动选择：${text}`, 'err', 7000);
    }
  }

  async function start() {
    const target = targetVersion();
    if (!target) {
      MP.toast('请先选择游戏实例', 'err');
      return;
    }
    if (!state.currentId) {
      MP.toast('请先保存联机配置', 'err');
      return;
    }
    const profile = profileById(state.currentId);
    const ok = await MP.modal({
      title: '启动本机联机工具？',
      body: `<p>MinePilot 将运行你配置的程序：</p><p class="content-path"><code>${esc((profile && profile.executable) || '')}</code></p>
        <p class="muted-sm">这不会自动启动 Minecraft，也不会创建或托管房间。请确认程序来源可信，并自行承担第三方服务的费用和条款。</p>`,
      actions: [{ label: '取消', value: false }, { label: '启动', kind: 'primary', value: true }],
    });
    if (ok !== true) return;
    let result;
    try {
      result = await MP.api.invoke('netplay:start', { id: state.currentId, targetVersionId: target.id });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (!result || !result.ok) {
      MP.toast((result && result.error) || '启动失败', 'err', 7000);
      return;
    }
    state.addresses = Array.isArray(result.addresses) ? result.addresses : state.addresses;
    await loadState();
    MP.toast('联机工具已启动', 'ok');
    if (profile && profile.autoCopy !== false && state.addresses.length) {
      copyText(state.addresses[0].text);
    }
  }

  async function stop() {
    if (!state.currentId) return;
    await MP.api.invoke('netplay:stop', state.currentId);
    state.processes = state.processes.map((item) => (item.id === state.currentId ? Object.assign({}, item, { running: false }) : item));
    renderProcess();
    MP.toast('已请求停止联机工具', 'ok');
  }

  function bind() {
    MP.on('#netplay-profile-select', 'change', (event) => {
      state.currentId = event.target.value;
      fillForm(profileById(state.currentId));
      renderProcess();
    });
    MP.on('#btn-netplay-start', 'click', start);
    MP.on('#btn-netplay-stop', 'click', stop);
    MP.on('#btn-netplay-copy', 'click', () => {
      const item = state.addresses[0];
      if (item) copyText(item.text);
      else MP.toast('还没有检测到本机地址', 'warn');
    });
    MP.on('#btn-netplay-save', 'click', saveProfile);
    MP.on('#btn-netplay-browse', 'click', async () => {
      let result;
      try {
        result = await MP.api.invoke('netplay:browse');
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      if (result && result.ok && result.filePath) {
        $('#np-exe').value = result.filePath;
        if (!$('#np-name').value.trim()) {
          $('#np-name').value = String(result.filePath).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
        }
      } else if (result && !result.canceled && result.error) {
        MP.toast(result.error, 'warn');
      }
    });
    MP.on('#btn-netplay-remove', 'click', removeProfile);
    MP.on('#btn-netplay-new', 'click', () => {
      state.currentId = '';
      fillForm(null);
      $('#np-name').focus();
    });
    MP.on('#netplay-addresses', 'click', (event) => {
      const button = event.target.closest('[data-netplay-address]');
      if (button) copyText(button.dataset.netplayAddress);
    });
    MP.api.on('netplay:log', (payload) => {
      if (!payload || !payload.id) return;
      const list = state.logs.get(payload.id) || [];
      list.push(String(payload.line || '').slice(0, 4000));
      if (list.length > 160) list.splice(0, list.length - 160);
      state.logs.set(payload.id, list);
      if (payload.id === state.currentId) renderLogs();
    });
    MP.api.on('netplay:state', (payload) => {
      if (!payload || !payload.id) return;
      state.processes = state.processes.filter((item) => item.id !== payload.id);
      state.processes.push(Object.assign({ id: payload.id }, payload));
      renderProcess();
    });
  }

  MP.views = MP.views || {};
  MP.views.netplay = {
    init() {
      bind();
    },
    onShow() {
      populateTargets();
      if (!state.loaded) loadState();
      else {
        populateTargets();
        renderProfiles();
      }
    },
    render() {
      populateTargets();
      loadState();
    },
  };
})();