'use strict';

(function () {
  const { $, esc } = MP;

  let loading = false;
  let bound = false;
  let speedSample = { time: 0, bytes: 0, value: 0 };

  function onlineDownloadsEnabled() {
    return Boolean(MP.state.settings && MP.state.settings.onlineDownloads);
  }

  function typeLabel(type) {
    if (type === 'release') return '正式版';
    if (type === 'snapshot') return '快照';
    if (type === 'old_beta') return '旧版 Beta';
    if (type === 'old_alpha') return '旧版 Alpha';
    return type || '未知';
  }

  function badgeOf(type) {
    if (type === 'release') return { text: 'REL', cls: '' };
    if (type === 'snapshot') return { text: 'SNAP', cls: 'snapshot' };
    if (type === 'old_beta') return { text: 'BETA', cls: 'snapshot' };
    return { text: 'ALPHA', cls: 'snapshot' };
  }

  function rowHTML(version, installedSet) {
    const badge = badgeOf(version.type);
    const isInstalled = installedSet.has(version.id);
    const date = MP.fmtDate(version.releaseTime || version.time);
    const action = isInstalled
      ? `<button class="btn small ghost" data-loader-install="${esc(version.id)}" title="一键安装 Fabric / Forge / NeoForge / Quilt">加载器</button><button class="btn small ghost" data-install="${esc(version.id)}">重新安装</button>`
      : '<button class="btn small primary" data-install="' + esc(version.id) + '">安装</button>';

    return `<div class="card dl-row">
      <div class="dl-badge ${badge.cls}">${badge.text}</div>
      <div class="dl-main">
        <div class="dl-name">${esc(version.id)}</div>
        <div class="dl-meta">${typeLabel(version.type)} · 发布于 ${date}${isInstalled ? ' · 已安装' : ''}</div>
      </div>
      ${action}
    </div>`;
  }

  function render() {
    const manifest = MP.state.manifest;
    const list = $('#dl-list');
    if (!list) return;

    const notice = $('#dl-offline-notice');
    const enabled = onlineDownloadsEnabled();
    if (notice) notice.classList.toggle('hidden', enabled);
    if (!enabled) {
      list.innerHTML = '';
      if ($('#dl-empty')) $('#dl-empty').classList.add('hidden');
      return;
    }
    if (!manifest) return;

    const filter = MP.state.manifestFilter || 'release';
    const query = String(MP.state.manifestQuery || '').trim().toLowerCase();
    let versions = Array.isArray(manifest.versions) ? manifest.versions : [];
    if (filter !== 'all') versions = versions.filter((version) => version.type === filter);
    if (query) versions = versions.filter((version) => version.id.toLowerCase().includes(query));

    if ($('#dl-source-chip')) {
      const source = (MP.state.settings && MP.state.settings.downloadSource) || 'auto';
      const text = source === 'bmclapi' ? 'BMCLAPI 镜像优先' : source === 'official' ? 'Mojang 官方源' : '自动选择下载源';
      const node = $('#dl-source-chip');
      node.innerHTML = `<span class="status-dot"></span><span>${text}</span>`;
    }

    const empty = $('#dl-empty');
    if (!versions.length) {
      list.innerHTML = '';
      if (empty) {
        empty.classList.remove('hidden');
        const title = $('#dl-empty-title');
        const text = $('#dl-empty-text');
        if (title) title.textContent = query ? '没有找到这个版本' : '暂无版本数据';
        if (text) {
          text.textContent = query
            ? '检查一下版本号，或切换到“全部”再试试。'
            : '请点击“刷新列表”重新获取版本信息。';
        }
      }
      return;
    }
    if (empty) empty.classList.add('hidden');

    const installedSet = new Set(MP.state.versions.map((version) => version.id));
    const shown = versions.slice(0, 300);
    let html = shown.map((version) => rowHTML(version, installedSet)).join('');
    if (versions.length > shown.length) {
      html += `<div class="muted-sm" style="padding:10px 4px 2px">仅显示前 ${shown.length} 个版本，请使用搜索缩小范围。</div>`;
    }
    list.innerHTML = html;
  }

  async function loadManifest(force) {
    if (!onlineDownloadsEnabled()) {
      render();
      return;
    }
    if (loading) return;
    loading = true;
    const refreshButton = $('#btn-refresh-manifest');
    if (refreshButton) refreshButton.disabled = true;

    if (!MP.state.manifest) {
      $('#dl-list').innerHTML = '<div class="card" style="padding:26px;text-align:center;color:var(--muted)">正在从 Mojang 获取版本列表…</div>';
      if ($('#dl-empty')) $('#dl-empty').classList.add('hidden');
    }

    let result;
    try {
      result = await MP.api.invoke('manifest:get', { force: Boolean(force) });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    loading = false;
    if (refreshButton) refreshButton.disabled = false;

    if (!result.ok) {
      MP.toast(`获取版本列表失败：${result.error}`, 'err', 6500);
      if (!MP.state.manifest) {
        $('#dl-list').innerHTML = '';
        if ($('#dl-empty')) {
          $('#dl-empty').classList.remove('hidden');
          if ($('#dl-empty-title')) $('#dl-empty-title').textContent = '无法获取版本列表';
          if ($('#dl-empty-text')) $('#dl-empty-text').textContent = result.error;
        }
      }
      return;
    }

    MP.state.manifest = result;
    render();
    if (force) MP.toast('版本列表已更新', 'ok');
  }

  function resetBar() {
    if ($('#ib-fill')) $('#ib-fill').style.width = '0%';
    if ($('#ib-percent')) $('#ib-percent').textContent = '0%';
    if ($('#ib-speed')) $('#ib-speed').textContent = '';
    if ($('#ib-files')) $('#ib-files').textContent = '';
    speedSample = { time: 0, bytes: 0, value: 0 };
    const cancel = $('#btn-cancel-install');
    if (cancel) {
      cancel.disabled = false;
      cancel.textContent = '取消安装';
    }
  }

  function showBar(versionId) {
    resetBar();
    if ($('#install-bar')) $('#install-bar').classList.remove('hidden');
    if ($('#ib-title')) $('#ib-title').textContent = `正在安装 ${versionId}`;
    if ($('#ib-phase')) $('#ib-phase').textContent = '准备中…';
  }

  async function startInstall(versionId) {
    if (!onlineDownloadsEnabled()) {
      MP.toast('在线下载已关闭。请先在「设置 → 下载」中勾选“在线下载”。', 'warn', 5500);
      return;
    }
    if (MP.state.installing) {
      MP.toast('已有安装任务正在进行', 'warn');
      return;
    }
    MP.state.installing = true;
    MP.state.installingVersion = versionId;
    showBar(versionId);
    if (MP.views.home) MP.views.home.refresh();

    let result;
    try {
      result = await MP.api.invoke('install:start', versionId);
    } catch (err) {
      result = { ok: false, error: err.message };
    }

    if (!result.ok && MP.state.installing) {
      MP.state.installing = false;
      if ($('#install-bar')) $('#install-bar').classList.add('hidden');
      MP.toast(`安装失败：${result.error}`, 'err', 6500);
      if (MP.views.home) MP.views.home.refresh();
    }
  }

  function onProgress(progress) {
    MP.state.installing = true;
    MP.state.installingVersion = progress.versionId;
    if ($('#install-bar')) $('#install-bar').classList.remove('hidden');
    if ($('#ib-title')) $('#ib-title').textContent = `正在安装 ${progress.versionId}`;
    if ($('#ib-phase')) $('#ib-phase').textContent = progress.phase || '准备中…';

    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    if ($('#ib-fill')) $('#ib-fill').style.width = `${percent}%`;
    if ($('#ib-percent')) $('#ib-percent').textContent = `${Math.round(percent)}%`;
    if ($('#ib-files')) {
      $('#ib-files').textContent = progress.totalFiles
        ? `${progress.doneFiles || 0} / ${progress.totalFiles} 个文件`
        : '';
    }

    const now = Date.now();
    const bytes = Number(progress.bytesDone) || 0;
    if (!speedSample.time) {
      speedSample = { time: now, bytes, value: 0 };
    } else {
      const seconds = (now - speedSample.time) / 1000;
      if (seconds >= 0.7) {
        const delta = bytes - speedSample.bytes;
        if (delta > 0) speedSample.value = delta / seconds;
        speedSample.time = now;
        speedSample.bytes = bytes;
      }
    }
    if ($('#ib-speed')) {
      $('#ib-speed').textContent = speedSample.value > 0 ? `${MP.fmtBytes(speedSample.value)}/s` : '';
    }
  }

  async function onDone(result) {
    MP.state.installing = false;
    if ($('#ib-title')) $('#ib-title').textContent = `已安装 ${result.versionId}`;
    if ($('#ib-phase')) $('#ib-phase').textContent = '安装完成，可以开始游戏了';
    if ($('#ib-fill')) $('#ib-fill').style.width = '100%';
    if ($('#ib-percent')) $('#ib-percent').textContent = '100%';
    if ($('#ib-speed')) $('#ib-speed').textContent = '';
    if ($('#ib-files')) $('#ib-files').textContent = '';

    MP.toast(`版本 ${result.versionId} 安装完成`, 'ok', 4500);

    MP.state.selectedVersion = result.versionId;
    const settings = await MP.api.invoke('settings:update', { lastVersion: result.versionId });
    MP.state.settings = settings;
    await MP.refreshVersions();
    render();

    setTimeout(() => {
      if (!MP.state.installing && $('#install-bar')) $('#install-bar').classList.add('hidden');
    }, 2200);
  }

  function onError(payload) {
    MP.state.installing = false;
    if ($('#install-bar')) $('#install-bar').classList.add('hidden');
    if (payload.aborted) {
      MP.toast('已取消安装', 'warn');
    } else {
      MP.toast(`安装失败：${payload.error}`, 'err', 7000);
    }
    if (MP.views.home) MP.views.home.refresh();
  }

  async function cancelInstall() {
    const button = $('#btn-cancel-install');
    if (button) {
      button.disabled = true;
      button.textContent = '正在取消…';
    }
    await MP.api.invoke('install:cancel');
    setTimeout(() => {
      if (button && document.body.contains(button)) {
        button.disabled = false;
        button.textContent = '取消安装';
      }
    }, 1600);
  }

  async function handleListClick(event) {
    const loaderButton = event.target.closest('button[data-loader-install]');
    if (loaderButton) {
      const version = MP.state.versions.find((item) => item.id === loaderButton.dataset.loaderInstall);
      if (version && MP.views.versions && MP.views.versions.openLoader) {
        await MP.views.versions.openLoader(version);
      }
      return;
    }
    const button = event.target.closest('button[data-install]');
    if (!button) return;
    await startInstall(button.dataset.install);
  }

  function setFilter(type, button) {
    MP.state.manifestFilter = type;
    MP.$$('#dl-filter button').forEach((item) => item.classList.toggle('active', item === button));
    render();
  }

  function init() {
    if (bound) return;
    bound = true;

    MP.$$('#dl-filter button').forEach((button) => {
      button.addEventListener('click', () => setFilter(button.dataset.type, button));
    });

    MP.on('#dl-search', 'input', MP.debounce((event) => {
      MP.state.manifestQuery = event.target.value;
      render();
    }, 140));

    MP.on('#btn-refresh-manifest', 'click', () => loadManifest(true));
    MP.on('#dl-list', 'click', handleListClick);
    MP.on('#btn-cancel-install', 'click', cancelInstall);
    MP.on('#btn-enable-online', 'click', () => MP.go('settings'));
  }

  MP.views.download = {
    init,
    onShow: () => {
      render();
      if (onlineDownloadsEnabled() && !MP.state.manifest) loadManifest(false);
    },
    onOnlineChange: (enabled) => {
      render();
      if (enabled && MP.state.view === 'download' && !MP.state.manifest) loadManifest(false);
    },
    onProgress,
    onDone,
    onError,
    render,
  };
})();