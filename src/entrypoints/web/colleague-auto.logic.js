/**
 * 后端同事消息自动处理的纯逻辑（零 IO）：分类 prompt / 输出解析 / 子会话提示词 / 简报文案 / 子会话 id。
 *
 * 为什么单独成文件：编排层 colleague-auto.js 全是 LLM 与落盘调用，无法直测；
 * 这里的每个函数都是「输入 → 输出」，测试钉住契约后编排层只需接线。
 */

/** 接口文档候选扩展名：本仓能抽出文本的格式。pdf 无抽取能力、图片无意义，都不在列 → 走三期归档。
 *  不导出：外部只该问 isApiDocCandidate，直接暴露集合会诱使调用方自己写第二套判定 */
const API_DOC_EXTS = new Set(['md', 'txt', 'json', 'yaml', 'yml', 'docx']);

/** 喂给分类器的样本长度。接口文档头几千字就足够判定形态，整份喂进去只是烧 token */
export const API_DOC_SAMPLE_CHARS = 4000;

/** 回给同事的简报上限。飞书私聊里一屏能读完的量 */
export const BRIEF_MAX_CHARS = 200;

/** summary 上限。prompt 文案与解析器共用一份，改一处两边同步（兄弟文件 req-quiz.logic 的 QUIZ_MAX 同款做法） */
export const SUMMARY_MAX_CHARS = 30;

/** 按「字符」而非 UTF-16 码元截断：Claude 结果里常见 emoji，从代理对中间切开飞书会渲染成乱码 */
function clipChars(s, n) {
  const chars = Array.from(s);
  return chars.length > n ? { text: chars.slice(0, n).join(''), clipped: true } : { text: s, clipped: false };
}

/** 小写扩展名（不含点）；无扩展名 / 空 / 非字符串归空串 */
export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || '').trim());
  return m ? m[1].toLowerCase() : '';
}

/** 能抽出文本的格式才是接口文档候选；其余走三期归档 */
export function isApiDocCandidate(name) {
  return API_DOC_EXTS.has(extOf(name));
}

/** @param {{fileName: string, sample: string}} p sample 由编排层按 API_DOC_SAMPLE_CHARS 截好再传入 */
export function buildApiDocClassifyPrompt({ fileName, sample }) {
  return (
    `下面是一份文件「${fileName}」的开头部分。判断它是否是**后端接口 / API 文档**。\n\n` +
    `算：文档**主体**是接口定义 —— 请求路径 + 方法 + 参数 / 返回字段（表格或示例），或 OpenAPI / Swagger / Postman 导出。\n` +
    `不算：需求文档、会议纪要、项目 README、部署 / 环境说明、数据库表结构、前端组件文档、mock 数据或配置文件、代码片段。\n` +
    `以内容为准，文件名与发送方身份仅供参考。\n\n` +
    `文件开头：\n「${sample}」\n\n` +
    `只输出一个 JSON 对象，不要代码围栏，不要解释：{"isApiDoc": true} 或 {"isApiDoc": false}`
  );
}

/** 只认字面 true：模型偶尔输出 "true" 字符串，那不是肯定回答 */
export function parseApiDocVerdict(data) {
  return data?.isApiDoc === true;
}

/**
 * @param {{reqTitle: string, text: string}} p
 * 三条硬性要求的由来：产物会经 buildColleagueDevPrompt 喂给在前端仓库里跑的 Claude ——
 * Haiku 看不到前端代码，编出来的「实现方案」只会误导；改写字段名则永远找不回来；
 * 字符串里的裸换行会让 JSON.parse 抛错、整条被静默归「不处理」（llm-classify 的 unparsable 路径）。
 */
export function buildTextClassifyPrompt({ reqTitle, text }) {
  return (
    `这是需求「${reqTitle}」的后端开发同事对前端说的一段话：\n「${text}」\n\n` +
    `判断它是否包含**需要前端修改代码才能配合**的具体信息（接口变更、字段增删改名、返回结构调整、联调时发现的问题等）。\n` +
    `纯沟通、确认、提问、闲聊、「收到」「好的」这类都算不需要。\n\n` +
    `若需要处理，prompt 字段是写给前端开发 AI 的任务描述，硬性要求：\n` +
    `- 原话里出现的接口路径、字段名、类型、枚举值**必须原文保留**，不得改写或省略；\n` +
    `- 只转述后端说了什么、前端需要核对或配合的点；**不要编造**前端的具体文件或实现方案，不确定处写「需在代码中查证」；\n` +
    `- 写成单段，分点用分号。\n\n` +
    `只输出一个 JSON 对象，不要代码围栏，不要解释，**所有字符串值内不要换行**：\n` +
    `{"needsAction": true|false, "summary": "一句话概括这次改动（不超过 ${SUMMARY_MAX_CHARS} 字）", "prompt": "任务描述；不需要则空字符串"}`
  );
}

/**
 * 文字判定 → {summary, prompt} 或 null（不处理）。
 * needsAction 为真但 prompt 空也归 null：没有任务描述的 run 只会让 Claude 反问一句就结束，白烧额度。
 * summary 会成为子会话标题，压平内部空白：模型偶尔在 30 字里塞换行。
 */
export function parseTextVerdict(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.needsAction !== true) return null;
  const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
  if (!prompt) return null;
  const rawSummary = typeof data.summary === 'string' ? data.summary.trim() : '';
  // 回落到 prompt 时同样压平：模型违约带了换行，也不该原样进会话标题
  const summarySrc = (rawSummary || prompt).replace(/\s+/g, ' ').trim();
  return { summary: clipChars(summarySrc, SUMMARY_MAX_CHARS).text, prompt };
}

/** 回同事的简报。成功时压平空白再截断；失败时不透传错误细节（那是主机该看的） */
export function buildBrief(ok, resultText) {
  if (!ok) return '接入遇到问题，已转主机处理';
  const t = String(resultText || '').replace(/\s+/g, ' ').trim();
  if (!t) return '已处理完成';
  const { text, clipped } = clipChars(t, BRIEF_MAX_CHARS);
  return '已处理完成：' + text + (clipped ? '…' : '');
}

/**
 * 子会话真正喂给 Claude 的任务提示词：固定模板**同时**承载后端原话与 Haiku 的提炼。
 * 只给提炼不给原话，Haiku 漏掉或改写的字段名就永远找不回来；Claude 在前端仓库里对照原话查证更稳。
 * 「只读参考工程禁止修改」与 req-logic#buildBugFixPrompt 同一口径。
 */
export function buildColleagueDevPrompt({ reqTitle, original, task }) {
  return (
    `【后端同事沟通 · 需求「${reqTitle}」】\n\n` +
    `后端原话：\n「${original}」\n\n` +
    `提炼出的前端任务：\n${task}\n\n` +
    `请以原话为准核对上面的提炼，在本工程里定位相关调用并完成对应修改；只读参考工程禁止修改。修改后自查。`
  );
}

/**
 * 服务端生成的子会话 id。前端 createReqConv 是 `'c' + Date.now()`（c + 13 位数字），
 * 这里多拖 3 位字母数字，两边天然不撞；openConv 不校验 id 格式。
 * padEnd：Math.random 的 36 进制表示偶尔不足 3 位小数，不补齐会让长度契约偶发失守。
 */
export function newSubConvId(now = Date.now()) {
  return 'c' + now + Math.random().toString(36).slice(2, 5).padEnd(3, '0');
}
