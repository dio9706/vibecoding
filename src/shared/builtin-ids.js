/**
 * 内置能力（MCP / Skills）的 id 白名单 —— settings 的 normalize 与
 * capabilities 侧的内置注册表共用同一份常量，防「注册表加了新项、normalize 却把它丢掉」
 * 这类两处漂移（表现为：设置页能开、重启后状态消失）。
 *
 * 只放 id；描述/命令/默认值都在各自注册表（capabilities/builtin-mcp.js 等）里。
 */
export const BUILTIN_MCP_IDS = Object.freeze(['context7', 'figma-devmode', 'figma-framelink']);

// superpowers 的注册与装载在 Phase 2（fetch 脚本 + SDK plugins 接线）；id 先占位，settings 可先存状态
export const BUILTIN_SKILL_IDS = Object.freeze(['superpowers']);

/**
 * Superpowers 技能白名单（目录名 = 技能 id）：fetch 脚本只拷这些、per-skill 开关只认这些、
 * 设置页子开关也由此生成。定义在 shared 的原因：store 的 normalize 要过滤 disabledSkills，
 * 而 store 不能向上 import capabilities（分层单向依赖）。
 * 顺序 = 拷贝顺序与 UI 顺序；增删只改这一处。
 */
export const SUPERPOWERS_SKILL_IDS = Object.freeze([
  'using-superpowers',
  'brainstorming',
  'writing-plans',
  'executing-plans',
  'test-driven-development',
  'systematic-debugging',
  'verification-before-completion',
  'requesting-code-review',
  'receiving-code-review',
  'subagent-driven-development',
  'using-git-worktrees',
  'finishing-a-development-branch',
]);
