/**
 * popup.js
 *
 * 只做三件事：
 *   1. 读取 / 保存用户偏好（chrome.storage.local，本机存储，不参与账号同步）
 *   2. 把偏好作为参数发给内容脚本
 *   3. 展示结果并把 Markdown 写入剪贴板
 *
 * 不包含任何网络请求，也不引用任何远程脚本。
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'dse_settings_v1';

  const DEFAULTS = {
    thinkMode: 'exclude', // 'exclude' | 'collapse' | 'plain'
    excludeToolCalls: true,
    includeMeta: true,
    keepRoleLabels: true,
    imageMode: 'link',
    loadHistory: true,
  };

  const el = (id) => document.getElementById(id);

  const ui = {
    banner: el('banner'),
    seg: el('seg-thinking'),
    thinkHint: el('think-hint'),
    optTool: el('opt-tool'),
    optMeta: el('opt-meta'),
    optRoles: el('opt-roles'),
    optImage: el('opt-image'),
    optHistory: el('opt-history'),
    status: el('status'),
    diag: el('diag'),
    diagBody: el('diag-body'),
    btnDownload: el('btn-download'),
    btnCopy: el('btn-copy'),
    btnBoth: el('btn-both'),
    btnDiag: el('btn-diag'),
    btnDiagClose: el('btn-diag-close'),
  };

  let settings = Object.assign({}, DEFAULTS);
  let activeTabId = null;
  let pageReady = false;

  /* ---------------------------- 存储 ---------------------------- */

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (res) => {
        const saved = (res && res[STORAGE_KEY]) || {};
        settings = Object.assign({}, DEFAULTS, saved);
        resolve(settings);
      });
    });
  }

  function saveSettings() {
    const patch = {};
    patch[STORAGE_KEY] = settings;
    chrome.storage.local.set(patch);
  }

  /* ---------------------------- UI 同步 ---------------------------- */

  const THINK_HINTS = {
    exclude: '已开启：深度思考 / 推理过程 不会写入 Markdown。',
    collapse: '思考过程会作为 <details> 折叠块保留，默认收起。',
    plain: '思考过程会直接混在正文里一起导出。',
  };

  function render() {
    Array.from(ui.seg.querySelectorAll('button')).forEach((b) => {
      b.classList.toggle('active', b.dataset.v === settings.thinkMode);
    });
    ui.thinkHint.textContent = THINK_HINTS[settings.thinkMode] || '';
    ui.optTool.checked = !!settings.excludeToolCalls;
    ui.optMeta.checked = !!settings.includeMeta;
    ui.optRoles.checked = !!settings.keepRoleLabels;
    ui.optImage.value = settings.imageMode;
    ui.optHistory.checked = !!settings.loadHistory;
  }

  function bind() {
    ui.seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      settings.thinkMode = b.dataset.v;
      saveSettings();
      render();
    });

    const bindCheck = (node, key) =>
      node.addEventListener('change', () => {
        settings[key] = node.checked;
        saveSettings();
      });

    bindCheck(ui.optTool, 'excludeToolCalls');
    bindCheck(ui.optMeta, 'includeMeta');
    bindCheck(ui.optRoles, 'keepRoleLabels');
    bindCheck(ui.optHistory, 'loadHistory');

    ui.optImage.addEventListener('change', () => {
      settings.imageMode = ui.optImage.value;
      saveSettings();
    });
  }

  /* ---------------------------- 状态提示 ---------------------------- */

  function setBanner(text, kind) {
    ui.banner.textContent = text;
    ui.banner.className = 'banner' + (kind ? ' ' + kind : '');
  }

  function setStatus(text, kind, persist) {
    if (!text) {
      ui.status.hidden = true;
      ui.status.textContent = '';
      return;
    }
    ui.status.hidden = false;
    ui.status.className = 'status' + (kind ? ' ' + kind : '');
    ui.status.textContent = text;
    if (!persist) {
      clearTimeout(setStatus._t);
      setStatus._t = setTimeout(() => {
        ui.status.hidden = true;
      }, 6000);
    }
  }

  function setBusy(on) {
    [ui.btnDownload, ui.btnCopy, ui.btnBoth].forEach((b) => (b.disabled = !!on));
  }

  /* ---------------------------- 通信 ---------------------------- */

  function queryActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve((tabs && tabs[0]) || null));
    });
  }

  function sendToTab(msg) {
    return new Promise((resolve) => {
      if (activeTabId == null) {
        resolve({ ok: false, error: '找不到当前标签页。' });
        return;
      }
      try {
        chrome.tabs.sendMessage(activeTabId, msg, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({
              ok: false,
              error:
                '无法连接到页面脚本（' + err.message + '）。请确认当前标签页是 chat.deepseek.com 的对话页面，并刷新一次页面后重试。',
            });
            return;
          }
          resolve(resp || { ok: false, error: '页面没有返回任何数据。' });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  function toScanOptions() {
    const obj = Object.assign({}, settings);
    obj.excludeThinking = settings.thinkMode !== 'plain';
    obj.includeThinkingBlock = settings.thinkMode === 'collapse';
    delete obj.thinkMode;
    return obj;
  }

  async function detectPage() {
    const tab = await queryActiveTab();
    if (!tab) {
      setBanner('找不到活动标签页。', 'err');
      return;
    }
    activeTabId = tab.id;

    const url = tab.url || '';
    if (!/^https:\/\/chat\.deepseek\.com\//.test(url)) {
      setBanner('当前不是 DeepSeek 对话页。请先打开 chat.deepseek.com 的对话再点击插件。', 'err');
      return;
    }

    const ping = await sendToTab({ type: 'DSE_PING' });
    if (!ping.ok) {
      setBanner('页面脚本尚未就绪，请刷新该页面后重试。', 'err');
      return;
    }
    pageReady = true;
    setBanner('已连接到 DeepSeek 页面，可以导出当前会话。', 'ok');
  }

  /* ---------------------------- 剪贴板 ---------------------------- */

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e) {
        return false;
      }
    }
  }

  /* ---------------------------- 动作 ---------------------------- */

  async function doExport(deliver, alsoCopy) {
    if (!pageReady) {
      setStatus('尚未连接到 DeepSeek 页面。', 'err');
      return;
    }
    setBusy(true);
    setStatus('正在读取会话…（长会话 / 需要加载历史消息时会花几秒）', 'busy', true);

    const resp = await sendToTab({
      type: 'DSE_EXPORT',
      settings: toScanOptions(),
      deliver: deliver || 'none',
      deliverJson: deliver === 'both',
    });

    setBusy(false);

    if (!resp.ok) {
      setStatus('导出失败：' + resp.error, 'err', true);
      return;
    }

    const s = resp.stats || {};
    const lines = [
      '共导出 ' + (s.exported || 0) + ' 条消息，用时 ' + Math.round((resp.elapsed || 0) / 100) / 10 + 's',
      '识别到思考过程块 ' + (s.thinkingBlocks || 0) + ' 处' +
        (settings.thinkMode === 'exclude' ? '（已排除）' : settings.thinkMode === 'collapse' ? '（已折叠保留）' : '（已并入正文）'),
      '联网/工具卡片 ' + (s.toolBlocks || 0) + ' 处',
    ];
    if (s.lowConfidence) lines.push('置信度较低的消息：' + s.lowConfidence + ' 条（如角色标注有误，请点「诊断」反馈）');
    if (deliver === 'download' || deliver === 'both') lines.push('文件：' + resp.filename);

    if (alsoCopy) {
      const ok = await copyText(resp.markdown);
      lines.push(ok ? '已复制到剪贴板。' : '复制失败，请改用「下载 Markdown」。');
    }

    setStatus(lines.join('\n'), 'ok', true);
  }

  async function doDiagnose() {
    const resp = await sendToTab({ type: 'DSE_DIAGNOSE' });
    ui.diag.hidden = false;
    if (!resp.ok) {
      ui.diagBody.textContent = '诊断失败：' + resp.error;
      return;
    }
    const d = resp.data;
    const lines = [
      '页面标题   : ' + (d.title || '(未识别)'),
      '滚动容器   : ' + d.container,
      '滚动高度   : ' + d.scrollHeight + ' / 可视 ' + d.clientHeight,
      '消息节点   : ' + d.messageNodes,
      '正文块数   : ' + d.markdownBlocks + '  (.ds-markdown)',
      '思考过程块 : ' + d.thinkingBlocks,
      '折叠思考头 : ' + d.collapsedThinkingHeaders,
      '搜索/工具块: ' + d.toolBlocks,
      '',
      '前几条识别结果：',
    ];
    (d.sample || []).forEach((s, i) => {
      lines.push(
        String(i + 1).padStart(2, '0') + '. [' + s.role + '/' + s.confidence + '] ' + s.element + '\n    ' + s.preview
      );
    });
    ui.diagBody.textContent = lines.join('\n');
  }

  /* ---------------------------- 启动 ---------------------------- */

  (async function init() {
    bind();
    await loadSettings();
    render();

    ui.btnDownload.addEventListener('click', () => doExport('download', false));
    ui.btnCopy.addEventListener('click', () => doExport('none', true));
    ui.btnBoth.addEventListener('click', () => doExport('both', false));
    ui.btnDiag.addEventListener('click', doDiagnose);
    ui.btnDiagClose.addEventListener('click', () => {
      ui.diag.hidden = true;
    });

    await detectPage();
  })();
})();
