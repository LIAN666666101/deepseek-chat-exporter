const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { __DSMD__: {} };
context.globalThis = context;
vm.runInNewContext(fs.readFileSync('src/content/long-capture.js', 'utf8'), context);
const create = context.__DSMD__.longCapture.create;
const hasStableFullDom = context.__DSMD__.longCapture.hasStableFullDom;

// buildDocx 已异步化（长图切割需要解码图片），主体包进 async IIFE 顺序执行
(async () => {

const firstNode = {};
const lastNode = {};
const stableRoots = [
  { count: 25, first: { node: firstNode, text: '首条消息' }, last: { node: lastNode, text: '末条消息' } },
  { count: 25, first: { node: firstNode, text: '首条消息' }, last: { node: lastNode, text: '末条消息' } }
];
assert.equal(hasStableFullDom(stableRoots, 2, [{ pageUploads: 2 }]), true);
assert.equal(hasStableFullDom(stableRoots, 1, [{ pageUploads: 2 }]), false);
assert.equal(hasStableFullDom([stableRoots[0], { count: 25,
  first: { node: {}, text: '另一条消息' }, last: stableRoots[1].last }], 2, []), false);
const unchangedDomWithMismatchedSnapshots = create();
unchangedDomWithMismatchedSnapshots.add({ messages: [{ role: 'user', body: '屏幕一' }], images: [] }, 'top');
unchangedDomWithMismatchedSnapshots.add({ messages: [{ role: 'user', body: '屏幕二' }], images: [] }, 'bottom');
assert.ok(unchangedDomWithMismatchedSnapshots.result().gaps > 0);
assert.equal(hasStableFullDom(stableRoots, 0, []), true);

const full = [];
for (let turn = 1; turn <= 22; turn++) {
  full.push({ role: 'user', body: `测试问题 ${turn}${turn <= 18 ? ' [image]' : ''}`, turn });
  full.push({ role: 'assistant', body: `测试回复 ${turn}`, turn });
}

function snapshot(start, end, failed = false) {
  const images = [];
  const messages = full.slice(start, end).map(message => {
    let body = message.body;
    if (body.includes('[image]')) {
      const id = images.length;
      const status = failed && message.turn === 10 ? 'failed' : 'embedded';
      images.push({ id, src: `blob:test-${message.turn}`, alt: `图 ${message.turn}`,
        kind: 'user', status, ext: 'png', b64: 'AA==', dataUrl: 'data:image/png;base64,AA==',
        width: 100, height: 100 });
      body = body.replace('[image]', `![用户上传图片](dsmd-img://${id})`);
    }
    return { role: message.role, body };
  });
  return { ok: true, messages, images, stats: { pageUploads: images.length } };
}

const capture = create();
for (let start = 0; start < full.length; start += 5) {
  capture.add(snapshot(start, Math.min(full.length, start + 10)), start);
}
const result = capture.result();
assert.equal(result.gaps, 0);
assert.equal(result.messages.length, 44);
assert.equal(result.images.length, 18);
assert.equal(result.messages.filter(message => message.role === 'user').length, 22);
for (let turn = 1; turn <= 22; turn++) {
  const user = result.messages[(turn - 1) * 2];
  assert.ok(user.body.includes(`测试问题 ${turn}`));
  assert.equal((user.body.match(/dsmd-img:\/\//g) || []).length, turn <= 18 ? 1 : 0);
}
assert.deepEqual(Array.from(result.images, image => image.filename),
  Array.from({ length: 18 }, (_, i) => `user-${String(i + 1).padStart(3, '0')}.png`));

const gaps = create();
gaps.add(snapshot(0, 4), 'top');
gaps.add(snapshot(12, 16), 'bottom');
assert.ok(gaps.result().gaps > 0);
assert.equal(gaps.result().ok, false);

// DeepSeek 的虚拟列表在滚动时会重绘消息正文；同一编号仍应正确对齐。
const virtual = create();
const virtualSnapshot = (numbers, suffix = '') => ({ messages: numbers.map(n => ({
  role: n % 2 ? 'user' : 'assistant', virtualKey: String(n), body: `消息 ${n}${suffix}`
})), images: [] });
virtual.add(virtualSnapshot([3, 4, 5, 6], ' 初次渲染'), 'middle');
virtual.add(virtualSnapshot([1, 2, 3, 4], ' 重绘后'), 'top');
virtual.add(virtualSnapshot([1, 2, 3, 4], ' 再次重绘'), 'top-again');
virtual.add(virtualSnapshot([3, 4, 5, 6], ' 下行重绘'), 'bottom');
assert.equal(virtual.result().gaps, 0);
assert.deepEqual(Array.from(virtual.result().messages, message => message.virtualKey),
  ['1', '2', '3', '4', '5', '6']);

const noOverlap = create();
noOverlap.add(Object.assign(virtualSnapshot([3, 4]), { virtualItemKeys: ['3', '4'] }), 'middle');
noOverlap.add(Object.assign(virtualSnapshot([1, 2]), { virtualItemKeys: ['1', '2'] }), 'top');
noOverlap.add(Object.assign(virtualSnapshot([5, 6]), { virtualItemKeys: ['5', '6'] }), 'bottom');
assert.equal(noOverlap.result().gaps, 0);
assert.deepEqual(Array.from(noOverlap.result().messages, message => message.virtualKey),
  ['1', '2', '3', '4', '5', '6']);
const missingVirtual = create();
missingVirtual.add(virtualSnapshot([1, 2]), 'top');
missingVirtual.add(virtualSnapshot([4, 5]), 'bottom');
assert.equal(missingVirtual.result().gaps, 1);
assert.equal(missingVirtual.result().ok, false);
const branchSkip = create();
branchSkip.add({ messages: [
  { role: 'user', virtualKey: '58', body: '修改前的提问' },
  { role: 'assistant', virtualKey: '61', body: '当前分支的回复' }
], virtualItemKeys: ['58', '61'], images: [] }, 'branch');
assert.equal(branchSkip.result().gaps, 0);
assert.deepEqual(Array.from(branchSkip.result().gapDetails.skippedVirtualKeys), [59, 60]);
const unobservedGap = create();
unobservedGap.add(virtualSnapshot([58]), 'before');
unobservedGap.add(virtualSnapshot([61]), 'after');
assert.equal(unobservedGap.result().gaps, 2);
const emptyVirtualItem = create();
emptyVirtualItem.add(Object.assign(virtualSnapshot([1, 2]), {
  virtualItemKeys: ['1', '2', '3']
}), 'top');
emptyVirtualItem.add(Object.assign(virtualSnapshot([4, 5]), {
  virtualItemKeys: ['3', '4', '5']
}), 'bottom');
assert.equal(emptyVirtualItem.result().gaps, 0);

// 缺编号的瞬时重渲染快照：内容与已归并消息一致 → 不算漏采，不再阻止导出
const transient = create();
transient.add(virtualSnapshot([1, 2, 3]), 'first');
transient.add({ messages: [
  { role: 'user', virtualKey: '', body: '消息 1' },
  { role: 'assistant', virtualKey: '', body: '消息 2' }
], images: [] }, 'transient');
assert.equal(transient.result().gaps, 0);
assert.equal(transient.result().messages.length, 3);
assert.equal(transient.result().gapDetails.unnumberedSnapshots, 0);

// 流式输出：先采到半成品（缺编号），后采到完整版（编号）→ 前缀容差匹配，不算漏采
const streaming = create();
streaming.add(virtualSnapshot([1]), 'first');
streaming.add({ messages: [
  { role: 'user', virtualKey: '', body: '消息 2' },
  { role: 'assistant', virtualKey: '', body: '回复 2 的开头部分', thinking: '思考过程的前半部分' }
], images: [] }, 'partial');
streaming.add({ messages: [
  { role: 'user', virtualKey: '2', body: '消息 2' },
  { role: 'assistant', virtualKey: '3', body: '回复 2 的开头部分和结尾',
    thinking: '思考过程的前半部分加结尾' }
], images: [] }, 'full');
assert.equal(streaming.result().gaps, 0);
assert.deepEqual(Array.from(streaming.result().messages, m => m.virtualKey).filter(Boolean),
  ['1', '2', '3']);

// 缺编号快照里出现从未采集到的新内容 → 仍保守判漏采，阻止导出
const unknownUnnumbered = create();
unknownUnnumbered.add(virtualSnapshot([1]), 'first');
unknownUnnumbered.add({ messages: [
  { role: 'user', virtualKey: '', body: '从未见过的全新消息内容' }
], images: [] }, 'new');
assert.equal(unknownUnnumbered.result().ok, false);
assert.ok(unknownUnnumbered.result().gapDetails.unnumberedSnapshots >= 1);

const virtualImages = create();
virtualImages.add({ messages: [{ role: 'user', virtualKey: '7', body: '![图片](dsmd-img://0)' }],
  virtualItemKeys: ['7'], images: [{ id: 0, src: 'blob:photo', alt: '照片', kind: 'user',
    status: 'failed', ext: 'png' }] }, 'first');
virtualImages.add({ messages: [{ role: 'user', virtualKey: '7', body: '![图片](dsmd-img://0)' }],
  virtualItemKeys: ['7'], images: [{ id: 0, src: 'blob:photo', alt: '照片', kind: 'user',
    status: 'embedded', ext: 'png', b64: 'AA==', dataUrl: 'data:image/png;base64,AA==' }] }, 'retry');
assert.equal(virtualImages.result().images.length, 1);
assert.equal(virtualImages.result().images[0].status, 'embedded');

const recovery = create();
recovery.add(snapshot(16, 24, true), 'first');
recovery.add(snapshot(16, 24, false), 'second');
assert.equal(recovery.result().images.find(image => image.alt === '图 10').status, 'embedded');

// 同一张图懒加载：先采到 ~240px 缩略图、后采到原图 → 归并保留原图
const imgRecord = (w, h) => ({ id: 0, src: 'blob:photo', alt: '照片', kind: 'user',
  status: 'embedded', ext: 'png', b64: 'AA==', dataUrl: 'data:image/png;base64,AA==', width: w, height: h });
const imgMsg = w => ({ messages: [{ role: 'user', virtualKey: '1', body: '![照片](dsmd-img://0)' }],
  virtualItemKeys: ['1'], images: [imgRecord(w, Math.round(w * 2153 / 969))] });
const thumbUpgrade = create();
thumbUpgrade.add(imgMsg(108), 'thumb');
thumbUpgrade.add(imgMsg(969), 'full');
assert.equal(thumbUpgrade.result().images.length, 1);
assert.equal(thumbUpgrade.result().images[0].width, 969);

// 反向：原图先采、缩略图后采 → 仍保留原图
const fullFirst = create();
fullFirst.add(imgMsg(969), 'full');
fullFirst.add(imgMsg(108), 'thumb');
assert.equal(fullFirst.result().images[0].width, 969);

const lazy = create();
const imageOnly = src => ({ messages: [{ role: 'user', body: '![用户上传图片](dsmd-img://0)' },
  { role: 'assistant', body: '已收到图片' }], images: [{ id: 0, src, alt: '附件',
    kind: 'user', status: src ? 'embedded' : 'failed', ext: 'png', b64: 'AA==',
    dataUrl: src ? 'data:image/png;base64,AA==' : null, width: 100, height: 100 }] });
lazy.add(imageOnly(''), 'lazy');
lazy.add(imageOnly('blob:loaded'), 'loaded');
assert.equal(lazy.result().messages.length, 2);
assert.equal(lazy.result().images.length, 1);
assert.equal(lazy.result().images[0].status, 'embedded');

const short = create();
short.add({ messages: [{ role: 'user', body: '单轮多图\n\n![图一](dsmd-img://0)\n\n![图二](dsmd-img://1)', branchNo: '2 / 3' },
  { role: 'assistant', body: '回复' }], images: [0, 1].map(id => ({ id, src: `blob:short-${id}`,
  alt: `图${id}`, kind: 'user', status: 'embedded', ext: 'png', b64: 'AA==',
  dataUrl: 'data:image/png;base64,AA==', width: 100, height: 100 })) }, 'single');
assert.equal(short.result().images.length, 2);
assert.equal(short.result().messages[0].branchNo, '2 / 3');
assert.equal((short.result().messages[0].body.match(/dsmd-img:\/\//g) || []).length, 2);

const diagrams = create();
diagrams.add({ messages: [{ role: 'assistant', body: '![Mermaid 图表](dsmd-img://0)' }],
  images: [{ id: 0, kind: 'mermaid', status: 'embedded', ext: 'png',
    b64: 'AA==', dataUrl: 'data:image/png;base64,AA==' }] }, 'single');
assert.equal(diagrams.result().images[0].filename, 'mermaid-001.png');

for (const file of ['zip.js', 'md-parse.js', 'markdown.js', 'docx.js', 'pdf-doc.js']) {
  vm.runInNewContext(fs.readFileSync(`src/content/${file}`, 'utf8'), context);
}
vm.runInNewContext(fs.readFileSync('src/content/image-extractor.js', 'utf8'), context);
assert.equal(context.__DSMD__.imageTools.failuresOf([
  { id: 0, kind: 'user', status: 'embedded' },
  { id: 1, kind: 'user', status: 'remote', failureReason: 'cors' },
  { id: 2, kind: 'user', status: 'failed', failureReason: 'timeout' },
  { id: 3, kind: 'user', status: 'pending' }
]).length, 3);

// 缩略图变体升级：ty=t → ty=p（其余参数原样保留，非 ty=t 地址不变）
const upgrade = context.__DSMD__.imageTools.internals.upgradeFileUrl;
assert.equal(upgrade('https://files.deepseeksvc.com/api/file?file_id=a&state=s&ty=t'),
  'https://files.deepseeksvc.com/api/file?file_id=a&state=s&ty=p');
assert.equal(upgrade('https://files.deepseeksvc.com/api/file?ty=t&file_id=a'),
  'https://files.deepseeksvc.com/api/file?ty=p&file_id=a');
assert.equal(upgrade('https://files.deepseeksvc.com/api/file?file_id=a&ty=t'),
  'https://files.deepseeksvc.com/api/file?file_id=a&ty=p');
assert.equal(upgrade('https://files.deepseeksvc.com/api/file?file_id=a&ty=p'),
  'https://files.deepseeksvc.com/api/file?file_id=a&ty=p');
assert.equal(upgrade('https://example.com/a.png?ty=t'), 'https://example.com/a.png?ty=p');
assert.equal(upgrade('https://example.com/a.png'), 'https://example.com/a.png');
const input = { title: '长对话图片测试', messages: result.messages, images: result.images };
const shortInput = { title: '短对话多图测试', messages: short.result().messages,
  images: short.result().images };
const shortMarkdown = context.__DSMD__.buildMarkdown(shortInput);
assert.equal((shortMarkdown.markdown.match(/data:image\/png;base64/g) || []).length, 2);
assert.ok(shortMarkdown.markdown.includes('User（2 / 3）'));
assert.equal((context.__DSMD__.pdf.contentBlocks(shortInput.messages, true,
  new Map(shortInput.images.map(image => [image.id, image]))).match(/class="dfp-img"/g) || []).length, 2);
assert.equal((Buffer.from(await context.__DSMD__.docx.buildDocx(shortInput))
  .toString('latin1').match(/word\/media\/user-\d+\.png/g) || []).length, 4);
const markdown = context.__DSMD__.buildMarkdown(input);
assert.equal(markdown.ok, true);
assert.equal((markdown.markdown.match(/data:image\/png;base64/g) || []).length, 18);
const pdfBlocks = context.__DSMD__.pdf.contentBlocks(result.messages, true,
  new Map(result.images.map(image => [image.id, image])));
assert.equal((pdfBlocks.match(/class="dfp-img"/g) || []).length, 18);
const word = await context.__DSMD__.docx.buildDocx(input);
const wordText = Buffer.from(word).toString('latin1');
assert.equal((wordText.match(/word\/media\/user-\d+\.png/g) || []).length, 36);
assert.ok(wordText.includes('word/footer1.xml'));

// 图片分页规则：同一页至多一个图块（严禁多图挤同一页），文本可与图片同页
const imgBlock = height => ({ html: '<p class="dfp-p dfp-p-img"><img class="dfp-img"></p>', height, img: true });
const textBlock = (html, height) => ({ html, height });
const packed = context.__DSMD__.pdf.packPages(
  [imgBlock(400), textBlock('<p>文字</p>', 100), imgBlock(400), imgBlock(400)], 800);
assert.equal(packed.length, 3);
for (const page of packed) assert.equal(page.filter(b => b.img).length, 1);

// 段落重排：同一段落里的多张内嵌图各拆成独立图块
const segMap = new Map([0, 1].map(id => [id, { id, status: 'embedded', ext: 'png',
  dataUrl: 'data:image/png;base64,AA==', width: 100, height: 100 }]));
const inlineTwo = context.__DSMD__.pdf.contentBlocks(
  [{ role: 'user', body: '看![甲](dsmd-img://0)和![乙](dsmd-img://1)' }], true, segMap);
assert.equal((inlineTwo.match(/class="dfp-p dfp-p-img"/g) || []).length, 2);

// 选择性导出：编号区间校验与过滤（纯函数）
const lc = context.__DSMD__.longCapture;
const rangeMsgs = [1, 2, 3, 4, 5, 9, 10].map(n => ({
  role: n % 2 ? 'user' : 'assistant', virtualKey: String(n),
  body: n === 2 ? '![图](dsmd-img://7)消息' + n : '消息' + n
}));
// 分支跳号 6/7/8（skipped）不算缺漏；真正没采到的 6/7/8 若未声明则必须报缺
const rangeOk = lc.checkRange(rangeMsgs, { min: 1, max: 10 },
  { gapDetails: { skippedVirtualKeys: [6, 7, 8] } });
assert.equal(rangeOk.ok, true);
assert.deepEqual(Array.from(rangeOk.missing), []);
assert.equal(rangeOk.presentCount, 7);
const badCheck = lc.checkRange(rangeMsgs, { min: 1, max: 10 }, null);
assert.equal(badCheck.ok, false);
assert.deepEqual(Array.from(badCheck.missing), [6, 7, 8]);
const filtered = lc.filterRange(rangeMsgs, { min: 2, max: 4 });
assert.deepEqual(Array.from(filtered.messages, m => m.virtualKey), ['2', '3', '4']);
assert.ok(filtered.imageIds.has(7));   // 区间内消息引用的图片 id 被收集
assert.equal(lc.filterRange(rangeMsgs, { min: 5, max: 5 }).messages.length, 1); // 单条特例
assert.equal(lc.filterRange(rangeMsgs, { min: 6, max: 8 }).messages.length, 0); // 跳号区间为空

// 绝对序号 X/Y：PDF/Markdown/Word 三通道；X 用虚拟列表编号，区间导出也不变
const seqMsgs = [{ role: 'user', body: '你好', virtualKey: '9' },
  { role: 'assistant', body: '回复', virtualKey: '10' }];
const seqPdf = context.__DSMD__.pdf.contentBlocks(seqMsgs, true, new Map(), 48);
assert.ok(seqPdf.includes('<span class="dfp-seq">9/48</span>'));
assert.ok(seqPdf.includes('<span class="dfp-seq">10/48</span>'));
const seqMd = context.__DSMD__.buildMarkdown({
  title: 't', messages: seqMsgs, excludeThinking: true, seqTotal: 48 });
assert.ok(seqMd.markdown.includes('## User（9/48）'));
assert.ok(seqMd.markdown.includes('## DeepSeek（10/48）'));
const noSeqPdf = context.__DSMD__.pdf.contentBlocks(seqMsgs, true, new Map());
assert.ok(!noSeqPdf.includes('dfp-seq'));
const seqDocx = await context.__DSMD__.docx.buildDocx({
  title: 't', messages: seqMsgs, excludeThinking: true, images: [], seqTotal: 48 });
const seqDocxText = Buffer.from(seqDocx).toString('latin1');
assert.ok(seqDocxText.includes('9/48'));

console.log('long-capture: 22 turns / 18 images, overlap, gap, retry and three formats passed');
})().catch(error => { console.error(error); process.exit(1); });
