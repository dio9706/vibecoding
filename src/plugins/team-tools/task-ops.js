/**
 * 共享领域模块：任务的「只读分析」与「实际开发」。
 * 从 feedback 抽出，供 feedback / task-triage / web 入口共用（见 ARCHITECTURE §10 —— 协作走共享模块，不 feature 互相 import）。
 * 只依赖下层 integrations/store/shared 及同插件内共享纯函数（material-pool），不注册为 feature、无 Feature 契约。
 */
import { updateTask, getTasks } from '../../store/tasks.js';
import { systemNotify } from '../../integrations/notify.js';
import { runClaude } from '../../integrations/claude.js';
import { claudeAuthOpts } from '../../features/token-rotation.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { botScopePrompt } from '../../shared/bot-scope.js';
import { getActiveBot } from '../../store/settings.js';
import { materialDetailLine } from './material-pool.js';
import { notifyTaskDone } from './task-notify.js';

/** 任务处理的机器人上下文：一次读盘取 cwd 与边界提示（两次分别读会有中途换 bot 的错配窗口） */
function botTaskContext() {
  const bot = getActiveBot();
  const scope = botScopePrompt(bot);
  return {
    cwd: bot?.projectDir || config.feedback.frontendDir,
    scopeSection: scope ? `\n${scope}\n` : '',
  };
}

/** 只读分析：判断要做什么，不改任何代码 */
export async function analyze(task) {
  logger.info('task-ops', '▶ analyze', { id: task.id, type: task.type, title: task.title });
  updateTask(task.id, { status: 'analyzing' }, '开始分析');
  const isBug = task.type === 'bug';
  const botCtx = botTaskContext();
  let out = '';
  let streamed = '';
  try {
    await runClaude(
      `用户提交了一个${isBug ? '故障/BUG' : '需求'}：\n「${task.detail}」\n\n` +
        `请分析当前代码库，判断要做什么来${isBug ? '定位并修复它' : '实现它'}。\n` +
        `⚠️ 只做分析，绝对不要修改任何文件、不要执行有副作用的命令。\n` +
        (task.fixNote ? `补充修正方案（请据此重新分析）：${task.fixNote}\n` : '') +
        // 评审门已初步定位过 → 带上结论省去重复冷启动探索（复核而非盲从）
        (task.review?.scores?.locatedAt ? `AI 评审已初步定位：${task.review.scores.locatedAt}（请复核并基于此展开）。\n` : '') +
        (task.review?.scores?.evidence ? `评审依据：${task.review.scores.evidence}\n` : '') +
        `反馈中若含本地文件/图片路径（截图、附件、参考文档），请先用 Read 查看再分析。\n` +
        // backendDir 未配置时整句省略：拼一句「相关后端项目在：（若与后端相关…）」
        // 只会误导模型去找一个空路径
        (config.feedback.backendDir
          ? `相关后端项目在：${config.feedback.backendDir}（若与后端相关可一并参考）。\n`
          : '') +
        botCtx.scopeSection +
        `\n【重要】你可以自由探索代码来定位，但【最终回复】只输出下面两段，绝对不要包含任何查找/排查/推理过程、不要贴代码、不要写"我先看…我再核实…"这类思路叙述：\n` +
        `【问题原因】${isBug ? '一两句话说清根本原因' : '一两句话说清要实现什么及为何'}\n` +
        `【解决方案】3-5 条要点，每条一行，说明改哪里、怎么改\n` +
        `总字数控制在 400 字以内。`,
      {
        ...claudeAuthOpts(), // 跟随备用账号轮换（与 web run 同一 token 池）
        cwd: botCtx.cwd,
        permissionMode: 'default',
        allowedTools: ['Read', 'Grep', 'Glob'], // 只读，物理上无法改码/执行
        // 只累加为兜底；最终以 result（模型的最终回复）为准，避免把边查边说的探索过程写进摘要
        onText: (t) => (streamed += t),
        onResult: (i) => {
          if (i.result) out = i.result;
        },
      },
    );
    if (!out) out = streamed; // result 缺失时才回退到流式累加
  } catch (e) {
    out = `分析失败：${e?.message || String(e)}`;
    logger.error('task-ops', '✖ analyze', { id: task.id, err: e?.message || String(e) });
  }
  updateTask(task.id, { status: 'analyzed', analysis: { suggestion: out || '(无分析输出)' } }, '分析完成');
  logger.info('task-ops', '✔ analyze', { id: task.id });
  systemNotify(
    `分析完成 ${isBug ? '[故障]' : '[需求]'}`,
    `${task.title}\n可在 web 管理台确认：开始进行 / 修正 / 放弃`,
  );
}

/**
 * 开发：按分析在项目里实际改码（bypassPermissions），完成后可 git diff 审查。
 * 返回 { ok, log }：ok 表示 runClaude 是否成功（try 成功=true，catch=false），
 * 供调用方区分「完成/失败」通知。副作用不变（仍 updateTask + systemNotify）。
 * 向后兼容：web 端等旧调用忽略返回值不受影响。
 *
 * opts.deferStatus  为 true 时只写 devLog 不改 status（由 auto-dev runOne 在 commitAll 后自行推进终态）。
 * opts.cwd          auto-dev 管线传 auto 工作区路径；其余调用方不传，保持原目录。
 * opts.mainDir      auto-dev 传主工作区路径，供 scopeFix 澄清边界（避免中途切 bot 导致 botCtx.cwd 错配）。
 */
export async function develop(task, opts = {}) {
  logger.info('task-ops', '▶ develop', { id: task.id, type: task.type, title: task.title });
  const isBug = task.type === 'bug';
  const botCtx = botTaskContext();
  const cwd = opts.cwd || botCtx.cwd; // auto-dev 管线传 auto 工作区；其余调用方保持原目录
  // auto 工作区语境下修正边界提示：scopeSection 写死「仅限 projectDir 内修改」，与 cwd=auto 工作区矛盾
  // （可能引导 agent 按绝对路径改主工作区，击穿 worktree 隔离）→ 追加澄清段压制。
  // 用 opts.mainDir 引用主工作区路径，消除中途切 bot 导致 botCtx.cwd 错配的窗口。
  const mainDir = opts.mainDir || botCtx.cwd;
  const scopeFix = opts.cwd
    ? `\n【工作区说明】本次开发在独立任务工作区进行（当前目录 ${opts.cwd}），所有文件修改必须在当前目录内完成；` +
      `绝对不要按绝对路径修改 ${mainDir} 下的文件（那是主工作区，由管理员另行合并）。\n`
    : '';
  let out = '';
  let ok = true;
  try {
    await runClaude(
      `请在当前项目实际实现这个${isBug ? '修复' : '需求'}：\n` +
        `原始反馈：「${task.detail}」\n` +
        `分析建议：\n${task.analysis?.suggestion || '(无)'}\n\n` +
        `反馈中若含本地文件/图片路径（截图、附件、参考文档），请先用 Read 查看再动手。\n` +
        botCtx.scopeSection + scopeFix +
        `请修改代码完成它；完成后用一段话说明你改了哪些文件、做了什么。`,
      {
        ...claudeAuthOpts(), // 跟随备用账号轮换（与 web run 同一 token 池）
        cwd,
        permissionMode: 'bypassPermissions',
        onText: (t) => (out += t),
        onResult: (i) => {
          if (!out && i.result) out = i.result;
        },
      },
    );
  } catch (e) {
    ok = false;
    out = `开发出错：${e?.message || String(e)}`;
    logger.error('task-ops', '✖ develop', { id: task.id, err: e?.message || String(e) });
  }
  // deferStatus=true 时只写 devLog，不改 status——终态由调用方（auto-dev runOne）在提交后推进
  const updated = updateTask(
    task.id,
    opts.deferStatus ? { devLog: out || '(无输出)' } : { status: 'done', devLog: out || '(无输出)' },
    ok ? '开发完成' : '开发失败',
  );
  logger.info('task-ops', ok ? '✔ develop' : '✖ develop(已记录失败)', { id: task.id, ok });
  // deferStatus（auto-dev）路径下由 runOne 提交后统一通知终态；此处提前通知会与后续 commit 失败矛盾
  if (!opts.deferStatus) {
    systemNotify(
      `开发${ok ? '完成' : '失败'} ${isBug ? '[故障]' : '[需求]'}`,
      ok ? `${task.title}\n请在项目里 git diff 审查改动` : `${task.title}\n开发过程出错，请在管理台查看 devLog`,
    );
    // 飞书私聊卡片通知（管理员本人）。同样只在这一分支发：deferStatus 路径的终态卡片
    // 由 auto-dev runOne 在提交成功后发，两边都发就会双推同一个任务。
    notifyTaskDone(updated, ok);
  }
  return { ok, log: out };
}

// 单发材料（图/文件/文档）可归属到该用户最近提交的任务的时间窗口
const ATTACH_WINDOW_MS = 10 * 60 * 1000;

/**
 * 补材料后是否触发重新分析（纯函数，单测目标）。
 * 只有 new/analyzed 重跑分析；reviewing/challenged 不动状态（评审流/质疑应答正在用它，
 * 冲掉会导致「坚持修改」失效或与评审结果竞写）；analyzing 本就在分析中不重复起。
 * 材料已追加进 detail，后续 analyze/develop 天然可见，不重分析不丢信息。
 */
export function shouldReanalyzeOnAttach(status) {
  return status === 'new' || status === 'analyzed';
}

/**
 * 把单发材料归属到该用户最近（10 分钟内）提交且未开发的任务：
 * 按 kind 格式化追加到 detail；仅 new/analyzed 状态带材料重新分析（reviewing/challenged 不冲状态）。
 * @param {string} openId
 * @param {{ kind:'image'|'file'|'doc'|'text', path:string, title?:string }} material
 * @returns 归属到的 task，找不到返回 null（调用方入材料池或提示用户）
 */
export function attachMaterialToRecentTask(openId, material) {
  const cutoff = Date.now() - ATTACH_WINDOW_MS;
  const task = getTasks().find(
    (t) =>
      t.source?.openId === openId &&
      // 评审中/被质疑的任务同样未开发，补材料后一并进入后续评审与修复的上下文；
      // 评审否定后的 rejected 在挽回窗口内可能被「坚持修改」复活，材料也要能挂上
      //（条件与 feedback/logic.js isReviewableTask 的 rejected 分支保持一致：owner 手动毙掉的不算）
      (['new', 'reviewing', 'challenged', 'analyzing', 'analyzed'].includes(t.status) ||
        (t.status === 'rejected' && ['reject', 'ask'].includes(t.review?.verdict) && t.rejectedBy !== 'owner')) &&
      new Date(t.createdAt).getTime() >= cutoff,
  );
  if (!task) return null;
  const updated = updateTask(task.id, { detail: `${task.detail}\n${materialDetailLine(material)}` }, '补充材料');
  logger.info('task-ops', '补充材料', { id: task.id, kind: material.kind, path: material.path });
  // 仅 new/analyzed 触发重分析；reviewing/challenged/analyzing 跳过（防冲评审态/质疑态，detail 已留存供后续阶段读取）
  if (shouldReanalyzeOnAttach(task.status)) {
    analyze(updated).catch((e) =>
      logger.error('task-ops', '带材料重新分析失败', { id: task.id, err: e?.message || String(e) }),
    );
  }
  return updated;
}

/** 兼容旧调用：单发截图归属（等价于 kind:'image' 的材料） */
export function attachImageToRecentTask(openId, imagePath) {
  return attachMaterialToRecentTask(openId, { kind: 'image', path: imagePath });
}
