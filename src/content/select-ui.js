/**
 * select-ui.js —— 选择性导出的消息勾选 UI
 *
 * 在每条消息（虚拟列表项 [data-virtual-list-item-key]）旁注入一个复选框，
 * 勾选状态按「消息编号」（virtualKey）记录，与节点回收无关；
 * 提供「导出选中区间」悬浮栏。所有注入节点带 ds-exporter-injected 标记类，
 * stop()/destroy() 时彻底从 DOM 清理，不会进入导出产物
 *（PDF 为离屏 iframe 排版、Word 为纯 OOXML，本就没有页面截图环节，这里再行双保险）。
 */
(() => {
  'use strict';

  const DSMD = (globalThis.__DSMD__ || (globalThis.__DSMD__ = {}));

  const MARK = 'ds-exporter-injected';       // 需求约定的注入标记类
  let active = false;
  let selected = new Map();                  // 编号(number) -> true
  let observer = null;
  let timer = null;
  let bar = null;
  let callbacks = null;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 当前文档里所有「有数字编号」的虚拟列表消息项
  function findItems(root) {
    return Array.from((root || document).querySelectorAll('[data-virtual-list-item-key]'))
      .filter(el => /^\d+$/.test(el.getAttribute('data-virtual-list-item-key') || ''));
  }

  function keyOf(item) {
    const m = /^(\d+)$/.exec(item.getAttribute('data-virtual-list-item-key') || '');
    return m ? Number(m[1]) : null;
  }

  // 给一个消息项挂复选框（挂在项内部左上角，绝对定位，不参与正文提取）
  function decorate(item) {
    if (item.querySelector(':scope > [data-dsmd-sel-host]')) return;
    const key = keyOf(item);
    if (key == null) return;
    const host = document.createElement('label');
    host.className = MARK + ' dsmd-sel-host';
    host.setAttribute('data-dsmd-sel-host', String(key));
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = MARK + ' dsmd-sel-box';
    box.checked = selected.has(key);
    box.addEventListener('change', () => {
      if (box.checked) selected.set(key, true);
      else selected.delete(key);
      refresh();          // 同屏同一编号可能出现两份节点（分支重渲染），状态要对齐
      updateBar();
      if (callbacks && callbacks.onChange) {
        try { callbacks.onChange(selected.size); } catch (e) { /* 忽略 */ }
      }
    });
    host.appendChild(box);
    // 绝对定位相对消息项：static 项临时设为 relative（清理时随节点一起消失）
    try {
      if (getComputedStyle(item).position === 'static') item.style.position = 'relative';
    } catch (e) { /* 忽略 */ }
    item.appendChild(host);
  }

  // 对账：新挂载的项补复选框；编号被复用节点复用导致不一致的，重建
  function refresh() {
    if (!active) return;
    for (const item of findItems(document)) {
      const key = keyOf(item);
      const host = item.querySelector(':scope > [data-dsmd-sel-host]');
      if (!host) { decorate(item); continue; }
      if (Number(host.getAttribute('data-dsmd-sel-host')) !== key) {
        host.remove();
        decorate(item);
        continue;
      }
      const box = host.querySelector('input');
      if (box && box.checked !== selected.has(key)) box.checked = selected.has(key);
    }
  }

  function ensureBar() {
    if (bar && bar.isConnected) return bar;
    bar = document.createElement('div');
    bar.className = MARK + ' dsmd-sel-bar';
    bar.innerHTML =
      '<span class="' + MARK + ' dsmd-sel-info">已选 0 条</span>' +
      '<button type="button" class="' + MARK + ' dsmd-sel-export">导出选中区间</button>' +
      '<button type="button" class="' + MARK + ' dsmd-sel-clear">清空</button>';
    document.body.appendChild(bar);
    bar.querySelector('.dsmd-sel-export').addEventListener('click', () => {
      if (callbacks && callbacks.onExport) callbacks.onExport();
    });
    bar.querySelector('.dsmd-sel-clear').addEventListener('click', () => {
      selected.clear();
      refresh();
      updateBar();
    });
    return bar;
  }

  function updateBar() {
    if (!bar) return;
    const keys = Array.from(selected.keys()).sort((a, b) => a - b);
    const info = bar.querySelector('.dsmd-sel-info');
    const btn = bar.querySelector('.dsmd-sel-export');
    if (info) {
      info.textContent = keys.length
        ? `已选 ${keys.length} 条（编号 ${keys[0]}${keys.length > 1 ? '–' + keys[keys.length - 1] : ''}）`
        : '已选 0 条';
    }
    if (btn) btn.disabled = !keys.length;
  }

  function cleanupDom() {
    document.querySelectorAll('[data-dsmd-sel-host]').forEach(el => el.remove());
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    bar = null;
  }

  /**
   * 开启选择模式。回调：
   *   onExport()  —— 悬浮栏「导出选中区间」被点击（由 content.js 接到导出流程）
   *   onChange(n) —— 勾选数量变化
   * 当前页面没有消息编号（极短对话无虚拟列表）时返回 { ok:false, reason:'no-keys' }。
   */
  function start(cb) {
    if (active) return { ok: true };
    if (!findItems(document).length) return { ok: false, reason: 'no-keys' };
    active = true;
    selected = new Map();
    callbacks = cb || {};
    ensureBar();
    updateBar();
    refresh();
    observer = new MutationObserver(() => { try { refresh(); } catch (e) { /* 忽略 */ } });
    observer.observe(document.body, { childList: true, subtree: true });
    timer = setInterval(() => { try { refresh(); } catch (e) { /* 忽略 */ } }, 1000);
    return { ok: true };
  }

  // 关闭并彻底清理注入 UI（勾选状态一并清空）
  function stop() {
    active = false;
    if (observer) { observer.disconnect(); observer = null; }
    if (timer) { clearInterval(timer); timer = null; }
    selected = new Map();
    callbacks = null;
    cleanupDom();
  }

  function isActive() { return active; }

  // 当前选择：{ keys:[升序], min, max }；未选返回 null
  function getSelection() {
    const keys = Array.from(selected.keys()).sort((a, b) => a - b);
    if (!keys.length) return null;
    return { keys, min: keys[0], max: keys[keys.length - 1] };
  }

  // 供测试 / 高级用法：直接按编号勾选
  function selectKey(key, checked) {
    const n = Number(key);
    if (!Number.isFinite(n)) return;
    if (checked) selected.set(n, true); else selected.delete(n);
    refresh();
    updateBar();
  }

  DSMD.selectUI = { start, stop, destroy: stop, isActive, getSelection, selectKey, refresh };
})();
