'use strict';

(function () {
  const { $, $$, esc } = MP;

  const state = {
    loading: false,
    seq: 0,
    saves: [],
    backups: [],
    instance: null,
    savesDir: '',
    backupsDir: '',
  };

  function targetVersion() {
    const select = $('#save-target');
    const id = select ? select.value : MP.state.selectedVersion;
    return (MP.state.versions || []).find((version) => version.id === id) || null;
  }

  function fmtDate(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return '从未';
    try {
      return new Date(value).toLocaleString(MP.i18n && MP.i18n.language === 'en-US' ? 'en-US' : 'zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    } catch (err) {
      return '—';
    }
  }

  function fmtRelative(timestamp) {
    return MP.fmtRelative ? MP.fmtRelative(timestamp) : fmtDate(timestamp);
  }

  function populateTargets() {
    const select = $('#save-target');
    if (!select) return;
    const versions = MP.state.versions || [];
    const previous = select.value || MP.state.selectedVersion || '';
    if (!versions.length) {
      select.innerHTML = '<option value="">还没有安装版本</option>';
      select.disabled = true;
      return;
    }
    select.disabled = false;
    select.innerHTML = versions.map((version) => {
      const loader = Array.isArray(version.loaders) && version.loaders[0] ? version.loaders[0].name : '原版';
      const isolation = version.isolation ? '隔离' : '共享';
      return `<option value="${esc(version.id)}">${esc(version.id)} · MC ${esc(version.mcVersion || '?')} · ${esc(loader)} · ${isolation}</option>`;
    }).join('');
    select.value = versions.some((version) => version.id === previous)
      ? previous
      : (MP.state.selectedVersion || versions[0].id);
  }

  function sharedNote(target) {
    if (!target || target.isolation) return '';
    const count = (MP.state.versions || []).filter((version) => version.gameDir === target.gameDir).length;
    return count > 1 ? `该 saves/ 目录由 ${count} 个未隔离实例共享，操作会影响这些实例。` : '';
  }

  function setBusy(value) {
    ['#btn-save-refresh', '#btn-save-import', '#btn-save-open', '#btn-save-open-backups'].forEach((selector) => {
      const button = $(selector);
      if (button) button.disabled = Boolean(value);
    });
  }

  function renderSummary() {
    const target = targetVersion();
    const title = $('#save-summary-title');
    const text = $('#save-summary-text');
    const size = $('#save-summary-size');
    const chip = $('#save-instance-chip');
    if (!target) {
      if (title) title.textContent = '还没有安装版本';
      if (text) text.textContent = '请先在「下载」页安装一个 Minecraft 版本。';
      if (size) size.textContent = '—';
      if (chip) chip.textContent = '无可用实例';
      return;
    }
    const note = sharedNote(target);
    if (title) title.textContent = `${target.id} 的存档`;
    if (text) {
      text.textContent = `${state.saves.length} 个世界 · ${state.backups.length} 个备份 · ${state.savesDir || 'saves/'}${note ? ` · ${note}` : ''}`;
    }
    if (size) size.textContent = MP.fmtBytes(state.saves.reduce((sum, world) => sum + (world.size || 0), 0));
    if (chip) chip.textContent = `${target.id} · ${state.saves.length} 个存档`;
  }

  function worldBadges(world) {
    const badges = [];
    if (!world.hasLevelDat) badges.push('<span class="save-badge warn">缺少 level.dat</span>');
    if (world.hardcore) badges.push('<span class="save-badge">极限</span>');
    if (world.locked) badges.push('<span class="save-badge">已锁定</span>');
    if (world.gameMode === 1) badges.push('<span class="save-badge">创造</span>');
    return badges.join('');
  }

  function renderSaves() {
    const list = $('#save-list');
    const empty = $('#save-empty');
    const count = $('#save-count');
    if (!list || !empty) return;
    if (count) count.textContent = `${state.saves.length} 个`;
    if (!state.saves.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.innerHTML = state.saves.map((world) => {
      const meta = [
        world.mcVersion ? `MC ${world.mcVersion}` : '',
        `${world.files || 0} 个文件`,
        world.folder,
      ].filter(Boolean);
      return `<div class="save-row" data-save-world="${esc(world.folder)}">
        <div class="save-icon">${esc(String(world.name || world.folder).trim().slice(0, 1).toUpperCase() || 'W')}</div>
        <div class="save-main">
          <div class="save-name">
            <strong>${esc(world.name || world.folder)}</strong>
            ${worldBadges(world)}
          </div>
          <div class="save-meta" title="${esc(world.path || '')}">${esc(meta.join(' · '))}</div>
          <div class="save-meta">最后游玩：${esc(fmtDate(world.lastPlayed))}（${esc(fmtRelative(world.lastPlayed))}）</div>
        </div>
        <div class="save-size">${esc(MP.fmtBytes(world.size || 0))}</div>
        <div class="save-actions">
          <button class="btn small primary" data-save-action="backup" data-world="${esc(world.folder)}">备份</button>
          <button class="btn small ghost" data-save-action="export" data-world="${esc(world.folder)}">导出</button>
          <button class="btn small ghost danger-text" data-save-action="delete" data-world="${esc(world.folder)}">删除</button>
        </div>
      </div>`;
    }).join('');
  }

  function renderBackups() {
    const list = $('#save-backup-list');
    const empty = $('#save-backup-empty');
    const count = $('#save-backup-count');
    const dir = $('#save-backups-dir');
    if (count) count.textContent = `${state.backups.length} 个`;
    if (dir) dir.textContent = state.backupsDir ? `保存在 ${state.backupsDir}` : '备份保存在实例目录的 backups/';
    if (!list || !empty) return;
    if (!state.backups.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.innerHTML = state.backups.map((backup) => `
      <div class="save-backup-row">
        <div class="save-backup-main">
          <strong>${esc(backup.name || backup.world || backup.file)}</strong>
          <span>${esc(backup.file)} · ${esc(backup.mcVersion || '未知版本')} · ${esc(fmtDate(backup.createdAt))} · ${esc(MP.fmtBytes(backup.size || 0))}</span>
        </div>
        <button class="btn small ghost" data-restore-backup="${esc(backup.file)}">恢复</button>
      </div>
    `).join('');
  }

  function renderError(result) {
    const message = (result && result.error) || '读取存档失败';
    state.saves = [];
    state.backups = [];
    renderSaves();
    renderBackups();
    renderSummary();
    const empty = $('#save-empty');
    if (empty) {
      empty.classList.remove('hidden');
      const title = empty.querySelector('strong');
      const text = empty.querySelector('span');
      if (title) title.textContent = '无法读取存档';
      if (text) text.textContent = message;
    }
    MP.toast(`读取存档失败：${message}`, 'err', 6000);
  }

  async function load(options = {}) {
    populateTargets();
    const target = targetVersion();
    if (!target) {
      state.saves = [];
      state.backups = [];
      state.instance = null;
      renderSummary();
      renderSaves();
      renderBackups();
      return;
    }
    if (state.loading && !options.silent) return;
    const seq = ++state.seq;
    state.loading = true;
    setBusy(true);
    const summary = $('#save-summary-text');
    if (summary) summary.textContent = '正在读取存档与备份…';
    try {
      const [savesResult, backupsResult] = await Promise.all([
        MP.api.invoke('saves:list', { targetVersionId: target.id }),
        MP.api.invoke('saves:backups', { targetVersionId: target.id }),
      ]);
      if (seq !== state.seq) return;
      if (!savesResult || !savesResult.ok) {
        renderError(savesResult);
        return;
      }
      state.saves = Array.isArray(savesResult.saves) ? savesResult.saves : [];
      state.savesDir = savesResult.savesDir || '';
      state.instance = savesResult.instance || null;
      state.backups = backupsResult && backupsResult.ok && Array.isArray(backupsResult.backups)
        ? backupsResult.backups
        : [];
      state.backupsDir = (backupsResult && backupsResult.backupsDir) || savesResult.backupsDir || '';
      renderSummary();
      renderSaves();
      renderBackups();
    } catch (err) {
      if (seq === state.seq) renderError({ ok: false, error: err.message });
    } finally {
      if (seq === state.seq) {
        state.loading = false;
        setBusy(false);
      }
    }
  }

  function downloadBase64(base64, fileName) {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName || 'world.zip';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function backupWorld(world) {
    const target = targetVersion();
    if (!target) return;
    const row = $(`[data-save-world="${CSS.escape(world)}"]`);
    row?.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try {
      const result = await MP.api.invoke('saves:backup', { targetVersionId: target.id, world });
      if (!result || !result.ok) {
        MP.toast(`备份失败：${(result && result.error) || '未知错误'}`, 'err', 6000);
        return;
      }
      MP.toast(`已备份「${result.backup && result.backup.name ? result.backup.name : world}」`, 'ok', 3500);
      await load({ silent: true });
    } catch (err) {
      MP.toast(`备份失败：${err.message}`, 'err', 6000);
    } finally {
      row?.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    }
  }

  async function exportWorld(world) {
    const target = targetVersion();
    if (!target) return;
    try {
      const result = await MP.api.invoke('saves:export', { targetVersionId: target.id, world });
      if (!result || !result.ok) {
        if (result && result.canceled) return;
        MP.toast(`导出失败：${(result && result.error) || '未知错误'}`, 'err', 6000);
        return;
      }
      if (result.downloadBase64) {
        downloadBase64(result.downloadBase64, result.fileName || `${world}.zip`);
        MP.toast('存档压缩包已开始下载', 'ok');
      } else if (result.path) {
        MP.toast(`已导出：${result.fileName || result.path}`, 'ok', 6000);
        MP.openPath(result.path.replace(/[\\/][^\\/]+$/, ''), '导出目录');
      }
    } catch (err) {
      MP.toast(`导出失败：${err.message}`, 'err', 6000);
    }
  }

  async function deleteWorld(world) {
    const target = targetVersion();
    if (!target) return;
    const info = state.saves.find((item) => item.folder === world);
    const choice = await MP.modal({
      title: '删除存档',
      width: 480,
      body: `<p>确定删除 <strong>${esc(info ? info.name : world)}</strong>？</p>
        <p class="muted-sm">删除后无法从回收站恢复。建议保留下面的备份选项。</p>
        <label class="save-check"><input type="checkbox" id="mp-save-backup-before" checked> 删除前先创建一个备份到 backups/</label>`,
      actions: [
        { label: '取消', value: null },
        {
          label: '删除',
          kind: 'danger',
          onClick: (box) => ({ backup: Boolean(box.querySelector('#mp-save-backup-before')?.checked) }),
        },
      ],
    });
    if (!choice) return;
    try {
      const result = await MP.api.invoke('saves:delete', {
        targetVersionId: target.id,
        world,
        backup: choice.backup !== false,
      });
      if (!result || !result.ok) {
        MP.toast(`删除失败：${(result && result.error) || '未知错误'}`, 'err', 6000);
        return;
      }
      MP.toast(result.backup ? '存档已删除，备份已保留' : '存档已删除', 'ok', 4000);
      await load({ silent: true });
    } catch (err) {
      MP.toast(`删除失败：${err.message}`, 'err', 6000);
    }
  }

  async function restoreBackup(file) {
    const target = targetVersion();
    if (!target) return;
    const backup = state.backups.find((item) => item.file === file);
    if (!backup) return;
    const exists = state.saves.some((world) => world.folder === backup.world);
    const choice = await MP.modal({
      title: '恢复存档备份',
      width: 500,
      body: `<p>将 <strong>${esc(backup.name || backup.world)}</strong> 恢复到当前实例的 saves/。</p>
        <p class="muted-sm">备份文件：${esc(backup.file)}<br>创建时间：${esc(fmtDate(backup.createdAt))}</p>
        ${exists ? `<p class="save-warn">当前已有同名世界，恢复会覆盖它。建议先给现有世界创建一个备份。</p>` : ''}`,
      actions: [
        { label: '取消', value: null },
        { label: exists ? '覆盖并恢复' : '恢复', kind: exists ? 'danger' : 'primary', value: true },
      ],
    });
    if (!choice) return;
    try {
      const result = await MP.api.invoke('saves:restore', {
        targetVersionId: target.id,
        file,
        overwrite: exists,
      });
      if (!result || !result.ok) {
        MP.toast(`恢复失败：${(result && result.error) || '未知错误'}`, 'err', 6000);
        return;
      }
      MP.toast(`已恢复「${result.folder || backup.world}」`, 'ok', 4000);
      await load({ silent: true });
    } catch (err) {
      MP.toast(`恢复失败：${err.message}`, 'err', 6000);
    }
  }

  function pickSaveZip() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip,application/zip';
      input.style.display = 'none';
      document.body.appendChild(input);
      const finish = (value) => {
        try { input.remove(); } catch (err) { /* ignore */ }
        resolve(value);
      };
      input.addEventListener('cancel', () => finish(null), { once: true });
      input.addEventListener('change', () => finish(input.files && input.files[0] ? input.files[0] : null), { once: true });
      input.click();
    });
  }

  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^;]+;base64,/, ''));
      reader.readAsDataURL(file);
    });
  }

  async function importWorld() {
    const target = targetVersion();
    if (!target) {
      MP.toast('请先选择实例', 'warn');
      return;
    }
    try {
      const payload = { targetVersionId: target.id };
      // 浏览器版没有原生文件对话框，用 <input type=file> 读取 ZIP 后交给本地服务。
      if (!window.mp || !window.mp.native) {
        const file = await pickSaveZip();
        if (!file) return;
        if (file.size > 1024 * 1024 * 1024) {
          MP.toast('浏览器版导入上限约 1 GB，请使用桌面版导入更大的存档', 'warn', 6500);
          return;
        }
        MP.toast('正在读取存档压缩包…', 'info', 2500);
        payload.dataBase64 = await readBase64(file);
        payload.fileName = file.name;
      }
      const result = await MP.api.invoke('saves:import', payload);
      if (!result || !result.ok) {
        if (result && result.canceled) return;
        if (result && result.code === 'SAVE_EXISTS') {
          MP.toast('同名世界已存在，请先删除或改名后再导入', 'warn', 6500);
          return;
        }
        MP.toast(`导入失败：${(result && result.error) || '未知错误'}`, 'err', 6500);
        return;
      }
      MP.toast(`已导入「${result.folder || '存档'}」`, 'ok', 4000);
      await load({ silent: true });
    } catch (err) {
      MP.toast(`导入失败：${err.message}`, 'err', 6500);
    }
  }

  async function openFolder(backups) {
    const target = targetVersion();
    if (!target) return;
    const result = await MP.api.invoke('saves:open-folder', {
      targetVersionId: target.id,
      backups: Boolean(backups),
    });
    if (result && result.ok === false) MP.toast(result.error || '无法打开目录', 'err', 5000);
  }

  function onListClick(event) {
    const action = event.target.closest('[data-save-action]');
    if (!action) return;
    const world = action.dataset.world || '';
    if (action.dataset.saveAction === 'backup') backupWorld(world);
    if (action.dataset.saveAction === 'export') exportWorld(world);
    if (action.dataset.saveAction === 'delete') deleteWorld(world);
  }

  function init() {
    populateTargets();
    MP.on('#save-target', 'change', () => {
      const target = targetVersion();
      if (target) MP.selectVersion(target.id);
      load();
    });
    MP.on('#btn-save-refresh', 'click', () => load());
    MP.on('#btn-save-import', 'click', importWorld);
    MP.on('#btn-save-open', 'click', () => openFolder(false));
    MP.on('#btn-save-open-backups', 'click', () => openFolder(true));
    MP.on('#save-list', 'click', onListClick);
    MP.on('#save-backup-list', 'click', (event) => {
      const button = event.target.closest('[data-restore-backup]');
      if (button) restoreBackup(button.dataset.restoreBackup || '');
    });
  }

  MP.views.saves = {
    init,
    onShow: () => load(),
    onVersionsChanged: () => {
      populateTargets();
      load({ silent: true });
    },
  };
})();