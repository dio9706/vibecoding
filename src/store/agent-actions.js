/**
 * Agent 写操作的撤销台账（agent-actions.json）。
 *
 * 「乐观执行 + 可撤销」这个授权模型的落地处：agent 调 reversible 工具时不等主机确认，
 * 直接执行，但每一次都在这里留一个**能把它撤回去的锚点**。主机事后一键撤销靠它。
 * 没有这份台账，「可撤销」就只是一句承诺。
 *
 * 为什么独立于 colleague-messages.json：那份是对话流（给人看的，按会话组织），
 * 这份是审计与撤销（给主机看的，按时间倒序）。混在一起会让「列出所有待撤销的 AI 改动」
 * 变成一次全表扫描。
 *
 * `undo: null` 是**合法值**，表示 external 档（如退款脚本）—— 已发生、撤不回，
 * 但仍要记录供事后审计。不要把它当成「忘了填」而去补一个假锚点。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'agent-actions.json';

/** 四种撤销方式，与 spec §5.2 一致 */
export const UNDO_KINDS = new Set(['revert-merge', 'delete-apidoc', 'revert-req-change', 'discard-task']);

function genId() {
  return 'aa_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 形状归一（纯函数）。
 *
 * **非法 `undo.kind` 归一为 `null` 而不是保留原值**：留着它会让撤销分派撞上一个
 * 认不出的 kind，而那时台账已经写下去、主机以为这条能撤。宁可当场就表现为「不可撤销」——
 * 主机看到撤不了会去问，看到按钮点了没反应只会以为撤成功了。
 */
/** 非字符串一律归空串，**不做类型强转**（理由见 normalizeAction 注释） */
function str(v) {
  return typeof v === 'string' ? v : '';
}

/** 普通对象：排除 null 与数组（与 colleague-messages.js 同口径） */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function normalizeAction(raw) {
  if (!isPlainObject(raw)) return null;
  const undo = isPlainObject(raw.undo) && UNDO_KINDS.has(raw.undo.kind) ? raw.undo : null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : genId(),
    at: typeof raw.at === 'string' && raw.at ? raw.at : new Date().toISOString(),
    // 刻意用「非字符串归空」而不是 String(x ?? '')：后者遇到对象会得到
    // '[object Object]'，把一坨垃圾当成合法 id 存进台账，之后按 id 查撤销永远查不到，
    // 而数据看起来是「有值的」。归空是干净失败 —— 与 colleague-messages.js 同口径。
    colleagueId: str(raw.colleagueId),
    role: str(raw.role),
    msgId: str(raw.msgId),
    reqId: str(raw.reqId),
    tool: str(raw.tool),
    input: isPlainObject(raw.input) ? raw.input : {},
    ok: raw.ok !== false,
    resultBrief: str(raw.resultBrief).slice(0, 200),
    undo,
    undone: raw.undone === true,
    undoneAt: typeof raw.undoneAt === 'string' ? raw.undoneAt : null,
  };
}

/** 能不能撤（纯函数）：有锚点、且没撤过 */
export function isUndoable(action) {
  return !!action && !!action.undo && action.undone !== true;
}

/** 追加一条，返回归一后的条目 */
export function appendAction(entry) {
  const item = normalizeAction(entry);
  if (!item) throw new Error('appendAction: entry 必须是对象');
  updateJson(FILE, { actions: [] }, (cur) => {
    const actions = Array.isArray(cur?.actions) ? cur.actions : [];
    return { actions: [item, ...actions] }; // 倒序存：主机看的永远是最近的
  });
  return item;
}

/** 全部条目（已归一，最近在前） */
export function getActions() {
  const raw = readJson(FILE, { actions: [] });
  return (Array.isArray(raw?.actions) ? raw.actions : []).map(normalizeAction).filter(Boolean);
}

export function getAction(id) {
  return getActions().find((a) => a.id === id) || null;
}

/**
 * 标记已撤销。
 * **幂等**：撤过的再调不报错，返回 false 表示这次没改 —— 调用方据此判断「是不是我撤的」，
 * 双击撤销按钮不会撤两次。
 */
export function markUndone(id) {
  let changed = false;
  updateJson(FILE, { actions: [] }, (cur) => {
    const actions = Array.isArray(cur?.actions) ? cur.actions : [];
    return {
      actions: actions.map((a) => {
        if (a?.id !== id || a.undone === true) return a;
        changed = true;
        return { ...a, undone: true, undoneAt: new Date().toISOString() };
      }),
    };
  });
  return changed;
}
