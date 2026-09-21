/**
 * 后端同事消息自动处理 —— 分类编排（四期）。
 *
 * 入口 autoHandleMessages 由路由 /api/req/colleague-messages/auto 在校验通过后 fire-and-forget 调用。
 * 逐条：有附件走接口文档识别，无附件走文字判定；命中则登记 / 入队 colleague-dev / 回同事一句。
 * 任何分类失败（超时 / 额度耗尽 / 解析不出 / 缺字段）一律视同「不处理」：同事手里已有三期那条 ACK，
 * 主机 web 端也能看到原消息 —— 退化到三期行为，不会更糟。**不重试**。
 *
 * deps 注入：分类是真实 SDK 调用、回复是真实飞书调用，单测只能用替身。默认实现见 defaultDeps。
 */
import fs from 'node:fs';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { runClassifierDetailed } from '../../capabilities/llm-classify.js';
import { docxToMdFile } from '../../integrations/docx.js';
import { getThread } from '../../store/colleague-messages.js';
import { buildApiFixPrompt } from './req-logic.js';
import { enqueueSystemTask, registerApiDoc } from './requirement-ops.js';
import { replyColleague, COLLEAGUE_DEV_KIND } from './colleague-dev.js';
import {
  isApiDocCandidate,
  extOf,
  API_DOC_SAMPLE_CHARS,
  buildApiDocClassifyPrompt,
  parseApiDocVerdict,
  buildTextClassifyPrompt,
  parseTextVerdict,
  buildColleagueDevPrompt,
} from './colleague-auto.logic.js';

const defaultDeps = {
  // 用 Detailed 而不是 Once：超时 / 额度耗尽 / 解析不出在 llm-classify 里大半是静默的，
  // 这里不留一行 warn，主机排查「后端发了消息为啥没反应」时只会看到 skip:no-action、误以为是模型判定
  classify: async (prompt, logTag) => {
    const { data, reason } = await runClassifierDetailed({ prompt, model: config.intent.classifyModel, logTag });
    if (reason) logger.warn('colleague-auto', '分类失败，视同不处理', { logTag, reason });
    return data;
  },
  /**
   * 读取文件开头作分类样本；docx 先转 md（转出的 md 路径同时也是登记给 Claude Read 的路径）。
   * 返回 null = 读不到；抛错（docx 解析失败等）由上层 catch 记 'error' 标签（warn 级日志）。
   */
  readSample: async (file) => {
    let p = file?.path;
    if (!p || !fs.existsSync(p)) return null;
    if (extOf(file.name) === 'docx') p = await docxToMdFile(p, file.name);
    return { path: p, sample: fs.readFileSync(p, 'utf8').slice(0, API_DOC_SAMPLE_CHARS) };
  },
  register: registerApiDoc,
  enqueue: enqueueSystemTask,
  reply: replyColleague,
};

async function handleFileMessage(req, colleagueId, m, d) {
  const file = m.files[0];
  if (!isApiDocCandidate(file.name)) return 'skip:ext';
  const s = await d.readSample(file);
  if (!s) return 'skip:unreadable';
  const verdict = await d.classify(buildApiDocClassifyPrompt({ fileName: file.name, sample: s.sample }), 'colleague-auto/apidoc');
  if (!parseApiDocVerdict(verdict)) return 'skip:not-apidoc';
  const reg = await d.register(req, { name: file.name, path: s.path });
  if (!reg.ok) {
    logger.warn('colleague-auto', '接口文档登记失败', { reqId: req.id, msgId: m.id, error: reg.error });
    return 'skip:register-failed';
  }
  d.enqueue(req.id, COLLEAGUE_DEV_KIND, {
    msgId: m.id,
    colleagueId,
    prompt: buildApiFixPrompt({ action: reg.action, doc: reg.doc }),
    title: '接入接口文档：' + file.name,
  });
  // 入队已是不可逆副作用；回复失败只 warn，标签仍如实记 queued（onSettle 收尾时还会补简报）
  await d
    .reply(req.id, colleagueId, `接口文档「${file.name}」已收到，开始接入开发`)
    .catch((e) => logger.warn('colleague-auto', '回复同事失败', { reqId: req.id, msgId: m.id, err: e?.message || String(e) }));
  return 'queued:apidoc';
}

async function handleTextMessage(req, colleagueId, m, d) {
  const text = (m.text || '').trim();
  if (!text) return 'skip:empty';
  const verdict = parseTextVerdict(await d.classify(buildTextClassifyPrompt({ reqTitle: req.title, text }), 'colleague-auto/text'));
  if (!verdict) return 'skip:no-action';
  d.enqueue(req.id, COLLEAGUE_DEV_KIND, {
    msgId: m.id,
    colleagueId,
    // 固定模板同时带原话与提炼：Haiku 漏掉的字段名靠原话找回（见 buildColleagueDevPrompt 注释）
    prompt: buildColleagueDevPrompt({ reqTitle: req.title, original: text, task: verdict.prompt }),
    title: '后端沟通：' + verdict.summary,
  });
  // 入队已是不可逆副作用；回复失败只 warn，标签仍如实记 queued（onSettle 收尾时还会补简报）
  await d
    .reply(req.id, colleagueId, `已收到，正在接入处理：${verdict.summary}`)
    .catch((e) => logger.warn('colleague-auto', '回复同事失败', { reqId: req.id, msgId: m.id, err: e?.message || String(e) }));
  return 'queued:text';
}

/**
 * @param {object} req 需求记录（调用方已校验 phase==='dev'）
 * @param {string} colleagueId
 * @param {string[]} msgIds 候选消息 id；不属于该线程 / dir!=='in' / 已 handled 的静默过滤
 * @param {object} [deps] 测试注入
 * @returns {Promise<string[]>} 逐条结果标签（顺序与过滤后的消息一致），供日志与测试
 */
export async function autoHandleMessages(req, colleagueId, msgIds, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const wanted = new Set(Array.isArray(msgIds) ? msgIds : []);
  const targets = getThread(req.id, colleagueId).messages.filter((m) => wanted.has(m.id) && m.dir === 'in' && !m.handledBy);
  const out = [];
  for (const m of targets) {
    try {
      const r = m.files?.length ? await handleFileMessage(req, colleagueId, m, d) : await handleTextMessage(req, colleagueId, m, d);
      logger.info('colleague-auto', '同事消息判定', { reqId: req.id, msgId: m.id, result: r });
      out.push(r);
    } catch (e) {
      logger.warn('colleague-auto', '单条处理异常，跳过', { reqId: req.id, msgId: m.id, err: e?.message || String(e) });
      out.push('error');
    }
  }
  return out;
}
