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
];

/** 纯函数：core + 插件 feature 条目按 order 合并排序（sort 稳定：同 order 保持传入先后） */
export function assembleFeatures(coreEntries, pluginEntries) {
  return [...coreEntries, ...pluginEntries]
    .sort((a, b) => a.order - b.order)
    .map((e) => e.feature);
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
