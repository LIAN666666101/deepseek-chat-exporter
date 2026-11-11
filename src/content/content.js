/**
 * content.js —— 入口：注入按钮与面板，编排「页面抓取 + 接口校验」两条通道并下载文件
 *
 * 隐私边界（与本文件相关的全部对外行为）：
 *   - 唯一的网络请求是对 chat.deepseek.com 自己的会话接口发起的只读 GET，
 *     且仅在未勾选「仅使用页面内容」时才可能发生；不访问任何第三方地址。
 *   - 文件由本页 Blob 直接生成下载，不经过任何服务器。
 *   - 选项偏好保存在本页 localStorage（键名前缀 dsmd_），不上报。
 */
(() => {
  'use strict';

  const DSMD = (globalThis.__DSMD__ || (globalThis.__DSMD__ = {}));
  if (DSMD.__contentLoaded) return;      // 防止重复注入
  DSMD.__contentLoaded = true;

  const LOG = '[DeepSeek 导出]';
  const PREF_KEY = 'dsmd_exporter_prefs_v1';
  const API_TIMEOUT = 15000;
  const HISTORY_URL = id =>
    `https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(id)}&cache_version=0`;

  let host = null;
  let els = null;
  let busy = false;
  let lastCaptureSummary = null;

  /* -------------------------------- 偏好存储 -------------------------------- */

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      const p = raw ? JSON.parse(raw) : {};
      return {
        excludeThinking: p.excludeThinking !== false,   // 默认排除思考过程
        localOnly: p.localOnly === true,              // 默认允许接口校验
        format: ['markdown', 'pdf', 'docx'].includes(p.format) ? p.format : 'markdown'
      };
    } catch (e) {
      return { excludeThinking: true, localOnly: false, format: 'markdown' };
    }
  }

  function savePrefs(prefs) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* 忽略存储失败 */ }
  }

  /* --------------------------------- 环境读取 -------------------------------- */

  function currentSessionId() {
    const fromUrl = DSMD.apiExtractor.sessionIdFromUrl(location.href);
    if (fromUrl) return fromUrl;
    const link = document.querySelector('a[href*="/a/chat/s/"]');
    return link ? DSMD.apiExtractor.sessionIdFromUrl(link.getAttribute('href') || '') : null;
  }

  function authToken() {
    try {
      const raw = localStorage.getItem('userToken');
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.value === 'string') return parsed.value;
      } catch (e) { /* 不是 JSON，按原值处理 */ }
      return raw.length > 20 ? raw : null;
    } catch (e) {
      return null;
    }
  }

  function pageTitle() {
    const raw = (document.title || '').replace(/\s*[-–|]\s*DeepSeek.*$/i, '').trim();
    if (raw && !/^DeepSeek$/i.test(raw)) return raw;
    return '';
  }

  /* --------------------------------- 接口通道 -------------------------------- */

  async function fetchHistory(sessionId) {
    const token = authToken();
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT);
    try {
      const res = await fetch(HISTORY_URL(sessionId), {
        method: 'GET',
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function tryApiChannel(fingerprint) {
    const sessionId = currentSessionId();
    if (!sessionId) return { ok: false, reason: 'no-session-id', error: '当前地址里没有会话 ID' };
    try {
      const json = await fetchHistory(sessionId);
      // 分支导出：把「当前页面显示分支」的指纹交给接口解析，
      // 让接口只返回页面正在显示的那条分支（而不是全部分支/最新分支）
      const result = DSMD.apiExtractor.extractFromApi(json, {
        fingerprint: Array.isArray(fingerprint) ? fingerprint : []
      });
      return Object.assign({ sessionId, json }, result);
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? '接口请求超时' : (e && e.message) || String(e);
      return { ok: false, reason: 'fetch-failed', error: msg, sessionId };
    }
  }

  /* --------------------------------- 通道选择 -------------------------------- */

  // 通道选择规则在 api-extractor.chooseSource：页面显示的分支无条件优先，
  // 只有接口按指纹完整命中同一分支且更完整时才采用接口数据
  function chooseSource(dom, api) {
    return DSMD.apiExtractor.chooseSource(dom, api);
  }

  /* --------------------------------- 导出流程 -------------------------------- */

  // 选择性导出：文件名带上区间标记（静秋文案情感解读_消息5-15_时间戳.pdf）
  function withRangeTag(name, selectRange) {
    if (!selectRange || !name || !name.name) return name;
    const tag = `_消息${selectRange.min}-${selectRange.max}`;
    return {
      name: name.name.replace(/(\.[a-z0-9]+)$/i, `${tag}$1`),
      base: (name.base || name.name) + tag
    };
  }

  // 图片统计的展示文案（只显示在面板上，不写入文件）
  function imageSummary(images) {
    if (!images || !images.length || !DSMD.imageTools) return '';
    const userRecs = images.filter(r => r && r.kind !== 'mermaid');
    const mermaidCount = images.filter(r => r && r.kind === 'mermaid' && r.status === 'embedded').length;
    const s = DSMD.imageTools.statsOf(userRecs);
    let line = '';
    if (s.total) {
      line = `\n图片 ${s.total} 张（内嵌 ${s.embedded}` +
        (s.remote ? ` / 需联网查看 ${s.remote}` : '') +
        (s.failed ? ` / 加载失败 ${s.failed}` : '') + '）';
    }
    if (mermaidCount) {
      line += (line ? '，' : '\n') + `Mermaid 图表 ${mermaidCount} 张（已转为图片）`;
    }
    return line;
  }

  async function runExport() {
    if (busy) return;
    busy = true;
    setStatus('正在读取页面内容…', 'busy');
    els.exportBtn.disabled = true;
    hideImageWarning();
    lastCaptureSummary = null;

    // 选择性导出：导出开始即读取勾选并彻底清理注入的复选框 UI
    //（选中编号已缓存；滚动采集期间页面节点会回收，勾选框没有必要留在页面上）。
    let selectRange = null;
    if (DSMD.selectUI && DSMD.selectUI.isActive()) {
      const sel = DSMD.selectUI.getSelection();
      if (sel && sel.keys.length) selectRange = { min: sel.min, max: sel.max };
      DSMD.selectUI.destroy();
      els.selectBtn.textContent = '选择消息';
    }

    let restoreScroll = null;
    const capture = DSMD.longCapture && DSMD.longCapture.create();
    const imageCache = new Map();
    const rootSamples = [];
    const sampleRoots = () => {
      const roots = Array.from(document.querySelectorAll('[class~="ds-markdown"]'));
      const edge = root => root ? {
        node: root,
        text: (root.textContent || '').replace(/\s+/g, ' ').trim()
      } : null;
      rootSamples.push({ count: roots.length, first: edge(roots[0]),
        last: edge(roots[roots.length - 1]) });
    };

    const prefs = {
      excludeThinking: els.excludeThinking.checked,
      localOnly: els.localOnly.checked
    };
    savePrefs(prefs);

    try {
      // 说明：曾尝试 beforeprint 全量渲染快捷通道（一次抓全部消息），但实测
      // DeepSeek 的打印渲染模式会剥掉用户上传图片（DOM 里只剩头像），无法承载
      // 图片导出，故保留经过验证的逐屏滚动采集管线；虚拟列表滚动失步由
      // preparePage 内的冻结自愈（resize 事件）兜底。
      // 滚动时立即保存当屏消息和图片；旧节点回收后，已保存的数据仍可导出。
      if (DSMD.imageTools) {
        setStatus('正在逐屏采集对话和图片…', 'busy');
        const prep = await DSMD.imageTools.preparePage({
          deferRestore: true,
          budgetMs: 150000,   // 长对话 + 原图加载场景：留足滚动与历史加载时间
          onStep: async step => {
            sampleRoots();
            const load = await DSMD.imageTools.waitForUploadImages(step.container, 8000);
            if (DSMD.mermaid && document.querySelector('[class*="mermaid"]')) {
              await DSMD.mermaid.capture(document);
            }
            const part = DSMD.extractFromDom(document, {
              allowUserOnly: true, userOnlyScope: step.container, skipChronologyFix: true
            });
            part.virtualItemKeys = Array.from(step.container.querySelectorAll('[data-virtual-list-item-key]'),
              el => el.getAttribute('data-virtual-list-item-key'));
            part.imageLoad = load;
            if (!part.messages || !part.messages.length) {
              if (DSMD.imageTools.collectUploadImages(step.container).length) {
                throw new Error('当前屏幕有用户图片，但未识别到所属消息；已停止导出以避免静默漏图');
              }
              return;
            }
            // 滚动阶段不做耗时的原图抓取（会拖慢逐屏采集、触发加载稳定性超时）：
            // 本地数据（blob:/data:）立即转码；远程地址只做零成本的缩略图升级
            //（DeepSeek 的 ty=t 是 ~240px 预览变体，ty=p 才是原图），原图抓取
            // 统一放到滚动结束后的 convertAll。
            const localImages = (part.images || []).filter(r => !/^https?:/i.test(r.src || ''));
            if (localImages.length) {
              await DSMD.imageTools.convertAll(localImages, { concurrency: 4, cache: imageCache });
            }
            DSMD.imageTools.upgradeRecordUrls(part.images || []);
            if (capture) capture.add(part, step.position);
          }
        });
        restoreScroll = prep.restore || null;
        log('预加载：', {
          scrolled: prep.scrolled,
          reason: prep.reason || '',
          anchors: prep.anchors,
          messageRoots: prep.messageRoots,
          imageCount: prep.imageCount,
          uploadImages: prep.uploadCount,
          ready: prep.ready,
          broken: prep.broken,
          missing: prep.missing,
          pending: prep.pending,
          timedOut: prep.timedOut,
          deadlineHit: prep.deadlineHit
        });
        if (prep.uploadCount && prep.pending) {
          log(`仍有 ${prep.pending} 张上传图未完成加载，将在转换阶段重试并记录失败原因`);
        }
      }

      // 滚动加载完成后、消息解析前，把页面上已渲染的 Mermaid 图表本地栅格化为 PNG；
      // 之后正文里的源码块/SVG 会被替换为图片引用，三种格式都显示图形而非代码
      if (DSMD.mermaid) {
        setStatus('正在捕获 Mermaid 图表…', 'busy');
        try {
          const captured = await DSMD.mermaid.capture(document);
          const n = Array.isArray(captured) ? captured.length : (Number(captured) || 0);
          if (n) log(`已捕获 ${n} 张 Mermaid 图表`);
        } catch (e) {
          log('Mermaid 捕获失败（对话将按源码导出）：', e);
        }
      }

      let dom = DSMD.extractFromDom(document, {});
      dom.virtualItemKeys = Array.from(document.querySelectorAll('[data-virtual-list-item-key]'),
        el => el.getAttribute('data-virtual-list-item-key'));
      sampleRoots();
      // 最后一屏也必须在恢复滚动位置前处理；blob: 地址可能随节点回收而失效，
      // 本地数据立即转码，远程地址做零成本升级后由下方统一抓取原图。
      if (dom.images && dom.images.length && DSMD.imageTools) {
        const localFinal = dom.images.filter(r => !/^https?:/i.test(r.src || ''));
        if (localFinal.length) {
          await DSMD.imageTools.convertAll(localFinal, { concurrency: 4, cache: imageCache });
        }
        DSMD.imageTools.upgradeRecordUrls(dom.images);
      }
      if (capture && dom.messages && dom.messages.length) capture.add(dom, 'final');
      let mergedCapture = null;
      let seqTotal = 0;   // 全文总消息数 Y（绝对总数，不随导出范围改变）
      if (capture) {
        const merged = capture.result();
        mergedCapture = merged;
        // Y = 虚拟编号区间覆盖数 − 当前分支跳号数（= 当前分支的实际消息总数）；
        // 无编号对话退化为「本次采集到的消息数」
        const gd = merged.gapDetails;
        if (gd && gd.virtualRange && gd.virtualRange.length === 2) {
          seqTotal = (gd.virtualRange[1] - gd.virtualRange[0] + 1) -
            (gd.skippedVirtualKeys || []).length;
        }
        if (!seqTotal || seqTotal < merged.messages.length) {
          seqTotal = merged.messages.length;
        }
        lastCaptureSummary = {
          snapshots: merged.snapshots,
          messages: merged.messages.length,
          images: merged.images.length,
          gaps: merged.gaps,
          gapDetails: merged.gapDetails
        };
        log('逐屏采集：', { snapshots: merged.snapshots, messages: merged.messages.length,
          images: merged.images.length, gaps: merged.gaps,
          gapDetails: merged.gapDetails, scans: merged.scans });
        const rootsStayedMounted = !!(dom.ok && DSMD.longCapture.hasStableFullDom(
          rootSamples, dom.stats && dom.stats.pageUploads, merged.scans));
        if (merged.gaps && !rootsStayedMounted) {
          const detail = merged.gapDetails || {};
          const reasons = [];
          if (detail.missingVirtualKeys && detail.missingVirtualKeys.length) {
            reasons.push(`未采到编号 ${detail.missingVirtualKeys.join('、')}`);
          }
          if (detail.unnumberedSnapshots) reasons.push(`${detail.unnumberedSnapshots} 个快照缺少消息编号`);
          if (detail.overlapGaps) reasons.push(`${detail.overlapGaps} 处正文无法对齐`);
          throw new Error(`逐屏采集出现 ${merged.gaps} 处无法对齐的消息区间` +
            `${reasons.length ? `（${reasons.join('；')}）` : ''}，已停止导出以避免漏图`);
        }
        if (merged.gaps && rootsStayedMounted) {
          log('完整页面消息节点保持稳定；使用最终页面解析结果，忽略逐屏快照对齐误报');
        } else if (merged.ok && (merged.messages.length > (dom.messages || []).length ||
          merged.images.length > (dom.images || []).length)) dom = merged;
      }

      // 选择性导出：按编号区间校验并过滤（放在原图抓取之前——区间外的图片不下载）。
      // 完整性以 long-capture 的 missingVirtualKeys 为准：它基于「实际挂载的编号节点」
      // 计算，已经处理了分支跳号与附件气泡并回消息（合并后编号不再对应独立消息）两种情况。
      if (selectRange) {
        const missingInRange = ((mergedCapture && mergedCapture.gapDetails &&
          mergedCapture.gapDetails.missingVirtualKeys) || [])
          .filter(k => k >= selectRange.min && k <= selectRange.max);
        if (missingInRange.length) {
          throw new Error(`选中区间（编号 ${selectRange.min}–${selectRange.max}）有 ` +
            `${missingInRange.length} 条消息未采集到（编号：${missingInRange.join('、')}），` +
            '已停止导出以避免漏图');
        }
        const filtered = DSMD.longCapture.filterRange(dom.messages, selectRange);
        dom.messages = filtered.messages;
        if (dom.images && dom.images.length) {
          const keepIds = filtered.imageIds;
          dom.images = dom.images.filter(r => r.kind === 'mermaid' || keepIds.has(r.id));
        }
        if (!dom.messages.length) {
          throw new Error('选中区间内没有可导出的消息（该编号可能是已并入相邻消息的附件气泡）。');
        }
        log(`区间过滤：编号 ${selectRange.min}–${selectRange.max}，` +
          `消息 ${dom.messages.length} 条，图片 ${dom.images.length} 张`);
      }
      if (restoreScroll) { restoreScroll(); restoreScroll = null; }

      // 统一原图抓取：滚动阶段只做了零成本的地址升级（ty 缩略图→原图），
      // 现在对最终选定的图片集合一次性抓取（同图去重缓存，带进度显示）。
      // 这一步耗时较长（原图体积大），但不再受滚动采集的时间预算约束。
      if (dom.images && dom.images.length && DSMD.imageTools) {
        const pendingRemote = dom.images.filter(r => r.status !== 'embedded' && /^https?:/i.test(r.src || ''));
        if (pendingRemote.length) {
          await DSMD.imageTools.convertAll(pendingRemote, { concurrency: 4, cache: imageCache,
            onProgress: p => setStatus(`正在转换图片原图（清晰版） ${p.done}/${p.total}…`, 'busy') });
        }
      }
      imageCache.clear();
      log('页面通道：', dom.ok ? `${dom.messages.length} 条消息` : `失败（${dom.reason}）`, dom.diag || '');
      if (dom.stats && dom.stats.pageUploads) {
        log(`页面扫描：上传图 ${dom.stats.pageUploads} 张，已归入消息 ${dom.stats.images} 张，兜底补入 ${dom.stats.orphanBound || 0} 张，未能定位 ${dom.stats.unboundImages || 0} 张`);
      }

      // 页面侧图片已在逐屏采集时完成本地转码。
      const domImages = dom.images || [];
      if (domImages.length && DSMD.imageTools) {
        const ist = DSMD.imageTools.statsOf(domImages);
        log(`图片转换完成：内嵌 ${ist.embedded} / 需联网 ${ist.remote} / 失败 ${ist.failed}`);
      }

      // 失败清单：转换失败 / 跨域无法内嵌 / 未能定位所属消息的图片全部收集起来，
      // 后续无论导出哪种格式都统一提示，避免「提示成功但实际漏图」。
      let imageFailures = DSMD.imageTools ? DSMD.imageTools.failuresOf(domImages) : [];
      if (DSMD.imageTools) {
        const refs = new Set((dom.messages || []).flatMap(message =>
          DSMD.imageTools.refIdsOf(message.body || '')));
        for (const rec of domImages) {
          if (rec.kind === 'mermaid' || refs.has(rec.id) ||
            imageFailures.some(failure => failure.id === rec.id)) continue;
          imageFailures.push({ id: rec.id, alt: rec.alt || '', src: rec.src || '',
            role: rec.role || 'user', status: 'failed', reason: 'image-not-referenced-by-message' });
        }
      }
      if (Array.isArray(dom.unboundImages) && dom.unboundImages.length) {
        imageFailures = imageFailures.concat(dom.unboundImages.map((img, i) => ({
          id: `unbound-${i}`,
          alt: img.alt || '',
          src: img.src || '',
          role: 'unknown',
          status: 'failed',
          reason: 'unbound-image'
        })));
      }

      // 分支导出：先从页面提取结果算出「当前显示分支」的指纹。
      // 用户切到哪个分支，页面渲染的就是哪个分支，指纹即以它为准。
      const branchFingerprint = DSMD.apiExtractor.branchFingerprint
        ? DSMD.apiExtractor.branchFingerprint(dom.messages || [])
        : [];
      if (branchFingerprint.length) {
        log(`当前显示分支指纹：${branchFingerprint.length} 条消息`);
      }

      let api = null;
      if (!prefs.localOnly) {
        setStatus('正在与接口数据校验（按当前显示分支过滤）…', 'busy');
        api = await tryApiChannel(branchFingerprint);
        const bm = api.branchMatch;
        log('接口通道：',
          api.ok ? `${api.messages.length} 条消息` : `失败（${api.reason}：${api.error || ''}）`,
          bm ? `分支指纹命中 ${bm.matched}/${bm.fingerprintSize}（${bm.strategy}）` : '');
      } else {
        log('已选择「仅使用页面内容」，跳过接口校验');
      }

      let chosen = chooseSource(dom, api);
      if (!chosen) {
        const why = [
          dom && dom.error ? `页面：${dom.error}` : '',
          prefs.localOnly ? '' : (api && api.error ? `接口：${api.error}` : '')
        ].filter(Boolean).join('；');
        setStatus(`未能取到对话正文。${why || '请确认已打开某个对话并等待加载完成。'} 可点击「诊断」下载诊断报告。`, 'error');
        if (imageFailures.length) showImageWarning(imageFailures, { alert: true });
        return;
      }

      // 选择性导出强制页面通道：接口消息没有虚拟编号，无法按编号区间过滤；
      // 区间完整性已在上方按页面采集结果校验过，dom 通道即完整。
      if (selectRange && chosen.source === 'api') {
        chosen = {
          source: 'dom',
          label: '当前页面（显示中的分支）',
          messages: dom.messages,
          note: '选中区间导出，已跳过接口数据'
        };
        log('区间导出：接口消息无编号，已改用页面采集结果');
      }

      // 接口有更多消息却没有相应页面节点时，无法证明那些轮次没有上传图。
      // 不生成一份看似成功、实际可能少图的文件。
      if (chosen.source === 'api' && (!dom.ok ||
        chosen.messages.length > dom.messages.length)) {
        setStatus(`接口有 ${chosen.messages.length} 条消息，逐屏页面仅采集到 ${(dom.messages || []).length} 条；图片完整性无法确认，已停止导出。`, 'error');
        if (imageFailures.length) showImageWarning(imageFailures, { alert: true });
        return;
      }

      // 数据源选了接口通道时，把页面侧收集到的图片按用户轮次贴回接口消息；
      // 接口正文里的 ```mermaid 围栏按源码匹配换成已捕获的图片引用
      let images = domImages;
      if (chosen.source === 'api' && domImages.length && DSMD.imageTools) {
        images = DSMD.imageTools.attachToApiMessages(chosen.messages, dom.messages, domImages);
      }
      if (chosen.source === 'api' && DSMD.mermaid) {
        DSMD.mermaid.embedIntoMessages(chosen.messages);
      }
      // 接口通道下未能贴回任何用户消息的图片，同样纳入失败清单
      if (Array.isArray(images.attachFailures) && images.attachFailures.length) {
        imageFailures = imageFailures.concat(images.attachFailures);
      }
      reportImageFailures(imageFailures);

      const title = (api && api.ok && api.title) || pageTitle() || firstUserLine(chosen.messages) || 'DeepSeek 对话';
      const sessionId = currentSessionId();
      const format = currentFormat();

      // 三条导出通道都以同一份「时序已校正、思考过程已按勾选过滤」的消息为输入，
      // 因此 Markdown / PDF / Word 的内容与顺序完全一致；图片引用随正文一起解析。
      const prepared = prepareMessages(chosen.messages, prefs.excludeThinking);
      if (!prepared.messages.length) {
        setStatus(`解析到 ${chosen.messages.length} 条消息，但过滤后没有可写出的正文。请点击「诊断」下载报告。`, 'error');
        if (imageFailures.length) showImageWarning(imageFailures, { alert: true });
        return;
      }

      if (format === 'pdf') {
        // PDF：排好 A4 分页（每页页脚「第 X 页 共 Y 页」）后调用打印引擎输出
        const name = withRangeTag(DSMD.buildFilename(title, sessionId, new Date(), 'pdf'), selectRange);
        const result = await DSMD.pdf.exportPdf({
          title,
          messages: prepared.messages,
          excludeThinking: prefs.excludeThinking,
          images,
          seqTotal,
          filename: name.base
        });
        if (!result.printed) {
          setStatus('无法自动打开打印窗口（可能被浏览器拦截）。请再次点击「导出」重试。', 'error');
          if (imageFailures.length) showImageWarning(imageFailures, { alert: true });
          return;
        }
        setStatus(
          `已排版 ${result.pages} 页，打印窗口已打开\n` +
          `① 目标选择「另存为 PDF」  ② 关闭「页眉和页脚」  ③ 保存\n` +
          `文件名建议：${name.name}\n` +
          `页脚已含「第 X 页 共 Y 页」；需要保留代码块底色请勾选「背景图形」\n` +
          `内容来源：${chosen.label}，共 ${prepared.stats.turns} 条消息` +
          imageSummary(images),
          'ok'
        );
        if (imageFailures.length) showImageWarning(imageFailures, { alert: true });
        log('PDF 排版完成：', result.pages, '页', name.name);
        return;
      }

      if (format === 'docx') {
        // Word：本地生成 OOXML 包（zip + XML），页脚用 PAGE / NUMPAGES 域输出页码；
        // 用户上传图片作为 word/media 部件内嵌，长图先切割再逐条插入
        const bytes = await DSMD.docx.buildDocx({
          title,
          messages: prepared.messages,
          excludeThinking: prefs.excludeThinking,
          images,
          seqTotal
        });
        const name = withRangeTag(DSMD.buildFilename(title, sessionId, new Date(), 'docx'), selectRange);
        downloadBlob(bytes, name.name,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        setStatus(
          `已导出 ${name.name}\n` +
          `消息 ${prepared.stats.turns} 条（用户 ${prepared.stats.userCount} / DeepSeek ${prepared.stats.assistantCount}）\n` +
          `页脚为「第 X 页 共 Y 页」，打开文档即自动更新\n` +
          `内容来源：${chosen.label}` +
          imageSummary(images) +
          (prepared.stats.droppedCount ? `\n已跳过 ${prepared.stats.droppedCount} 条空内容或重复消息` : ''),
          'ok'
        );
        if (imageFailures.length) showImageWarning(imageFailures, { alert: true });
        log('Word 导出完成：', name.name, bytes.length, '字节');
        return;
      }

      // Markdown：原有通道保持不变；图片默认 base64 内嵌，总量超限时自动打包 .zip
      const imageMode = DSMD.imageTools ? DSMD.imageTools.embedModeFor(images) : 'embed';
      const built = DSMD.buildMarkdown({
        title,
        messages: prepared.messages,
        excludeThinking: prefs.excludeThinking,
        images,
        imageMode,
        seqTotal
      });

      if (!built.ok) {
        setStatus(`解析到 ${chosen.messages.length} 条消息，但没有取到任何正文（${built.reason}）。请点击「诊断」下载报告，或向上滚动让消息完整渲染后重试。`, 'error');
        log('构建失败：', built);
        if (imageFailures.length) showImageWarning(imageFailures, { alert: true });
        return;
      }

      const filename = withRangeTag(DSMD.buildFilename(title, sessionId, new Date(), 'md'), selectRange);
      let outName = filename.name;
      let outNote = '';

      const embeddedCount = built.imageStats ? built.imageStats.embedded : 0;
      if (imageMode === 'zip' && embeddedCount > 0) {
        // 打包 .zip：conversation.md + images/user-00N.png，Markdown 里相对路径引用
        const entries = [{ name: 'conversation.md', data: built.markdown }];
        for (const rec of built.usedImages) {
          if (rec.status !== 'embedded' || !rec.b64) continue;
          entries.push({ name: `images/${rec.filename}`, data: DSMD.zip.base64Decode(rec.b64) });
        }
        const zipName = withRangeTag(DSMD.buildFilename(title, sessionId, new Date(), 'zip'), selectRange);
        downloadBlob(DSMD.zip.zipStore(entries), zipName.name, 'application/zip');
        outName = zipName.name;
        outNote = `\n图片较多，已打包为 .zip（conversation.md + images/ 共 ${embeddedCount} 张）`;
      } else {
        downloadText(built.markdown, filename.name, 'text/markdown');
      }

      const s = built.stats;
      setStatus(
        `已导出 ${outName}\n` +
        `消息 ${s.turns} 条（用户 ${s.userCount} / DeepSeek ${s.assistantCount}），正文 ${s.bodyChars} 字\n` +
        `内容来源：${chosen.label}` +
        (chosen.note ? `（${chosen.note}）` : '') +
        imageSummary(images) +
        outNote +
        (s.droppedCount ? `\n已跳过 ${s.droppedCount} 条空内容或重复消息` : ''),
        'ok'
      );
      if (imageFailures.length) showImageWarning(imageFailures, { alert: true });
      log('导出完成：', outName, s);
    } catch (e) {
      log('导出异常：', e);
      setStatus(`导出失败：${(e && e.message) || e}`, 'error');
    } finally {
      if (restoreScroll) {
        try { restoreScroll(); } catch (e) { /* 忽略 */ }
      }
      busy = false;
      els.exportBtn.disabled = false;
    }
  }

  /* ------------------------------ 图片失败提示 ------------------------------ */

  function safeDiagnosticUrl(value) {
    const url = String(value || '');
    if (/^(data:|blob:)/i.test(url)) return '<REDACTED>';
    return url.replace(/[?#].*$/, '');
  }

  /**
   * 控制台失败清单 + 面板红色提示。
   * 必须在导出结果里可见：只报「导出成功」但少图，是这次要根治的静默失败。
   */
  function reportImageFailures(failures) {
    const list = Array.isArray(failures) ? failures : [];
    if (!list.length) return 0;
    const roleLabel = role => role === 'assistant' ? 'assistant（模型）'
      : role === 'unknown' ? 'unknown（未能定位所属消息）' : 'user（用户）';
    const details = list.map((f, i) => ({
      index: i + 1,
      alt: f.alt || '(无 alt)',
      src: safeDiagnosticUrl(f.src) || '(无地址)',
      role: roleLabel(f.role),
      status: f.status,
      reason: f.reason || ''
    }));
    try {
      console.warn(`${LOG} ${list.length} 张用户图片未能导出：`, details);
      if (console.table) console.table(details);
    } catch (e) { /* 忽略控制台限制 */ }
    els.warning.hidden = false;
    els.warning.textContent = `⚠ ${list.length} 张用户图片未能导出（详见浏览器控制台）`;
    return list.length;
  }

  function hideImageWarning() {
    if (!els || !els.warning) return;
    els.warning.hidden = true;
    els.warning.textContent = '';
  }

  function showImageWarning(failures, options) {
    const list = Array.isArray(failures) ? failures : [];
    if (!list.length) return;
    const opts = options || {};
    // 转换阶段已经 report 过一次时不再重复刷控制台
    if (!els.warning || els.warning.hidden) reportImageFailures(list);
    if (opts.alert === false) return;
    // 「弹出提示」：导出结束（含 PDF 打印窗口打开后）明确告诉用户少了图，
    // 不让用户以为文件是完整的。控制台里有 alt / 脱敏地址 / 所属消息角色清单。
    try {
      window.alert(`${list.length} 张用户图片未能导出。\n` +
        '失败清单已输出到浏览器控制台（含 alt、脱敏图片地址、所属消息角色）。\n' +
        'Markdown 中跨域图片会保留原地址；PDF / Word 中会显示占位提示。');
    } catch (e) { /* 某些页面禁止 alert 时仍保留面板提示 */ }
  }

  function firstUserLine(messages) {
    const first = (messages || []).find(m => m.role === 'user' && m.body);
    if (!first) return '';
    const line = (first.body.split('\n').find(l => l.trim()) || '')
      .replace(/!\[[^\]]*\]\(dsmd-img:\/\/\d+\)/g, '')
      .replace(/\\+$/g, '')
      .trim();
    return line.slice(0, 40);
  }

  /**
   * 三种格式共用的内容预处理：同一套过滤与校验规则，
   * 保证 Markdown / PDF / Word 三者内容一致（含「排除思考过程」与空轮次处理）。
   */
  function prepareMessages(messages, excludeThinking) {
    const validated = DSMD.validateMessages(messages, { excludeThinking });
    return {
      messages: validated.messages.map(m => ({
        role: m.role,
        body: m.body,
        thinking: excludeThinking ? '' : m.thinking,
        extras: excludeThinking ? [] : m.extras,
        branchNo: m.branchNo || '',
        virtualKey: m.virtualKey || ''
      })),
      stats: {
        turns: validated.messages.length,
        userCount: validated.messages.filter(m => m.role === 'user').length,
        assistantCount: validated.messages.filter(m => m.role !== 'user').length,
        droppedCount: validated.dropped.length
      }
    };
  }

  function currentFormat() {
    const checked = els.formatInputs.find(input => input.checked);
    return checked ? checked.value : 'markdown';
  }

  /* --------------------------------- 下载实现 -------------------------------- */

  function downloadBlob(data, filename, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 2000);
  }

  function downloadText(text, filename, mime) {
    downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename, mime);
  }

  /* --------------------------------- 诊断报告 -------------------------------- */

  async function runDiagnostics() {
    setStatus('正在收集诊断信息…', 'busy');
    if (DSMD.mermaid) {
      try { await DSMD.mermaid.capture(document); } catch (e) { /* 忽略 */ }
    }
    const dom = DSMD.extractFromDom(document, {});
    const branchFingerprint = DSMD.apiExtractor.branchFingerprint
      ? DSMD.apiExtractor.branchFingerprint(dom.messages || [])
      : [];
    let api = null;
    if (!els.localOnly.checked) api = await tryApiChannel(branchFingerprint);

    const report = {
      generatedAt: new Date().toISOString(),
      page: { url: location.href, title: document.title, sessionId: currentSessionId(), hasToken: !!authToken() },
      domChannel: {
        ok: !!dom.ok, reason: dom.reason || '', error: dom.error || '',
        stats: dom.stats || null, warn: dom.warn || [], diag: dom.diag || null,
        mermaidCaptured: DSMD.mermaid ? DSMD.mermaid.count() : 0,
        images: DSMD.imageTools ? DSMD.imageTools.statsOf(dom.images) : { total: (dom.images || []).length },
        imageFailures: DSMD.imageTools ? DSMD.imageTools.failuresOf(dom.images) : [],
        coverage: dom.coverage || null,
        unboundImages: dom.unboundImages || [],
        // 页面图片扫描结果：区分「识别为上传图」与「被过滤」，用于定位上传图导出失败
        imageScan: (DSMD.imageTools && DSMD.imageTools.diagnose) ? DSMD.imageTools.diagnose(document) : null,
        branchFingerprintSize: branchFingerprint.length,
        sample: (dom.messages || []).slice(0, 2).map(m => ({ role: m.role, bodyPreview: (m.body || '').slice(0, 200), thinkingLen: (m.thinking || '').length }))
      },
      capture: lastCaptureSummary,
      apiChannel: api ? {
        ok: !!api.ok, reason: api.reason || '', error: api.error || '',
        messageCount: (api.messages || []).length,
        branchMatch: api.branchMatch || null,
        warn: api.warn || [],
        sample: (api.messages || []).slice(0, 2).map(m => ({ role: m.role, bodyPreview: (m.body || '').slice(0, 200), thinkingLen: (m.thinking || '').length })),
        rawShape: api.json ? shapeOf(api.json) : null
      } : { skipped: true },
      extension: { version: chrome.runtime.getManifest().version, permissions: 'none' }
    };

    const name = `deepseek-export-diagnostic_${Date.now()}.json`;
    // 图片地址常带临时签名参数；诊断文件可能被分享，不能写入这些参数或正文预览。
    const diagnosticReplacer = (key, value) => {
      if (key === 'preview' || key === 'bodyPreview') return `<REDACTED: ${String(value || '').length} chars>`;
      if (key === 'src' || key === 'url') return safeDiagnosticUrl(value);
      return value;
    };
    downloadText(JSON.stringify(report, diagnosticReplacer, 2), name, 'application/json');
    setStatus(`已生成诊断报告 ${name}\n可据此定位页面结构或接口字段的变化。`, 'ok');
  }

  // 只描述结构，不复制正文内容
  function shapeOf(obj, depth = 0) {
    if (depth > 4 || obj == null) return typeof obj;
    if (Array.isArray(obj)) return obj.length ? [shapeOf(obj[0], depth + 1)] : [];
    if (typeof obj === 'object') {
      const out = {};
      for (const k of Object.keys(obj)) out[k] = shapeOf(obj[k], depth + 1);
      return out;
    }
    return typeof obj;
  }

  /* ----------------------------------- 界面 ----------------------------------- */

  const ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>';

  function buildUi() {
    host = document.createElement('div');
    host.className = 'dsmd-root';
    host.setAttribute('data-dsmd', 'root');

    const fab = document.createElement('button');
    fab.className = 'dsmd-fab';
    fab.type = 'button';
    fab.title = '导出当前对话为 Markdown';
    fab.setAttribute('data-dsmd', 'fab');
    fab.innerHTML = ICON_SVG + '<span>导出 MD</span>';

    const panel = document.createElement('div');
    panel.className = 'dsmd-panel dsmd-hidden';
    panel.setAttribute('data-dsmd', 'panel');
    panel.innerHTML = [
      '<div class="dsmd-head"><strong>导出 DeepSeek 对话</strong><button type="button" class="dsmd-close" data-dsmd="close" title="关闭">×</button></div>',
      '<div class="dsmd-field"><span class="dsmd-field-label">导出格式</span>',
      '<div class="dsmd-formats">',
      '<label class="dsmd-format"><input type="radio" name="dsmd-format" value="markdown" data-dsmd="fmt-markdown"><span>Markdown</span></label>',
      '<label class="dsmd-format"><input type="radio" name="dsmd-format" value="pdf" data-dsmd="fmt-pdf"><span>PDF</span></label>',
      '<label class="dsmd-format"><input type="radio" name="dsmd-format" value="docx" data-dsmd="fmt-docx"><span>Word</span></label>',
      '</div></div>',
      '<label class="dsmd-row"><input type="checkbox" data-dsmd="exclude"><span>排除所有思考过程</span></label>',
      '<label class="dsmd-row"><input type="checkbox" data-dsmd="local"><span>仅使用页面内容（不发送任何网络请求）</span></label>',
      '<div class="dsmd-actions"><button type="button" class="dsmd-ghost" data-dsmd="select">选择消息</button>' +
      '<button type="button" class="dsmd-primary" data-dsmd="export">导出</button><button type="button" class="dsmd-ghost" data-dsmd="diag">诊断</button></div>',
      '<div class="dsmd-status" data-dsmd="status">选择格式与选项后点击导出</div>',
      '<div class="dsmd-warning" data-dsmd="warning" hidden></div>',
      '<div class="dsmd-note">文件在本机生成，不上传任何数据。</div>'
    ].join('');

    host.appendChild(panel);
    host.appendChild(fab);
    (document.body || document.documentElement).appendChild(host);

    els = {
      fab,
      panel,
      closeBtn: panel.querySelector('[data-dsmd="close"]'),
      excludeThinking: panel.querySelector('[data-dsmd="exclude"]'),
      localOnly: panel.querySelector('[data-dsmd="local"]'),
      exportBtn: panel.querySelector('[data-dsmd="export"]'),
      diagBtn: panel.querySelector('[data-dsmd="diag"]'),
      selectBtn: panel.querySelector('[data-dsmd="select"]'),
      status: panel.querySelector('[data-dsmd="status"]'),
      warning: panel.querySelector('[data-dsmd="warning"]'),
      formatInputs: Array.from(panel.querySelectorAll('input[name="dsmd-format"]'))
    };

    const prefs = loadPrefs();
    els.excludeThinking.checked = prefs.excludeThinking;
    els.localOnly.checked = prefs.localOnly;
    const selected = els.formatInputs.find(i => i.value === prefs.format) ||
      els.formatInputs.find(i => i.value === 'markdown');
    if (selected) selected.checked = true;

    els.fab.addEventListener('click', togglePanel);
    els.closeBtn.addEventListener('click', () => setPanelOpen(false));
    els.exportBtn.addEventListener('click', runExport);
    els.diagBtn.addEventListener('click', runDiagnostics);
    els.selectBtn.addEventListener('click', toggleSelectMode);
    els.excludeThinking.addEventListener('change', persistPrefs);
    els.localOnly.addEventListener('change', persistPrefs);
    els.formatInputs.forEach(input => input.addEventListener('change', persistPrefs));

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !panel.classList.contains('dsmd-hidden')) setPanelOpen(false);
    }, true);
  }

  function persistPrefs() {
    savePrefs({
      excludeThinking: els.excludeThinking.checked,
      localOnly: els.localOnly.checked,
      format: currentFormat()
    });
  }

  function togglePanel() {
    setPanelOpen(els.panel.classList.contains('dsmd-hidden'));
  }

  // 选择性导出模式开关：开启后在每条消息旁注入复选框（select-ui 负责），
  // 再点「导出」即导出选中区间（单条 = [k, k]）。关闭时彻底清理注入 UI。
  function toggleSelectMode() {
    if (busy) return;
    if (DSMD.selectUI && DSMD.selectUI.isActive()) {
      DSMD.selectUI.stop();
      els.selectBtn.textContent = '选择消息';
      setStatus('已退出选择模式。', 'ok');
      return;
    }
    if (!DSMD.selectUI) {
      setStatus('选择性导出模块未加载。', 'error');
      return;
    }
    const r = DSMD.selectUI.start({
      onExport: () => { if (!busy) runExport(); },
      onChange: count => {
        els.selectBtn.textContent = count ? `已选 ${count} 条` : '选择消息';
      }
    });
    if (!r.ok) {
      setStatus(r.reason === 'no-keys'
        ? '当前对话没有消息编号（虚拟列表未启用），不支持选择性导出；可直接全量导出。'
        : '无法开启选择模式。', 'error');
      return;
    }
    els.selectBtn.textContent = '退出选择';
    setStatus('选择模式已开启：勾选消息后点「导出选中区间」或「导出」。\n' +
      '勾选 2 条以上时导出两点之间的全部消息（含中间未勾选的）。', 'ok');
  }

  function setPanelOpen(open) {
    els.panel.classList.toggle('dsmd-hidden', !open);
    els.fab.classList.toggle('dsmd-fab-active', open);
  }

  function setStatus(text, state) {
    els.status.textContent = text;
    els.status.className = 'dsmd-status dsmd-status-' + (state || 'idle');
  }

  function log(...args) {
    try { console.log(LOG, ...args); } catch (e) { /* 忽略 */ }
  }

  // 页面路由切换、React 重渲染都可能摘掉我们的节点，这里做轻量看护（纯本地操作）
  function keepMounted() {
    if (!host || !host.isConnected) {
      (document.body || document.documentElement).appendChild(host);
    }
  }

  function mount() {
    buildUi();
    setInterval(keepMounted, 2000);
    log('已注入，点击右下角「导出 MD」按钮使用');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
