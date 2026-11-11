/**
 * docx.js —— 生成 Word（.docx）文件（纯本地，无依赖）
 *
 * 实现方式：直接产出 OOXML 包（zip + XML），不引入任何第三方库，
 * 因此不需要网络、不需要额外权限。
 *
 * 页脚页码用 Word 自身的域实现：PAGE / NUMPAGES，配合 settings.xml 里的
 * updateFields，打开文档即显示「第 X 页 共 Y 页」，且随内容分页自动更新。
 * 页脚段落用 <w:jc w:val="center"/> 居中。
 */
(() => {
  'use strict';

  const DSMD = (globalThis.__DSMD__ || (globalThis.__DSMD__ = {}));

  const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
  const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const NS_PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
  const USABLE_TWIPS = 9866;               // A4 宽 11906 − 左右页边距 1020×2
  const HEADER_FILL = 'F6F8FA';
  const ROLE_COLORS = { user: '1D4ED8', assistant: '0F766E' };
  const HEADING_SIZES = [32, 28, 26, 24, 22, 21];   // h1..h6，单位为半磅
  const EMU_PER_PX = 9525;                 // 1px（96dpi）= 9525 EMU
  // 版心尺寸换算为 px（1twip = 1/20pt，96dpi 下 1pt = 4/3px）：
  // 宽 = 9866/20×4/3 ≈ 657.7px；高 = (16838−1134×2)/20×4/3 ≈ 971.3px
  const CONTENT_W_PX = USABLE_TWIPS / 20 * (96 / 72);
  const CONTENT_H_PX = (16838 - 1134 * 2) / 20 * (96 / 72);
  // 单条图片显示高上限：版心高减去段前段后间距（60+120 twip ≈ 12px）再留余量；
  // 超过此高的长图先横向切割再逐条插入，由 Word 按页高自然分页
  const IMG_SLICE_MAX_H_PX = Math.floor(CONTENT_H_PX) - 24;
  const IMG_CTYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  /* ------------------------------ 用户上传图片 ------------------------------ */

  // 正文里的占位引用（dom-extractor 写入）指向的图片记录
  function resolveImageRecord(href, ctx) {
    const m = /^dsmd-img:\/\/(\d+)$/.exec(String(href || ''));
    if (!m || !ctx || !ctx.imageById) return null;
    return ctx.imageById.get(Number(m[1])) || null;
  }

  // 版心全宽显示（宽度尽可能占满，放大不超过 2 倍原生尺寸；高度等比不限），
  // 长图由 sliceDocxImages 预先切割；capHPx 仅用于切割失败时的兜底：
  // 整图缩到一页高以内，宁可缩小不依赖 Word 裁切。尺寸未知时按 4:3 兜底
  const IMG_MAX_UPSCALE = 2;
  function fitExtent(rec, capHPx) {
    let w = rec.width || 800;
    let h = rec.height || 600;
    if (w <= 0 || h <= 0) { w = 800; h = 600; }
    let scale = Math.min(CONTENT_W_PX / w, IMG_MAX_UPSCALE);
    if (capHPx) scale = Math.min(scale, capHPx / h);
    return {
      cx: Math.max(9525, Math.round(w * scale * EMU_PER_PX)),
      cy: Math.max(9525, Math.round(h * scale * EMU_PER_PX))
    };
  }

  // 登记媒体部件（同一图片只入包一次），返回关系 id
  function mediaRef(rec, ctx) {
    const hit = ctx.media.find(m => m.id === rec.id);
    if (hit) return hit.rid;
    const rid = `rId${ctx.nextRelId++}`;
    ctx.media.push({
      rid,
      id: rec.id,
      filename: rec.filename || `user-${String(ctx.media.length + 1).padStart(3, '0')}.${rec.ext || 'png'}`,
      ext: rec.ext || 'png',
      bytes: DSMD.zip && DSMD.zip.base64Decode
        ? DSMD.zip.base64Decode(rec.b64 || (rec.dataUrl || '').replace(/^data:[^;,]+;base64,/, ''))
        : new Uint8Array(0)
    });
    return rid;
  }

  // 切条各自作为独立媒体部件入包（字节互不相同）：合成 id「原图id#s序号」去重，
  // 文件名沿用原图名加序号；扩展名取切割时的实际重编码格式（jpeg / png）
  function sliceMediaRef(rec, k, ctx) {
    const sliceId = `${rec.id}#s${k}`;
    const hit = ctx.media.find(m => m.id === sliceId);
    if (hit) return hit.rid;
    const slice = rec._slices[k];
    const base = String(rec.filename || `image-${rec.id}`).replace(/\.[a-z0-9]+$/i, '');
    const rid = `rId${ctx.nextRelId++}`;
    ctx.media.push({
      rid,
      id: sliceId,
      filename: `${base}-s${String(k + 1).padStart(2, '0')}.${slice.ext || 'png'}`,
      ext: slice.ext || 'png',
      bytes: DSMD.zip && DSMD.zip.base64Decode
        ? DSMD.zip.base64Decode((slice.dataUrl || '').replace(/^data:[^;,]+;base64,/, ''))
        : new Uint8Array(0)
    });
    return rid;
  }

  function sliceName(rec, k) {
    const base = String(rec.filename || `image-${rec.id}`).replace(/\.[a-z0-9]+$/i, '');
    return `${base}-s${String(k + 1).padStart(2, '0')}`;
  }

  // 行内上下文（列表 / 表格 / 引用里的图）：等比缩到版心内、不放大、限高，
  // 避免撑破缩进后的行宽
  function fitCompactExtent(rec) {
    let w = rec.width || 800;
    let h = rec.height || 600;
    if (w <= 0 || h <= 0) { w = 800; h = 600; }
    const scale = Math.min(1, CONTENT_W_PX / w, CONTENT_H_PX * 0.6 / h);
    return {
      cx: Math.max(9525, Math.round(w * scale * EMU_PER_PX)),
      cy: Math.max(9525, Math.round(h * scale * EMU_PER_PX))
    };
  }

  // 独立图片段：每张图独立成段（居中，前后留间距），Word 对放不下的整段图片
  // 会自动推到下一页（inline 图片所在行不可拆分），不会压缩图片。
  // 长图切条后逐条成段、条间距为 0，在连续页面上视觉接近整图。
  function imageParasXml(rec, ctx) {
    if (rec._slices && rec._slices.length > 1) {
      const n = rec._slices.length;
      return rec._slices.map((s, k) => {
        const { cx, cy } = fitExtent(s);
        const rid = sliceMediaRef(rec, k, ctx);
        return para(drawingXml(rid, cx, cy, sliceName(rec, k), ctx.drawingId++), {
          align: 'center',
          spaceBefore: k === 0 ? 60 : 0,
          spaceAfter: k === n - 1 ? 120 : 0
        });
      }).join('');
    }
    // _sliceFailed：切割不可用（解码/画布失败），整图缩到一页高以内兜底
    const { cx, cy } = fitExtent(rec, rec._sliceFailed ? IMG_SLICE_MAX_H_PX : 0);
    const rid = mediaRef(rec, ctx);
    return para(drawingXml(rid, cx, cy, rec.filename, ctx.drawingId++),
      { align: 'center', spaceBefore: 60, spaceAfter: 120 });
  }

  // 内嵌图片的 <w:drawing>（inline）：真实分页由 Word 完成，图片随文流动、不跨页截断
  function drawingXml(rid, cx, cy, name, docPrId) {
    return '<w:r><w:rPr><w:noProof/></w:rPr><w:drawing>' +
      `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${cx}" cy="${cy}"/>` +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
      `<wp:docPr id="${docPrId}" name="${esc(name)}"/>` +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      `<a:graphic><a:graphicData uri="${NS_PIC}">` +
      '<pic:pic>' +
      `<pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
  }

  // 嵌入成功返回 drawing run；否则返回 null，由调用方按降级策略渲染。
  // 此入口供行内上下文（列表 / 表格 / 引用 / 普通图文混排段）使用，走紧凑尺寸；
  // 独立图片段走 imageParasXml（版心全宽 + 长图切条）。
  function imageRunXml(node, ctx) {
    const rec = resolveImageRecord(node.href, ctx);
    if (!rec || rec.status !== 'embedded' || !rec.dataUrl) return null;
    if (rec._slices && rec._slices.length > 1) {
      return rec._slices.map((s, k) => {
        const { cx, cy } = fitCompactExtent(s);
        const rid = sliceMediaRef(rec, k, ctx);
        return drawingXml(rid, cx, cy, sliceName(rec, k), ctx.drawingId++);
      }).join('');
    }
    const { cx, cy } = fitCompactExtent(rec);
    const rid = mediaRef(rec, ctx);
    return drawingXml(rid, cx, cy, rec.filename, ctx.drawingId++);
  }

  // 降级渲染：跨域图 → 原地址超链接 + 提示；加载失败 → 文字占位
  function imageFallbackRuns(node, ctx) {
    const rec = resolveImageRecord(node.href, ctx);
    if (!rec) {
      return run(node.text ? `[图片：${node.text}]` : '[图片]', { italic: true, color: '64748B' });
    }
    if (rec.status === 'remote' && rec.src) {
      return hyperlink(rec.src, run('🖼 图片可能需联网查看（点击打开原图）',
        Object.assign({}, { italic: true, link: true, underline: true, color: '1D4ED8' })), ctx);
    }
    return run(rec.status === 'remote' ? '🖼 图片可能需联网查看' : '（图片加载失败）',
      { italic: true, color: '64748B' });
  }

  /* ------------------------------ 行内元素 → run ------------------------------ */

  function run(text, props) {
    const p = props || {};
    const rPr = [];
    if (p.code) rPr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="微软雅黑" w:cs="Consolas"/>');
    if (p.bold) rPr.push('<w:b/>');
    if (p.italic) rPr.push('<w:i/>');
    if (p.strike) rPr.push('<w:strike/>');
    if (p.underline || p.link) rPr.push('<w:u w:val="single"/>');
    if (p.color) rPr.push(`<w:color w:val="${p.color}"/>`);
    if (p.size) rPr.push(`<w:sz w:val="${p.size}"/><w:szCs w:val="${p.size}"/>`);
    if (p.shade) rPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${p.shade}"/>`);
    const inner = text === '' ? '' : `<w:t xml:space="preserve">${esc(text)}</w:t>`;
    return `<w:r>${rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : ''}${inner}</w:r>`;
  }

  function hyperlink(url, innerXml, ctx) {
    if (!url || !/^https?:\/\//i.test(url)) return innerXml;
    let id = ctx.links.get(url);
    if (!id) {
      id = `rId${ctx.nextRelId++}`;
      ctx.links.set(url, id);
    }
    return `<w:hyperlink r:id="${id}" w:history="1">${innerXml}</w:hyperlink>`;
  }

  function inlineRuns(nodes, base, ctx) {
    const out = [];
    for (const node of nodes || []) {
      switch (node.type) {
        case 'text':
          out.push(run(node.text, base));
          break;
        case 'bold':
          out.push(run(node.text, Object.assign({}, base, { bold: true })));
          break;
        case 'italic':
          out.push(run(node.text, Object.assign({}, base, { italic: true })));
          break;
        case 'del':
          out.push(run(node.text, Object.assign({}, base, { strike: true })));
          break;
        case 'code':
          out.push(run(node.text, Object.assign({}, base, { code: true, shade: HEADER_FILL })));
          break;
        case 'link':
          out.push(hyperlink(node.href, run(node.text, Object.assign({}, base, {
            link: true, underline: true, color: '1D4ED8'
          })), ctx));
          break;
        case 'image': {
          const drawing = imageRunXml(node, ctx);
          if (drawing) { out.push(drawing); break; }
          out.push(imageFallbackRuns(node, ctx));
          break;
        }
        case 'math':
          // 行内公式：LaTeX 转可读数学文本，斜体呈现
          out.push(run(DSMD.mdParse.mathToText(node.text), Object.assign({}, base, { italic: true })));
          break;
        case 'br':
          out.push('<w:r><w:br/></w:r>');
          break;
        default:
          if (node.text) out.push(run(node.text, base));
      }
    }
    return out.join('');
  }

  /* ------------------------------- 段落与块级 ------------------------------- */

  function para(runsXml, props) {
    const p = props || {};
    const pPr = [];
    if (p.style) pPr.push(`<w:pStyle w:val="${p.style}"/>`);
    if (p.align) pPr.push(`<w:jc w:val="${p.align}"/>`);
    if (p.tabs) pPr.push(`<w:tabs><w:tab w:val="right" w:pos="${p.tabs}"/></w:tabs>`);
    if (p.indentLeft || p.hanging) {
      pPr.push(`<w:ind${p.indentLeft ? ` w:left="${p.indentLeft}"` : ''}${p.hanging ? ` w:hanging="${p.hanging}"` : ''}/>`);
    }
    if (p.borderBottom) {
      pPr.push(`<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="D0D7DE"/></w:pBdr>`);
    }
    const spacing = [];
    if (p.spaceBefore != null) spacing.push(`w:before="${p.spaceBefore}"`);
    if (p.spaceAfter != null) spacing.push(`w:after="${p.spaceAfter}"`);
    if (p.line) spacing.push(`w:line="${p.line}" w:lineRule="auto"`);
    if (spacing.length) pPr.push(`<w:spacing ${spacing.join(' ')}/>`);
    if (p.keepNext) pPr.push('<w:keepNext/>');
    if (p.shade) pPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${p.shade}"/>`);

    return `<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}${runsXml || ''}</w:p>`;
  }

  function headingPara(block, ctx) {
    const level = Math.min(Math.max(block.level || 1, 1), 6);
    const size = HEADING_SIZES[level - 1];
    const runs = inlineRuns(DSMD.mdParse.parseInline(block.text), { bold: true, size }, ctx);
    return para(runs, { style: `Heading${level}`, keepNext: true, spaceBefore: 200, spaceAfter: 80 });
  }

  function listParas(block, ctx) {
    const out = [];
    for (const item of block.items) {
      // 每 2 个空格缩进算一级，每级 360 twips（约 0.63cm），层级清晰可辨
      const level = Math.max(0, Math.floor(item.indent / 2));
      const base = { indentLeft: 360 + level * 360 };
      const marker = `${item.marker} `;
      const runs = run(marker, { bold: false }) +
        inlineRuns(DSMD.mdParse.parseInline(item.text), {}, ctx);
      out.push(para(runs, Object.assign(base, { hanging: 260, spaceAfter: 40 })));
    }
    return out.join('');
  }

  function codeParas(block) {
    const out = [];
    const lines = block.lines.length ? block.lines : [''];
    lines.forEach((line, i) => {
      out.push(para(run(line === '' ? ' ' : line, { code: true, size: 19 }), {
        shade: HEADER_FILL,
        indentLeft: 120,
        spaceAfter: i === lines.length - 1 ? 160 : 0,
        spaceBefore: i === 0 ? 60 : 0,
        keepNext: i < lines.length - 1
      }));
    });
    return out.join('');
  }

  function tableXml(block, ctx) {
    const cols = Math.max(block.header.length, ...block.rows.map(r => r.length), 1);
    const width = Math.floor(USABLE_TWIPS / cols);
    const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map(side => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>`).join('');

    const cell = (text, isHeader, align) => {
      const runs = inlineRuns(DSMD.mdParse.parseInline(text), isHeader ? { bold: true } : {}, ctx);
      const pPr = `<w:pPr><w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/>` +
        (align && align !== 'left' ? `<w:jc w:val="${align}"/>` : '') + '</w:pPr>';
      return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>` +
        (isHeader ? `<w:shd w:val="clear" w:color="auto" w:fill="${HEADER_FILL}"/>` : '') +
        `</w:tcPr><w:p>${pPr}${runs}</w:p></w:tc>`;
    };

    const row = (cells, isHeader) => '<w:tr>' + cells.map((c, i) =>
      cell(c, isHeader, (block.aligns || [])[i])).join('') + '</w:tr>';

    const header = block.header.map(h => h || ' ');
    const body = block.rows.map(r => {
      const cells = r.slice(0, cols);
      while (cells.length < cols) cells.push(' ');
      return cells;
    });

    return '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>' +
      `<w:tblBorders>${borders}</w:tblBorders>` +
      '<w:tblLayout w:type="fixed"/></w:tblPr>' +
      `<w:tblGrid>${header.map(() => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>` +
      row(header, true) + body.map(r => row(r, false)).join('') +
      '</w:tbl>' + para('', { spaceAfter: 120 });
  }

  // 段落重排：把段落里的每张内嵌图拆出来独立成段（与 PDF 同一策略）。
  // 多图不再挤在同一段；文本片段仍按普通段落渲染。仅拆「已内嵌」的图。
  function segmentParagraph(inline, ctx) {
    const segments = [];
    let cur = [];
    const flushText = () => {
      if (cur.length) segments.push({ type: 'text', nodes: cur });
      cur = [];
    };
    for (const node of inline || []) {
      const rec = node && node.type === 'image' ? resolveImageRecord(node.href, ctx) : null;
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

  function blockXml(block, ctx) {
    switch (block.type) {
      case 'heading':
        return headingPara(block, ctx);
      case 'paragraph': {
        const inline = block.inline || DSMD.mdParse.parseInline(block.text, { hard: true });
        return segmentParagraph(inline, ctx).map(seg => {
          if (seg.type === 'image') return imageParasXml(seg.rec, ctx);
          if (isEmptySegment(seg.nodes)) return '';
          return para(inlineRuns(seg.nodes, {}, ctx), { spaceAfter: 120 });
        }).join('');
      }
      case 'list':
        return listParas(block, ctx);
      case 'code':
        return codeParas(block);
      case 'table':
        return tableXml(block, ctx);
      case 'quote':
        return block.lines.map(line => para(
          inlineRuns(DSMD.mdParse.parseInline(line), { italic: true, color: '57606A' }, ctx),
          { indentLeft: 360, spaceAfter: 40 }
        )).join('');
      case 'math':
        // 块级公式：独立居中段，斜体呈现可读数学文本
        return para(run(DSMD.mdParse.mathToText(block.text), { italic: true, size: 22 }),
          { align: 'center', spaceBefore: 60, spaceAfter: 120 });
      case 'hr':
        return para('', { borderBottom: true, spaceBefore: 80, spaceAfter: 160 });
      default:
        return '';
    }
  }

  /* --------------------------------- 页脚 --------------------------------- */

  // PAGE / NUMPAGES 是 Word 的域，打开文档时由 Word 计算真实页码
  function fieldRun(instr) {
    const rPr = '<w:rPr><w:sz w:val="18"/><w:color w:val="57606A"/></w:rPr>';
    return `<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r>${rPr}<w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
      `<w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r>` +
      `<w:r>${rPr}<w:t>1</w:t></w:r>` +
      `<w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`;
  }

  function footerXml() {
    const label = text => `<w:r><w:rPr><w:sz w:val="18"/><w:color w:val="57606A"/></w:rPr>` +
      `<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<w:ftr xmlns:w="${NS_W}" xmlns:r="${NS_R}">` +
      '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr>' +
      // 「第X页 共Y页」：X = 当前页(PAGE 域)，Y = 总页数(NUMPAGES 域)
      label('第') + fieldRun('PAGE') + label('页 共') + fieldRun('NUMPAGES') + label('页') +
      '</w:p></w:ftr>';
  }

  /* ------------------------------- 样式与包装 ------------------------------- */

  function stylesXml() {
    const heading = (id, size, color, outline) =>
      `<w:style w:type="paragraph" w:styleId="Heading${id}"><w:name w:val="heading ${id}"/>` +
      '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>' +
      `<w:keepNext/><w:outlineLvl w:val="${outline}"/><w:spacing w:before="240" w:after="80"/></w:pPr>` +
      `<w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="${color}"/></w:rPr></w:style>`;

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<w:styles xmlns:w="${NS_W}">` +
      '<w:docDefaults><w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:eastAsia="微软雅黑" w:cs="Segoe UI"/>' +
      '<w:sz w:val="21"/><w:szCs w:val="21"/><w:color w:val="1F2328"/>' +
      '</w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="312" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
      '</w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      heading(1, HEADING_SIZES[0], '111827', 0) +
      heading(2, HEADING_SIZES[1], '111827', 1) +
      heading(3, HEADING_SIZES[2], '1F2937', 2) +
      heading(4, HEADING_SIZES[3], '1F2937', 3) +
      heading(5, HEADING_SIZES[4], '374151', 4) +
      heading(6, HEADING_SIZES[5], '374151', 5) +
      '</w:styles>';
  }

  function contentTypesXml(ctx) {
    const override = (part, type) => `<Override PartName="/${part}" ContentType="${type}"/>`;
    // 图片媒体：按实际用到的扩展名声明（image-extractor 已把格式归一为 png/jpeg/gif）
    const exts = Array.from(new Set(((ctx && ctx.media) || []).map(m => m.ext)));
    const defaults = exts.map(ext => `<Default Extension="${ext}" ContentType="${IMG_CTYPES[ext] || 'image/png'}"/>`).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      defaults +
      override('word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') +
      override('word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml') +
      override('word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml') +
      override('word/footer1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml') +
      override('docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml') +
      override('docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml') +
      '</Types>';
  }

  function rootRelsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="word/document.xml"/>` +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      `<Relationship Id="rId3" Type="${NS_R}/extended-properties" Target="docProps/app.xml"/>` +
      '</Relationships>';
  }

  function docRelsXml(ctx) {
    const links = Array.from(ctx.links.entries()).map(([url, id]) =>
      `<Relationship Id="${id}" Type="${NS_R}/hyperlink" Target="${esc(url)}" TargetMode="External"/>`);
    // 内嵌图片的媒体关系（word/media/*.png 等）
    const media = (ctx.media || []).map(m =>
      `<Relationship Id="${m.rid}" Type="${NS_R}/image" Target="media/${esc(m.filename)}"/>`);
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${NS_R}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId2" Type="${NS_R}/footer" Target="footer1.xml"/>` +
      `<Relationship Id="rId3" Type="${NS_R}/settings" Target="settings.xml"/>` +
      links.join('') + media.join('') + '</Relationships>';
  }

  function settingsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<w:settings xmlns:w="${NS_W}">` +
      // 打开文档即刷新 PAGE / NUMPAGES 域，页码立即正确
      '<w:updateFields w:val="true"/>' +
      '<w:defaultTabStop w:val="420"/>' +
      '</w:settings>';
  }

  function coreXml(title) {
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
      ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${esc(title || 'DeepSeek 对话')}</dc:title>` +
      '<dc:creator>DeepSeek 对话导出</dc:creator>' +
      '<cp:lastModifiedBy>DeepSeek 对话导出</cp:lastModifiedBy>' +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
      '</cp:coreProperties>';
  }

  function appXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"' +
      ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>DeepSeek 对话导出</Application>' +
      '<AppVersion>1.0</AppVersion>' +
      '</Properties>';
  }

  /* --------------------------------- 入口 --------------------------------- */

  // 长图预切割：占满版心后显示高超过 IMG_SLICE_MAX_H_PX 的内嵌图，
  // 按源像素横向切条写入 rec._slices（每条显示高 ≤ 版心高），
  // 渲染时逐条独立成段，由 Word 按页高自然分页；切割失败标记 _sliceFailed 兜底。
  async function sliceDocxImages(ctx) {
    const jobs = [];
    for (const rec of ctx.imageById.values()) {
      if (!rec || rec.status !== 'embedded' || !rec.dataUrl) continue;
      let w = rec.width || 800;
      let h = rec.height || 600;
      if (w <= 0 || h <= 0) { w = 800; h = 600; }
      const scale = Math.min(CONTENT_W_PX / w, IMG_MAX_UPSCALE);
      if (h * scale <= IMG_SLICE_MAX_H_PX) continue;
      const srcRows = Math.max(1, Math.round(IMG_SLICE_MAX_H_PX / scale));
      jobs.push((async () => {
        try {
          const slices = await (DSMD.imageTools && DSMD.imageTools.sliceDataUrl
            ? DSMD.imageTools.sliceDataUrl(rec.dataUrl, w, h, srcRows) : null);
          if (slices && slices.length > 1) rec._slices = slices;
          else rec._sliceFailed = true;
        } catch (e) {
          rec._sliceFailed = true;
        }
      })());
    }
    await Promise.all(jobs);
  }

  /**
   * 生成 .docx 字节
   * @param {{title: string, messages: Array, excludeThinking: boolean, images?: Array}} input
   *   images: 用户上传图片记录数组（正文里的 dsmd-img://N 引用据此嵌入 / 降级）
   * @returns {Promise<Uint8Array>}
   */
  async function buildDocx(input) {
    const opts = input || {};
    const messages = opts.messages || [];
    const excludeThinking = opts.excludeThinking !== false;
    const ctx = {
      links: new Map(),
      nextRelId: 10,
      imageById: new Map((opts.images || []).map(r => [r.id, r])),
      media: [],
      drawingId: 1
    };

    // 长图先切割（画布解码异步），再进入正文排版
    await sliceDocxImages(ctx);

    const body = [];

    if (opts.title) {
      body.push(para(run(opts.title, { bold: true, size: 36, color: '111827' }),
        { spaceAfter: 240, borderBottom: true }));
    }

    // 绝对序号 X/Y：X = 消息的虚拟列表编号（全文绝对位置），Y = 全文总消息数；
    // 无编号（接口通道等）时退化为导出列表内的顺序位置。
    const seqTotal = Number(opts.seqTotal) || 0;
    function seqTextOf(msg, position) {
      if (!seqTotal) return '';
      const m = /^(\d+)$/.exec(String(msg && msg.virtualKey || ''));
      return m ? `${m[1]}/${seqTotal}` : `${position}/${seqTotal}`;
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const isUser = msg.role === 'user';
      const role = isUser ? 'User' : 'DeepSeek';

      // 角色标题：加粗 + 主题色 + 下边框；绝对序号（X/Y，标题字号一半、置灰）
      // 紧随角色名；分支序号（如「1 / 2」）用右对齐制表位推到同一行右缘
      const seq = seqTextOf(msg, i + 1);
      const seqRuns = seq ? run(' ' + seq, { size: 14, color: '888888' }) : '';
      const branchRuns = msg.branchNo
        ? '<w:r><w:tab/></w:r>' + run(msg.branchNo, { size: 18, color: '57606A' })
        : '';
      body.push(para(
        run(role, { bold: true, size: 28, color: ROLE_COLORS[isUser ? 'user' : 'assistant'] }) + seqRuns + branchRuns,
        { spaceBefore: 240, spaceAfter: 120, borderBottom: true, keepNext: true, tabs: USABLE_TWIPS }
      ));

      if (!excludeThinking && msg.thinking) {
        body.push(para(run('思考过程', { bold: true, size: 22, color: '64748B' }),
          { spaceBefore: 80, spaceAfter: 60, keepNext: true }));
        for (const line of String(msg.thinking).split('\n')) {
          body.push(para(run(line === '' ? ' ' : line, { size: 20, italic: true, color: '57606A' }),
            { indentLeft: 300, spaceAfter: 20 }));
        }
      }

      for (const block of DSMD.mdParse.parseBlocks(msg.body)) {
        const xml = blockXml(block, ctx);
        if (xml) body.push(xml);
      }

      for (const extra of msg.extras || []) {
        body.push(para(run(extra.title || '附加内容', { bold: true, size: 22, color: '64748B' }),
          { spaceBefore: 160, spaceAfter: 60 }));
        for (const line of String(extra.text || '').split('\n')) {
          body.push(para(run(line === '' ? ' ' : line, { size: 20, color: '57606A' }), { indentLeft: 300, spaceAfter: 20 }));
        }
      }

      body.push(para('', { borderBottom: true, spaceBefore: 160, spaceAfter: 200 }));
    }

    const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}" xmlns:wp="${NS_WP}" xmlns:a="${NS_A}" xmlns:pic="${NS_PIC}"><w:body>` +
      body.join('') +
      '<w:sectPr>' +
      '<w:footerReference w:type="default" r:id="rId2"/>' +
      '<w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1134" w:right="1020" w:bottom="1134" w:left="1020" w:header="709" w:footer="567" w:gutter="0"/>' +
      '</w:sectPr></w:body></w:document>';

    const files = [
      { name: '[Content_Types].xml', data: contentTypesXml(ctx) },
      { name: '_rels/.rels', data: rootRelsXml() },
      { name: 'word/document.xml', data: documentXml },
      { name: 'word/_rels/document.xml.rels', data: docRelsXml(ctx) },
      { name: 'word/styles.xml', data: stylesXml() },
      { name: 'word/settings.xml', data: settingsXml() },
      { name: 'word/footer1.xml', data: footerXml() },
      { name: 'docProps/core.xml', data: coreXml(opts.title) },
      { name: 'docProps/app.xml', data: appXml() }
    ];
    // 内嵌图片作为 word/media 部件进包
    for (const m of ctx.media) files.push({ name: `word/media/${m.filename}`, data: m.bytes });

    return DSMD.zip.zipStore(files);
  }

  DSMD.docx = { buildDocx, footerXml, stylesXml, resolveImageRecord, sliceDocxImages, fitExtent, fitCompactExtent, drawingXml };
})();
