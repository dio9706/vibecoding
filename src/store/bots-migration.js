/**
 * bots 迁移编排 —— 旧「单飞书凭证 + 全局 persona/messages + 无主动作」→ 机器人实体模型。
 * web 启动（initializeDefaults）与配置导入后调用；幂等：
 * 1. bots 为空且存在旧 settings 配置 → 生成启用的「机器人 1」并清空旧字段；
 * 2. 只要存在机器人，就收养 botId 缺失/失配的动作（同时治愈导入旧配置后的引用失配）。
 */
import { migrateLegacySettingsToBot, getBots, pickActiveBot } from './settings.js';
import { adoptOrphanConfigs } from './action-configs.js';
import { BOT_MESSAGE_KEYS } from '../shared/messages.js';

export function migrateToBots() {
  const created = migrateLegacySettingsToBot({ messageKeys: BOT_MESSAGE_KEYS });
  const bots = getBots();
  if (bots.length === 0) return { migrated: false, adopted: 0 };
  const fallback = pickActiveBot(bots) || bots[0];
  const adopted = adoptOrphanConfigs(fallback.id, new Set(bots.map((b) => b.id)));
  return { migrated: !!created, adopted };
}
