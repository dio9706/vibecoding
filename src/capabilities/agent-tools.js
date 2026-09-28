import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../shared/logger.js';

/**
 * Agent 工具注册表 —— 对话 agent 与业务能力之间的唯一接缝。
 *
 * ## 为什么是「注册」而不是「import」
 *
 * 对话 agent（`plugins/colleague-agent`）要调 action-runner 的脚本、tracking-stats 的埋点，
 * 但分层约定明写**插件之间不互相 import**（协作走 store 或事件）。这里复用仓库已有的
 * `shared/card-actions.js#registerCardKindHandler` 范式：插件在**模块加载时**把自己的能力
 * 注册进来，agent 只从注册表取。
 *
 * 三个白拿的性质：
 *   1. 分层不倒挂 —— `plugins → capabilities` 是顺向依赖，本模块零业务语义；
 *   2. **插件停用即工具自然缺席** —— 与卡片回调完全同一语义，不需要额外写开关；
 *   3. 加能力不改 agent —— 新工具 = 在自己插件里注册一行。
 *
 * ## 四档危险级
 *
 *   safe        只读，无副作用                          —— 不写撤销台账
 *   reversible  有副作用但能撤回                        —— 必须能给出 undo 描述
 *   external    有真实外部副作用、撤不回（如退款脚本）  —— 必须有可关掉的硬开关
 *   notify      只给主机发消息                          —— 不写台账
 *
 * `external` 刻意单独立一档而不是塞进 `reversible`：「能撤」和「不能撤」是两种完全不同的
 * 风险，混在一档会让下面两条不变式失去意义。
 *
 * ## ⚠️ 新增工具时的固定检查项：模型上下文不许出现主机内部信息
 *
 * **这个 agent 的对话对象是公司同事，不是主机。** 进了模型上下文的东西，模型就可能
 * 复述给同事。磁盘绝对路径、数据目录结构、id 命名规则、内部实现措辞，一概不该进去。
 *
 * 新写一个工具，这三处**都要查**（2026-09-28 实测：只防住其中两处仍然会漏）：
 *
 *   1. **schema 入参** —— 别要求模型提供它本不该知道的东西。
 *      反例：`register_api_doc` 曾要求模型传 `path`，于是上游只能把绝对路径喂进对话，
 *      而同一份代码的读侧（`req-read.js#get_api_doc`）明明刻意把 path 摘掉了。
 *      正解：路径走 `ctx`（服务端按文件名解析），模型全程不经手。
 *
 *   2. **handler 正常出参** —— 只回模型用得上的字段，不要把整条记录倒出去。
 *      见 `tools/req-read.js` 文件头的三条纪律。
 *
 *   3. **handler 失败出参** —— **不要把下游函数的 error 原样转发**。
 *      下游文案通常是给人（web UI 操作者）设计的，`'文件不存在：' + 绝对路径`、
 *      Node fs 自带全路径的报错都在此列。范式照本文件 `buildAgentMcpServer` 的 catch：
 *      **日志留全文供排查，回模型换一句稳定短语。**
 *
 * 第 3 条最容易漏 —— 它只在失败路径上触发，正常测试跑不到，而补测试时很容易只断言
 * 「有没有报错」而不是「报错里有没有内部信息」（实测踩过：用例喂了带路径的 error，
 * 却只断言 `error` 非空，客观上在给泄露背书）。
 */

/** MCP server 名 —— 工具全名是 `mcp__<MCP_SERVER_NAME>__<tool>`，canUseTool 白名单必须用全名 */
export const MCP_SERVER_NAME = 'colleague';

/** 对外导出为冻结数组：Set 是引用类型，导出可变 Set 会让调用方 `.add()` 一下就把校验枚举改了 */
export const DANGER_LEVELS = Object.freeze(['safe', 'reversible', 'external', 'notify']);

/** 校验用的查找结构，模块私有，不随 DANGER_LEVELS 被外部篡改 */
const DANGER_LEVEL_SET = new Set(DANGER_LEVELS);

/** 工具短名的形状：小写 snake_case。模型看到的是这个名字，保持可读且稳定 */
const NAME_RE = /^[a-z][a-z0-9_]*$/;

/** 注册表：name → def。模块级可变状态，测试用 clearAgentTools 复位 */
const registry = new Map();

/** 拼 MCP 全名（纯函数）。写短名会让 canUseTool 静默不匹配 —— 模型看得见工具、一调就被拒 */
export function toolFullName(name) {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

/**
 * 校验工具定义（纯函数）。
 * @returns {string|null} 错误原因；null 表示合法
 */
export function validateToolDef(def) {
  if (!def || typeof def !== 'object') return 'def 必须是对象';
  if (typeof def.name !== 'string' || !NAME_RE.test(def.name)) return `name 非法（需小写 snake_case）：${def.name}`;
  if (typeof def.description !== 'string' || !def.description.trim()) return `${def.name}: description 不能为空`;
  if (!DANGER_LEVEL_SET.has(def.danger)) return `${def.name}: danger 非法（需为 ${DANGER_LEVELS.join('/')}）`;
  if (!Array.isArray(def.roles) || def.roles.length === 0) return `${def.name}: roles 不能为空数组`;
  // 只校验元素形状（非空字符串），不校验是否为合法 ROLE id —— 那是业务语义，
  // 交给注册方（colleague-agent 插件）在调用 registerAgentTool 前自行核对。
  //
  // ⚠️ 这一条只挡得住 [null] / [''] 这类形状错。**拼错的角色名（如 'Backend'）形状合法，
  // 挡不住**：它会注册成功，然后 filterToolsByRole 对任何角色都过滤掉它 ——
  // 能力消失且全链路零信号。这个失败形态由另外两道兜：注册方的 ROLE 枚举核对（业务层），
  // 以及 buildAgentMcpServer 在装配出零工具时打的 warn。别以为本行解决了它。
  if (def.roles.some((r) => typeof r !== 'string' || !r)) return `${def.name}: roles 元素必须是非空字符串`;
  if (!def.schema || typeof def.schema !== 'object' || Array.isArray(def.schema))
    return `${def.name}: schema 必须是 zod raw shape 对象`;
  if (typeof def.handler !== 'function') return `${def.name}: handler 必须是函数`;

  // —— 两条不变式。它们守的是「乐观执行 + 可撤销」这个授权模型的地基：
  //    注册一个声称可撤销却给不出撤销方式的工具，会让保证在这一个工具上悄悄失效，
  //    而代码看起来一切正常。所以在启动期硬抛，不靠自觉。
  if (def.danger === 'reversible' && typeof def.buildUndo !== 'function')
    return `${def.name}: danger=reversible 必须提供 buildUndo`;
  if (def.danger === 'external' && (typeof def.exposedFlag !== 'string' || !def.exposedFlag))
    return `${def.name}: danger=external 必须提供 exposedFlag（撤不回的工具必须有硬开关）`;

  return null;
}

/**
 * 按角色过滤（纯函数）。`roles` 含 `'*'` 即对所有角色可见。
 * **fail-closed**：未知 / 空角色只看得到 `'*'` 工具，绝不外推。
 *
 * **契约：`defs` 只接受已通过 `validateToolDef` 校验的 def 列表。**
 * 不做防御性判空/判形状 —— `defs` 为空、或元素缺 `roles` 字段会直接抛错
 * （分别炸在 `.filter`/`.includes`）。喂注册表（`listAgentTools()`）时这不会发生，
 * 因为 `registerAgentTool` 已在注册期校验过；但不要拿它去过滤别处未经校验的列表。
 */
export function filterToolsByRole(defs, role) {
  const r = typeof role === 'string' ? role : '';
  return defs.filter((d) => d.roles.includes('*') || (r && d.roles.includes(r)));
}

/** 注册一个工具（同名覆盖，便于测试注入替身）。校验不过直接抛 —— 启动期暴露，不拖到运行时 */
export function registerAgentTool(def) {
  const err = validateToolDef(def);
  if (err) throw new Error(`registerAgentTool: ${err}`);
  registry.set(def.name, def);
  return def;
}

/** 列出全部已注册工具 */
export function listAgentTools() {
  return [...registry.values()];
}

/** 清空注册表（仅测试用） */
export function clearAgentTools() {
  registry.clear();
}

/**
 * MCP 工具的返回形状：一律包成单个 text block。
 * handler 返回字符串则**原样透传**，其余 JSON 序列化 —— 别写成「内容是 JSON 字符串」，
 * 那句话会让人对字符串返回值去 `JSON.parse`，直接炸。
 *
 * ⚠️ `text` 绝不能是 `undefined`。`JSON.stringify` 对 `undefined` / 函数 / Symbol
 * 返回的是 **`undefined` 这个值本身，不是字符串**，序列化后 `text` 字段整个消失
 * （`{"content":[{"type":"text"}]}`），对端 result schema 校验直接抛
 * `MCP error -32602: ... expected string, received undefined`。
 *
 * **这个错 `buildAgentMcpServer` 里的 try/catch 兜不住** —— 它是客户端侧校验抛的，
 * 那时 handler 早已成功返回，catch 根本不在调用栈上。于是唯独这一类错会打断整轮对话，
 * 正好打脸下面那句「工具抛错不该打断整轮」。
 *
 * 触发条件一点不刁钻：`notify` 档的工具定义就是「只给主机发消息」，这种 handler
 * 天然写成不 return。
 */
function textResult(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text: text === undefined ? 'null' : text }] };
}

/**
 * 按角色装配一个进程内 MCP server。
 *
 * @param {string} role colleagues.js 的 ROLES id
 * @param {{ ctx?: object }} [opts] ctx 透传给每个 handler 的第二参（业务上下文：colleagueId/role/msgId/reqId）
 * @returns {{ server: object, allowed: Set<string>, defs: Array }}
 *   allowed：给 canUseTool 用的全名白名单
 *   defs：**单独暴露是为了可测** —— createSdkMcpServer 把工具埋进私有字段，
 *         测试去够它就把用例绑死在 SDK 内部结构上，SDK 一改版就红一片。
 */
export function buildAgentMcpServer(role, opts = {}) {
  // 浅拷贝 + 冻结：ctx 装的是身份与授权上下文（colleagueId / role / msgId / reqId），
  // 而同一个对象被闭包进**所有** handler。不冻结的话三层都会串：工具之间互相看见对方的改动、
  // 写回调用方持有的那个对象、下一次 buildAgentMcpServer 继续脏。
  // 最要命的是一个工具能改掉 ctx.role —— 在一个对外跟同事对话的 agent 上，
  // 那等于工具可以给自己提权。「ctx 只读」必须是强制的，不能是口头约定。
  const ctx = Object.freeze({ ...(opts.ctx || {}) });
  const picked = filterToolsByRole(listAgentTools(), role);

  const defs = picked.map((d) =>
    tool(d.name, d.description, d.schema, async (input) => {
      try {
        return textResult(await d.handler(input, ctx));
      } catch (e) {
        // 「给日志看的」与「给模型看的」必须分开：
        // 日志留全文（排查要它），回模型的换一句稳定短语。
        // 原样回 e.message 会把绝对路径、数据目录结构、id 命名规则讲给对话中的同事 ——
        // 这个 agent 的对话对象是公司同事，不是主机。一次 ENOENT 就能漏出
        // 「C:\…\data\requirements\req_xxx.json」，而这些细节对模型毫无用处。
        // 工具**预期内**的失败请在 handler 里 return {error:'人话'}，那条不走这里。
        logger.warn('agent-tools', '工具执行抛错', { tool: d.name, err: e?.message || String(e) });
        return textResult({ error: `工具 ${d.name} 执行失败，请换个方式或稍后再试` });
      }
    }),
  );

  // 空工具集必须出声：web 进程不走插件装配层（loadEnabledPluginFeatures 只被 app/dispatch.js
  // 这条链调用，web 入口零引用），忘了显式 import 插件时注册表恒为空 → 这里会安静地造出一个
  // 零工具的 MCP server → 模型看不到工具就凭记忆作答，回复照样通顺，日志里什么都没有。
  // 这是最难往这里想的一类故障，一行 warn 的成本换它值。
  if (picked.length === 0)
    logger.warn('agent-tools', '按角色装配出零个工具（插件可能未加载，检查是否 import 了对应插件）', { role });

  const server = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '1.0.0',
    instructions: '这是团队协作环境的业务工具集。用它们查需求状态、查代码、办事，不要凭记忆回答事实性问题。',
    tools: defs,
    alwaysLoad: true,
  });

  // 白名单**从实际装配的工具算出来**，不写死常量 ——
  // 否则新注册的工具会被 canUseTool 静默拒掉：模型看得见工具、一调就被拒，
  // 日志里只有一句权限拒绝，极难往这里想（llm-sql-agent 踩过同款）。
  return { server, allowed: new Set(picked.map((d) => toolFullName(d.name))), defs };
}
