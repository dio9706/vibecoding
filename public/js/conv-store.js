/** 会话存储 + 气泡缓存守护（「存储=DOM=_bubbleMap 三方同序」不变量的两侧收敛点）。
 *  convs 走 localStorage（500ms 防抖 + beforeunload flush）；_bubbleMap 只经本模块守护函数触碰，
 *  app.js 侧不得直接操作 Map——任何 splice/move/reorder 必须两侧一起动（见 moveMessageToEnd）。 */
import { lsSet } from './util.js';

      const CONV_KEY = 'claude_convs';
      // ---- localStorage 内存缓存（减少 JSON.parse/stringify 频率）----
      let _convsCache = null; // null 表示尚未初始化
      let _convsSaveTimer = null;
      // ---- 气泡 DOM 引用缓存（convId → Element[]，避免 querySelectorAll 线性扫描）----
      const _bubbleMap = new Map(); // convId -> [bubbleEl, bubbleEl, ...]

      export function loadConvs() {
        if (_convsCache !== null) return _convsCache;
        try {
          _convsCache = JSON.parse(localStorage.getItem(CONV_KEY)) || [];
        } catch {
          _convsCache = [];
        }
        return _convsCache;
      }
      export function saveConvs(list) {
        _convsCache = list; // 内存立即更新（快路径）
        clearTimeout(_convsSaveTimer);
        _convsSaveTimer = setTimeout(() => {
          _convsSaveTimer = null;
          try { lsSet(CONV_KEY, JSON.stringify(_convsCache)); } catch { /* 配额满等 */ }
        }, 500);
      }
      /** 强制立即写 localStorage（页面卸载前调用，防止防抖窗口内丢数据）*/
      export function flushConvs() {
        if (_convsSaveTimer === null) return;
        clearTimeout(_convsSaveTimer);
        _convsSaveTimer = null;
        try { lsSet(CONV_KEY, JSON.stringify(_convsCache || [])); } catch { /* ignore */ }
      }

      export function convPushMessage(convId, role, text) {
        const list = loadConvs();
        const c = list.find((x) => x.id === convId);
        if (!c) return -1;
        const idx = c.messages.length;
        c.messages.push({ role, text });
        c.updatedAt = Date.now();
        saveConvs(list);
        return idx;
      }
      export function convSetMessage(convId, index, text) {
        const list = loadConvs();
        const c = list.find((x) => x.id === convId);
        if (!c || !c.messages[index]) return;
        c.messages[index].text = text;
        c.updatedAt = Date.now();
        saveConvs(list);
      }
      export function convSetSession(convId, sid) {
        const list = loadConvs();
        const c = list.find((x) => x.id === convId);
        if (!c) return;
        c.session = sid;
        saveConvs(list);
      }
      export function convSetTitle(convId, title) {
        const list = loadConvs();
        const c = list.find((x) => x.id === convId);
        if (!c) return;
        c.title = String(title || '新会话').slice(0, 60);
        c.updatedAt = Date.now();
        saveConvs(list);
      }
      export function convDelete(convId) {
        const list = loadConvs();
        const idx = list.findIndex((x) => x.id === convId);
        if (idx < 0) return;
        list.splice(idx, 1);
        if (list.length > 0) {
          list[0].updatedAt = Date.now();
        }
        saveConvs(list);
      }
      export function convSetMeta(convId, patch) {
        const list = loadConvs();
        const c = list.find((x) => x.id === convId);
        if (!c) return;
        if (!patch || typeof patch !== 'object') return;
        Object.assign(c.meta || (c.meta = {}), patch);
        c.updatedAt = Date.now();
        saveConvs(list);
      }
      // 给某条消息打补丁字段（runId / pending 等，用于关网页后按 runId 重连）
      export function convSetMsgFields(convId, index, patch) {
        const list = loadConvs();
        const c = list.find((x) => x.id === convId);
        if (!c || !c.messages[index]) return;
        Object.assign(c.messages[index], patch);
        c.updatedAt = Date.now();
        saveConvs(list);
      }
      /** 存储+_bubbleMap 两侧同步搬移（DOM appendChild 由调用方执行）：消息移到会话末尾，返回新索引；失败 -1。
       *  两侧永远一起动是三方同序不变量的守护核心，禁止在调用方拆开做。 */
      export function moveMessageToEnd(convId, index) {
        const list = loadConvs();
        const c = list.find((x) => x.id === convId);
        if (!c || !c.messages[index]) return -1;
        const [m] = c.messages.splice(index, 1);
        c.messages.push(m);
        c.updatedAt = Date.now();
        saveConvs(list);
        const arr = _bubbleMap.get(convId);
        if (arr && arr[index]) {
          const [b] = arr.splice(index, 1);
          arr.push(b);
        }
        return c.messages.length - 1;
      }

      /** 存储+_bubbleMap 两侧同步删除第 index 条消息（DOM removeChild 由调用方执行）；成功返回 true。
       *  与 moveMessageToEnd 同为三方同序不变量的守护操作，禁止在调用方拆开做。 */
      export function removeMessageAt(convId, index) {
        const list = loadConvs();
        const c = list.find((x) => x.id === convId);
        if (!c || !c.messages[index]) return false;
        c.messages.splice(index, 1);
        c.updatedAt = Date.now();
        saveConvs(list);
        const arr = _bubbleMap.get(convId);
        if (arr && index < arr.length) arr.splice(index, 1);
        return true;
      }

      /** 重置某会话的气泡缓存（切会话/重建消息区前调用） */
      export function bubbleReset(convId) { _bubbleMap.delete(convId); }
      /** 登记一个新气泡（与存储 push 同步调用，保持索引对齐） */
      export function bubblePush(convId, el) {
        if (!_bubbleMap.has(convId)) _bubbleMap.set(convId, []);
        _bubbleMap.get(convId).push(el);
      }
      /** O(1) 取某会话第 index 个气泡；未命中 null（调用方自行降级线性扫描） */
      export function bubbleGet(convId, index) {
        const arr = _bubbleMap.get(convId);
        return (arr && arr[index]) || null;
      }
