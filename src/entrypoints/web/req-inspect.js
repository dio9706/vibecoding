/**
 * 测试期 bitable 巡检 —— 复用 \10001 基建（bitable API/字段映射/评审门），差异见 spec §5.4：
 * 不回写表格状态；fix→sure 自动入队修复，ask|reject→doubt 等确认；recordId 去重保留旧状态。
 * 编排独立于 requirement-ops.js（该文件已两轮过审保持稳定），只 import 它导出的串行闸原语。
 */
import {
  listBitableTables,
  listBitableFields,
  searchBitableRecords,
  resolveWikiNodeObj,
} from '../../integrations/lark.js';
import { runClassifierOnce } from '../../capabilities/llm-classify.js';
import { reviewTask } from '../../plugins/team-tools/review/index.js';
import { getRequirement, updateRequirement } from '../../store/requirements.js';
import { getMyFeishuOpenId } from '../../store/settings.js';
import { resolveTrustedOpenIds } from '../../shared/trusted-ids.js';
import { config } from '../../shared/config.js';
import { enqueueSystemTask, raceWithTimeoutFlag } from './requirement-ops.js';
import { verdictToBug, mergeBugs } from './req-logic.js';
import {
  parseBitableLink,
  buildFieldMappingPrompt,
  validateFieldMapping,
  primaryFieldName,
  buildStatusFilter,
  isAssignedToMe,
  recordTitle,
  buildRecordDetail,
} from '../../plugins/team-tools/bug-patrol/logic.js';

/** 权限类错误的引导话术（与 bug-patrol/index.js 的 permissionHint 同文案，独立复制以免跨插件耦合） */
function permissionHint(e) {
  const msg = e?.message || String(e);
  const isPerm = /perm|forbidden|access|denied|91403|99991|1254/i.test(msg);
  return isPerm
    ? '（看起来是权限问题：请确认应用已开通「多维表格 bitable:app」权限并发布版本，且表格已对机器人可见——加为文档协作者或所在知识库可见）'
    : '';
}

/**
 * 巡检身份解析（纯函数，供测试直接注入）：myFeishuOpenId 非空用之；否则取可信名单第一个；都空返回 null。
 */
export function resolveInspectIdentity({ myFeishuOpenId, trusted }) {
  const mine = String(myFeishuOpenId || '').trim();
  if (mine) return mine;
  return trusted?.[0] || null;
}

/** 从当前真实设置解析巡检身份；供路由层预检（N2）与 inspectBitable 内部守卫共用同一份解析逻辑 */
export function currentInspectIdentity() {
  return resolveInspectIdentity({
    myFeishuOpenId: getMyFeishuOpenId(),
    trusted: resolveTrustedOpenIds(getMyFeishuOpenId()),
  });
}

/** wiki 链接换 app_token（须 objType===bitable）；/base/ 直链原样透传，无需网络往返 */
async function resolveAppToken(link) {
  if (link.kind === 'base') return link.appToken;
  const node = await resolveWikiNodeObj(link.token);
  if (node?.objType !== 'bitable' || !node.objToken) throw new Error('该链接不是多维表格');
  return node.objToken;
}

/** Haiku 字段映射（与 bug-patrol 同款：自适应任意表结构，结果由 validateFieldMapping 硬校验） */
async function mapFields(fields) {
  return runClassifierOnce({
    prompt: buildFieldMappingPrompt(fields),
    model: config.intent.classifyModel,
    logTag: 'req-inspect/field-map',
  });
}

/** 单条评审门的超时上限：巡检逐条串行，一条卡死不能拖死整场巡检 */
export const REVIEW_TIMEOUT_MS = 5 * 60_000;

/**
 * 评审门加超时护栏（review/timeoutMs 可注入供测试；默认真实 reviewTask + 5 分钟）。
 * reviewTask 不接受 abortController，超时后底层可能仍在跑——这与 llm-classify/runDocgen 的
 * race 兜底同性质：不真正中断调用，只是不再等它。超时按 ask 落 doubt，巡检继续下一条，不中断整场。
 */
export async function reviewWithTimeout(task, { review = reviewTask, timeoutMs = REVIEW_TIMEOUT_MS } = {}) {
  let settled;
  const call = review(task).then((r) => {
    settled = r; // race 赢的一定是已 resolve 的 call，此时该赋值必已执行（见 raceWithTimeoutFlag 用法）
    return r;
  });
  let timer;
  try {
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    const timedOut = await raceWithTimeoutFlag(call, timeoutPromise);
    return timedOut ? { verdict: 'ask', reason: '评审超时，请人工确认' } : settled;
  } finally {
    clearTimeout(timer); // call 先赢时计时器仍会挂到 timeoutMs 后才触发，不清会拖住进程退出（对齐 requirement-ops.js:378 纪律）
  }
}

/**
 * 单条记录评审并转 bug（导出供测试注入 opts.review）。reviewWithTimeout 本身只处理超时；
 * 若 reviewTask 调用本身异常（网络/解析等），这里兜底按 ask 落 doubt 继续巡检，不向上抛出中断整场。
 */
export async function reviewRecordAsBug(record, { title, detail }, opts) {
  let verdict;
  try {
    verdict = await reviewWithTimeout({ id: 'reqbug_' + record.record_id, type: 'bug', title, detail }, opts);
  } catch (e) {
    verdict = { verdict: 'ask', reason: `评审异常：${(e?.message || String(e)).slice(0, 200)}` };
  }
  return verdictToBug({ recordId: record.record_id, title, detail }, verdict);
}

/**
 * 逐表拉「关于我的待处理」记录并评审，产出待合并的 bug 列表（不落盘，由调用方统一 merge）。
 * 字段映射/查记录失败的表跳过并各自落一条 history（不中断其余表）；listBitableTables 本身失败
 * 不在此处兜底，交由调用方的外层 try/catch 判定整次巡检失败（无表可扫，继续没有意义）。
 */
async function collectBugsFromTables({ reqId, appToken, tableId, url, openId }) {
  const tables = tableId ? [{ tableId, name: '' }] : await listBitableTables(appToken);
  const incoming = [];
  for (const t of tables) {
    const tableLabel = t.name || t.tableId;
    let fields;
    try {
      fields = await listBitableFields(appToken, t.tableId);
    } catch (e) {
      updateRequirement(reqId, {}, `表 ${tableLabel} 跳过：读取字段失败：${e?.message || e}`);
      continue;
    }
    const mapping = await mapFields(fields);
    // requireFixingValue:false —— 本巡检不回写表格，无需「修复中」选项，不能因为它缺失就误判整表跳过
    const v = validateFieldMapping(mapping, fields, { requireFixingValue: false });
    if (!v.ok) {
      updateRequirement(reqId, {}, `表 ${tableLabel} 跳过：${v.error}`);
      continue;
    }
    let records;
    try {
      records = await searchBitableRecords(appToken, t.tableId, {
        filter: buildStatusFilter(v.statusField, v.pendingValue),
      });
    } catch (e) {
      updateRequirement(reqId, {}, `表 ${tableLabel} 跳过：查记录失败：${e?.message || e}`);
      continue;
    }
    const mine = records.filter((r) => isAssignedToMe(r, v.assigneeField, openId));
    const titleField = primaryFieldName(fields);
    for (const rec of mine) {
      const title = recordTitle(rec, titleField);
      const detail = buildRecordDetail(rec, { tableName: t.name, url });
      // 评审门：只读查证，不改表；synthetic id 供判例库溯源，与 \10001 的 patrol_ 前缀区分。
      // reviewRecordAsBug 内部已兜住超时与调用异常，单条出问题不会拖死或中断整场巡检
      incoming.push(await reviewRecordAsBug(rec, { title, detail }));
    }
  }
  return incoming;
}

/**
 * 测试期 bitable 巡检（异步全流程，由路由 202 受理后 fire-and-forget 调用；不回写多维表格，
 * 区别于 \10001 的 BUG 巡检）。sure 且本次新增的 bug 自动入队修复，doubt 等人工确认。
 * 守卫（同 runDocgen 纪律：busy 同步写在第一个 await 之前，防泵/重复提交竞争）：
 * 需求存在 + phase==='test' + busy 空 + 身份可解析 + 链接可解析出多维表格。
 */
export async function inspectBitable(reqId, url) {
  const req = getRequirement(reqId);
  if (!req) throw new Error('需求不存在');
  // 守卫未通过一律留痕再抛错（对齐 runDocgen 纪律：不写 busy，只留痕给前端看见）；
  // 路由层已有一道预检（N2，含身份），这里是二次防御，覆盖「预检通过后状态又变了」的窄窗口
  const reject = (msg) => {
    updateRequirement(reqId, {}, `表格巡检被拒：${msg}`);
    throw new Error(msg);
  };
  if (req.phase !== 'test') reject('仅测试期可进行表格巡检');
  if (req.busy) reject('有任务正在进行，请稍候');
  const openId = currentInspectIdentity();
  if (!openId) reject('请先在设置页填写我的飞书 open_id');
  const link = parseBitableLink(url);
  if (!link) reject('未识别出多维表格链接');

  // 同步写 busy（第一个 await 之前）：路由 fire-and-forget 派发后，下一 tick 前即可见 busy 已占用
  updateRequirement(reqId, { busy: { kind: 'bitable', startedAt: Date.now() } }, '开始表格巡检');
  try {
    const appToken = await resolveAppToken(link);
    updateRequirement(reqId, { bitable: { url, appToken, tableId: link.tableId } });

    const incoming = await collectBugsFromTables({ reqId, appToken, tableId: link.tableId, url, openId });

    const before = getRequirement(reqId).bugs; // 重新读取：期间已有若干次 history-only 写盘，须以最新落盘为合并基线
    const merged = mergeBugs(before, incoming);
    const added = merged.slice(before.length); // mergeBugs 新增项固定追加于末尾，即本次去重后真正新增的集合
    const sureCount = added.filter((b) => b.verdict === 'sure').length;
    updateRequirement(
      reqId,
      { bugs: merged },
      `巡检完成：新增 ${added.length}（确定 ${sureCount}/疑问 ${added.length - sureCount}）`,
    );

    // 只对本次新增的 sure&pending 入队修复；已存在的旧 bug（含本次被去重跳过的同 recordId）不重复入队
    for (const b of added) {
      if (b.verdict === 'sure' && b.status === 'pending') enqueueSystemTask(reqId, 'bug-fix', { bug: b });
    }
  } catch (e) {
    const reason = (e?.message || String(e)).slice(0, 200);
    updateRequirement(reqId, {}, `表格巡检失败：${reason}${permissionHint(e)}`);
    throw e;
  } finally {
    updateRequirement(reqId, { busy: null });
  }
}

// —— BUG 确认 / 忽略 / 重试（doubt 等人工确认；failed 可重试或重新确认；fixing 中不可忽略）——

function findBug(req, bugId) {
  return (req.bugs || []).find((b) => b.id === bugId) || null;
}

/** 锁内替换单条 bug 的部分字段；confirmBug 需要同时改 status+verdict，setBugStatus 只改 status 不够用。
 *  不下沉到 requirement-ops.js（保持该文件稳定），本地实现同款读-改-写。 */
function patchBug(reqId, bugId, patch) {
  const req = getRequirement(reqId);
  const next = req.bugs.map((b) => (b.id === bugId ? { ...b, ...patch } : b));
  updateRequirement(reqId, { bugs: next });
  return next.find((b) => b.id === bugId);
}

/** confirmBug / retryBug 共用的状态转移：落 pending（+ extraPatch 额外字段）+ 入队 bug-fix */
function toPendingAndEnqueue(reqId, bug, extraPatch = {}) {
  const patched = patchBug(reqId, bug.id, { status: 'pending', ...extraPatch });
  enqueueSystemTask(reqId, 'bug-fix', { bug: patched });
  return { ok: true };
}

/** 疑问态确认为真实缺陷，或修复失败后重新确认 → pending + verdict 转 sure + 入队修复。
 *  verdict 一并转 sure：人工确认=确定要修，前端按 verdict 渲染就不会残留「确认」按钮（N3）。 */
export async function confirmBug(reqId, bugId) {
  const req = getRequirement(reqId);
  if (!req) return { ok: false, status: 404, error: '需求不存在' };
  const bug = findBug(req, bugId);
  if (!bug) return { ok: false, status: 404, error: 'BUG 不存在' };
  if (bug.status === 'fixing') return { ok: false, status: 409, error: '该 BUG 正在修复中，无法操作' };
  if (bug.status === 'ignored') return { ok: false, status: 409, error: '已忽略的 BUG 不能直接确认，如需处理请重新巡检' };
  if (bug.verdict !== 'doubt' && bug.status !== 'failed') {
    return { ok: false, status: 409, error: '仅疑问态或修复失败的 BUG 可确认' };
  }
  return toPendingAndEnqueue(reqId, bug, { verdict: 'sure' });
}

/** 忽略该 BUG（不再处理）；修复中的不可忽略 */
export async function ignoreBug(reqId, bugId) {
  const req = getRequirement(reqId);
  if (!req) return { ok: false, status: 404, error: '需求不存在' };
  const bug = findBug(req, bugId);
  if (!bug) return { ok: false, status: 404, error: 'BUG 不存在' };
  if (bug.status === 'fixing') return { ok: false, status: 409, error: '修复中的 BUG 无法忽略' };
  patchBug(reqId, bugId, { status: 'ignored' });
  return { ok: true };
}

/** 修复失败后重试 → pending + 入队修复（与 confirmBug 同径，共用 toPendingAndEnqueue） */
export async function retryBug(reqId, bugId) {
  const req = getRequirement(reqId);
  if (!req) return { ok: false, status: 404, error: '需求不存在' };
  const bug = findBug(req, bugId);
  if (!bug) return { ok: false, status: 404, error: 'BUG 不存在' };
  if (bug.status !== 'failed') return { ok: false, status: 409, error: '仅修复失败的 BUG 可重试' };
  return toPendingAndEnqueue(reqId, bug);
}
