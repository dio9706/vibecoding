/**
 * 评审门 —— 中度/完全托管下，需求/故障进入处理流程前的 AI 评审。
 * AI 只读查证并打分（强制反方论证 + 判例 few-shot），判决由 decideVerdict 纯函数产出；
 * 每次判决记入判例库（review-log.jsonl），人工覆盖沉淀为后续校准素材。
 */
import { runClaude } from '../../../integrations/claude.js';
import { claudeAuthOpts } from '../../../features/token-rotation.js';
import { config } from '../../../shared/config.js';
import { logger } from '../../../shared/logger.js';
import { getActiveBot } from '../../../store/settings.js';
import { appendReviewVerdict, recentOverrides } from '../../../store/review-log.js';
import { decideVerdict, parseReviewJson, buildReviewPrompt } from './logic.js';

/**
 * 评审一条任务。
 * @returns {{ verdict: 'reject'|'ask'|'fix'|'plan', reason: string, scores: object|null }}
 */
export async function reviewTask(task) {
  const bot = getActiveBot();
  const projectDir = bot?.projectDir || config.feedback.frontendDir;
  logger.info('review', '▶ 评审', { id: task.id, type: task.type, title: task.title });

  let out = '';
  try {
    await runClaude(
      buildReviewPrompt(task, {
        projectDir,
        projectNotes: bot?.projectNotes || '',
        precedents: recentOverrides(5),
      }),
      {
        ...claudeAuthOpts(),
        cwd: projectDir,
        // dontAsk + allowedTools 才是真正的只读闸。allowedTools 本身只是「免确认」，
        // 不构成限制——文档原文：其余工具「still exist and fall through to the permission mode」。
        // 之前是 default，未列出的工具靠「恰好没传 canUseTool 回调」才被拒；
        // 哪天有人加了回调或改成 bypassPermissions，只读保证会静默失效。
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Grep', 'Glob'], // 只读查证
        persistSession: false, // 内部一次性调用不落盘 session
        onText: (t) => (out += t),
        onResult: (i) => {
          if (i.result) out = i.result;
        },
      },
    );
  } catch (e) {
    logger.error('review', '✖ 评审调用失败（落 ask）', { id: task.id, err: e?.message || String(e) });
  }

  const scores = parseReviewJson(out);
  const decision = decideVerdict(scores);
  appendReviewVerdict({ taskId: task.id, type: task.type, title: task.title, scores, verdict: decision.verdict });
  logger.info('review', '✔ 评审判决', { id: task.id, verdict: decision.verdict, reason: decision.reason });
  return { ...decision, scores };
}

/** 记录人工覆盖判例（challenged 后坚持修改 / owner 对质疑任务手动开发） */
export function recordOverride(task, override = 'proceed') {
  appendReviewVerdict({
    taskId: task.id,
    type: task.type,
    title: task.title,
    scores: task.review?.scores || null,
    verdict: task.review?.verdict || 'ask',
    override,
  });
}
