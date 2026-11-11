/**
 * content.js —— 内容脚本（运行在 chat.deepseek.com 页面内）
 *
 * 职责边界（安全设计）：
 *   - 只做两件事：读取当前页面已渲染的 DOM 文本；在用户点击导出时，本地触发一次文件保存。
 *   - 不发起任何网络请求，不注入任何远程资源，不读取 cookie / localStorage。
 *   - 不自动点击、不自动发送消息、不修改页面内容（除临时插入一个 Shadow DOM 进度浮层，
 *     导出结束后立即移除）。
 */
(function () {
  'use strict';

  if (window.__DSE_CONTENT_READY__) return;
  window.__DSE_CONTENT_READY__ = true;

  const NS = window.__DSE__;
  if (!NS || !NS.extract) return;

  /* ------------------------------------------------------------------ *
   * 进度浮层（Shadow DOM 隔离样式，不污染站点 CSS）
   * ------------------------------------------------------------------ */

  let ui = null;

  function ensureUI() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('div');
    host.id = 'dse-overlay-host';
    host.style.cssText =
      'position:fixed;z-index:2147483647;top:16px;left:50%;transform:translateX(-50%);pointer-events:none;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .pill{font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
              background:#1f2430;color:#f2f4f8;padding:9px 16px;border-radius:20px;
              box-shadow:0 8px 24px rgba(0,0,0,.28);max-width:min(70vw,460px);
              display:flex;align-items:center;gap:9px;opacity:0;transform:translateY(-8px);
              transition:opacity .18s,transform .18s}
        .pill.on{opacity:1;transform:translateY(0)}
        .pill.err{background:#5b1f22}
        .pill.ok{background:#14401f}
        .dot{width:8px;height:8px;border-radius:50%;background:#5b8cff;flex:none;
             animation:p 1s infinite ease-in-out}
        @keyframes p{0%,100%{opacity:.35}50%{opacity:1}}
        .txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      </style>
      <div class="pill" id="pill"><span class="dot"></span><span class="txt">准备中…</span></div>`;
    (document.body || document.documentElement).appendChild(host);
    ui = { host, root, pill: root.getElementById('pill'), txt: root.querySelector('.txt'), timer: null };
    requestAnimationFrame(() => ui.pill.classList.add('on'));
    return ui;
  }

  function showProgress(text, kind) {
    const u = ensureUI();
    u.txt.textContent = text;
    u.pill.classList.remove('err', 'ok');
    if (kind) u.pill.classList.add(kind);
    if (u.timer) clearTimeout(u.timer);
    u.timer = null;
  }

  function finishProgress(text, kind, keepMs) {
    const u = ensureUI();
    u.txt.textContent = text;
    u.pill.classList.remove('err', 'ok');
    if (kind) u.pill.classList.add(kind);
    if (u.timer) clearTimeout(u.timer);
    u.timer = setTimeout(removeUI, keepMs || 2200);
  }

  function removeUI() {
    if (!ui) return;
    try {
      ui.host.remove();
    } catch (_) {
      /* noop */
    }
    ui = null;
  }

  /* ------------------------------------------------------------------ *
   * 文档构建
   * ------------------------------------------------------------------ */

  const SETTING_DEFAULTS = {
    excludeThinking: true,
    includeThinkingBlock: false,
    excludeToolCalls: true,
    includeMeta: true,
    imageMode: 'link',
    keepRoleLabels: true,
  };

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function stamp(d) {
    const t = d || new Date();
    return (
      t.getFullYear() +
      '-' + pad2(t.getMonth() + 1) +
      '-' + pad2(t.getDate()) +
      ' ' + pad2(t.getHours()) +
      ':' + pad2(t.getMinutes())
    );
  }

  function fileStamp(d) {
    const t = d || new Date();
    return (
      String(t.getFullYear()) + pad2(t.getMonth() + 1) + pad2(t.getDate()) +
      '-' + pad2(t.getHours()) + pad2(t.getMinutes()) + pad2(t.getSeconds())
    );
  }

  function safeName(s, fallback) {
    const t = String(s || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    return t || fallback;
  }

  function buildDocument(result, settings) {
    const now = new Date();
    const L = [];
    const title = result.title || 'DeepSeek 对话';

    L.push('# ' + title);
    L.push('');

    if (settings.includeMeta) {
      L.push('> **来源**：' + result.url);
      L.push('> ');
      L.push('> **模型**：' + (result.model || 'DeepSeek'));
      L.push('> ');
      L.push('> **导出时间**：' + stamp(now));
      L.push('> ');
      L.push('> **消息数**：' + result.messages.length +
        '　|　**思考过程**：' + (settings.excludeThinking ? '已排除' : '已保留') +
        (result.stats.thinkingBlocks ? '（识别到 ' + result.stats.thinkingBlocks + ' 处）' : ''));
      L.push('');
    }

    L.push('---');
    L.push('');

    const label = { user: '用户', assistant: 'DeepSeek' };

    result.messages.forEach((m, i) => {
      const role = m.role === 'user' ? 'user' : 'assistant';
      if (settings.keepRoleLabels) {
        L.push('## ' + (label[role] || role));
        L.push('');
      }

      if (m.thinking) {
        L.push('<details>');
        L.push('<summary>思考过程</summary>');
        L.push('');
        L.push(m.thinking);
        L.push('');
        L.push('</details>');
        L.push('');
      }

      if (m.content) {
        L.push(m.content);
        L.push('');
      }

      if (i !== result.messages.length - 1) {
        L.push('---');
        L.push('');
      }
    });

    return L.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim() + '\n';
  }

  /* ------------------------------------------------------------------ *
   * 下载（本地 Blob，无需 downloads 权限，不经过网络）
   * ------------------------------------------------------------------ */

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: (mime || 'text/markdown') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 4000);
  }

  /* ------------------------------------------------------------------ *
   * 主流程
   * ------------------------------------------------------------------ */

  let busy = false;

  async function runExport(rawSettings) {
    const settings = Object.assign({}, SETTING_DEFAULTS, rawSettings || {});
    const t0 = Date.now();
    showProgress('正在准备…');

    const result = await NS.extract.scan(settings, (p) => {
      if (p.phase === 'loading-history') {
        showProgress('正在加载更早的历史消息…（第 ' + (p.round || 1) + ' 轮）');
      } else if (p.phase === 'scanning') {
        const pct = p.max ? Math.min(99, Math.round((p.pos / p.max) * 100)) : 0;
        showProgress('正在扫描消息… ' + pct + '%（已识别 ' + p.found + ' 条）');
      }
    });

    if (!result.messages.length) {
      throw new Error('未在当前页面识别到任何消息。请先打开一个具体的对话页面再试。');
    }

    const markdown = buildDocument(result, settings);
    const base = safeName(result.title, 'DeepSeek-对话');
    const filename = base + '-' + fileStamp() + '.md';

    return { result, markdown, filename, elapsed: Date.now() - t0, settings };
  }

  /* ------------------------------------------------------------------ *
   * 消息通道
   * ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('DSE_') !== 0) return;

    if (msg.type === 'DSE_PING') {
      sendResponse({ ok: true, url: location.href });
      return;
    }

    if (msg.type === 'DSE_DIAGNOSE') {
      try {
        sendResponse({ ok: true, data: NS.extract.diagnose() });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
      return;
    }

    if (msg.type === 'DSE_EXPORT') {
      if (busy) {
        sendResponse({ ok: false, error: '当前已有导出任务在进行中，请稍候。' });
        return true;
      }
      busy = true;
      runExport(msg.settings)
        .then((out) => {
          try {
            if (msg.deliver === 'download' || msg.deliver === 'both') {
              downloadText(out.filename, out.markdown, 'text/markdown');
            }
            if (msg.deliverJson) {
              const json = JSON.stringify(
                {
                  title: out.result.title,
                  url: out.result.url,
                  model: out.result.model,
                  exportedAt: new Date().toISOString(),
                  settings: out.settings,
                  stats: out.result.stats,
                  messages: out.result.messages,
                },
                null,
                2
              );
              downloadText(out.filename.replace(/\.md$/, '') + '.json', json, 'application/json');
            }
          } catch (e) {
            /* 下载失败不阻塞结果返回 */
          }
          busy = false;
          finishProgress('导出完成：' + out.result.messages.length + ' 条消息', 'ok');
          sendResponse({
            ok: true,
            markdown: out.markdown,
            filename: out.filename,
            stats: out.result.stats,
            elapsed: out.elapsed,
            title: out.result.title,
          });
        })
        .catch((e) => {
          busy = false;
          const m = String((e && e.message) || e);
          finishProgress('导出失败：' + m, 'err', 4200);
          sendResponse({ ok: false, error: m });
        });
      return true; // 异步响应
    }
  });

  // 页面跳转/切换会话时，清理浮层
  window.addEventListener('beforeunload', removeUI);
})();
