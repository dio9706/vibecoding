/**
 * 同事侧对话 Agent 插件。
 *
 * **P3 Task 6 挂上 feature**：飞书文本入口经 dispatch 接管到这里（order 35；上一代
 * `colleague-relay` 插件已在 P3 下线）。附件不走 dispatch，直接由 `entrypoints/feishu/index.js` 调
 * `relay.js`（两条链路共用同一份判定，见该文件头）。
 *
 * 工具在**模块加载时**注册（与 `shared/card-actions.js` 的卡片回调同一范式）：
 * 插件停用 → 本文件不被 import → 工具自然缺席，不需要额外写开关。
 *
 * ⚠️ web 进程不走插件装配层：`loadEnabledPluginFeatures` 只被 `src/features/index.js`
 * 调用，后者只被 `src/app/dispatch.js` import，而 web 入口对 `app/` 零引用。
 * 所以 web 进程必须**显式 import 本文件**才会注册上工具（`features` 数组在那条路径
 * 上不被消费，见文件末尾 default 导出的注释）。
 */
import { registerAgentTool } from '../../capabilities/agent-tools.js';
import { ROLES } from '../../store/colleagues.js';
import { buildReqReadTools } from './tools/req-read.js';
import { buildReqWriteTools } from './tools/req-write.js';
import feature from './feature.js';

const ROLE_IDS = new Set(ROLES.map((r) => r.id));

/**
 * 角色名的**语义**校验 —— 注册表那层只校验形状（非空字符串），拼错的角色名（如 'Backend'）
 * 形状合法、挡不住：注册成功，但 filterToolsByRole 对任何角色都过滤掉它 ——
 * 能力消失且全链路零信号。这里是唯一能合法 import ROLES 的地方（业务层），
 * 所以这道闸必须在这里。启动期硬抛，不拖到运行时。
 */
export function assertRoles(def) {
  const bad = def.roles.filter((r) => r !== '*' && !ROLE_IDS.has(r));
  if (bad.length)
    throw new Error(
      `colleague-agent: 工具 ${def.name} 的 roles 含非法角色 id：${bad.join(', ')}（合法值：*, ${[...ROLE_IDS].join(', ')}）`,
    );
}

for (const def of [...buildReqReadTools(), ...buildReqWriteTools()]) {
  assertRoles(def);
  registerAgentTool(def);
}

// order 35：在 action-runner(30) 之后、feedback(40) 之前。
// 注意：feature 只在**走 dispatch 的进程**（feishu/console）生效；web 进程加载本文件
// 是为了工具自注册（server.js 的 loadPluginSideEffects），那里 features 不被消费。
export default { id: 'colleague-agent', features: [{ order: 35, feature }] };
