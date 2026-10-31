'use strict';

(function () {
  const { $, $$, esc } = MP;
  let bound = false;

  const LOADER_COLORS = {
    fabric: ['#f0a13a', '#a65b12'],
    forge: ['#8b6cf0', '#4c2fa8'],
    neoforge: ['#3ecf8e', '#14764c'],
    quilt: ['#ef6ba8', '#8d1f56'],
    optifine: ['#ef6a6a', '#8c1f1f'],
    liteloader: ['#4bb3d4', '#155e75'],
  };

  function findVersion(id) {
    return MP.state.versions.find((version) => version.id === id) || null;
  }

  function loaderText(version) {
    if (!version || !version.loaders.length) return '原版';
    return version.loaders.map((loader) => `${loader.name}${loader.version ? ` ${loader.version}` : ''}`).join(' + ');
  }

  function memoryText(mb) {
    const value = Number(mb) || 0;
    return value % 1024 === 0 ? `${value / 1024} GB` : `${(value / 1024).toFixed(1)} GB`;
  }

  function memoryOf(settings) {
    if (!settings) return 0;
    return settings.memoryAuto !== false
      ? Number(settings.recommendedMemoryMb) || Number(settings.memoryMb) || 0
      : Number(settings.memoryMb) || 0;
  }

  function setHint(text, isError) {
    const hint = $('#launch-hint');
    if (!hint) return;
    hint.textContent = text || '';
    hint.classList.toggle('error', Boolean(isError));
  }

  function renderLaunchButton(version) {
    const button = $('#btn-launch');
    const main = $('#btn-launch .launch-main');
    const sub = $('#launch-sub');
    if (!button || !main || !sub) return;

    button.disabled = false;

    if (!version) {
      main.textContent = '安装游戏';
      sub.textContent = '还没有安装版本';
      if (MP.state.installing) {
        main.textContent = '正在安装…';
        sub.textContent = MP.state.installingVersion || '';
      }
      return;
    }

    if (MP.state.launchBusy) {
      main.textContent = '正在启动…';
      sub.textContent = '正在检查运行环境';
      button.disabled = true;
      return;
    }

    if (MP.state.installing) {
      main.textContent = '正在安装…';
      sub.textContent = MP.state.installingVersion || '';
      button.disabled = true;
      return;
    }

    if (MP.state.launching) {
      main.textContent = '游戏运行中';
      sub.textContent = '点击查看启动日志';
      return;
    }

    const needsRepair = Boolean(version.incomplete);
    main.textContent = needsRepair ? '启动游戏（自动修复）' : '启动游戏';
    const bestJava = MP.bestJava(version.requiredJava);
    const javaLabel = bestJava
      ? `Java ${bestJava.major}`
      : `需要 Java ${version.requiredJava}`;
    sub.textContent = `${javaLabel} · ${memoryText(memoryOf(MP.state.settings))} 内存${needsRepair ? ' · 启动前补全文件' : ''}`;
  }

  function renderSelect() {
    const select = $('#version-select');
    if (!select) return;
    const versions = MP.state.versions;

    if (!versions.length) {
      select.innerHTML = '<option value="">暂无已安装版本</option>';
      select.disabled = true;
      return;
    }

    select.disabled = Boolean(MP.state.launching || MP.state.launchBusy);
    select.innerHTML = versions.map((version) => {
      const suffix = version.loaders.length ? ` · ${version.loaders.map((loader) => loader.name).join(' + ')}` : '';
      return `<option value="${esc(version.id)}">${esc(version.id)}${esc(suffix)}</option>`;
    }).join('');

    if (versions.some((version) => version.id === MP.state.selectedVersion)) {
      select.value = MP.state.selectedVersion;
    }
  }

  function renderJavaStatus(version) {
    const need = version ? version.requiredJava : 8;
    const best = MP.state.javaList[0];
    const chipText = $('#chip-java-text');
    const chipDot = $('#chip-java .status-dot');
    const sideText = $('#java-stat-text');
    const sideDot = $('#java-stat .status-dot');

    if (chipText && chipDot) {
      if (!MP.state.javaList.length) {
        chipText.textContent = '未检测到 Java';
        chipDot.className = 'status-dot warn';
      } else if (best.major >= need) {
        chipText.textContent = `Java ${best.major} 就绪`;
        chipDot.className = 'status-dot';
      } else {
        chipText.textContent = `需要 Java ${need}`;
        chipDot.className = 'status-dot warn';
      }
    }

    if (sideText && sideDot) {
      if (!MP.state.javaList.length) {
        sideText.textContent = '未检测到 Java';
        sideDot.className = 'status-dot warn';
      } else {
        sideText.textContent = `Java ${best.major} · ${best.vendor}`;
        sideDot.className = 'status-dot';
      }
    }
  }

  function refresh() {
    const settings = MP.state.settings;
    if (!settings) return;

    const name = MP.accountName ? MP.accountName() : (settings.offlineName || 'Steve');
    if ($('#greeting')) $('#greeting').textContent = MP.greeting();
    if ($('#head-name')) $('#head-name').textContent = name;
    if ($('#side-name')) $('#side-name').textContent = name;
    if ($('#account-name')) $('#account-name').textContent = name;
    if ($('#side-mode')) $('#side-mode').textContent = MP.accountModeText ? MP.accountModeText() : '离线账户';
    if ($('#account-mode')) $('#account-mode').textContent = MP.accountModeText ? MP.accountModeText() : '离线账户 · 仅本地';
    const msMode = MP.state.account && MP.state.account.mode === 'microsoft'
      && MP.state.account.microsoft && MP.state.account.microsoft.authenticated;
    if ($('#side-mode-dot')) $('#side-mode-dot').className = `status-dot${msMode ? '' : ' warn'}`;
    if ($('#account-mode-dot')) $('#account-mode-dot').className = `status-dot${msMode ? '' : ' warn'}`;
    MP.setAvatar($('#side-avatar'), name);
    MP.setAvatar($('#home-avatar'), name);

    if ($('#chip-mem-text')) $('#chip-mem-text').textContent = `分配内存 ${memoryText(memoryOf(settings))}`;
    const selected = findVersion(MP.state.selectedVersion);
    const shownGameDir = selected && selected.gameDir ? selected.gameDir : settings.gameDir;
    if ($('#stat-path')) {
      $('#stat-path').textContent = shownGameDir;
      $('#stat-path').title = shownGameDir;
    }
    if ($('#stat-versions')) $('#stat-versions').textContent = String(MP.state.versions.length);

    renderSelect();

    const version = findVersion(MP.state.selectedVersion);
    renderLaunchButton(version);
    renderJavaStatus(version);

    if ($('#stat-mods')) {
      $('#stat-mods').textContent = String(version && version.mods ? version.mods.count : 0);
    }
    if ($('#quick-mods')) {
      const scope = version && version.isolation ? '版本隔离' : '全局';
      $('#quick-mods').textContent = version && version.mods && version.mods.count
        ? `${scope}共 ${version.mods.count} 个模组`
        : '管理模组';
    }

    const meta = $('#hero-meta');
    if (meta) {
      if (!version) {
        meta.textContent = MP.state.versionsError
          ? `读取版本失败：${MP.state.versionsError}`
          : '还没有安装任何版本，去下载页安装一个吧';
      } else {
        const scope = version.isolation ? '版本隔离' : '全局';
        const parts = [
          `Minecraft ${version.mcVersion}`,
          loaderText(version),
          `${version.mods ? version.mods.count : 0} 个 Mod（${scope}）`,
          version.lastPlayed ? `上次游玩 ${MP.fmtRelative(version.lastPlayed)}` : '从未启动',
        ];
        meta.textContent = parts.join('  ·  ');
      }
    }

    if ($('#version-select') && version) {
      $('#version-select').value = version.id;
    }
  }

  async function editAccount() {
    if (MP.openAccount) {
      MP.openAccount();
      return;
    }
    const current = (MP.state.settings && MP.state.settings.offlineName) || 'Steve';
    const name = await MP.prompt({
      title: '修改离线玩家名',
      label: '玩家名用于生成离线 UUID，仅支持字母、数字和下划线。',
      value: current,
      maxlength: 16,
      placeholder: 'Steve',
      validate: (value) => (/^[A-Za-z0-9_]{3,16}$/.test(value) ? '' : '请输入 3–16 位字母、数字或下划线'),
    });
    if (!name || name === current) return;
    const settings = await MP.api.invoke('settings:update', { offlineName: name });
    MP.state.settings = settings;
    refresh();
    MP.toast('玩家名已更新', 'ok');
  }

  async function launch() {
    if (MP.state.launching) {
      MP.log.open();
      return;
    }
    if (MP.state.launchBusy) return;

    const id = MP.state.selectedVersion;
    if (!id) {
      MP.go('download');
      return;
    }
    if (MP.state.installing) {
      MP.toast('正在安装版本，请稍后再启动', 'warn');
      return;
    }

    const version = findVersion(id);
    if (!version) return;
    if (version.incomplete) {
      // 不阻止启动：launch 阶段会先做完整性校验并自动补全 client.jar。
      setHint('检测到版本文件不完整，启动时将自动补全…');
    }

    MP.state.launchBusy = true;
    setHint('正在检查 Java 与版本文件…');
    renderLaunchButton(version);
    setLaunchLabel();
    let result;
    try {
      result = await MP.api.invoke('launch:start', id);
    } catch (err) {
      result = { ok: false, code: 'IPC_FAILED', error: err.message };
    }
    MP.state.launchBusy = false;

    if (!result.ok) {
      renderLaunchButton(version);
      if (result.code === 'NO_ACCOUNT' || result.code === 'AUTH_EXPIRED') {
        setHint(result.error || '请先登录 Microsoft 账户', true);
        MP.toast(result.error || '请先登录 Microsoft 账户', 'err', 6000);
        if (MP.openAccount) MP.openAccount();
        return;
      }
      if (result.code === 'NO_JAVA' || result.code === 'JAVA_TOO_OLD') {
        setHint(result.error, true);
        const found = result.found || (MP.state.javaList[0] ? MP.state.javaList[0].major : 0);
        const installed = await MP.ensureJava(result.required, found);
        if (installed) setTimeout(() => launch(), 300);
        else setHint(`已取消启动：需要 Java ${result.required}`, true);
        return;
      }
      setHint(result.error || '启动失败', true);
      MP.toast(result.error || '启动失败', 'err', 6500);
      MP.log.open();
      return;
    }

    MP.state.launching = true;
    MP.state.currentLaunch = result;
    if (version) version.lastPlayed = Date.now();
    MP.state.settings.lastPlayed = MP.state.settings.lastPlayed || {};
    MP.state.settings.lastPlayed[id] = Date.now();
    setHint(`游戏已启动 · Java ${result.javaMajor} · 日志已保存`);
    refresh();
    if (MP.state.settings.autoOpenLog) MP.log.open();
    if (result.portable) {
      MP.toast(`已使用便携游戏数据目录：${result.gameDir}`, 'warn', 12000);
    }
    if (result.integrity && result.integrity.repaired > 0) {
      MP.toast(`启动前已自动修复 ${result.integrity.repaired} 个文件`, 'ok', 7000);
    }
    if (MP.monitor) MP.monitor.onLaunch(result);
    MP.toast('游戏已启动', 'ok');
  }

  function setLaunchLabel() {
    const main = $('#btn-launch .launch-main');
    const sub = $('#launch-sub');
    const button = $('#btn-launch');
    if (main) main.textContent = '正在启动…';
    if (sub) sub.textContent = '正在检查运行环境';
    if (button) button.disabled = true;
  }

  function init() {
    if (bound) return;
    bound = true;

    MP.on('#btn-launch', 'click', launch);
    MP.api.on('launch:progress', (progress) => {
      if (!MP.state.launchBusy || !progress) return;
      const message = progress.message || '正在校验文件…';
      const percent = Number(progress.percent);
      setHint(percent > 0 && percent < 100 ? `${message}（${Math.round(percent)}%）` : message);
    });
    MP.on('#btn-install-cta', 'click', () => MP.go('download'));
    MP.on('#btn-refresh', 'click', async () => {
      await MP.refreshVersions();
      MP.toast('版本列表已刷新', 'ok');
    });
    MP.on('#version-select', 'change', (event) => {
      const id = event.target.value;
      if (!id) return;
      MP.selectVersion(id);
      setHint('');
    });
    MP.on('#btn-edit-account', 'click', editAccount);
    MP.on('#profile-card', 'click', editAccount);

    $$('[data-action]', $('#view-home')).forEach((button) => {
      button.addEventListener('click', async () => {
        const action = button.dataset.action;
        if (action === 'open-game') {
          const result = await MP.api.invoke('game:open-folder', MP.state.selectedVersion || '');
          if (!result.ok) MP.toast(`无法打开目录：${result.error}`, 'err');
        } else if (action === 'open-mods') {
          const result = await MP.api.invoke('versions:open-mods', MP.state.selectedVersion || '');
          if (!result.ok) MP.toast(`无法打开 Mods 目录：${result.error}`, 'err');
        } else if (action === 'show-log') {
          MP.log.open();
        }
      });
    });
  }

  function onExit() {
    MP.state.launching = false;
    MP.state.currentLaunch = null;
    refresh();
    renderSelect();
  }

  MP.onExit = onExit;

  MP.views.home = {
    init,
    refresh,
    onExit,
    onShow: refresh,
  };
})();