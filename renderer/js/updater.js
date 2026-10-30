'use strict';

(function () {
  const { $ } = MP;

  const state = {
    current: null,
    checking: false,
    downloading: false,
    busy: false,
  };

  function esc(value) {
    return MP.esc ? MP.esc(String(value == null ? '' : value)) : String(value == null ? '' : value);
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024 * 1024) return `${Math.max(0, Math.round(value / 1024))} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function isWeb() {
    return Boolean(MP.state.info && MP.state.info.mode === 'web');
  }

  function setButton(selector, visible, disabled) {
    const node = $(selector);
    if (!node) return;
    node.classList.toggle('hidden', !visible);
    node.disabled = Boolean(disabled);
  }

  function setProgress(visible, percent, label) {
    const wrappers = [$('#update-progress-wrap'), $('#about-update-progress-wrap')].filter(Boolean);
    for (const wrapper of wrappers) wrapper.classList.toggle('hidden', !visible);
    const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    const bars = [$('#update-progress-bar'), $('#about-update-progress-bar')].filter(Boolean);
    for (const bar of bars) bar.style.width = `${value}%`;
    const labels = [$('#update-progress-label'), $('#about-update-progress-label')].filter(Boolean);
    for (const node of labels) node.textContent = label || '下载更新';
    const percents = [$('#update-progress-percent'), $('#about-update-progress-percent')].filter(Boolean);
    for (const node of percents) node.textContent = `${value}%`;
  }

  function statusText(update) {
    if (!update) return '还没有检查更新';
    if (!update.configured) return '未配置更新源，不会联网检查';
    if (update.error) return update.error;
    if (update.available) return `发现新版本 ${update.latestVersion}`;
    if (update.latestVersion) return `已是最新版本（${update.currentVersion}）`;
    return '尚未检查更新';
  }

  function render(update) {
    if (update) state.current = update;
    const value = state.current || {};
    const version = value.currentVersion || (MP.state.info && MP.state.info.version) || '';
    const versionText = version ? `v${version}` : '—';

    const feedInput = $('#set-update-feed');
    if (feedInput && document.activeElement !== feedInput) {
      feedInput.value = (MP.state.settings && MP.state.settings.updateFeedUrl) || '';
    }
    const auto = $('#set-auto-update');
    if (auto && MP.state.settings) auto.checked = MP.state.settings.autoCheckUpdates !== false;

    const status = $('#update-status-text');
    if (status) status.textContent = statusText(value);
    const chip = $('#update-version-chip');
    if (chip) chip.textContent = versionText;
    const aboutStatus = $('#about-update-status');
    if (aboutStatus) aboutStatus.textContent = statusText(value);
    const aboutVersion = $('#about-update-version');
    if (aboutVersion) aboutVersion.textContent = versionText;

    const notes = $('#about-update-notes');
    const notesText = $('#about-update-notes-text');
    if (notes && notesText) {
      const content = String(value.notes || '').trim();
      notes.classList.toggle('hidden', !content);
      notesText.textContent = content;
    }

    const downloaded = Boolean(value.filePath);
    const available = Boolean(value.available);
    const canDownload = available && !downloaded && !state.downloading && !state.checking;
    const installVisible = downloaded && !isWeb();

    setButton('#about-check-update', true, state.checking || state.downloading);
    setButton('#btn-check-update', true, state.checking || state.downloading);
    setButton('#about-download-update', canDownload, !canDownload);
    setButton('#about-install-update', installVisible, state.downloading);
    setButton('#about-open-updates', Boolean(value.configured) || downloaded, false);
    setButton('#btn-open-updates', Boolean(value.configured) || downloaded, false);

    if (downloaded) {
      if (aboutStatus) aboutStatus.textContent = isWeb() ? `已下载 ${value.latestVersion}，请到下载目录手动安装` : `已下载 ${value.latestVersion}，可以安装并重启`;
      setProgress(false, 100, '更新已下载');
    }
  }

  async function load() {
    try {
      const result = await MP.api.invoke('updater:state');
      render(result);
    } catch (err) {
      const status = $('#update-status-text');
      if (status) status.textContent = `读取更新状态失败：${err.message}`;
    }
  }

  async function check() {
    if (state.checking || state.downloading) return;
    state.checking = true;
    render();
    const status = $('#update-status-text');
    if (status) status.textContent = '正在检查更新…';
    const aboutStatus = $('#about-update-status');
    if (aboutStatus) aboutStatus.textContent = '正在检查更新…';
    try {
      const result = await MP.api.invoke('updater:check');
      if (!result) throw new Error('没有返回更新状态');
      render(result);
      if (!result.configured) {
        MP.toast('还没有配置更新源，请先在设置里填写更新地址', 'err', 6000);
      } else if (result.error) {
        MP.toast(`检查更新失败：${result.error}`, 'err', 6500);
      } else if (result.available) {
        MP.toast(`发现 MinePilot ${result.latestVersion}`, 'ok', 5000);
      } else {
        MP.toast('当前已是最新版本', 'ok');
      }
    } catch (err) {
      MP.toast(`检查更新失败：${err.message}`, 'err', 6000);
    } finally {
      state.checking = false;
      render();
    }
  }

  async function download() {
    if (state.downloading) return;
    const update = state.current || {};
    if (!update.available) {
      MP.toast('当前没有可下载的新版本', 'err');
      return;
    }
    state.downloading = true;
    setProgress(true, 0, `准备下载 MinePilot ${update.latestVersion || ''}`);
    render();
    try {
      const result = await MP.api.invoke('updater:download');
      if (!result || !result.ok) throw new Error((result && result.error) || '下载失败');
      state.current = result.state || state.current;
      setProgress(true, 100, '更新已下载');
      MP.toast(result.warning || '更新安装包已下载', result.warning ? 'err' : 'ok', result.warning ? 7000 : 4000);
      render();
    } catch (err) {
      setProgress(false, 0, '');
      MP.toast(`下载更新失败：${err.message}`, 'err', 7000);
    } finally {
      state.downloading = false;
      render();
    }
  }

  async function install() {
    if (state.busy) return;
    const update = state.current || {};
    const confirmed = await MP.confirm({
      title: '安装更新',
      text: `将启动 MinePilot ${update.latestVersion || ''} 的安装程序，并退出当前启动器。安装包来自你配置的更新源，请确认来源可信。`,
      confirmLabel: '安装并退出',
    });
    if (!confirmed) return;
    state.busy = true;
    try {
      const result = await MP.api.invoke('updater:install');
      if (result && result.desktopOnly) {
        MP.toast(result.error || '浏览器版不能自动安装更新', 'err', 7000);
        await openDownloads();
        return;
      }
      if (!result || !result.ok) throw new Error((result && result.error) || '安装程序启动失败');
      MP.toast(result.message || '安装程序已启动，正在退出…', 'ok', 5000);
    } catch (err) {
      MP.toast(`启动安装程序失败：${err.message}`, 'err', 7000);
    } finally {
      state.busy = false;
    }
  }

  async function openDownloads() {
    try {
      const result = await MP.api.invoke('updater:open-downloads');
      if (result && result.ok === false) MP.toast(result.error || '无法打开下载目录', 'err');
    } catch (err) {
      MP.toast(`无法打开下载目录：${err.message}`, 'err');
    }
  }

  async function saveFeed() {
    const input = $('#set-update-feed');
    if (!input) return;
    const value = input.value.trim();
    if (value && !/^https:\/\//i.test(value) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(value)) {
      MP.toast('更新源必须使用 HTTPS（本地调试地址除外）', 'err', 6000);
      return;
    }
    try {
      const next = await MP.api.invoke('settings:update', { updateFeedUrl: value });
      MP.state.settings = next;
      MP.toast(value ? '更新源已保存' : '已清空更新源，不会联网检查', 'ok');
      if (value) await check();
      else await load();
    } catch (err) {
      MP.toast(`保存更新源失败：${err.message}`, 'err', 6000);
    }
  }

  async function saveAuto(checked) {
    try {
      const next = await MP.api.invoke('settings:update', { autoCheckUpdates: Boolean(checked) });
      MP.state.settings = next;
    } catch (err) {
      MP.toast(`保存更新设置失败：${err.message}`, 'err', 5000);
    }
  }

  function bind() {
    MP.on('#btn-save-update-feed', 'click', saveFeed);
    MP.on('#btn-check-update', 'click', check);
    MP.on('#about-check-update', 'click', check);
    MP.on('#btn-open-updates', 'click', openDownloads);
    MP.on('#about-open-updates', 'click', openDownloads);
    MP.on('#about-download-update', 'click', download);
    MP.on('#about-install-update', 'click', install);
    MP.on('#set-auto-update', 'change', (event) => saveAuto(event.target.checked));
    MP.api.on('update:state', (update) => render(update));
    MP.api.on('update:progress', (progress) => {
      if (!progress) return;
      state.downloading = true;
      setProgress(true, progress.percent || 0, progress.phase || '下载更新');
    });
  }

  MP.updater = {
    init() {
      bind();
      load();
    },
    check,
    render,
    load,
  };
})();