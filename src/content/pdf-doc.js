/**
 * pdf-doc.js —— 生成 PDF（纯本地，无依赖、无网络）
 *
 * 实现方式：把对话排成一份「A4 分页文档」，再用 Edge 自身的打印引擎输出 PDF。
 *   - 为什么走打印：中文需要字体支持，浏览器内置的打印引擎可以直接用系统字体，
 *     不需要下载或内嵌任何字体文件（也就不需要网络、不需要额外权限）。
 *   - 分页与页码由我们自己算：先在离屏 iframe 里按 A4 内容宽度逐块量高、
 *     按页高切分，再把「第 X 页 共 Y 页」作为每页页脚的文本写进对应页面，
 *     所以页码是确定的、居中的，不依赖浏览器的页眉页脚设置。
 *
 * 版式：A4（210×297mm），左右边距 18mm，上边距 16mm，页脚区 14mm。
 */
(() => {
  'use strict';

  const DSMD = (globalThis.__DSMD__ || (globalThis.__DSMD__ = {}));

  const MM_PER_PX = 25.4 / 96;          // 96dpi 下 1px = 0.2646mm
  const CONTENT_WIDTH_MM = 174;         // 210 − 18×2
  const CONTENT_HEIGHT_MM = 253;        // 297 − 16（上）− 14（页脚区）− 14（下留白）
  const IMG_MAX_H_MM = 110;             // 行内上下文（列表/表格/引用）里的图片高度上限
  // 图块段落底距 2.8mm（.dfp-img margin-bottom）+ 1px 量高余量；
  // 长图切割时按「页内容高 − 该余量」定每条显示高，保证整块（含边距）不超页
  const IMG_SLICE_RESERVE_PX = Math.ceil(2.8 / MM_PER_PX) + 1;

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  /* ------------------------------ 用户上传图片 ------------------------------ */

  // 占位引用 dsmd-img://N → 图片记录
  function resolveImageRecord(href, imgMap) {
    const m = /^dsmd-img:\/\/(\d+)$/.exec(String(href || ''));
    if (!m || !imgMap) return null;
    return imgMap.get(Number(m[1])) || null;
  }

  // 独立图块：宽度尽可能占满版心（放大不超过 2 倍原生尺寸，避免小图拉伸模糊），
  // 高度等比、不设上限；显示高超过一页的长图由 sliceTallImages 预先横向切割成多条
  const IMG_MAX_UPSCALE = 2;
  function fitSizePx(rec) {
    let w = rec.width || 800;
    let h = rec.height || 600;
    if (w <= 0 || h <= 0) { w = 800; h = 600; }
    const targetW = Math.round(CONTENT_WIDTH_MM / MM_PER_PX);
    const scale = Math.min(targetW / w, IMG_MAX_UPSCALE);
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale };
  }

  // 行内上下文（列表 / 表格 / 引用里的图）：等比缩到容器内、不放大，避免撑破版面
  function fitCompactPx(rec) {
    let w = rec.width || 800;
    let h = rec.height || 600;
    if (w <= 0 || h <= 0) { w = 800; h = 600; }
    const maxW = CONTENT_WIDTH_MM / MM_PER_PX;
    const maxH = IMG_MAX_H_MM / MM_PER_PX;
    const scale = Math.min(1, maxW / w, maxH / h);
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
  }

  // 切割失败时的兜底：整图等比缩到「一页内」（宽占满与页高限高取小），宁可缩小不裁切
  function fitPagePx(rec, maxDisplayH) {
    let w = rec.width || 800;
    let h = rec.height || 600;
    if (w <= 0 || h <= 0) { w = 800; h = 600; }
    const scale = Math.min(CONTENT_WIDTH_MM / MM_PER_PX / w, maxDisplayH / h);
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
  }

  function imageHtml(node, imgMap, compact) {
    const rec = resolveImageRecord(node.href, imgMap);
    if (!rec) return `<span class="dfp-image">${esc(node.text ? `[图片：${node.text}]` : '[图片]')}</span>`;
    if (rec.status === 'embedded' && rec.dataUrl) {
      const size = compact ? fitCompactPx(rec) : fitSizePx(rec);
      return `<img class="dfp-img" src="${esc(rec.dataUrl)}" alt="${esc(node.text || '用户上传图片')}"` +
        ` style="width:${size.w}px;height:${size.h}px">`;
    }
    if (rec.status === 'remote' && rec.src) {
      return `<div class="dfp-img-missing">🖼 ${esc(node.text || '用户上传图片')}（图片可能需联网查看）` +
        `<br><span class="dfp-url">${esc(rec.src)}</span></div>`;
    }
    return `<div class="dfp-img-missing">（图片加载失败${rec.src ? `，原始地址 ${esc(rec.src)}` : ''}）</div>`;
  }

  /* ------------------------------- 行内 → HTML ------------------------------- */

  function inlineHtml(nodes, imgMap) {
    return (nodes || []).map(node => {
      switch (node.type) {
        case 'bold': return `<strong>${esc(node.text)}</strong>`;
        case 'italic': return `<em>${esc(node.text)}</em>`;
        case 'del': return `<del>${esc(node.text)}</del>`;
        case 'code': return `<code class="dfp-inline-code">${esc(node.text)}</code>`;
        case 'link': return `<a href="${esc(node.href)}">${esc(node.text)}</a>`;
        case 'image': return imageHtml(node, imgMap, true);
        case 'math': return `<span class="dfp-math">${esc(DSMD.mdParse.mathToText(node.text))}</span>`;
        case 'br': return '<br>';
        default: return esc(node.text || '');
      }
    }).join('');
  }

  /* ------------------------------ 块级 → HTML ------------------------------ */

  // 段落重排：把段落里的每张内嵌图拆出来独立成块。
  // 多图不再挤在同一段（否则只能整体限高塞进一页），文本片段仍按普通段落渲染。
  // 仅拆「已内嵌」的图；remote / failed 的占位提示保持行内。
  function segmentParagraph(inline, imgMap) {
    const segments = [];
    let cur = [];
    const flushText = () => {
      if (cur.length) segments.push({ type: 'text', nodes: cur });
      cur = [];
    };
    for (const node of inline || []) {
      const rec = node && node.type === 'image' ? resolveImageRecord(node.href, imgMap) : null;
      if (rec && rec.status === 'embedded' && rec.dataUrl) {
        flushText();
        segments.push({ type: 'image', rec });
      } else {
        cur.push(node);
      }
    }
    flushText();
    return segments;
  }

  // 文本片段是否没有实际内容（纯空白 / 换行）——不值得输出一个空段落
  function isEmptySegment(nodes) {
    return (nodes || []).every(n => !n || n.type === 'br' ||
      (n.type !== 'br' && !String(n.text || '').trim() && n.type !== 'image'));
  }

  // 独立图块：整块参与分页（不跨页截断）。已切割的长图每条一个图块，
  // 依次落到连续页面上。
  function imageBlockHtml(rec) {
    if (rec._slices && rec._slices.length > 1) {
      return rec._slices.map(s =>
        `<p class="dfp-p dfp-p-img"><img class="dfp-img" src="${esc(s.dataUrl)}"` +
        ` alt="${esc(rec.alt || '用户上传图片')}" style="width:${s.w}px;height:${s.h}px"></p>`).join('');
    }
    // _sliceFailed：切割不可用（解码/画布失败），整图等比缩到一页内，宁可缩小不裁切
    const size = rec._sliceFailed && rec._pageCapH
      ? fitPagePx(rec, rec._pageCapH) : fitSizePx(rec);
    return `<p class="dfp-p dfp-p-img"><img class="dfp-img" src="${esc(rec.dataUrl)}"` +
      ` alt="${esc(rec.alt || '用户上传图片')}" style="width:${size.w}px;height:${size.h}px"></p>`;
  }

  function blockHtml(block, imgMap) {
    switch (block.type) {
      case 'heading': {
        const level = Math.min(Math.max(block.level || 1, 1), 6);
        return `<div class="dfp-h${level}">${inlineHtml(DSMD.mdParse.parseInline(block.text), imgMap)}</div>`;
      }
      case 'paragraph': {
        const inline = block.inline || DSMD.mdParse.parseInline(block.text, { hard: true });
        return segmentParagraph(inline, imgMap).map(seg => {
          if (seg.type === 'image') return imageBlockHtml(seg.rec);
          if (isEmptySegment(seg.nodes)) return '';
          return `<p class="dfp-p">${inlineHtml(seg.nodes, imgMap)}</p>`;
        }).join('');
      }

      case 'list':
        // 每项独立成块，长列表可以跨页拆分；
        // 每 2 个空格缩进算一级，每级 4.5mm，保证子列表层级可辨
        return block.items.map(item => {
          const level = Math.max(0, Math.floor(item.indent / 2));
          const pad = (6 + level * 4.5).toFixed(2);
          return `<div class="dfp-li" style="padding-left:${pad}mm">` +
            `<span class="dfp-marker">${esc(item.marker)}</span> ` +
            `${inlineHtml(DSMD.mdParse.parseInline(item.text), imgMap)}</div>`;
        }).join('');

      case 'math':
        // 块级公式：LaTeX 转可读数学文本后居中呈现
        return `<div class="dfp-math-block">${esc(DSMD.mdParse.mathToText(block.text))}</div>`;

      case 'code':
        return `<div class="dfp-code">` +
          (block.lang ? `<div class="dfp-code-lang">${esc(block.lang)}</div>` : '') +
          (block.lines.length ? block.lines : ['']).map(line =>
            `<div class="cl">${esc(line === '' ? ' ' : line)}</div>`).join('') +
          `</div>`;

      case 'table': {
        const header = block.header.map(h => `<th>${inlineHtml(DSMD.mdParse.parseInline(h), imgMap)}</th>`).join('');
        const rows = block.rows.map(r =>
          `<tr>${r.map((c, i) => `<td class="dfp-td-${(block.aligns || [])[i] || 'left'}">` +
            `${inlineHtml(DSMD.mdParse.parseInline(c), imgMap)}</td>`).join('')}</tr>`).join('');
        return `<table class="dfp-table"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
      }

      case 'quote':
        return `<div class="dfp-quote">` + block.lines.map(line =>
          `<p class="dfp-p">${inlineHtml(DSMD.mdParse.parseInline(line), imgMap)}</p>`).join('') + `</div>`;

      case 'hr':
        return `<hr class="dfp-hr">`;

      default:
        return '';
    }
  }

  // 绝对序号 X/Y：X = 消息的虚拟列表编号（全文绝对位置，区间/单条导出时不变），
  // Y = 全文总消息数；无编号（接口通道等）时退化为导出列表内的顺序位置。
  function seqTextOf(msg, seqTotal, position) {
    if (!seqTotal) return '';
    const m = /^(\d+)$/.exec(String(msg && msg.virtualKey || ''));
    return m ? `${m[1]}/${seqTotal}` : `${position}/${seqTotal}`;
  }

  /** 对话 → 流水块 HTML（每个块都是可分页的最小单位） */
  function contentBlocks(messages, excludeThinking, imgMap, seqTotal) {
    const parts = [];

    const list = messages || [];
    for (let i = 0; i < list.length; i++) {
      const msg = list[i];
      const isUser = msg.role === 'user';
      // 分支序号（如「1 / 2」）与绝对序号（X/Y）右浮在角色标题同一行
      const branch = msg.branchNo
        ? `<span class="dfp-branch">${esc(msg.branchNo)}</span>` : '';
      const seq = seqTextOf(msg, seqTotal, i + 1);
      const seqHtml = seq ? `<span class="dfp-seq">${esc(seq)}</span>` : '';
      parts.push(`<div class="dfp-role ${isUser ? 'dfp-role-user' : 'dfp-role-ai'}">` +
        `${isUser ? 'User' : 'DeepSeek'}${seqHtml}${branch}</div>`);

      if (!excludeThinking && msg.thinking) {
        parts.push(`<div class="dfp-think-title">思考过程</div>`);
        for (const line of String(msg.thinking).split('\n')) {
          parts.push(`<div class="dfp-think">${esc(line === '' ? ' ' : line)}</div>`);
        }
      }

      for (const block of DSMD.mdParse.parseBlocks(msg.body)) {
        const html = blockHtml(block, imgMap);
        if (html) parts.push(html);
      }

      for (const extra of msg.extras || []) {
        parts.push(`<div class="dfp-think-title">${esc(extra.title || '附加内容')}</div>`);
        for (const line of String(extra.text || '').split('\n')) {
          parts.push(`<div class="dfp-think">${esc(line === '' ? ' ' : line)}</div>`);
        }
      }
    }

    return parts.join('');
  }

  /** 文档标题块 */
  function titleBlock(title) {
    return title ? `<div class="dfp-title">${esc(title)}</div>` : '';
  }

  /* --------------------------------- 样式 --------------------------------- */

  const PRINT_CSS = `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body {
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", "Hiragino Sans GB", sans-serif;
  font-size: 10.5pt; line-height: 1.7; color: #1f2328;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.page { position: relative; width: 210mm; height: 297mm; overflow: hidden; page-break-after: always; break-after: page; }
.page:last-of-type { page-break-after: auto; break-after: auto; }
.page-body { position: absolute; left: 18mm; top: 16mm; width: ${CONTENT_WIDTH_MM}mm; height: ${CONTENT_HEIGHT_MM}mm; overflow: hidden; }
.page-footer { position: absolute; left: 18mm; bottom: 9mm; width: ${CONTENT_WIDTH_MM}mm; text-align: center;
  font-size: 9pt; color: #57606a; font-variant-numeric: tabular-nums; }
.dfp-title { font-size: 18pt; font-weight: 700; color: #111827; margin: 0 0 5mm; padding-bottom: 2mm; border-bottom: 1px solid #d0d7de; }
.dfp-role { font-size: 14pt; font-weight: 700; margin: 6mm 0 2.5mm; padding-bottom: 1.2mm; border-bottom: 1px solid #d0d7de; }
.dfp-role-user { color: #1d4ed8; }
.dfp-role-ai { color: #0f766e; }
.dfp-p { margin: 0 0 2.6mm; white-space: normal; }
.dfp-h1 { font-size: 16pt; font-weight: 700; margin: 4mm 0 2mm; }
.dfp-h2 { font-size: 14pt; font-weight: 700; margin: 4mm 0 2mm; }
.dfp-h3 { font-size: 12.5pt; font-weight: 700; margin: 3.5mm 0 1.8mm; }
.dfp-h4 { font-size: 11.5pt; font-weight: 700; margin: 3mm 0 1.5mm; }
.dfp-h5 { font-size: 11pt; font-weight: 700; margin: 3mm 0 1.5mm; }
.dfp-h6 { font-size: 10.5pt; font-weight: 700; margin: 3mm 0 1.5mm; }
.dfp-li { margin: 0 0 1.4mm; position: relative; }
/* marker 绝对定位在 padding 区内：旧版用负缩进悬挂，
   会把 marker 拉出 .page-body（overflow:hidden）盒子被整块裁掉，列表符号因此消失 */
.dfp-marker { position: absolute; left: 0; min-width: 5mm; color: #57606a; }
.dfp-branch { float: right; font-size: 9pt; font-weight: 400; color: #57606a; }
/* 绝对序号 X/Y：标题字号的一半、置灰，与标题水平对齐 */
.dfp-seq { float: right; font-size: 0.5em; font-weight: 400; color: #888888; margin-right: 8px; }
.dfp-math { font-family: "Cambria Math", "Times New Roman", Georgia, serif; font-style: italic; }
.dfp-math-block { text-align: center; margin: 0 0 2.8mm; color: #1f2328;
  font-family: "Cambria Math", "Times New Roman", Georgia, serif; }
.dfp-code { background: #f6f8fa; border-left: 3px solid #d0d7de; border-radius: 1.5mm; padding: 2mm 3mm; margin: 0 0 2.8mm; }
.dfp-code-lang { font-size: 8.5pt; color: #6b7280; margin-bottom: 1mm; letter-spacing: 0.04em; }
.dfp-code .cl { font-family: Consolas, "Courier New", monospace; font-size: 9.5pt; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word; }
.dfp-inline-code { font-family: Consolas, "Courier New", monospace; font-size: 9.5pt; background: #f6f8fa;
  border: 1px solid #e5e7eb; border-radius: 1mm; padding: 0 1mm; }
.dfp-table { width: 100%; border-collapse: collapse; margin: 0 0 3mm; font-size: 10pt; }
.dfp-table th, .dfp-table td { border: 1px solid #d0d7de; padding: 1.2mm 2mm; }
.dfp-table th { background: #f6f8fa; font-weight: 700; }
.dfp-td-center { text-align: center; }
.dfp-td-right { text-align: right; }
.dfp-quote { border-left: 3px solid #d0d7de; padding-left: 3mm; color: #57606a; margin: 0 0 2.8mm; }
.dfp-hr { border: 0; border-top: 1px solid #d0d7de; margin: 3mm 0; }
.dfp-think-title { font-size: 10pt; font-weight: 700; color: #64748b; margin: 2mm 0 1mm; }
.dfp-think { color: #57606a; font-style: italic; margin: 0 0 1mm; padding-left: 3mm;
  border-left: 2px solid #e5e7eb; white-space: pre-wrap; word-break: break-word; }
.dfp-image { color: #64748b; font-style: italic; }
/* 用户上传图片：显式宽高（等比缩放后的确定值），整块参与分页、不跨页截断 */
.dfp-img { display: block; margin: 0 auto 2.8mm; border-radius: 1mm;
  page-break-inside: avoid; break-inside: avoid; }
.dfp-p-img { text-align: center; page-break-inside: avoid; break-inside: avoid; }
.dfp-img-missing { border: 1px dashed #d0d7de; border-radius: 1.5mm; color: #57606a;
  padding: 2.5mm 3mm; margin: 0 0 2.8mm; font-size: 9.5pt; text-align: center; }
.dfp-img-missing .dfp-url { font-size: 8.5pt; color: #6b7280; word-break: break-all; }
a { color: #1d4ed8; text-decoration: none; }
`;

  /* ------------------------------- 分页算法 ------------------------------- */

  // 需要与下一块同页的块：角色标题、各级小节标题——不能孤零零留在页尾
  function keepOf(block) {
    return block.keep === true || block.role === true;
  }

  /**
   * 贪心装箱：把块按顺序装进若干页（纯函数，便于单测）
   * 图片块（b.img）有两条额外规则：
   *   1. 每页最多一个图块——本页已放图片时，下一张图另起新页（严禁多图挤同一页）；
   *   2. 图片前只剩标题类 keep 块且放不下时，keep 块自成页、图片独占下一页，
   *      避免图片底部被 overflow:hidden 裁切。
   * @param {Array<{html:string, height:number, role?:boolean, keep?:boolean, img?:boolean}>} blocks
   * @param {number} maxHeight
   */
  function packPages(blocks, maxHeight) {
    const pages = [];
    let current = [];
    let used = 0;
    const heightOf = b => Math.max(0, b.height || 0);
    const sumOf = list => list.reduce((n, b) => n + heightOf(b), 0);
    const hasImg = list => list.some(b => b && b.img);

    for (const block of blocks) {
      const height = heightOf(block);

      if (block.img && current.length && hasImg(current)) {
        // 本页已有图片：整页收口（页尾 keep 块随带），图片另起新页
        const carried = [];
        while (current.length && keepOf(current[current.length - 1])) {
          carried.unshift(current.pop());
        }
        pages.push(current);
        current = carried;
        used = sumOf(carried);
      }

      if (current.length && used + height > maxHeight) {
        // 换页；页尾的 keep 块（角色标题 / 小节标题，含连续多个）整体带到新页，
        // 避免「3. 表格」这类标题孤零零留在页尾
        const carried = [];
        while (current.length && keepOf(current[current.length - 1])) {
          carried.unshift(current.pop());
        }
        if (current.length) {
          pages.push(current);
          current = carried;
          used = sumOf(carried);
        } else if (block.img) {
          // 整页都是 keep 块且图片放不下：keep 块自成页，图片独占下一页不裁切
          pages.push(current);
          current = [];
          used = 0;
        } else {
          // 整页都是 keep 块：不切页，新块直接跟进来（超高块由后方的满页判断兜底）
          current = carried;
          used = sumOf(carried);
        }
      }

      current.push(block);
      used += height;

      if (used >= maxHeight - 0.5) {
        // 页满收口：页尾的 keep 块（角色标题 / 小节标题）带到下一页，
        // 与换页时的 carry 同语义——「3. 表格」这类标题不能孤零零留在页尾
        const carried = [];
        while (current.length && keepOf(current[current.length - 1])) {
          carried.unshift(current.pop());
        }
        if (current.length) {
          pages.push(current);
          current = carried;
          used = sumOf(carried);
        } else {
          pages.push(current);
          current = [];
          used = 0;
        }
      }
    }

    if (current.length) pages.push(current);
    return pages;
  }

  /* ------------------------------ 页脚与文档 ------------------------------ */

  // 页脚格式：严格按「第X页 共Y页」
  const footerText = (page, total) => `第${page}页 共${total}页`;

  function buildDocument(title, pages) {
    const total = pages.length;
    const body = pages.map((blocks, i) =>
      `<div class="page"><div class="page-body">${blocks.map(b => b.html).join('')}</div>` +
      `<div class="page-footer">${footerText(i + 1, total)}</div></div>`).join('');

    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      `<title>${esc(title || '')}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
  }

  /* ------------------------------ 测量与拆分 ------------------------------ */

  function measureOf(win, el) {
    const rect = el.getBoundingClientRect();
    const cs = win.getComputedStyle(el);
    const mb = parseFloat(cs.marginBottom || '0') || 0;
    const mt = parseFloat(cs.marginTop || '0') || 0;
    return rect.height + mb + mt;
  }

  function measureFragment(flow, node) {
    flow.appendChild(node);
    const h = measureOf(flow.ownerDocument.defaultView, node);
    flow.removeChild(node);
    return h;
  }

  function collectBlocks(flow, maxHeight, depth) {
    const win = flow.ownerDocument.defaultView;
    const out = [];

    const keepOf = el => el.classList.contains('dfp-role') ||
      /(?:^|\s)dfp-h[1-6](?:\s|$)/.test(typeof el.className === 'string' ? el.className : '');

    const push = (el, level) => {
      if (!el || el.nodeType !== 1) return;
      const h = measureOf(win, el);
      // 独立图块（整段只有图）：整块参与分页、每页至多一个，不参与子块拆分
      const isImgBlock = el.classList.contains('dfp-p-img');

      if (h <= maxHeight || isImgBlock) {
        out.push({ html: el.outerHTML, height: Math.min(h, maxHeight),
          role: el.classList.contains('dfp-role'), keep: keepOf(el), img: isImgBlock });
        return;
      }

      if (level >= 3 || !el.children.length) {
        out.push({ html: el.outerHTML, height: Math.min(h, maxHeight), role: el.classList.contains('dfp-role'), keep: keepOf(el) });
        return;
      }

      if (el.classList.contains('dfp-code')) return splitLines(el, out, maxHeight, flow, level);
      if (el.tagName === 'TABLE') return splitTable(el, out, maxHeight, flow, level);
      return splitChildren(el, out, maxHeight, flow, level, push);
    };

    Array.from(flow.children).forEach(el => push(el, 0));
    return out;
  }

  // 代码块按行拆分
  function splitLines(el, out, maxHeight, flow, level) {
    const lines = Array.from(el.children).filter(n => !n.classList.contains('dfp-code-lang'));
    const chunks = [];
    let current = [];

    for (const line of lines) {
      const probe = el.cloneNode(false);
      current.forEach(n => probe.appendChild(n.cloneNode(true)));
      probe.appendChild(line.cloneNode(true));
      if (current.length && measureFragment(flow, probe) > maxHeight) {
        chunks.push(current);
        current = [line];
      } else {
        current.push(line);
      }
    }
    if (current.length) chunks.push(current);

    for (const chunk of chunks) {
      const wrapper = el.cloneNode(false);
      const lang = el.querySelector('.dfp-code-lang');
      if (lang) wrapper.appendChild(lang.cloneNode(true));
      chunk.forEach(n => wrapper.appendChild(n.cloneNode(true)));
      out.push({ html: wrapper.outerHTML, height: measureFragment(flow, wrapper.cloneNode(true)) });
    }
    return out;
  }

  // 表格按行拆分，每页重复表头
  function splitTable(el, out, maxHeight, flow) {
    const head = el.querySelector('thead');
    const rows = Array.from(el.querySelectorAll('tbody > tr'));
    if (!rows.length) {
      out.push({ html: el.outerHTML, height: Math.min(measureOf(flow.ownerDocument.defaultView, el), maxHeight) });
      return out;
    }

    const chunks = [];
    let current = [];

    for (const row of rows) {
      const probe = el.cloneNode(false);
      if (head) probe.appendChild(head.cloneNode(true));
      const tbody = flow.ownerDocument.createElement('tbody');
      current.forEach(r => tbody.appendChild(r.cloneNode(true)));
      tbody.appendChild(row.cloneNode(true));
      probe.appendChild(tbody);
      if (current.length && measureFragment(flow, probe) > maxHeight) {
        chunks.push(current);
        current = [row];
      } else {
        current.push(row);
      }
    }
    if (current.length) chunks.push(current);

    for (const chunk of chunks) {
      const wrapper = el.cloneNode(false);
      if (head) wrapper.appendChild(head.cloneNode(true));
      const tbody = flow.ownerDocument.createElement('tbody');
      chunk.forEach(r => tbody.appendChild(r.cloneNode(true)));
      wrapper.appendChild(tbody);
      out.push({ html: wrapper.outerHTML, height: measureFragment(flow, wrapper.cloneNode(true)) });
    }
    return out;
  }

  // 通用容器按子元素拆分（列表、引用等）
  function splitChildren(el, out, maxHeight, flow, level, push) {
    const win = flow.ownerDocument.defaultView;
    let batch = [];

    const flush = () => {
      if (!batch.length) return;
      const wrapper = el.cloneNode(false);
      batch.forEach(n => wrapper.appendChild(n.cloneNode(true)));
      const h = measureFragment(flow, wrapper.cloneNode(true));
      out.push({ html: wrapper.outerHTML, height: Math.min(h, maxHeight) });
      batch = [];
    };

    for (const child of Array.from(el.children)) {
      const probe = el.cloneNode(false);
      batch.forEach(n => probe.appendChild(n.cloneNode(true)));
      probe.appendChild(child.cloneNode(true));
      if (batch.length && measureOf(win, probe) > maxHeight) flush();
      batch.push(child);
    }
    flush();
    return out;
  }

  /* --------------------------------- 入口 --------------------------------- */

  // 长图预切割：占满版心后显示高超过 maxDisplayH 的内嵌图，按源像素横向切成多条
  // （每条显示高 ≤ maxDisplayH），切好的条目写入 rec._slices，渲染时逐条独立成块。
  // 切割失败时标记 rec._sliceFailed / rec._pageCapH，渲染退化为「整图缩进一页」。
  async function sliceTallImages(imgMap, maxDisplayH) {
    const jobs = [];
    for (const rec of imgMap.values()) {
      if (!rec || rec.status !== 'embedded' || !rec.dataUrl) continue;
      const size = fitSizePx(rec);
      if (size.h <= maxDisplayH) continue;
      const srcRows = Math.max(1, Math.round(maxDisplayH / size.scale));
      jobs.push((async () => {
        try {
          const slices = await (DSMD.imageTools && DSMD.imageTools.sliceDataUrl
            ? DSMD.imageTools.sliceDataUrl(rec.dataUrl, rec.width || 800, rec.height || 600, srcRows)
            : null);
          if (slices && slices.length > 1) {
            rec._slices = slices.map(s => ({
              dataUrl: s.dataUrl,
              w: Math.max(1, Math.round((rec.width || 800) * size.scale)),
              h: Math.max(1, Math.round(s.height * size.scale))
            }));
          } else {
            rec._sliceFailed = true;
            rec._pageCapH = maxDisplayH;
          }
        } catch (e) {
          rec._sliceFailed = true;
          rec._pageCapH = maxDisplayH;
        }
      })());
    }
    await Promise.all(jobs);
  }

  const FRAME_ID = 'dsmd-print-frame';

  function ensureFrame() {
    let frame = document.getElementById(FRAME_ID);
    if (frame && frame.isConnected) return frame;
    frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.setAttribute('aria-hidden', 'true');
    // 必须真实渲染才能量到高度，因此移出可视区而不是 display:none
    frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:210mm;height:297mm;' +
      'border:0;visibility:visible;pointer-events:none;';
    (document.body || document.documentElement).appendChild(frame);
    return frame;
  }

  function removeFrame() {
    const frame = document.getElementById(FRAME_ID);
    if (frame) frame.remove();
  }

  // 等待离屏文档里的图片加载完（数据 URL 解码很快；加载失败不阻塞导出）
  function waitFrameImages(win, doc, timeoutMs) {
    try {
      const pending = Array.from((doc && doc.images) || []).filter(i => !i.complete);
      if (!pending.length) return Promise.resolve();
      return Promise.race([
        Promise.all(pending.map(img => new Promise(res => {
          img.addEventListener('load', () => res(), { once: true });
          img.addEventListener('error', () => res(), { once: true });
        }))),
        new Promise(res => setTimeout(res, timeoutMs || 8000))
      ]);
    } catch (e) { return Promise.resolve(); }
  }

  /**
   * 生成 PDF：排好 A4 分页（含「第 X 页 共 Y 页」页脚）后调用打印
   * @param {{title: string, messages: Array, excludeThinking: boolean, images?: Array}} input
   * @returns {Promise<{pages:number, printed:boolean}>}
   */
  async function exportPdf(input) {
    const opts = input || {};
    const title = opts.title || 'DeepSeek 对话';
    const imgMap = new Map((opts.images || []).map(r => [r.id, r]));
    const frame = ensureFrame();
    const doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
    if (!doc) return { pages: 0, printed: false };

    const maxHeight = CONTENT_HEIGHT_MM / MM_PER_PX;      // px
    // 单条图片显示高上限：页内容高 − 图块底距余量；超过此高的长图先切割再排版
    const maxDisplayH = Math.floor(maxHeight) - IMG_SLICE_RESERVE_PX;

    // 第零步：长图预切割（画布在主页面上运行，数据 URL 不受跨域污染）
    await sliceTallImages(imgMap, maxDisplayH);

    // 第一步：把内容写进离屏文档，等图片就位后逐块量高
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8">' +
      `<style>${PRINT_CSS}</style></head><body>` +
      `<div class="page"><div class="page-body" id="dfp-flow">` +
      titleBlock(title) + contentBlocks(opts.messages, opts.excludeThinking !== false, imgMap,
        Number(opts.seqTotal) || 0) +
      '</div></div></body></html>');
    doc.close();

    await waitFrameImages(frame.contentWindow, doc);

    const flow = doc.getElementById('dfp-flow');
    const blocks = collectBlocks(flow, maxHeight, 0);
    const pages = packPages(blocks, maxHeight);

    // 第二步：写入最终文档（每页一个 .page，页脚带确定页码），图片就位后再调用打印
    doc.open();
    doc.write(buildDocument(title, pages));
    doc.close();

    await waitFrameImages(frame.contentWindow, doc);

    let printed = false;
    try {
      const win = frame.contentWindow;
      win.focus();
      win.print();
      printed = true;
    } catch (e) {
      printed = false;
    }

    // 打印对话框关闭后清理离屏 iframe（附超时兜底，避免残留 DOM）
    const win = frame.contentWindow;
    if (win) {
      const cleanup = () => removeFrame();
      try { win.addEventListener('afterprint', cleanup, { once: true }); } catch (e) { /* 忽略 */ }
      setTimeout(cleanup, 180000);
    }

    return { pages: pages.length, printed };
  }

  DSMD.pdf = {
    exportPdf,
    buildDocument,
    packPages,
    contentBlocks,
    titleBlock,
    PRINT_CSS,
    footerText,
    resolveImageRecord,
    sliceTallImages,
    fitSizePx,
    fitCompactPx,
    fitPagePx
  };
})();
