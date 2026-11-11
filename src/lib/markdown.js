/**
 * markdown.js —— 纯本地 DOM → Markdown 转换器
 *
 * 不依赖任何第三方库（无 CDN、无打包依赖），因此不存在"供应链投毒"风险面。
 */
(function () {
  'use strict';

  const NS = (window.__DSE__ = window.__DSE__ || {});
  const { SKIP_TAGS } = NS.util;

  /** 明显属于界面控件、不应出现在正文里的类名 */
  const UI_CLASS_RE = /(^|[\s_-])(btn|button|toolbar|actions?|copy-?btn|copy-?code|avatar|ds-icon|icon-btn|tooltip|sf-hidden|sr-only|visually-hidden)([\s_-]|$)/i;

  function clsOf(el) {
    const c = el.className;
    if (typeof c === 'string') return c;
    if (c && c.baseVal) return c.baseVal;
    return '';
  }

  function shouldSkip(el, ctx) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute('hidden')) return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    if (UI_CLASS_RE.test(clsOf(el))) return true;
    if (ctx && typeof ctx.shouldSkipElement === 'function' && ctx.shouldSkipElement(el)) return true;
    return false;
  }

  /** 代码块内容：保留换行，不做空白压缩 */
  function codeText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('br').forEach((n) => n.replaceWith(document.createTextNode('\n')));
    clone.querySelectorAll('button,svg,toolbar,[class*="copy" i]').forEach((n) => n.remove());
    let t = clone.textContent || '';
    return t.replace(/\u00a0/g, ' ').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
  }

  function langOf(codeEl) {
    const c = clsOf(codeEl);
    const m = /language-([\w+#.-]+)/i.exec(c) || /lang-([\w+#.-]+)/i.exec(c);
    if (m) return m[1];
    const dl = codeEl.getAttribute && (codeEl.getAttribute('data-lang') || codeEl.getAttribute('data-language'));
    if (dl) return dl;
    // 有些实现把语言名放在代码块头部的 span 里
    const wrap = codeEl.closest('pre') || codeEl.parentElement;
    if (wrap) {
      const head = wrap.querySelector('header,div[class*="header" i],div[class*="lang" i]');
      if (head) {
        const t = NS.util.normalizeText(head.textContent);
        if (t && t.length <= 16) return t.replace(/[^A-Za-z0-9+#.-]/g, '');
      }
    }
    return '';
  }

  /** KaTeX / MathJax：从隐藏的 annotation 里取回原始 TeX */
  function katexTex(el) {
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    if (ann && ann.textContent) return ann.textContent.trim();
    const mj = el.querySelector('script[type^="math/tex"]');
    if (mj && mj.textContent) return mj.textContent.trim();
    return '';
  }

  function escapeInline(s) {
    return s;
  }

  function tableToMd(table, ctx) {
    const rows = [];
    const trs = table.querySelectorAll('tr');
    trs.forEach((tr) => {
      const cells = [];
      tr.querySelectorAll('th,td').forEach((cell) => {
        let t = Array.from(cell.childNodes).map((c) => mdOf(c, ctx)).join('');
        t = NS.util.normalizeText(t).replace(/\|/g, '\\|');
        cells.push(t);
      });
      if (cells.length) rows.push(cells);
    });
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r) => {
      const c = r.slice();
      while (c.length < width) c.push('');
      return c;
    };
    const head = pad(rows[0]);
    const hasHeader = !!table.querySelector('thead th');
    const body = rows.slice(1).map(pad);
    const lines = [];
    lines.push('| ' + head.join(' | ') + ' |');
    lines.push('| ' + head.map(() => '---').join(' | ') + ' |');
    if (!hasHeader && body.length === 0) {
      // 单行表格
    }
    body.forEach((r) => lines.push('| ' + r.join(' | ') + ' |'));
    return '\n\n' + lines.join('\n') + '\n\n';
  }

  /**
   * 核心递归转换
   * @param {Node} node
   * @param {object} ctx { imageMode:'link'|'skip', shouldSkipElement?:fn }
   * @returns {string}
   */
  function mdOf(node, ctx) {
    if (!node) return '';
    if (node.nodeType === 3) return escapeInline(node.nodeValue.replace(/\u00a0/g, ' '));
    if (node.nodeType === 8) return '';
    if (node.nodeType !== 1) return '';

    const el = node;
    if (shouldSkip(el, ctx)) return '';

    const inner = () => Array.from(el.childNodes).map((c) => mdOf(c, ctx)).join('');

    // ---- 数学公式 ----
    if (/\bkatex\b/.test(clsOf(el)) || el.getAttribute('data-math')) {
      const tex = katexTex(el);
      if (tex) {
        const display = el.classList.contains('katex-display') || /katex-display/.test(clsOf(el.parentElement || el));
        return display ? `\n\n$$${tex}$$\n\n` : `$${tex}$`;
      }
      return inner();
    }

    const tag = el.tagName;

    switch (tag) {
      case 'BR':
        return '  \n';

      case 'HR':
        return '\n\n---\n\n';

      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6': {
        // headingOffset：正文标题整体降级，避免和「## 用户 / ## DeepSeek」抢层级
        const lvl = Math.min(6, Math.max(1, Number(tag[1]) + (ctx.headingOffset || 0)));
        const t = NS.util.normalizeText(stripInline(inner()));
        return t ? `\n\n${'#'.repeat(lvl)} ${t}\n\n` : '';
      }

      case 'P': {
        const t = inner();
        const tt = t.trim();
        return tt ? `\n\n${tt}\n\n` : '';
      }

      case 'STRONG':
      case 'B': {
        const t = inner().trim();
        return t ? `**${t}**` : '';
      }

      case 'EM':
      case 'I': {
        const t = inner().trim();
        return t ? `*${t}*` : '';
      }

      case 'DEL':
      case 'S':
      case 'STRIKE': {
        const t = inner().trim();
        return t ? `~~${t}~~` : '';
      }

      case 'MARK': {
        const t = inner().trim();
        return t ? `==${t}==` : '';
      }

      case 'CODE': {
        if (el.closest('pre')) return codeText(el);
        const t = codeText(el);
        if (!t) return '';
        const fence = t.includes('`') ? '``' : '`';
        return `${fence}${t}${fence}`;
      }

      case 'PRE': {
        const codeEl = el.querySelector('code') || el;
        const lang = langOf(codeEl);
        const body = codeText(codeEl);
        if (!body) return '';
        return `\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
      }

      case 'BLOCKQUOTE': {
        const t = inner().trim();
        if (!t) return '';
        const quoted = t
          .split('\n')
          .map((l) => (l.trim() ? '> ' + l : '>'))
          .join('\n');
        return `\n\n${quoted}\n\n`;
      }

      case 'UL':
      case 'OL': {
        const ordered = tag === 'OL';
        const start = Number(el.getAttribute('start') || 1);
        const items = Array.from(el.children).filter((c) => c.tagName === 'LI');
        let n = start;
        const lines = items.map((li) => {
          const txt = Array.from(li.childNodes).map((c) => mdOf(c, ctx)).join('').trim();
          const marker = ordered ? `${n++}. ` : '- ';
          const indent = ' '.repeat(marker.length);
          const body = txt.replace(/\n{2,}/g, '\n').replace(/\n/g, '\n' + indent);
          return marker + body;
        });
        return '\n\n' + lines.join('\n') + '\n\n';
      }

      case 'LI': {
        return inner();
      }

      case 'A': {
        const href = el.getAttribute('href') || '';
        const t = NS.util.normalizeText(inner());
        if (!t) return '';
        if (!href || href.startsWith('javascript:')) return t;
        // 站内锚点/引用标记直接保留文本
        if (href.startsWith('#')) return t;
        return `[${t}](${href})`;
      }

      case 'IMG': {
        if (ctx && ctx.imageMode === 'skip') return '';
        const src = el.getAttribute('src') || '';
        const alt = el.getAttribute('alt') || '图片';
        if (!src) return '';
        // 超长 data: URL 会让 Markdown 文件爆炸，默认省略
        if (src.startsWith('data:') && src.length > 512) return `![${alt}]()`;
        return `![${alt}](${src})`;
      }

      case 'TABLE':
        return tableToMd(el, ctx);

      case 'THEAD':
      case 'TBODY':
      case 'TFOOT':
      case 'TR':
      case 'TD':
      case 'TH':
        return inner();

      case 'DIV':
      case 'SECTION':
      case 'ARTICLE':
      case 'MAIN':
      case 'SPAN':
      case 'FONT':
      case 'SMALL':
      case 'U':
      case 'SUP':
      case 'SUB':
      default:
        return inner();
    }
  }

  /** 去掉行内标记，只留文字（用于标题这种不能嵌套强调的场景） */
  function stripInline(s) {
    return String(s).replace(/\*\*/g, '').replace(/(^|\s)\*(?=\S)/g, '$1').replace(/`/g, '');
  }

  /** 结果收尾：压缩多余空行、去掉行尾空格 */
  function tidy(md) {
    return String(md)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')
      .trim();
  }

  /**
   * @param {Element} root 已经剔除掉思考过程/工具调用等节点的容器副本
   * @param {object} opts { imageMode, shouldSkipElement }
   */
  function elementToMarkdown(root, opts) {
    const ctx = Object.assign({ imageMode: 'link', headingOffset: 0 }, opts || {});
    const out = mdOf(root, ctx);
    return tidy(out);
  }

  NS.markdown = { elementToMarkdown, tidy, UI_CLASS_RE };
})();
