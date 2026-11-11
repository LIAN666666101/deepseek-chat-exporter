/**
 * mermaid-capture.js —— 捕获页面上已渲染的 Mermaid 图表并转为 PNG（纯本地，无网络）
 *
 * 故障背景：DeepSeek 对话里的 Mermaid 图表在 DOM 中是「源码块 + 渲染后的 SVG」并存。
 * 旧版导出把 language-mermaid 代码块当普通代码导出（得到源码文本），而 SVG 子元素里的
 * 节点文字与内部 CSS 也会被当正文漏出——这就是「导出的是 SVG/CSS 代码而非图形」的原因。
 *
 * 修复思路：导出时先把渲染完成的 SVG 在本地栅格化成 PNG（canvas + data URL，全程离线），
 * 挂进 image-extractor 的图片注册表（kind='mermaid'，与用户上传图同一套内嵌管线），
 * 三种格式都嵌这张图，源码文本不再导出：
 *   - Markdown：![Mermaid 图表](data:image/png;base64,...)（自包含；图片过多时随 zip 打包）
 *   - PDF / Word：经 dsmd-img://N 引用由 pdf-doc / docx 渲染为真实图片
 *
 * 与其他模块的分工：
 *   - content.js 在滚动加载完成后、消息解析前调用 capture()（此时图表已渲染）；
 *   - dom-extractor.js 创建图片注册表后调用 attachRegistry()；
 *   - html-to-md.js 在转换时用 tokenForElement / tokenForSource 换取占位引用
 *     ![Mermaid 图表](dsmd-img://N)——源码块与 SVG 两个位置只输出一张图；
 *   - 接口通道的数据里仍是 ```mermaid 围栏，由 embedIntoMessages 按源码匹配换成图片引用。
 *
 * 匹配策略（多信号，不赌单一类名）：
 *   1. 显式信号：svg 自身或祖先元素的 class/id/data-lang 含 "mermaid"；
 *   2. 邻接信号：紧挨 language-mermaid 代码块的 svg（同一容器或相邻兄弟）；
 *   3. 形态过滤：尺寸 ≥120×60 且包含图形元素（path/rect/...），排除图标类小 svg。
 */
(() => {
  'use strict';

  const DSMD = (globalThis.__DSMD__ || (globalThis.__DSMD__ = {}));

  const MERMAID_RE = /mermaid/i;
  const MIN_WIDTH = 120;                 // 小于该宽度的 svg 视为图标，不是图表
  const MIN_HEIGHT = 60;
  const MAX_PIXELS = 16e6;               // 栅格化尺寸上限，防止异常大图拖垮页面
  const SCALE = 2;                       // 2x 采样，保证打印与缩放清晰
  const TOKEN_ALT = 'Mermaid 图表';

  let captures = null;                   // capture() 的结果：[{source,dataUrl,b64,bytes,width,height,element}]
  let attached = null;                   // attachRegistry() 后的索引：{bySource, byElement}

  /* -------------------------------- 识别信号 -------------------------------- */

  function tagOf(el) {
    return el && el.tagName ? String(el.tagName).toLowerCase() : '';
  }

  function attr(el, name) {
    return el && el.getAttribute ? (el.getAttribute(name) || '') : '';
  }

  function isMermaidSignal(el) {
    if (MERMAID_RE.test(attr(el, 'class')) || MERMAID_RE.test(attr(el, 'data-lang'))) return true;
    return /^mermaid/i.test(attr(el, 'id'));
  }

  function rectOf(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    try {
      const r = el.getBoundingClientRect();
      return r && Number.isFinite(r.width) ? r : null;
    } catch (e) {
      return null;
    }
  }

  // 形态过滤：像一张图，而不是图标或装饰
  function looksLikeDiagram(svg) {
    const r = rectOf(svg);
    const w = r && r.width ? r.width : parseFloat(attr(svg, 'width')) || 0;
    const h = r && r.height ? r.height : parseFloat(attr(svg, 'height')) || 0;
    if (w < MIN_WIDTH || h < MIN_HEIGHT) return false;
    return !!svg.querySelector('path, rect, circle, polygon, line, ellipse, polyline, foreignObject');
  }

  // 找 svg 对应的 Mermaid 源码（来自相邻的 language-mermaid 代码块）
  function sourceNear(svg) {
    let node = svg.parentElement;
    for (let hop = 0; node && hop < 6; hop++, node = node.parentElement) {
      for (const code of node.querySelectorAll('code')) {
        const m = /language-([\w-]+)/i.exec(attr(code, 'class'));
        if (m && MERMAID_RE.test(m[1])) return code.textContent || '';
      }
      for (const b of node.querySelectorAll('[class*="banner"], [class*="lang"]')) {
        if (!MERMAID_RE.test(b.textContent || '')) continue;
        const code = node.querySelector('pre code, code');
        if (code) return code.textContent || '';
      }
    }
    return '';
  }

  function normalizeSource(src) {
    return String(src || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .join('\n');
  }

  /* ------------------------------ 候选 svg 收集 ------------------------------ */

  function collectCandidates(doc) {
    const out = [];
    const add = el => {
      if (tagOf(el) === 'svg' && out.indexOf(el) === -1) out.push(el);
    };

    // 1) 显式信号：svg 自身或祖先带 mermaid 标记
    doc.querySelectorAll('svg').forEach(svg => {
      if (isMermaidSignal(svg)) { add(svg); return; }
      let p = svg.parentElement;
      for (let hop = 0; p && hop < 4; hop++, p = p.parentElement) {
        if (isMermaidSignal(p)) { add(svg); return; }
      }
    });

    // 2) 邻接信号：language-mermaid 代码块所在的容器及其相邻兄弟里的 svg
    doc.querySelectorAll('pre > code, code').forEach(code => {
      if (!MERMAID_RE.test(attr(code, 'class'))) return;
      let node = code.closest('pre') || code.parentElement;
      for (let hop = 0; node && hop < 3; hop++, node = node.parentElement) {
        node.querySelectorAll('svg').forEach(add);
        let sib = node.nextElementSibling;
        for (let s = 0; sib && s < 2; s++, sib = sib.nextElementSibling) {
          sib.querySelectorAll('svg').forEach(add);
        }
      }
    });

    return out;
  }

  /* ------------------------------- SVG 序列化 ------------------------------- */

  function serializeSvg(svg, options) {
    const opts = options || {};
    const clone = svg.cloneNode(true);

    clone.querySelectorAll('script').forEach(n => n.remove());
    if (opts.stripForeignObjects) {
      clone.querySelectorAll('foreignObject').forEach(n => n.remove());
    }

    // 显式尺寸：SVG 作为图片加载时需要确定的宽高
    const r = rectOf(svg);
    let w = r && r.width > 0 ? r.width : parseFloat(attr(svg, 'width')) || 0;
    let h = r && r.height > 0 ? r.height : parseFloat(attr(svg, 'height')) || 0;
    if ((!w || !h) && attr(svg, 'viewBox')) {
      const vb = attr(svg, 'viewBox').trim().split(/[\s,]+/).map(Number);
      if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
        w = w || vb[2];
        h = h || vb[3];
      }
    }
    if (w > 0) clone.setAttribute('width', String(Math.round(w)));
    if (h > 0) clone.setAttribute('height', String(Math.round(h)));
    if (clone.style) clone.style.maxWidth = '';

    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

    // foreignObject 里的 HTML 子元素必须带 XHTML 命名空间，否则无法作为图片加载
    if (!opts.stripForeignObjects) {
      clone.querySelectorAll('foreignObject *').forEach(el => {
        if (!attr(el, 'xmlns')) el.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      });
    }

    return { xml: new XMLSerializer().serializeToString(clone), width: Math.round(w), height: Math.round(h) };
  }

  /* ------------------------------- SVG → PNG ------------------------------- */

  function svgToPng(svgXml, width, height) {
    return new Promise(resolve => {
      let finished = false;
      const done = value => { if (!finished) { finished = true; resolve(value); } };

      try {
        const img = new Image();
        img.onload = () => {
          try {
            const w0 = img.naturalWidth || width || 300;
            const h0 = img.naturalHeight || height || 200;
            const scale = Math.min(SCALE, Math.sqrt(MAX_PIXELS / (w0 * h0)) || SCALE);
            const cw = Math.max(1, Math.round(w0 * scale));
            const ch = Math.max(1, Math.round(h0 * scale));

            const canvas = document.createElement('canvas');
            canvas.width = cw;
            canvas.height = ch;
            const ctx2d = canvas.getContext('2d');
            if (!ctx2d) return done(null);

            // 铺白底：透明背景的图在深色查看器里会看不清
            ctx2d.fillStyle = '#ffffff';
            ctx2d.fillRect(0, 0, cw, ch);
            ctx2d.drawImage(img, 0, 0, cw, ch);
            done(canvas.toDataURL('image/png'));
          } catch (e) {
            done(null);              // 例如 toDataURL 被安全策略拦截
          }
        };
        img.onerror = () => done(null);
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgXml);
        setTimeout(() => done(null), 8000);      // 极端情况下的兜底，避免卡住导出
      } catch (e) {
        done(null);
      }
    });
  }

  /* --------------------------------- 捕获 --------------------------------- */

  /**
   * 扫描文档并栅格化所有已渲染的 Mermaid 图表。
   * 结果暂存于本模块，等 dom-extractor 创建注册表后由 attachRegistry 登记。
   * @param {Document} rootDocument
   * @returns {Promise<Array<{source:string, dataUrl:string}>>}
   */
  async function capture(rootDocument) {
    const doc = rootDocument || (typeof document !== 'undefined' ? document : null);
    captures = { list: [] };
    attached = null;
    if (!doc || !doc.querySelectorAll) return captures.list;

    const seen = new Set();
    for (const svg of collectCandidates(doc)) {
      if (seen.has(svg)) continue;
      seen.add(svg);
      if (!looksLikeDiagram(svg)) continue;

      const source = normalizeSource(sourceNear(svg));
      if (source && captures.list.some(c => c.source === source)) {
        continue;                                  // 同一张图的重复渲染
      }

      const ser = serializeSvg(svg);
      let dataUrl = await svgToPng(ser.xml, ser.width, ser.height);

      // 带 foreignObject 的 SVG 个别环境会渲染/导出失败：去掉文字标签再试一次，
      // 保证图形框架一定出得来
      if (!dataUrl && svg.querySelector('foreignObject')) {
        const retry = serializeSvg(svg, { stripForeignObjects: true });
        dataUrl = await svgToPng(retry.xml, retry.width, retry.height);
      }
      if (!dataUrl) continue;

      const b64 = /^data:image\/png;base64,/.test(dataUrl) ? dataUrl.slice(22) : '';
      captures.list.push({
        source,
        dataUrl,
        b64,
        bytes: Math.round(b64.length * 3 / 4),     // 供 zip 打包阈值判断，无需精确
        width: ser.width,
        height: ser.height,
        element: svg
      });
    }

    return captures.list;
  }

  /* --------------------------- 注册表挂接与占位引用 --------------------------- */

  /**
   * 把捕获结果登记进 image-extractor 的图片注册表（kind='mermaid'）。
   * 由 dom-extractor 在创建注册表后调用；重复调用或重复提取都是安全的。
   */
  function attachRegistry(registry) {
    attached = { bySource: new Map(), byElement: new WeakMap() };
    if (!registry || typeof registry.registerData !== 'function' || !captures) return 0;

    let n = 0;
    for (const c of captures.list) {
      if (!c.dataUrl) continue;
      const id = registry.registerData({
        src: '',
        source: c.source || '',
        width: c.width, height: c.height,
        dataUrl: c.dataUrl, b64: c.b64, mime: 'image/png', ext: 'png', bytes: c.bytes,
        filename: `mermaid-${String(n + 1).padStart(3, '0')}.png`,
        status: 'embedded',
        kind: 'mermaid'
      });
      if (id == null) continue;
      if (c.source) attached.bySource.set(c.source, id);
      if (c.element) attached.byElement.set(c.element, id);
      n++;
    }
    return n;
  }

  const tokenForId = id => `![${TOKEN_ALT}](dsmd-img://${id})`;

  /** html-to-md 用：该 svg 元素对应的占位引用（未捕获返回 null） */
  function tokenForElement(el) {
    if (!attached) return null;
    const id = attached.byElement.get(el);
    return id === undefined ? null : tokenForId(id);
  }

  /** html-to-md 用：该 Mermaid 源码对应的占位引用（未捕获返回 null） */
  function tokenForSource(src) {
    if (!attached) return null;
    const id = attached.bySource.get(normalizeSource(src));
    return id === undefined ? null : tokenForId(id);
  }

  /**
   * 把消息体里的 ```mermaid 围栏替换为图片占位引用（接口通道的数据用）。
   * 匹配不上的围栏原样保留——宁可给源码也不丢内容。
   */
  function embedIntoMessages(messages) {
    if (!attached || !attached.bySource.size) return messages || [];
    for (const msg of messages || []) {
      if (!msg || typeof msg.body !== 'string' || msg.body.indexOf('`') === -1) continue;
      const lines = msg.body.replace(/\r\n?/g, '\n').split('\n');
      const out = [];
      let i = 0;

      while (i < lines.length) {
        const m = /^(`{3,})\s*mermaid\s*$/i.exec(lines[i].trim());
        if (!m) { out.push(lines[i]); i++; continue; }

        const fenceLen = m[1].length;
        const start = i;
        const body = [];
        i++;
        while (i < lines.length && !(new RegExp('^`{' + fenceLen + ',}\\s*$')).test(lines[i].trim())) {
          body.push(lines[i]);
          i++;
        }
        const closed = i < lines.length;
        if (closed) i++;

        const token = tokenForSource(body.join('\n'));
        if (token) {
          out.push(token);
          out.push('');
        } else {
          for (let j = start; j < i; j++) out.push(lines[j]);
        }
      }

      msg.body = out.join('\n');
    }
    return messages;
  }

  function count() {
    return captures ? captures.list.length : 0;
  }

  function clear() {
    captures = null;
    attached = null;
  }

  /**
   * 测试钩子：跳过 canvas 栅格化，直接注入捕获结果。
   * @param {Array<{source?:string, dataUrl:string, element?:Element, width?:number, height?:number}>} entries
   */
  function setCaptures(entries) {
    const list = [];
    for (const e of entries || []) {
      if (!e || !e.dataUrl) continue;
      const b64 = /^data:image\/png;base64,/.test(e.dataUrl) ? e.dataUrl.slice(22) : (e.b64 || '');
      list.push({
        source: normalizeSource(e.source || ''),
        dataUrl: e.dataUrl,
        b64,
        bytes: Math.round(b64.length * 3 / 4),
        width: e.width || 0,
        height: e.height || 0,
        element: e.element || null
      });
    }
    captures = { list };
    attached = null;
    return list;
  }

  DSMD.mermaid = {
    capture,
    attachRegistry,
    tokenForElement,
    tokenForSource,
    embedIntoMessages,
    count,
    clear,
    setCaptures,
    normalizeSource,
    serializeSvg,
    looksLikeDiagram,
    collectCandidates
  };
})();
