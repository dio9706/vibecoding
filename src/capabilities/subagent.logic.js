/**
 * 只读子代理（Task 工具）纯函数层：工具子集过滤 + 子代理 system prompt + 工具定义。
 * 运行时（嵌套 agent-loop、审批复用、abort 传播）在 `entrypoints/web/run-openai.js` 装配。
 *
 * 只读口径（拍板）：子代理只能用 Read/Glob/Grep/WebFetch/WebSearch/RepoMap——
 * 写/命令（Write/Edit/Bash）、清单（TodoWrite）、委托同事与 MCP 一律剥掉；
 * **Task 本身不在子集里 → 天然禁递归**（子代理不能再派子代理）。
 */
import { z } from 'zod';

/** 允许子代理使用的工具名（顺序即宣传口径，无执行语义） */
export const READONLY_SUBAGENT_TOOL_NAMES = Object.freeze(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'RepoMap']);

/** 从已装配的工具定义里挑出只读子集（名称匹配；未知工具一律不计入） */
export function pickReadonlyToolDefs(defs) {
  const src = defs && typeof defs === 'object' ? defs : {};
  const out = {};
  for (const name of READONLY_SUBAGENT_TOOL_NAMES) {
    if (Object.hasOwn(src, name)) out[name] = src[name];
  }
  return out;
}

/** 子代理 system prompt：角色（只读探查）、工作目录、交付要求 */
export function buildSubagentSystemPrompt({ cwd } = {}) {
  return [
    '你是一个只读探查子代理：只能读取、搜索、抓取与查询代码地图，不能写文件或执行命令。',
    cwd ? `工作目录：${cwd}（相对路径基于它解析）。` : '',
    '要求：围绕交给你的任务尽可能自主查证，完成或确认无法完成后，输出一份简洁结论：',
    '做了什么、找到的事实（文件/行号/关键代码/链接）、结论与建议。不要输出无关寒暄。',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Task 工具定义（Claude 式参数命名：description 短说明 + prompt 具体任务） */
export const SUBAGENT_TOOL_DEF = Object.freeze({
  description:
    '派一个只读探查子代理去独立完成一项调查（读文件/搜索/抓网页/查仓库地图），返回结论。' +
    '适合「先摸清某个问题再动手」；子代理不能写文件或执行命令。',
  inputSchema: z.object({
    description: z.string().describe('三五个词的短说明（展示用）'),
    prompt: z.string().describe('交给子代理的具体任务与期望产出'),
  }),
});
