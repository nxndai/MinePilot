'use strict';

(function () {
  const { $, esc } = MP;
  let bound = false;
  let saving = null;

  function onlineDownloadsEnabled() {
    return Boolean(MP.state.settings && MP.state.settings.onlineDownloads);
  }

  function setRangeFill(input, min, max, value) {
    if (!input) return;
    const percent = ((Number(value) - min) / (max - min)) * 100;
    input.style.setProperty('--fill', `${Math.max(0, Math.min(100, percent))}%`);
  }

  function memoryText(mb) {
    const value = Number(mb) || 0;
    return `${value} MB`;
  }

  async function save(patch, options) {
    saving = MP.api.invoke('settings:update', patch);
    const settings = await saving;
    saving = null;
    MP.state.settings = settings;
    if (MP.applyAppearance) MP.applyAppearance(settings);
    if (options && options.refreshVersions) await MP.refreshVersions();
    if (MP.views.home) MP.views.home.refresh();
    if (MP.views.mods && MP.views.mods.onSettingsChanged) MP.views.mods.onSettingsChanged();
    return settings;
  }

  function renderJava() {
    const select = $('#set-java');
    const detail = $('#java-detail');
    if (!select) return;

    const settings = MP.state.settings || {};
    const current = settings.javaPath || '';
    const list = MP.state.javaList || [];

    let html = '<option value="">自动选择（推荐）</option>';
    for (const item of list) {
      const selected = item.path === current ? ' selected' : '';
      html += `<option value="${esc(item.path)}"${selected}>Java ${item.major} · ${esc(item.vendor)} · ${esc(item.version)}</option>`;
    }
    if (current && !list.some((item) => item.path === current)) {
      html += `<option value="${esc(current)}" selected>自定义 · ${esc(current)}</option>`;
    }
    select.innerHTML = html;
    select.value = current;

    if (detail) {
      if (!list.length) {
        detail.textContent = '未检测到 Java，可点击右侧“安装 Java”自动下载';
      } else {
        const best = list[0];
        detail.textContent = `已找到 ${list.length} 个 Java，最高为 Java ${best.major}（${best.vendor}）`;
      }
    }
  }

  function render() {
    const settings = MP.state.settings;
    if (!settings) return;

    if ($('#set-gamedir')) {
      $('#set-gamedir').value = settings.gameDir;
      $('#set-gamedir').title = settings.gameDir;
    }
    if ($('#set-memory')) {
      $('#set-memory').value = settings.memoryMb;
      setRangeFill($('#set-memory'), 1024, 16384, settings.memoryMb);
    }
    if ($('#memory-value')) $('#memory-value').textContent = memoryText(settings.memoryMb);

    if ($('#set-width')) $('#set-width').value = settings.width;
    if ($('#set-height')) $('#set-height').value = settings.height;
    if ($('#set-fullscreen')) $('#set-fullscreen').checked = Boolean(settings.fullscreen);
    if ($('#set-jvm')) $('#set-jvm').value = settings.jvmArgs || '';
    if ($('#set-autolog')) $('#set-autolog').checked = Boolean(settings.autoOpenLog);
    if ($('#set-theme')) $('#set-theme').value = settings.theme === 'light' ? 'light' : 'dark';
    if ($('#set-language')) $('#set-language').value = settings.language === 'en-US' ? 'en-US' : 'zh-CN';
    if ($('#set-bg-type')) $('#set-bg-type').value = settings.backgroundType || 'default';
    if ($('#set-bg-color')) $('#set-bg-color').value = settings.backgroundColor || '#0b1020';
    if ($('#set-ui-scale')) $('#set-ui-scale').value = String(settings.uiScale || 1);
    if ($('#set-animations')) $('#set-animations').checked = settings.animations !== false;
    if ($('#set-download-source')) $('#set-download-source').value = settings.downloadSource || (settings.useMirror === false ? 'official' : 'auto');
    if ($('#set-assets')) $('#set-assets').checked = Boolean(settings.downloadAssets);
    if ($('#set-online-downloads')) $('#set-online-downloads').checked = Boolean(settings.onlineDownloads);
    if ($('#set-isolation')) $('#set-isolation').checked = Boolean(settings.versionIsolation);
    if ($('#set-threads')) {
      $('#set-threads').value = settings.downloadThreads;
      setRangeFill($('#set-threads'), 1, 32, settings.downloadThreads);
    }
    if ($('#threads-value')) $('#threads-value').textContent = String(settings.downloadThreads);
    if ($('#set-username')) $('#set-username').value = settings.offlineName || '';
    if ($('#set-curseforge-key')) $('#set-curseforge-key').value = settings.curseforgeApiKey || '';
    if ($('#cf-key-status')) {
      $('#cf-key-status').textContent = settings.curseforgeApiKey
        ? 'CurseForge 已配置，可在「模组」页切换来源'
        : 'CurseForge 未配置';
    }
    if ($('#btn-clear-cf-key')) $('#btn-clear-cf-key').classList.toggle('hidden', !settings.curseforgeApiKey);

    const bgType = settings.backgroundType || 'default';
    if ($('#set-bg-color')) $('#set-bg-color').classList.toggle('hidden', bgType !== 'color');
    if ($('#btn-pick-bg')) $('#btn-pick-bg').classList.toggle('hidden', bgType !== 'image');
    if ($('#btn-clear-bg')) $('#btn-clear-bg').classList.toggle('hidden', bgType !== 'image');

    renderJava();
    if (MP.renderAccountSettings) MP.renderAccountSettings();
    if (MP.bindAccountSettings) MP.bindAccountSettings();
  }

  async function browseGameDir() {
    const current = MP.state.settings ? MP.state.settings.gameDir : '';
    const dir = await MP.api.invoke('dialog:pick-folder', {
      title: '选择 Minecraft 游戏目录',
      defaultPath: current,
    });
    if (!dir) return;
    await save({ gameDir: dir }, { refreshVersions: true });
    render();
    MP.toast('游戏目录已更新', 'ok');
  }

  async function detectJava() {
    const button = $('#btn-detect-java');
    if (button) {
      button.disabled = true;
      button.textContent = '检测中…';
    }
    await MP.refreshJava();
    renderJava();
    if (button) {
      button.disabled = false;
      button.textContent = '重新检测';
    }
    MP.toast(`检测完成，找到 ${MP.state.javaList.length} 个 Java`, 'ok');
  }

  async function installJava() {
    if (!onlineDownloadsEnabled()) {
      MP.toast('在线下载已关闭。请先勾选“在线下载”。', 'warn', 5000);
      return;
    }
    const body = `<p class="muted-sm">选择要安装的 Java 版本。Minecraft 1.17–1.20.4 需要 Java 17；1.20.5 及以上需要 Java 21；1.16.5 及以下通常使用 Java 8。</p>
      <select id="mp-java-major" class="input select" style="width:100%;margin-top:8px">
        <option value="21">Java 21（推荐）</option>
        <option value="17">Java 17</option>
        <option value="8">Java 8</option>
      </select>`;
    const major = await MP.modal({
      title: '安装 Java 运行环境',
      body,
      actions: [
        { label: '取消', value: null },
        {
          label: '开始下载',
          kind: 'primary',
          onClick: (box) => box.querySelector('#mp-java-major').value,
        },
      ],
    });
    if (!major) return;
    const ok = await MP.installJavaFlow(Number(major));
    if (ok) renderJava();
  }

  async function saveUsername() {
    const input = $('#set-username');
    if (!input) return;
    const name = input.value.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
      MP.toast('玩家名需为 3–16 位字母、数字或下划线', 'warn', 4500);
      input.focus();
      return;
    }
    await save({ offlineName: name });
    MP.toast('玩家名已保存', 'ok');
  }

  async function saveCurseforgeKey() {
    const input = $('#set-curseforge-key');
    if (!input) return;
    const key = input.value.trim();
    if (!key) {
      MP.toast('请先粘贴 CurseForge API Key', 'warn');
      input.focus();
      return;
    }
    if (key.length < 20 || key.length > 200 || /\s/.test(key)) {
      MP.toast('这个 Key 看起来不完整，请检查后重试', 'warn', 5000);
      input.focus();
      return;
    }
    const button = $('#btn-save-cf-key');
    if (button) {
      button.disabled = true;
      button.textContent = '保存中…';
    }
    try {
      await save({ curseforgeApiKey: key });
      render();
      MP.toast('CurseForge API Key 已保存，可在「模组」页切换来源', 'ok', 5000);
    } catch (err) {
      MP.toast(`保存 CurseForge API Key 失败：${err.message}`, 'err', 6000);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '保存';
      }
    }
  }

  async function clearCurseforgeKey() {
    const ok = await MP.confirm({
      title: '清除 CurseForge API Key',
      text: '清除后将无法使用 CurseForge 搜索和下载，Modrinth 不受影响。',
      confirmLabel: '清除',
      danger: true,
    });
    if (!ok) return;
    try {
      await save({ curseforgeApiKey: '' });
      render();
      MP.toast('CurseForge API Key 已清除', 'ok');
    } catch (err) {
      MP.toast(`清除 CurseForge API Key 失败：${err.message}`, 'err', 6000);
    }
  }

  function bindRange(input, min, max, onChange, formatter) {
    if (!input) return;
    input.addEventListener('input', () => {
      const value = Number(input.value);
      setRangeFill(input, min, max, value);
      if (formatter) formatter(value);
    });
    input.addEventListener('change', () => onChange(Number(input.value)));
  }

  function init() {
    if (bound) return;
    bound = true;

    MP.on('#btn-browse-game', 'click', browseGameDir);
    MP.on('#btn-open-game', 'click', async () => {
      const result = await MP.api.invoke('game:open-folder', MP.state.selectedVersion || '');
      if (!result.ok) MP.toast(`无法打开目录：${result.error}`, 'err');
    });
    MP.on('#btn-detect-java', 'click', detectJava);
    MP.on('#btn-download-java', 'click', installJava);

    MP.on('#set-java', 'change', (event) => {
      save({ javaPath: event.target.value });
      MP.toast('Java 设置已保存', 'ok');
    });

    bindRange($('#set-memory'), 1024, 16384, (value) => save({ memoryMb: value }), (value) => {
      if ($('#memory-value')) $('#memory-value').textContent = memoryText(value);
    });

    bindRange($('#set-threads'), 1, 24, (value) => save({ downloadThreads: value }), (value) => {
      if ($('#threads-value')) $('#threads-value').textContent = String(value);
    });

    MP.on('#set-width', 'change', (event) => {
      const value = Math.max(640, Math.min(7680, Number(event.target.value) || 1280));
      event.target.value = value;
      save({ width: value });
    });
    MP.on('#set-height', 'change', (event) => {
      const value = Math.max(480, Math.min(4320, Number(event.target.value) || 720));
      event.target.value = value;
      save({ height: value });
    });
    MP.on('#set-fullscreen', 'change', (event) => save({ fullscreen: event.target.checked }));
    MP.on('#set-jvm', 'change', (event) => {
      save({ jvmArgs: event.target.value });
      MP.toast('JVM 参数已保存', 'ok');
    });
    MP.on('#set-autolog', 'change', (event) => save({ autoOpenLog: event.target.checked }));
    MP.on('#set-download-source', 'change', async (event) => {
      const source = event.target.value;
      await save({ downloadSource: source });
      if (MP.views.download) MP.views.download.render();
      const labels = { auto: '自动选择下载源', bmclapi: 'BMCLAPI 镜像优先', official: '官方源优先' };
      MP.toast(labels[source] || '下载源已更新', 'ok');
    });

    MP.on('#set-language', 'change', async (event) => {
      const language = event.target.value === 'en-US' ? 'en-US' : 'zh-CN';
      await save({ language });
      // 重新加载界面，确保静态文案、动态列表和 document.lang 全部切换。
      window.location.reload();
    });

    MP.on('#set-theme', 'change', async (event) => {
      const theme = event.target.value;
      if (MP.applyAppearance) MP.applyAppearance(Object.assign({}, MP.state.settings, { theme }));
      await save({ theme });
      MP.toast(theme === 'light' ? '已切换为浅色主题' : '已切换为深色主题', 'ok');
    });

    MP.on('#set-bg-type', 'change', async (event) => {
      const type = event.target.value;
      await save({ backgroundType: type });
      render();
      if (type === 'image') MP.toast('背景类型已设为图片，请选择一张本机图片', 'warn', 5000);
    });

    MP.on('#set-bg-color', 'input', (event) => {
      if (MP.applyAppearance) {
        MP.applyAppearance(Object.assign({}, MP.state.settings, { backgroundType: 'color', backgroundColor: event.target.value }));
      }
    });
    MP.on('#set-bg-color', 'change', async (event) => {
      await save({ backgroundType: 'color', backgroundColor: event.target.value });
      render();
    });

    MP.on('#bg-file-input', 'change', async (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      try {
        const dataUrl = await MP.chooseBackground(file);
        const result = await MP.api.invoke('theme:set-background', { dataUrl });
        if (!result || result.ok === false) throw new Error((result && result.error) || '保存背景图失败');
        MP.state.backgroundDataUrl = dataUrl;
        await save({ backgroundType: 'image' });
        render();
        MP.toast('自定义背景已应用', 'ok');
      } catch (err) {
        MP.toast(`背景图设置失败：${err.message}`, 'err', 6000);
      } finally {
        event.target.value = '';
      }
    });

    MP.on('#btn-clear-bg', 'click', async () => {
      try {
        await MP.api.invoke('theme:clear-background');
      } catch (err) { /* ignore */ }
      MP.state.backgroundDataUrl = '';
      await save({ backgroundType: 'default' });
      render();
      MP.toast('已恢复默认背景', 'ok');
    });

    MP.on('#set-ui-scale', 'change', async (event) => {
      const scale = Number(event.target.value);
      if (MP.applyAppearance) MP.applyAppearance(Object.assign({}, MP.state.settings, { uiScale: scale }));
      await save({ uiScale: scale });
      MP.toast(`界面缩放已设为 ${Math.round(scale * 100)}%`, 'ok');
    });

    MP.on('#set-animations', 'change', async (event) => {
      if (MP.applyAppearance) MP.applyAppearance(Object.assign({}, MP.state.settings, { animations: event.target.checked }));
      await save({ animations: event.target.checked });
      MP.toast(event.target.checked ? '界面动画已开启' : '界面动画已关闭', 'ok');
    });
    MP.on('#set-assets', 'change', (event) => save({ downloadAssets: event.target.checked }));
    MP.on('#set-online-downloads', 'change', async (event) => {
      const enabled = Boolean(event.target.checked);
      await save({ onlineDownloads: enabled });
      if (MP.views.download && MP.views.download.onOnlineChange) {
        MP.views.download.onOnlineChange(enabled);
      } else if (MP.views.download) {
        MP.views.download.render();
      }
      MP.toast(enabled ? '在线下载已开启' : '在线下载已关闭，仅使用本地文件', enabled ? 'ok' : 'warn', 4500);
    });
    MP.on('#set-isolation', 'change', async (event) => {
      await save({ versionIsolation: event.target.checked }, { refreshVersions: true });
      if (MP.views.home) MP.views.home.refresh();
      MP.toast(event.target.checked ? '已开启版本隔离，每个版本使用独立数据目录' : '已关闭版本隔离，使用全局 mods 与存档', 'ok', 5000);
    });
    MP.on('#btn-save-name', 'click', saveUsername);
    MP.on('#set-username', 'keydown', (event) => {
      if (event.key === 'Enter') saveUsername();
    });
    MP.on('#btn-save-cf-key', 'click', saveCurseforgeKey);
    MP.on('#set-curseforge-key', 'keydown', (event) => {
      if (event.key === 'Enter') saveCurseforgeKey();
    });
    MP.on('#btn-clear-cf-key', 'click', clearCurseforgeKey);
  }

  MP.views.settings = {
    init,
    render,
    renderJava,
    onShow: render,
  };
})();