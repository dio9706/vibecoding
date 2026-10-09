/** web 入口：openai-compat run 编排（历史走 conv-messages 重放；T2-P3 起每步落盘为检查点，崩溃后从检查点续；P5 起孤儿对账统一走 run-claude.js#reconcileRuns） */
import { logger } from '../../shared/logger.js';
import * as providers from '../../providers/index.js';
import { getMessages, appendMessages, getSummary, setSummary } from '../../store/conv-messages.js';
import {
  dropLeadingOrphans,
  shouldCompact,
  pickCompactCut,
  formatMessagesForSummary,
  buildSummaryPrompt,
  normalizeSummaryText,
  composeSystemWithSummary,
  SUMMARY_SYSTEM_PROMPT,
} from './conv-compact.logic.js';
import { connectMcpServers, buildAutoAllowSet } from '../../providers/mcp.js';
import {
  createRun,
  runPulse,
  runText,
  runActivity,
  runResult,
  runTodos,
  finishRun,
  failRun,
  askUser,
  nextReqId,
  emitRunEvent,
  truncateForJournal,
} from '../../store/runs.js';
import { upsertRun, removeRun } from '../../store/run-index.js';
import { repairDanglingToolCalls, resolveMaxSteps } from './run-openai.logic.js';
import { getMcpServers, getBuiltinMcp, getRepoMapSettings, getUiPrefs, getExecSettings, getSearchSettings, credentialModels } from '../../store/settings.js';
import { pickActive, getTokens, getTokenById } from '../../capabilities/token-rotation.js';
import { DEFAULT_PROVIDER_ID } from '../../shared/provider-ids.js';
import { summarizeTool } from './tool-summary.js';
import { createBuiltinTools, buildAgentSystemPrompt, normalizeTodos } from '../../providers/builtin-tools.js';
import { resolveBashBackend, describeBackend } from '../../providers/exec-backends.js';
import { createFeishuAskTools, FEISHU_ASK_READONLY_TOOLS } from '../../capabilities/feishu-ask-tools.js';
import { createPolicyGate } from '../../capabilities/tool-policy.js';
import { createWebTools } from '../../capabilities/web-tools.js';
import { clipText } from '../../capabilities/web-tools.logic.js';
import { pickReadonlyToolDefs, buildSubagentSystemPrompt, SUBAGENT_TOOL_DEF } from '../../capabilities/subagent.logic.js';
import { resolveBuiltinMcp } from '../../capabilities/builtin-mcp.js';
import { getRepoMap, TOOL_BUDGET_CHARS } from '../../features/repo-map/index.js';

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
    // 凭证多模型（OpenCode 式）：按凭证发现到的模型列表匹配；legacy 单 model 由 credentialModels 归一
    const byModel = list.filter((t) => credentialModels(t).some((m) => m.id === model));
    // 仅在**唯一**命中时才认：同 model 多条（同厂商不同 key）无从判断用哪条，
    // 挑一条等于赌，交给 pickActive 的确定性顺序更诚实
    if (byModel.length === 1) return { cred: byModel[0], reason: 'by-model' };
  }
  const active = pickActive(list, 'openai-compat');
  return { cred: active, reason: active ? 'fallback-active' : 'none' };
}

/** 本轮实际模型：请求指定优先；缺省回落凭证发现到的第一个（legacy model 已由 credentialModels 归一） */
function pickModel(model, cred) {
  return model || credentialModels(cred)[0]?.id || '';
}

/** 载入 conv-messages 并修复序列：悬空 tool-call 补合成结果、头部孤儿 tool 结果剔除。
 *  修复必须**落盘**——否则下次加载仍是非法序列，新消息会接在断口后（T7：dropLeadingOrphans 见 conv-compact.logic） */
function loadRepairedHistory(run, convId) {
  const { messages, added } = repairDanglingToolCalls(getMessages(convId));
  if (added.length && convId) {
    appendMessages(convId, added);
    runActivity(run, `⚠️ 检测到 ${added.length} 个中断未执行的工具调用，已按「未执行」补记`);
  }
  return dropLeadingOrphans(messages);
}

/** 被丢段 → 摘要文本（同会话凭证一次性无工具调用；零工具时 agent-loop 自然降级纯对话） */
async function summarizeSpan({ run, cred, model, previousSummary, dropped }) {
  const prompt = buildSummaryPrompt({ previousSummary, droppedText: formatMessagesForSummary(dropped) });
  let text = '';
  const handle = providers.get('openai-compat').run(
    {
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      model: pickModel(model, cred),
      apiKey: cred.token,
      baseURL: cred.baseURL,
      abortController: run.abortController,
    },
    { onText: (t) => (text += t) },
  );
  await handle.done;
  const out = normalizeSummaryText(text);
  if (!out) throw new Error('摘要调用返回空文本');
  return out;
}

/**
 * 压缩编排（T7，spec §4.3）：历史超限则生成滚动摘要并落盘，返回当前有效摘要（或原样）。
 * fail-open：摘要失败只提示、不阻塞——本轮按原文继续（与改动前行为一致），下轮再试。
 */
async function maybeCompactHistory({ run, cred, model, convId, messages }) {
  if (!convId) return null;
  let summary = getSummary(convId);
  const covered = summary?.covered || 0;
  if (!shouldCompact({ total: messages.length, covered })) return summary;
  const cut = pickCompactCut(messages, { covered });
  if (cut < 0) return summary; // 找不到安全整轮边界/可丢太少 → 本轮不压
  const dropped = messages.slice(covered, cut);
  if (!dropped.length) return summary;
  try {
    const text = await summarizeSpan({ run, cred, model, previousSummary: summary?.text || '', dropped });
    const saved = setSummary(convId, { text, covered: cut, at: Date.now(), model });
    runActivity(run, `📝 历史较长：已生成滚动摘要（覆盖前 ${cut} 条消息，原文保留）`);
    return saved || summary;
  } catch (e) {
    runActivity(run, `⚠️ 历史摘要生成失败（本轮按原文继续）：${e?.message || String(e)}`);
    return summary;
  }
}

/**
 * 会话主体（fresh / resume 共用）：system + 历史 + 工具管线 + 每步检查点 + 事件流/索引。
 *
 * 检查点（T2-P3）：`conv-messages` 即检查点——agent-loop 每步的消息增量经 `onMessages` 立即落盘，
 * 进程崩溃后历史里留下的就是「干到一半」的现场；恢复时修复悬空调用即可继续（见 resumeOpenAiRun）。
 *
 * @param {object} p
 * @param {object} p.cred openai 凭证条目
 * @param {string} p.model
 * @param {string} [p.cwd] 工作目录（缺省退服务进程 cwd）
 * @param {string} [p.convId]
 * @param {Array} p.messages 历史消息（不含 system；末尾即接续点）
 * @param {string} [p.repoMapQuery] 仓库地图查询词（fresh=本次 prompt；resume=原 run 存档的 prompt）
 */
async function runOpenAiSession(run, { cred, model, effort, cwd, convId, messages, repoMapQuery }) {
  // 工作目录：没选目录时退到服务进程 cwd（与 Claude 路径 SDK 默认一致）
  const workspace = cwd || process.cwd();
  // 仓库地图（可按设置关闭）：确定性代码索引，给模型找线索的起点；构建失败 fail-open 返回空串
  const repoMapEnabled = getRepoMapSettings().enabled;
  let repoMap = '';
  if (repoMapEnabled) {
    repoMap = await getRepoMap({ cwd: workspace, query: repoMapQuery || '' });
  }
  // 上下文压缩（T7）：历史超限 → 滚动摘要（同凭证、fail-open）；模型视角 = 摘要 + 近期（原文保留在存储）。
  // covered 越界（异常数据）时整体弃用摘要，退化为全量原文——fail-safe。
  const summary = await maybeCompactHistory({ run, cred, model, convId, messages });
  const summaryUsable = !!summary && Number.isFinite(summary.covered) && summary.covered <= messages.length;
  const viewMessages = summaryUsable && summary.covered > 0 ? messages.slice(summary.covered) : messages;
  // system 提示词每轮注入、不进历史：落盘会在重放里逐轮堆积，且内容随 cwd 变化
  const modelMessages = [
    { role: 'system', content: composeSystemWithSummary(buildAgentSystemPrompt({ cwd: workspace, repoMap }), summaryUsable ? summary.text : '') },
    ...viewMessages,
  ];

  // 内置文件/命令工具打底：harness 自己实现（对标 OpenCode），不依赖用户配 MCP 才有工具。
  // RepoMap 工具与地图注入同开关：enabled 时注入，按需按关键词重查 / refresh 强制重建。
  // Bash 执行后端（T6）：settings.exec.backend=container 时探测 docker/podman；
  // 引擎不可用 → unavailable（Bash fail-closed 明确报错，绝不静默退回本地）。
  const bashBackend = await resolveBashBackend(getExecSettings());
  if (bashBackend.kind !== 'local') runActivity(run, `Bash 执行后端：${describeBackend(bashBackend)}`);
  const builtin = createBuiltinTools({
    cwd: workspace,
    signal: run.abortController.signal,
    bashBackend,
    ...(repoMapEnabled
      ? {
          loadRepoMap: ({ query: q, refresh }) =>
            getRepoMap({ cwd: workspace, query: q, refresh, budgetChars: TOOL_BUDGET_CHARS }),
        }
      : {}),
  });

  // 委托同事对话（AskColleague / WaitColleagueReply）：子引擎负责追问到结论，
  // 提问走审批卡、等待免审批；只有同事名册里、且配了 open_id 的人才问得到。
  const feishuAsk = createFeishuAskTools({
    runId: run.id,
    convId,
    signal: run.abortController.signal,
    pulse: () => runPulse(run),
    activity: (text) => runActivity(run, text),
  });

  // MCP 是可选增强（失败隔离；连不上只降级 MCP 部分，内置工具照常可用）。
  // 内置 MCP（registry 解析：context7 缺省开、figma 缺省关）+ 用户自定义 MCP，共用同一条连接管线；
  // 只读工具的免审批来自各自配置的 autoAllow（内置项自带注册表白名单）。
  let mcp = null;
  const mcpConfigs = [
    ...resolveBuiltinMcp({ state: getBuiltinMcp(), provider: 'openai' }),
    ...getMcpServers().filter((s) => s && s.command && s.enabled !== false),
  ];
  if (mcpConfigs.length) {
    try {
      mcp = await connectMcpServers(mcpConfigs, { cwd: cwd || undefined, signal: run.abortController.signal });
    } catch (e) {
      logger.warn('web', 'MCP 连接失败，降级为仅内置工具', { err: e?.message || String(e) });
      mcp = null;
    }
  }
  const mcpDefs = mcp?.toolDefs || {};
  // 联网工具（WebFetch/WebSearch）：WebSearch 依赖 settings.search 的 provider/key；
  // 审批由策略表网络类负责（default 档弹确认、bypass/无人值守放行）。
  const webTools = createWebTools({ search: getSearchSettings() });
  const localDefs = { ...builtin.toolDefs, ...feishuAsk.toolDefs, ...webTools.toolDefs, Task: SUBAGENT_TOOL_DEF };
  // 只读子代理（Task）的工具子集：从本地只读集合里挑（不含 Task → 天然禁递归）
  const subagentDefs = pickReadonlyToolDefs({ ...builtin.toolDefs, ...webTools.toolDefs });
  const subagentExecute = async (name, input) =>
    Object.hasOwn(webTools.toolDefs, name) ? webTools.executeTool(name, input) : builtin.executeTool(name, input);
  /**
   * 只读子代理执行体（Task）：嵌套 agent-loop，同凭证/模型/强度/预算；
   * 审批复用主 run 同一策略门（网络类照常弹卡）；中间文本不上主气泡，活动转发带前缀。
   */
  async function runSubagent(input) {
    const taskText = String(input?.prompt || input?.description || '').trim();
    if (!taskText) return '错误：prompt 不能为空';
    const handle = providers.get('openai-compat').run(
      {
        messages: [
          { role: 'system', content: buildSubagentSystemPrompt({ cwd: workspace }) },
          { role: 'user', content: taskText },
        ],
        model: pickModel(model, cred),
        apiKey: cred.token,
        baseURL: cred.baseURL,
        abortController: run.abortController,
        tools: subagentDefs,
        executeTool: subagentExecute,
        effort: effort || undefined,
        maxSteps,
      },
      {
        onActivity: (a) => runActivity(run, '🔍 子代理：' + (a?.invalid ? `${a.name} 参数无效（已让其修正）` : summarizeTool(a))),
        canUseTool: (name, toolInput) => hooks.canUseTool(name, toolInput),
        onPulse: () => runPulse(run),
      },
    );
    const out = await handle.done;
    const text = String(out?.result || '').trim();
    return text ? clipText(text, 8000) : '（子代理未产出结论）';
  }
  const conflicts = Object.keys(mcpDefs).filter((n) => Object.hasOwn(localDefs, n));
  if (conflicts.length) runActivity(run, `⚠️ MCP 工具覆盖了同名本地工具：${conflicts.join('、')}`);
  const toolDefs = { ...localDefs, ...mcpDefs }; // 同名时用户显式配置的 MCP 优先
  const executeTool = async (name, input) => {
    if (Object.hasOwn(mcpDefs, name)) return mcp.executeTool(name, input);
    if (Object.hasOwn(feishuAsk.toolDefs, name)) return feishuAsk.executeTool(name, input);
    if (Object.hasOwn(webTools.toolDefs, name)) return webTools.executeTool(name, input);
    if (name === 'Task') return runSubagent(input);
    return builtin.executeTool(name, input);
  };
  // 把连不上的 MCP server 明确告诉用户。此前只写 logger.warn，用户侧的表现是
  // 「模型突然没工具了、能力莫名退化」，几乎不可能自行定位到是某个 server 没起来。
  const mcpFailed = (mcp?.failed || []).concat(
    mcpConfigs.length && !mcp ? [{ label: '全部 MCP server', error: 'MCP 初始化失败' }] : [],
  );
  if (mcpFailed.length) {
    runActivity(
      run,
      `⚠️ ${mcpFailed.length} 个 MCP server 未连上，相关 MCP 工具本轮不可用（内置与委托工具不受影响）：` +
        mcpFailed.map((f) => `${f.label}（${f.error}）`).join('；'),
    );
  }

  // 检查点（P3）：每步消息增量立即落盘；游标记录已持久化条数，结束时兜底只补差量（防重复落盘）
  let persistedCount = modelMessages.length;
  const persistBatch = (batch) => {
    if (!convId || !Array.isArray(batch) || batch.length === 0) return;
    appendMessages(convId, batch);
    persistedCount += batch.length;
  };

  const hooks = {
    onText: (t) => runText(run, t),
    // TodoWrite → 任务清单面板（同 run-claude 口径：清单行不进活动转录）；
    // 其它工具 → 活动转录；invalid 调用要让人看见「参数无效、已让模型修正」
    onActivity: (a) => {
      if (a?.name === 'TodoWrite' && Array.isArray(a.input?.todos)) {
        runTodos(run, normalizeTodos(a.input.todos));
        return;
      }
      runActivity(run, a?.invalid ? `⚠️ ${a.name} 参数无效（已让模型修正）` : summarizeTool(a));
    },
    onResult: (info) => runResult(run, info),
    onPulse: () => runPulse(run),
    onMessages: persistBatch, // 检查点钩子：agent-loop 每步 / 每条工具结果都会调
  };
  const autoAllow = buildAutoAllowSet(mcpConfigs); // 各 server 配置的免审批工具名并集
  // 工具策略门（T6）：档位 = 本 run 的 mode（routes-run 透传；缺省 default=非白名单全问，与改动前等价）。
  // 区内只读/写、越界、网络、危险命令的统一规则表在 capabilities/tool-policy.logic.js。
  const { disabledTools: rawDisabledTools, openaiMaxSteps } = getUiPrefs();
  // 工具循环预算：默认无上限（对齐 Claude Code / OpenCode）；基础设置可配正整数，
  // 到限时 agent-loop 会走 OpenCode 式强制收尾（工具禁用 + 总结），不再静默截断。
  const maxSteps = resolveMaxSteps(openaiMaxSteps);
  const disabledToolsSet = new Set(Array.isArray(rawDisabledTools) ? rawDisabledTools : []);
  const policyGate = createPolicyGate({
    provider: 'openai-compat',
    // 实时读 run.mode（闭包）：中途切档立即对后续工具调用生效——openai 的 canUseTool 全程在线，
    // 不像 Claude SDK 受「起跑时是否装钩子」限制（2026-10-08 用户反馈：长任务里切「自动」无感）
    level: () => run.mode || 'default',
    workspace,
    disabledTools: disabledToolsSet,
    autoAllow,
    readOnlyExtra: FEISHU_ASK_READONLY_TOOLS,
    onDeny: (info) => emitRunEvent(run, 'policy_block', { tool: info.tool, klass: info.klass, ruleId: info.ruleId, reason: info.reason }),
  });
  // 每个工具调用过策略门：allow 直放；deny 明确拒绝；ask 走审批队列（复用 Claude 路径的允许/拒绝卡）。
  // 免审批来源统一在规则表内：MCP 白名单 / 内置只读且在工作目录内 / 委托的「等待」工具。
  hooks.canUseTool = async (toolName, input) => {
    const d = policyGate.decide(toolName, input);
    if (d.action === 'allow') return { behavior: 'allow' };
    if (d.action === 'deny') return { behavior: 'deny', message: d.reason };
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

  // 事件流 + 索引（P3 起 openai 参与跨重启检查点续跑）。
  // 索引写失败吞掉：最坏结果是崩溃后不自动续（退回今日行为）；journal 的 settled 事件负责下次启动兜底清理
  emitRunEvent(run, 'submitted', {
    provider: 'openai-compat',
    requestId: run.requestId || null,
    cwd: workspace,
    model: pickModel(model, cred),
    effort: effort || null,
    mode: run.mode || null, // 模式进 journal（对账/排障用；此前写死 null 无从查证）
    session: null,
    resumeAttempt: run.resumeAttempt || 0,
  });
  try {
    upsertRun({
      runId: run.id,
      convId,
      provider: 'openai-compat',
      session_id: null,
      cwd: workspace,
      model: pickModel(model, cred),
      effort: effort || null,
      mode: run.mode || null, // 续跑对账后按原档位恢复（此前写死 null，续跑必退回 default 逐次询问）
      credId: cred.id,
      requestId: run.requestId || null,
      prompt: repoMapQuery ? truncateForJournal(repoMapQuery) : null,
      resumeAttempt: run.resumeAttempt || 0,
      pid: process.pid,
      startedAt: run.startedAt,
      updatedAt: Date.now(),
      status: 'running',
      lastSeq: run._journalSeq || 0,
    });
  } catch (e) {
    logger.warn('web', 'openai run 索引写入失败（已忽略；该 run 崩溃后不会自动续跑）', {
      runId: run.id,
      err: e?.message || String(e),
    });
  }

  const handle = providers.get('openai-compat').run(
    {
      messages: modelMessages,
      model: pickModel(model, cred),
      apiKey: cred.token,
      baseURL: cred.baseURL,
      abortController: run.abortController,
      tools: toolDefs,
      executeTool,
      effort: effort || undefined, // 自定义模型强度（reasoning_effort）；无档位模型不带
      maxSteps, // ∞ = 无上限（默认）；有限值到限走强制收尾
    },
    hooks,
  );
  emitRunEvent(run, 'started', { pid: process.pid });
  handle.done
    .then((out) => {
      if (out && Array.isArray(out.messages)) {
        // 兜底：把没走 onMessages 的余量补上（正常为空）；system 提示词每轮重建，不进历史
        const rest = out.messages.slice(persistedCount);
        if (convId && rest.length) appendMessages(convId, rest);
      }
      // 排障留痕（2026-10-08 空输出事故）：步数/用量/空回复/预算耗尽都从日志可还原
      if (out?.exhausted && out?.wrappedUp) {
        runActivity(run, `⚠️ 已达工具步数上限（${Number.isFinite(maxSteps) ? maxSteps + ' 步' : '——'}），已让模型收尾总结`);
        logger.warn('web', 'openai run 达上限并强制收尾', { runId: run.id, steps: out.steps, maxSteps: Number.isFinite(maxSteps) ? maxSteps : null });
      } else if (out?.exhausted) {
        runActivity(run, `⚠️ 已达工具步数上限，且收尾调用失败——任务可能未完成，可回复「继续」`);
        logger.warn('web', 'openai run 工具步数耗尽（收尾失败）', { runId: run.id, steps: out.steps });
      } else if (out && !out.result) {
        logger.warn('web', 'openai run 未产出文本', { runId: run.id, steps: out?.steps ?? null });
      } else if (out) {
        logger.info('web', 'openai run 完成', {
          runId: run.id,
          steps: out.steps ?? null,
          inputTokens: out.inputTokens ?? null,
          outputTokens: out.outputTokens ?? null,
        });
      }
      finishRun(run);
    })
    .catch((err) => {
      logger.warn('web', 'openai run 失败', { runId: run.id, err: err?.message || String(err) });
      failRun(run, `自定义模型执行失败：${err?.message || String(err)}`);
    })
    .finally(() => {
      try {
        removeRun(run.id); // 收尾即摘除索引（任何路径）；失败由 journal settled 在下次启动兜底
      } catch (e) {
        logger.warn('web', 'openai run 索引移除失败（已忽略）', { runId: run.id, err: e?.message || String(e) });
      }
      if (mcp) mcp.close();
    });
}

/** openai-compat run 提交入口：历史 + 本次用户消息 = 检查点起点（模型调用前崩溃也能续） */
export async function startOpenAiRun(run, { prompt, model, credId, cwd, convId, requestId, mode, effort } = {}) {
  run.convId = convId || run.convId || null;
  // 工具策略档位（T6）：与 Claude 路径共用同一份规则表；缺省 default（非白名单全问，与改动前等价）
  run.mode = mode || 'default';
  run.provider = 'openai-compat'; // journal/索引的 provider 归属（P3 起 openai 参与检查点续跑）
  run.requestId = requestId || null; // 提交幂等键（与 submissions 认领对账）
  run.effort = effort || null; // 自定义模型强度（reasoning_effort；无档位模型为 null，follow-up 快照取它）
  run.resumeAttempt = 0;
  // { id, token=apiKey, baseURL, model, ... } | null
  const { cred, reason } = resolveCredential(getTokens(), { credId, model });
  if (!cred) return failRun(run, '未配置可用的自定义模型凭证——请到设置页添加 OpenAI 兼容凭证（baseURL + apiKey）');
  // 指名了凭证却没命中 = 它已被删除。此时 baseURL/apiKey 来自别的号，
  // 极可能与 model 不配套；明确告知，而不是让用户对着一句 400 猜。
  if (credId && reason !== 'by-id') {
    runActivity(run, `⚠️ 指定的模型凭证已不存在，本轮改用「${cred.label || pickModel('', cred)}」（${cred.baseURL}）`);
  }
  // busy inbox 能力与快照上下文（T2-P4）：openai 没有「工具执行中途」恢复 API，不做 steer；
  // 同 conv 运行中收到的新消息一律 follow-up 排队（能力位），排空时从检查点续下一轮（快照字段）。
  run.capabilities.followUp = true;
  run.cwd = cwd || null;
  run.model = pickModel(model, cred); // buildFollowUpItem 取它做排空快照
  run.credId = cred.id;
  logger.info('web', 'openai-compat run 凭证解析', { credId: credId || null, picked: cred.id, reason, model: pickModel(model, cred), mode: run.mode });
  const history = loadRepairedHistory(run, convId); // 含上一轮崩溃的悬空修复（修复落盘）
  const userMsg = { role: 'user', content: prompt };
  if (convId) appendMessages(convId, [userMsg]); // 有会话才持久化 user 消息（检查点的起点）
  await runOpenAiSession(run, {
    cred,
    model: pickModel(model, cred),
    effort: effort || null,
    cwd,
    convId,
    messages: [...history, userMsg],
    repoMapQuery: prompt,
  });
}

/**
 * 检查点续跑（P3）：**不追加「继续」提示词**——历史末尾是 tool 结果或用户消息时，
 * 模型看到的上下文天然是「干到一半的活」，直接继续即可。
 *
 * @param {object} run 新 run（调用方 createRun 并挂好 convId）
 * @param {object} entry run-index 里的旧条目（对账或手工恢复取得）
 */
export async function resumeOpenAiRun(run, entry) {
  run.convId = entry?.convId || run.convId || null;
  run.provider = 'openai-compat';
  run.requestId = entry?.requestId || null;
  run.resumeAttempt = entry?.resumeAttempt || 0;
  // 续跑按原档位恢复策略门（缺省 default）；缺失时逐次询问是 fail-closed 的兜底
  run.mode = entry?.mode || 'default';
  const { cred } = resolveCredential(getTokens(), { credId: entry?.credId, model: entry?.model });
  if (!cred) {
    return failRun(run, `续跑失败：原模型凭证已不可用（${entry?.model || '未知模型'}），请到设置页检查自定义模型配置`);
  }
  // busy inbox 能力与快照上下文（T2-P4）：续跑 run 同样可被排队/接续
  run.capabilities.followUp = true;
  run.cwd = entry?.cwd || null;
  run.model = entry?.model || pickModel('', cred);
  run.effort = entry?.effort || null; // 续跑原样恢复上轮强度（reasoning_effort）
  run.credId = cred.id;
  const history = loadRepairedHistory(run, run.convId);
  const last = history[history.length - 1];
  if (last && last.role === 'assistant') {
    // 检查点停在完整回复的末尾（进程死在「模型产出完成 → settle」之间的窗口）：没有要续的活。
    // 多为索引移除失败后的下次启动兜底；中性收尾，不烧一次模型调用去接一轮已完成的发言。
    logger.info('web', 'openai 检查点停在完整回复末尾，无需续跑', { convId: run.convId, fromRunId: entry?.runId || null });
    return finishRun(run);
  }
  if (!history.length) {
    return failRun(run, '续跑失败：会话检查点为空（无可续内容），请手动重发消息');
  }
  logger.info('web', 'openai-compat 从检查点续跑', { convId: run.convId, fromRunId: entry?.runId || null });
  await runOpenAiSession(run, {
    cred,
    model: entry?.model || pickModel('', cred),
    effort: entry?.effort || null,
    cwd: entry?.cwd,
    convId: run.convId,
    messages: history,
    repoMapQuery: entry?.prompt || '',
  });
}

/** 启动对账后调度检查点续跑的延迟：本地检查点无需 Claude 的 token 重置缓冲，留一点让服务先就绪 */
const OPENAI_RESUME_DELAY_MS = 3000;

/** 执行一次续跑：新 run + resumed 事件 + resumeOpenAiRun（异常兜底 failRun） */
function doResumeOpenAi(entry, attempt) {
  const run = createRun();
  run.convId = entry.convId || null;
  emitRunEvent(run, 'resumed', { fromRunId: entry.runId || null, attempt, reason: 'orphan_recovery', pendingId: null });
  logger.info('web', '从检查点恢复中断的自定义模型任务', { fromRunId: entry.runId || null, convId: entry.convId || null, attempt });
  resumeOpenAiRun(run, { ...entry, resumeAttempt: attempt }).catch((e) =>
    failRun(run, `自定义模型续跑失败：${e?.message || String(e)}`),
  );
}

/**
 * 调度一次孤儿检查点续跑（P5 起由 run-claude.js#reconcileRuns 统一调用；本模块只提供起跑细节）。
 * 延迟让服务先就绪；deps 供测试注入 schedule/launch。
 */
export function scheduleOpenAiOrphanResume(
  entry,
  attempt,
  { schedule = (fn) => setTimeout(fn, OPENAI_RESUME_DELAY_MS), launch = doResumeOpenAi } = {},
) {
  schedule(() => launch(entry, attempt));
}
