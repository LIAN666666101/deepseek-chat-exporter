/**
 * md-parse.js —— 把规范化后的 Markdown 解析成结构化块与行内片段（纯函数）
 *
 * PDF 与 Word 两条导出通道共用这一层：先解析，再各自渲染成 HTML / OOXML，
 * 保证两种格式的内容、顺序、角色区分完全一致。
 * 输入是我们自己生成的 Markdown（结构可控），因此解析规则保持精简而确定。
 */
(() => {
  'use strict';

  const DSMD = (globalThis.__DSMD__ || (globalThis.__DSMD__ = {}));

  const FENCE_RE = /^(`{3,})(.*)$/;
  const HEADING_RE = /^(#{1,6})\s+(.*)$/;
  const HR_RE = /^(-{3,}|\*{3,}|_{3,})\s*$/;
  const QUOTE_RE = /^>\s?(.*)$/;
  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const TABLE_SEP_RE = /^\|[\s:|-]+\|$/;

  /* -------------------------------- 行内解析 -------------------------------- */

  // $...$ 行内公式：放在 code 之后，避免行内代码里的 $ 被误认
  const INLINE_RE = /(\*\*[\s\S]+?\*\*|~~[\s\S]+?~~|\*[^*\n]+?\*|`[^`\n]+?`|\$[^$\n]+?\$|!\[[^\]]*\]\([^)\s]*\)|\[[^\]]*\]\([^)\s]*\)|<https?:\/\/[^>\s]+>)/g;

  function textNode(text) {
    return { type: 'text', text };
  }

  /**
   * 把一段行内 Markdown 解析为片段数组。
   * `hard` 为 true 时把行尾的反斜杠转成硬换行（用户消息里的主动换行）。
   */
  function parseInline(input, options) {
    const opts = options || {};
    const raw = String(input == null ? '' : input);
    const nodes = [];
    let buffer = '';

    const flush = () => {
      if (!buffer) return;
      nodes.push(textNode(buffer.replace(/\\(?=\n|$)/g, '\\')));
      buffer = '';
    };

    raw.split(INLINE_RE).forEach(part => {
      if (!part) return;
      let m;
      if ((m = /^\*\*([\s\S]+?)\*\*$/.exec(part))) { flush(); nodes.push({ type: 'bold', text: m[1] }); return; }
      if ((m = /^~~([\s\S]+?)~~$/.exec(part))) { flush(); nodes.push({ type: 'del', text: m[1] }); return; }
      if ((m = /^\*([^*\n]+?)\*$/.exec(part))) { flush(); nodes.push({ type: 'italic', text: m[1] }); return; }
      if ((m = /^`([^`\n]+?)`$/.exec(part))) { flush(); nodes.push({ type: 'code', text: m[1] }); return; }
      if ((m = /^\$([^$\n]+?)\$$/.exec(part))) { flush(); nodes.push({ type: 'math', text: m[1] }); return; }
      if ((m = /^!\[([^\]]*)\]\(([^)\s]*)\)$/.exec(part))) { flush(); nodes.push({ type: 'image', text: m[1], href: m[2] }); return; }
      if ((m = /^\[([^\]]*)\]\(([^)\s]*)\)$/.exec(part))) { flush(); nodes.push({ type: 'link', text: m[1] || m[2], href: m[2] }); return; }
      if ((m = /^<(https?:\/\/[^>\s]+)>$/.exec(part))) { flush(); nodes.push({ type: 'link', text: m[1], href: m[1] }); return; }
      buffer += part;
    });
    flush();

    if (!opts.hard) return nodes;

    // 行尾反斜杠 = 硬换行：拆成 br 片段
    const out = [];
    for (const node of nodes) {
      if (node.type !== 'text' || node.text.indexOf('\n') === -1) {
        out.push(node);
        continue;
      }
      const lines = node.text.split('\n');
      lines.forEach((line, i) => {
        const isBreak = /\\$/.test(line);
        const text = isBreak ? line.slice(0, -1) : line;
        if (text) out.push(textNode(text));
        if (i < lines.length - 1 && isBreak) out.push({ type: 'br' });
        else if (i < lines.length - 1) out.push(textNode('\n'));
      });
    }
    return out;
  }

  /** 片段数组的纯文本形式（用于长度估算、占位输出） */
  function inlineToText(nodes) {
    return (nodes || []).map(n => {
      if (n.type === 'br') return '\n';
      if (n.type === 'math') return n.text || '';
      if (n.type === 'image') return n.text ? `[图片：${n.text}]` : '[图片]';
      return n.text || '';
    }).join('');
  }

  function splitRow(line) {
    return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
      .split(/(?<!\\)\|/)
      .map(c => c.replace(/\\\|/g, '|').trim());
  }

  /* -------------------------------- 块级解析 -------------------------------- */

  function parseBlocks(markdown) {
    const lines = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i++; continue; }

      // 代码块
      let m = FENCE_RE.exec(line);
      if (m) {
        const fenceLen = m[1].length;
        const lang = m[2].trim();
        const body = [];
        i++;
        while (i < lines.length && !(new RegExp('^`{' + fenceLen + ',}\\s*$')).test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++;                                            // 跳过收尾围栏
        blocks.push({ type: 'code', lang, lines: body });
        continue;
      }

      // 标题
      m = HEADING_RE.exec(line);
      if (m) {
        blocks.push({ type: 'heading', level: m[1].length, text: m[2].trim() });
        i++;
        continue;
      }

      // 分割线
      if (HR_RE.test(line)) {
        blocks.push({ type: 'hr' });
        i++;
        continue;
      }

      // 表格（需要紧跟对齐行）
      if (line.trim().indexOf('|') === 0 && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1].trim())) {
        const header = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map(c => {
          const left = c.startsWith(':');
          const right = c.endsWith(':');
          if (left && right) return 'center';
          if (right) return 'right';
          return 'left';
        });
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim().indexOf('|') === 0) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        blocks.push({ type: 'table', header, aligns, rows });
        continue;
      }

      // 引用（行尾硬换行反斜杠只在 Markdown 里有意义，渲染成 PDF/Word 时剔除，
      // 各行本身已作为独立行呈现，不剔除会泄漏一个「\」字符）
      if (QUOTE_RE.test(line)) {
        const body = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) {
          body.push(QUOTE_RE.exec(lines[i])[1].replace(/\\+$/, ''));
          i++;
        }
        blocks.push({ type: 'quote', lines: body });
        continue;
      }

      // 列表（保留原始缩进与标记，嵌套层级原样呈现）
      if (LIST_RE.test(line)) {
        const items = [];
        while (i < lines.length) {
          const lm = LIST_RE.exec(lines[i]);
          if (lm) {
            items.push({
              indent: lm[1].replace(/\t/g, '  ').length,
              marker: lm[2],
              ordered: /\d/.test(lm[2]),
              text: lm[3]
            });
            i++;
            continue;
          }
          // 列表项里的续行（缩进且不是新的块）
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && !HEADING_RE.test(lines[i].trim()) &&
            !FENCE_RE.test(lines[i].trim()) && !HR_RE.test(lines[i].trim())) {
            const last = items[items.length - 1];
            if (last) {
              last.text += '\n' + lines[i].trim();
              i++;
              continue;
            }
          }
          break;
        }
        if (items.length) blocks.push({ type: 'list', items });
        continue;
      }

      // 段落：连续行合并，行尾反斜杠表示硬换行
      const para = [];
      while (i < lines.length && lines[i].trim() &&
        !FENCE_RE.test(lines[i]) && !HEADING_RE.test(lines[i]) &&
        !HR_RE.test(lines[i]) && !QUOTE_RE.test(lines[i]) && !LIST_RE.test(lines[i]) &&
        !(lines[i].trim().indexOf('|') === 0 && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1].trim()))) {
        para.push(lines[i]);
        i++;
      }
      if (para.length) {
        const joined = para.join('\n');
        // 块级公式：$$...$$（可多行）独立成块，PDF/Word 渲染为居中的公式文本
        const mm = /^\$\$\s*([\s\S]*?)\s*\$\$$/.exec(joined.trim());
        if (mm) {
          blocks.push({ type: 'math', text: mm[1].replace(/^\n+|\n+$/g, '').trim() });
        } else {
          blocks.push({ type: 'paragraph', text: joined, inline: parseInline(joined, { hard: true }) });
        }
      } else {
        i++;                                            // 兜底，避免死循环
      }
    }

    return blocks;
  }

  /** 解析整段对话正文，附带角色信息 */
  function parseMessageBody(markdown) {
    return parseBlocks(markdown);
  }

  /* ------------------------- LaTeX → Unicode 数学文本 ------------------------- */

  // PDF / Word 没有数学排版引擎。页面导出的 LaTeX（KaTeX annotation 源码）在这里
  // 转成可读的 Unicode 数学文本：E = mc^2 → E = mc²、\frac{n(n+1)}{2} → (n(n+1))/2、
  // \int_{0}^{1} → ∫₀¹。只做常见结构的转换，转不了的按原样保留（宁可源码不丢内容）。

  const SUP_DIGITS = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
  const SUB_DIGITS = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' };
  const SUP_CHARS = {
    a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ',
    l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ',
    x: 'ˣ', y: 'ʸ', z: 'ᶻ', T: 'ᵀ', H: 'ᴴ', N: 'ᴺ', K: 'ᴷ', L: 'ᴸ', M: 'ᴹ', '+': '⁺', '-': '⁻'
  };

  const MATH_SYMBOLS = {
    pm: '±', mp: '∓', times: '×', cdot: '·', div: '÷', ast: '∗',
    leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡',
    sim: '∼', propto: '∝', infty: '∞', partial: '∂', nabla: '∇',
    in: '∈', notin: '∉', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
    cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅', forall: '∀', exists: '∃', neg: '¬',
    rightarrow: '→', to: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐',
    Leftrightarrow: '⇔', iff: '⇔', mapsto: '↦', uparrow: '↑', downarrow: '↓',
    ldots: '…', cdots: '⋯', vdots: '⋮', dots: '…', prime: '′', degree: '°',
    angle: '∠', perp: '⊥', parallel: '∥', because: '∵', therefore: '∴',
    cupdot: '∪', oplus: '⊕', otimes: '⊗', top: '⊤', bot: '⊥', circ: '∘', bullet: '•',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ',
    mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
    upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    ',': ' ', ':': ' ', ';': ' ', '!': '', ' ': ' ', quad: '  ', qquad: '    ',
    '{': '{', '}': '}'
  };

  // \left \right 等纯排版命令：剥掉命令名，保留后面的定界符本身
  const MATH_DROP_RE = /^(?:left|right|big[lrm]?|Big[lrm]?|bigg[lrm]?|Bigg[lrm]?|displaystyle|limits|nolimits|mathrm|mathbf|mathit|mathsf|mathtt|textrm|textbf|textit|text|operatorname|mathcal|mathbb|mathfrak)$/;

  function supOf(t) {
    return /^[0-9]+$/.test(t) ? [...t].map(c => SUP_DIGITS[c] || c).join('')
      : t.length === 1 && SUP_CHARS[t] ? SUP_CHARS[t] : null;
  }
  function subOf(t) {
    return /^[0-9]+$/.test(t) ? [...t].map(c => SUB_DIGITS[c] || c).join('') : null;
  }

  // 读一个参数组：'{' 配平取整组，否则取单个字符 / 单个命令
  function readGroup(s, i) {
    if (s[i] === '{') {
      let depth = 0;
      for (let j = i; j < s.length; j++) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') {
          depth--;
          if (!depth) return { text: s.slice(i + 1, j), end: j + 1 };
        }
      }
      return { text: s.slice(i + 1), end: s.length };
    }
    const cmd = /^\\[a-zA-Z]+/.exec(s.slice(i));
    if (cmd) return { text: cmd[0], end: i + cmd[0].length };
    return { text: s[i] || '', end: i + 1 };
  }

  // 转换结果是否足够「简单」（不含空格/运算符/括号），决定 \frac 是否加括号
  function isSimpleMathToken(t) {
    return /^[A-Za-z0-9.²³¹⁰-₉ⁿⁱ°]+$/.test(t);
  }

  function mathConvert(s, depth) {
    if (depth > 8) return s;
    let out = '';
    for (let i = 0; i < s.length;) {
      let m;
      if ((m = /^\\(sum|prod|int)/.exec(s.slice(i)))) {
        const sym = m[1] === 'sum' ? 'Σ' : m[1] === 'prod' ? '∏' : '∫';
        i += m[0].length;
        let sub = '', sup = '';
        while (s[i] === '_' || s[i] === '^') {
          const kind = s[i];
          const g = readGroup(s, i + 1);
          i = g.end;
          if (kind === '_') sub = g.text; else sup = g.text;
        }
        const subT = mathConvert(sub, depth + 1);
        const supT = mathConvert(sup, depth + 1);
        if (!subT && !supT) out += sym;
        else if (/^[0-9]+$/.test(subT) && /^[0-9]+$/.test(supT)) out += sym + subOf(subT) + supOf(supT);
        else if (subT && supT) out += `${sym}(${subT}→${supT})`;
        else if (subT) out += `${sym}_{${subT}}`;
        else out += `${sym}^{${supT}}`;
        continue;
      }
      if (s.startsWith('\\frac', i)) {
        i += 5;
        const a = readGroup(s, i);
        const b = readGroup(s, a.end);
        i = b.end;
        const ca = mathConvert(a.text, depth + 1);
        const cb = mathConvert(b.text, depth + 1);
        out += (isSimpleMathToken(ca) ? ca : `(${ca})`) + '/' + (isSimpleMathToken(cb) ? cb : `(${cb})`);
        continue;
      }
      if (s.startsWith('\\sqrt', i)) {
        i += 5;
        let idx = '';
        if (s[i] === '[') {
          const e = s.indexOf(']', i);
          if (e > 0) { idx = s.slice(i + 1, e); i = e + 1; }
        }
        const g = readGroup(s, i);
        i = g.end;
        const cg = mathConvert(g.text, depth + 1);
        const supIdx = idx ? supOf(mathConvert(idx, depth + 1)) : null;
        out += (supIdx || (idx ? `(${mathConvert(idx, depth + 1)})` : '')) +
          '√' + (isSimpleMathToken(cg) ? cg : `(${cg})`);
        continue;
      }
      if (s[i] === '^' || s[i] === '_') {
        const kind = s[i];
        const g = readGroup(s, i + 1);
        i = g.end;
        const t = mathConvert(g.text, depth + 1);
        const mapped = kind === '^' ? supOf(t) : subOf(t);
        out += mapped != null ? mapped : (kind === '^' ? `^${t.length > 1 ? `{${t}}` : t}` : `_${t.length > 1 ? `{${t}}` : t}`);
        continue;
      }
      out += s[i];
      i++;
    }
    return out;
  }

  function mathToText(latex) {
    let s = String(latex == null ? '' : latex).trim();
    if (!s) return '';
    s = s.replace(/\$\$?/g, '');                    // 容错：剥掉残留定界符
    s = mathConvert(s, 0);
    s = s.replace(/\\([a-zA-Z]+|.)/g, (whole, name) => {
      if (MATH_SYMBOLS[name] != null) return MATH_SYMBOLS[name];
      if (MATH_DROP_RE.test(name)) return '';
      return name;                                  // 未知命令：去掉反斜杠保留字母
    });
    s = s.replace(/\{|\}/g, '');
    return s.replace(/\s+/g, ' ').trim();
  }

  DSMD.mdParse = { parseBlocks, parseInline, inlineToText, splitRow, mathToText };
})();
