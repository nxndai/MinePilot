'use strict';

(function () {
  /**
   * 发起安装并显示一个独立的进度弹窗，供下载页与版本页共用。
   * 后端的 install:* 事件仍会广播，下载页自己的进度条也会同步更新。
   */
  MP.installWithProgress = function (request, title) {
    MP.state.installing = true;
    MP.state.installingVersion = request.versionId;
    MP.state.installPercent = 0;
    const modal = MP.progressModal({ title: title || '正在安装', text: '准备中…' });
    return new Promise((resolve, reject) => {
      let settled = false;
      const offs = [];

      function cleanup() {
        for (const off of offs) {
          try { off(); } catch (err) { /* ignore */ }
        }
        offs.length = 0;
      }

      function finish(fn, value) {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      }

      offs.push(MP.api.on('install:progress', (progress) => {
        if (!progress || (progress.requestId || progress.versionId) !== request.versionId) return;
        modal.update(progress.percent, progress.phase || '正在安装…');
      }));

      offs.push(MP.api.on('install:done', (payload) => {
        if (!payload || (payload.requestId || payload.versionId) !== request.versionId) return;
        modal.update(100, '安装完成');
        setTimeout(() => modal.close(), 500);
        finish(resolve, payload);
      }));

      offs.push(MP.api.on('install:error', (payload) => {
        if (!payload || (payload.requestId || payload.versionId) !== request.versionId) return;
        const error = new Error(payload.error || '安装失败');
        error.code = payload.code;
        MP.state.installing = false;
        modal.update(0, payload.error || '安装失败');
        setTimeout(() => modal.close(), 1800);
        finish(reject, error);
      }));

      MP.api.invoke('install:start', request).then((result) => {
        if (!result || !result.ok) {
          MP.state.installing = false;
          const error = new Error((result && result.error) || '安装失败');
          error.code = result && result.code;
          modal.update(0, error.message);
          setTimeout(() => modal.close(), 1800);
          finish(reject, error);
        }
      }).catch((err) => {
        MP.state.installing = false;
        modal.update(0, err.message || '安装失败');
        setTimeout(() => modal.close(), 1800);
        finish(reject, err);
      });
    });
  };
})();