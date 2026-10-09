/**
 * 「委托同事对话」的纯函数层：目标解析 / 询问卡 / 判定 prompt / 判定结果解析 / 转录格式化。
 * 全部无 IO（只读 ROLES 常量），是单测主战场；有状态与网络的部分在 feishu-ask.js。
 */
import { ROLES } from '../store/colleagues.js';

/** 追问上限：超过仍未得出结论就放弃自动追问，把已有信息如实交回主 agent（防无限叨扰同事） */
export const MAX_FOLLOW_UPS = 3;

/** 职位输入归一：接受 id（backend）或 label（后端），未知返回 null */
export function normalizeRole(role) {
  const s = typeof role === 'string' ? role.trim() : '';
  if (!s) return null;
  const byId = ROLES.find((r) => r.id === s);
  if (byId) return byId.id;
  return ROLES.find((r) => r.label === s)?.id || null;
}

/**
 * 按职位/姓名在名册里定位唯一目标（纯函数）。
 *
 * 三条失败语义刻意分开：
 * - 名册里根本没有 → 提示可用职位，帮模型换目标
 * - 有这个人但没飞书 open_id → 指明是谁，提示去设置页补
 * - 命中多个都可用 → 列名字，要求用 name 指定（绝不替模型赌一个）
 *
 * @returns {{colleague: object}|{error: string}}
 */
export function resolveColleagueTarget(colleagues, { role, name } = {}) {
  const list = Array.isArray(colleagues) ? colleagues : [];
  const roleRaw = typeof role === 'string' ? role.trim() : '';
  const nameKey = typeof name === 'string' ? name.trim() : '';
  if (!roleRaw && !nameKey) return { error: '请用 role 或 name 指定要询问的同事' };

  const roleKey = roleRaw ? normalizeRole(roleRaw) : null;
  if (roleRaw && !roleKey) {
    return { error: `未知职位「${roleRaw}」（可用：${ROLES.map((r) => `${r.id}/${r.label}`).join('、')}）` };
  }

  let hits = list;
  if (roleKey) hits = hits.filter((c) => c.role === roleKey);
  if (nameKey) hits = hits.filter((c) => (c.name || '').trim() === nameKey);
  if (!hits.length) {
    return { error: `名册里没找到匹配的同事（role=${roleRaw || '-'} name=${nameKey || '-'}），可用职位：${ROLES.map((r) => `${r.id}/${r.label}`).join('、')}` };
  }

  const reachable = hits.filter((c) => c.feishuOpenId);
  if (!reachable.length) {
    return { error: `${hits.map((c) => c.name || c.id).join('、')} 未配置飞书 open_id，请先在设置页补全` };
  }
  if (reachable.length > 1) {
    return { error: `匹配到多位可用同事（${reachable.map((c) => c.name).join('、')}），请用 name 指定具体问谁` };
  }
  return { colleague: reachable[0] };
}

function clip(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}

/** 询问卡（纯函数）。正文上限 4000 字防卡片超长；header 让同事一眼知道是谁在问 */
export function buildAskCard({ question, context = '' }) {
  const body = context ? `${question}\n\n---\n${context}` : String(question || '');
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '💬 开发助手提问' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: clip(body, 4000) } },
      { tag: 'hr' },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: '直接回复本条消息即可；助手会自动追问确认，得出结论后继续开发任务。' },
      },
    ],
  };
}

/**
 * 判定引擎的 prompt（纯函数）：给子引擎看「原始问题 + 已有对话」，要一个 JSON：
 * 已得出结论 → conclusion；还没有 → followUp（下一句该问什么）。
 */
export function buildJudgePrompt({
  colleagueName = '同事',
  question,
  context = '',
  transcript = [],
  followUps = 0,
  maxFollowUps = MAX_FOLLOW_UPS,
}) {
  const who = colleagueName || '同事';
  const lines = transcript
    .map((t) => `${t.dir === 'in' ? who : '助手'}：${clip(t.text || '（无文字）', 800)}${filesNote(t.files)}`)
    .join('\n');
  return `你是开发助手的「同事沟通」子代理。开发任务遇到一个只有同事才知道答案的问题，由你在飞书上向 ${who} 询问，负责把话题聊到得出**完整结论**再交回。

## 要问清楚的问题
${question}
${context ? `\n## 补充背景\n${context}` : ''}

## 当前对话记录
${lines || '（尚未开始，你正在发出第一个问题）'}

## 输出要求（只输出一个 JSON 对象，不要其他内容）
- 已能回答上面的问题：{"done": true, "conclusion": "给开发任务的完整结论（含关键细节：原文数字、字段名、文件/链接名、边界条件）"}
- 还不能：{"done": false, "followUp": "给 ${who} 的下一句话——只问一个最关键的问题，口语、简短、像同事沟通"}
- 对方明确说不清楚/不负责，且换角度再问也拿不到实质信息：可以 done=true，在 conclusion 里如实写明「未获确定答案」及对方给出的线索。

## 纪律
1. 一次只问一件事，已经答过的不重复问。
2. 不寒暄、不复述对方原话、不暴露开发任务之外的内部信息。
3. 追问预算还剩 ${Math.max(maxFollowUps - followUps, 0)} 次；快用完仍无结论时，尽最大努力收敛成一个结论（哪怕结论是「没问到」）。`;
}

/**
 * 解析判定结果（纯函数）。两条硬约束：not-done 必须给 followUp、done 必须给 conclusion，
 * 缺一视为无效输出（交由调用方按「判定失败」处理，保持继续等待），绝不半途用半个结果结算。
 * @returns {{done:boolean, followUp:string, conclusion:string}|null}
 */
export function parseJudgeResult(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const done = data.done === true;
  const followUp = typeof data.followUp === 'string' ? data.followUp.trim() : '';
  const conclusion = typeof data.conclusion === 'string' ? data.conclusion.trim() : '';
  if (done && !conclusion) return null;
  if (!done && !followUp) return null;
  return { done, followUp, conclusion };
}

function filesNote(files) {
  const list = Array.isArray(files) ? files.filter((f) => f && f.name) : [];
  return list.length ? `（附件：${list.map((f) => f.name).join('、')}）` : '';
}

/** 转录 → 给主 agent 看的原文（带上限截断，防止超长会话把工具结果撑爆） */
export function formatTranscript(transcript, { maxChars = 4000 } = {}) {
  const out = [];
  let used = 0;
  for (const t of Array.isArray(transcript) ? transcript : []) {
    const line = `${t.dir === 'in' ? '对方' : '助手'}：${t.text ? clip(t.text, 600) : '（无文字）'}${filesNote(t.files)}`;
    if (used + line.length > maxChars) {
      out.push('…（对话较长，已截断）');
      break;
    }
    used += line.length + 1;
    out.push(line);
  }
  return out.join('\n');
}
