'use strict';

(function () {
  const { $, $$ } = MP;

  const log = {
    autoScroll: true,
    init() {
      this.content = $('#log-content');
      MP.on('#log-close', 'click', () => this.close());
      MP.on('#log-clear', 'click', () => this.clear());
      MP.on('#log-open-folder', 'click', () => MP.openLogs());
      MP.on('#log-autoscroll', 'click', () => {
        this.autoScroll = !this.autoScroll;
        $('#log-autoscroll').classList.toggle('active', this.autoScroll);
        if (this.autoScroll) this.scrollToEnd();
      });
    },
    open() {
      $('#log-drawer').classList.add('open');
      this.scrollToEnd();
    },
    close() {
      $('#log-drawer').classList.remove('open');
    },
    setTitle(text) {
      const node = $('#log-title-text');
      if (node) node.textContent = text;
    },
    append(text) {
      const content = $('#log-content');
      if (!content) return;
      content.textContent += text;
      if (content.textContent.length > 400000) {
        content.textContent = content.textContent.slice(-200000);
      }
      if (this.autoScroll) this.scrollToEnd();
    },
    clear() {
      if (this.content) this.content.textContent = '';
    },
    scrollToEnd() {
      const content = $('#log-content');
      if (content) content.scrollTop = content.scrollHeight;
    },
  };
  MP.log = log;

  function bindWindowControls() {
    MP.on('#win-min', 'click', () => MP.api.minimize());
    MP.on('#win-max', 'click', () => MP.api.toggleMaximize());
    MP.on('#win-close', 'click', () => MP.api.close());
    MP.api.on('win:state', (state) => {
      const button = $('#win-max');
      if (!button) return;
      button.title = state && state.maximized ? '还原' : '最大化';
    });
  }

  function bindNavigation() {
    $$('.nav-item').forEach((button) => {
      button.addEventListener('click', () => MP.go(button.dataset.view));
    });

    document.addEventListener('click', (event) => {
      const goto = event.target.closest('[data-goto]');
      if (goto) {
        MP.go(goto.dataset.goto);
        return;
      }
      const link = event.target.closest('[data-url]');
      if (link) {
        event.preventDefault();
        MP.openExternal(link.dataset.url);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && $('#log-drawer').classList.contains('open')) {
        log.close();
      }
    });
  }

  async function maybeWelcome() {
    const settings = MP.state.settings;
    if (!settings || !settings.firstRun) return;
    const english = MP.i18n && MP.i18n.language === 'en-US';
    setTimeout(async () => {
      await MP.modal({
        title: english ? 'Welcome to MinePilot' : '欢迎使用 MinePilot',
        body: english
          ? `<p>This is a <strong>lightweight</strong> Minecraft Java Edition launcher with <strong>offline accounts and Microsoft login</strong>. It installs vanilla Minecraft and can add Fabric, Forge, NeoForge or Quilt with one click, with version isolation.</p>
          <p class="muted-sm">You can search Modrinth or CurseForge from the Mods page, filter by category, and resolve required dependencies automatically. MinePilot does not bypass authentication or modify game files. If you enjoy Minecraft, please buy it to support Mojang.</p>`
          : `<p>这是一个 <strong>轻量</strong>的 Minecraft Java 版启动器，支持<strong>离线账户与 Microsoft 正版登录</strong>，可安装原版，并一键安装 Fabric、Forge、NeoForge、Quilt，管理版本隔离。</p>
          <p class="muted-sm">现在还可以在「模组」页从 Modrinth 或 CurseForge 搜索模组，按功能、优化、科技等分类筛选，并自动补齐必需前置。MinePilot 不会绕过正版验证，也不会修改游戏文件。如果你喜欢 Minecraft，请购买正版支持 Mojang。</p>`,
        actions: [
          {
            label: english ? 'Buy the game' : '购买正版',
            kind: 'ghost',
            onClick: () => {
              MP.openExternal('https://www.minecraft.net/zh-hans/store/minecraft-java-bedrock-edition-pc');
              return null;
            },
          },
          { label: english ? 'Get started' : '开始使用', kind: 'primary', value: true },
        ],
      });
      const next = await MP.api.invoke('settings:update', { firstRun: false });
      MP.state.settings = next;
    }, 800);
  }

  function bindIpc() {
    const downloadView = MP.views.download;

    MP.api.on('install:progress', (progress) => {
      if (downloadView) downloadView.onProgress(progress);
    });
    MP.api.on('install:done', async (result) => {
      if (downloadView) await downloadView.onDone(result);
    });
    MP.api.on('install:error', (payload) => {
      if (downloadView) downloadView.onError(payload);
    });

    MP.api.on('launch:log', (payload) => {
      if (payload && payload.versionId) log.setTitle(payload.versionId);
      log.append(payload && payload.text ? payload.text : '');
    });

    MP.api.on('launch:exit', async (payload) => {
      MP.state.launching = false;
      MP.state.currentLaunch = null;
      if (MP.views.home) MP.views.home.onExit();
      if (MP.monitor) MP.monitor.onExit();
      const code = payload ? payload.code : -1;
      const diag = payload && payload.diagnostics;
      if (diag && diag.killed) {
        MP.toast('游戏已结束', 'ok');
      } else if (diag && diag.crashed) {
        // 崩溃详情由「诊断」页和 crash:detected 弹窗展示，这里只把日志准备好。
        log.open();
      } else if (code === 0) {
        const seconds = Math.max(1, Math.round((payload.duration || 0) / 1000));
        MP.toast(`游戏已退出，本次运行 ${seconds} 秒`, 'ok');
      } else {
        MP.toast(`游戏异常退出（代码 ${code}），已打开日志`, 'err', 6500);
        log.open();
      }
      await MP.refreshVersions();
    });

    MP.api.on('settings:changed', (settings) => {
      MP.state.settings = settings;
      if (MP.applyAppearance) MP.applyAppearance(settings);
    });

    MP.api.on('auth:changed', async (state) => {
      MP.state.account = state;
      if (MP.refreshAccount) await MP.refreshAccount();
      else if (MP.views.home) MP.views.home.refresh();
      if (MP.views.settings) MP.views.settings.render();
    });
  }

  async function boot() {
    bindWindowControls();
    bindNavigation();
    log.init();
    bindIpc();
    MP.state.launchBusy = false;

    try {
      MP.state.info = await MP.api.invoke('app:info');
      MP.state.settings = await MP.api.invoke('settings:get');
      if (MP.i18n) MP.i18n.apply(MP.state.settings.language);
      if (MP.applyAppearance) MP.applyAppearance(MP.state.settings);
      MP.state.account = await MP.api.invoke('auth:status');
    } catch (err) {
      MP.toast(`启动器初始化失败：${err.message}`, 'err', 8000);
    }

    ['home', 'versions', 'download', 'mods', 'skin', 'monitor', 'diagnostics', 'settings', 'about'].forEach((name) => {
      const view = MP.views[name];
      if (view && view.init) view.init();
    });

    if (MP.updater) MP.updater.init();
    if (MP.plugins) MP.plugins.init();

    try {
      await Promise.all([MP.refreshVersions(), MP.refreshJava()]);
    } catch (err) {
      MP.toast(`读取本地数据失败：${err.message}`, 'err', 6000);
    }

    if (MP.views.settings) MP.views.settings.render();
    if (MP.views.about) MP.views.about.render();
    if (MP.views.home) MP.views.home.refresh();
    maybeWelcome();

    const requestedView = new URLSearchParams(location.search).get('view');
    if (requestedView && document.getElementById(`view-${requestedView}`)) {
      setTimeout(() => MP.go(requestedView), 180);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();