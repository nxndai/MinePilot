'use strict';

(function () {
  const { $ } = MP;
  let bound = false;

  function render() {
    const info = MP.state.info;
    const settings = MP.state.settings;

    if (info) {
      if ($('#about-electron')) $('#about-electron').textContent = info.electron || '—';
      if ($('#about-node')) $('#about-node').textContent = info.node || '—';
      if ($('#about-platform')) {
        const platformName = info.mode === 'web' ? '浏览器版' : info.platform === 'win32' ? 'Windows' : info.platform === 'darwin' ? 'macOS' : info.platform === 'linux' ? 'Linux' : info.platform;
        $('#about-platform').textContent = `${platformName} ${info.arch || ''}`.trim();
      }
      if ($('#about-data')) {
        $('#about-data').textContent = info.dataDir || '—';
        $('#about-data').title = info.dataDir || '';
      }
      const versionNode = document.querySelector('.side-version');
      if (versionNode) versionNode.textContent = `MinePilot v${info.version}`;
    }
    if (settings && $('#about-game')) {
      $('#about-game').textContent = settings.gameDir;
      $('#about-game').title = settings.gameDir;
    }
  }

  function init() {
    if (bound) return;
    bound = true;
    MP.on('#btn-open-data', 'click', () => {
      MP.openPath(MP.state.info ? MP.state.info.dataDir : '', '数据目录');
    });
    MP.on('#btn-open-logs', 'click', () => {
      MP.openLogs();
    });
  }

  MP.views.about = { init, render, onShow: render };
})();