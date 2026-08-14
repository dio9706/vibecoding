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
import { pickActive, getTokens } from '../../features/token-rotation.js';
import { summarizeTool } from './tool-summary.js';

/** openai-compat run 路径：无 Claude session，历史走 app 自持 conv-messages 重放；
 *  经 MCP 提供 agentic 工具（每次调用过 canUseTool 审批）；hooks 复用 runs.js SSE/停止/流式。
 *  openai resume=false → 不 addActiveRun（不参与跨重启孤儿恢复）。 */
export async function startOpenAiRun(run, { prompt, model, cwd, convId }) {
  run.convId = convId || run.convId || null;
  const cred = pickActive(getTokens(), 'openai-compat'); // { id, token=apiKey, baseURL, model, ... } | null
  if (!cred) return failRun(run, '未配置可用的自定义模型凭证——请到设置页添加 OpenAI 兼容凭证（baseURL + apiKey + model）');
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
