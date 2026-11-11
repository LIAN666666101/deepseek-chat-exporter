/**
 * dom-extractor.js —— 直接从已渲染的页面读取当前对话（完全离线，不发任何请求）
 *
 * 为什么要有这条通道：
 *   DeepSeek 的会话接口没有公开文档，字段结构已经改过一次（content → fragments），
 *   只要再改一次，纯接口方案就会再次导出空文件。页面 DOM 是用户亲眼所见的内容，
 *   读取它不依赖任何字段命名，因此把它作为首选通道。
 *
 * 识别策略（不依赖随时会变的哈希类名）：
 *   - 助手正文：DeepSeek 的 Markdown 渲染根节点固定带 ds-markdown 类，取最外层。
 *   - 用户消息：显式标记（data-role / 语义类名）优先；否则用布局特征判断
 *     （气泡宽度小于列宽且紧贴右侧 = 用户气泡，模型回复是整列宽）。
 *   - 思考过程：含 thinking / reasoning 语义的容器，或「深度思考」折叠块。
 *   - 时序：以用户气泡为轮次分隔，同一轮里最后一个正文根是正式回复，
 *     位于其上方且属于思考容器的正文归入思考过程。
 */
(() => {
  'use strict';

  const DSMD = (globalThis.__DSMD__ || (globalThis.__DSMD__ = {}));

  const BODY_ROOT_SELECTOR = '[class~="ds-markdown"]';
  const GENERIC_MARKDOWN_SELECTOR = '[class*="markdown-body"],[class*="markdownBody"],[class*="ds-markdown"]';

  const NOISE_CLASS_RE = /(?:^|[\s_-])(?:icons?|toolbar|actions?|btn|button|copy|avatar|feedback|thumb|regenerate|share|spinner|skeleton|loading|sr-only|visually-hidden)(?:[\s_-]|$)/i;
  const USER_CLASS_RE = /(?:^|[\s_-])(?:user[-_]?(?:message|msg|bubble|content|query|question|input|text|turn)|message[-_]?user|chat[-_]?user|human[-_]?(?:message|msg|turn)|question[-_]?(?:text|content|bubble))(?:[\s_-]|$)/i;
  const USER_NEGATIVE_CLASS_RE = /(?:^|[\s_-])(?:assistant|answer|response|reply|markdown|thinking|reasoning|sidebar|nav|menu|header|footer|input[-_]?box|editor|textarea|history|list|dialog|modal|toast|tooltip|scroll)(?:[\s_-]|$)/i;
  const THINK_CLASS_RE = /(?:^|[\s_-])(?:thinking|think|reasoning|thought|deep[-_]?think|ds[-_]?think|chain[-_]?of[-_]?thought)(?:[\s_-]|$)/i;
  const THINK_TEXT_RE = /^(?:已?深度思考|思考过程|思考中|正在思考|Thinking|Reasoning|Thought)/i;
  // 分支切换器：页面在「被修改过 / 重新生成过」的消息旁渲染的「1 / 2」版本指示
  const BRANCH_SWITCHER_RE = /^(\d+)\s*\/\s*(\d+)$/;
  // 用户消息长度上限：显式角色标记可以完全信任；纯布局判断留出更大余量。
  // 旧上限 4000 会把带多张图的长提问整条漏掉（连带图片一起丢失）。
  const MAX_USER_TEXT_EXPLICIT = 50000;
  const MAX_USER_TEXT_GEOMETRY = 12000;

  const className = el => {
    if (!el) return '';
    const c = typeof el.className === 'string' ? el.className : el.getAttribute('class');
    return c || '';
  };

  const textOf = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();

  /* -------------------------------- 正文根节点 -------------------------------- */

  function isBodyRoot(el) {
    const cls = className(el);
    if (!/(?:^|\s)ds-markdown(?:\s|$)/.test(cls)) return false;
    if (/(?:^|\s)ds-markdown-[a-z]/.test(cls)) return false;   // ds-markdown-paragraph 之类的子部件
    return true;
  }

  function collectBodyRoots(scope) {
    const hits = [];
    scope.querySelectorAll(BODY_ROOT_SELECTOR).forEach(el => { if (isBodyRoot(el)) hits.push(el); });
    const outer = hits.filter(el => !hits.some(o => o !== el && o.contains(el)));
    if (outer.length) return { roots: outer, kind: 'ds-markdown' };

    // 退化：通用 markdown 容器，取最内层，避免把整个会话外壳当成一条消息
    const generic = [];
    scope.querySelectorAll(GENERIC_MARKDOWN_SELECTOR).forEach(el => {
      if (el.querySelector(GENERIC_MARKDOWN_SELECTOR)) return;
      if (NOISE_CLASS_RE.test(className(el))) return;
      generic.push(el);
    });
    return { roots: generic, kind: generic.length ? 'generic-markdown' : 'none' };
  }

  function deepestCommonAncestor(nodes) {
    if (!nodes.length) return null;
    let cur = nodes[0];
    while (cur) {
      if (nodes.every(n => cur.contains(n))) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  /* --------------------------------- 顺序判定 --------------------------------- */

  /**
   * 排序依据：优先用元素在页面上的纵向位置（top 越小越靠上），
   * 这正是网页端呈现给用户的对话顺序，与 DOM 结构无关——
   * 有些实现会为了滚动方便把 DOM 倒着渲染（配合 column-reverse），
   * 只看文档顺序就会导出成「回复在前、提问在后」。
   * 拿不到布局信息时（元素不可见、无头环境等）退回文档顺序，
   * 并识别反向布局把它翻转回来。
   */
  function buildOrderMap(container, elements) {
    const docIndex = new Map();
    let i = 0;
    docIndex.set(container, i++);
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) docIndex.set(node, i++);

    const reversedLayout = isReverseLayout(container);

    // 收集视觉位置；只有绝大多数元素都能测到高度时才采信，避免半套数据把顺序搅乱
    const tops = new Map();
    let measurable = 0;
    for (const el of elements) {
      const rect = rectOf(el);
      if (rect) {
        tops.set(el, rect.top);
        measurable++;
      }
    }
    const useGeometry = elements.length > 0 && measurable >= elements.length * 0.8;

    const map = new Map();
    for (const el of elements) {
      if (useGeometry && tops.has(el)) {
        map.set(el, tops.get(el));                 // 视觉纵向位置：与网页端呈现顺序一致
      } else {
        map.set(el, docIndex.has(el) ? docIndex.get(el) : Number.MAX_SAFE_INTEGER);
      }
    }
    // reversed 交给调用方在「轮次」层面处理：反向布局只翻转轮次之间的顺序，
    // 一轮内部依然是提问在前、回复在后，整段取负会把轮内顺序也弄反。
    return { map, mode: useGeometry ? 'visual' : 'document', reversed: reversedLayout };
  }

  function rectOf(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    try {
      const r = el.getBoundingClientRect();
      return r && r.height > 0 && Number.isFinite(r.top) ? r : null;
    } catch (e) {
      return null;
    }
  }

  // 反向布局：flex-direction: column-reverse / row-reverse、direction: rtl 等
  function isReverseLayout(el) {
    if (typeof getComputedStyle !== 'function') return false;
    let node = el;
    for (let depth = 0; node && depth < 8; node = node.parentElement, depth++) {
      let style;
      try { style = getComputedStyle(node); } catch (e) { continue; }
      if (!style) continue;
      if (/reverse/i.test(style.flexDirection || '')) return true;
      if (/reverse/i.test(style.flexWrap || '')) return true;
      if (/^rtl$/i.test(style.direction || '')) return true;
    }
    return false;
  }

  const indexOf = (order, el) => {
    const v = order.map.get(el);
    return v === undefined ? Number.MAX_SAFE_INTEGER : v;
  };

  /* --------------------------------- 几何信号 --------------------------------- */

  function geometrySignal(el, container) {
    if (typeof el.getBoundingClientRect !== 'function') return null;
    let a, c;
    try {
      a = el.getBoundingClientRect();
      c = container.getBoundingClientRect();
    } catch (e) {
      return null;
    }
    if (!a || !c || !(c.width > 0) || !(a.width > 0) || !(a.height > 0)) return null;

    const rightGap = c.right - a.right;
    if (a.width <= c.width * 0.9 && rightGap <= Math.max(48, c.width * 0.08)) return 'user';
    if (a.width >= c.width * 0.92) return 'full';
    return 'partial';
  }

  /* --------------------------------- 用户气泡 --------------------------------- */

  function userSignal(el, container) {
    const cls = className(el);
    const text = textOf(el);
    // 分支切换器（「1 / 2」这类窄小的右对齐版本指示）不是用户消息——
    // 旧版会把它误判成独立气泡，导出成正文下方的「## User / 1 / 2」段落；
    // 它由 collectBranchSwitchers 收割后附着到对应消息，随角色标题同行导出
    if (BRANCH_SWITCHER_RE.test(text) && text.length <= 12) return null;
    // 纯图片消息（只上传了图、没打字）也必须识别：气泡无文字但含用户上传图时放行
    const hasUpload = !text && DSMD.imageTools &&
      Array.prototype.some.call(el.querySelectorAll('img'), i => DSMD.imageTools.isUserUploadImage(i));
    if (!text && !hasUpload) return null;
    if (isBodyRoot(el)) return null;
    if (el.querySelector(BODY_ROOT_SELECTOR)) return null;
    if (NOISE_CLASS_RE.test(cls)) return null;

    // 用户气泡里不可能装着模型的思考过程或折叠区；
    // 这一条能挡住「整轮外壳」被误判为用户消息（外壳宽度也常小于容器宽度）。
    if (el.querySelector('details, summary') ||
      el.querySelector('[class*="thinking"], [class*="think-"], [class*="reasoning"]')) return null;

    const role = String(
      el.getAttribute('data-role') ||
      el.getAttribute('data-message-role') ||
      el.getAttribute('data-author-role') || ''
    ).toLowerCase();
    if (role === 'user' || role === 'human') return text.length <= MAX_USER_TEXT_EXPLICIT ? 'explicit' : null;

    const testid = el.getAttribute('data-testid') || '';
    if (/user|question|prompt|request/i.test(testid)) return text.length <= MAX_USER_TEXT_EXPLICIT ? 'explicit' : null;

    if (USER_CLASS_RE.test(cls) && !USER_NEGATIVE_CLASS_RE.test(cls)) return text.length <= MAX_USER_TEXT_EXPLICIT ? 'explicit' : null;

    // 布局信号：右侧窄气泡才是用户消息，且不能长到像一整轮对话
    if (text.length <= MAX_USER_TEXT_GEOMETRY && geometrySignal(el, container) === 'user') return 'geometry';
    return null;
  }

  function rowFor(el, container, bodyRoots) {
    let node = el;
    const limit = textOf(el).length;
    while (node.parentElement && node.parentElement !== container && container.contains(node.parentElement)) {
      const p = node.parentElement;
      if (p === document.body || p === document.documentElement) break;
      if (bodyRoots.some(r => p.contains(r))) break;                        // 再往上就跨到模型回复了
      if (textOf(p).length > Math.max(limit * 1.4, limit + 60)) break;      // 再往上就吃进别的消息了
      node = p;
    }
    return node;
  }

  function collectUserBubbles(container, bodyRoots) {
    const found = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    let el = walker.nextNode();

    while (el) {
      const insideBody = bodyRoots.some(r => r === el || r.contains(el));
      let hit = null;

      if (!insideBody) {
        hit = userSignal(el, container);
        if (!hit && el.getAttribute && el.getAttribute('role') === 'button') hit = null;
      }

      if (hit) {
        found.push({ el, row: rowFor(el, container, bodyRoots), signal: hit });
        // 命中后跳过整棵子树，避免同一气泡的嵌套元素被重复计入
        let n = walker.nextNode();
        while (n && el.contains(n)) n = walker.nextNode();
        el = n;
        continue;
      }

      el = walker.nextNode();
    }

    // 去掉被外层命中项包含的内层项
    const pruned = found.filter(f => !found.some(o => o !== f && o.el.contains(f.el)));
    pruned.sort((a, b) => {
      const pa = a.el.compareDocumentPosition(b.el);
      if (pa & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pa & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return pruned;
  }

  /* --------------------------------- 思考过程 --------------------------------- */

  function collectThinkingBlocks(container, bodyRoots) {
    const hits = [];

    // 1) 折叠块 <details>，summary 含「思考」语义
    container.querySelectorAll('details').forEach(d => {
      const summary = d.querySelector('summary');
      if (summary && THINK_TEXT_RE.test(textOf(summary))) hits.push(d);
    });

    // 2) 语义类名容器
    container.querySelectorAll('*').forEach(el => {
      const cls = className(el);
      if (!cls || !THINK_CLASS_RE.test(cls)) return;
      if (NOISE_CLASS_RE.test(cls)) return;
      if (!textOf(el)) return;
      hits.push(el);
    });

    const outer = hits.filter(el => !hits.some(o => o !== el && o.contains(el)));

    return outer.filter(el => {
      if (bodyRoots.some(r => r === el)) return false;
      const innerRoots = bodyRoots.filter(r => el.contains(r));
      if (innerRoots.length > 1) return false;        // 吃掉多条正文，说明是外壳而非思考块
      return true;
    });
  }

  function isLikelyThinkingRoot(root, answer, thinkBlocks) {
    if (thinkBlocks.some(b => b === root || b.contains(root))) return true;

    let p = root.parentElement;
    while (p && p !== document.body && !p.contains(answer)) {
      if (THINK_CLASS_RE.test(className(p))) return true;
      const sib = p.nextElementSibling;
      if (sib && sib.contains && sib.contains(answer)) return true;
      p = p.parentElement;
    }
    return false;
  }

  // 读取用户消息正文。即使气泡元素选得过宽（外壳节点），
  // 也先把模型侧的思考区与正文根摘掉，保证用户内容里不会混入模型输出。
  // registry 存在时，收割本轮所有用户上传图：
  //   - 气泡内的图 → 占位引用按原位置留在正文里
  //   - 气泡外（同一轮附件容器）的图 → 按文档先后拼到正文开头/结尾
  // 占位符与文字的先后 = DOM 里的先后，后续由三个渲染器统一解析成图片。
  function userBodyOf(el, thinkBlocks, bodyRoots, registry, imgScope, meta) {
    const clone = el.cloneNode(true);

    let before = '';
    let after = '';
    if (registry && DSMD.imageTools) {
      if (typeof DSMD.imageTools.harvestTurn === 'function') {
        const r = DSMD.imageTools.harvestTurn(imgScope || el, el, clone, registry, meta || { role: 'user' });
        before = r.before;
        after = r.after;
      } else {
        DSMD.imageTools.harvestInto(clone, el, registry, meta || { role: 'user' });
      }
    }

    const strip = node => {
      if (!node || !node.querySelectorAll) return;
      node.querySelectorAll('details, summary, [class*="thinking"], [class*="think-"], [class*="reasoning"]')
        .forEach(n => n.remove());
      node.querySelectorAll(BODY_ROOT_SELECTOR).forEach(n => n.remove());
      // 分支切换器若随行容器进入克隆树，剔叶子节点，避免「1 / 2」混进正文
      node.querySelectorAll('*').forEach(n => {
        if (n.children.length === 0 && BRANCH_SWITCHER_RE.test(textOf(n)) && textOf(n).length <= 12) n.remove();
      });
    };
    strip(clone);

    if (thinkBlocks.concat(bodyRoots).some(n => n === el)) return '';

    const text = DSMD.htmlToMarkdown(clone, { plainText: true });
    const body = (before + text + after).trim();
    return body;
  }

  // 从思考块里取文本，去掉「深度思考（用时 x 秒）」这类标题行
  function thinkingTextOf(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('summary, button, svg, [class*="toolbar"], [class*="icon"]').forEach(n => n.remove());

    let removed = 0;
    for (const n of clone.querySelectorAll('*')) {
      if (removed >= 3) break;
      if (n.children.length > 0) continue;
      const t = textOf(n);
      if (t && t.length <= 24 && THINK_TEXT_RE.test(t)) {
        n.remove();
        removed++;
      }
    }

    return DSMD.htmlToMarkdown(clone, { plainText: false });
  }

  /* ------------------------------- 分支切换器 ------------------------------- */

  // 与锚点（用户气泡 / 正文根）纵向位置最近的锚点；无布局信息时退回容器内文档序距离
  function nearestAnchor(el, anchors, tops, docIndexOf) {
    const rect = rectOf(el);
    const myTop = rect ? rect.top : null;
    const myDoc = docIndexOf(el);
    let best = null;
    let bestDist = Infinity;
    for (const a of anchors) {
      let dist;
      if (myTop != null && tops.has(a.el)) {
        dist = Math.abs(tops.get(a.el) - myTop);
      } else {
        dist = Math.abs(docIndexOf(a.el) - myDoc);
      }
      if (dist < bestDist) { bestDist = dist; best = a; }
    }
    return best;
  }

  /**
   * 收割分支切换器并关联到对应消息：页面在「被修改 / 重新生成」的消息旁渲染
   * 「1 / 2」版本指示，切换到哪个分支它就显示哪个分支的位置。
   * 返回 Map(锚点元素 → '当前 / 总数')。
   */
  function collectBranchSwitchers(container, roots, bubbles, order) {
    const map = new Map();
    const anchors = [
      ...bubbles.map(b => ({ el: b.el })),
      ...roots.map(r => ({ el: r }))
    ];
    if (!anchors.length) return map;

    const tops = new Map();
    for (const a of anchors) {
      const r = rectOf(a.el);
      if (r) tops.set(a.el, r.top);
    }

    // 容器内统一的文档序号：布局不可用时作为距离兜底（保证切换器能参与比较）
    const docIndex = new Map();
    {
      let i = 0;
      docIndex.set(container, i++);
      const w = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = w.nextNode())) docIndex.set(n, i++);
    }
    const docIndexOf = el => docIndex.has(el) ? docIndex.get(el) : Number.MAX_SAFE_INTEGER;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    let el = walker.nextNode();
    while (el) {
      const insideRoot = roots.some(r => r === el || r.contains(el));
      const insideBubble = bubbles.some(b => b.el === el || b.el.contains(el));
      if (!insideRoot && !insideBubble) {
        const text = textOf(el);
        const m = BRANCH_SWITCHER_RE.exec(text);
        if (m && text.length <= 12) {
          const rect = rectOf(el);
          // 切换器是很小的元素；有布局时还要尺寸过关，无布局时靠文本与文档距离
          if (!rect || rect.width <= 160) {
            const a = nearestAnchor(el, anchors, tops, docIndexOf);
            if (a && !map.has(a.el)) map.set(a.el, `${m[1]} / ${m[2]}`);
          }
        }
      }
      el = walker.nextNode();
    }
    return map;
  }

  /* ----------------------------------- 主体 ----------------------------------- */

  /**
   * 把「只有图片、没有文字」的气泡并入同一轮的文字气泡。
   *
   * DeepSeek 把上传图渲染在文字气泡之外的附件容器里，那个容器本身也满足
   * 「右侧窄块」特征，会被识别成一条独立的用户气泡 —— 结果图片和文字被拆成
   * 两条消息（图片单独一条、文字单独一条），顺序也乱了。
   * 这里把这类容器按共同祖先（同属一轮、且不含模型正文）配回文字气泡；
   * 真正「只发了图没打字」的消息找不到可配的文字气泡，仍保留为独立消息。
   *
   * @returns {{kept: Array, extras: Map<Element, Element[]>}}
   */
  function pairImageBubbles(bubbles, bodyRoots, container) {
    const textBubbles = [];
    const imageOnly = [];

    for (const b of bubbles) {
      if (textOf(b.el).length > 0) { textBubbles.push(b); continue; }
      if (b.el.querySelector('img')) imageOnly.push(b);
      else textBubbles.push(b);
    }

    const extras = new Map();
    const keptImageOnly = [];

    for (const io of imageOnly) {
      let node = io.el.parentElement;
      let host = null;
      for (let hop = 0; node && node !== container && hop < 5; hop++, node = node.parentElement) {
        if (bodyRoots.some(r => r.contains(node))) break;        // 跨到模型回复就停
        const inside = textBubbles.filter(t => node.contains(t.el));
        if (inside.length === 1) { host = inside[0]; break; }
        if (inside.length > 1) break;                            // 包含多个文字气泡，不是同一轮
      }

      if (host && !host.el.contains(io.el)) {
        if (!extras.has(host.el)) extras.set(host.el, []);
        extras.get(host.el).push(io.el);
      } else {
        keptImageOnly.push(io);                                  // 纯图片消息
      }
    }

    const kept = textBubbles.concat(keptImageOnly);
    kept.sort((a, b) => {
      const pa = a.el.compareDocumentPosition(b.el);
      if (pa & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pa & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    return { kept, extras };
  }

  /**
   * 本轮用户图片的收割范围：从用户行向上扩到「仍只包含这一轮用户内容」的最大祖先，
   * 这样文字气泡之外的附件容器、甚至与用户行平级的图片容器都能被覆盖，
   * 同时不会跨进模型回复或下一轮。
   */
  function userImageScope(row, bubble, bodyRoots, allBubbles) {
    let scope = row || bubble;
    let node = scope.parentElement;
    let hops = 0;
    while (node && hops < 3) {
      if (bodyRoots.some(r => r.contains(node))) break;
      if (allBubbles.some(b => b.el !== bubble && node.contains(b.el))) break;
      if (textOf(node).length > Math.max(textOf(bubble).length + 120, 400)) break;
      scope = node;
      node = node.parentElement;
      hops++;
    }
    return scope;
  }

  /**
   * 兜底：页面上还有被识别为用户上传图、但没有被任何一轮收割到的图片，
   * 按「元素包含关系 / 视觉距离 / 文档顺序」补到最近的一条用户消息末尾。
   *
   * 正常路径不会走到这里（userImageScope + 附件容器配对已覆盖）；
   * 它专门防长对话中附件容器位于轮次外壳之外、或某轮气泡识别失败时图片静默消失。
   * @returns {{bound:number, unbound:number, unboundImages:Array}}
   */
  function bindOrphanUploads(container, messages, registry, order) {
    const out = { bound: 0, unbound: 0, unboundImages: [] };
    if (!container || !registry || !DSMD.imageTools) return out;
    const userMsgs = messages.filter(m => m.role === 'user' && m.sourceEl);

    const registered = new Set();
    for (const rec of registry.all()) {
      if (rec && rec.el) registered.add(rec.el);
    }

    // 文档序索引（无布局信息时作为距离兜底）
    const docIndex = new Map();
    {
      let i = 0;
      docIndex.set(container, i++);
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = walker.nextNode())) docIndex.set(n, i++);
    }
    const idxOf = el => (docIndex.has(el) ? docIndex.get(el) : Number.MAX_SAFE_INTEGER);

    container.querySelectorAll('img').forEach(img => {
      if (registered.has(img)) return;
      if (!DSMD.imageTools.isUserUploadImage(img)) return;

      const imgRect = rectOf(img);
      let best = null;
      let bestDist = Infinity;
      for (const m of userMsgs) {
        const row = m.sourceRow || m.sourceEl;
        let dist;
        if (row && row.contains && row.contains(img)) {
          dist = 0;
        } else {
          const rowRect = rectOf(row) || rectOf(m.sourceEl);
          if (imgRect && rowRect) {
            const ic = (imgRect.top + imgRect.bottom) / 2;
            const rc = (rowRect.top + rowRect.bottom) / 2;
            dist = Math.abs(ic - rc);
          } else {
            dist = Math.abs(idxOf(img) - idxOf(m.sourceEl));
          }
        }
        if (dist < bestDist) { bestDist = dist; best = m; }
      }

      if (!best) {
        out.unbound++;
        out.unboundImages.push({
          alt: img.getAttribute('alt') || '',
          src: DSMD.imageTools.resolveImageSrc ? DSMD.imageTools.resolveImageSrc(img) : '',
          width: 0, height: 0
        });
        return;
      }

      const id = registry.register(img, {
        role: 'user',
        turnIndex: best.turnIndex || null,
        alt: img.getAttribute('alt') || ''
      });
      const token = DSMD.imageTools.tokenFor(id);
      best.body = best.body ? `${best.body}\n\n${token}` : token;
      registered.add(img);
      out.bound++;
    });
    return out;
  }

  function extractFromDom(root, options) {
    const opts = options || {};
    const scope = root && root.querySelectorAll ? root : document;
    const warn = [];
    const imgRegistry = DSMD.imageTools ? DSMD.imageTools.createRegistry() : null;
    // 把导出前捕获的 Mermaid 图表（PNG 数据）登记进同一张注册表，
    // 正文转换时用 dsmd-img://N 引用，与用户上传图共用一套内嵌管线
    if (imgRegistry && DSMD.mermaid) DSMD.mermaid.attachRegistry(imgRegistry);

    const { roots, kind } = collectBodyRoots(scope);
    if (!roots.length && !opts.allowUserOnly) {
      return {
        ok: false,
        reason: 'no-body-root',
        error: '页面里没有找到已渲染的对话正文（可能尚未打开任何对话，或页面仍在加载）',
        messages: [], warn, diag: { bodyRootKind: kind, bodyRootCount: 0 }
      };
    }

    let container = roots.length ? deepestCommonAncestor(roots) : opts.userOnlyScope;
    if (roots.length && (!container || roots.some(r => r === container))) {
      container = (container || roots[0]).parentElement || document.body;
    }
    if (!container || !container.querySelectorAll) container = document.body;

    // 用户气泡：容器内找不到时，逐级向上扩大搜索范围（但最多 3 层，避免扫到侧边栏）
    let bubbles = collectUserBubbles(container, roots);
    let scanScope = container;
    for (let i = 0; i < 3 && !bubbles.length && scanScope.parentElement; i++) {
      scanScope = scanScope.parentElement;
      if (scanScope === document.body) break;
      bubbles = collectUserBubbles(scanScope, roots);
    }
    if (!bubbles.length) warn.push('未识别到用户消息气泡，导出结果可能只有模型回复');

    // 只有图片、没有文字的附件容器并入同一轮的文字气泡，
    // 避免「图片消息」和「文字消息」被拆成两条（顺序也会乱）
    const paired = pairImageBubbles(bubbles, roots, container);
    if (paired.extras.size) warn.push(`已把 ${paired.extras.size} 组附图容器并回对应消息`);
    bubbles = paired.kept;

    const thinkBlocks = collectThinkingBlocks(container, roots);

    // 排除落在思考块内部的正文根（思考过程本身用 markdown 渲染时会这样嵌套）
    const answerRoots = roots.filter(r => !thinkBlocks.some(b => b !== r && b.contains(r)));
    const usableRoots = answerRoots.length ? answerRoots : roots;

    // 参与排序的元素：用户气泡行、正文根、思考块。
    // 顺序以页面上的实际呈现位置为准（视觉从上到下），而不是 DOM 结构顺序。
    const order = buildOrderMap(container, [
      ...bubbles.map(b => b.row),
      ...bubbles.map(b => b.el),
      ...usableRoots,
      ...thinkBlocks
    ]);

    // 以用户气泡分隔轮次
    const items = [
      ...bubbles.map(b => ({ kind: 'user', el: b.el, row: b.row, signal: b.signal })),
      ...usableRoots.map(r => ({ kind: 'root', el: r }))
    ].map(it => Object.assign(it, { index: indexOf(order, it.row || it.el) }))
      .sort((a, b) => a.index - b.index);

    // 分支切换器收割：附着到最近的用户气泡 / 正文根，随角色标题同行导出
    const switcherMap = collectBranchSwitchers(container, usableRoots, bubbles, order);

    const sections = [];
    let current = { user: null, roots: [] };
    for (const it of items) {
      if (it.kind === 'user') {
        if (current.user || current.roots.length) sections.push(current);
        current = { user: it, roots: [] };
      } else {
        current.roots.push(it.el);
      }
    }
    sections.push(current);

    // 拿不到布局信息、又确认是反向布局（column-reverse / rtl）时，
    // 把轮次的先后顺序翻转回来。只翻轮次，不动轮内顺序。
    if (order.mode !== 'visual' && order.reversed) sections.reverse();

    // 每轮在排序中的区间，用于把思考块归到正确的轮次
    const ranges = sections.map((s, i) => ({
      start: s.user ? indexOf(order, s.user.row) : -1,
      end: sections[i + 1] && sections[i + 1].user
        ? indexOf(order, sections[i + 1].user.row)
        : Number.MAX_SAFE_INTEGER
    }));

    const messages = [];
    const virtualKeyOf = el => el && el.closest
      ? (el.closest('[data-virtual-list-item-key]') || {}).dataset?.virtualListItemKey || ''
      : '';
    let userTurnSeq = 0;

    for (let si = 0; si < sections.length; si++) {
      const section = sections[si];
      const range = ranges[si];

      if (section.user) {
        userTurnSeq++;
        // 收割范围：本轮用户行 + 配回本轮的附图容器（多个作用域，避免跨进模型正文）
        const extraEls = paired.extras.get(section.user.el) || [];
        const rowScope = userImageScope(section.user.row, section.user.el, roots, bubbles);
        const imgScope = [rowScope].concat(extraEls);
        // meta 里带着角色与轮次序号：图片记录据此归属消息，失败清单也能报「所属消息角色」
        const userMeta = { role: 'user', turnIndex: userTurnSeq };
        const body = userBodyOf(section.user.el, thinkBlocks, roots, imgRegistry, imgScope, userMeta);
        if (body) {
          messages.push({
            role: 'user', body, label: 'dom',
            branchNo: switcherMap.get(section.user.el) || '',
            // 仅用于兜底图片归属，不参与导出字段
            sourceEl: section.user.el,
            sourceRow: section.user.row,
            virtualKey: virtualKeyOf(section.user.el),
            turnIndex: userTurnSeq
          });
        }
      }

      // 落在本轮区间内的思考块
      const sectionThinks = thinkBlocks.filter(b => {
        const idx = indexOf(order, b);
        return idx >= (range.start < 0 ? 0 : range.start) && idx < range.end;
      });

      // 只有思考过程、没有正式回复的轮次：保留思考内容，勾选排除时由校验环节丢弃
      if (!section.roots.length) {
        const t = sectionThinks.map(thinkingTextOf).filter(Boolean).join('\n\n');
        if (t) messages.push({ role: 'assistant', body: '', thinking: t, label: 'dom',
          virtualKey: virtualKeyOf(sectionThinks[0]) });
        continue;
      }

      const answer = section.roots[section.roots.length - 1];
      const answerText = DSMD.htmlToMarkdown(answer, { plainText: false });
      const earlier = section.roots.slice(0, -1);

      const thinkingParts = [];
      for (const r of earlier) {
        if (isLikelyThinkingRoot(r, answer, thinkBlocks)) {
          const t = DSMD.htmlToMarkdown(r, { plainText: false });
          if (t) thinkingParts.push(t);
          continue;
        }

        const t = DSMD.htmlToMarkdown(r, { plainText: false });
        if (!t) continue;

        // 与正式回复内容一致：属于重复渲染留下的副本，直接丢弃
        if (t.replace(/\s+/g, '') === answerText.replace(/\s+/g, '')) continue;

        // 判断不了就先保留成独立的助手消息，宁可多留也不丢内容
        messages.push({ role: 'assistant', body: t, label: 'dom', virtualKey: virtualKeyOf(r) });
      }

      // 独立的思考容器（不在正文根里）
      for (const b of thinkBlocks) {
        if (b.contains(answer) || answer.contains(b)) continue;
        if (earlier.some(r => b === r || b.contains(r))) continue;   // 已按思考正文根计入
        const idx = indexOf(order, b);
        const aIdx = indexOf(order, answer);
        if (idx > aIdx) continue;                       // 位于回复之后的思考块不归属本轮
        const t = thinkingTextOf(b);
        if (t) thinkingParts.push(t);
      }

      if (answerText || thinkingParts.length) {
        messages.push({
          role: 'assistant',
          body: answerText,
          thinking: thinkingParts.join('\n\n'),
          label: 'dom',
          virtualKey: virtualKeyOf(answer),
          branchNo: switcherMap.get(answer) || ''
        });
      }
    }

    // 相邻重复（重复渲染 / 重新生成留下的副本）去掉：正文相同即视为同一条，
    // 思考内容取更完整的一份，避免把模型的思考过程丢掉。
    const deduped = [];
    for (const m of messages) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.role === m.role && prev.body === m.body) {
        if ((m.thinking || '').length > (prev.thinking || '').length) prev.thinking = m.thinking;
        continue;
      }
      deduped.push(m);
    }

    // 时序自检：万一排序依据全部失效导致整段倒序，这里兜底翻转回
    // 「提问在前、回复在后」，与网页端一致。
    // 逐屏快照可能恰好从助手消息开始；这种局部窗口不能用角色数量判断整段倒序。
    const ordered = opts.skipChronologyFix ? deduped : DSMD.chronology.fixOrder(deduped);

    // 漏图兜底：优先按消息顺序收割后仍未被认领的上传图，补到最近的消息；
    // 实在找不到所属消息的，作为 unboundImages 上报（而不是安静丢掉）。
    const orphaned = bindOrphanUploads(container, ordered, imgRegistry, order);
    if (orphaned.bound) warn.push(`已把 ${orphaned.bound} 张未归位的用户图片补到最近的消息`);
    if (orphaned.unbound) warn.push(`${orphaned.unbound} 张用户图片未能定位所属消息`);
    const coverage = DSMD.imageTools && DSMD.imageTools.auditCoverage
      ? DSMD.imageTools.auditCoverage(container, imgRegistry)
      : null;

    const withBody = ordered.filter(m => m.body);
    if (!withBody.length) {
      return {
        ok: false,
        reason: 'empty-bodies',
        error: '识别到消息节点，但未能取到正文文本',
        messages: ordered,
        images: imgRegistry ? imgRegistry.all() : [],
        unboundImages: orphaned.unboundImages,
        coverage,
        warn,
        diag: diagnostics(scope, roots, bubbles, thinkBlocks, kind)
      };
    }

    return {
      ok: true,
      messages: ordered,
      images: imgRegistry ? imgRegistry.all() : [],
      unboundImages: orphaned.unboundImages,
      coverage,
      warn,
      diag: Object.assign(diagnostics(scope, roots, bubbles, thinkBlocks, kind), { orderMode: order.mode }),
      stats: {
        bodyRoots: roots.length,
        userBubbles: bubbles.length,
        thinkingBlocks: thinkBlocks.length,
        branchSwitchers: switcherMap.size,
        turns: ordered.length,
        images: imgRegistry ? imgRegistry.all().length : 0,
        orphanBound: orphaned.bound,
        unboundImages: orphaned.unbound,
        pageUploads: coverage ? coverage.uploads : 0
      }
    };
  }

  /* --------------------------------- 诊断输出 --------------------------------- */

  function diagnostics(scope, roots, bubbles, thinkBlocks, kind) {
    const describe = el => ({
      tag: el.tagName,
      class: className(el).slice(0, 160),
      textLength: textOf(el).length,
      preview: textOf(el).slice(0, 60)
    });
    return {
      bodyRootKind: kind,
      bodyRootCount: roots.length,
      bodyRoots: roots.slice(0, 8).map(describe),
      userBubbles: bubbles.slice(0, 8).map(b => Object.assign(describe(b.el), { signal: b.signal })),
      thinkingBlocks: thinkBlocks.slice(0, 5).map(describe),
      title: (document.title || '').slice(0, 120),
      url: typeof location !== 'undefined' ? location.href : ''
    };
  }

  DSMD.extractFromDom = extractFromDom;
  DSMD.domInternals = {
    isBodyRoot, collectBodyRoots, deepestCommonAncestor, collectUserBubbles,
    collectThinkingBlocks, userSignal, geometrySignal, extractFromDom
  };
})();
