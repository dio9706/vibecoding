/**
 * 内置 MCP 注册表 —— 开箱可用的常用 MCP（context7 / figma），带逐项开关。
 *
 * ## 与「用户自定义 MCP」的边界
 *
 * `settings.mcpServers` 是用户手配的（CRUD 在设置页）；本注册表是产品内置的（代码里声明、设置里只存开关）。
 * 两者最终都汇进同一条连接管线：
 * - openai 路径：`run-openai.js` 把本注册表解析结果与用户配置合并后交 `providers/mcp.js`；
 * - Claude 路径：`run-claude.js` 把本注册表解析结果转成 SDK `mcpServers` 形态直传（**不注入用户配置**，
 *   避免存量用户行为突变——用户 MCP 全路径统一是后续独立子项）。
 *
 * ## 形态与路径差异（如实标注，UI 同步展示）
 *
 * - context7：stdio（npx），双路径可用；
 * - figma-devmode：http://127.0.0.1:3845/mcp，**仅 Claude 路径**（openai 路径的 MCP 客户端只有 stdio transport）；
 * - figma-framelink：stdio（npx + FIGMA_API_KEY），双路径可用。
 *
 * ## 命令注入纪律
 *
 * 内置命令是代码里的常量（npx + 固定包名），**不接受任何运行时数据拼接**；apiKey 只作为 env 注入，
 * 不参与命令行。与 verifier 的命令纪律同源：绝不给模型开任意命令通道。
 */
import { BUILTIN_MCP_IDS } from '../shared/builtin-ids.js';

export const BUILTIN_MCP = Object.freeze([
  {
    id: 'context7',
    label: 'Context7（最新文档）',
    desc: '按库名实时检索最新官方文档与用法示例',
    transport: 'stdio',
    paths: ['claude', 'openai'],
    defaultEnabled: true,
    autoAllow: ['resolve-library-id', 'get-library-docs'], // 只读工具（openai 路径免审批）
    needsKey: { env: 'CONTEXT7_API_KEY', required: false }, // 不填也能用（有速率限制）
    npx: ['-y', '@upstash/context7-mcp'],
  },
  {
    id: 'figma-devmode',
    label: 'Figma（本地 Dev Mode）',
    desc: '读取 Figma 桌面端 Dev Mode 的设计上下文（需 Figma 桌面运行且开启 MCP）',
    transport: 'http',
    url: 'http://127.0.0.1:3845/mcp',
    paths: ['claude'],
    defaultEnabled: false,
    probe: 'http://127.0.0.1:3845/mcp',
    autoAllow: [],
  },
  {
    id: 'figma-framelink',
    label: 'Figma（Framelink API）',
    desc: '经 Figma REST API 读设计（需 Figma API Key，双路径可用）',
    transport: 'stdio',
    paths: ['claude', 'openai'],
    defaultEnabled: false,
    autoAllow: ['get_figma_data', 'download_figma_images'],
    needsKey: { env: 'FIGMA_API_KEY', required: true },
    npx: ['-y', 'figma-developer-mcp', '--stdio'],
  },
]);

/** 注册表与 id 白名单必须严格一致（防两处漂移；白名单在 shared，settings 的 normalize 也读它） */
export function registryIdsMatchWhitelist() {
  const ids = BUILTIN_MCP.map((d) => d.id).sort();
  return JSON.stringify(ids) === JSON.stringify([...BUILTIN_MCP_IDS].sort());
}

/**
 * npx 的平台调用形态。
 * openai 路径的 stdio transport 不走 shell，Windows 上 `npx` 是 `npx.cmd`（spawn 直接找不到）；
 * 统一包一层 cmd.exe，两条路径行为一致。
 */
export function npxInvocation(args, platform = process.platform) {
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npx', ...args] }
    : { command: 'npx', args: [...args] };
}

/**
 * 按开关 + 目标路径解析出可用内置项。
 *
 * @param {{settings?:object, state?:object, provider:'claude'|'openai', platform?:string}} opts
 *   state = settings.builtinMcp（也可直接传）；缺省值以注册表 defaultEnabled 为准（老 settings 无需迁移）。
 * @returns {Array<{id:string, builtinId:string, label:string, transport:'stdio'|'http', command?:string, args?:string[], env?:object, url?:string, autoAllow:string[]}>}
 *   注意「缺必需密钥」的条目不产出（UI 侧提示去配置），而不是产出后连接失败。
 */
export function resolveBuiltinMcp({ settings, state, provider, platform = process.platform } = {}) {
  const st = (state && typeof state === 'object' ? state : null) || settings?.builtinMcp || {};
  const out = [];
  for (const def of BUILTIN_MCP) {
    if (!def.paths.includes(provider)) continue;
    const entryState = st[def.id] && typeof st[def.id] === 'object' && !Array.isArray(st[def.id]) ? st[def.id] : {};
    const enabled = typeof entryState.enabled === 'boolean' ? entryState.enabled : def.defaultEnabled;
    if (!enabled) continue;
    if (def.needsKey?.required && !entryState.apiKey) continue; // 缺密钥：设置页会提示，这里不产出

    if (def.transport === 'http') {
      out.push({
        id: `builtin:${def.id}`,
        builtinId: def.id,
        label: def.label,
        transport: 'http',
        url: def.url,
        autoAllow: [...(def.autoAllow || [])],
      });
      continue;
    }
    const inv = npxInvocation(def.npx, platform);
    const env = {};
    if (def.needsKey?.env && entryState.apiKey) env[def.needsKey.env] = entryState.apiKey;
    out.push({
      id: `builtin:${def.id}`,
      builtinId: def.id,
      label: def.label,
      transport: 'stdio',
      command: inv.command,
      args: inv.args,
      ...(Object.keys(env).length ? { env } : {}),
      autoAllow: [...(def.autoAllow || [])],
    });
  }
  return out;
}

/** 解析结果 → Claude Agent SDK 的 McpServerConfig（stdio / http 两形态） */
export function toClaudeServerConfig(entry) {
  if (entry.transport === 'http') return { type: 'http', url: entry.url };
  return {
    type: 'stdio',
    command: entry.command,
    args: entry.args,
    ...(entry.env ? { env: entry.env } : {}),
  };
}

/**
 * 本地服务探测（figma-devmode 这类 http 端点）。
 * 服务在监听即算可用——MCP 端点对普通 GET 可能返回 4xx/406，能响应就说明进程活着。
 * @returns {Promise<boolean|null>} null = 该项没有 probe 端点
 */
export async function probeBuiltinMcp(def, { fetchImpl = fetch, timeoutMs = 800 } = {}) {
  if (!def?.probe) return null;
  try {
    await fetchImpl(def.probe, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}
