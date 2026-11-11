/** 滚动时保存消息和已转码图片；只处理本页数据。 */
(() => {
  'use strict';
  const DSMD = (globalThis.__DSMD__ || (globalThis.__DSMD__ = {}));
  const REF = /!\[[^\]]*\]\(dsmd-img:\/\/(\d+)\)/g;

  function refs(text) {
    return Array.from(String(text || '').matchAll(REF), match => Number(match[1]));
  }

  function fields(message) {
    return ['body', 'thinking'].concat((message.extras || []).map((_, i) => `extra:${i}`));
  }

  function fieldValue(message, field) {
    return field.startsWith('extra:')
      ? String((message.extras[Number(field.slice(6))] || {}).text || '')
      : String(message[field] || '');
  }

  function setField(message, field, value) {
    if (field.startsWith('extra:')) message.extras[Number(field.slice(6))].text = value;
    else message[field] = value;
  }

  function imageIds(message) {
    return fields(message).flatMap(field => refs(fieldValue(message, field)));
  }

  // 纯内容签名（不含虚拟编号）：虚拟列表瞬时重渲染的快照缺编号时，
  // 用它把快照消息与已归并消息做内容比对，判断是否只是重复渲染。
  function contentKey(message, imageById) {
    const clean = value => String(value || '').replace(REF, '').replace(/\s+/g, ' ').trim();
    const body = clean(message.body);
    const thinking = clean(message.thinking);
    const signatures = !body && !thinking ? imageIds(message).map(id => {
      const image = imageById.get(id);
      return image ? `${image.kind === 'mermaid' ? image.source || '' : ''}|${image.alt || ''}` : '?';
    }).join(';') : '';
    return JSON.stringify([message.role, body, thinking, message.branchNo || '', signatures]);
  }

  function messageKey(message, imageById) {
    if (message.virtualKey) return JSON.stringify(['virtual', message.virtualKey, message.role]);
    return contentKey(message, imageById);
  }

  // 文本匹配：完全一致，或长文本的前缀（流式输出中先采到半成品、后采到全文）。
  // 短文本（<8 字符）必须完全一致，避免无意义的公共前缀误判。
  function textMatches(a, b) {
    if (a === b) return true;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    return shorter.length >= 8 && longer.startsWith(shorter);
  }

  function imageSignatureOf(message, imageById) {
    return imageIds(message).map(id => {
      const image = imageById.get(id);
      return image ? `${image.kind === 'mermaid' ? image.source || '' : ''}|${image.alt || ''}` : '?';
    }).join(';');
  }

  // 缺编号快照消息与已归并消息是否同一内容。流式渲染期间正文 / 思考可能只输出了一半：
  // 某字段一侧为空视为「尚未输出到该字段」；两侧都有值时按前缀容差比对。
  function contentMatches(incoming, incomingById, stored, storedById) {
    if (String(incoming.role || '') !== String(stored.role || '')) return false;
    const clean = value => String(value || '').replace(REF, '').replace(/\s+/g, ' ').trim();
    const incBody = clean(incoming.body);
    const storedBody = clean(stored.body);
    const incThink = clean(incoming.thinking);
    const storedThink = clean(stored.thinking);
    if (!incBody && !incThink) {
      // 图片 / 附件消息：没有正文字段可比，按图片签名精确比对
      return imageSignatureOf(incoming, incomingById) === imageSignatureOf(stored, storedById);
    }
    const bodyOk = incBody === '' || storedBody === '' || textMatches(incBody, storedBody);
    const thinkOk = incThink === '' || storedThink === '' || textMatches(incThink, storedThink);
    return bodyOk && thinkOk;
  }

  function hasStableFullDom(samples, finalUploads, scans) {
    if (!samples || !samples.length) return false;
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first.first || !first.last || !first.count) return false;
    if (last.count < Math.max(...samples.map(sample => sample.count))) return false;
    if ((finalUploads || 0) < Math.max(0, ...(scans || []).map(scan => scan.pageUploads || 0))) return false;
    return samples.every(sample => sample.first && sample.last &&
      sample.first.node === first.first.node && sample.first.text === first.first.text &&
      sample.last.node === first.last.node && sample.last.text === first.last.text);
  }

  function create() {
    const messages = [];
    const images = [];
    const keys = [];
    const unboundImages = [];
    const scans = [];
    const virtualItems = new Map();
    const seenVirtualKeys = new Set();
    const skippedVirtualKeys = new Set();
    const pendingUnnumbered = [];
    let virtualMode = null;
    let gaps = 0;
    let unnumberedSnapshots = 0;
    let snapshots = 0;

    function addImage(record) {
      const id = images.length;
      images.push(Object.assign({}, record, { id, el: null }));
      return id;
    }

    function copyMessage(message, byId, existing) {
      const copy = {
        role: message.role,
        body: String(message.body || ''),
        thinking: String(message.thinking || ''),
        extras: (message.extras || []).map(item => Object.assign({}, item)),
        branchNo: message.branchNo || '',
        virtualKey: message.virtualKey || '',
        label: message.label || 'dom'
      };
      const oldIds = existing ? imageIds(existing) : [];
      let ordinal = 0;
      for (const field of fields(copy)) {
        setField(copy, field, fieldValue(copy, field).replace(REF, (token, localId) => {
          const next = byId.get(Number(localId));
          if (!next) return token;
          const old = images[oldIds[ordinal++]];
          let id;
          if (old && old.kind === next.kind) {
            id = old.id;
            // 升级条件：新记录能补齐旧记录缺的数据，或内嵌像素更多
            //（懒加载时同一张图可能先采到 ~240px 缩略图、后采到原图，保留原图）。
            const better = (old.status !== 'embedded' && next.status === 'embedded') ||
              (!old.src && next.src) ||
              (next.status === 'embedded' &&
                (Number(next.width) || 0) * (Number(next.height) || 0) >
                (Number(old.width) || 0) * (Number(old.height) || 0));
            if (better) {
              images[id] = Object.assign({}, next, { id, el: null });
            }
          } else {
            id = addImage(next);
          }
          return token.replace(/dsmd-img:\/\/\d+/, `dsmd-img://${id}`);
        }));
      }
      return copy;
    }

    function overlap(nextKeys) {
      let best = { start: 0, nextStart: 0, length: 0 };
      for (let i = 0; i < keys.length; i++) {
        for (let j = 0; j < nextKeys.length; j++) {
          let length = 0;
          while (i + length < keys.length && j + length < nextKeys.length &&
            keys[i + length] === nextKeys[j + length]) length++;
          if (length > best.length || (length === best.length && i + length === keys.length)) {
            best = { start: i, nextStart: j, length };
          }
        }
      }
      return best;
    }

    function add(snapshot, position) {
      if (!snapshot || !Array.isArray(snapshot.messages) || !snapshot.messages.length) return false;
      snapshots++;
      const byId = new Map((snapshot.images || []).map(image => [image.id, image]));
      const numbered = snapshot.messages.every(message => /^\d+$/.test(message.virtualKey || ''));
      if (virtualMode === null) virtualMode = numbered;
      if (virtualMode) {
        // 缺编号快照（新消息挂载、重渲染的瞬间）：先挂起，result() 时与最终
        // 归并结果做内容比对——全部对得上只是重复渲染，不算漏采；对不上才算漏采。
        if (!numbered) pendingUnnumbered.push(snapshot);
        const numberedMessages = snapshot.messages.filter(message =>
          /^\d+$/.test(message.virtualKey || ''));
        if (numberedMessages.length) {
          const ordinals = new Map();
          for (const message of numberedMessages) {
            const base = `${message.virtualKey}:${message.role}`;
            const ordinal = ordinals.get(base) || 0;
            ordinals.set(base, ordinal + 1);
            const key = `${base}:${ordinal}`;
            const old = virtualItems.get(key);
            const fresh = copyMessage(message, byId, old);
            if (!old || imageIds(fresh).length > imageIds(old).length ||
              (imageIds(fresh).length === imageIds(old).length &&
                fresh.body.length + fresh.thinking.length > old.body.length + old.thinking.length)) {
              virtualItems.set(key, fresh);
            }
          }
        }
        const mountedKeys = snapshot.virtualItemKeys || snapshot.messages.map(message => message.virtualKey);
        let previous = null;
        for (const key of mountedKeys) {
          if (!/^\d+$/.test(String(key))) continue;
          const current = Number(key);
          seenVirtualKeys.add(current);
          // 同一快照里相邻挂载项直接从 A 跳到 B，说明中间编号不在当前分支。
          // 不同快照之间的缺号仍视为漏采，不能据此推断跳号。
          if (previous !== null && current > previous + 1) {
            for (let absent = previous + 1; absent < current; absent++) skippedVirtualKeys.add(absent);
          }
          previous = current;
        }
        unboundImages.push(...(snapshot.unboundImages || []));
        scans.push(Object.assign({ position: position || '' }, snapshot.stats || {}, snapshot.imageLoad || {}, {
          mountedMessages: snapshot.messages.length,
          mountedImages: (snapshot.images || []).filter(image => image.kind !== 'mermaid').length
        }));
        return true;
      }
      const nextKeys = snapshot.messages.map(message => messageKey(message, byId));
      const match = overlap(nextKeys);
      if (keys.length && !match.length) gaps++;

      // 同一屏的重叠消息复用原图片记录；新消息才追加。扫描按页面从上到下进行。
      if (match.length) {
        for (let k = 0; k < match.length; k++) {
          const at = match.start + k;
          const fresh = copyMessage(snapshot.messages[match.nextStart + k], byId, messages[at]);
          if (imageIds(fresh).length > imageIds(messages[at]).length) messages[at] = fresh;
        }
      }
      const prefix = match.length ? snapshot.messages.slice(0, match.nextStart) : [];
      if (prefix.length) {
        if (match.start !== 0) gaps++;
        const copied = prefix.map(message => copyMessage(message, byId));
        messages.unshift(...copied);
        keys.unshift(...nextKeys.slice(0, match.nextStart));
      }
      const from = match.length ? match.nextStart + match.length : 0;
      const tail = snapshot.messages.slice(from);
      if (tail.length && match.length && match.start + match.length < keys.length) {
        // 已有序列中间出现无法对齐的新消息，不能假装采集完整。
        gaps++;
      }
      for (let i = 0; i < tail.length; i++) {
        messages.push(copyMessage(tail[i], byId));
        keys.push(nextKeys[from + i]);
      }
      unboundImages.push(...(snapshot.unboundImages || []));
      scans.push(Object.assign({ position: position || '' }, snapshot.stats || {}, snapshot.imageLoad || {}, {
        mountedMessages: snapshot.messages.length,
        mountedImages: (snapshot.images || []).filter(image => image.kind !== 'mermaid').length
      }));
      return true;
    }

    function result() {
      if (virtualMode) {
        messages.length = 0;
        for (const [key, message] of Array.from(virtualItems).sort((a, b) => {
          const [aNo, , aOrdinal] = a[0].split(':');
          const [bNo, , bOrdinal] = b[0].split(':');
          return Number(aNo) - Number(bNo) || Number(aOrdinal) - Number(bOrdinal);
        })) messages.push(message);
      }
      // 挂起的缺编号快照：与最终归并结果逐条内容比对。此时编号消息已全部归并，
      // 流式输出的半成品正文能与完整版做前缀匹配；最终找不到的消息才判定为漏采。
      for (const snapshot of pendingUnnumbered) {
        const byId = new Map((snapshot.images || []).map(image => [image.id, image]));
        const byIdGlobal = new Map(images.map(image => [image.id, image]));
        const stored = Array.from(virtualItems.values());
        const unmatched = snapshot.messages.filter(message =>
          !/^\d+$/.test(message.virtualKey || '') &&
          !stored.some(storedMessage => contentMatches(message, byId, storedMessage, byIdGlobal)));
        if (unmatched.length) { gaps++; unnumberedSnapshots++; }
      }
      const missingVirtualKeys = [];
      let virtualRange = null;
      if (virtualMode && seenVirtualKeys.size) {
        const min = Math.min(...seenVirtualKeys);
        const max = Math.max(...seenVirtualKeys);
        virtualRange = [min, max];
        for (let key = min; key <= max; key++) {
          if (!seenVirtualKeys.has(key) && !skippedVirtualKeys.has(key)) missingVirtualKeys.push(key);
        }
      }
      let userNo = 0;
      let mermaidNo = 0;
      for (const image of images) {
        if (image.kind === 'mermaid') {
          image.filename = `mermaid-${String(++mermaidNo).padStart(3, '0')}.${image.ext || 'png'}`;
        } else if (image.status === 'embedded') {
          image.filename = `user-${String(++userNo).padStart(3, '0')}.${image.ext || 'png'}`;
        }
      }
      const accounted = new Set(images.filter(image => image.kind !== 'mermaid' && image.src)
        .map(image => `${image.src}\n${image.alt || ''}`));
      const unresolved = unboundImages.filter(image =>
        !image.src || !accounted.has(`${image.src}\n${image.alt || ''}`));
      return {
        ok: messages.length > 0 && gaps + missingVirtualKeys.length === 0,
        messages, images, unboundImages: unresolved, scans,
        gaps: gaps + missingVirtualKeys.length, snapshots,
        gapDetails: {
          mode: virtualMode ? 'virtual-list' : 'text-overlap',
          virtualRange,
          missingVirtualKeys,
          skippedVirtualKeys: Array.from(skippedVirtualKeys).sort((a, b) => a - b),
          unnumberedSnapshots,
          overlapGaps: gaps - unnumberedSnapshots
        },
        stats: {
          turns: messages.length,
          images: images.filter(image => image.kind !== 'mermaid').length,
          unboundImages: unresolved.length,
          pageUploads: Math.max(0, ...scans.map(scan => scan.pageUploads || 0))
        }
      };
    }

    return { add, result };
  }

  /* ------------------------- 选择性导出：编号区间过滤 ------------------------- */

  function messageKeyNo(message) {
    const m = /^(\d+)$/.exec(String(message && message.virtualKey || ''));
    return m ? Number(m[1]) : null;
  }

  /**
   * 区间完整性校验：[min, max] 内每个编号要么已采集到，要么属于当前分支的跳号
   *（skippedVirtualKeys，本就不在当前分支），否则视为缺漏，导出必须停止。
   */
  function checkRange(messages, range, merged) {
    const present = new Set();
    for (const m of messages || []) {
      const n = messageKeyNo(m);
      if (n != null) present.add(n);
    }
    const skipped = new Set((((merged && merged.gapDetails &&
      merged.gapDetails.skippedVirtualKeys) || [])).map(Number));
    const missing = [];
    const min = Math.max(1, Number(range && range.min) || 1);
    const max = Number(range && range.max) || min;
    for (let k = min; k <= max; k++) {
      if (!present.has(k) && !skipped.has(k)) missing.push(k);
    }
    return { ok: missing.length === 0, missing, presentCount: present.size };
  }

  /**
   * 按编号区间过滤消息（单条导出 = [k, k] 的特例），并收集区间内消息引用的图片 id，
   * 供调用方把图片记录裁剪到选中范围（区间外的图片不抓取、不进文件）。
   */
  function filterRange(messages, range) {
    const out = [];
    const keepIds = new Set();
    const min = Number(range && range.min) || 0;
    const max = Number(range && range.max) || 0;
    for (const m of messages || []) {
      const n = messageKeyNo(m);
      if (n == null || n < min || n > max) continue;
      out.push(m);
      for (const id of imageIds(m)) keepIds.add(id);
    }
    return { messages: out, imageIds: keepIds };
  }

  DSMD.longCapture = { create, messageKey, hasStableFullDom, checkRange, filterRange };
})();
