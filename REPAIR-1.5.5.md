# REPAIR 1.5.5 —— 图片导出失真修复（PDF / Word）

日期：2026-10-24
范围：仅 PDF 与 Word 两条导出通道；Markdown 导出未做任何改动。

## 问题

1. **多图挤同页**：一条消息上传多张图片时，PDF 里多张图被压到同一页（每张限高 110mm），
   Word 里每张图被限到 600×760px，细节完全看不清。
2. **长图压扁**：竖版长截图（如 969×2153、更极端的 900×8000）为塞进单页被等比缩到
   极小（PDF 曾把高度上限设为 110mm，长图实际显示宽只有 ~35mm）。
3. **附加问题**：旧排版下超出页高的图片在 `collectBlocks` 中被钳制测量高度后，
   会被 `.page-body` 的 `overflow:hidden` 直接裁掉底部内容。

## 导出原理（排查结论）

- **PDF**（`pdf-doc.js`）：纯前端。在离屏 iframe 里按 A4 版心逐块量高、贪心装箱分页
  （`packPages`），生成带页脚「第 X 页 共 Y 页」的分页 HTML，最后调用
  `iframe.contentWindow.print()` 交给浏览器打印引擎「另存为 PDF」。
  **不使用 html2canvas / jsPDF / 截图**。
- **Word**（`docx.js`）：纯前端手写 OOXML（zip + XML，零第三方库），图片以
  inline drawing 插入，分页由 Word 自身完成。
- **导出时页面自动滚动**：来自 `long-capture.js` / `image-extractor.preparePage`
  对 DeepSeek 虚拟列表的逐屏采集（DOM 回收机制下必须滚动才能取全消息），
  与排版渲染无关，不是截图行为。

## 根因

| 位置 | 旧逻辑 |
| --- | --- |
| `pdf-doc.js` `IMG_MAX_H_MM = 110` + `fitSizePx()` | 所有图片强制 ≤110mm 高；超出页高的图被 `Math.min(h, maxHeight)` 钳制后整块裁切 |
| `docx.js` `IMG_MAX_W_PX = 600` / `IMG_MAX_H_PX = 760` + `fitExtent()` | 图片双重压缩 |
| 两者的 `imgOnly`（`inline.length === 1`）判断 | 同一段落含多图时失效，多图按行内限高挤在一起 |

## 修复内容

### 共享：`image-extractor.js`
- 新增 `DSMD.imageTools.sliceDataUrl(dataUrl, srcW, srcH, srcRows)`：
  用 canvas 把内嵌长图按源像素行数横向切条，JPEG 源保持 JPEG 重编码，
  其余 PNG；返回 `[{dataUrl, width, height, ext}]`。

### PDF：`pdf-doc.js`
- `fitSizePx()`：宽度尽可能占满版心（658px @96dpi），**高度不再设上限**；
  放大不超过 2 倍原生尺寸（`IMG_MAX_UPSCALE = 2`，避免 108×240 之类小图拉到全宽而模糊）。
- 新增 `sliceTallImages()`：显示高超过「页内容高 − 图块底距余量」（约 944px）的长图，
  在导出前预切割成多条（`rec._slices`），每条独立成块、依次落在连续页面；
  切割失败时 `fitPagePx()` 兜底为「整图缩进一页」，宁可缩小不裁切。
- 段落重排 `segmentParagraph()`：段落里每张**已内嵌**的图都拆成独立居中图块
  （`.dfp-p-img`），多图不再挤同段；remote/failed 占位与文本段保持原样。
- `packPages()` 增加规则：**每页至多一个图块**（`b.img`）——本页已有图片时下一张图
  另起新页；图片前只剩标题类 keep 块且放不下时，keep 块自成页、图片独占下一页，
  杜绝图片底部被 overflow 裁切。
- `collectBlocks()` 给图块打 `img` 标记；图块不参与子块拆分。
- 行内上下文（列表/表格/引用里的图）保留 `fitCompactPx()`（≤版心宽、≤110mm），
  避免撑破缩进行宽。

### Word：`docx.js`
- `fitExtent()`：版心全宽（cx = 6,264,910 EMU ≈ 9866 twips），高度等比不限，
  同样带 2× 放大上限；`capHPx` 仅用于切割失败兜底。
- 新增 `sliceDocxImages()`：显示高超过 `IMG_SLICE_MAX_H_PX`（947px，版心高 971px
  减段距余量）的长图预切割；每条作为**独立媒体部件**（`rec.id#s<序号>` 去重，
  文件名 `原名-s01.png`…）逐条独立成段插入，条间距 0，Word 按页高自然分页。
- 段落重排与 PDF 同策略：每张内嵌图独立成段（居中，段前 60 / 段后 120 twip）；
  Word 对放不下的整段 inline 图片会自动推到下一页（inline 图片所在行不可拆分），
  不会压缩图片。
- `buildDocx` 改为 **async**（切片需要 Image 解码 + canvas）；
  `content.js` 调用点同步加 `await`。
- 行内上下文新增 `fitCompactExtent()`（不放大、限高 0.6×版心高）。

### 测试
- `tools/test-long-capture.js`：适配 async buildDocx；新增两条断言——
  packPages 每页至多一图、同段多图拆分为独立图块。
- `test-dom.js` 需要的 jsdom 在本机未安装（1.5.3 起即如此，与本次修改无关）。

## 真实验证（chat.deepseek.com「导出图片功能测试」对话，62 条消息 / 28 张图 + 合成 900×8000 长图）

将修复后的 content 脚本（随 1.5.5 发布）注入登录态页面驱动真实导出（拦截 print 捕获排版结果）：

| 指标 | PDF 实测 | Word 实测 |
| --- | --- | --- |
| 总页数 / drawing 数 | 236 页 | 44 个 drawing |
| 每页图片数 | **≤ 1**（44 个含图页均 1 图） | **每段 1 图**（multiDrawingParas = 0） |
| 图片宽度 | 658px（版心全宽）或小图 2× | 6,264,910 EMU（版心全宽）或小图 2× |
| 969×2153 长截图 | 切成 658×944 + 658×518 两条，连续两页，无裁切 | 同样切成 s01/s02 两条，cy ≤ 9,021,470 EMU |
| 合成 900×8000 超长图 | 切成 7 条（第 230–236 页），逐条清晰 | 切成 long-test-s01…s07 七个媒体部件 |
| 单图是否超页 | 无（最高块含边距 ≤ 页内容高） | 无（maxCy = 947px ≤ 971px 版心高） |

视觉抽查截图确认：标题页、长图切片页、切片续接页文字全部清晰可辨，
页脚「第 X 页 共 236 页」编号正确。

## 已知边界

- 切片在切割点处可能切在文字行中间（切割线处一行字上下分家），
  相邻页拼接后内容完整；这是「横向切割分页」方案的固有形态。
- 动图 GIF 被切割后变为静态（首帧形态的对应条带）；未切割的 GIF 保持原样。
- 极小图（< 329px 宽）按最多 2× 放大显示，不再强行拉到版心全宽，避免模糊。
