/**
 * MCP 集成层：连一组 stdio MCP server，聚合工具，拆成"定义 + 执行"。
 * 定义（toolDefs）给 streamText（剥掉 execute → 模型请求但不自动执行）；
 * 执行（executeTool）由 agent-loop 在 canUseTool 审批通过后调用。
 * 已核实 @ai-sdk/mcp@2.0.16：client.tools() 的工具含 description/inputSchema/execute；
 * execute(input,{toolCallId,messages}) → { content:[{type:'text',text}], isError }。
 */
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { logger } from '../shared/logger.js';

/**
 * @param {Array<{id?:string,command:string,args?:string[],cwd?:string,env?:object,autoAllow?:string[]}>} configs
 * @param {{ cwd?:string, signal?:AbortSignal }} [ctx]
 * @returns {Promise<{ toolDefs:object, executeTool:(name:string,input:any)=>Promise<any>, close:()=>Promise<void> }>}
 * @throws {Error} name='AbortError'：ctx.signal 中断时（含连接中途）；已连上的 server 会先被 close。
 */
export async function connectMcpServers(configs, ctx = {}) {
  const signal = ctx.signal;
  const clients = [];
  const failed = []; // 连接失败的 server 清单，随返回值上报给调用方（不再静默降级）
  const toolDefs = {};
  const executors = {};
  for (const cfg of Array.isArray(configs) ? configs : []) {
    if (!cfg || !cfg.command) continue;
    try {
      if (signal?.aborted) throw abortError();
      const client = await connectAbortable(cfg, ctx, signal);
      clients.push(client);
      const tools = await client.tools();
      for (const [name, t] of Object.entries(tools)) {
        toolDefs[name] = { description: t.description, inputSchema: t.inputSchema };
        executors[name] = t.execute;
      }
    } catch (e) {
      if (e?.name === 'AbortError') {
        await close(); // run 已被停止：释放已连上的 server，整体中断
        throw e;
      }
      // 记录失败清单并随返回值上报：只写 warn 的话用户完全不知情，
      // 表现为「模型突然没工具了、能力莫名退化」，排查成本极高。
      failed.push({ command: cfg.command, label: cfg.label || cfg.command, error: e?.message || String(e) });
      logger.warn('mcp', 'MCP server 连接失败，跳过', { command: cfg.command, err: e?.message || String(e) });
    }
  }
  async function executeTool(name, input) {
    const exec = executors[name];
    if (!exec) throw new Error(`未知 MCP 工具：${name}`);
    const r = await exec(input, { toolCallId: 'mcp-' + name, messages: [], abortSignal: ctx.signal });
    return normalizeMcpResult(r);
  }
  async function close() {
    for (const c of clients) {
      try {
        await c.close();
      } catch {
        /* ignore：进程可能已随 abort 退出 */
      }
    }
  }
  return { toolDefs, executeTool, close, failed };
}

function abortError() {
  return Object.assign(new Error('MCP 连接已中断（run 被停止）'), { name: 'AbortError' });
}

/**
 * 单个 MCP server 的连接超时。
 * 没有它时：server 进程起来了但不完成握手（依赖缺失、脚本卡在交互提示、协议不兼容），
 * createMCPClient 的 Promise 永不 settle —— 整个 run 挂在这里，直到看门狗 15 分钟后
 * 靠 abort 才解开。20s 足够任何正常的本地 stdio server 完成握手。
 */
const MCP_CONNECT_TIMEOUT_MS = 20_000;

/** 单个 server 的可中断 + 带超时连接。StdioConfig/MCPClientConfig 均不收 signal（2.0.16 类型核验），
 *  在外层包 abort 与 timeout：任一触发都立即拒绝返回，并关 transport 杀掉挂起的子进程
 *（transport.close → 内部 abortController.abort → spawn signal 生效），防孤儿进程。 */
function connectAbortable(cfg, ctx, signal) {
  const transport = new Experimental_StdioMCPTransport({
    command: cfg.command,
    ...(Array.isArray(cfg.args) ? { args: cfg.args } : {}),
    cwd: cfg.cwd || ctx.cwd,
    ...(cfg.env ? { env: cfg.env } : {}),
  });
  const p = createMCPClient({ transport });
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const kill = () => {
      p.then((c) => c.close()).catch(() => {}); // 已握手完成的路径：正常关 client
      transport.close().catch(() => {}); // 握手挂起的路径：直接杀子进程（client 永远拿不到手）
    };
    const onAbort = () => {
      if (done) return;
      cleanup();
      kill();
      reject(abortError());
    };
    // 握手超时：必须杀掉子进程，否则它会作为孤儿一直挂着
    const timer = setTimeout(() => {
      if (done) return;
      cleanup();
      kill();
      reject(new Error(`MCP server 连接超时（${MCP_CONNECT_TIMEOUT_MS / 1000}s 未完成握手）`));
    }, MCP_CONNECT_TIMEOUT_MS);

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (c) => {
        if (done) return;
        cleanup();
        resolve(c);
      },
      (e) => {
        if (done) return;
        cleanup();
        reject(e);
      },
    );
  });
}

/** 纯函数：聚合各 server 的 autoAllow 工具名 → Set（canUseTool 命中即免审批放行） */
export function buildAutoAllowSet(configs) {
  const set = new Set();
  for (const c of Array.isArray(configs) ? configs : []) {
    if (!c || !Array.isArray(c.autoAllow)) continue;
    for (const name of c.autoAllow) {
      const n = String(name).trim();
      if (n) set.add(n);
    }
  }
  return set;
}

/** 纯函数：MCP 工具结果 → agent-loop 可回灌形态（取 text 内容；isError → {error}）。 */
export function normalizeMcpResult(r) {
  const content = Array.isArray(r?.content) ? r.content : [];
  const text = content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
  if (r?.isError) return { error: text || 'MCP 工具执行失败' };
  return text || content;
}
