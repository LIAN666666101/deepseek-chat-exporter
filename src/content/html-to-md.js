/**
 * html-to-md.js —— HTML → Markdown 转换器（纯函数，无外部依赖）
 *
 * 用途：把 DeepSeek 页面里已渲染的富文本（正文、代码块、表格、公式、列表）
 *       还原成 Maerkdown 源码。
 *
 * 针对 DeepSeek 页面做了三处专门处理：
 *  1. 代码块横幅：DeepSeek 把「语言名 + 复制按钮」的横幅塞在 <pre> 内部，
 *     直接取文本会把「python 复制」混进代码里，这里在提取前先摘除。
 *  2. 代码行容器：部分版本每个逻辑行是一个 <div class="md-code-block-line">，
 *     行与行之间没有换行符，直接取 textContent 会把所有行粘成一行。
 *  3. 公式：KaTeX 会把同一段公式渲染两遍（MathML + 视觉版），
 *     这里取 MathML 里的 LaTeX 源码，避免公式内容重复。
 */
(() => {
  'use strict';

  const DSMD = (globalThis.__DSMD__ || (globalThis.__DSMD__ = {}));

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'BUTTON', 'TEXTAREA',
    'INPUT', 'SELECT', 'IFRAME', 'VIDEO', 'AUDIO', 'TEMPLATE', 'LINK', 'META'
  ]);

  // 界面噪音：图标、工具条、复制/重新生成按钮、代码块横幅、骨架屏等
  const NOISE_CLASS_RE = /(?:^|[\s_-])(?:icons?|toolbar|actions?|btn|button|copy|banner|avatar|feedback|thumb|regenerate|share|spinner|skeleton|loading|sr-only|visually-hidden|katex-html|scrollbar)(?:[\s_-]|$)/i;
  const NOISE_TESTID_RE = /copy|toolbar|feedback|like|dislike|regenerate|share|menu|button/i;

  // 行容器识别（代码块换行还原）
  const LINE_CLASS_RE = /(?:^|[\s_-])lines?(?:$|[\s_-])|code-line/i;

  // 行内容器的保护标记：已生成的代码块不再参与空白规整
  const MARK = '\u0001';

  function isNoise(el) {
    if (SKIP_TAGS.has(String(el.tagName || '').toUpperCase())) return true;
    if (el.hasAttribute('hidden')) return true;
    if (el.getAttribute('aria-hidden') === 'true' && !el.querySelector('annotation')) return true;

    const style = el.getAttribute('style');
    if (style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;

    const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    if (cls && NOISE_CLASS_RE.test(cls)) return true;

    const testid = el.getAttribute('data-testid') || '';
    if (testid && NOISE_TESTID_RE.test(testid)) return true;

    return false;
  }

  function protect(ctx, text) {
    ctx.saved.push(text);
    return MARK + (ctx.saved.length - 1) + MARK;
  }

  function restore(text, ctx) {
    return text.replace(new RegExp(MARK + '(\\d+)' + MARK, 'g'), (m, i) => {
      const v = ctx.saved[Number(i)];
      return v === undefined ? '' : v;
    });
  }

  /* ------------------------------- 文本与内联 ------------------------------- */

  function sep(ctx) { return ctx.opts.plainText ? '\n' : '\n\n'; }

  function block(ctx, content) {
    const t = (content || '').trim();
    if (!t) return '';
    return sep(ctx) + t + sep(ctx);
  }

  function inline(ctx, el) {
    return convertChildren(el, ctx).trim();
  }

  function collapseSpace(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function codeSpan(ctx, text) {
    if (!text) return '';
    const ticks = '`'.repeat(longestRun(text, '`') + 1);
    const pad = /^`|`$/.test(text) ? ' ' : '';
    return protect(ctx, ticks + pad + text + pad + ticks);
  }

  function longestRun(text, ch) {
    let max = 0;
    const re = new RegExp('\\' + ch + '+', 'g');
    let m;
    while ((m = re.exec(text))) max = Math.max(max, m[0].length);
    return max;
  }

  /* --------------------------------- 代码块 --------------------------------- */

  // 取 <pre> 的纯文本，必要时按行容器重新插入换行
  function preText(pre) {
    const clone = pre.cloneNode(true);
    clone.querySelectorAll('[class*="banner"], [class*="toolbar"], [class*="copy"], button, svg')
      .forEach(n => n.remove());

    const lines = collectLineElements(clone);
    let text;
    if (lines.length > 1) {
      text = lines.map(e => (e.textContent || '').replace(/\n+$/, '')).join('\n');
    } else {
      text = clone.textContent || '';
    }

    return text
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/^[ \t]*\n+/, '')
      .replace(/[ \t]+$/gm, '');
  }

  // 找出代码行容器（最外层），找不到返回空数组
  function collectLineElements(root) {
    const found = [];
    root.querySelectorAll('*').forEach(el => {
      const cls = el.getAttribute('class') || '';
      if (!cls || !LINE_CLASS_RE.test(cls)) return;
      if (/\bline-number\b|gutter|lineno/i.test(cls)) return;      // 行号栏不参与
      if (found.some(p => p.contains(el))) return;                  // 只保留最外层
      found.push(el);
    });
    if (found.length > 1) return found;

    // 退化：<pre>/<code> 下若每个逻辑行是块级子元素，同样按行处理
    const blocks = [];
    const scan = n => {
      for (const c of n.children) {
        if (/^(DIV|P)$/.test(c.tagName)) {
          if (!blocks.some(b => b.contains(c))) blocks.push(c);
        } else {
          scan(c);
        }
      }
    };
    scan(root);
    return blocks.length > 1 ? blocks : [];
  }

  // 从横幅里取语言名。DeepSeek 的横幅把「语言名」与「复制」放在相邻节点里
  //（有时是同级的两个 div，有时是「python<button>复制</button>」），
  // 直接取 textContent 会得到「python复制」这种粘连文本，因此逐个文本节点找。
  function languageFromBanner(banner) {
    const doc = banner.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return '';

    const walker = doc.createTreeWalker(banner, 4 /* NodeFilter.SHOW_TEXT */);
    let node;
    while ((node = walker.nextNode())) {
      const text = collapseSpace(node.nodeValue || '');
      if (!text || text.length > 20) continue;
      if (/复制|拷贝|copy|下载|download|运行|run/i.test(text)) continue;

      const parentCls = (node.parentElement && (node.parentElement.getAttribute('class') || '')) || '';
      if (/copy|btn|action/i.test(parentCls)) continue;

      if (/^[\w+#.-]+$/.test(text)) return text;
    }

    // 退化：整个横幅文本里挑一个合法 token（粘连文本缺少边界，匹配失败属预期）
    const whole = collapseSpace(banner.textContent || '');
    if (!/复制|拷贝|copy/i.test(whole)) {
      const m = /(?:^|[\s|])([A-Za-z][\w+#.-]{0,19})(?=[\s|]|$)/.exec(whole);
      if (m) return m[1];
    }
    return '';
  }

  function preLanguage(pre) {
    const code = pre.querySelector('code');
    const cls = ((code && code.getAttribute('class')) || pre.getAttribute('class') || '');
    const m = /language-([\w+#.-]+)/i.exec(cls);
    if (m) return m[1];

    // 横幅可能在 pre 内部，也可能在 pre 外面的 md-code-block 外壳里
    let scope = pre;
    if (!scope.querySelector('[class*="banner"], [class*="lang"], [class*="header"]')) {
      const wrapper = (pre.closest && pre.closest('[class*="code-block"], [class*="codeblock"], [class*="highlight"]')) ||
        pre.parentElement;
      if (wrapper) scope = wrapper;
    }

    const banner = scope.querySelector('[class*="banner"], [class*="lang"], [class*="header"]');
    if (banner) {
      const lang = languageFromBanner(banner);
      if (lang) return lang;
    }

    const attr = pre.getAttribute('data-lang') || pre.getAttribute('lang') || '';
    return /^[\w+#.-]{1,20}$/.test(attr.trim()) ? attr.trim() : '';
  }

  function convertPre(pre, ctx) {
    const lang = preLanguage(pre);
    let body = preText(pre);

    // 少数版本会把语言名回显为代码首行，去掉避免重复
    if (lang) {
      const nl = body.indexOf('\n');
      const first = collapseSpace(nl === -1 ? body : body.slice(0, nl));
      if (first.toLowerCase() === lang.toLowerCase()) {
        body = nl === -1 ? '' : body.slice(nl + 1);
      }
    }

    if (!body.trim()) return '';

    // Mermaid 代码块：页面里已渲染出图形时，用图片占位引用（dsmd-img://N）替代源码，
    // 源码与 SVG 两个位置只输出一张图；没有渲染图可用时保留源码围栏（宁可给代码也不丢内容）
    if (/^mermaid$/i.test(lang || '')) {
      const token = DSMD.mermaid ? DSMD.mermaid.tokenForSource(body) : null;
      if (token) {
        if (ctx.mermaidUsed.has(token)) return '';
        ctx.mermaidUsed.add(token);
        return block(ctx, token);
      }
    }

    const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1));
    const out = fence + lang + '\n' + body.replace(/\n+$/, '') + '\n' + fence;
    return protect(ctx, out);
  }

  /* --------------------------------- 公式 --------------------------------- */

  function convertKatex(el, ctx) {
    const ann = el.querySelector('annotation[encoding="application/x-tex"]') || el.querySelector('annotation');
    const tex = ann ? (ann.textContent || '').trim() : '';
    const isDisplay = el.classList.contains('katex-display') ||
      !!(el.closest && el.closest('.katex-display'));

    if (tex) {
      if (isDisplay) return block(ctx, '$$\n' + tex + '\n$$');
      return protect(ctx, '$' + tex + '$');
    }

    // 没有 LaTeX 源码时退回可见文本，且只取视觉版本，避免 MathML 与视觉版重复
    const visual = el.querySelector('.katex-html');
    return collapseSpace((visual || el).textContent || '');
  }

  /* --------------------------------- 列表 --------------------------------- */

  function convertList(list, ctx) {
    const ordered = list.tagName === 'OL';
    const startAttr = parseInt(list.getAttribute('start') || '1', 10);
    const start = Number.isFinite(startAttr) ? startAttr : 1;
    const items = Array.from(list.children).filter(c => c.tagName === 'LI');
    if (!items.length) return block(ctx, convertChildren(list, ctx));

    const lines = [];

    items.forEach((li, idx) => {
      const nested = Array.from(li.children).filter(c => c.tagName === 'UL' || c.tagName === 'OL');

      // 任务列表
      const checkbox = li.querySelector('input[type="checkbox"]');
      let marker;
      if (checkbox) {
        marker = (checkbox.checked || checkbox.hasAttribute('checked')) ? '- [x] ' : '- [ ] ';
      } else {
        marker = ordered ? `${start + idx}. ` : '- ';
      }

      const clone = li.cloneNode(true);
      // 关键：移除谓词必须用「克隆树里」的嵌套列表对象——旧版拿原始 li 的 nested 引用
      // 与克隆节点比较（x === n 永远不命中），嵌套子列表从未被移出克隆体，
      // 于是正文转换与 nested.forEach 各转换一遍，子项目成对重复
      const cloneNested = Array.from(clone.children).filter(c => c.tagName === 'UL' || c.tagName === 'OL');
      clone.querySelectorAll('ul, ol, input[type="checkbox"]').forEach(n => {
        if (n.tagName === 'INPUT' || cloneNested.some(x => x === n || x.contains(n) || n.contains(x))) n.remove();
      });

      const body = convertChildren(clone, ctx).trim();
      const bodyLines = body.split('\n');
      if (bodyLines.length === 0 || !body) {
        lines.push(marker.trim());
      } else {
        lines.push(marker + bodyLines[0]);
        for (const extra of bodyLines.slice(1)) lines.push(' '.repeat(marker.length) + extra);
      }

      // 嵌套列表按标记宽度缩进；页面会把同一子列表渲染两遍（相同内容的兄弟 <ul>），
      // 按内容去重只保留一份
      const seenNested = new Set();
      nested.forEach(sub => {
        const subText = convertList(sub, ctx).trim();
        if (!subText) return;
        if (seenNested.has(subText)) return;
        seenNested.add(subText);
        for (const l of subText.split('\n')) lines.push(' '.repeat(marker.length) + l);
      });
    });

    // 相邻重复行收口：同缩进同文本连续出现视为重复渲染残留（空行不去重）
    const deduped = [];
    for (const l of lines) {
      if (deduped.length && deduped[deduped.length - 1] === l && l.trim()) continue;
      deduped.push(l);
    }

    return block(ctx, deduped.join('\n'));
  }

  /* --------------------------------- 表格 --------------------------------- */

  function tableRows(table) {
    let scoped = [];
    try {
      scoped = Array.from(table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr, :scope > tr'));
    } catch (e) {
      scoped = [];
    }
    const rows = scoped.length ? scoped : Array.from(table.querySelectorAll('tr'));
    // 嵌套表格的行不属于本表
    return rows.filter(tr => tr.closest('table') === table);
  }

  function cellText(cell, ctx) {
    const text = convertChildren(cell, ctx)
      .replace(/\n{2,}/g, '<br>')
      .replace(/\n/g, '<br>')
      .replace(/\|/g, '\\|')
      .trim();
    return text || ' ';
  }

  function convertTable(table, ctx) {
    const rows = tableRows(table);
    if (!rows.length) return '';

    const matrix = rows.map(tr =>
      Array.from(tr.children)
        .filter(c => c.tagName === 'TD' || c.tagName === 'TH')
        .map(cell => ({ text: cellText(cell, ctx), cell }))
    ).filter(r => r.length);

    if (!matrix.length) return '';

    const width = matrix.reduce((n, r) => Math.max(n, r.length), 0);
    const pad = r => { while (r.length < width) r.push({ text: ' ' }); return r; };

    const header = pad(matrix[0].slice());
    const body = matrix.slice(1).map(r => pad(r.slice()));

    const aligns = header.map(c => {
      const st = (c.cell && c.cell.getAttribute && (c.cell.getAttribute('style') || '')) || '';
      const al = (c.cell && c.cell.getAttribute && c.cell.getAttribute('align')) || '';
      if (/center/i.test(st) || /center/i.test(al)) return ':---:';
      if (/right/i.test(st) || /right/i.test(al)) return '---:';
      return '---';
    });

    const line = cells => '| ' + cells.map(c => c.text).join(' | ') + ' |';
    const out = [line(header), '| ' + aligns.join(' | ') + ' |', ...body.map(line)];
    return block(ctx, out.join('\n'));
  }

  /* -------------------------------- 主分发 -------------------------------- */

  function convertChildren(parent, ctx) {
    let out = '';
    for (const child of Array.from(parent.childNodes)) out += convertNode(child, ctx);
    return out;
  }

  function convertNode(node, ctx) {
    if (node.nodeType === 3) {
      const raw = node.nodeValue || '';
      if (ctx.opts.plainText) {
        return raw.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
      }
      return raw.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1) return '';

    const el = node;

    // SVG 是图形不是文本：已捕获的 Mermaid 图表输出占位引用（渲染端内嵌为图片），
    // 其余 SVG（含内部的节点文字、CSS）一律不导出——
    // 注意 SVG 元素的 tagName 是小写，旧版的大写 'SVG' 跳过规则从未命中，
    // 这正是「导出 SVG/CSS 代码文本」故障的根因。
    const lowerTag = String(el.tagName || '').toLowerCase();
    if (lowerTag === 'svg') {
      const token = DSMD.mermaid ? DSMD.mermaid.tokenForElement(el) : null;
      if (token && !ctx.mermaidUsed.has(token)) {
        ctx.mermaidUsed.add(token);
        return block(ctx, token);
      }
      return '';
    }

    if (isNoise(el)) return '';

    // KaTeX 公式（整块接管，避免 MathML 与视觉版重复输出）
    if (el.classList && (el.classList.contains('katex') || el.classList.contains('katex-display'))) {
      return convertKatex(el, ctx);
    }

    const tag = el.tagName;

    switch (tag) {
      case 'PRE':
        return convertPre(el, ctx);

      case 'CODE':
        return codeSpan(ctx, el.textContent || '');

      case 'BR':
        return ctx.opts.plainText ? '\n' : '\\\n';

      case 'HR':
        return block(ctx, '---');

      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
        const level = Number(tag.slice(1));
        const text = inline(ctx, el);
        return text ? block(ctx, '#'.repeat(level) + ' ' + text) : '';
      }

      case 'STRONG': case 'B': {
        const text = inline(ctx, el);
        return text ? '**' + text + '**' : '';
      }

      case 'EM': case 'I': {
        const text = inline(ctx, el);
        return text ? '*' + text + '*' : '';
      }

      case 'DEL': case 'S': case 'STRIKE': {
        const text = inline(ctx, el);
        return text ? '~~' + text + '~~' : '';
      }

      case 'A': {
        const href = el.getAttribute('href') || '';
        const text = inline(ctx, el);
        if (!href || /^javascript:/i.test(href)) return text;
        let url = href;
        if (ctx.opts.resolveUrl && typeof location !== 'undefined') {
          try { url = new URL(href, location.href).href; } catch { /* 保留原值 */ }
        }
        if (!text || text === url) return '<' + url + '>';
        return '[' + text + '](' + url.replace(/[()]/g, m => '\\' + m) + ')';
      }

      case 'IMG': {
        const alt = el.getAttribute('alt') || '';
        const src = el.getAttribute('src') || '';
        if (!src) return '';
        return '![' + alt + '](' + src + ')';
      }

      case 'UL': case 'OL':
        return convertList(el, ctx);

      case 'LI': {
        const text = convertChildren(el, ctx).trim();
        return text ? block(ctx, '- ' + text) : '';
      }

      case 'BLOCKQUOTE': {
        const inner = convertChildren(el, ctx).trim();
        if (!inner) return '';
        const quoted = inner.split('\n').map(l => (l ? '> ' + l : '>')).join('\n');
        return block(ctx, quoted);
      }

      case 'TABLE':
        return convertTable(el, ctx);

      case 'SUMMARY': {
        const text = inline(ctx, el);
        return text ? block(ctx, '**' + text + '**') : '';
      }

      case 'DETAILS': {
        const summary = el.querySelector(':scope > summary');
        const clone = el.cloneNode(true);
        clone.querySelectorAll('summary').forEach(n => n.remove());
        const head = summary ? block(ctx, '**' + inline(ctx, summary) + '**') : '';
        return head + block(ctx, convertChildren(clone, ctx));
      }

      case 'DT': {
        const text = inline(ctx, el);
        return text ? block(ctx, '**' + text + '**') : '';
      }

      case 'DD': {
        const text = inline(ctx, el);
        return text ? block(ctx, '  ' + text) : '';
      }

      case 'SUP': case 'SUB': {
        const text = inline(ctx, el);
        return text; // Markdown 无原生上下标，保留文本
      }

      case 'THEAD': case 'TBODY': case 'TFOOT': case 'TR': case 'TD': case 'TH':
        return block(ctx, convertChildren(el, ctx));

      default:
        break;
    }

    // 其余容器：块级加空行，行内直接透传
    const isBlock = /^(ADDRESS|ARTICLE|ASIDE|DIV|DL|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|HEADER|HGROUP|MAIN|NAV|P|SECTION|SPAN|TIME|LABEL|CENTER|FONT)$/.test(tag);
    const inner = convertChildren(el, ctx);
    if (!inner) return '';

    const blockLike = /^(ADDRESS|ARTICLE|ASIDE|DIV|DL|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|HEADER|HGROUP|MAIN|NAV|P|SECTION|CENTER|BLOCKQUOTE)$/.test(tag);
    return blockLike ? block(ctx, inner) : inner;
  }

  /* -------------------------------- 清洗收尾 -------------------------------- */

  function tidy(md, ctx) {
    let s = md.replace(/\r\n?/g, '\n');
    s = s.replace(/[ \t]+\n/g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    // 折叠正文中的连续空格，但保留行首缩进（列表层级）
    s = s.replace(/([^\n]) {2,}(?=[^\n])/g, '$1 ');
    // 中文标点前后的多余空格
    s = s.replace(/[ \t]+([，。！？；：、）】》」』])/g, '$1');
    s = s.replace(/([（【《「『])[ \t]+/g, '$1');
    s = s.trim();

    if (ctx.opts.plainText) {
      // 用户消息是 pre-wrap 纯文本，单换行是用户主动敲的，转成硬换行，
      // 否则 Markdown 渲染时会被吞成一个空格（空行仍保留为段落分隔）
      s = s.replace(/\n{3,}/g, '\n\n').replace(/([^\n\\])\n(?!\n)/g, '$1\\\n');
    }

    return restore(s, ctx);
  }

  function htmlToMarkdown(input, options) {
    const opts = Object.assign({ plainText: false, resolveUrl: true }, options || {});
    const doc = typeof document !== 'undefined' ? document : null;

    let top;
    if (typeof input === 'string') {
      if (!doc) return input.replace(/\s+/g, ' ').trim();
      top = doc.createElement('div');
      top.innerHTML = input;
    } else if (input && input.nodeType === 1) {
      top = input;
    } else {
      return '';
    }

    const ctx = { opts, saved: [], mermaidUsed: new Set() };
    const out = convertChildren(top, ctx);
    return tidy(out, ctx);
  }

  DSMD.htmlToMarkdown = htmlToMarkdown;
  DSMD.htmlToMarkdownInternal = {
    isNoise, preText, preLanguage, collectLineElements, longestRun
  };
})();
