'use strict';

(function () {
  const { $, esc } = MP;
  let bound = false;
  let saving = null;
  let cleanerBusy = false;
  let cleanerTimer = null;
  let cleanerStats = null;
  let removeBusy = false;

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
    if (value < 1024) return `${value} MB`;
    return value % 1024 === 0 ? `${value / 1024} GB` : `${(value / 1024).toFixed(1)} GB`;
  }

  function renderMemory(settings) {
    const auto = settings.memoryAuto !== false;
    const recommended = Number(settings.recommendedMemoryMb) || Number(settings.memoryMb) || 0;
    const value = auto ? recommended : Number(settings.memoryMb) || recommended;
    const slider = $('#set-memory');
    const autoSwitch = $('#set-memory-auto');
    const optimizeSwitch = $('#set-memory-optimize');
    const totalHint = $('#memory-total-hint');

    if (autoSwitch) autoSwitch.checked = auto;
    if (optimizeSwitch) optimizeSwitch.checked = settings.memoryOptimize !== false;
    if (slider) {
      slider.disabled = auto;
      slider.value = value;
      setRangeFill(slider, 1024, 16384, value);
    }
    if ($('#memory-value')) {
      $('#memory-value').textContent = `${auto ? '自动' : '手动'} · ${memoryText(value)}`;
    }
    if ($('#memory-auto-hint')) {
      $('#memory-auto-hint').textContent = auto ? '由启动器自动选择合适的值' : '使用下方手动设置的值';
    }
    if (totalHint) {
      totalHint.textContent = `系统内存 ${memoryText(settings.totalMemoryMb)} · 推荐 ${memoryText(recommended)}`;
    }
    if ($('#memory-optimize-hint')) {
      $('#memory-optimize-hint').textContent = settings.memoryOptimize !== false
        ? '已开启，适用于 Java 8 及以上'
        : '已关闭，使用游戏默认 GC';
    }
  }

  function percentText(value) {
    const percent = Number(value);
    return `${Number.isFinite(percent) ? Math.round(percent) : 0}%`;
  }

  function renderCleaner(stats) {
    if (!stats) return;
    const percent = Math.max(0, Math.min(100, Number(stats.percent) || 0));
    const number = $('#cleaner-percent');
    const fill = $('#cleaner-fill');
    const detail = $('#cleaner-detail');
    const headText = $('#settings-memory-text');
    const headDot = $('#settings-memory-dot');
    const buttons = [$('#btn-clean-memory'), $('#btn-clean-memory-top')].filter(Boolean);

    if (number) {
      number.textContent = percentText(percent);
      number.classList.toggle('high', percent >= 80);
    }
    if (fill) {
      fill.style.width = `${percent}%`;
      fill.classList.toggle('high', percent >= 80);
    }
    if (detail) {
      detail.textContent = stats.supported === false
        ? '当前系统不支持内存清理'
        : `已用 ${memoryText(stats.usedMb)} / ${memoryText(stats.totalMb)}`;
    }
    if (headText) headText.textContent = stats.supported === false ? '仅 Windows 可用' : `内存 ${percentText(percent)}`;
    if (headDot) headDot.className = `status-dot${stats.supported === false ? ' off' : percent >= 80 ? ' warn' : ''}`;
    for (const button of buttons) {
      button.disabled = cleanerBusy || stats.supported === false;
      button.title = stats.supported === false ? '仅 Windows 支持内存清理' : '';
    }
  }

  async function refreshCleaner() {
    if (cleanerBusy) return;
    try {
      const stats = await MP.api.invoke('memory:stats');
      if (!stats) return;
      cleanerStats = stats;
      renderCleaner(stats);
    } catch (err) {
      const detail = $('#cleaner-detail');
      if (detail) detail.textContent = '无法读取系统内存信息';
    }
  }

  function startCleanerPolling() {
    stopCleanerPolling();
    refreshCleaner();
    cleanerTimer = setInterval(refreshCleaner, 8000);
  }

  function stopCleanerPolling() {
    if (cleanerTimer) clearInterval(cleanerTimer);
    cleanerTimer = null;
  }

  function showCleanerResult(text, kind) {
    const result = $('#cleaner-result');
    if (!result) return;
    result.textContent = text;
    result.className = `memory-cleaner-result${kind ? ` ${kind}` : ''}`;
  }

  async function cleanMemory() {
    if (cleanerBusy || !cleanerStats || cleanerStats.supported === false) return;
    cleanerBusy = true;
    const buttons = [$('#btn-clean-memory'), $('#btn-clean-memory-top')].filter(Boolean);
    for (const item of buttons) {
      item.disabled = true;
      item.textContent = '正在清理…';
    }
    showCleanerResult('正在整理其他程序的内存工作集；如需深度清理，请在系统弹窗中允许管理员权限…', 'busy');
    try {
      const result = await MP.api.invoke('memory:clean');
      if (!result || result.ok === false) throw new Error((result && result.error) || '内存清理失败');
      cleanerStats = result.after;
      renderCleaner(result.after);
      const freed = Number(result.freedMb) || 0;
      const beforePercent = Number(result.before && result.before.percent) || 0;
      const afterPercent = Number(result.after && result.after.percent) || 0;
      const trimmed = Number(result.trimmed) || 0;
      const deep = result.deep === true;
      const needsAdmin = result.needsAdmin === true;
      if (deep) {
        if (freed > 0) {
          showCleanerResult(
            `已深度清理 ${trimmed} 个进程，释放约 ${memoryText(freed)}（${percentText(beforePercent)} → ${percentText(afterPercent)}）。`,
          );
          MP.toast(`已深度释放约 ${memoryText(freed)} 内存`, 'ok');
        } else {
          showCleanerResult(`已深度清理 ${trimmed} 个进程；系统占用变化不明显，部分内存可能已被重新载入。`);
          MP.toast('深度内存清理完成，占用变化不明显', 'ok');
        }
      } else if (needsAdmin) {
        if (freed > 0) {
          showCleanerResult(
            `已清理 ${trimmed} 个进程，释放约 ${memoryText(freed)}（${percentText(beforePercent)} → ${percentText(afterPercent)}）；深度清理需要管理员权限。`,
          );
          MP.toast(`基础清理已释放约 ${memoryText(freed)} 内存`, 'ok');
        } else {
          showCleanerResult(`已清理 ${trimmed} 个进程；深度清理需要管理员权限，本次仅完成基础清理。`);
          MP.toast('深度清理需要管理员权限', 'ok');
        }
      } else if (freed > 0) {
        showCleanerResult(
          `已清理 ${trimmed} 个进程，释放约 ${memoryText(freed)}（${percentText(beforePercent)} → ${percentText(afterPercent)}）。`,
        );
        MP.toast(`已释放约 ${memoryText(freed)} 内存`, 'ok');
      } else {
        showCleanerResult(`已清理 ${trimmed} 个进程；系统占用变化不明显，部分内存可能已被重新载入。`);
        MP.toast('内存清理完成，占用变化不明显', 'ok');
      }
    } catch (err) {
      showCleanerResult('内存清理失败，请稍后重试。', 'error');
      MP.toast('内存清理失败，请稍后重试', 'err', 5000);
    } finally {
      cleanerBusy = false;
      for (const item of buttons) {
        item.textContent = '清理内存';
        item.disabled = Boolean(cleanerStats && cleanerStats.supported === false);
      }
    }
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
    renderJavaList();
    renderJavaOverrides();
  }

  function renderJavaList() {
    const root = $('#java-list');
    if (!root) return;
    const list = MP.state.javaList || [];
    const settings = MP.state.settings || {};
    const current = settings.javaPath || '';
    const count = $('#java-count');
    if (count) count.textContent = list.length ? `${list.length} 个` : '未检测到';
    if (!list.length) {
      root.innerHTML = '<p class="muted-sm java-empty">没有检测到 Java。点击上方“安装 Java”，或手动添加 java.exe / java 路径。</p>';
      return;
    }
    root.innerHTML = list.map((item) => {
      const isDefault = current && item.path === current;
      return `<div class="java-item ${isDefault ? 'is-default' : ''}">
        <div class="java-item-main">
          <div class="java-item-title">
            <strong>Java ${esc(item.major)}</strong>
            <span class="badge gray">${esc(item.vendor || '未知发行版')}</span>
            ${item.bits ? `<span class="badge gray">${esc(item.bits)} 位</span>` : ''}
            ${isDefault ? '<span class="badge green">默认</span>' : ''}
            ${item.source === 'manual' ? '<span class="badge violet">手动添加</span>' : ''}
          </div>
          <div class="java-item-meta">${esc(item.version || '—')} · ${esc(item.major)} · ${esc(item.arch || '未知架构')}</div>
          <div class="java-item-path" title="${esc(item.path)}">${esc(item.path)}</div>
        </div>
        <div class="java-item-actions">
          ${isDefault ? '' : `<button class="btn small ghost" data-java-default="${esc(item.path)}">设为默认</button>`}
          <button class="btn small ghost danger-text" data-java-remove="${esc(item.path)}">隐藏</button>
        </div>
      </div>`;
    }).join('');
  }

  function renderJavaOverrides() {
    const root = $('#java-overrides');
    if (!root) return;
    const versions = MP.state.versions || [];
    const list = MP.state.javaList || [];
    const settings = MP.state.settings || {};
    const overrides = settings.javaVersionOverrides || {};
    if (!versions.length) {
      root.innerHTML = '<p class="muted-sm java-empty">还没有安装游戏版本。安装后会在这里按版本指定 Java。</p>';
      return;
    }
    root.innerHTML = versions.map((version) => {
      const selected = overrides[version.id] || '';
      const options = ['<option value="">自动匹配</option>'].concat(list.map((item) => (
        `<option value="${esc(item.path)}"${item.path === selected ? ' selected' : ''}>Java ${esc(item.major)} · ${esc(item.vendor)}${item.bits ? ` · ${item.bits} 位` : ''}</option>`
      ))).join('');
      return `<div class="java-override-row">
        <div class="java-override-label">
          <strong>${esc(version.id)}</strong>
          <span>MC ${esc(version.mcVersion || '?')} · ${esc(Array.isArray(version.loaders) && version.loaders[0] ? version.loaders[0].name : '原版')}</span>
        </div>
        <select class="input select" data-java-override="${esc(version.id)}">${options}</select>
      </div>`;
    }).join('');
  }

  async function saveJavaOverride(versionId, javaPath) {
    const current = (MP.state.settings && MP.state.settings.javaVersionOverrides) || {};
    const next = Object.assign({}, current);
    if (javaPath) next[versionId] = javaPath;
    else delete next[versionId];
    await save({ javaVersionOverrides: next });
    MP.toast(javaPath ? `已为 ${versionId} 指定 Java` : `已恢复 ${versionId} 的自动匹配`, 'ok');
  }

  async function setDefaultJava(javaPath) {
    if (!javaPath) return;
    await save({ javaPath });
    renderJava();
    MP.toast('默认 Java 已更新', 'ok');
  }

  async function hideJava(javaPath) {
    if (!javaPath) return;
    const item = (MP.state.javaList || []).find((entry) => entry.path === javaPath);
    const ok = await MP.confirm({
      title: '从列表隐藏 Java',
      text: `只会从 MinePilot 的 Java 列表中隐藏${item ? ` Java ${item.major}（${item.vendor}）` : '这个 Java'}，不会删除磁盘文件。之后可以通过“重新检测”或手动添加恢复。`,
      confirmLabel: '隐藏',
      danger: true,
    });
    if (!ok) return;
    const result = await MP.api.invoke('java:remove-path', { path: javaPath });
    if (!result || !result.ok) {
      MP.toast(`隐藏失败：${(result && result.error) || '未知错误'}`, 'err', 5000);
      return;
    }
    MP.state.javaList = result.list || [];
    try {
      const fresh = await MP.api.invoke('settings:get');
      if (fresh && typeof fresh === 'object') MP.state.settings = fresh;
    } catch (err) { /* 用本地状态兜底 */ }
    renderJava();
    MP.toast(result.message || '已隐藏', 'ok');
  }

  async function addJava() {
    const payload = {};
    if (!window.mp || !window.mp.native) {
      const value = await MP.prompt({
        title: '添加 Java',
        label: '输入 java.exe / java 的完整路径，或 Java 安装目录。浏览器版无法打开原生文件选择器。',
        placeholder: '例如 C:\\Program Files\\Java\\jdk-21\\bin\\java.exe',
        confirmLabel: '添加',
        maxlength: 500,
      });
      if (!value) return;
      payload.path = value;
    }
    const result = await MP.api.invoke('java:add-path', payload);
    if (!result || !result.ok) {
      if (result && result.canceled) return;
      MP.toast(`添加失败：${(result && result.error) || '未知错误'}`, 'err', 5500);
      return;
    }
    MP.state.javaList = result.list || [];
    if (MP.state.settings && result.java) {
      MP.state.settings.javaPath = result.java.path;
      MP.state.settings.javaExtraPaths = Array.from(new Set([...(MP.state.settings.javaExtraPaths || []), result.java.path]));
    }
    renderJava();
    MP.toast(result.message || '已添加 Java', 'ok', 4500);
  }

  async function openJavaDir() {
    const result = await MP.api.invoke('java:open-folder');
    if (result && result.ok === false) MP.toast(result.error || '无法打开 Java 目录', 'err', 5000);
  }

  function render() {
    const settings = MP.state.settings;
    if (!settings) return;

    if ($('#set-gamedir')) {
      $('#set-gamedir').value = settings.gameDir;
      $('#set-gamedir').title = settings.gameDir;
    }
    renderMemory(settings);

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
    const body = `<p class="muted-sm">选择要安装的 Java 版本和发行版。Minecraft 1.17–1.20.4 需要 Java 17；1.20.5 及以上需要 Java 21；1.16.5 及以下通常使用 Java 8。</p>
      <div class="java-install-grid">
        <select id="mp-java-major" class="input select">
          <option value="21">Java 21（推荐）</option>
          <option value="17">Java 17</option>
          <option value="11">Java 11</option>
          <option value="8">Java 8</option>
        </select>
        <select id="mp-java-vendor" class="input select">
          <option value="temurin">Eclipse Temurin（Adoptium）</option>
          <option value="zulu">Azul Zulu</option>
          <option value="corretto">Amazon Corretto</option>
        </select>
      </div>
      <p class="muted-sm" style="margin-top:8px">下载失败时会提示切换发行版；所有安装包都会校验 SHA256。</p>`;
    const chosen = await MP.modal({
      title: '安装 Java 运行环境',
      width: 520,
      body,
      actions: [
        { label: '取消', value: null },
        {
          label: '开始下载',
          kind: 'primary',
          onClick: (box) => ({
            major: box.querySelector('#mp-java-major').value,
            vendor: box.querySelector('#mp-java-vendor').value,
          }),
        },
      ],
    });
    if (!chosen) return;
    const ok = await MP.installJavaFlow(Number(chosen.major), chosen.vendor);
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

  async function removeLauncher() {
    if (removeBusy) return;
    if (!window.mp || !window.mp.native) {
      MP.toast('仅桌面版支持删除启动器', 'warn', 4000);
      return;
    }

    const confirmed = await MP.modal({
      title: '删除启动器',
      width: 460,
      body: `<p>将强制关闭 MinePilot，并删除启动器程序、桌面和开始菜单快捷方式以及卸载登记。</p>
        <p class="muted-sm">设置、账户、缓存、皮肤和 Minecraft 游戏存档会保留。</p>
        <p class="muted-sm">此操作不可撤销；删除后需要重新下载安装包才能再次使用 MinePilot。</p>`,
      actions: [
        { label: '取消', value: false },
        { label: '删除启动器', kind: 'danger', value: true },
      ],
    });
    if (confirmed !== true) return;

    removeBusy = true;
    const button = $('#btn-remove-launcher');
    if (button) {
      button.disabled = true;
      button.textContent = '正在删除…';
    }
    try {
      const result = await MP.api.invoke('app:remove');
      if (!result || !result.ok) throw new Error((result && result.error) || '删除启动器失败');
      MP.toast('正在删除启动器，窗口即将关闭', 'warn', 4000);
    } catch (err) {
      removeBusy = false;
      if (button) {
        button.disabled = false;
        button.textContent = '删除启动器';
      }
      MP.toast(`删除启动器失败：${err.message}`, 'err', 8000);
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
    MP.on('#btn-java-add', 'click', addJava);
    MP.on('#btn-java-open', 'click', openJavaDir);
    MP.on('#java-list', 'click', (event) => {
      const setButton = event.target.closest('[data-java-default]');
      if (setButton) {
        setDefaultJava(setButton.dataset.javaDefault || '');
        return;
      }
      const removeButton = event.target.closest('[data-java-remove]');
      if (removeButton) hideJava(removeButton.dataset.javaRemove || '');
    });
    MP.on('#java-overrides', 'change', (event) => {
      const select = event.target.closest('[data-java-override]');
      if (select) saveJavaOverride(select.dataset.javaOverride || '', select.value);
    });
    MP.on('#btn-clean-memory', 'click', cleanMemory);
    MP.on('#btn-clean-memory-top', 'click', cleanMemory);
    MP.on('#btn-remove-launcher', 'click', removeLauncher);

    const canRemove = Boolean(window.mp && window.mp.native && MP.state.info && MP.state.info.platform === 'win32');
    if (!canRemove && $('#remove-card')) $('#remove-card').classList.add('hidden');

    MP.on('#set-java', 'change', (event) => {
      save({ javaPath: event.target.value });
      MP.toast('Java 设置已保存', 'ok');
    });

    MP.on('#set-memory-auto', 'change', async (event) => {
      const auto = event.target.checked;
      const recommended = Number(MP.state.settings.recommendedMemoryMb)
        || Number(MP.state.settings.memoryMb)
        || 4096;
      await save(auto ? { memoryAuto: true } : { memoryAuto: false, memoryMb: recommended });
      render();
      MP.toast(auto ? '已启用自动内存分配' : '已改用手动内存分配', 'ok');
    });

    bindRange($('#set-memory'), 1024, 16384, (value) => {
      save({ memoryAuto: false, memoryMb: value }).then(render);
    }, (value) => {
      if ($('#memory-value')) $('#memory-value').textContent = `手动 · ${memoryText(value)}`;
    });

    MP.on('#set-memory-optimize', 'change', async (event) => {
      const enabled = event.target.checked;
      await save({ memoryOptimize: enabled });
      render();
      MP.toast(enabled ? '已启用 GC 调优' : '已关闭 GC 调优', 'ok');
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
    onShow: () => {
      render();
      startCleanerPolling();
    },
    onLeave: stopCleanerPolling,
  };
})();