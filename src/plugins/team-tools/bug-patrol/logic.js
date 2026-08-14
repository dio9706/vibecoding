/**
 * BUG 巡检（\10001）纯逻辑 —— 链接解析 / 字段映射校验 / 记录过滤 / 文案拼装（单测目标）。
 * 字段映射由 Haiku 产出（用户拍板的自适应方案），这里只负责「映射结果必须真实存在」的硬校验：
 * 校验不过整表跳过并回告原因，绝不带着猜测去改用户的表。
 */

/** 触发文案（全等匹配）；带「(多维表格)」后缀的原文写法一并兼容，防止照需求原文复制发送没反应 */
export const PATROL_TRIGGERS = [
  '\\10001 开始进行BUG巡检与修复',
  '\\10001 开始进行BUG巡检与修复(多维表格)',
];

/** 等表状态下的取消词（短文本全等级别的宽松：允许一个语气尾字） */
const CANCEL_RE = /^(取消|算了|不用了|不弄了|退出|不巡检了)[吧了呢~！!。.]?$/;

export function isCancelText(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  return !!t && t.length <= 8 && CANCEL_RE.test(t);
}

// 多维表格链接：/base/ 直链（app_token 开头 bascn/其它均可能，按通用 token 收）；
// wiki 链接需 get_node 换 obj_token（obj_type=bitable），解析层只负责抽 token。
const BASE_LINK_RE = /https?:\/\/[\w.-]+\.(?:feishu\.cn|larksuite\.com)\/base\/([A-Za-z0-9]+)(\?[\w&=%.~-]*)?/;
const WIKI_LINK_RE = /https?:\/\/[\w.-]+\.(?:feishu\.cn|larksuite\.com)\/wiki\/([A-Za-z0-9]+)(\?[\w&=%.~-]*)?/;

/**
 * 从消息文本解析多维表格链接。
 * @returns {{ kind:'base', appToken:string, tableId:string|null, url:string }
 *   | { kind:'wiki', token:string, tableId:string|null, url:string } | null}
 */
export function parseBitableLink(text) {
  const t = String(text ?? '');
  const base = BASE_LINK_RE.exec(t);
  if (base) {
    return { kind: 'base', appToken: base[1], tableId: parseTableParam(base[2]), url: base[0] };
  }
  const wiki = WIKI_LINK_RE.exec(t);
  if (wiki) {
    return { kind: 'wiki', token: wiki[1], tableId: parseTableParam(wiki[2]), url: wiki[0] };
  }
  return null;
}

/** query 串中的 table=tblXXX 参数（多维表格链接常带，命中则只扫该表） */
function parseTableParam(query) {
  const m = /[?&]table=(tbl[A-Za-z0-9]+)/.exec(query || '');
  return m ? m[1] : null;
}

/** 字段清单 → 供 Haiku 映射的精简摘要行（含选项值，选项过多截断） */
export function summarizeFieldsForMapping(fields) {
  return (Array.isArray(fields) ? fields : []).map((f) => {
    const options = (f?.property?.options || []).map((o) => o?.name).filter(Boolean);
    const opt = options.length ? `；选项: ${options.slice(0, 20).join(' / ')}` : '';
    return `- ${f?.field_name}（${f?.ui_type || f?.type}${opt}）`;
  });
}

/** 构造 Haiku 字段映射 prompt（index 用 runClassifierOnce 调用） */
export function buildFieldMappingPrompt(fields) {
  return (
    `你是多维表格字段映射器，仅输出一行 JSON，不要任何解释。\n` +
    `下面是一张 BUG 记录表的字段清单，请找出：\n` +
    `- status_field：表示处理进展/状态的字段名\n` +
    `- pending_value：该状态字段中表示「待处理/未开始/待修复」的选项值\n` +
    `- fixing_value：该状态字段中表示「修复中/处理中」的选项值\n` +
    `- assignee_field：表示处理人/负责人/指派对象的人员（User）字段名\n` +
    `字段清单：\n${summarizeFieldsForMapping(fields).join('\n')}\n\n` +
    `找不到的项填 null。严格输出：\n` +
    `{"status_field":"...","pending_value":"...","fixing_value":"...","assignee_field":"..."}`
  );
}

/**
 * 校验 Haiku 映射结果：字段真实存在、选项值真实存在（选择类字段）、人员字段类型正确。
 * @param {object|null} mapping Haiku 输出
 * @param {Array} fields listBitableFields 返回的字段数组
 * @param {{ requireFixingValue?: boolean }} [opts] requireFixingValue 默认 true（\10001 巡检要写「修复中」，
 *   必须校验该选项存在）；req-inspect 巡检不回写表格，传 false 时 fixing_value 缺失/非法不再报错。
 * @returns {{ ok:true, statusField:string, pendingValue:string, fixingValue:string, assigneeField:string }
 *   | { ok:false, error:string }}
 */
export function validateFieldMapping(mapping, fields, { requireFixingValue = true } = {}) {
  if (!mapping || typeof mapping !== 'object') return { ok: false, error: '字段映射失败（模型无输出）' };
  const { status_field: statusField, pending_value: pendingValue, fixing_value: fixingValue, assignee_field: assigneeField } = mapping;
  if (!statusField || !pendingValue || !assigneeField || (requireFixingValue && !fixingValue)) {
    return { ok: false, error: '未识别出完整的 状态字段/待处理值/修复中值/人员字段' };
  }
  const list = Array.isArray(fields) ? fields : [];
  const status = list.find((f) => f?.field_name === statusField);
  if (!status) return { ok: false, error: `状态字段「${statusField}」在表中不存在` };
  // 选择类字段（有 options）：两个值都必须是真实选项——写入不存在的选项会失败或污染选项集。
  // 文本类字段无从校验选项，放行（写入即字符串）。
  const options = (status.property?.options || []).map((o) => o?.name).filter(Boolean);
  if (options.length) {
    if (!options.includes(pendingValue)) return { ok: false, error: `状态字段「${statusField}」没有「${pendingValue}」选项` };
    if (requireFixingValue && !options.includes(fixingValue)) {
      return { ok: false, error: `状态字段「${statusField}」没有「${fixingValue}」选项` };
    }
  }
  const assignee = list.find((f) => f?.field_name === assigneeField);
  if (!assignee) return { ok: false, error: `人员字段「${assigneeField}」在表中不存在` };
  if (assignee.ui_type && assignee.ui_type !== 'User') {
    return { ok: false, error: `「${assigneeField}」不是人员（User）字段，无法按人筛选` };
  }
  return { ok: true, statusField, pendingValue, fixingValue, assigneeField };
}

/** 主字段名（记录标题来源）：is_primary 优先，缺失取第一个字段 */
export function primaryFieldName(fields) {
  const list = Array.isArray(fields) ? fields : [];
  return (list.find((f) => f?.is_primary) || list[0])?.field_name || null;
}

/** search 接口的服务端过滤：状态字段 = 待处理值 */
export function buildStatusFilter(statusField, pendingValue) {
  return {
    conjunction: 'and',
    conditions: [{ field_name: statusField, operator: 'is', value: [pendingValue] }],
  };
}

/**
 * 单元格值 → 展示文本。search 返回值形态多样：
 * 文本=[{text}]段数组、单选=字符串、多选=[字符串]、人员=[{id,name}]、数字=number。
 * 统一收敛为字符串，识别不出的形态给 JSON 兜底（截断），绝不抛错。
 */
export function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v
      .map((item) => {
        if (item == null) return '';
        if (typeof item === 'string' || typeof item === 'number') return String(item);
        return item.text || item.name || item.link || '';
      })
      .filter(Boolean)
      .join('、');
  }
  if (typeof v === 'object') return v.text || v.name || v.link || JSON.stringify(v).slice(0, 100);
  return '';
}

/** 人员字段值 → open_id 列表（user_id_type=open_id 查询下 id 即 open_id） */
export function personOpenIds(v) {
  if (!Array.isArray(v)) return [];
  return v.map((u) => u?.id).filter(Boolean);
}

/** 该记录的人员字段是否包含我（客户端过滤「关于我的」） */
export function isAssignedToMe(record, assigneeField, openId) {
  if (!openId) return false;
  return personOpenIds(record?.fields?.[assigneeField]).includes(openId);
}

/** 记录标题（主字段文本，空则占位） */
export function recordTitle(record, titleField) {
  const t = cellText(record?.fields?.[titleField]).trim();
  return t || '（未命名记录）';
}

/** 记录 → 评审/任务用 detail 文本：全字段拼接（限长）+ 溯源信息 */
export function buildRecordDetail(record, { tableName, url } = {}) {
  const lines = ['【BUG 巡检】来自多维表格记录，评审确认后自动修复。'];
  const fields = record?.fields || {};
  for (const [name, value] of Object.entries(fields)) {
    const text = cellText(value).trim();
    if (text) lines.push(`${name}：${text.slice(0, 300)}`);
  }
  if (tableName) lines.push(`所在数据表：${tableName}`);
  if (url) lines.push(`表格链接：${url}`);
  if (record?.record_id) lines.push(`记录ID：${record.record_id}`);
  return lines.join('\n').slice(0, 4000);
}

/**
 * 巡检汇总文案。
 * @param {{ mine:number, fixed:{title:string}[], rejected:{title:string, reason:string}[],
 *   failed:{title:string, reason:string}[], skippedTables:{name:string, reason:string}[] }} s
 */
export function buildPatrolSummary(s) {
  const skipped = s.skippedTables?.length
    ? `\n（跳过数据表：${s.skippedTables.map((t) => `${t.name} — ${t.reason}`).join('；')}）`
    : '';
  if (!s.mine) return `🧹 巡检完成：没有找到分配给你的「待处理」BUG～${skipped}`;
  const lines = [`🧹 BUG 巡检完成：分配给你的待处理 BUG 共 ${s.mine} 条`];
  if (s.fixed.length) {
    lines.push(`🔧 确认缺陷并转自动修复 ${s.fixed.length} 条（表格已改「修复中」，修完在此通知你；合并代码后请自行更新表格状态）：`);
    s.fixed.forEach((r, i) => lines.push(`  ${i + 1}. ${r.title}`));
  }
  if (s.rejected.length) {
    lines.push(`⛔ 评审未通过 ${s.rejected.length} 条（表格未改动）：`);
    s.rejected.forEach((r, i) => lines.push(`  ${i + 1}. ${r.title} — ${r.reason || '未通过评审'}`));
  }
  if (s.failed.length) {
    lines.push(`⚠️ 处理失败 ${s.failed.length} 条：`);
    s.failed.forEach((r, i) => lines.push(`  ${i + 1}. ${r.title} — ${r.reason || '未知原因'}`));
  }
  return lines.join('\n') + skipped;
}
