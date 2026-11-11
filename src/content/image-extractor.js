/**
 * image-extractor.js —— 用户上传图片的识别、读取与本地转换（全部在页面内完成）
 *
 * 安全边界（与本文件相关的全部对外行为）：
 *   - 只对「当前对话页里已显示的图片地址」发起只读 GET（blob: / 同源 https: / 带 CORS 的跨域图），
 *     目标是图片本身所在的地址，不向任何第三方发送数据，不携带对话内容。
 *   - 跨域图无法本地读取时按需求降级：保留原始 URL 并标注「图片可能需联网查看」，
 *     绝不为此新增 host_permissions，也绝不把图片交给外部服务转存。
 *   - fetch / FileReader / canvas 均为浏览器标准 API，数据不离开本机内存。
 *
 * 与其他模块的分工：
 *   - dom-extractor.js 在解析用户气泡时调用 isUserUploadImage / harvestInto：
 *     把命中的 <img> 替换为占位引用 ![用户上传图片](dsmd-img://N)（N 为全局序号），
 *     并在注册表里登记原始元素 —— 占位符与文字在 Markdown 里的先后 = DOM 里的先后。
 *   - content.js 在导出前调用 preparePage（滚动加载 + 等图）与 convertAll（转 base64），
 *     再把注册表数组连同消息一起交给 markdown / pdf-doc / docx 三个渲染器。
 *   - 渲染器只认 dsmd-img://N 引用 + 记录数组，本身不做任何 IO。
 */
(() => {
  'use strict';

  const DSMD = (globalThis.__DSMD__ || (globalThis.__DSMD__ = {}));
  if (DSMD.imageTools) return;          // 防止重复注入

  /* --------------------------------- 常量 --------------------------------- */

  // 头像 / 图标 / 表情 / UI 装饰图的特征（类名与 alt 文案），命中即排除
  const IMG_NOISE_RE = /(?:^|[\s_-])(?:avatars?|icons?|iconfont|emojis?|logos?|favicons?|sprites?|badges?|flags?|placeholders?|spinners?|skeletons?|loadings?|ratings?|thumbs?|decoration|decorat(?:e|ive|ion))(?:[\s_-]|$)/i;
  const IMG_NOISE_ALT_RE = /^(?:avatar|头像|图标|icon|logo|表情|emoji|装饰)/i;
  // 上传图所在容器（气泡之外的附件区）的语义特征：
  // 懒加载占位图可能连 src 都还没有，只能靠这个信号把它认成用户上传图
  const UPLOAD_CONTAINER_RE = /(?:^|[\s_-])(?:upload(?:s|ed)?|attach(?:ment|ed|s)?|file[-_]?(?:list|preview|card|item)|image[-_]?(?:list|preview|card|grid|item)|img[-_]?(?:list|preview|card|grid|item)|preview[-_]?(?:list|grid|item))(?:[\s_-]|$)/i;
  // 小于该尺寸（px）的图按界面元素处理：头像 24~40px，用户上传图通常远大于此
  const MIN_SIZE_PX = 64;
  // 单张图读取上限：超过按无法本地读取处理（避免撑爆内存 / 导出文件）
  const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
  // Markdown 单文件内嵌总量上限，超过自动改为打包 .zip
  const EMBED_TOTAL_LIMIT = 16 * 1024 * 1024;
  // 多图转换并发数：4 路可显著缩短长对话耗时，同时把内存峰值压住
  const CONVERT_CONCURRENCY = 4;
  // 单张图片读取的总超时与重试次数（超时后放弃该张，进入 failed/remote 清单）
  const READ_TIMEOUT_MS = 20000;
  const READ_RETRIES = 2;
  // 预加载阶段默认预算：长对话（20+ 轮、10+ 图）足够完成全量滚动与图片加载
  const PRELOAD_BUDGET_MS = 90000;
  const IMAGE_WAIT_MS = 25000;

  const MIME_TO_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg'
  };
  const KEEP_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif']);  // Word 原生支持的三类

  // 懒加载常见的真实地址属性（按优先级）
  const LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url', 'data-image-src'];
  const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset', 'srcset'];

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 给任意 Promise 加超时；不能取消底层操作，但能保证导出的等待有上界
  function withTimeout(promise, ms, label) {
    let timer = null;
    const guard = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label || 'timeout')), Math.max(1, ms || READ_TIMEOUT_MS));
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  }

  function attrOf(el, name) {
    if (!el || !el.getAttribute) return '';
    return String(el.getAttribute(name) || '').trim();
  }

  function pickSrcsetUrl(srcset) {
    const s = String(srcset || '').trim();
    if (!s) return '';
    let best = '';
    let bestScore = -1;
    for (const part of s.split(',')) {
      const bits = part.trim().split(/\s+/);
      const url = bits[0] || '';
      if (!url || /^data:image\/svg/i.test(url)) continue;
      const score = parseFloat((bits[1] || '').replace(/[^\d.]/g, '')) || 1;
      if (score >= bestScore) { bestScore = score; best = url; }
    }
    return best;
  }

  // 占位图：无地址、1×1 透明 PNG/GIF、空白 SVG 等懒加载占位
  function isPlaceholderSrc(img, src) {
    const s = String(src || '').trim();
    if (!s) return true;
    if (/^about:blank$/i.test(s)) return true;
    const nw = (img && (img.naturalWidth || 0)) || 0;
    // 常见懒加载占位数据：1×1 GIF / 1×1 透明 PNG（未加载完成时 naturalWidth 为 0 也要识别）
    if (/^data:image\/(?:gif|png)/i.test(s) &&
      /^(?:R0lGOD|iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB)/i.test(s.replace(/^data:image\/[^;]+;base64,/i, ''))) {
      return nw <= 2;
    }
    if (/^data:image\/(?:gif|png|jpeg|webp|svg\+xml)/i.test(s) && nw > 0 && nw <= 2) return true;
    return false;
  }

  /**
   * 解析 <img> 的真实图片地址。
   * 长对话里未进入视口的图片常见两种形态：src 为空、或 src 是 1×1 占位图，
   * 真实地址放在 data-src / data-original / srcset 里；这里统一取出来，
   * 否则这些图会在采集阶段直接被判成「不是上传图」而静默消失。
   */
  function resolveImageSrc(img) {
    if (!img) return '';
    const current = String(img.currentSrc || '').trim();
    const attrSrc = attrOf(img, 'src');
    let src = current || attrSrc;

    let lazy = '';
    for (const name of LAZY_SRC_ATTRS) {
      lazy = attrOf(img, name);
      if (lazy) break;
    }
    if (!lazy) {
      for (const name of LAZY_SRCSET_ATTRS) {
        lazy = pickSrcsetUrl(attrOf(img, name));
        if (lazy) break;
      }
    }

    if (lazy && (!src || isPlaceholderSrc(img, src) ||
      (/^data:/i.test(src) && (img.naturalWidth || 0) > 0 && (img.naturalWidth || 0) < MIN_SIZE_PX))) {
      return lazy;
    }
    return src || lazy || '';
  }

  // 图片是否位于附件/上传区域（用于识别还没有 src 的懒加载占位图）
  function inUploadContainer(el) {
    let node = el;
    for (let depth = 0; node && depth < 6; node = node.parentElement, depth++) {
      const cls = classNameOf(node);
      if (cls && UPLOAD_CONTAINER_RE.test(cls)) return true;
      const testid = attrOf(node, 'data-testid');
      if (testid && /upload|attach|file|image|preview/i.test(testid)) return true;
    }
    return false;
  }

  // 强制懒加载图片开始加载：loading=eager + 把真实地址写回 src
  function forceLazyImage(img) {
    if (!img || img.tagName !== 'IMG') return false;
    let changed = false;
    try { img.loading = 'eager'; } catch (e) { /* 只读属性时忽略 */ }
    if (img.getAttribute && img.getAttribute('loading') === 'lazy') {
      try { img.setAttribute('loading', 'eager'); } catch (e) { /* 忽略 */ }
    }
    const real = resolveImageSrc(img);
    const current = String(img.currentSrc || attrOf(img, 'src') || '').trim();
    if (real && (!current || isPlaceholderSrc(img, current))) {
      try {
        img.src = absoluteUrl(real);
        changed = true;
      } catch (e) { /* 保留原值 */ }
    }
    if (typeof img.decode === 'function') {
      try { img.decode().catch(() => {}); } catch (e) { /* 忽略 */ }
    }
    return changed;
  }

  function absoluteUrl(src) {
    try { return new URL(src, (typeof location !== 'undefined' ? location.href : 'about:blank')).href; }
    catch (e) { return String(src || ''); }
  }

  function sameOrigin(url) {
    try { return new URL(url).origin === location.origin; } catch (e) { return false; }
  }

  function extForMime(mime) {
    return MIME_TO_EXT[String(mime || '').toLowerCase()] || 'png';
  }

  /* ------------------------------- 图片筛选 ------------------------------- */

  function dimsOf(img) {
    let w = img.naturalWidth || 0;
    let h = img.naturalHeight || 0;
    if (!w) {
      try {
        const r = img.getBoundingClientRect();
        if (r && r.width > 0) { w = r.width; h = h || r.height; }
      } catch (e) { /* 无布局信息 */ }
    }
    if (!w) {
      w = parseFloat(img.getAttribute('width')) || 0;
      h = h || (parseFloat(img.getAttribute('height')) || 0);
    }
    return { w: Math.round(w || 0), h: Math.round(h || 0) };
  }

  function classNameOf(el) {
    if (!el || !el.getAttribute) return '';
    const c = typeof el.className === 'string' ? el.className : el.getAttribute('class');
    return c || '';
  }

  /**
   * 判断一张 <img> 是否用户上传图（而非头像/图标/表情/UI 装饰）。
   * 判据：可解析出图片地址（含 data-src 等懒加载地址）或位于附件容器、
   * 自身与近祖（5 层内）不带界面噪音类名、alt 不是头像语义、尺寸 ≥ 64px。
   */
  function isUserUploadImage(img) {
    if (!img || img.tagName !== 'IMG') return false;
    const src = resolveImageSrc(img);
    if (/^data:image\/svg/i.test(src)) return false;
    // 连真实地址都没有时：位于附件/上传容器，或尺寸明确像上传图（≥64px）的占位图，
    // 都先登记为待转换记录。最终失败会进入 failed 清单，而不是静默消失。
    if (!src && !inUploadContainer(img)) {
      const d = dimsOf(img);
      if (!(d.w >= MIN_SIZE_PX && d.h >= MIN_SIZE_PX)) return false;
    }

    const alt = String(img.getAttribute('alt') || '').trim();
    if (alt && IMG_NOISE_ALT_RE.test(alt)) return false;

    let node = img;
    for (let depth = 0; node && depth < 5; node = node.parentElement, depth++) {
      const cls = classNameOf(node);
      if (cls && IMG_NOISE_RE.test(cls)) return false;
      const testid = node.getAttribute ? (node.getAttribute('data-testid') || '') : '';
      if (testid && /avatar|icon|emoji/i.test(testid)) return false;
    }

    const { w, h } = dimsOf(img);
    if (w > 0 && w < MIN_SIZE_PX) return false;
    if (h > 0 && h < MIN_SIZE_PX && w > 0 && w < MIN_SIZE_PX * 4) return false;
    return true;
  }

  /* ------------------------------- 注册表 ------------------------------- */

  const TOKEN_PREFIX = '![用户上传图片](dsmd-img://';
  const tokenFor = id => `${TOKEN_PREFIX}${id})`;
  const IMG_REF_RE = /!\[([^\]]*)\]\(dsmd-img:\/\/(\d+)\)/g;

  /** 从一段 Markdown 里取出引用的图片 id（保持出现顺序） */
  function refIdsOf(text) {
    const ids = [];
    String(text || '').replace(IMG_REF_RE, (m, alt, id) => { ids.push(Number(id)); return m; });
    return ids;
  }

  function createRegistry() {
    const records = [];
    const baseInfo = (info, img) => {
      const o = info || {};
      return {
        alt: String(o.alt != null ? o.alt : (img ? img.getAttribute('alt') : '') || '').trim(),
        role: o.role === 'assistant' ? 'assistant' : 'user',
        turnIndex: Number.isFinite(o.turnIndex) ? o.turnIndex : null,
        failureReason: ''
      };
    };
    return {
      /** 登记一张用户上传图，返回占位引用（调用方负责把 <img> 替换成它） */
      register(img, info) {
        const d = (info && (info.width || info.height)) ? info : dimsOf(img);
        const rec = Object.assign({
          id: records.length,
          src: (info && info.src) || resolveImageSrc(img),
          el: img,
          width: d.w, height: d.h,
          dataUrl: null, b64: '', mime: '', ext: '', bytes: 0,
          filename: '', status: 'pending',   // pending → embedded / remote / failed
          kind: 'user'
        }, baseInfo(info, img));
        records.push(rec);
        return rec.id;
      },
      /**
       * 登记一条「数据已就位」的图片记录（如 Mermaid 图表栅格化结果），
       * 无需再走 readImage 转换，直接可被三个渲染端内嵌。
       */
      registerData(info) {
        const o = info || {};
        const rec = Object.assign({
          id: records.length,
          src: o.src || '',
          source: o.source || '',
          el: null,
          width: o.width || 0, height: o.height || 0,
          dataUrl: o.dataUrl || null,
          b64: o.b64 || '', mime: o.mime || 'image/png', ext: o.ext || 'png',
          bytes: o.bytes || 0,
          filename: o.filename || '',
          status: o.status || 'embedded',
          kind: o.kind || 'user'
        }, baseInfo(o, null));
        records.push(rec);
        return rec.id;
      },
      /**
       * 以地址登记一张上传图（背景图缩略图等没有 <img> 元素的情形）。
       * 之后由 convertAll 统一读取。
       */
      registerSrc(src, info) {
        const s = String(src || '');
        if (!s) return null;
        const d = info || {};
        const rec = Object.assign({
          id: records.length,
          src: s,
          el: d.el || null,          // 保留元素身份：覆盖率审计 / 去重需要
          width: d.w || 0, height: d.h || 0,
          dataUrl: null, b64: '', mime: '', ext: '', bytes: 0,
          filename: '', status: 'pending',
          kind: 'user'
        }, baseInfo(info, null));
        records.push(rec);
        return rec.id;
      },
      all: () => records
    };
  }

  /**
   * 把 original 气泡里命中的用户上传图，在 clone 里替换为占位引用。
   * 两棵树在克隆瞬间结构一致，按 querySelectorAll('img') 的文档顺序一一配对；
   * 尺寸/类名筛选以 original（有布局、已加载）为准。
   */
  /**
   * 把 original 气泡里命中的用户上传图，在 clone 里替换为占位引用。
   * 两棵树在克隆瞬间结构一致，按 querySelectorAll('img') 的文档顺序一一配对；
   * 尺寸/类名筛选以 original（有布局、已加载）为准。
   * @returns {number} 替换掉的图片数量
   */
  function harvestInto(clone, original, registry, meta) {
    if (!clone || !original || !registry) return 0;
    const cloneImgs = clone.querySelectorAll('img');
    const origImgs = original.querySelectorAll('img');
    const n = Math.min(cloneImgs.length, origImgs.length);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const oImg = origImgs[i];
      const cImg = cloneImgs[i];
      if (!cImg.parentNode) continue;
      if (!isUserUploadImage(oImg)) continue;
      const id = registry.register(oImg, Object.assign({}, meta || {}, {
        src: resolveImageSrc(oImg),
        alt: oImg.getAttribute('alt') || ''
      }));
      const token = (clone.ownerDocument || document).createTextNode(tokenFor(id));
      cImg.parentNode.replaceChild(token, cImg);
      count++;
    }
    // 未命中筛选的 img（头像 / 图标 / 表情 / UI 装饰）直接剔除，避免混进用户正文
    clone.querySelectorAll('img').forEach(img => {
      if (img.parentNode) img.parentNode.removeChild(img);
    });
    return count;
  }

  /* --------------------------- 轮次范围内的图片收割 --------------------------- */

  // 元素在文档中的先后：a 在 b 之前返回 true
  function isBefore(a, b) {
    if (!a || !b || a === b) return false;
    return !!(a.compareDocumentPosition(b) & 4 /* DOCUMENT_POSITION_FOLLOWING */);
  }

  // 背景图：少数版本用 background-image 显示上传缩略图
  function backgroundUploads(scope) {
    const out = [];
    if (!scope || !scope.querySelectorAll) return out;
    scope.querySelectorAll('[style*="background-image"], [class*="upload"], [class*="attach"], [class*="file"]').forEach(el => {
      let bg = '';
      try { bg = (getComputedStyle(el).backgroundImage || ''); } catch (e) { bg = ''; }
      if (!bg || bg === 'none') {
        const st = el.getAttribute('style') || '';
        const m = /background-image\s*:\s*url\((['"]?)([^'")]+)\1\)/i.exec(st);
        bg = m ? `url("${m[2]}")` : '';
      }
      const m = /url\((['"]?)([^'")]+)\1\)/i.exec(bg || '');
      if (!m) return;
      const src = m[2];
      if (!src || !/^(blob:|https?:|data:image\/)/i.test(src)) return;
      if (/^data:image\/svg/i.test(src)) return;
      const cls = classNameOf(el);
      if (cls && IMG_NOISE_RE.test(cls)) return;
      const r = (() => { try { return el.getBoundingClientRect(); } catch (e) { return null; } })();
      const w = (r && r.width) || 0;
      const h = (r && r.height) || 0;
      if (w < MIN_SIZE_PX || h < MIN_SIZE_PX) return;
      out.push({ el, src, width: Math.round(w), height: Math.round(h) });
    });
    return out;
  }

  /**
   * 收割「一整轮用户消息」里的上传图片。
   *
   * 为什么需要轮次范围：DeepSeek 的上传图常常渲染在文字气泡之外的附件容器里
   * （气泡只是右侧那段文字）。只从气泡里找 img 会漏掉全部上传图；
   * 而把附件容器当成独立气泡又会和文字拆成两条消息。
   *
   * - 气泡内的图片：替换进 clone（位置原样保留）
   * - 气泡外、同一轮范围内的图片：按文档顺序返回占位引用，分 before（文字之前）
   *   与 after（文字之后）两组，由调用方拼到正文首尾
   *
   * @param {Element|Element[]} scope 本轮范围（可传多个互不重叠的容器）
   * @param {Element} bubble  文字气泡
   * @param {Element} clone   气泡的克隆树
   * @param {object}  registry
   * @returns {{before: string, after: string, count: number}}
   */
  function harvestTurn(scope, bubble, clone, registry, meta) {
    const result = { before: '', after: '', count: 0 };
    if (!registry) return result;

    // 1) 气泡内的图
    if (bubble && clone) result.count += harvestInto(clone, bubble, registry, meta);

    // 2) 气泡外、本轮范围内的图（多个作用域之间按文档顺序归并，去重）
    const scopes = (Array.isArray(scope) ? scope : [scope]).filter(Boolean);
    if (!scopes.length) return result;

    const before = [];
    const after = [];
    const seen = new Set();

    const add = (src, width, height, el, order, alt) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      const info = Object.assign({}, meta || {}, {
        src, width, height, w: width, h: height, alt: alt || ''
      });
      // 有元素时走 register：即使 src 仍为空（纯懒加载占位），也要留下记录，
      // 让转换阶段把它记入失败清单，而不是直接跳过、无声漏图。
      const id = (typeof registry.register === 'function')
        ? registry.register(el, info)
        : (typeof registry.registerSrc === 'function' ? registry.registerSrc(src, info) : null);
      if (id == null) return;
      const token = tokenFor(id) + '\n\n';
      if (order === 'before') before.push(token);
      else after.push(token);
      result.count++;
    };

    for (const sc of scopes) {
      if (!sc || !sc.querySelectorAll) continue;

      sc.querySelectorAll('img').forEach(img => {
        if (!img.parentNode) return;
        if (bubble && (bubble === img || bubble.contains(img))) return;
        if (!isUserUploadImage(img)) return;
        const d = dimsOf(img);
        add(resolveImageSrc(img), d.w, d.h, img,
          isBefore(img, bubble) ? 'before' : 'after',
          img.getAttribute('alt') || '');
      });

      // 3) 背景图形式的缩略图
      for (const item of backgroundUploads(sc)) {
        if (bubble && (bubble === item.el || bubble.contains(item.el))) continue;
        if (seen.has(item.el)) continue;
        add(item.src, item.width, item.height, item.el,
          isBefore(item.el, bubble) ? 'before' : 'after', '');
      }
    }

    result.before = before.join('');
    result.after = after.join('');
    return result;
  }

  /**
   * 诊断：统计页面里被识别/被排除的图片，定位「上传图没导出来」的原因。
   * 只输出类名与尺寸等结构信息，不含图片内容。
   */
  function diagnose(scope) {
    const out = { total: 0, uploads: 0, rejected: [] };
    if (!scope || !scope.querySelectorAll) return out;
    scope.querySelectorAll('img').forEach(img => {
      out.total++;
      if (isUserUploadImage(img)) { out.uploads++; return; }
      if (out.rejected.length >= 12) return;
      const src = resolveImageSrc(img);
      out.rejected.push({
        cls: classNameOf(img).slice(0, 60),
        alt: String(img.getAttribute('alt') || '').slice(0, 30),
        w: dimsOf(img).w,
        h: dimsOf(img).h,
        scheme: (src.match(/^([a-z]+:)/i) || [, '?'])[1]
      });
    });
    return out;
  }

  /* ------------------------------- 滚动加载 ------------------------------- */

  // 找到承载对话的滚动容器：包含对话正文、可滚动、尽量大；找不到时退回页面滚动根
  function findScrollContainer() {
    if (typeof document === 'undefined') return null;
    const anchors = document.querySelectorAll('[class~="ds-markdown"]');
    let best = null;
    let bestScore = -1;
    const candidates = new Set();
    for (const a of anchors) {
      let node = a.parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        candidates.add(node);
        node = node.parentElement;
      }
    }
    // 有些版本把消息列表放在固定高度的外壳里，正文根并非直接后代；
    // 再从右侧主区域找一遍可滚动容器，避免只认 ds-markdown 的祖先
    document.querySelectorAll('main, [role="main"], [class*="chat"], [class*="message-list"], [class*="conversation"]').forEach(el => {
      candidates.add(el);
    });

    for (const el of candidates) {
      let style;
      try { style = getComputedStyle(el); } catch (e) { continue; }
      if (!style || !/^(auto|scroll|overlay)$/i.test(style.overflowY || '')) continue;
      const extra = el.scrollHeight - el.clientHeight;
      if (extra <= 100 || (el.clientHeight < 200 && extra < 400)) continue;
      const bodyCount = Array.prototype.filter.call(anchors, anchor => el.contains(anchor)).length;
      if (anchors.length && !bodyCount) continue;
      const score = bodyCount * 10000 + el.clientHeight + Math.min(extra, 5000);
      if (score > bestScore) { bestScore = score; best = el; }
    }
    if (best) return best;

    // 整页滚动（body/html）的版本：滚动根同样可以触发历史消息加载
    const root = (typeof document.scrollingElement !== 'undefined' && document.scrollingElement) ||
      document.documentElement;
    if (root && root.scrollHeight - root.clientHeight > 200) return root;
    return null;
  }

  // 预加载锚点：每条用户消息、每个模型正文、以及每张上传图（确保图片所在附件容器进入视口）
  function collectPreloadAnchors(container) {
    const out = [];
    const seen = new Set();
    const add = el => {
      if (!el || !el.nodeType || el.nodeType !== 1 || seen.has(el)) return;
      if (container !== document && container.contains && !container.contains(el)) return;
      seen.add(el);
      out.push(el);
    };
    const SELECTORS = [
      '[class~="ds-markdown"]',
      '[data-role="user"]', '[data-message-role="user"]', '[data-author-role="user"]',
      '[data-message-id]',
      '[class*="user-message"]', '[class*="userMessage"]', '[class*="user-bubble"]',
      '[class*="user_bubble"]', '.user-bubble', '.user-line', '.turn',
      '[class*="chat-message"]', '[class*="message-row"]'
    ].join(',');
    try {
      container.querySelectorAll(SELECTORS).forEach(add);
    } catch (e) { /* 选择器在旧环境不支持时忽略 */ }

    try {
      container.querySelectorAll('img').forEach(img => {
        if (!isUserUploadImage(img)) return;
        // 图片自身滚到视口内最直接；同时把最近的消息行也纳入，保证文字与附件同屏
        add(img);
        let parent = img.parentElement;
        for (let hop = 0; parent && parent !== container && hop < 3; hop++, parent = parent.parentElement) {
          const cls = classNameOf(parent);
          if (cls && /(?:upload|attach|preview|grid|bubble|turn|message)/i.test(cls)) {
            add(parent);
            break;
          }
        }
      });
    } catch (e) { /* 忽略 */ }

    // 文档顺序稳定，便于日志与逐条滚动
    out.sort((a, b) => {
      const p = a.compareDocumentPosition(b);
      if (p & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (p & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return out;
  }

  function forceLazyImages(scope) {
    const root = scope && scope.querySelectorAll ? scope : (typeof document !== 'undefined' ? document : null);
    if (!root) return 0;
    let n = 0;
    root.querySelectorAll('img').forEach(img => { if (forceLazyImage(img)) n++; });
    return n;
  }

  function clampScrollTop(container, value) {
    const max = Math.max(0, (container.scrollHeight || 0) - (container.clientHeight || 0));
    return Math.max(0, Math.min(max, value));
  }

  function scrollMessageIntoView(container, el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); }
    catch (e) { try { el.scrollIntoView(); } catch (e2) { /* 忽略 */ } }

    // scrollIntoView 可能连带滚动整个页面，这里按容器坐标再校准一次，
    // 保证目标消息落在消息列表的可视区中部（长对话逐条滚动依赖这一点）
    try {
      const cRect = container.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      if (cRect && eRect && cRect.height > 0 && eRect.height >= 0) {
        const delta = (eRect.top - cRect.top) - (container.clientHeight - eRect.height) / 2;
        container.scrollTop = clampScrollTop(container, container.scrollTop + delta);
      }
    } catch (e) { /* 无布局信息 */ }
  }

  /**
   * 导出前自动滚动加载全部历史消息（懒加载 / 虚拟滚动兜底）。
   *
   * 旧实现的缺口：只从当前滚动位置向上滚，且顶部加载循环可能耗尽整个预算，
   * 长对话里中间和尾部的消息/图片从未进入视口，懒加载地址一直为空。
   * 现在的顺序：
   *   1) 先到底：让最新消息渲染并触发尾部图片；
   *   2) 回到顶并反复停留，直到 scrollHeight 连续稳定（加载更早的消息）；
   *   3) 逐条消息 + 逐张上传图 scrollIntoView，确保每张图都进入过视口；
   *   4) 再到底停留，强制 loading=lazy → eager，返回原滚动位置的恢复函数。
   *
   * @returns {{scrolled:boolean, reason?:string, container?:Element, restore?:Function,
   *            anchors:number, messageRoots:number, imageCount:number, uploadCount:number, deadlineHit:boolean}}
   */
  async function ensureHistoryLoaded(options) {
    const opts = options || {};
    const budgetMs = opts.budgetMs || PRELOAD_BUDGET_MS;
    const deadline = Date.now() + budgetMs;
    const waitMs = Math.max(20, opts.waitMs || 400);
    const perMessageWaitMs = Math.max(0, opts.perMessageWaitMs != null ? opts.perMessageWaitMs : 60);
    const container = findScrollContainer();

    if (!container) {
      // 没有滚动容器也要强制懒加载图片开始加载（后面还有图片等待兜底）
      forceLazyImages(document);
      if (typeof opts.onStep === 'function') await opts.onStep({ container: document, position: 'single' });
      return {
        scrolled: false, reason: 'no-scroll-container', container: null,
        restore: () => {}, anchors: 0,
        messageRoots: document.querySelectorAll('[class~="ds-markdown"]').length,
        imageCount: document.images ? document.images.length : document.querySelectorAll('img').length,
        uploadCount: collectUploadImages(document).length,
        deadlineHit: false
      };
    }

    const original = Number(container.scrollTop) || 0;
    const originalPageX = typeof window !== 'undefined' && Number.isFinite(window.scrollX) ? window.scrollX : 0;
    const originalPageY = typeof window !== 'undefined' && Number.isFinite(window.scrollY) ? window.scrollY : 0;
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      try { container.scrollTop = original; } catch (e) { /* 忽略 */ }
      // scrollIntoView 可能连带滚动整个页面（消息容器不是页面滚动根时），一并还原
      try {
        if (typeof window !== 'undefined' && typeof window.scrollTo === 'function' &&
          (window.scrollX !== originalPageX || window.scrollY !== originalPageY)) {
          window.scrollTo(originalPageX, originalPageY);
        }
      } catch (e) { /* 忽略 */ }
    };
    const setTop = value => {
      try { container.scrollTop = clampScrollTop(container, value); } catch (e) { /* 忽略 */ }
    };
    const sleepOrStop = async ms => {
      const left = deadline - Date.now();
      await sleep(Math.min(ms, Math.max(0, left)));
    };

    // 虚拟列表冻结自愈：页面停留过久、打印模式残留等会让虚拟列表的渲染窗口与
    // 滚动位置失步（滚动在变、消息节点编号却不变，实测整屏只渲染尾部几条）。
    // 检测到「滚动明显移动但编号签名连续两步不变」时派发一次 resize 事件，
    // 强制虚拟列表重新测量；多次自愈仍无变化则向上抛错，避免静默截断导出。
    function keySignature(scope) {
      const nodes = scope.querySelectorAll('[data-virtual-list-item-key]');
      const out = [];
      for (const el of nodes) out.push(el.getAttribute('data-virtual-list-item-key'));
      return out.join(',');
    }
    const watchdog = (() => {
      let lastKeys = keySignature(container);
      let stalled = 0;
      let dispatches = 0;
      let sawChange = false;
      let lastDispatchAt = 0;
      const notify = moved => {
        const keys = keySignature(container);
        if (keys !== lastKeys) { sawChange = true; lastKeys = keys; stalled = 0; return; }
        if (!moved) return;
        // 长消息跨多屏属正常（编号连续几步不变）；连续 6 步不变才疑似冻结，
        // 且两次自愈至少间隔 3 秒——避免 resize 重渲染风暴拖慢正常滚动。
        if (++stalled >= 6 && Date.now() - lastDispatchAt >= 3000) {
          stalled = 0;
          dispatches++;
          lastDispatchAt = Date.now();
          try { window.dispatchEvent(new Event('resize')); } catch (e) { /* 忽略 */ }
        }
      };
      return {
        notify,
        // 虚拟列表页面（ds-virtual-list）滚动了多步、编号从未变化、自愈多次无效 → 冻结
        frozen: minDispatches => dispatches >= (minDispatches || 3) && !sawChange &&
          /ds-virtual-list/i.test(String(container.className || ''))
      };
    })();

    // 增量模式从当前屏开始向上扫描，随后再从顶部向下扫描；每步先采集再移动。
    // 不能直接跳到底部，否则虚拟列表可能在第一次采集前销毁当前屏节点。
    if (typeof opts.onStep === 'function') {
      const step = Math.max(120, Math.floor((container.clientHeight || 600) * 0.5));
      try {
        for (let i = 0; i < 2000; i++) {
          if (Date.now() > deadline) {
            throw new Error('逐屏采集超时（页面响应异常或历史加载过慢）；请刷新 DeepSeek 页面后重新导出。');
          }
          forceLazyImages(container);
          await opts.onStep({ container, position: container.scrollTop, phase: 'up', index: i });
          const now = Number(container.scrollTop) || 0;
          if (now <= 0) break;
          setTop(Math.max(0, now - step));
          await sleep(Math.max(20, Math.min(waitMs, 180)));
          watchdog.notify(true);
          if (i === 1999) throw new Error('incremental-up-scroll-limit');
        }
      } catch (error) {
        restore();
        throw error;
      }
      if (watchdog.frozen(3)) {
        restore();
        throw new Error('页面虚拟列表未随滚动更新（多次自愈无效，页面状态异常）；' +
          '请刷新 DeepSeek 页面后重新导出。');
      }
    } else {
      setTop(container.scrollHeight);
      await sleepOrStop(waitMs);
      forceLazyImages(container);
    }

    // 2) 反复回到顶部，直到更早消息加载完毕（scrollHeight 连续两轮不变）。
    //    只给顶部加载阶段 40% 预算：即使高度一直因图片解码而抖动，也必须留出时间
    //    执行后面的「逐条消息 scrollIntoView」。
    const topDeadline = typeof opts.onStep === 'function'
      ? deadline : Math.min(deadline, Date.now() + Math.max(3000, budgetMs * 0.4));
    let prevHeight = -1;
    let stable = 0;
    for (let i = 0; i < 120 && Date.now() < topDeadline; i++) {
      setTop(0);
      await sleepOrStop(waitMs);
      forceLazyImages(container);
      const h = container.scrollHeight;
      if (h === prevHeight) {
        if (++stable >= 2) break;
      } else {
        stable = 0;
        prevHeight = h;
      }
    }
    if (typeof opts.onStep === 'function' && stable < 2) {
      restore();
      throw new Error('历史消息加载未稳定，已停止导出以避免漏图');
    }

    // 增量采集：每次移动半个视口就保存当前消息并读取图片。虚拟列表会回收旧节点，
    // 因此不能等滚到底部后再统一读取当时仍留在 DOM 中的图片。
    if (typeof opts.onStep === 'function') {
      const step = Math.max(120, Math.floor((container.clientHeight || 600) * 0.5));
      let visited = 0;
      let lastTop = -1;
      setTop(0);
      try {
        while (visited++ < 2000) {
          if (Date.now() > deadline) {
            throw new Error('逐屏采集超时（页面响应异常或历史加载过慢）；请刷新 DeepSeek 页面后重新导出。');
          }
          await sleep(Math.max(20, Math.min(waitMs, 180)));
          forceLazyImages(container);
          await opts.onStep({ container, position: container.scrollTop, index: visited });
          const now = Number(container.scrollTop) || 0;
          const next = clampScrollTop(container, now + step);
          if (next <= now || now === lastTop) break;
          lastTop = now;
          setTop(next);
          watchdog.notify(true);
        }
      } catch (error) {
        restore();
        throw error;
      }
      if (visited >= 2000) throw new Error('incremental-scroll-limit');
      return {
        scrolled: true, container, restore,
        anchors: visited,
        messageRoots: document.querySelectorAll('[class~="ds-markdown"]').length,
        imageCount: document.images ? document.images.length : document.querySelectorAll('img').length,
        uploadCount: collectUploadImages(container).length,
        deadlineHit: false
      };
    }

    // 3) 逐条消息 / 逐张上传图滚进视口。新加载的消息会追加为新的锚点，
    //    最多补扫两轮，保证长对话中后段没有“从未进入视口”的图片。
    let anchors = collectPreloadAnchors(container);
    const initialCount = anchors.length;
    for (let pass = 0; pass < 2 && Date.now() < deadline; pass++) {
      for (const el of anchors) {
        if (Date.now() >= deadline) break;
        scrollMessageIntoView(container, el);
        forceLazyImage(el && el.tagName === 'IMG' ? el : (el.querySelector ? el.querySelector('img') : null));
        await sleepOrStop(perMessageWaitMs);
      }
      const next = collectPreloadAnchors(container);
      if (next.length === anchors.length) break;
      anchors = next;
    }

    // 4) 再到底部停留：尾部消息与图片最终就位；之后由调用方决定何时恢复滚动位置
    setTop(container.scrollHeight);
    await sleepOrStop(waitMs);
    forceLazyImages(container);

    const imageCount = document.images ? document.images.length : document.querySelectorAll('img').length;
    return {
      scrolled: true,
      container,
      restore,
      anchors: Math.max(initialCount, anchors.length),
      messageRoots: document.querySelectorAll('[class~="ds-markdown"]').length,
      imageCount,
      uploadCount: collectUploadImages(container).length,
      deadlineHit: Date.now() >= deadline
    };
  }

  function collectUploadImages(scope) {
    const root = scope && scope.querySelectorAll ? scope : (typeof document !== 'undefined' ? document : null);
    if (!root) return [];
    const out = [];
    root.querySelectorAll('img').forEach(img => { if (isUserUploadImage(img)) out.push(img); });
    return out;
  }

  /**
   * 等待用户上传图片真正就位：complete === true 且 naturalWidth > 0。
   * - 没有 src 的占位图不空等（转换阶段会把它记入 failed 清单）；
   * - complete 但 naturalWidth 为 0 视为加载失败，同样不空等；
   * - 整体有超时上限，超时未完成的图片仍会被采集，并在转换后进入失败清单。
   */
  async function waitForUploadImages(scope, timeoutMs) {
    const root = scope && scope.querySelectorAll ? scope : (typeof document !== 'undefined' ? document : null);
    const imgs = collectUploadImages(root);
    if (!imgs.length) {
      return { uploadImages: 0, ready: 0, broken: 0, missing: 0, pending: 0, timedOut: false };
    }

    forceLazyImages(root);
    imgs.forEach(forceLazyImage);

    const deadline = Date.now() + (timeoutMs || IMAGE_WAIT_MS);
    let pending = [];
    while (Date.now() < deadline) {
      pending = imgs.filter(img => {
        const src = resolveImageSrc(img);
        if (!src) return false;                                  // 无地址：交给转换失败清单
        if (img.complete && (img.naturalWidth || 0) > 0) return false;
        if (img.complete) return false;                          // 已报错：不空等
        return true;
      });
      if (!pending.length) break;
      await sleep(120);
    }

    const ready = imgs.filter(img => img.complete && (img.naturalWidth || 0) > 0).length;
    const broken = imgs.filter(img => img.complete && !(img.naturalWidth > 0)).length;
    const missing = imgs.filter(img => !resolveImageSrc(img)).length;
    return {
      uploadImages: imgs.length,
      ready,
      broken,
      missing,
      pending: pending.length,
      timedOut: pending.length > 0
    };
  }

  /** 等待页面里尚未加载完的 <img> 结束（load 或 error），整体限时（兼容旧接口） */
  async function waitForPageImages(timeoutMs) {
    if (typeof document === 'undefined' || !document.images) return;
    const pending = Array.from(document.images).filter(i => !i.complete && resolveImageSrc(i));
    if (!pending.length) return;
    const done = pending.map(img => new Promise(res => {
      img.addEventListener('load', () => res(), { once: true });
      img.addEventListener('error', () => res(), { once: true });
    }));
    await Promise.race([Promise.all(done), sleep(timeoutMs || 12000)]);
  }

  /**
   * 导出前的页面准备：滚动加载全部历史 + 逐条消息触发懒加载 + 等待上传图就位。
   * @param {object} [options]
   * @param {boolean} [options.deferRestore] true 时返回 restore 函数，由调用方在采集完成后恢复滚动位置
   */
  async function preparePage(options) {
    const opts = options || {};
    const result = {
      scrolled: false, reason: '', restored: false, restore: null,
      anchors: 0, messageRoots: 0, imageCount: 0, uploadCount: 0,
      ready: 0, broken: 0, missing: 0, pending: 0, timedOut: false, deadlineHit: false
    };
    try {
      const r = await ensureHistoryLoaded(opts);
      Object.assign(result, r);
      result.restore = r.restore || null;
    } catch (e) {
      if (typeof opts.onStep === 'function') throw e;
      result.reason = (e && e.message) || 'scroll-failed';
      try { forceLazyImages(document); } catch (e2) { /* 忽略 */ }
    }

    try {
      const waited = await waitForUploadImages(result.container || document, opts.imageTimeoutMs || IMAGE_WAIT_MS);
      Object.assign(result, waited);
      result.uploadCount = Math.max(result.uploadCount || 0, waited.uploadImages || 0);
    } catch (e) { /* 等待超时不影响导出，失败会在转换阶段记录 */ }

    if (result.restore && !opts.deferRestore) {
      result.restore();
      result.restored = true;
    }
    return result;
  }

  /**
   * 覆盖率审计：页面上的上传图与注册表按元素比对。
   * 返回未被任何消息认领的图片（用于「提示漏图」而不是静默丢掉）。
   */
  function auditCoverage(scope, registry) {
    const root = scope && scope.querySelectorAll ? scope : (typeof document !== 'undefined' ? document : null);
    const out = { total: 0, uploads: 0, registered: 0, unregistered: [] };
    if (!root) return out;
    const registered = new Set();
    if (registry && typeof registry.all === 'function') {
      for (const rec of registry.all()) if (rec && rec.el) registered.add(rec.el);
    }
    root.querySelectorAll('img').forEach(img => {
      out.total++;
      if (!isUserUploadImage(img)) return;
      out.uploads++;
      if (registered.has(img)) { out.registered++; return; }
      out.unregistered.push({
        alt: img.getAttribute('alt') || '',
        src: resolveImageSrc(img),
        width: dimsOf(img).w,
        height: dimsOf(img).h
      });
    });
    return out;
  }

  /* ------------------------------ 读取与转换 ------------------------------ */

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('file-reader-failed'));
      fr.readAsDataURL(blob);
    });
  }

  // fetch（只读 GET）+ FileReader：blob: 与同源 https: 的首选路径
  // 必须带超时：长对话里个别请求卡住会占满并发池，导致后续图片排队直到导出结束
  async function fetchToDataUrl(url, init, timeoutMs) {
    if (typeof fetch !== 'function') return null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => { try { controller.abort(); } catch (e) { /* 忽略 */ } }, Math.max(1, timeoutMs || READ_TIMEOUT_MS))
      : null;
    try {
      const res = await fetch(url, Object.assign({
        method: 'GET', mode: 'cors', credentials: 'omit',
        signal: controller ? controller.signal : undefined
      }, init || {}));
      if (!res.ok) return null;
      const blob = await res.blob();
      if (blob.size > MAX_IMAGE_BYTES) return null;
      if (blob.type && !/^image\//i.test(blob.type) && !/^application\/octet-stream/i.test(blob.type)) return null;
      return await blobToDataUrl(blob);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 跨域图：带 crossOrigin=anonymous 重取并经 canvas 绘制导出，
  // 服务器不给 CORS 头时 load 失败或 toDataURL 抛 SecurityError，调用方按降级处理
  async function canvasFetch(url, timeoutMs) {
    if (typeof Image === 'undefined' || typeof document === 'undefined') return null;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('canvas-image-timeout')), timeoutMs || 12000);
      img.onload = () => { clearTimeout(timer); resolve(); };
      img.onerror = () => { clearTimeout(timer); reject(new Error('canvas-image-load-failed')); };
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    if (!canvas.width || !canvas.height) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  // 用已加载的图片重新编码为 PNG（webp/bmp/svg → Word 可用的格式）
  async function reencodePng(dataUrl) {
    if (typeof Image === 'undefined' || typeof document === 'undefined') return null;
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('decode-timeout')), 8000);
        img.onload = () => { clearTimeout(timer); resolve(); };
        img.onerror = () => { clearTimeout(timer); reject(new Error('decode-failed')); };
        img.src = dataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      if (!canvas.width || !canvas.height) return null;
      canvas.getContext('2d').drawImage(img, 0, 0);
      return canvas.toDataURL('image/png');
    } catch (e) {
      return null;
    }
  }

  function decodeDims(dataUrl) {
    if (typeof Image === 'undefined') return Promise.resolve({ w: 0, h: 0 });
    return new Promise(resolve => {
      const img = new Image();
      const timer = setTimeout(() => resolve({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 }), 8000);
      img.onload = () => { clearTimeout(timer); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = () => { clearTimeout(timer); resolve({ w: 0, h: 0 }); };
      img.src = dataUrl;
    });
  }

  // 统一收尾：格式归一（Word 只认 png/jpeg/gif）、量尺寸、解字节
  async function finalizeDataUrl(dataUrl) {
    const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(dataUrl);
    if (!m) return null;
    let mime = m[1].toLowerCase() || 'image/png';
    let b64 = m[2];
    if (!KEEP_MIMES.has(mime)) {
      const png = await reencodePng(dataUrl);
      if (!png) return null;
      const pm = /^data:([^;,]+);base64,([\s\S]*)$/.exec(png);
      if (!pm) return null;
      dataUrl = png;
      mime = pm[1].toLowerCase();
      b64 = pm[2];
    }
    const dims = await decodeDims(dataUrl);
    const bytes = DSMD.zip && DSMD.zip.base64Decode ? DSMD.zip.base64Decode(b64) : new Uint8Array(0);
    return {
      dataUrl,
      b64,
      mime,
      ext: extForMime(mime),
      bytes: bytes.length,
      width: dims.w,
      height: dims.h
    };
  }

  async function readImage(src, options) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || READ_TIMEOUT_MS;
    if (!src) return null;

    if (/^data:/i.test(src)) return await finalizeDataUrl(src);

    if (/^blob:/i.test(src)) {
      const d = await fetchToDataUrl(src, {}, timeoutMs);
      return d ? await finalizeDataUrl(d) : null;
    }

    const abs = absoluteUrl(src);
    if (!/^https?:/i.test(abs)) return null;

    // 同源：fetch 同源图片不涉及跨域，凭当前登录态即可
    if (sameOrigin(abs)) {
      try {
        const d = await fetchToDataUrl(abs, { credentials: 'include' }, timeoutMs);
        return d ? await finalizeDataUrl(d) : null;
      } catch (e) { /* 落到跨域分支重试 */ }
    }

    // 跨域：先 canvas（带 CORS），失败再试 fetch（服务器可能只对 XHR 放行），
    // 都不行 → 返回 null，调用方按「保留原始 URL」降级
    let d = null;
    try { d = await canvasFetch(abs, timeoutMs); } catch (e) { /* 降级 */ }
    if (!d) {
      try { d = await fetchToDataUrl(abs, {}, timeoutMs); } catch (e) { /* 降级 */ }
    }
    return d ? await finalizeDataUrl(d) : null;
  }

  // DeepSeek 文件服务的变体参数：ty=t 是 ~240px 缩略图（页面懒加载用的预览），
  // ty=p 是原图分辨率。抓取前统一升级，否则导出文件里内嵌的是缩略图，图片严重模糊。
  function upgradeFileUrl(src) {
    const s = String(src || '');
    if (!/^https?:/i.test(s)) return s;
    if (/[?&]ty=t(&|$)/.test(s)) return s.replace(/([?&])ty=t(&|$)/, '$1ty=p$2');
    return s;
  }

  // 就地升级一批记录的远程地址（同步、零成本）：滚动采集阶段调用，
  // 抓取统一放到滚动结束后进行（见 convertAll 的调用方）。
  function upgradeRecordUrls(records) {
    const list = Array.isArray(records) ? records : [];
    for (const rec of list) {
      if (rec && rec.src && /^https?:/i.test(rec.src) && rec.status !== 'embedded') {
        rec.src = upgradeFileUrl(rec.src);
      }
    }
    return list;
  }

  // 等待懒加载图片的地址稳定：DeepSeek 会先渲染 ~240px 的预览变体，
  // 完整原图加载完成后 React 再把 src 换成原图地址。连续 ~400ms 地址不再变化
  // 视为稳定（期间节点可能完成加载），整体限时，超时按当前地址继续。
  async function waitForImageSrcStable(el, timeoutMs) {
    if (!el || !el.isConnected) return '';
    const deadline = Date.now() + (timeoutMs || 2500);
    let last = String(el.currentSrc || el.src || '');
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      if (!el.isConnected) break;
      const now = String(el.currentSrc || el.src || '');
      if (now !== last) { last = now; stableSince = Date.now(); }
      else if (el.complete && Date.now() - stableSince >= 400) break;
      await sleep(120);
    }
    return last;
  }

  async function convertRecord(rec, cache, options) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || READ_TIMEOUT_MS;
    const retries = opts.retries != null ? opts.retries : READ_RETRIES;
    // 数据已就位的记录（Mermaid 图表栅格化结果）无需再读，且没有 src 可读
    if (rec.status === 'embedded' && rec.dataUrl) return;
    let src = rec.src || '';
    // 换址等待：记录还挂着页面节点时，先等懒加载把预览地址换成原图地址，
    // 用最终地址抓取——否则会把 240px 缩略图当成「转换成功」内嵌进导出文件。
    if (rec.el && rec.el.isConnected && /^https?:/i.test(src)) {
      try {
        const settled = await waitForImageSrcStable(rec.el, Math.min(timeoutMs, 2500));
        if (settled && settled !== src) {
          src = settled;
          rec.src = settled;
        }
      } catch (e) { /* 等待失败按原地址转换 */ }
    }
    if (!src) {
      rec.status = 'failed';
      rec.failureReason = 'missing-src';
      rec.el = null;
      return;
    }

    // 缩略图变体升级：优先抓 ty=p 原图；升级地址整体拿不到时退回原地址
    //（至少保留缩略图，不至于变成加载失败）。
    const preferred = upgradeFileUrl(src);
    const fallbackSrc = preferred !== src ? src : '';
    if (preferred !== src) {
      src = preferred;
      rec.src = preferred;
    }

    let lastReason = '';
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        let pending = cache.get(src);
        if (!pending) {
          pending = withTimeout(readImage(src, { timeoutMs }), timeoutMs + 1000, 'image-read-timeout')
            .then(got => {
              if (!got) cache.delete(src);           // 失败不缓存，允许下一张/下次重试
              return got;
            }, err => {
              cache.delete(src);
              throw err;
            });
          cache.set(src, pending);
        }
        const got = await pending;
        if (got) {
          // 像素守卫：抓到的图明显小于页面节点的当前尺寸，说明抓到的是缩略图变体，
          // 而节点 src 已经被换成更大的地址——立刻改用最新地址重抓（占用一次重试）。
          const el = (rec.el && rec.el.isConnected) ? rec.el : null;
          const newerSrc = el ? String(el.currentSrc || el.src || '') : '';
          if (el && got.width > 0 && (el.naturalWidth || 0) > got.width * 1.5 &&
            newerSrc && newerSrc !== src) {
            cache.delete(src);
            src = newerSrc;
            rec.src = newerSrc;
            lastReason = 'thumbnail-upgrade';
            continue;
          }
          rec.dataUrl = got.dataUrl;
          rec.b64 = got.b64;
          rec.mime = got.mime;
          rec.ext = got.ext;
          rec.bytes = got.bytes;
          if (got.width) rec.width = got.width;
          if (got.height) rec.height = got.height;
          rec.status = 'embedded';
          rec.failureReason = '';
          rec.el = null;                       // 数据已落地，释放对页面节点的引用
          return;
        }
        lastReason = 'unreadable';
      } catch (e) {
        lastReason = (e && e.message) || 'read-failed';
      }

      cache.delete(src);
      // ty=p 升级地址整体失败：退回页面原始地址（缩略图）再试
      if (fallbackSrc && src === preferred) {
        src = fallbackSrc;
        rec.src = fallbackSrc;
        continue;
      }
      if (attempt < retries) await sleep(300 * (attempt + 1));
    }

    rec.status = /^https?:/i.test(absoluteUrl(src)) ? 'remote' : 'failed';
    rec.failureReason = lastReason || (rec.status === 'remote' ? 'not-embeddable' : 'read-failed');
    rec.el = null;
  }

  /**
   * 把注册表里全部图片转换为 base64（并发池、相同 src 只读一次），
   * 成功者按注册顺序统一命名为 user-001.png / user-002.jpg …
   * 失败项不会被吞掉：status=remote/failed 并记录 failureReason，
   * 由 failuresOf() 汇总给 UI 提示与控制台清单。
   */
  async function convertAll(records, options) {
    const opts = options || {};
    const target = Array.isArray(records) ? records : [];
    const list = target.slice();
    const cache = opts.cache || new Map();
    let cursor = 0;
    let done = 0;

    const worker = async () => {
      while (cursor < list.length) {
        const rec = list[cursor++];
        try {
          await convertRecord(rec, cache, {
            timeoutMs: opts.timeoutMs || READ_TIMEOUT_MS,
            retries: opts.retries != null ? opts.retries : READ_RETRIES
          });
        } catch (error) {
          rec.status = 'failed';
          rec.failureReason = (error && error.message) || 'unexpected-conversion-error';
          rec.el = null;
        }
        done++;
        if (typeof opts.onProgress === 'function') {
          try { opts.onProgress({ done, total: list.length, record: rec }); } catch (e) { /* 忽略 */ }
        }
      }
    };
    const concurrency = Math.max(1, Math.min(opts.concurrency || CONVERT_CONCURRENCY, list.length || 1));
    await Promise.all(Array.from({ length: concurrency }, worker));

    let n = 0;
    for (const rec of target) {
      if (rec.status === 'embedded') {
        if (rec.filename) continue;          // Mermaid 图表等已命名的记录不改名
        n++;
        rec.filename = `user-${String(n).padStart(3, '0')}.${rec.ext}`;
      }
    }
    return target;
  }

  /* ------------------------------- 统计与合并 ------------------------------- */

  function statsOf(records) {
    const list = Array.isArray(records) ? records : [];
    return {
      total: list.length,
      embedded: list.filter(r => r.status === 'embedded').length,
      remote: list.filter(r => r.status === 'remote').length,
      failed: list.filter(r => r.status === 'failed').length,
      pending: list.filter(r => r.status === 'pending').length,
      bytes: list.reduce((n, r) => n + (r.status === 'embedded' ? r.bytes || 0 : 0), 0)
    };
  }

  /**
   * 失败清单：所有「没能内嵌进导出文件」的用户上传图。
   * remote（跨域读不到，Markdown 里只能保留链接）也计入——
   * PDF / Word 里它同样无法显示，不能对用户报「全部导出成功」。
   * @returns {Array<{id:number, alt:string, src:string, role:string, status:string, reason:string}>}
   */
  function failuresOf(records) {
    const list = Array.isArray(records) ? records : [];
    return list
      .filter(r => r && r.kind !== 'mermaid' && r.status !== 'embedded')
      .map(r => ({
        id: r.id,
        alt: r.alt || '',
        src: r.src || '',
        role: r.role === 'assistant' ? 'assistant' : 'user',
        status: r.status,
        reason: r.failureReason || (r.status === 'remote' ? 'cross-origin' : 'conversion-failed')
      }));
  }

  // 超过单文件内嵌上限时改打包 .zip
  function embedModeFor(records) {
    return statsOf(records).bytes > EMBED_TOTAL_LIMIT ? 'zip' : 'embed';
  }

  const normalizeKey = s => String(s || '').replace(/!\[[^\]]*\]\(dsmd-img:\/\/\d+\)/g, '')
    .replace(/\\|\s+/g, '').slice(0, 120);

  /**
   * 数据源选了接口通道时，把页面侧收集到的图片按用户轮次贴回接口消息：
   * 优先按正文文本匹配；匹配不上的按用户消息顺序对齐（页面可能只渲染了尾部消息，
   * 因此优先从末尾对齐），最后仍无法归属的图片记录到返回数组的 attachFailures 上，
   * 由 content.js 统一提示，避免接口通道下图片静默消失。
   */
  function attachToApiMessages(apiMessages, domMessages, images) {
    const out = images;
    if (!images || !images.length || !Array.isArray(apiMessages) || !Array.isArray(domMessages)) return out;

    const domUsers = domMessages.filter(m => m && m.role === 'user');
    const groups = [];
    domUsers.forEach((dm, ui) => {
      const ids = refIdsOf(dm.body);
      if (ids.length) groups.push({ ui, ids, key: normalizeKey(dm.body), matched: false });
    });
    if (!groups.length) return out;

    const apiUsers = apiMessages.filter(m => m && m.role === 'user');
    const apiIndex = new Map(apiUsers.map((m, i) => [m, i]));
    const used = new Set();
    const attachedIds = new Set();
    const append = (msg, ids) => {
      if (!msg) return false;
      const refs = ids.map(id => tokenFor(id)).filter(Boolean);
      if (!refs.length) return false;
      msg.body = msg.body ? `${msg.body}\n\n${refs.join('\n\n')}` : refs.join('\n\n');
      for (const id of ids) attachedIds.add(id);
      const at = apiIndex.get(msg);
      if (at != null) used.add(at);
      return true;
    };

    // 1) 正文文本匹配（最可靠，允许前缀互含）
    for (const am of apiUsers) {
      const key = normalizeKey(am.body);
      if (!key) continue;
      const hit = groups.find(g => !g.matched && g.key &&
        (g.key === key || key.indexOf(g.key) === 0 || g.key.indexOf(key) === 0));
      if (hit) { hit.matched = append(am, hit.ids); }
    }

    // 2) 顺序对齐：接口消息可能比页面多出早前消息，优先按尾部对齐；
    //    页面未渲染早前消息时，第一条 DOM 用户消息对应 apiUsers[apiUsers.length - domUsers.length]。
    const offset = Math.max(0, apiUsers.length - domUsers.length);
    for (const g of groups) {
      if (g.matched) continue;
      let target = g.ui + offset;
      if (target >= apiUsers.length) target = apiUsers.length - 1;
      while (target >= 0 && target < apiUsers.length && used.has(target) && target < apiUsers.length - 1) target++;
      if (target >= 0 && target < apiUsers.length && !used.has(target)) {
        g.matched = append(apiUsers[target], g.ids);
      }
    }

    // 3) 仍未归属的图片：不静默丢掉，记录失败清单
    const attachFailures = [];
    for (const g of groups) {
      if (g.matched) continue;
      for (const id of g.ids) {
        const rec = images.find(r => r && r.id === id);
        attachFailures.push({
          id,
          alt: (rec && rec.alt) || '',
          src: (rec && rec.src) || '',
          role: 'user',
          status: 'failed',
          reason: 'message-not-matched'
        });
      }
    }
    if (attachFailures.length && Array.isArray(out)) {
      try {
        Object.defineProperty(out, 'attachFailures', {
          value: attachFailures, enumerable: false, configurable: true
        });
      } catch (e) { out.attachFailures = attachFailures; }
    }
    return out;
  }

  /* --------------------- 长图横向切割（PDF / Word 排版共用） --------------------- */

  // 把一张已内嵌的图片按固定源像素行数横向切成多条，逐条返回独立的数据 URL。
  // 用于导出排版：显示高度超过一页的长图先切割再依次插入连续页面，
  // 避免为了塞进单页而被等比压扁到无法辨认。
  //   dataUrl   图片数据（data:image/...;base64,...）
  //   srcW/srcH 源图像素尺寸
  //   srcRows   每条覆盖的源像素行数（最后一条允许更短）
  // 返回 Promise<Array<{dataUrl, width, height, ext}>>；源高不足一条或参数非法时返回 null。
  // JPEG 源保持 JPEG 重编码（避免照片体积膨胀），其余一律 PNG（截图无损）。
  async function sliceDataUrl(dataUrl, srcW, srcH, srcRows) {
    if (!dataUrl || !(srcW > 0) || !(srcH > 0) || !(srcRows > 0) || srcH <= srcRows) return null;
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('slice: decode failed'));
      el.src = dataUrl;
    });
    const count = Math.ceil(srcH / srcRows);
    const isJpeg = /^data:image\/jpeg[;,]/i.test(dataUrl);
    const ext = isJpeg ? 'jpeg' : 'png';
    const mime = isJpeg ? 'image/jpeg' : 'image/png';
    const slices = [];
    for (let k = 0; k < count; k++) {
      const sy = k * srcRows;
      const sh = Math.min(srcRows, srcH - sy);
      const canvas = document.createElement('canvas');
      canvas.width = srcW;
      canvas.height = sh;
      canvas.getContext('2d').drawImage(img, 0, sy, srcW, sh, 0, 0, srcW, sh);
      slices.push({
        dataUrl: canvas.toDataURL(mime, isJpeg ? 0.92 : undefined),
        width: srcW,
        height: sh,
        ext
      });
    }
    return slices;
  }

  DSMD.imageTools = {
    isUserUploadImage,
    resolveImageSrc,
    harvestInto,
    harvestTurn,
    diagnose,
    createRegistry,
    tokenFor,
    refIdsOf,
    IMG_REF_RE,
    preparePage,
    ensureHistoryLoaded,
    waitForPageImages,
    waitForUploadImages,
    collectUploadImages,
    collectPreloadAnchors,
    forceLazyImages,
    auditCoverage,
    convertAll,
    statsOf,
    failuresOf,
    embedModeFor,
    attachToApiMessages,
    upgradeRecordUrls,
    sliceDataUrl,
    EMBED_TOTAL_LIMIT,
    CONVERT_CONCURRENCY,
    READ_TIMEOUT_MS,
    internals: {
      absoluteUrl, sameOrigin, extForMime, dimsOf, findScrollContainer, readImage,
      finalizeDataUrl, isBefore, backgroundUploads, withTimeout, forceLazyImage,
      isPlaceholderSrc, pickSrcsetUrl, upgradeFileUrl, CONVERT_CONCURRENCY, READ_TIMEOUT_MS,
      base64Decode: () => (DSMD.zip && DSMD.zip.base64Decode)
    }
  };
})();
