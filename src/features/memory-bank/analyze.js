/**
 * 单会话转录分析器 —— Phase 1 LLM 层。
 * 把 .jsonl 会话转录文件分析成 findings（bug / solution / pattern / preference）。
 * 复用 runClassifierOnce（额度耗尽 fail-fast / 30s 超时 / 单轮禁工具 / 首个 JSON 块提取）。
 */
import { runClassifierOnce } from '../../capabilities/llm-classify.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

/** 合法的 finding 类型。调用方可用来验证产出。 */
export const FINDING_TYPES = ['bug', 'solution', 'pattern', 'preference'];

const MAX_SUMMARY = 200;
const MAX_DETAIL = 500;
const MAX_CONVERSATION_CHARS = 8000;

/**
 * 从 JSONL 行里提取可读的对话文本。
 * 只取 type='user'|'assistant' 的条目；content 可为字符串或 content-block 数组。
 * @param {string} line 单行 JSONL
 * @returns {{role:string, text:string}|null}
 */
function parseLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (obj.type !== 'user' && obj.type !== 'assistant') return null;

  const role = obj.type === 'user' ? 'User' : 'Assistant';
  const content = obj.message?.content;
  let text = '';

  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    // content-block 数组：只取 text 类型，忽略工具调用、图片等
    text = content
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text || '')
      .join('');
  }

  text = text.trim();
  if (!text) return null;
  return { role, text };
}

/**
 * 纯函数。把会话转录文本构建为分析 prompt。
 * @param {string} transcript 会话 .jsonl 文件的原始文本
 * @returns {string}
 */
export function buildAnalysisPrompt(transcript) {
  const lines = (transcript || '').split('\n').filter(Boolean);
  const parts = [];

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    parts.push(`[${parsed.role}] ${parsed.text}`);
  }

  let conversation = parts.join('\n\n');
  if (conversation.length > MAX_CONVERSATION_CHARS) {
    conversation = conversation.slice(0, MAX_CONVERSATION_CHARS) + '\n...（内容已截断）';
  }

  return [
    '你是一个代码对话分析器。下面是一段开发对话记录，请从中提炼出有价值的发现（findings）。',
    '',
    '请找出以下类型的发现：',
    '- bug：发现的程序缺陷或错误',
    '- solution：解决问题的方案或修复方法',
    '- pattern：代码或设计模式、最佳实践',
    '- preference：用户的编程偏好或习惯',
    '',
    '仅输出一个 JSON 对象，不要任何解释文字。格式：',
    '{"findings":[{"type":"bug|solution|pattern|preference","summary":"简洁描述","detail":"详细说明（可选）"}]}',
    '',
    '硬约束：',
    '1. 没有值得记录的发现时，findings 返回空数组（{"findings":[]}）。宁缺毋滥。',
    '2. summary 必须简洁具体，不超过 200 字符。',
    '3. detail 可选，不超过 500 字符。',
    '4. type 必须是 bug / solution / pattern / preference 之一。',
    '',
    '对话记录：',
    '',
    conversation || '（无对话内容）',
  ].join('\n');
}

/**
 * 校验并归一化 LLM 返回的 findings 数组。任何非法输入返回空数组，不抛错。
 * @param {object} json LLM 返回的 JSON 对象
 * @returns {Array<{type:string, summary:string, detail:string}>}
 */
export function sanitizeFindings(json) {
  if (!json || !Array.isArray(json.findings)) return [];
  const out = [];
  for (const item of json.findings) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '');
    if (!FINDING_TYPES.includes(type)) continue;
    const summary = String(item.summary || '').trim();
    if (!summary) continue;
    const detail = String(item.detail || '').slice(0, MAX_DETAIL);
    out.push({
      type,
      summary: summary.slice(0, MAX_SUMMARY),
      detail,
    });
  }
  return out;
}

/**
 * 分析单个会话转录，提炼 findings。
 *
 * 返回值契约（与 extract.js 保持一致，调用方据此决定是否推进游标）：
 * - `null`   —— LLM 调用失败（超时/额度耗尽/解析失败）。调用方不应推进游标。
 * - `[]`     —— 调用成功，但模型判定此对话无值得记录的发现。正常完成，可推进游标。
 * - `[...]`  —— 调用成功且有发现。
 *
 * @param {string} transcript 会话 .jsonl 文件原始内容
 * @param {{model?:string, _runner?:Function}} opts
 *   `_runner` 仅供测试注入替换 `runClassifierOnce`，避免单测烧用户额度。
 * @returns {Promise<Array|null>} findings 数组；null 表示 LLM 调用失败
 */
export async function analyzeSession(transcript, opts = {}) {
  // 内容太短：空文件或只有几行头信息，无需分析
  if (!transcript || transcript.length < 100) return [];

  const { model, _runner = runClassifierOnce } = opts;

  const json = await _runner({
    prompt: buildAnalysisPrompt(transcript),
    model: model || config.intent.classifyModel,
    logTag: 'memory-bank/analyze',
  });

  if (!json) {
    logger.warn('memory-bank', '会话分析调用无结果（超时/额度/解析失败）');
    return null;
  }

  return sanitizeFindings(json);
}
