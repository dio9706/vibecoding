/**
 * Phase 2 合成器 —— 把多个会话的 findings 批量提炼为 memories（长期记忆）。
 * 复用 runClassifierOnce 骨架（额度耗尽 fail-fast / 30s 超时 / 单轮禁工具）。
 * findings 由 analyze.js（Phase 1）产出；memories 写入 src/store/memory-bank.js。
 */
import { runClassifierOnce } from '../../capabilities/llm-classify.js';
import { addMemory } from '../../store/memory-bank.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

/** 合法的 memory 分类。调用方可用来验证产出。 */
export const MEMORY_CATEGORIES = ['collaboration', 'code-style', 'writing', 'dialogue', 'tech-pref'];

const MAX_STATEMENT = 300;
const MAX_REASONING = 300;

/**
 * 纯函数。把 findings 数组构建为合成 prompt。
 * @param {Array<{type:string, summary:string, detail?:string, sessionPath?:string}>} findings
 * @returns {string}
 */
export function buildSynthesisPrompt(findings) {
  const list = Array.isArray(findings) ? findings : [];

  const items = list
    .map((f, i) => {
      const type = String(f?.type || '');
      const summary = String(f?.summary || '').trim();
      const detail = String(f?.detail || '').trim();
      return `[${i + 1}] type=${type}\n  summary: ${summary}${detail ? `\n  detail: ${detail}` : ''}`;
    })
    .join('\n\n');

  return [
    '你是一个用户偏好提炼器。下面是从多个开发对话会话中提炼的发现（findings）。',
    '请从中识别出值得长期记住的偏好、模式或规则，并合成为记忆条目（memories）。',
    '',
    '重要原则：',
    '1. 不是每个 finding 都需要变成 memory，要有选择性。只保留真正具有长期价值的条目。',
    '2. statement 必须是具体可执行的规则，不能是模糊描述。',
    '3. category 必须从以下值中选一个：collaboration / code-style / writing / dialogue / tech-pref',
    '   - collaboration：协作方式、沟通风格、工作流程偏好',
    '   - code-style：代码风格、命名规范、格式习惯',
    '   - writing：文档、注释、提交信息的写作风格',
    '   - dialogue：对话风格、反馈偏好、交互习惯',
    '   - tech-pref：技术选型、框架/库偏好、工具链选择',
    '',
    '仅输出一个 JSON 对象，不要任何解释文字。格式：',
    '{"memories":[{"category":"tech-pref","statement":"具体规则描述","reasoning":"为什么值得记住（可选）"}]}',
    '',
    '硬约束：',
    '1. 无值得记录的内容时，memories 返回空数组（{"memories":[]}）。宁缺毋滥。',
    '2. statement 不超过 300 字符，必须简洁具体。',
    '3. reasoning 可选，不超过 300 字符。',
    '4. category 必须是上述五个值之一，否则该条目无效。',
    '',
    `共 ${list.length} 条 findings：`,
    '',
    items || '（无 findings 内容）',
  ].join('\n');
}

/**
 * 校验归一化 LLM 返回的 memories。任何非法输入返回空数组，不抛错。
 * @param {object} json
 * @returns {Array<{category:string, statement:string, reasoning:string}>}
 */
export function sanitizeMemories(json) {
  if (!json || !Array.isArray(json.memories)) return [];
  const out = [];
  for (const item of json.memories) {
    if (!item || typeof item !== 'object') continue;
    const category = String(item.category || '').trim();
    if (!MEMORY_CATEGORIES.includes(category)) continue;
    const statement = String(item.statement || '').trim();
    if (!statement) continue;
    const reasoning = String(item.reasoning || '').slice(0, MAX_REASONING);
    out.push({
      category,
      statement: statement.slice(0, MAX_STATEMENT),
      reasoning,
    });
  }
  return out;
}

/**
 * Phase 2 主函数：把 findings 合成为 memories，写入 memory-bank。
 *
 * 返回值契约（与 analyze.js 保持一致）：
 * - `null`   —— LLM 调用失败（超时/额度耗尽/解析失败）。
 * - `[]`     —— 调用成功，但无值得记录的 memory。
 * - `[...]`  —— 调用成功且有新 memory 写入。
 *
 * @param {Array} findings 来自多个会话的 findings
 * @param {{model?:string, _runner?:Function}} opts
 *   `_runner` 仅供测试注入替换 `runClassifierOnce`，避免单测烧用户额度。
 * @returns {Promise<Array|null>} 新增的 memory 对象数组；null 表示 LLM 调用失败
 */
export async function synthesizeMemories(findings, opts = {}) {
  if (!Array.isArray(findings) || findings.length === 0) return [];

  const { model, _runner = runClassifierOnce } = opts;

  const json = await _runner({
    prompt: buildSynthesisPrompt(findings),
    model: model || config.intent.classifyModel,
    logTag: 'memory-bank/synthesize',
  });

  if (!json) {
    logger.warn('memory-bank', '合成调用无结果（超时/额度/解析失败）');
    return null;
  }

  const candidates = sanitizeMemories(json);
  const written = [];

  for (const c of candidates) {
    const memory = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      category: c.category,
      statement: c.statement,
      reasoning: c.reasoning,
      createdAt: Date.now(),
      source: 'synthesized',
    };
    try {
      addMemory(memory);
      written.push(memory);
    } catch (e) {
      logger.warn('memory-bank', '写入 memory 失败', { id: memory.id, err: e?.message });
    }
  }

  return written;
}
