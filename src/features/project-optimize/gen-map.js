/**
 * 地图生成执行层：事实包 → 只读沙箱 → 质量闸 → 交出正文。
 *
 * **本模块不写任何文件**，只返回文本。写盘归 fix-map.js。
 * 这个分工是只读沙箱设计的直接推论：模型没有写工具，产出必然要经过 Node 的手，
 * 而经过 Node 的手就意味着备份、幂等、质量闸三件事都能在写盘前统一把关。
 *
 * 从不抛错：调用方处在优化流程中途，一切失败通过返回值的 ok/reason 表达。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runReadonlyAgent } from '../llm-readonly-agent.js';
import { logger } from '../../shared/logger.js';
import { collectRootFacts, collectModuleFacts } from './map-facts.js';
import {
  MAP_SYSTEM_PROMPT, buildRootMapPrompt, buildModuleMapPrompt, buildStaleAuditPrompt,
  validateRootMap, validateModuleMap, validateStaleFindings,
} from './gen-map.logic.js';

/**
 * 失败原因转中文说法。
 *
 * 分开归因的理由同 llm-classify.js 的 classifyOutcome 注释记录的事故：那次把「超时」
 * 说成「没听懂」，用户一遍遍改说法而毫无用处。这里同理——「额度耗尽」要用户去换账号，
 * 「模型没按格式返回」要用户重试，两者混为一谈会把人引进死路。
 */
const REASON_TEXT = {
  exhausted: 'token 池额度耗尽，未发起生成',
  cancelled: '用户取消了优化',
  timeout: '生成超时',
  unparsable: '模型未按要求返回 JSON',
};

const failed = (reason) => ({ ok: false, markdown: '', reason });

/** 模型试图越权时留一条日志：不影响结果（已被拦下），但能解释「为什么这次生成质量差」 */
function logDenied(logTag, denied) {
  if (!denied?.length) return;
  logger.warn('gen-map', '模型尝试调用非只读工具（已拦截）', { logTag, tools: [...new Set(denied)] });
}

/**
 * 跑一次生成并做质量闸。三种失败——调用失败 / 字段缺失 / 闸没过——都归一成 {ok:false}。
 *
 * @param {object} args
 * @param {string} args.field 期望的 JSON 字段名
 * @param {(v:unknown)=>{ok:boolean,reason:string}} args.validate
 */
async function generateAndValidate({ prompt, cwd, logTag, signal, field, validate }) {
  const { data, reason, denied } = await runReadonlyAgent({
    prompt, cwd, logTag, signal, systemPrompt: MAP_SYSTEM_PROMPT,
  });
  logDenied(logTag, denied);

  if (!data) return { ok: false, value: null, reason: REASON_TEXT[reason] || '生成失败' };

  const value = data[field];
  const v = validate(value);
  if (!v.ok) {
    // 质量闸拦下的产出要留证据：闸的判据可能需要按真实项目调整，
    // 只记「被拒了」而不记内容的话，事后无从判断是模型的问题还是判据太严
    logger.warn('gen-map', '产出未通过质量闸，不写文件', {
      logTag, reason: v.reason, preview: String(value ?? '').slice(0, 200),
    });
    return { ok: false, value: null, reason: v.reason };
  }
  return { ok: true, value, reason: '' };
}

/**
 * 生成根 CLAUDE.md 正文。
 *
 * @param {string} projectDir
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok:boolean, markdown:string, reason:string}>}
 */
export async function generateRootMap(projectDir, { signal } = {}) {
  const out = await generateAndValidate({
    prompt: buildRootMapPrompt(collectRootFacts(projectDir)),
    cwd: projectDir,
    logTag: 'optimize/map:root',
    signal,
    field: 'markdown',
    validate: validateRootMap,
  });
  return out.ok ? { ok: true, markdown: out.value.trim(), reason: '' } : failed(out.reason);
}

/**
 * 生成模块 CLAUDE.md 正文。
 *
 * @param {string} moduleRel 形如 'src/features'
 */
export async function generateModuleMap(projectDir, moduleRel, { signal } = {}) {
  const out = await generateAndValidate({
    prompt: buildModuleMapPrompt(moduleRel, collectModuleFacts(projectDir, moduleRel)),
    cwd: projectDir,
    logTag: `optimize/map:${moduleRel}`,
    signal,
    field: 'markdown',
    validate: validateModuleMap,
  });
  return out.ok ? { ok: true, markdown: out.value.trim(), reason: '' } : failed(out.reason);
}

/**
 * 核对一份过期地图，产出差异条目（不产出新地图正文）。
 *
 * @param {string} mapRel 地图相对路径，如 'src/a/CLAUDE.md'
 * @returns {Promise<{ok:boolean, findings:string[], reason:string}>}
 */
export async function generateStaleFindings(projectDir, mapRel, { signal } = {}) {
  let body = '';
  try {
    body = fs.readFileSync(path.join(projectDir, mapRel), 'utf8');
  } catch (e) {
    return { ok: false, findings: [], reason: `读不到地图文件：${e?.message || String(e)}` };
  }

  // 根地图的 dirname 是 '.'，此时该喂根事实包而不是去扫一个叫 '.' 的模块
  const moduleRel = path.dirname(mapRel).replace(/\\/g, '/');
  const facts = moduleRel === '.' ? collectRootFacts(projectDir) : collectModuleFacts(projectDir, moduleRel);

  const logTag = `optimize/stale:${mapRel}`;
  const { data, reason, denied } = await runReadonlyAgent({
    prompt: buildStaleAuditPrompt(mapRel, body, facts),
    cwd: projectDir,
    logTag,
    signal,
    systemPrompt: MAP_SYSTEM_PROMPT,
  });
  logDenied(logTag, denied);

  if (!data) return { ok: false, findings: [], reason: REASON_TEXT[reason] || '核对失败' };

  const v = validateStaleFindings(data.findings);
  if (!v.ok) return { ok: false, findings: [], reason: v.reason };
  return { ok: true, findings: v.findings, reason: '' };
}
