/**
 * util.js —— 通用工具
 *
 * 设计原则（安全相关）：
 *  - 本文件及整个扩展不包含任何网络请求（fetch / XMLHttpRequest / WebSocket /
 *    sendBeacon / EventSource）、不做任何远程代码加载（无 eval / new Function /
 *    import()）、不读取 cookie、不读取 localStorage / sessionStorage 中的站点数据。
 *  - 只读取当前页面已渲染出来的 DOM 文本，并在返回给用户后再由用户自行保存。
 */
(function () {
  'use strict';

  const NS = (window.__DSE__ = window.__DSE__ || {});

  /** 简单稳定的字符串哈希（FNV-1a 32bit），仅用于本地去重，不做任何加密用途 */
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  /** 规范化空白，用于指纹比较 */
  function normalizeText(s) {
    return String(s || '')
      .replace(/\u200b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 等待条件成立，或超时返回 false */
  async function waitFor(cond, timeout = 3000, interval = 120) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      let ok = false;
      try {
        ok = !!cond();
      } catch (_) {
        ok = false;
      }
      if (ok) return true;
      await sleep(interval);
    }
    return false;
  }

  /** 等到浏览器完成一次绘制（含两帧，确保渲染管线已落地） */
  function nextFrame() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }

  /** 元素是否可见（用于过滤折叠/隐藏的思考过程块） */
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    return true;
  }

  /** 收集元素上的各种"身份字符串"：class / id / data-* / aria-label / title */
  function identityText(el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    const cn = el.className;
    if (typeof cn === 'string') parts.push(cn);
    else if (cn && cn.baseVal) parts.push(cn.baseVal);
    if (el.id) parts.push(el.id);
    if (el.getAttribute) {
      const whitelist = [
        'data-testid',
        'data-role',
        'data-message-author-role',
        'data-message-id',
        'data-type',
        'data-name',
        'aria-label',
        'aria-roledescription',
        'title',
      ];
      for (const k of whitelist) {
        const v = el.getAttribute(k);
        if (v) parts.push(k + '=' + v);
      }
    }
    return parts.join(' ');
  }

  /** 判断某个结点是否为另一个结点的祖先 */
  function contains(ancestor, node) {
    if (!ancestor || !node || ancestor === node) return false;
    return ancestor.contains(node);
  }

  /** 找到一组元素在 DOM 中最深的公共祖先 */
  function deepestCommonAncestor(nodes) {
    if (!nodes || nodes.length === 0) return null;
    let anc = nodes[0];
    for (let i = 1; i < nodes.length; i++) {
      while (anc && !anc.contains(nodes[i])) anc = anc.parentElement;
      if (!anc) return null;
    }
    return anc;
  }

  /** 元素在父节点中的序号，用于排序与指纹（对虚拟列表更稳） */
  function siblingIndex(el) {
    let i = 0;
    let p = el;
    while (p && p.previousElementSibling) {
      p = p.previousElementSibling;
      i++;
    }
    return i;
  }

  /** 取元素的"纯文本"，忽略 script/style，并把 <br> 视作换行 */
  function innerTextLoose(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,template').forEach((n) => n.remove());
    clone.querySelectorAll('br').forEach((n) => n.replaceWith(document.createTextNode('\n')));
    return normalizeText(clone.textContent || '');
  }

  /** 系统级忽略的标签与属性（既用于角色判定，也用于 Markdown 转换） */
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META',
    'BUTTON', 'SVG', 'CANVAS', 'IFRAME', 'VIDEO', 'AUDIO',
    'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'DIALOG',
  ]);

  NS.util = {
    hash32,
    normalizeText,
    sleep,
    waitFor,
    nextFrame,
    isVisible,
    identityText,
    contains,
    deepestCommonAncestor,
    siblingIndex,
    innerTextLoose,
    SKIP_TAGS,
  };
})();
