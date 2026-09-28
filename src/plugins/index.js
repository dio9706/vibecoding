/**
 * 插件清单与装配 —— 业务功能（团队工具等）以插件挂载，内核 dispatch 不再硬编码业务 feature。
 * 停用的插件不 import（动态加载）：内核进程不载入业务代码，这是「内核更纯」的实质。
 * 启停：settings.json plugins 节（缺省启用=向后兼容）；order 决定 dispatch 匹配优先级（小者先）。
 */
import { getPluginEnabled } from '../store/settings.js';
import { logger } from '../shared/logger.js';

/** 已知插件清单：id + 说明 + 动态加载器（模块 default 导出 { id, features: [{ order, feature }] }） */
export const PLUGIN_MANIFEST = [
  {
    id: 'team-tools',
    description: '飞书团队工具：需求/故障收集（feedback）+ owner 待办分诊（task-triage）',
    load: () => import('./team-tools/index.js'),
  },
  {
    id: 'feishu-relay',
    description: 'web 会话飞书回控：通知卡片的[补充内容]/[结束会话]，把补充内容注入执行台会话',
    load: () => import('./feishu-relay/index.js'),
  },
  {
    id: 'action-runner',
    description: '配置驱动的通用动作执行（脚本 + 槽位填充）',
    load: () => import('./action-runner/index.js'),
  },
  {
    id: 'tracking-stats',
    description: '埋点统计：「帮我统计埋点: <自然语言>」→ 两阶段推理 → 查生产埋点库 → HTML 报告附件',
    load: () => import('./tracking-stats/index.js'),
  },
  {
    id: 'colleague-agent',
    description: '同事侧对话 Agent：按职位装配业务工具，接管名册内同事的飞书消息做多轮对话',
    load: () => import('./colleague-agent/index.js'),
  },
];

/** 纯函数：core + 插件 feature 条目按 order 合并排序（sort 稳定：同 order 保持传入先后） */
export function assembleFeatures(coreEntries, pluginEntries) {
  return [...coreEntries, ...pluginEntries]
    .sort((a, b) => a.order - b.order)
    .map((e) => e.feature);
}

/**
 * 按 id 加载插件模块，**只为触发模块级副作用**（工具自注册、卡片回调注册），不取 features。
 *
 * 为什么非有这个不可：`loadEnabledPluginFeatures` 只被 `app/dispatch.js` 那条链调用，
 * 而 web 入口对 `app/` 零引用 —— **web 进程根本不走装配层**。于是插件里靠模块加载注册的
 * 能力（`colleague-agent` 的 agent 工具）在 web 进程一个都不会注册，而 agent 会话恰恰
 * 跑在 web 进程（起 run 必须在那里）。
 *
 * 失败形态极隐蔽，这是它值得单独一个函数的全部理由：注册表为空 → `buildAgentMcpServer`
 * 安静地造出一个**零工具**的 MCP server → 模型看不到工具就凭记忆作答，
 * **回复照样通顺、日志里什么都没有**。`agent-tools.js` 那行 `picked.length === 0` 的 warn
 * 是最后一道哨，但别让它有机会响。
 *
 * 仍然逐个过 `getPluginEnabled`：这是补装配层的缺口，**不是绕开停用开关的后门**。
 * 单个失败隔离（与 `loadEnabledPluginFeatures` 同款纪律）：一个插件加载不了不该让 web 起不来。
 *
 * @param {string[]} ids 插件 id
 * @param {{manifest?:Array, isEnabled?:Function}} [deps] 供测试注入
 * @returns {Promise<{loaded:string[], skipped:string[], failed:string[]}>} **不抛**
 */
export async function loadPluginSideEffects(ids, deps = {}) {
  const { manifest = PLUGIN_MANIFEST, isEnabled = getPluginEnabled } = deps;
  const out = { loaded: [], skipped: [], failed: [] };
  for (const id of ids) {
    const p = manifest.find((x) => x.id === id);
    if (!p) {
      // 拼错的 id 是编程错误，但不该让 web 起不来——响亮记一笔，继续
      logger.error('plugins', `请求副作用加载的插件不在清单里：${id}`);
      out.failed.push(id);
      continue;
    }
    if (!isEnabled(id)) {
      logger.info('plugins', `插件已停用，跳过副作用加载：${id}`);
      out.skipped.push(id);
      continue;
    }
    try {
      await p.load();
      out.loaded.push(id);
    } catch (e) {
      logger.error('plugins', `插件副作用加载失败：${id}`, { err: e?.message || String(e) });
      out.failed.push(id);
    }
  }
  return out;
}

/** 加载启用插件的 feature 条目；停用不 import；单个插件加载失败隔离并告警（不拖垮内核启动） */
export async function loadEnabledPluginFeatures() {
  const out = [];
  for (const p of PLUGIN_MANIFEST) {
    if (!getPluginEnabled(p.id)) {
      logger.info('plugins', `插件已停用，跳过加载：${p.id}`);
      continue;
    }
    try {
      const mod = (await p.load()).default;
      out.push(...mod.features);
    } catch (e) {
      logger.error('plugins', `插件加载失败，跳过：${p.id}`, { err: e?.message || String(e) });
    }
  }
  return out;
}
