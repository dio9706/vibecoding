/**
 * 工具开关目录（纯数据 + 分叉函数）—— 🔧 工具弹层「内置工具」按 provider 展示真实可用的工具集。
 *
 * 为什么分叉：
 *  - Claude 路径（claude-agent SDK）：工具由 SDK 提供，禁用经 run-claude 的别名表归一
 *    （如 MultiEdit→Edit），此处 id 与 TOOL_DISABLE_ALIASES 的**逻辑名**一致；
 *  - 自定义模型路径（openai-compat）：工具是本仓自研装配（`providers/builtin-tools.js` 六件套 +
 *    `capabilities/feishu-ask-tools.js` 委托同事 + 可选 RepoMap），**没有** WebSearch/WebFetch/
 *    Task/Workflow/TodoWrite，也没有 Skills 机制。把 Claude 的清单拿来展示会误导用户：
 *    关了什么都没发生、真正存在的 Glob/RepoMap/问同事又关不掉。
 *
 * disabledTools 是一份全局数组（uiPrefs.disabledTools），按**逻辑名**判：
 *  - Claude 路径经 run-claude 的别名表归一后匹配；
 *  - openai 路径由 `capabilities/tool-policy.logic.js#decideToolAction` 按工具名直接匹配。
 * 两边同名工具（Read/Write/Edit/Grep/Bash）共享开关，跨 provider 的 id 互不影响。
 */

/** Claude 路径的内置工具开关（与 run-claude.js TOOL_DISABLE_ALIASES 保持同一套逻辑名） */
export const CLAUDE_BUILTIN_TOOLS = Object.freeze([
  { id: 'Bash',      label: 'Bash',    desc: '执行终端命令' },
  { id: 'Write',     label: '写入',    desc: '创建/覆盖文件' },
  { id: 'Edit',      label: '编辑',    desc: '修改文件内容（含 MultiEdit）' },
  { id: 'Read',      label: '读取',    desc: '读取文件内容（含 NotebookRead）' },
  { id: 'Grep',      label: '搜索',    desc: '搜索文件（含 Glob / LS）' },
  { id: 'WebSearch', label: '网页搜索', desc: '搜索互联网' },
  { id: 'WebFetch',  label: '网页抓取', desc: '获取网页内容' },
  { id: 'Task',      label: '子代理',  desc: '启动子任务代理（含 Agent）' },
  { id: 'Workflow',  label: '工作流',  desc: '多智能体编排（ultracode 触发，可拉起多个子代理）' },
  { id: 'TodoWrite', label: '任务清单', desc: '管理待办清单' },
]);

/** 自定义模型（openai-compat）路径真实装配的工具：builtin-tools 七件套 + 联网 + 子代理 + 委托同事 */
export const OPENAI_BUILTIN_TOOLS = Object.freeze([
  { id: 'Read',  label: 'Read',  desc: '读取文件/列目录（带行号，可分段读大文件）' },
  { id: 'Write', label: '写入',  desc: '创建或整体覆盖文件' },
  { id: 'Edit',  label: '编辑',  desc: '文件内精确字符串替换' },
  { id: 'Glob',  label: 'Glob',  desc: '按通配符查找文件路径（**、*、?、{a,b}）' },
  { id: 'Grep',  label: '搜索',  desc: '按正则搜索文件内容（文件:行号:内容）' },
  { id: 'Bash',  label: 'Bash',  desc: '在工作目录执行 shell 命令（测试/构建/git）' },
  { id: 'RepoMap', label: '仓库地图', desc: '查询代码地图（git 仓库且「仓库地图」开启时可用）' },
  { id: 'WebFetch',  label: '网页抓取', desc: '抓网页转可读文本（网络类：询问档需审批，自动档放行）' },
  { id: 'WebSearch', label: '网页搜索', desc: '联网搜索（需在设置页「联网搜索」配置 API key；网络类审批）' },
  { id: 'TodoWrite', label: '任务清单', desc: '更新任务清单（显示在任务面板）' },
  { id: 'Task',      label: '子代理',  desc: '派只读子代理独立调查（不能写文件或执行命令）' },
  { id: 'AskColleague',       label: '问同事',    desc: '委托同事对话：发卡片提问（需同事名册与飞书配置）' },
  { id: 'WaitColleagueReply', label: '等同事回复', desc: '等待「问同事」的结论（免审批）' },
]);

/** 当前 provider 的工具清单（未知 provider 按 Claude 处理，与 chat.js 的缺省分支一致） */
export function builtinToolsFor(provider) {
  return provider === 'openai-compat' ? OPENAI_BUILTIN_TOOLS : CLAUDE_BUILTIN_TOOLS;
}
