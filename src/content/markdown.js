/**
 * markdown.js —— 组装最终 .md 文件（纯函数，可在 Node 中直接测试）
 *
 * 设计要点（针对「导出只有 User / DeepSeek 身份标题、没有正文」的故障）：
 *  1. 写入正文前逐条校验，正文与思考过程都为空的轮次直接丢弃，
 *     绝不会出现「有标题、无内容」的空壳。
 *  2. 若全部轮次都被丢弃，返回 ok:false 并给出诊断原因，
 *     由调用方提示用户，而不是生成一个只有标题的文件。
 *  3. 正文原样保留（接口返回的是 Markdown 源码，页面抓取的已转成 Markdown），
 *     只做行尾空白与多余空行的规整，不改动用户内容。
 */
(() => {
  'use strict';

  const DSMD = (globalThis.__DSMD__ || (globalThis.__DSMD__ = {}));

  const USER_LABEL = 'User';
  const ASSISTANT_LABEL = 'DeepSeek';

  function normalizeText(s) {
    return String(s == null ? '' : s)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  function fenceFor(text) {
    let max = 0;
    const re = /`+/g;
    let m;
    while ((m = re.exec(text))) max = Math.max(max, m[0].length);
    return '`'.repeat(Math.max(4, max + 1));
  }

  function roleLabel(role) {
    return role === 'user' ? USER_LABEL : ASSISTANT_LABEL;
  }

  /**
   * 校验并清理消息列表。
   * @param {Array} messages
   * @param {object} [options] {excludeThinking}: 排除思考过程时，
   *        只有思考内容、没有正式回复的轮次会被整条丢弃，
   *        避免导出文件里出现「有身份标题、没有正文」的空段。
   * @returns {{messages: Array, dropped: Array, bodyChars: number}}
   */
  function validateMessages(messages, options) {
    const excludeThinking = !options || options.excludeThinking !== false;
    const kept = [];
    const dropped = [];

    for (const raw of messages || []) {
      const role = raw && raw.role === 'user' ? 'user' : 'assistant';
      const body = normalizeText(raw && raw.body);
      const thinking = normalizeText(raw && raw.thinking);
      const extras = Array.isArray(raw && raw.extras)
        ? raw.extras.map(e => ({ title: normalizeText(e && e.title), text: normalizeText(e && e.text) }))
          .filter(e => e.text)
        : [];
      // 分支序号（如「1 / 2」）：仅接受合法形态，随角色标题同行导出
      const branchNo = /^\d+\s*\/\s*\d+$/.test(String((raw && raw.branchNo) || '').trim())
        ? String(raw.branchNo).replace(/\s+/g, ' ').trim()
        : '';
      // 绝对序号（虚拟列表编号，如「5」）：随角色标题以 X/Y 形式导出
      const virtualKey = /^(\d+)$/.test(String((raw && raw.virtualKey) || '').trim())
        ? String(raw.virtualKey).trim()
        : '';

      if (!body && !thinking && !extras.length) {
        dropped.push({ role, reason: 'empty', label: raw && raw.label });
        continue;
      }

      // 排除思考过程时，只有思考的轮次等于没有正式回复，整条不要
      if (excludeThinking && !body && !extras.length) {
        dropped.push({ role, reason: 'thinking-only', label: raw && raw.label });
        continue;
      }

      // 与前一条完全同角色同内容 => 页面重复渲染产生的副本
      const prev = kept[kept.length - 1];
      if (prev && prev.role === role && prev.body === body && prev.thinking === thinking) {
        if (!prev.branchNo && branchNo) prev.branchNo = branchNo;   // 副本上的分支序号补回主条
        dropped.push({ role, reason: 'duplicate' });
        continue;
      }

      kept.push({ role, body, thinking, extras, label: raw && raw.label, branchNo, virtualKey });
    }

    const bodyChars = kept.reduce((n, m) => n + m.body.length, 0);
    return { messages: kept, dropped, bodyChars };
  }

  // 用鸭子类型判断日期，兼容内容脚本与页面（以及测试环境）之间跨作用域传入的 Date
  function asDate(value) {
    return value && typeof value.getTime === 'function' && Number.isFinite(value.getTime())
      ? value
      : new Date();
  }

  /* -------------------------------- 时序自检 -------------------------------- */

  /**
   * 判断消息序列是否是倒序。
   * 正常对话里「用户提问 → 模型回复」的相邻组合应不少于反向组合；
   * 若反向组合更多，说明数据源给的是倒序（页面反向渲染、接口倒序返回等）。
   */
  function looksReversed(messages) {
    let forward = 0;    // user → assistant，正常时序
    let backward = 0;   // assistant → user，倒序特征
    for (let i = 1; i < (messages || []).length; i++) {
      const prev = messages[i - 1] && messages[i - 1].role;
      const cur = messages[i] && messages[i].role;
      if (prev === 'user' && cur === 'assistant') forward++;
      else if (prev === 'assistant' && cur === 'user') backward++;
    }
    return backward > forward;
  }

  /** 时序兜底：整段倒序时反转回「提问在前、回复在后」 */
  function fixOrder(messages) {
    const list = Array.isArray(messages) ? messages.slice() : [];
    const hasUser = list.some(m => m && m.role === 'user');
    const hasAssistant = list.some(m => m && m.role === 'assistant');
    if (!hasUser || !hasAssistant) return list;
    return looksReversed(list) ? list.reverse() : list;
  }

  /* ------------------------------ 图片引用解析 ------------------------------ */

  // 正文里的占位引用（dom-extractor 写入）：![用户上传图片](dsmd-img://N)
  const IMG_REF_RE = /!\[([^\]]*)\]\(dsmd-img:\/\/(\d+)\)/g;

  /**
   * 把占位引用解析成最终形式：
   *   - embedded + embed 模式 → base64 内嵌 data URL
   *   - embedded + zip 模式   → images/user-001.png 相对路径（配合打包 .zip）
   *   - remote（跨域无法本地读取）→ 保留原始 URL，后缀「图片可能需联网查看」
   *   - failed（图片加载失败）→ 文字占位符提示
   * @returns {{markdown, used, remote, failed}} used/failed 为记录数组（zip 打包要用 used）
   */
  function resolveImageRefs(markdown, images, mode) {
    const list = Array.isArray(images) ? images : [];
    if (!list.length || String(markdown).indexOf('dsmd-img://') === -1) {
      return { markdown, used: [], remote: [], failed: [] };
    }
    const byId = new Map(list.map(r => [r.id, r]));
    const used = [];
    const remote = [];
    const failed = [];

    const out = String(markdown).replace(IMG_REF_RE, (whole, alt, idStr) => {
      const rec = byId.get(Number(idStr));
      if (!rec) return alt || '';
      used.push(rec);
      const label = alt || '用户上传图片';
      if (rec.status === 'embedded' && rec.dataUrl) {
        return mode === 'zip'
          ? `![${label}](images/${rec.filename})`
          : `![${label}](${rec.dataUrl})`;
      }
      if (rec.status === 'remote' && rec.src) {
        remote.push(rec);
        return `![${label}](${rec.src})（图片可能需联网查看）`;
      }
      failed.push(rec);
      return `（图片加载失败${rec.src ? `，原始地址 ${rec.src}` : ''}）`;
    });

    return { markdown: out, used, remote, failed };
  }

  /**
   * 生成 Markdown 全文。
   * 文件内容只有对话本身：标题行 + 按真实时序排列的 User / DeepSeek 轮次，
   * 不写入来源、导出时间、消息数等任何元数据。
   * @param {object} input
   * @param {string} input.title
   * @param {Array}  input.messages  [{role, body, thinking, extras}]
   * @param {boolean} input.excludeThinking 是否排除思考过程
   * @param {Array}  [input.images]   用户上传图片记录（正文里的 dsmd-img://N 引用据此解析）
   * @param {string} [input.imageMode] 'embed'（base64 内嵌，默认）| 'zip'（相对路径引用）
   */
  function buildMarkdown(input) {
    const opts = input || {};
    const excludeThinking = opts.excludeThinking !== false;
    const seqTotal = Number(opts.seqTotal) || 0;
    const { messages, dropped, bodyChars } = validateMessages(opts.messages, { excludeThinking });

    if (!messages.length) {
      return {
        ok: false,
        reason: 'no-content',
        droppedCount: dropped.length,
        markdown: ''
      };
    }

    const title = normalizeText(opts.title) || 'DeepSeek 对话';
    const userCount = messages.filter(m => m.role === 'user').length;
    const assistantCount = messages.length - userCount;

    const lines = [];
    lines.push(`# ${title}`);
    lines.push('');

    for (const msg of messages) {
      // 角色标题行末尾：绝对序号 X/Y（X = 消息的虚拟列表编号 = 全文绝对位置，
      // Y = 全文总消息数；区间/单条导出时 X 仍为全文位置）+ 分支序号（如有）
      const seqNo = /^(\d+)$/.exec(String(msg.virtualKey || ''));
      const seqPart = seqTotal && seqNo ? `${seqNo[1]}/${seqTotal}` : '';
      const tagParts = [seqPart, msg.branchNo].filter(Boolean);
      lines.push(`## ${roleLabel(msg.role)}${tagParts.length ? `（${tagParts.join('，')}）` : ''}`);
      lines.push('');

      // 思考过程：可选项，默认排除
      if (!excludeThinking && msg.thinking) {
        const fence = fenceFor(msg.thinking);
        lines.push('### 思考过程');
        lines.push('');
        lines.push(fence + 'text');
        lines.push(msg.thinking);
        lines.push(fence);
        lines.push('');
      }

      if (msg.body) {
        lines.push(msg.body);
        lines.push('');
      } else {
        // 正文为空但有思考过程/附加内容时，明确标注，避免看起来像导出失败
        lines.push('> （此轮无正文内容）');
        lines.push('');
      }

      for (const extra of msg.extras) {
        const fence = fenceFor(extra.text);
        lines.push(`#### ${extra.title || '附加内容'}`);
        lines.push('');
        lines.push(fence + 'text');
        lines.push(extra.text);
        lines.push(fence);
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    }

    let md = lines.join('\n').replace(/\n{4,}/g, '\n\n\n').replace(/\s+$/, '') + '\n';

    // 图片引用解析：base64 内嵌 / zip 相对路径 / 远程降级 / 失败占位
    const resolved = resolveImageRefs(md, opts.images, opts.imageMode === 'zip' ? 'zip' : 'embed');
    md = resolved.markdown;

    return {
      ok: true,
      markdown: md,
      usedImages: resolved.used,
      imageStats: {
        total: (opts.images || []).length,
        used: resolved.used.length,
        embedded: resolved.used.filter(r => r.status === 'embedded').length,
        remote: resolved.remote.length,
        failed: resolved.failed.length
      },
      stats: {
        turns: messages.length,
        userCount,
        assistantCount,
        bodyChars,
        droppedCount: dropped.length,
        dropped
      }
    };
  }

  /** 文件名：标题 + 时间戳 + 扩展名，去掉文件系统非法字符 */
  function buildFilename(title, sessionId, date, extension) {
    let base = normalizeText(title)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 60);
    if (!base) base = sessionId ? `deepseek-${sessionId.slice(0, 8)}` : 'deepseek-chat';

    const d = asDate(date);
    const p = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
      `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const ext = extension || 'md';
    return { name: `${base}_${stamp}.${ext}`, base: `${base}_${stamp}` };
  }

  DSMD.buildMarkdown = buildMarkdown;
  DSMD.validateMessages = validateMessages;
  DSMD.resolveImageRefs = resolveImageRefs;
  DSMD.buildFilename = buildFilename;
  DSMD.chronology = { looksReversed, fixOrder };
  DSMD.markdownInternals = { fenceFor, normalizeText, asDate };
})();
