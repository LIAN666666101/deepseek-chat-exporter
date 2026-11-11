/**
 * extract.js —— 会话结构识别与抽取
 *
 * 为什么不用硬编码选择器？
 *   DeepSeek 网页版的 class 名是构建期生成的哈希（例如 _4f9bf79），每次发版都可能变化。
 *   因此这里采用「多层启发式 + 打分」策略：
 *     1. 语义属性优先（data-message-author-role / data-testid 等）
 *     2. 类名关键词（assistant / user / think / search ...）
 *     3. 结构特征（.ds-markdown 的公共祖先、按钮文案、头像）
 *     4. 几何特征（用户气泡右对齐 / 助手消息左对齐）
 *   并把置信度一起返回，popup 的「诊断」面板会展示识别结果，方便快速定位适配问题。
 */
(function () {
  'use strict';

  const NS = (window.__DSE__ = window.__DSE__ || {});
  const U = NS.util;

  /* ------------------------------------------------------------------ *
   * 关键词
   * ------------------------------------------------------------------ */

  // 思考过程块：类名/属性侧线索
  const THINK_ATTR_SEL = [
    '[class*="think" i]',
    '[class*="reasoning" i]',
    '[data-testid*="think" i]',
    '[data-testid*="reason" i]',
    '[data-role*="think" i]',
    '[data-type*="think" i]',
    '[aria-label*="思考"]',
    '[aria-label*="推理"]',
    '[aria-label*="reasoning" i]',
  ].join(',');

  // 思考过程块：文案侧线索（类名被哈希时的兜底）
  const THINK_TEXT_RE =
    /^(已)?(深度)?思考(过程)?|^思考用时|^推理(过程)?|^思维链|^Thought for|^Thought about|^Reasoning|^Thinking/i;

  // 联网搜索 / 工具调用块
  const TOOL_ATTR_SEL = [
    '[class*="search" i]',
    '[class*="tool-call" i]',
    '[data-testid*="search" i]',
    '[data-testid*="tool" i]',
    '[aria-label*="搜索"]',
    '[aria-label*="search" i]',
  ].join(',');
  const TOOL_TEXT_RE =
    /^(已)?(联网|搜索|浏览|阅读)(了)?\s*[\d一二两三四五六七八九十]*\s*(个)?(网页|网站|结果|页面)?|^Web search|^Searching|^Browsing|^阅读了\s*\d+/i;

  // 显式的角色属性
  const ROLE_ATTRS = ['data-message-author-role', 'data-role', 'data-author-role', 'data-sender', 'data-message-role'];

  const MSG_MARK_RE = /(^|[\s_=-])(message|chat-item|chat-message|msg|dialogue|turn)([\s_=-]|$)/i;

  /* ------------------------------------------------------------------ *
   * 滚动容器
   * ------------------------------------------------------------------ */

  function findScrollContainer(root) {
    const scope = root || document.body;
    const cands = [];
    let visited = 0;

    (function walk(el, depth) {
      if (!el || depth > 16 || visited > 6000) return;
      for (const c of el.children) {
        visited++;
        if (c.tagName === 'SCRIPT' || c.tagName === 'STYLE') continue;
        let st;
        try {
          st = getComputedStyle(c);
        } catch (_) {
          continue;
        }
        const oy = st.overflowY;
        const scrollable = oy === 'auto' || oy === 'scroll' || oy === 'overlay';
        if (scrollable && c.clientHeight > 150 && c.scrollHeight - c.clientHeight > 80) {
          cands.push(c);
        }
        walk(c, depth + 1);
      }
    })(scope, 0);

    if (!cands.length) return document.scrollingElement || document.documentElement;
    // 选"可滚动余量最大"的那个
    cands.sort(
      (a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
    );
    return cands[0];
  }

  /* ------------------------------------------------------------------ *
   * 消息节点枚举
   * ------------------------------------------------------------------ */

  /** 去掉被列表中其他元素包含的嵌套元素（双向判断，不依赖顺序） */
  function pruneNested(list) {
    const arr = Array.from(new Set(list.filter(Boolean)));
    if (arr.length <= 1) return arr;
    if (arr.length > 400) return arr; // 防御：超大列表不做 O(n^2)
    return arr.filter((el) => !arr.some((o) => o !== el && o.contains(el)));
  }

  function clsString(el) {
    const c = el.className;
    if (typeof c === 'string') return c;
    if (c && c.baseVal) return c.baseVal;
    return '';
  }

  function domOrder(list) {
    return list.slice().sort((a, b) => {
      const p = a.compareDocumentPosition(b);
      if (p & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (p & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  /**
   * 给一组候选"消息块"打分。
   * 关键指标是覆盖率：所有 .ds-markdown 正文块是否都被这组候选包住了。
   * 这样即使一部分消息缺少角色属性，也不会因为"命中数 >= 2 就提前返回"而漏掉它们。
   */
  function scoreList(list, mdNodes) {
    if (!list || !list.length) return -1;
    const covered = mdNodes.length
      ? mdNodes.filter((md) => list.some((n) => n.contains(md))).length / mdNodes.length
      : 1;
    const texty =
      list.filter((n) => U.normalizeText(U.innerTextLoose(n)).length > 0).length / list.length;
    let s = covered * 10 + texty * 2 + Math.min(list.length, 60) / 60;
    if (list.length > 300) s *= 0.3;
    return s;
  }

  /**
   * 找出当前 DOM 中所有"消息块"，按 DOM 顺序返回。
   * 多策略并行取分，避免单一策略在页面改版后直接失效。
   */
  function findMessageRoots(container) {
    const scope = container || document.body;
    const mdNodes = Array.from(scope.querySelectorAll('.ds-markdown'));
    const cands = [];

    // A 显式语义属性
    let a = [];
    for (const attr of ROLE_ATTRS) {
      try {
        a = a.concat(Array.from(scope.querySelectorAll('[' + attr + ']')));
      } catch (_) {
        /* 忽略非法属性选择器 */
      }
    }
    a = domOrder(pruneNested(a));
    if (a.length) cands.push({ list: a, name: 'attr' });

    // B 所有 .ds-markdown 的公共祖先的直接子元素
    if (mdNodes.length >= 2) {
      const anc = U.deepestCommonAncestor(mdNodes);
      if (anc) {
        const kids = Array.from(anc.children).filter(
          (c) => U.normalizeText(U.innerTextLoose(c)).length > 0
        );
        if (kids.length >= 2) cands.push({ list: kids, name: 'markdown-ancestor' });
      }
    }

    // C 类名含 message / chat-item 等
    const c = domOrder(
      pruneNested(
        Array.from(scope.querySelectorAll('[class]')).filter((el) => MSG_MARK_RE.test(clsString(el)))
      )
    );
    if (c.length) cands.push({ list: c, name: 'class' });

    // D 容器的直接子元素（最朴素但常常最准）
    const weak = scope.tagName === 'HTML' || scope.tagName === 'BODY';
    const d = Array.from(scope.children).filter(
      (el) => U.normalizeText(U.innerTextLoose(el)).length > 0
    );
    if (d.length) cands.push({ list: d, name: 'container-children', weak });

    // E 页面只有一条消息时，向上爬几层拿到消息外壳
    if (mdNodes.length === 1) {
      let node = mdNodes[0];
      for (let i = 0; i < 6 && node.parentElement; i++) {
        node = node.parentElement;
        if (node === scope) break;
      }
      if (node && node !== scope) cands.push({ list: [node], name: 'single' });
    }

    if (!cands.length) return [];

    let best = null;
    for (const cand of cands) {
      let s = scoreList(cand.list, mdNodes);
      if (cand.weak) s *= 0.6;
      if (!best || s > best.s) best = { s, list: cand.list, name: cand.name };
    }
    return best ? best.list : [];
  }

  /* ------------------------------------------------------------------ *
   * 角色判定
   * ------------------------------------------------------------------ */

  function attrRole(node) {
    for (const a of ROLE_ATTRS) {
      const v = node.getAttribute && node.getAttribute(a);
      if (!v) continue;
      const s = String(v).toLowerCase();
      if (/assistant|ai|bot|system|deepseek/.test(s)) return { role: 'assistant', conf: 'high' };
      if (/user|human|me|self/.test(s)) return { role: 'user', conf: 'high' };
    }
    return null;
  }

  function classRole(node) {
    const id = U.identityText(node);
    if (!id) return null;
    if (/(^|[\s_=-])(assistant|bot|ai-?reply|ai-?message|reply)([\s_=-]|$)/i.test(id)) return 'assistant';
    if (/(^|[\s_=-])(user|human|question|ask|prompt)([\s_=-]|$)/i.test(id)) return 'user';
    return null;
  }

  /** 从按钮文案判断：助手消息有"重新生成"，用户消息有"编辑" */
  function buttonRole(node) {
    let score = 0;
    const labels = [];
    node.querySelectorAll('button,[role="button"],div[class*="action" i] span').forEach((b) => {
      const t = U.normalizeText(b.getAttribute('aria-label') || b.textContent || '');
      if (t && t.length <= 12) labels.push(t);
    });
    const all = labels.join('|');
    if (/重新生成|重新回答|regenerate|重试/i.test(all)) score += 2;
    if (/编辑|edit/i.test(all)) score -= 2;
    if (/点赞|点踩|like|dislike|thumbs/i.test(all)) score += 1;
    return score;
  }

  /** 几何 / 布局：用户气泡右对齐，助手内容左对齐铺满 */
  function geometryRole(node, listRect) {
    if (!listRect || !listRect.width) return 0;
    let score = 0;

    const r = node.getBoundingClientRect();
    if (r.width) {
      const relLeft = (r.left - listRect.left) / listRect.width;
      const relRight = (r.right - listRect.left) / listRect.width;
      if (relRight > 0.93 && relLeft > 0.18) score -= 2; // 右侧留白 → 用户
      else if (relLeft < 0.05) score += 1; // 顶到左边 → 助手
    }

    // 布局线索：右对齐文本 / flex 右靠
    const probe = [node].concat(Array.from(node.children).slice(0, 3));
    for (const el of probe) {
      let st;
      try {
        st = getComputedStyle(el);
      } catch (_) {
        continue;
      }
      if (st.textAlign === 'right' || st.textAlign === 'end') score -= 1;
      const jc = String(st.justifyContent || '');
      if (/flex-end|end|right/.test(jc)) score -= 1;
      if (st.display === 'flex' && /flex-start|start|left/.test(jc)) score += 1;
    }

    // 气泡线索：半透明/纯色背景 + 圆角 + 右贴边
    const kids = Array.from(node.querySelectorAll('*')).slice(0, 60);
    for (const el of kids) {
      const cls = typeof el.className === 'string' ? el.className : '';
      if (!/bubble|bg|user|question|query/i.test(cls)) continue;
      const rr = el.getBoundingClientRect();
      if (!rr.width || r.width && rr.width > r.width * 0.95) continue;
      if (r.width && Math.abs(rr.right - r.right) < 12) score -= 2;
    }

    return score;
  }

  function judgeRole(node, listRect) {
    const explicit = attrRole(node);
    if (explicit) return explicit;

    let score = 0;
    const byClass = classRole(node);
    if (byClass === 'assistant') score += 3;
    if (byClass === 'user') score -= 3;

    score += buttonRole(node);
    score += geometryRole(node, listRect);

    // 助手消息里几乎必然存在 ds-markdown 正文块
    if (node.querySelector('.ds-markdown')) score += 1;

    if (score >= 2) return { role: 'assistant', conf: score >= 4 ? 'high' : 'medium' };
    if (score <= -2) return { role: 'user', conf: score <= -4 ? 'high' : 'medium' };
    return { role: score > 0 ? 'assistant' : score < 0 ? 'user' : 'unknown', conf: 'low' };
  }

  /** 兜底：按对话的自然交替规律修补 unknown */
  function repairUnknownRoles(messages) {
    let prev = null;
    for (const m of messages) {
      if (m.role === 'unknown') {
        if (prev === 'user') m.role = 'assistant';
        else if (prev === 'assistant') m.role = 'user';
        else m.role = 'assistant';
        m.roleRepaired = true;
      }
      prev = m.role;
    }
    return messages;
  }

  /* ------------------------------------------------------------------ *
   * 思考过程 / 工具调用块识别
   * ------------------------------------------------------------------ */

  function hasMarkdownInside(el) {
    return !!el.querySelector('.ds-markdown');
  }

  function collectByHints(node, attrSel, textRe) {
    const out = [];

    // 1) 属性/类名线索
    let attrHits = [];
    try {
      attrHits = Array.from(node.querySelectorAll(attrSel));
    } catch (_) {
      attrHits = [];
    }
    for (const el of attrHits) {
      if (el === node) continue;
      // 严格规则：块内不能包含正文 .ds-markdown，避免把答案一起删掉
      if (hasMarkdownInside(el)) continue;
      out.push(el);
    }

    // 2) 文案线索（类名被哈希时的兜底）
    //    只认「短、少子节点」的标题元素，并且拒绝把消息本身当成待删除块。
    const leaves = node.querySelectorAll('div,span,p,button,summary');
    for (const el of leaves) {
      if (el === node) continue;
      if (el.children.length > 1) continue;
      const t = U.normalizeText(el.textContent || '');
      if (!t || t.length > 24) continue;
      if (!textRe.test(t)) continue;
      if (hasMarkdownInside(el)) continue;
      const parent = el.parentElement;
      if (!parent || parent === node) continue;
      // 块外再包一层（标题 + 内容），但不能是消息本身
      let wrap = parent;
      if (parent.parentElement && parent.parentElement !== node && !hasMarkdownInside(parent.parentElement)) {
        wrap = parent.parentElement;
      }
      if (wrap === node || hasMarkdownInside(wrap)) continue;
      out.push(wrap);
    }

    return pruneNested(out);
  }

  /**
   * 已展开的思考块：内容在 DOM 里
   */
  function findThinkingRoots(node) {
    return collectByHints(node, THINK_ATTR_SEL, THINK_TEXT_RE);
  }

  /**
   * 折叠状态下的思考块：只看得到标题（例如「已深度思考（用时 13 秒）」），
   * 正文没渲染。这类块本身没有可导出的内容，但要把它从正文里剔除。
   */
  function findCollapsedThinkHeaders(node) {
    const out = [];
    const cands = node.querySelectorAll('div,span,button,summary');
    for (const el of cands) {
      if (el === node) continue;
      if (el.children.length > 1) continue;
      const t = U.normalizeText(el.textContent || '');
      if (!t || t.length > 24) continue;
      if (!THINK_TEXT_RE.test(t)) continue;
      if (hasMarkdownInside(el)) continue;
      out.push(el);
    }
    // 只保留最外层（例如「思考块容器」而不是它里面的标题文字）
    return out.filter((el) => !out.some((o) => o !== el && o.contains(el)));
  }

  function findToolRoots(node) {
    return collectByHints(node, TOOL_ATTR_SEL, TOOL_TEXT_RE);
  }

  /* ------------------------------------------------------------------ *
   * 单条消息 → Markdown
   * ------------------------------------------------------------------ */

  function markdownNodesOf(node) {
    return Array.from(node.querySelectorAll('.ds-markdown'));
  }

  function buildMessageContent(node, opts, removalRoots) {
    const imageMode = opts.imageMode || 'link';
    const mdOpts = {
      imageMode,
      // 有「## 用户 / ## DeepSeek」角色标题时，正文标题自动降一级
      headingOffset: opts.keepRoleLabels === false ? 0 : 1,
    };

    // 优先只取 .ds-markdown 正文块（最干净，天然避开工具栏/按钮）
    const allMds = markdownNodesOf(node);
    if (allMds.length) {
      const keep = allMds.filter((md) => !removalRoots.some((r) => r.contains(md)));
      const list = keep.length ? keep : allMds;
      const parts = list
        .map((md) => NS.markdown.elementToMarkdown(md, mdOpts))
        .filter(Boolean);
      if (parts.length) return parts.join('\n\n');
    }

    // 兜底：整块克隆后剔除干扰节点再转 Markdown
    const clone = node.cloneNode(true);
    removalRoots.forEach((r) => {
      // 在克隆体里按结构路径定位并移除
      try {
        const path = pathOf(node, r);
        const target = nodeAtPath(clone, path);
        if (target && target.remove) target.remove();
      } catch (_) {
        /* 忽略单个节点的定位失败 */
      }
    });
    return NS.markdown.elementToMarkdown(clone, mdOpts);
  }

  function extractThinkingContent(node, opts) {
    const roots = findThinkingRoots(node);
    if (!roots.length) return '';
    const parts = roots
      .map((r) => {
        const md = markdownNodesOf(r);
        if (md.length) {
          return md
            .map((m) => NS.markdown.elementToMarkdown(m, { imageMode: 'skip' }))
            .join('\n\n');
        }
        // 折叠面板：去掉「已深度思考（用时 X 秒）」这类标题行，只留正文
        const clone = r.cloneNode(true);
        clone.querySelectorAll('*').forEach((el) => {
          if (el.children.length > 2) return;
          const t = U.normalizeText(el.textContent || '');
          if (t && t.length <= 48 && THINK_TEXT_RE.test(t)) el.remove();
        });
        return NS.markdown.tidy(clone.textContent || '');
      })
      .filter((s) => s && s.length > 0);
    return parts.join('\n\n');
  }

  /* --- 克隆体内按路径定位（DOM 对比用） --- */
  function pathOf(root, el) {
    const path = [];
    let cur = el;
    while (cur && cur !== root) {
      const parent = cur.parentElement;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.children, cur));
      cur = parent;
    }
    return cur === root ? path : null;
  }

  function nodeAtPath(root, path) {
    let cur = root;
    for (const i of path) {
      if (!cur || !cur.children || !cur.children[i]) return null;
      cur = cur.children[i];
    }
    return cur;
  }

  /* ------------------------------------------------------------------ *
   * 滚动加载 & 全量扫描
   * ------------------------------------------------------------------ */

  async function loadOlderHistory(scrollEl, onProgress) {
    let stableRounds = 0;
    const deadlineAll = Date.now() + 90000; // 总预算：最多 90 秒，避免极端情况卡死
    for (let i = 0; i < 80; i++) {
      if (Date.now() > deadlineAll) break;
      const before = scrollEl.scrollHeight;
      scrollEl.scrollTop = 0;
      scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));

      let grew = false;
      const deadline = Date.now() + 1600;
      while (Date.now() < deadline) {
        await U.sleep(120);
        if (scrollEl.scrollHeight > before + 4) {
          grew = true;
          break;
        }
      }
      if (!grew) {
        stableRounds++;
        if (stableRounds >= 2) break;
      } else {
        stableRounds = 0;
        onProgress && onProgress({ phase: 'loading-history', round: i + 1, height: scrollEl.scrollHeight });
      }
    }
    scrollEl.scrollTop = 0;
    await U.nextFrame();
    await U.sleep(200);
  }

  function fingerprintOf(node, role) {
    const text = U.normalizeText(U.innerTextLoose(node)).slice(0, 1200);
    const stableId =
      (node.getAttribute && (node.getAttribute('data-message-id') || node.id)) || '';
    return role + '|' + (stableId || U.hash32(text));
  }

  /**
   * 从顶到底扫描一遍，增量收集（兼容虚拟列表）
   */
  async function sweep(scrollEl, onProgress) {
    const records = []; // { key, order, node }
    const seen = new Map();
    let order = 0;
    let maxNodes = 0;
    const step = Math.max(180, Math.floor(scrollEl.clientHeight * 0.55));
    const maxPos = () => Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    let pos = 0;
    let stagnant = 0;
    const deadlineAll = Date.now() + 120000; // 总预算：最多 120 秒

    for (let guard = 0; guard < 4000; guard++) {
      if (Date.now() > deadlineAll) break;
      scrollEl.scrollTop = pos;
      await U.nextFrame();
      await U.sleep(70);

      const nodes = findMessageRoots(scrollEl);
      maxNodes = Math.max(maxNodes, nodes.length);

      const listRect = scrollEl.getBoundingClientRect();
      for (const n of nodes) {
        const j = judgeRole(n, listRect);
        const key = fingerprintOf(n, j.role === 'unknown' ? 'x' : j.role);
        if (!seen.has(key)) {
          const rec = { key, order: order++, node: n, role: j.role, conf: j.conf, seq: pos };
          seen.set(key, rec);
          records.push(rec);
        } else {
          seen.get(key).node = n; // 指向最新挂载的 DOM
        }
      }

      onProgress &&
        onProgress({
          phase: 'scanning',
          pos,
          max: maxPos(),
          found: records.length,
        });

      const end = maxPos();
      if (pos >= end) {
        stagnant++;
        if (stagnant > 1) break;
      } else {
        stagnant = 0;
      }
      pos = Math.min(pos + step, end);
    }

    records.sort((a, b) => (a.seq - b.seq) || (a.order - b.order));
    return { records, maxNodes };
  }

  /* ------------------------------------------------------------------ *
   * 会话标题
   * ------------------------------------------------------------------ */

  function detectTitle() {
    // 1) 侧边栏当前选中项
    const active = document.querySelector(
      '[class*="sidebar" i] [class*="active" i], [class*="conversation" i][aria-selected="true"], a[aria-current="page"]'
    );
    if (active) {
      const t = U.normalizeText(active.textContent);
      if (t && t.length <= 60) return t;
    }
    // 2) document.title
    const dt = (document.title || '').replace(/\s*[-|·]\s*DeepSeek.*$/i, '').trim();
    if (dt && dt.length <= 60) return dt;
    return '';
  }

  /* ------------------------------------------------------------------ *
   * 对外的三个入口
   * ------------------------------------------------------------------ */

  async function scan(opts, onProgress) {
    const options = Object.assign(
      {
        excludeThinking: true,
        includeThinkingBlock: false,
        excludeToolCalls: true,
        imageMode: 'link',
        includeMeta: true,
        keepRoleLabels: true,
        loadHistory: true,
      },
      opts || {}
    );

    const scrollEl = findScrollContainer(document.body);
    onProgress && onProgress({ phase: 'start', container: scrollEl.tagName });

    if (options.loadHistory) {
      await loadOlderHistory(scrollEl, onProgress);
    }

    const { records, maxNodes } = await sweep(scrollEl, onProgress);

    const listRect = scrollEl.getBoundingClientRect();
    const messages = [];

    for (const rec of records) {
      const node = rec.node;
      if (!node || !node.isConnected) continue;

      const j = rec.role === 'unknown' ? judgeRole(node, listRect) : { role: rec.role, conf: rec.conf };
      // 注意：角色未定时保留 'unknown' 原样写回消息，交给后面的交替规律兜底；
      // 这里只在"块剔除"环节按助手处理（助手的剔除规则更严格，不会误删用户提问）。
      const effectiveRole = j.role === 'unknown' ? 'assistant' : j.role;
      const isAssistant = effectiveRole === 'assistant';

      const removal = [];
      const thinkRoots = isAssistant ? findThinkingRoots(node) : [];
      const collapsedThink = isAssistant ? findCollapsedThinkHeaders(node) : [];
      const toolRoots = isAssistant ? findToolRoots(node) : [];

      if (options.excludeThinking) {
        removal.push(...thinkRoots, ...collapsedThink);
      }
      if (options.excludeToolCalls) {
        removal.push(...toolRoots);
      }

      const content = buildMessageContent(node, options, removal);

      const msg = {
        role: j.role,
        confidence: j.conf,
        content,
        thinking: options.includeThinkingBlock ? extractThinkingContent(node, options) : '',
        collapsedThinking: collapsedThink.map((e) => U.normalizeText(e.textContent)).join('；'),
        hadThinkingBlock: thinkRoots.length > 0 || collapsedThink.length > 0,
        hadToolBlock: toolRoots.length > 0,
      };

      if (!msg.content && !msg.thinking) continue;
      messages.push(msg);
    }

    repairUnknownRoles(messages);

    return {
      title: detectTitle(),
      url: location.href,
      model: detectModelName(),
      messages,
      stats: {
        maxNodesInView: maxNodes,
        scanned: records.length,
        exported: messages.length,
        thinkingBlocks: messages.filter((m) => m.hadThinkingBlock).length,
        toolBlocks: messages.filter((m) => m.hadToolBlock).length,
        lowConfidence: messages.filter((m) => m.confidence === 'low').length,
        container: describeEl(scrollEl),
      },
    };
  }

  function detectModelName() {
    const cands = document.querySelectorAll(
      '[class*="model" i], [class*="version" i], [data-testid*="model" i]'
    );
    for (const el of cands) {
      const t = U.normalizeText(el.textContent);
      if (t && t.length <= 24 && /deepseek|r1|v3|chat|reasoner/i.test(t)) return t;
    }
    return 'DeepSeek';
  }

  function describeEl(el) {
    if (!el) return '(none)';
    const cn = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cn ? '.' + cn : '');
  }

  /** 只做识别、不改动页面，用于 popup 的「诊断」 */
  function diagnose() {
    const scrollEl = findScrollContainer(document.body);
    const nodes = findMessageRoots(scrollEl);
    const listRect = scrollEl.getBoundingClientRect();

    const sample = nodes.slice(0, 8).map((n) => {
      const j = judgeRole(n, listRect);
      return {
        role: j.role,
        confidence: j.conf,
        element: describeEl(n),
        preview: U.normalizeText(U.innerTextLoose(n)).slice(0, 80),
      };
    });

    let thinkCount = 0;
    let toolCount = 0;
    let collapsedCount = 0;
    let mdCount = 0;
    nodes.forEach((n) => {
      thinkCount += findThinkingRoots(n).length;
      collapsedCount += findCollapsedThinkHeaders(n).length;
      toolCount += findToolRoots(n).length;
      mdCount += markdownNodesOf(n).length;
    });

    return {
      url: location.href,
      title: detectTitle(),
      container: describeEl(scrollEl),
      scrollHeight: scrollEl.scrollHeight,
      clientHeight: scrollEl.clientHeight,
      messageNodes: nodes.length,
      markdownBlocks: mdCount,
      thinkingBlocks: thinkCount,
      collapsedThinkingHeaders: collapsedCount,
      toolBlocks: toolCount,
      sample,
    };
  }

  NS.extract = {
    scan,
    diagnose,
    findScrollContainer,
    findMessageRoots,
    judgeRole,
    findThinkingRoots,
    findCollapsedThinkHeaders,
    findToolRoots,
  };
})();
