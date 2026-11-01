'use strict';

(function () {
  const { $, esc } = MP;

  const TYPE_META = {
    resourcepack: {
      label: '资源包',
      title: '已安装资源包',
      sub: '启用状态写入 options.txt；停用会重命名为 .disabled，文件仍保留。',
      placeholder: '搜索资源包，例如 Faithful、Stay True',
      modrinth: 'resourcepack',
    },
    shaderpack: {
      label: '光影',
      title: '已安装光影',
      sub: '通过 config/iris.properties 启用；没有 Iris 时仍可管理文件。',
      placeholder: '搜索光影，例如 Complementary、BSL',
      modrinth: 'shader',
    },
    datapack: {
      label: '数据包',
      title: '已安装数据包',
      sub: '放在 datapacks 表示启用，移到 datapacks-disabled 表示停用；世界数据包也会列出。',
      placeholder: '搜索数据包，例如 Terralith、Incendium',
      modrinth: 'datapack',
    },
  };

  const state = {
    type: 'resourcepack',
    items: [],
    worlds: [],
    world: '',
    targetId: '',
    seq: 0,
    searchSeq: 0,
    searchHits: [],
    installing: false,
  };

  function targetVersion() {
    const select = $('#content-target');
    const id = select ? select.value : MP.state.selectedVersion;
    return (MP.state.versions || []).find((version) => version.id === id) || null;
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function populateTargets() {
    const select = $('#content-target');
    if (!select) return;
    const versions = MP.state.versions || [];
    const previous = select.value || MP.state.selectedVersion || '';
    if (!versions.length) {
      select.innerHTML = '<option value="">没有已安装版本</option>';
      select.disabled = true;
      state.targetId = '';
      renderChip();
      return;
    }
    select.disabled = false;
    select.innerHTML = versions.map((version) => `<option value="${esc(version.id)}">${esc(version.id)}${version.mcVersion ? ` · ${esc(version.mcVersion)}` : ''}</option>`).join('');
    const next = versions.some((version) => version.id === previous)
      ? previous
      : (versions.some((version) => version.id === MP.state.selectedVersion) ? MP.state.selectedVersion : versions[0].id);
    select.value = next;
    state.targetId = next;
    renderChip();
  }

  function renderChip() {
    const target = targetVersion();
    const chip = $('#content-instance-chip');
    if (chip) chip.textContent = target ? `${target.id} · ${TYPE_META[state.type].label}` : '选择实例';
  }

  function setType(type) {
    if (!TYPE_META[type]) return;
    state.type = type;
    document.querySelectorAll('#content-tabs [data-content-type]').forEach((button) => {
      button.classList.toggle('active', button.dataset.contentType === type);
    });
    const meta = TYPE_META[type];
    const title = $('#content-list-title');
    if (title) title.textContent = meta.title;
    const sub = $('#content-list-sub');
    if (sub) sub.textContent = meta.sub;
    const search = $('#content-search');
    if (search) search.placeholder = meta.placeholder;
    $('#content-world-wrap')?.classList.toggle('hidden', type !== 'datapack');
    state.searchHits = [];
    renderSearch();
    renderChip();
    load();
  }

  async function load() {
    populateTargets();
    const target = targetVersion();
    const seq = ++state.seq;
    if (!target) {
      state.items = [];
      renderList();
      return;
    }
    const list = $('#content-list');
    if (list && !state.items.length) list.innerHTML = '<div class="content-loading">正在扫描…</div>';
    let result;
    try {
      result = await MP.api.invoke('content:list', {
        targetVersionId: target.id,
        type: state.type,
        world: state.world || undefined,
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (seq !== state.seq) return;
    if (!result || !result.ok) {
      state.items = [];
      renderList(result && result.error);
      MP.toast(`读取内容失败：${(result && result.error) || '未知错误'}`, 'err', 6000);
      return;
    }
    state.items = Array.isArray(result.items) ? result.items : [];
    state.worlds = Array.isArray(result.worlds) ? result.worlds : [];
    renderWorlds();
    renderList();
  }

  function renderWorlds() {
    const select = $('#content-world');
    if (!select) return;
    const previous = state.world;
    select.innerHTML = '<option value="">全部世界</option>'
      + state.worlds.map((world) => `<option value="${esc(world)}">${esc(world)}</option>`).join('');
    if (state.worlds.includes(previous)) select.value = previous;
    else state.world = '';
  }

  function visibleItems() {
    if (state.type !== 'datapack' || !state.world) return state.items;
    return state.items.filter((item) => item.scope === 'instance' || item.world === state.world);
  }

  function renderList(error) {
    const list = $('#content-list');
    const empty = $('#content-empty');
    if (!list) return;
    const items = visibleItems();
    const count = $('#content-count');
    if (count) count.textContent = `${items.length} 个`;
    if (empty) {
      empty.classList.toggle('hidden', items.length > 0 || Boolean(error));
      const strong = empty.querySelector('strong');
      const span = empty.querySelector('span');
      if (strong) strong.textContent = error ? '读取失败' : '还没有内容';
      if (span) span.textContent = error || '导入 ZIP，或从 Modrinth 搜索下载。';
    }
    if (!items.length) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = items.map((item) => {
      const icon = item.icon
        ? `<img src="${item.icon}" alt="">`
        : `<span class="content-thumb-fallback">${state.type === 'shaderpack' ? 'GL' : state.type === 'datapack' ? 'DP' : 'RP'}</span>`;
      const meta = [];
      if (state.type === 'datapack') meta.push(item.scopeLabel || (item.scope === 'world' ? `世界 ${item.world}` : '实例全局'));
      if (item.packFormat) meta.push(`格式 ${item.packFormat}`);
      if (item.kind === 'directory') meta.push('文件夹');
      const disabled = item.canToggle ? '' : ' disabled';
      return `<div class="content-item" data-content-item="${esc(item.id)}">
        <div class="content-thumb">${icon}</div>
        <div class="content-main">
          <div class="content-title-row">
            <strong>${esc(item.name || item.fileName)}</strong>
            ${item.enabled ? '<span class="badge success">已启用</span>' : '<span class="badge gray">未启用</span>'}
            ${meta.map((text) => `<span class="badge gray">${esc(text)}</span>`).join('')}
          </div>
          <span class="muted-sm">${esc(item.description || '没有 pack.mcmeta 描述')}</span>
          <span class="muted-sm content-file-line">${esc(item.fileName)}${item.size ? ` · ${formatBytes(item.size)}` : ''}</span>
        </div>
        <div class="content-actions">
          <label class="switch" title="${item.canToggle ? '启用或停用' : '该内容不支持在这里切换'}">
            <input type="checkbox" data-content-toggle="${esc(item.id)}" ${item.enabled ? 'checked' : ''}${disabled}>
            <span></span>
          </label>
          <button class="btn tiny ghost" data-content-preview="${esc(item.id)}">详情</button>
          <button class="btn tiny ghost danger-text" data-content-remove="${esc(item.id)}">删除</button>
        </div>
      </div>`;
    }).join('');
  }

  function itemById(id) {
    return state.items.find((item) => item.id === id) || null;
  }

  async function toggle(id, enabled, checkbox) {
    const target = targetVersion();
    if (!target) return;
    if (checkbox) checkbox.disabled = true;
    let result;
    try {
      result = await MP.api.invoke('content:set-enabled', {
        targetVersionId: target.id,
        type: state.type,
        id,
        enabled,
        world: state.world || undefined,
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (!result || !result.ok) {
      if (checkbox) {
        checkbox.checked = !enabled;
        checkbox.disabled = false;
      }
      MP.toast((result && result.error) || '切换失败', 'err', 6000);
      return;
    }
    MP.toast(enabled ? '已启用' : '已停用', 'ok', 2200);
    await load();
  }

  async function showPreview(id) {
    const target = targetVersion();
    if (!target) return;
    let result;
    try {
      result = await MP.api.invoke('content:preview', {
        targetVersionId: target.id,
        type: state.type,
        id,
        world: state.world || undefined,
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (!result || !result.ok) {
      MP.toast((result && result.error) || '读取详情失败', 'err');
      return;
    }
    await MP.modal({
      title: result.name || '内容详情',
      width: 520,
      body: `<div class="content-preview">
        ${result.icon ? `<img src="${result.icon}" alt="">` : '<div class="content-preview-placeholder">没有预览图</div>'}
        <div>
          <p>${esc(result.description || '没有描述')}</p>
          <p class="muted-sm">格式版本：${result.packFormat || '未知'}</p>
          <p class="muted-sm content-path">${esc(result.path || '')}</p>
        </div>
      </div>`,
      actions: [{ label: '关闭', value: true }],
    });
  }

  async function removeItem(id) {
    const item = itemById(id);
    const ok = await MP.confirm({
      title: `删除${TYPE_META[state.type].label}`,
      text: `确定删除「${(item && item.name) || id}」吗？文件会移动到内容回收站，不会立即永久删除。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    const target = targetVersion();
    if (!target) return;
    let result;
    try {
      result = await MP.api.invoke('content:remove', {
        targetVersionId: target.id,
        type: state.type,
        id,
        world: state.world || undefined,
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (!result || !result.ok) {
      MP.toast((result && result.error) || '删除失败', 'err', 6000);
      return;
    }
    MP.toast('已移动到内容回收站', 'ok');
    await load();
  }

  function isWeb() {
    return Boolean(MP.state.info && MP.state.info.mode === 'web');
  }

  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',').pop() || '');
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });
  }

  async function importFromFile(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name || '')) {
      MP.toast('请选择 .zip 格式的内容包', 'err');
      return;
    }
    if (isWeb() && file.size > 13 * 1024 * 1024) {
      MP.toast('浏览器版单次上传上限约 13 MB，请使用桌面版导入大文件', 'err', 6000);
      return;
    }
    const target = targetVersion();
    if (!target) return;
    let result;
    try {
      const data = await readBase64(file);
      result = await MP.api.invoke('content:import-base64', {
        targetVersionId: target.id,
        type: state.type,
        name: file.name,
        data,
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (result && result.code === 'CONTENT_EXISTS') {
      const ok = await MP.confirm({
        title: '文件已经存在',
        text: '是否覆盖同名内容包？覆盖后旧文件会被替换。',
        confirmLabel: '覆盖',
        danger: true,
      });
      if (!ok) return;
      try {
        const data = await readBase64(file);
        result = await MP.api.invoke('content:import-base64', {
          targetVersionId: target.id,
          type: state.type,
          name: file.name,
          data,
          overwrite: true,
        });
      } catch (err) {
        result = { ok: false, error: err.message };
      }
    }
    if (!result || !result.ok) {
      MP.toast((result && result.error) || '导入失败', 'err', 6000);
      return;
    }
    MP.toast('内容包已导入', 'ok');
    await load();
  }

  async function importContent() {
    if (isWeb()) {
      const input = $('#content-file-input');
      if (input) input.click();
      return;
    }
    const target = targetVersion();
    if (!target) return;
    let result;
    try {
      result = await MP.api.invoke('content:import', {
        targetVersionId: target.id,
        type: state.type,
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (!result || result.canceled) return;
    if (!result.ok) {
      MP.toast(result.error || '导入失败', 'err', 6000);
      return;
    }
    MP.toast('内容包已导入', 'ok');
    await load();
  }

  function renderSearch() {
    const box = $('#content-results');
    const status = $('#content-search-status');
    if (!box) return;
    if (status) {
      status.textContent = state.searchHits.length
        ? `找到 ${state.searchHits.length} 个结果`
        : (MP.state.settings && MP.state.settings.onlineDownloads
          ? '输入关键词搜索 Modrinth；结果来自第三方服务。'
          : '需要先在设置 → 下载中开启“在线下载”。');
    }
    if (!state.searchHits.length) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = state.searchHits.map((hit) => `<div class="content-result">
      <div class="content-result-icon">${hit.iconUrl ? `<img src="${esc(hit.iconUrl)}" alt="" loading="lazy">` : 'MR'}</div>
      <div class="content-result-main">
        <strong>${esc(hit.title)}</strong>
        <span class="muted-sm">${esc(hit.description || '')}</span>
        <span class="muted-sm">${esc((hit.categories || []).slice(0, 4).join(' · '))}${hit.downloads ? ` · ${Number(hit.downloads).toLocaleString()} 次下载` : ''}</span>
      </div>
      <button class="btn small primary" data-content-install="${esc(hit.projectId)}">${state.type === 'datapack' ? '下载' : '下载并启用'}</button>
    </div>`).join('');
  }

  async function search() {
    const target = targetVersion();
    if (!target) {
      MP.toast('请先选择实例', 'err');
      return;
    }
    const input = $('#content-search');
    const query = input ? input.value.trim() : '';
    if (!MP.state.settings || !MP.state.settings.onlineDownloads) {
      MP.toast('请先在设置 → 下载中开启在线下载', 'warn', 6000);
      return;
    }
    const seq = ++state.searchSeq;
    const status = $('#content-search-status');
    if (status) status.textContent = '正在搜索 Modrinth…';
    let result;
    try {
      result = await MP.api.invoke('content:search', {
        targetVersionId: target.id,
        type: state.type,
        query,
        gameVersion: target.mcVersion || '',
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (seq !== state.searchSeq) return;
    if (!result || !result.ok) {
      state.searchHits = [];
      renderSearch();
      if (status) status.textContent = (result && result.error) || '搜索失败';
      MP.toast(`搜索失败：${(result && result.error) || '未知错误'}`, 'err', 6000);
      return;
    }
    state.searchHits = Array.isArray(result.hits) ? result.hits : [];
    renderSearch();
  }

  async function install(projectId) {
    if (state.installing) return;
    const target = targetVersion();
    if (!target) return;
    state.installing = true;
    if (MP.plugins && MP.plugins.broadcast) {
      MP.plugins.broadcast('download:started', { kind: 'content', type: state.type, projectId });
    }
    const bar = $('#content-progress-bar');
    if (bar) bar.classList.remove('hidden');
    let result;
    try {
      result = await MP.api.invoke('content:install', {
        targetVersionId: target.id,
        type: state.type,
        projectId,
        gameVersion: target.mcVersion || '',
        enable: state.type !== 'datapack',
      });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    state.installing = false;
    if (bar) bar.classList.add('hidden');
    if (MP.plugins && MP.plugins.broadcast) {
      MP.plugins.broadcast('download:completed', {
        kind: 'content',
        type: state.type,
        projectId,
        ok: Boolean(result && result.ok),
        error: (result && result.error) || '',
      });
    }
    if (!result || !result.ok) {
      MP.toast((result && result.error) || '下载失败', 'err', 7000);
      return;
    }
    MP.toast(`已下载 ${result.fileName}${result.enabled ? ' 并启用' : ''}`, 'ok', 5000);
    await load();
  }

  function bindProgress() {
    MP.api.on('content:progress', (payload) => {
      if (!payload) return;
      const bar = $('#content-progress-bar');
      if (bar) bar.classList.remove('hidden');
      const fill = $('#content-pb-fill');
      const percent = $('#content-pb-percent');
      const phase = $('#content-pb-phase');
      const size = $('#content-pb-size');
      if (fill) fill.style.width = `${Math.max(0, Math.min(100, Number(payload.percent) || 0))}%`;
      if (percent) percent.textContent = `${Math.max(0, Math.min(100, Number(payload.percent) || 0))}%`;
      if (phase) phase.textContent = payload.message || '正在下载…';
      if (size) size.textContent = payload.bytes ? `${formatBytes(payload.received || 0)} / ${formatBytes(payload.bytes)}` : '';
      if (MP.plugins && MP.plugins.broadcast) {
        MP.plugins.broadcast('download:progress', {
          kind: 'content',
          type: payload.type || state.type,
          percent: Math.max(0, Math.min(100, Number(payload.percent) || 0)),
          phase: payload.message || '',
        });
      }
    });
    MP.api.on('content:done', () => {
      const bar = $('#content-progress-bar');
      if (bar) bar.classList.add('hidden');
    });
    MP.api.on('content:error', () => {
      const bar = $('#content-progress-bar');
      if (bar) bar.classList.add('hidden');
    });
  }

  function bind() {
    MP.on('#content-target', 'change', () => { state.items = []; load(); });
    MP.on('#content-tabs', 'click', (event) => {
      const button = event.target.closest('[data-content-type]');
      if (button) setType(button.dataset.contentType);
    });
    MP.on('#content-world', 'change', () => {
      const select = $('#content-world');
      state.world = select ? select.value : '';
      renderList();
    });
    MP.on('#btn-content-refresh', 'click', () => load());
    MP.on('#btn-content-rescan', 'click', () => load());
    MP.on('#btn-content-open', 'click', async () => {
      const target = targetVersion();
      if (!target) return;
      const result = await MP.api.invoke('content:open-folder', { targetVersionId: target.id, type: state.type });
      if (result && result.ok === false) MP.toast(result.error || '无法打开目录', 'err');
    });
    MP.on('#btn-content-import', 'click', importContent);
    MP.on('#content-file-input', 'change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) importFromFile(file).finally(() => { event.target.value = ''; });
    });
    MP.on('#btn-content-search', 'click', search);
    MP.on('#content-search', 'keydown', (event) => {
      if (event.key === 'Enter') search();
    });
    MP.on('#content-list', 'change', (event) => {
      const toggleInput = event.target.closest('[data-content-toggle]');
      if (toggleInput) toggle(toggleInput.dataset.contentToggle, toggleInput.checked, toggleInput);
    });
    MP.on('#content-list', 'click', (event) => {
      const preview = event.target.closest('[data-content-preview]');
      if (preview) { showPreview(preview.dataset.contentPreview); return; }
      const remove = event.target.closest('[data-content-remove]');
      if (remove) removeItem(remove.dataset.contentRemove);
    });
    MP.on('#content-results', 'click', (event) => {
      const button = event.target.closest('[data-content-install]');
      if (button) install(button.dataset.contentInstall);
    });
  }

  MP.views = MP.views || {};
  MP.views.content = {
    init() {
      bind();
      bindProgress();
      populateTargets();
      renderSearch();
    },
    onShow() {
      populateTargets();
      load();
    },
    render() {
      populateTargets();
      load();
    },
  };
})();