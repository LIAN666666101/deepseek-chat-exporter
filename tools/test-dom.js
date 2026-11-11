/**
 * test-dom.js —— 用 jsdom 构造一个"类 DeepSeek"的页面结构，验证两个最关键的逻辑：
 *   1. 思考过程块的识别与排除（含展开态、折叠态两种情况）
 *   2. DOM → Markdown 转换的正确性（标题/代码块/表格/列表/公式/行内样式）
 *
 * 运行：
 *   NODE_PATH=<managed-node-workspace>/node_modules node tools/test-dom.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SRC = ['src/lib/util.js', 'src/lib/markdown.js', 'src/lib/extract.js'];

/* ------------------------------------------------------------------ *
 * 模拟页面：刻意使用「哈希类名」，逼出启发式识别能力
 * ------------------------------------------------------------------ */
const HTML = `<!DOCTYPE html>
<html><head><title>如何用 Python 做数据分析 - DeepSeek</title></head>
<body>
<div class="app">
  <div class="scroll-area _9f2c1">
    <div class="_4f9bf79 list">

      <!-- 用户提问 1 -->
      <div class="_9a1f7e" data-message-author-role="user">
        <div class="_b7c2d">帮我用 Python 做一份销售数据分析，顺便讲讲思路。</div>
      </div>

      <!-- 助手回答 1：展开状态的思考过程 + 正文 -->
      <div class="_3c8e1a" data-message-author-role="assistant">
        <div class="_7436101">
          <div class="_e1675d8">已深度思考（用时 13 秒）</div>
          <div class="think-inner">我需要先确认数据字段，再决定用 pandas 还是 polars。先给出一个通用流程。</div>
        </div>
        <div class="_4f9bf79">
          <div class="ds-markdown ds-markdown--block">
            <h2>整体思路</h2>
            <p>分三步：<strong>读取</strong>、<em>清洗</em>、<code>聚合</code>。</p>
            <ul><li>读取：<code>pd.read_csv</code></li><li>清洗：处理缺失值</li></ul>
            <pre><code class="language-python">import pandas as pd
df = pd.read_csv("sales.csv")
print(df.head())</code></pre>
            <table>
              <thead><tr><th>步骤</th><th>工具</th></tr></thead>
              <tbody><tr><td>读取</td><td>pandas</td></tr><tr><td>绘图</td><td>matplotlib</td></tr></tbody>
            </table>
            <p>公式示例：<span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">E = mc^2</annotation></semantics></math></span></span></p>
            <p>参考 <a href="https://pandas.pydata.org/">官方文档</a>。</p>
            <blockquote><p>提示：先看分布再建模。</p></blockquote>
          </div>
        </div>
        <div class="_88e3a2b toolbar">
          <button>复制</button><button>重新生成</button><button>点赞</button>
        </div>
      </div>

      <!-- 用户提问 2 -->
      <div class="_9a1f7e">
        <div class="_b7c2d">再帮我看看异常值怎么处理？</div>
      </div>

      <!-- 助手回答 2：折叠状态的思考过程（正文未渲染）+ 联网搜索卡片 -->
      <div class="_3c8e1a">
        <div class="search-cards" data-testid="search-result-list">
          <div class="search-title">搜索 3 个网页</div>
          <a href="https://example.com/a">异常值检测方法</a>
        </div>
        <div class="_cc22dd">
          <div class="_e1675d8">已深度思考（用时 5 秒）</div>
        </div>
        <div class="_4f9bf79">
          <div class="ds-markdown ds-markdown--block">
            <p>常见做法有三种：Z-Score、IQR、以及基于模型的检测。</p>
            <p>其中 IQR 最稳健。</p>
          </div>
        </div>
        <div class="_88e3a2b toolbar"><button>复制</button><button>重新生成</button></div>
      </div>

    </div>
  </div>
</div>
</body></html>`;

/* ------------------------------------------------------------------ */

const dom = new JSDOM(HTML, {
  url: 'https://chat.deepseek.com/a/chat/s/test-conversation-id',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});

for (const rel of SRC) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  dom.window.eval(code);
}

const NS = dom.window.__DSE__;

/* ------------------------------------------------------------------ *
 * 迷你断言框架
 * ------------------------------------------------------------------ */
let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + name);
  } else {
    fail++;
    failures.push(name + (extra ? '  → ' + extra : ''));
    console.log('  \u2717 ' + name + (extra ? '  → ' + extra : ''));
  }
}

function section(t) {
  console.log('\n' + t);
}

/* ------------------------------------------------------------------ *
 * 1. 结构识别
 * ------------------------------------------------------------------ */
section('[1] 页面结构识别');

const scrollEl = NS.extract.findScrollContainer(dom.window.document.body);
const nodes = NS.extract.findMessageRoots(scrollEl);
check('识别到 4 个消息块', nodes.length === 4, '实际 ' + nodes.length);

const r1 = NS.extract.judgeRole(nodes[0], scrollEl.getBoundingClientRect());
const r2 = NS.extract.judgeRole(nodes[1], scrollEl.getBoundingClientRect());
check('消息 1 判定为用户（属性优先）', r1.role === 'user', r1.role + '/' + r1.conf);
check('消息 2 判定为助手（属性优先）', r2.role === 'assistant', r2.role + '/' + r2.conf);

const roles = nodes.map((n) => NS.extract.judgeRole(n, scrollEl.getBoundingClientRect()).role);
check('有角色属性的消息判定准确', roles[0] === 'user' && roles[1] === 'assistant', roles.join(','));
check('无属性的消息进入 unknown（等待交替规律兜底）', roles[2] === 'unknown' || roles[3] === 'unknown', roles.join(','));

const think1 = NS.extract.findThinkingRoots(nodes[1]);
check('展开态思考块被识别', think1.length === 1, '识别到 ' + think1.length);
check('思考块不含正文 .ds-markdown', think1.every((e) => !e.querySelector('.ds-markdown')));

const collapsed = NS.extract.findCollapsedThinkHeaders(nodes[3]);
check('折叠态思考标题被识别', collapsed.length === 1, '识别到 ' + collapsed.length);

const tools = NS.extract.findToolRoots(nodes[3]);
check('联网搜索卡片被识别', tools.length >= 1, '识别到 ' + tools.length);

/* ------------------------------------------------------------------ *
 * 2. Markdown 转换
 * ------------------------------------------------------------------ */
section('[2] Markdown 转换');

const md1 = NS.markdown.elementToMarkdown(nodes[1].querySelector('.ds-markdown'), { imageMode: 'link' });
const want = [
  ['标题', /##\s*整体思路/],
  ['加粗', /\*\*读取\*\*/],
  ['斜体', /\*清洗\*/],
  ['行内代码', /`聚合`/],
  ['无序列表', /-\s*读取/],
  ['代码块 fence', /```python/],
  ['代码内容', /pd\.read_csv\("sales\.csv"\)/],
  ['表格表头', /\|\s*步骤\s*\|\s*工具\s*\|/],
  ['表格分隔行', /\|\s*---\s*\|\s*---\s*\|/],
  ['表格数据', /\|\s*绘图\s*\|\s*matplotlib\s*\|/],
  ['KaTeX 公式还原', /\$E = mc\^2\$/],
  ['链接', /\[官方文档\]\(https:\/\/pandas\.pydata\.org\/\)/],
  ['引用', /> 提示：先看分布再建模。/],
  ['不含按钮文案', !/重新生成|点赞/.test(md1)],
];
want.forEach(([n, re]) => {
  const ok = typeof re === 'boolean' ? re : re.test(md1);
  check(n, ok, ok ? '' : JSON.stringify(md1.slice(0, 200)));
});

const mdOffset = NS.markdown.elementToMarkdown(nodes[1].querySelector('.ds-markdown'), {
  imageMode: 'link',
  headingOffset: 1,
});
check(
  '标题层级可按角色标题需要整体降级',
  /###\s*整体思路/.test(mdOffset),
  JSON.stringify(mdOffset.slice(0, 40))
);

/* ------------------------------------------------------------------ *
 * 3. 端到端：排除思考过程
 * ------------------------------------------------------------------ */
section('[3] 端到端导出（已开启"排除所有思考过程"）');

(async function () {
  const result = await NS.extract.scan(
    {
      excludeThinking: true,
      includeThinkingBlock: false,
      excludeToolCalls: true,
      includeMeta: true,
      imageMode: 'link',
      loadHistory: false,
    },
    () => {}
  );

  const all = result.messages.map((m) => m.content).join('\n\n@@\n\n');

  check('导出消息条数 = 4', result.messages.length === 4, '实际 ' + result.messages.length);
  check(
    '角色顺序正确（含无属性消息的交替推断）',
    result.messages.map((m) => m.role).join(',') === 'user,assistant,user,assistant',
    result.messages.map((m) => m.role).join(',')
  );
  check('识别到思考过程块（统计）', result.stats.thinkingBlocks >= 1, String(result.stats.thinkingBlocks));
  check('思考正文已被排除', !/我需要先确认数据字段/.test(all));
  check('折叠态思考标题已被排除', !/已深度思考（用时 13 秒）/.test(all) && !/已深度思考（用时 5 秒）/.test(all));
  check('联网搜索卡片已被排除', !/搜索 3 个网页/.test(all));
  check('正文内容完整保留', /整体思路/.test(all) && /IQR 最稳健/.test(all));
  check('用户提问完整保留', /帮我用 Python 做一份销售数据分析/.test(all) && /异常值怎么处理/.test(all));
  check('会话标题来自 document.title', result.title === '如何用 Python 做数据分析', JSON.stringify(result.title));

  section('[4] 端到端导出（保留思考过程为折叠块）');
  const result2 = await NS.extract.scan(
    { excludeThinking: true, includeThinkingBlock: true, excludeToolCalls: true, loadHistory: false },
    () => {}
  );
  const t = result2.messages.map((m) => m.thinking).join('\n');
  check('思考正文被单独抽出', /我需要先确认数据字段/.test(t), JSON.stringify(t.slice(0, 80)));
  check('思考正文未混入 content', !/我需要先确认数据字段/.test(result2.messages.map((m) => m.content).join('\n')));

  /* 顺便落一份样例导出文件，方便肉眼检查格式 */
  const samplePath = path.join(ROOT, 'tools', 'sample-output.md');
  fs.writeFileSync(
    samplePath,
    [
      '# ' + result.title,
      '',
      '> **来源**：https://chat.deepseek.com/a/chat/s/test-conversation-id',
      '> ',
      '> **模型**：DeepSeek',
      '> ',
      '> **导出时间**：2026-09-26 02:40',
      '> ',
      '> **消息数**：' + result.messages.length + '　|　**思考过程**：已排除',
      '',
      '---',
      '',
      result.messages
        .map((m, i) => {
          const head = '## ' + (m.role === 'user' ? '用户' : 'DeepSeek');
          const body = [m.content];
          if (i !== result.messages.length - 1) body.push('\n---\n');
          return head + '\n\n' + body.join('\n');
        })
        .join('\n'),
    ].join('\n')
  );
  console.log('\n  已写出样例文件：tools/sample-output.md');

  section('[5] 用户消息不被误删（护栏）');
  const dom2 = new JSDOM(
    `<!DOCTYPE html><html><head><title>t</title></head><body><div class="s">
      <div data-message-author-role="user"><div>思考过程</div></div>
      <div data-message-author-role="assistant"><div class="ds-markdown"><p>好的。</p></div></div>
    </div></body></html>`,
    { url: 'https://chat.deepseek.com/a', pretendToBeVisual: true, runScripts: 'outside-only' }
  );
  for (const rel of SRC) dom2.window.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const res3 = await dom2.window.__DSE__.extract.scan({ loadHistory: false, excludeThinking: true }, () => {});
  check(
    '用户消息内容"思考过程"未被当作思考块删除',
    res3.messages[0] && /思考过程/.test(res3.messages[0].content),
    JSON.stringify(res3.messages[0] && res3.messages[0].content)
  );

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})();
