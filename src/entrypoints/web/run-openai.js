/** web 入口：openai-compat run 编排（历史走 conv-messages 重放，agentic 工具经 MCP + 审批） */
import { logger } from '../../shared/logger.js';
import * as providers from '../../providers/index.js';
import { getMessages, appendMessages } from '../../store/conv-messages.js';
import { connectMcpServers, buildAutoAllowSet } from '../../providers/mcp.js';
import {
  runPulse,
  runText,
  runActivity,
  runResult,
  finishRun,
  failRun,
  askUser,
  nextReqId,
} from '../../store/runs.js';
import { getMcpServers } from '../../store/settings.js';
import { pickActive, getTokens, getTokenById } from '../../capabilities/token-rotation.js';
import { DEFAULT_PROVIDER_ID } from '../../shared/provider-ids.js';
import { summarizeTool } from './tool-summary.js';

/**
 * 定位本轮该用哪条 openai-compat 凭证。
 *
 * 之所以不能只靠 pickActive：它返回的是「第一条可用的 openai-compat 凭证」，
 * 而 model 由前端按用户点的 pill 单独传入。两者来源不同 → 多厂商共存必然串台：
 * 点智谱发出 model=glm-4，却配上 DeepSeek 的 apiKey/baseURL，
 * 请求打到 api.deepseek.com 去要一个 glm-4，必然 400。
 *
 * 优先级：credId 精确命中 > 按 model 匹配（老前端不传 credId）> pickActive 兜底。
 * 中间那层是关键的向后兼容：老会话虽没有 credId，但 model 已经能把厂商区分开，
 * 直接掉到 pickActive 等于放任串台。
 *
 * @returns {{cred: object|null, reason: string}} reason 供日志追溯实际走了哪条路径
 */
export function resolveCredential(tokens, { credId, model }) {
  const list = (Array.isArray(tokens) ? tokens : []).filter(
    (t) => t && (t.providerId || DEFAULT_PROVIDER_ID) === 'openai-compat',
  );
  if (credId) {
    const hit = list.find((t) => t.id === credId);
    if (hit) return { cred: hit, reason: 'by-id' };
    // 指名的凭证没了（设置页刚删/导入了别的配置）：不静默换一条别的号去发，
    // 让它落到下面的 model 匹配，匹配不上就报错——用错凭证比失败更难排查。
  }
  if (model) {
    const byModel = list.filter((t) => t.model === model);
    // 仅在**唯一**命中时才认：同 model 多条（同厂商不同 key）无从判断用哪条，
    // 挑一条等于赌，交给 pickActive 的确定性顺序更诚实
    if (byModel.length === 1) return { cred: byModel[0], reason: 'by-model' };
  }
  const active = pickActive(list, 'openai-compat');
  return { cred: active, reason: active ? 'fallback-active' : 'none' };
}

/** openai-compat run 路径：无 Claude session，历史走 app 自持 conv-messages 重放；
 *  经 MCP 提供 agentic 工具（每次调用过 canUseTool 审批）；hooks 复用 runs.js SSE/停止/流式。
 *  openai resume=false → 不 addActiveRun（不参与跨重启孤儿恢复）。 */
export async function startOpenAiRun(run, { prompt, model, credId, cwd, convId }) {
  run.convId = convId || run.convId || null;
  // { id, token=apiKey, baseURL, model, ... } | null
  const { cred, reason } = resolveCredential(getTokens(), { credId, model });
  if (!cred) return failRun(run, '未配置可用的自定义模型凭证——请到设置页添加 OpenAI 兼容凭证（baseURL + apiKey + model）');
  // 指名了凭证却没命中 = 它已被删除。此时 baseURL/apiKey 来自别的号，
  // 极可能与 model 不配套；明确告知，而不是让用户对着一句 400 猜。
  if (credId && reason !== 'by-id') {
    runActivity(run, `⚠️ 指定的模型凭证已不存在，本轮改用「${cred.label || cred.model}」（${cred.baseURL}）`);
  }
  logger.info('web', 'openai-compat run 凭证解析', { credId: credId || null, picked: cred.id, reason, model: model || cred.model });
  const history = getMessages(convId); // 已有历史（无 convId 则空）
  const userMsg = { role: 'user', content: prompt };
  if (convId) appendMessages(convId, [userMsg]); // 有会话才持久化 user 消息
  const priorMessages = [...history, userMsg]; // 喂模型的消息始终含本轮 prompt（不依赖 convId）

  // 连 MCP 工具（失败隔离；无配置 → 纯对话）
  let mcp = null;
  const mcpConfigs = getMcpServers().filter((s) => s && s.command && s.enabled !== false);
  if (mcpConfigs.length) {
    try {
      mcp = await connectMcpServers(mcpConfigs, { cwd: cwd || undefined, signal: run.abortController.signal });
    } catch (e) {
      logger.warn('web', 'MCP 连接失败，降级为纯对话', { err: e?.message || String(e) });
      mcp = null;
    }
  }
  const hasTools = !!(mcp && Object.keys(mcp.toolDefs).length);
  // 把连不上的 MCP server 明确告诉用户。此前只写 logger.warn，用户侧的表现是
  // 「模型突然没工具了、能力莫名退化」，几乎不可能自行定位到是某个 server 没起来。
  const mcpFailed = (mcp?.failed || []).concat(
    mcpConfigs.length && !mcp ? [{ label: '全部 MCP server', error: 'MCP 初始化失败' }] : [],
  );
  if (mcpFailed.length) {
    runActivity(
      run,
      `⚠️ ${mcpFailed.length} 个 MCP server 未连上，相关工具本轮不可用：` +
        mcpFailed.map((f) => `${f.label}（${f.error}）`).join('；'),
    );
  }

  const hooks = {
    onText: (t) => runText(run, t),
    onActivity: (a) => runActivity(run, summarizeTool(a)),
    onResult: (info) => runResult(run, info),
    onPulse: () => runPulse(run),
  };
  if (hasTools) {
    const autoAllow = buildAutoAllowSet(mcpConfigs); // 各 server 配置的免审批工具名并集
    // 每个工具调用过审批队列（复用 Claude 路径的允许/拒绝卡 + 并发串行化）；白名单命中直接放行
    hooks.canUseTool = async (toolName, input) => {
      if (autoAllow.has(toolName)) return { behavior: 'allow' };
      const choice = await askUser(run, {
        reqId: nextReqId(run),
        kind: 'permission',
        title: `自定义模型请求执行：${toolName}`,
        body: summarizeTool({ name: toolName, input }),
        options: [
          { id: 'allow', label: '允许' },
          { id: 'deny', label: '拒绝' },
        ],
        defaultChoice: 'deny',
      });
      return choice === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: '用户拒绝了该操作' };
    };
  }

  const handle = providers.get('openai-compat').run(
    {
      messages: priorMessages,
      model: model || cred.model,
      apiKey: cred.token,
      baseURL: cred.baseURL,
      abortController: run.abortController,
      ...(hasTools ? { tools: mcp.toolDefs, executeTool: mcp.executeTool } : {}),
    },
    hooks,
  );
  handle.done
    .then((out) => {
      if (convId && out && Array.isArray(out.messages)) {
        appendMessages(convId, out.messages.slice(priorMessages.length));
      }
      finishRun(run);
    })
    .catch((err) => failRun(run, `自定义模型执行失败：${err?.message || String(err)}`))
    .finally(() => {
      if (mcp) mcp.close();
    });
}
