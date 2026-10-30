'use strict';

(function () {
  const MP = window.MP;

  /** 把外观设置应用到文档根节点。背景图片由主进程保存并在启动时读取。 */
  MP.applyAppearance = function (settings) {
    const s = settings || MP.state.settings || {};
    const root = document.documentElement;
    const theme = s.theme === 'light' ? 'light' : 'dark';
    root.dataset.theme = theme;
    root.dataset.motion = s.animations === false ? 'off' : 'on';
    const scale = Math.max(0.8, Math.min(1.4, Number(s.uiScale) || 1));
    if (window.mp && window.mp.native) {
      root.style.removeProperty('--ui-scale');
      MP.api.invoke('ui:set-zoom', scale).catch(() => {});
    } else {
      root.style.setProperty('--ui-scale', String(scale));
    }
    root.style.setProperty('--custom-bg-color', s.backgroundColor || '#0b1020');

    const type = s.backgroundType || 'default';
    root.dataset.background = type;
    if (type !== 'image') {
      root.style.removeProperty('--custom-bg-image');
      return;
    }

    // 启动或首次切换时读取一次图片，之后复用缓存，避免每次保存设置都传输大文件。
    if (MP.state.backgroundDataUrl) {
      root.style.setProperty('--custom-bg-image', `url("${MP.state.backgroundDataUrl}")`);
      return;
    }
    MP.api.invoke('theme:background').then((result) => {
      const url = result && result.ok && result.dataUrl ? result.dataUrl : '';
      MP.state.backgroundDataUrl = url;
      if (url && (MP.state.settings || {}).backgroundType === 'image') {
        root.style.setProperty('--custom-bg-image', `url("${url}")`);
      } else {
        root.style.removeProperty('--custom-bg-image');
      }
    }).catch(() => {
      root.style.removeProperty('--custom-bg-image');
    });
  };

  MP.chooseBackground = function (file) {
    return new Promise((resolve, reject) => {
      if (!file) {
        resolve(null);
        return;
      }
      if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type || '')) {
        reject(new Error('请选择 PNG、JPG、WebP 或 GIF 图片'));
        return;
      }
      if (file.size > 12 * 1024 * 1024) {
        reject(new Error('背景图片不能超过 12 MB'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
  };

  MP.applyAppearance(MP.state.settings);
})();
