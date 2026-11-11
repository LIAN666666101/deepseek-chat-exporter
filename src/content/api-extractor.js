/**
 * api-extractor.js —— 解析 DeepSeek 会话接口返回的数据（纯函数，无网络、无 DOM 依赖）
 *
 * 故障根因（本项目要解决的问题）：
 *   DeepSeek 已把助手消息的正文从顶层 message.content 迁到 message.fragments[]
 *   （数组元素形如 { type: "THINK" | "RESPONSE", content: "..." }）。
 *   旧实现只读 message.content，取到 undefined，于是导出文件里
 *   「## User」「## DeepSeek」标题照常输出，正文却一片空白。
 *
 * 本模块的应对：
 *   1. 按 fragments 的类型分流：THINK 类进思考过程，RESPONSE 类进正文，
 *      检索/工具类作为附加内容；无 type 的片段按正文处理（宁可保留也不丢内容）。
 *   2. 顶层 content / text / thinking_content 等旧字段继续兼容。
 *   3. 前两步都取不到正文时，深扫整条消息对象，取最长的有效文本兜底，
 *      并对 id、状态枚举、时间戳等噪音字段做排除。
 *   4. 分支还原：优先按 current_message_id + parent_id 回溯当前分支，
 *      元数据缺失或链路断裂时退回按时间/顺序排列，两种情况下都不会返回空数组。
 */
(() => {
  'use strict';

  const DSMD = (globalThis.__DSMD__ || (globalThis.__DSMD__ = {}));

  const THINK_KEYS = ['thinking_content', 'thinking', 'reasoning_content', 'reasoning', 'cot', 'chain_of_thought', 'thought'];
  const BODY_KEYS = ['content', 'text', 'answer', 'response', 'output', 'markdown', 'body', 'value', 'reply', 'message'];
  const CONTENT_KEYS = ['content', 'text', 'value', 'markdown', 'body', 'inner', 'html', 'answer', 'message', 'reply', 'output'];
  const ARRAY_KEYS = ['fragments', 'content_fragments', 'parts', 'blocks', 'segments', 'content_blocks', 'items'];

  const SKIP_KEYS = new Set([
    'id', 'message_id', 'parent_id', 'chat_session_id', 'session_id', 'conversation_id',
    'title', 'status', 'model', 'model_type', 'role', 'type', 'message_type',
    'inserted_at', 'updated_at', 'created_at', 'seq_id',
    'elapsed_secs', 'elapse_secs', 'thinking_elapsed_secs', 'accumulated_token_usage',
    'code', 'msg', 'biz_code', 'biz_msg', 'error', 'error_code', 'trace_id', 'request_id',
    'finish_reason', 'search_status', 'ban_edit', 'ban_regenerate', 'thinking_enabled',
    'search_enabled', 'incomplete', 'pinned', 'muted', 'version', 'agent', 'character',
    'title_type', 'feedback', 'files', 'file_ids', 'file_name', 'file_size', 'mime_type',
    'tips', 'references', 'index', 'key', 'name', 'version_id', 'selected', 'extra'
  ]);

  /* ------------------------------ 基础读取工具 ------------------------------ */

  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/\r\n?/g, '\n')
      .replace(/\u0000/g, '')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  function looksLikeContent(s) {
    const t = String(s || '').trim();
    if (t.length < 12) return false;
    if (/^[0-9a-f]{8,}$/i.test(t)) return false;            // 十六进制串 / 哈希
    if (/^\d+([.]\d+)?$/.test(t)) return false;              // 纯数字
    if (/^\d{4}-\d{2}-\d{2}[T ]/.test(t)) return false;      // 时间戳
    if (/^[A-Z_]{3,}$/.test(t)) return false;                // 枚举常量 FINISHED / ASSISTANT
    if (/^(true|false|null|none|undefined)$/i.test(t)) return false;
    if (/^https?:\/\/\S+$/.test(t)) return false;            // 纯链接
    if (/^[0-9a-f-]{32,}$/i.test(t)) return false;           // UUID
    return /[\u4e00-\u9fa5a-zA-Z]/.test(t);
  }

  // 把任意形态的内容值读成文本（字符串 / 数组 / 嵌套对象 / HTML）
  function readText(value, depth = 0) {
    if (value == null || depth > 4) return '';
    if (typeof value === 'string') return maybeHtmlToMarkdown(value);
    if (typeof value === 'number' || typeof value === 'boolean') return '';
    if (Array.isArray(value)) {
      return value.map(v => readText(v, depth + 1)).filter(Boolean).join('\n\n');
    }
    if (typeof value === 'object') {
      for (const k of CONTENT_KEYS) {
        if (k in value) {
          const t = readText(value[k], depth + 1);
          if (t) return t;
        }
      }
      return '';
    }
    return '';
  }

  // 接口正文通常是 Markdown 源码，只有明显是 HTML 时才转换，避免误伤 Markdown
  function maybeHtmlToMarkdown(s) {
    const t = clean(s);
    if (!t || !DSMD.htmlToMarkdown) return t;
    const looksHtml = /^\s*<(p|div|table|ul|ol|h[1-6]|pre|blockquote)\b/i.test(t) &&
      /<\/[a-z]+\s*>/i.test(t) &&
      !/```/.test(t);
    if (!looksHtml) return t;
    try {
      return clean(DSMD.htmlToMarkdown(t));
    } catch (e) {
      return t;
    }
  }

  function firstArray(obj, keys) {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of keys) {
      if (Array.isArray(obj[k])) return obj[k];
    }
    return null;
  }

  /* -------------------------------- 角色识别 -------------------------------- */

  function normalizeRole(msg) {
    if (!msg || typeof msg !== 'object') return 'assistant';
    if (msg.__role) return msg.__role;

    let raw = msg.role != null ? msg.role
      : msg.sender != null ? msg.sender
        : msg.author != null ? msg.author
          : msg.from != null ? msg.from
            : msg.speaker;

    let r = '';
    if (typeof raw === 'string') r = raw;
    else if (raw && typeof raw === 'object') r = String(raw.role || raw.type || raw.name || '');
    r = r.toLowerCase().trim();

    if (!r) {
      const t = String(msg.type != null ? msg.type : (msg.message_type || '')).toUpperCase();
      if (/^(REQUEST|USER|HUMAN|QUESTION|PROMPT|ASK)$/.test(t)) return 'user';
      if (/^(RESPONSE|ASSISTANT|ANSWER|REPLY|MODEL|AI|BOT)$/.test(t)) return 'assistant';
      if (msg.is_user === true) return 'user';
      if (msg.is_user === false) return 'assistant';
      return 'assistant';
    }

    if (/user|human|customer|request|question|prompt|ask/.test(r)) return 'user';
    return 'assistant';
  }

  /* ------------------------------ 片段类型分流 ------------------------------ */

  function classifyFragment(type) {
    const t = String(type == null ? '' : type).toUpperCase().trim();
    if (!t) return 'body';                                   // 无类型 => 当正文，宁可多留
    if (/THINK|REASON|\bCOT\b|ANALYSIS|REFLECT/.test(t)) return 'thinking';
    if (/^(RESPONSE|ANSWER|CONTENT|FINAL|REPLY|TEXT|MESSAGE|OUTPUT|BODY|REQUEST|USER)/.test(t)) return 'body';
    if (/SEARCH|WEB|BROWSE|CITE|REFERENCE|SOURCE|LINK|TOOL|FUNCTION|CALL|CODE|HTML|IMAGE|FILE/.test(t)) return 'extra';
    if (/TIPS|SUGGEST|TITLE|META|STATUS|USAGE|TOKEN|METRIC/.test(t)) return 'skip';
    return 'body';
  }

  /* ------------------------------ 单条消息解析 ------------------------------ */

  function extractMessageParts(msg) {
    const result = { role: normalizeRole(msg), body: '', thinking: '', extras: [], branchNo: '' };
    if (msg && msg.__branchNo) result.branchNo = String(msg.__branchNo).trim();
    if (!msg || typeof msg !== 'object') return result;

    const bodyParts = [];
    const thinkParts = [];
    const usedKeys = new Set();

    // 1) fragments / parts / blocks / segments —— 新版正文所在
    const frags = firstArray(msg, ARRAY_KEYS);
    if (frags) {
      usedKeys.add(ARRAY_KEYS.find(k => Array.isArray(msg[k])));
      for (const frag of frags) {
        if (frag == null) continue;
        const isObj = typeof frag === 'object';
        const type = isObj ? (frag.type != null ? frag.type : (frag.kind != null ? frag.kind : frag.fragment_type)) : '';
        const kind = classifyFragment(type);
        if (kind === 'skip') continue;

        const text = isObj
          ? readText(frag.content != null ? frag.content
            : frag.text != null ? frag.text
              : frag.value != null ? frag.value
                : frag.markdown != null ? frag.markdown
                  : frag.body != null ? frag.body : frag)
          : readText(frag);

        if (!text) continue;
        if (kind === 'thinking') thinkParts.push(text);
        else if (kind === 'extra') result.extras.push({ title: extraTitleFor(type), text });
        else bodyParts.push(text);
      }
    }

    // 2) 旧版顶层字段（content / thinking_content 等）
    for (const k of THINK_KEYS) {
      if (msg[k] != null) {
        usedKeys.add(k);
        const t = readText(msg[k]);
        if (t) thinkParts.push(t);
      }
    }
    for (const k of BODY_KEYS) {
      if (msg[k] != null) {
        usedKeys.add(k);
        const t = readText(msg[k]);
        if (t) bodyParts.push(t);
      }
    }

    // 3) 兜底：深扫消息对象里最长的有效文本
    if (!bodyParts.length) {
      const fb = deepestText(msg, usedKeys);
      if (fb) bodyParts.push(fb);
    }

    result.body = joinUnique(bodyParts);
    result.thinking = joinUnique(thinkParts);
    return result;
  }

  function extraTitleFor(type) {
    const t = String(type || '').toUpperCase();
    if (/SEARCH|WEB|BROWSE/.test(t)) return '联网检索';
    if (/CITE|REFERENCE|SOURCE|LINK/.test(t)) return '引用来源';
    if (/TOOL|FUNCTION|CALL/.test(t)) return '工具调用';
    if (/CODE|HTML/.test(t)) return '代码片段';
    if (/IMAGE|FILE/.test(t)) return '附件内容';
    return '附加内容';
  }

  // 合并同一角色的多个文本片段，去掉互相包含的重复（fragments 与顶层字段常常是同一份内容）
  function joinUnique(parts) {
    const out = [];
    for (const raw of parts) {
      const t = clean(raw);
      if (!t) continue;
      const dup = out.some(o => o === t || o.includes(t) || t.includes(o));
      if (dup) {
        const idx = out.findIndex(o => t.length > o.length && t.includes(o));
        if (idx >= 0) out[idx] = t;
        continue;
      }
      out.push(t);
    }
    return out.join('\n\n');
  }

  // 深扫对象，取最长的一段有效文本
  function deepestText(root, usedKeys) {
    let best = '';
    const seen = new Set();

    (function walk(node, depth, key) {
      if (node == null || depth > 6) return;
      if (typeof node === 'string') {
        if (usedKeys && usedKeys.has(key)) return;
        if (!looksLikeContent(node)) return;
        if (node.length > best.length) best = node;
        return;
      }
      if (typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        for (const v of node) walk(v, depth + 1, key);
        return;
      }
      for (const k of Object.keys(node)) {
        if (SKIP_KEYS.has(k)) continue;
        walk(node[k], depth + 1, k);
      }
    })(root, 0, null);

    return clean(best);
  }

  /* ------------------------------ 载荷归一化 ------------------------------ */

  function pickSession(scope, fallback) {
    if (!scope || typeof scope !== 'object') return fallback || null;
    return scope.chat_session || scope.session || scope.conversation || scope.chat || fallback || null;
  }

  // 部分接口把一轮对话包成 { request_message, response_message }，这里展开成消息数组
  function expandTurns(items) {
    const out = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const req = item.request_message || item.user_message || item.request;
      const res = item.response_message || item.assistant_message || item.reply_message || item.response;
      if (req || res) {
        if (req && typeof req === 'object') out.push(Object.assign({ __role: 'user' }, req));
        if (res && typeof res === 'object') out.push(Object.assign({ __role: 'assistant' }, res));
        continue;
      }
      out.push(item);
    }
    return out;
  }

  function normalizeEnvelope(json) {
    const candidates = [json, json && json.data, json && json.data && json.data.biz_data,
      json && json.biz_data, json && json.data && json.data.data, json && json.result];

    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;
      const msgs = firstArray(c, ['chat_messages', 'messages', 'items', 'message_list', 'history', 'list', 'turns']);
      if (msgs) {
        return {
          session: pickSession(c, pickSession(json, null)),
          messages: expandTurns(msgs),
          payload: c
        };
      }
    }
    return { session: pickSession(json, null), messages: [], payload: null };
  }

  // 接口层错误信息（用于给出可读提示）
  function apiErrorMessage(json) {
    if (!json || typeof json !== 'object') return '接口返回内容不可解析';
    const code = json.code != null ? json.code : (json.data && json.data.biz_code);
    const msg = json.msg || json.message || (json.data && (json.data.biz_msg || json.data.msg));
    if (code === 0) return null;
    if (code == null) return null;
    return `DeepSeek 接口返回错误（code=${code}${msg ? '：' + msg : ''}）`;
  }

  /* -------------------------------- 排序还原 -------------------------------- */

  // 最近一次 orderMessages 的分支匹配信息（extractFromApi 读取后随结果返回）
  let lastBranchMatch = null;

  function keyOf(msg) {
    const k = msg.message_id != null ? msg.message_id
      : msg.id != null ? msg.id
        : msg.seq_id != null ? msg.seq_id : null;
    return k == null ? null : String(k);
  }

  /* ------------------------------ 分支指纹匹配 ------------------------------ */

  /**
   * 故障根因（「只能导出最后一次修改的分支」）：
   *   接口返回的是「全部分支」的消息合集，其 chat_session.current_message_id 只指向
   *   最新生成的叶子，不会跟随用户在网页上切换分支。旧逻辑从该叶子回溯，于是永远
   *   导出最后一次修改生成的分支；页面显示的分支只有 DOM 知道。
   * 修复：导出前从页面提取结果算出「当前显示分支」的指纹（依序的 角色+正文键），
   *   在消息树中搜索与指纹最吻合的根→叶路径——用户切到哪个分支，就导出哪个分支。
   */

  // 比对键：两侧正文形态差异（硬换行反斜杠、图片/图表占位引用、mermaid 源码块
  // 在页面侧已被换成图片引用）统一抹平，只留可稳定比对的文字
  function fingerprintKey(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, '\n')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\\+/g, '')
      .replace(/\s+/g, '')
      .slice(0, 160)
      .toLowerCase();
  }

  /** 从页面侧消息数组提取「当前显示分支」指纹：依序的 (角色, 正文键)，空正文不参与 */
  function branchFingerprint(messages) {
    const fp = [];
    for (const m of messages || []) {
      if (!m) continue;
      const key = fingerprintKey(m.body);
      if (!key) continue;
      fp.push({ role: m.role === 'user' ? 'user' : 'assistant', key });
    }
    return fp;
  }

  function parentKeyOf(m) {
    const p = m.parent_id != null ? m.parent_id : m.parent_message_id;
    return p == null ? null : String(p);
  }

  function sessionLeafKey(session) {
    const leaf = session && (session.current_message_id != null ? session.current_message_id
      : session.current_message != null ? session.current_message
        : session.leaf_message_id);
    return leaf == null ? null : String(leaf);
  }

  /** 一条根→叶路径与指纹的有序匹配数（贪心前进；角色与文本键都要对上） */
  function matchScore(path, fingerprint, entries) {
    let i = 0;
    for (const m of path) {
      if (i >= fingerprint.length) break;
      const e = entries.get(m);
      if (!e || !e.key) continue;                 // 空正文（纯图片轮次等）不参与比对
      const f = fingerprint[i];
      if (e.role === f.role &&
        (e.key === f.key || e.key.indexOf(f.key) === 0 || f.key.indexOf(e.key) === 0)) i++;
    }
    return i;
  }

  /**
   * 在消息树中搜索与「当前显示分支指纹」最吻合的根→叶路径。
   * 每个叶子回溯出一条路径并与指纹比对打分；同分时依次按
   * 「会话游标指向的叶子 → 时间更新 → 路径更长」裁决。
   * @returns {{path, score, leaves, accepted}|null}
   */
  function findBestBranch(list, map, fingerprint, session) {
    const childCount = new Map();
    for (const m of list) {
      const pk = parentKeyOf(m);
      if (pk != null) childCount.set(pk, (childCount.get(pk) || 0) + 1);
    }

    const entries = new Map();
    for (const m of list) {
      const p = extractMessageParts(m);
      entries.set(m, { role: p.role, key: fingerprintKey(p.body) });
    }

    const leafKey = sessionLeafKey(session);
    const timeOf = m => Number(m.inserted_at != null ? m.inserted_at
      : m.created_at != null ? m.created_at
        : m.updated_at != null ? m.updated_at : NaN);

    let best = null;
    let leaves = 0;
    for (const m of list) {
      const k = keyOf(m);
      if (k == null || childCount.has(k)) continue;    // 只从叶子出发
      leaves++;
      const path = [];
      const visited = new Set();
      let cur = m;
      while (cur && !visited.has(cur) && path.length < 5000) {
        visited.add(cur);
        path.push(cur);
        const pk = parentKeyOf(cur);
        cur = pk != null ? map.get(pk) : null;
      }
      path.reverse();
      const score = matchScore(path, fingerprint, entries);

      if (!best) { best = { path, score, leaf: m }; continue; }
      if (score === best.score) {
        let take = false;
        const lk = keyOf(m);
        const bk = keyOf(best.leaf);
        if (leafKey && ((lk === leafKey) !== (bk === leafKey))) {
          take = lk === leafKey;
        } else {
          const lt = timeOf(m);
          const bt = timeOf(best.leaf);
          if (Number.isFinite(lt) && Number.isFinite(bt) && lt !== bt) take = lt > bt;
          else take = path.length > best.path.length;
        }
        if (take) best = { path, score, leaf: m };
      } else if (score > best.score) {
        best = { path, score, leaf: m };
      }
    }
    if (!best) return null;

    // 可靠性门槛：指纹命中数与路径长度都要够，避免拿单点误配当分支
    //（没有 parent_id 的扁平载荷里每条消息都是"叶子"，路径长度 1 会被这里挡住）
    const needScore = Math.max(1, Math.ceil(fingerprint.length * 0.5));
    const accepted = best.score >= needScore && best.path.length >= 2;
    return { path: best.path, score: best.score, leaves, accepted };
  }

  function orderMessages(messages, session, fingerprint) {
    lastBranchMatch = null;
    const list = [];
    const seen = new Set();
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const k = keyOf(m);
      if (k != null && seen.has(k)) continue;      // 同 id 去重
      if (k != null) seen.add(k);
      list.push(m);
    }
    if (list.length <= 1) return list;

    const map = new Map();
    for (const m of list) {
      const k = keyOf(m);
      if (k != null) map.set(k, m);
    }

    // ★ 分支导出：优先按「当前页面显示分支」的指纹在全树中搜索对应路径
    if (fingerprint && fingerprint.length) {
      const found = findBestBranch(list, map, fingerprint, session);
      if (found) {
        lastBranchMatch = {
          strategy: found.accepted ? 'fingerprint' : 'fallback',
          fingerprintSize: fingerprint.length,
          matched: found.score,
          leaves: found.leaves,
          pathLength: found.path.length
        };
        if (found.accepted) return found.path;
      } else {
        lastBranchMatch = { strategy: 'none', fingerprintSize: fingerprint.length, matched: 0, leaves: 0 };
      }
    }

    // 1) 按当前分支回溯（处理「重新生成」产生的兄弟分支）
    let leafKey = sessionLeafKey(session);

    if (leafKey && !map.has(leafKey) && /^\d+$/.test(leafKey)) {
      // current_message_id 有时是序号而非 id，尝试用序号定位
      const bySeq = list.filter(m => Number(m.seq_id) === Number(leafKey));
      if (bySeq.length === 1) leafKey = keyOf(bySeq[0]);
    }

    if (leafKey && map.has(leafKey)) {
      const branch = [];
      const visited = new Set();
      let cur = leafKey;
      while (cur && map.has(cur) && !visited.has(cur) && branch.length < 5000) {
        visited.add(cur);
        const m = map.get(cur);
        branch.unshift(m);
        const p = m.parent_id != null ? m.parent_id : m.parent_message_id;
        cur = p == null ? null : String(p);
      }
      if (branch.length >= 2 || (branch.length === 1 && list.length <= 2)) return branch;
    }

    // 2) 退回时间/顺序排列
    const indexed = list.map((m, i) => ({
      m,
      i,
      t: Number(m.inserted_at != null ? m.inserted_at
        : m.created_at != null ? m.created_at
          : m.updated_at != null ? m.updated_at : NaN)
    }));

    // 全部消息都带时间戳时按时间升序排，结果与真实时序一致
    if (indexed.every(x => Number.isFinite(x.t))) {
      indexed.sort((a, b) => (a.t === b.t ? a.i - b.i : a.t - b.t));
      return indexed.map(x => x.m);
    }

    // 没有时间戳：数组顺序可能是正序也可能是倒序，用 parent_id 的指向判断方向，
    // parent_id 也不可用时交给时序自检（以用户提问开头为准）
    const reversed = detectReversedArray(list);
    const sequence = reversed ? list.slice().reverse() : list;
    return DSMD.chronology ? DSMD.chronology.fixOrder(sequence) : sequence;
  }

  /**
   * 判断消息数组是否是倒序返回：
   * 正序时「后一条的 parent_id == 前一条的 id」，倒序时「前一条的 parent_id == 后一条的 id」。
   * 父子关系不可用时返回 false，交由上层按角色顺序判断。
   */
  function detectReversedArray(list) {
    let forward = 0;
    let backward = 0;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      const prevKey = keyOf(prev);
      const curKey = keyOf(cur);
      const prevParent = prev.parent_id != null ? String(prev.parent_id) : null;
      const curParent = cur.parent_id != null ? String(cur.parent_id) : null;
      if (curParent != null && curKey != null && curParent === prevKey) forward++;
      if (prevParent != null && prevKey != null && prevParent === curKey) backward++;
    }
    return backward > forward;
  }

  /**
   * 为选中分支的每条消息计算分支序号：同一父节点下同角色的兄弟消息数即版本总数，
   * 按 inserted_at 排序得到当前消息的位置（与页面切换器「当前 / 总数」一致）。
   * 兄弟只有自己（从未修改 / 重新生成）时不标注。
   */
  function attachApiBranchNos(ordered) {
    const groups = new Map();
    for (const m of ordered) {
      const pk = parentKeyOf(m);
      const k = pk == null ? '__root__' : pk;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    const timeOf = m => Number(m.inserted_at != null ? m.inserted_at
      : m.created_at != null ? m.created_at : m.updated_at) || 0;
    return ordered.map(m => {
      const pk = parentKeyOf(m);
      const sibs = (groups.get(pk == null ? '__root__' : pk) || [])
        .filter(s => normalizeRole(s) === normalizeRole(m));
      if (sibs.length <= 1) return m;
      const sorted = sibs.slice().sort((a, b) => timeOf(a) - timeOf(b));
      const idx = sorted.indexOf(m);
      if (idx < 0) return m;
      return Object.assign({}, m, { __branchNo: `${idx + 1} / ${sibs.length}` });
    });
  }

  /* --------------------------------- 入口 --------------------------------- */

  function extractFromApi(json, options) {
    const opts = options || {};
    const warn = [];

    const err = apiErrorMessage(json);
    if (err) return { ok: false, reason: 'api-error', error: err, messages: [], warn };

    const env = normalizeEnvelope(json);
    if (!env.messages.length) {
      return { ok: false, reason: 'no-messages', error: '接口返回中未找到消息列表', messages: [], warn };
    }

    // 分支导出：opts.fingerprint 是「当前页面显示分支」的指纹（content.js 从页面
    // 提取结果算出）。接口按指纹过滤出同一分支，而不是盲目采用最新叶子/全部消息。
    const fingerprint = Array.isArray(opts.fingerprint) ? opts.fingerprint : null;
    const ordered = orderMessages(env.messages, env.session, fingerprint);
    const branchMatch = lastBranchMatch;
    // 分支序号（如「1 / 2」）：按树中同父同角色的兄弟版本数量与时间序计算，
    // 与页面切换器显示的版本位置一致
    const orderedWithBranch = attachApiBranchNos(ordered);
    // 时序自检兜底：保证「提问在前、回复在后」
    const sequenced = DSMD.chronology ? DSMD.chronology.fixOrder(
      orderedWithBranch.map(m => ({ role: normalizeRole(m), ref: m }))
    ).map(x => x.ref) : orderedWithBranch;

    const messages = sequenced.map(m => {
      const p = extractMessageParts(m);
      return { role: p.role, body: p.body, thinking: p.thinking, extras: p.extras };
    });

    const withBody = messages.filter(m => m.body);
    if (!withBody.length) {
      return {
        ok: false,
        reason: 'empty-bodies',
        error: '接口返回了消息，但未解析出任何正文（字段结构可能再次变更）',
        messages,
        warn
      };
    }

    const emptyCount = messages.length - withBody.length;
    if (emptyCount > 0) warn.push(`有 ${emptyCount} 条消息未解析出正文，已跳过`);

    const session = env.session || {};
    return {
      ok: true,
      messages,
      title: clean(session.title || ''),
      sessionId: clean(session.id || session.chat_session_id || ''),
      warn,
      branchMatch: branchMatch || null,
      raw: {
        messageCount: env.messages.length,
        usedBranch: ordered.length,
        branchMatch: branchMatch || null
      }
    };
  }

  function sessionIdFromUrl(url) {
    const m = String(url || '').match(/\/(?:a\/)?chat\/s\/([0-9a-zA-Z_-]+)/);
    return m ? m[1] : null;
  }

  /* -------------------------------- 通道选择 -------------------------------- */

  /** 接口通道是否按指纹「完整命中」了当前页面显示的分支 */
  function sameBranchMatched(api) {
    const bm = api && api.branchMatch;
    if (!bm || bm.strategy !== 'fingerprint') return false;
    return bm.fingerprintSize > 0 && bm.matched >= bm.fingerprintSize;
  }

  /**
   * 数据源选择（分支导出的关键规则）：
   *   页面上显示哪个分支，页面抓取通道拿到的就是哪个分支 —— 只要页面通道可用就无条件优先；
   *   接口通道返回的是全部分支的合集，只有当它按页面分支指纹【完整命中同一分支】
   *   且比页面更完整（页面未渲染出早前消息）时，才用接口数据替换页面数据。
   *   页面通道不可用时退回接口通道（此时无指纹，按原有最新分支逻辑）。
   */
  function chooseSource(dom, api) {
    const domOk = !!(dom && dom.ok && dom.messages && dom.messages.length);
    const apiOk = !!(api && api.ok && api.messages && api.messages.length);

    if (domOk) {
      if (apiOk && sameBranchMatched(api) && api.messages.length > dom.messages.length) {
        return {
          source: 'api',
          label: '会话接口（当前显示分支，页面未渲染全部消息）',
          messages: api.messages,
          note: '与页面同一分支，内容更完整'
        };
      }
      return { source: 'dom', label: '当前页面（显示中的分支）', messages: dom.messages, note: '' };
    }
    if (apiOk) return { source: 'api', label: '会话接口（最新分支）', messages: api.messages, note: '' };
    return null;
  }

  DSMD.apiExtractor = {
    extractFromApi,
    extractMessageParts,
    orderMessages,
    normalizeRole,
    classifyFragment,
    normalizeEnvelope,
    apiErrorMessage,
    sessionIdFromUrl,
    readText,
    deepestText,
    looksLikeContent,
    branchFingerprint,
    fingerprintKey,
    findBestBranch,
    sameBranchMatched,
    chooseSource
  };
})();
