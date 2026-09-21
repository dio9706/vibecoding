/**
 * 同事名册持久化（colleagues.json）—— 按职位维护人员：姓名 / 备注 / 飞书 open_id。
 *
 * 为什么独立于 settings.json：后者含明文密钥、已 gitignore，且整份参与配置导入导出；
 * 名册是可分享的组织数据，混进去等于让「导出一份同事清单」顺手带走密钥。
 *
 * 为什么是扁平数组 + role 字段而不是按职位嵌套的 map：增删改一个人就是一次 map/filter，
 * 不必先定位分组；职位 label 改名不触发数据迁移；分组只是渲染形态，不该被 store 固化。
 *
 * 消费方：设置页「同事设置」tab、需求工作流的开发人员指派，以及后续「智能体主动询问同事」。
 */
import { readJson, updateJson } from './index.js';

const FILE = 'colleagues.json';

/** 职位枚举：id 稳定（落盘值 + 后续按职位路由的契约），label 可随时改而不动数据。
 *  新职位一律**追加到末尾**：这个数组的顺序就是设置页与选人弹窗的分组顺序，
 *  插到中间会把用户已经形成肌肉记忆的那几组位置全部挪动。 */
export const ROLES = [
  { id: 'ops', label: '运营' },
  { id: 'frontend', label: '前端' },
  { id: 'backend', label: '后端' },
  { id: 'design', label: 'UI设计' },
  { id: 'product', label: '产品' },
  { id: 'qa', label: '测试' },
];

const ROLE_IDS = new Set(ROLES.map((r) => r.id));

function genId() {
  return 'cl_' + Math.random().toString(36).slice(2, 8);
}

/**
 * 形状归一（纯函数）。两条刻意的「不」：
 *
 * 1. **不改非法 role**：归一到第一个合法值是静默改数据，丢弃条目是静默丢数据，
 *    两者都会让用户以为「我填的人没了」。保留原值，由 UI 的「未知职位」兜底分组
 *    显示出来——用户看得见才能自己修。
 * 2. **无 id 的条目补发 id 而非丢弃**（同 settings.js:ensureMcpServerIds）：没有 id
 *    的条目在 UI 上既编辑不了也删不掉，丢弃则用户连它曾经存在都看不见。
 */
export function normalizeColleagues(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
    .map((c) => ({
      id: typeof c.id === 'string' && c.id ? c.id : genId(),
      role: typeof c.role === 'string' ? c.role : '',
      name: typeof c.name === 'string' ? c.name : '',
      note: typeof c.note === 'string' ? c.note : '',
      feishuOpenId: typeof c.feishuOpenId === 'string' ? c.feishuOpenId : '',
      updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : '',
    }));
}

/**
 * 输入校验（纯函数）—— 名册数据不变式的**唯一实现**。
 * HTTP 层调它拿 400 文案；add/update 也调它并抛错，挡住非 HTTP 调用方（插件 / 脚本）写脏数据。
 * 两处共用同一实现，规则不会各写一份然后跑偏。
 */
export function validateColleagueInput(input) {
  const o = input && typeof input === 'object' ? input : {};
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) return { error: '姓名不能为空' };
  const role = typeof o.role === 'string' ? o.role.trim() : '';
  if (!ROLE_IDS.has(role)) return { error: `未知职位：${role || '(空)'}` };
  const note = typeof o.note === 'string' ? o.note.trim() : '';
  const feishuOpenId = typeof o.feishuOpenId === 'string' ? o.feishuOpenId.trim() : '';
  // 允许留空：先把人记下、之后再补 id 是常见节奏。非空则必须是 open_id——
  // 填成 user_id 的话后续发消息只会静默失败，用户根本不知道是这里填错了。
  if (feishuOpenId && !feishuOpenId.startsWith('ou_')) {
    return { error: '飞书 open_id 必须以 ou_ 开头' };
  }
  return { value: { role, name: name.slice(0, 40), note: note.slice(0, 100), feishuOpenId } };
}

export function getColleagues() {
  return normalizeColleagues(readJson(FILE, []));
}

export function getColleague(id) {
  return getColleagues().find((c) => c.id === id) || null;
}

/** 按职位筛；严格匹配，非法 roleId 返回空数组 */
export function getColleaguesByRole(role) {
  return getColleagues().filter((c) => c.role === role);
}

/** 锁内读-改-写整份名册：fn(list) 就地修改；fn 显式返回 false 则放弃写盘 */
function updateColleagues(fn) {
  return updateJson(FILE, [], (raw) => {
    const list = normalizeColleagues(raw);
    if (fn(list) === false) return undefined;
    return list;
  });
}

export function addColleague(input) {
  const v = validateColleagueInput(input);
  if (v.error) throw new Error(v.error);
  let created = null;
  updateColleagues((list) => {
    created = { id: genId(), ...v.value, updatedAt: new Date().toISOString() };
    list.push(created);
  });
  return created;
}

/**
 * 批量新增（「从飞书群导入」用）。一次锁内写盘，不是 N 次 addColleague——
 * 后者会让 22 个人产生 22 轮「抢锁→读盘→写盘」，中途失败还留下半批数据。
 *
 * 两条策略：
 * - **按 feishuOpenId 去重**（已在名册的跳过而非覆盖）：覆盖会抹掉用户手改过的职位与备注，
 *   而重复导入同一个群是常态（隔几周补新同事）。空 open_id 不参与去重——
 *   把「都没填号」的人折叠成一个才是真丢数据。
 * - **整批原子校验**：任一条非法就整批不写。半批写入会让用户看到一份残缺名册，
 *   且没有任何线索指出断在第几条。
 *
 * @returns {{added: object[], skipped: string[]}} skipped 是被跳过的 feishuOpenId
 */
export function addColleaguesBatch(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) return { added: [], skipped: [] };
  // 先全量校验再动盘
  const cleaned = inputs.map((input) => {
    const v = validateColleagueInput(input);
    if (v.error) throw new Error(v.error);
    return v.value;
  });

  const added = [];
  const skipped = [];
  updateColleagues((list) => {
    const seen = new Set(list.map((c) => c.feishuOpenId).filter(Boolean));
    const now = new Date().toISOString();
    for (const v of cleaned) {
      if (v.feishuOpenId && seen.has(v.feishuOpenId)) {
        skipped.push(v.feishuOpenId);
        continue;
      }
      if (v.feishuOpenId) seen.add(v.feishuOpenId);
      const entry = { id: genId(), ...v, updatedAt: now };
      list.push(entry);
      added.push(entry);
    }
    if (!added.length) return false; // 全被跳过：不必写盘
  });
  return { added, skipped };
}

/** 局部更新；未知 id 不写盘并返回 null */
export function updateColleague(id, input) {
  const v = validateColleagueInput(input);
  if (v.error) throw new Error(v.error);
  let updated = null;
  updateColleagues((list) => {
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) return false;
    list[i] = { ...list[i], ...v.value, id, updatedAt: new Date().toISOString() };
    updated = list[i];
  });
  return updated;
}

/** @returns {boolean} 是否真的删掉了（供路由区分 200 / 404） */
export function removeColleague(id) {
  let removed = false;
  updateColleagues((list) => {
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    removed = true;
  });
  return removed;
}
