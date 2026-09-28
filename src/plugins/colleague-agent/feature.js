/**
 * 同事对话 agent 的 dispatch feature（order 35；上一代 `colleague-relay` 插件已在 P3 下线，被本 feature 整体取代）。
 *
 * order 35 的理由沿用 1.0：在 action-runner(30) 之后、feedback(40) 之前 ——
 * 同事说「帮我退款」仍该触发动作脚本，说「接口文档给你」才归 agent 对话。
 *
 * 本 feature **只覆盖文本**。附件在 `entrypoints/feishu/index.js` 的 image/file 分支
 * 就被接走，到不了 dispatch，那条链路直接调 `relay.js`（两边共用同一个判定）。
 */
import { PASS } from '../../app/signals.js';
import { logger } from '../../shared/logger.js';
import { relayToAgent } from './relay.js';

export async function handle(ctx, _intentResult, deps = {}) {
  const { relay = relayToAgent } = deps;
  try {
    const taken = await relay({ openId: ctx?.user?.id, text: ctx?.text || '' });
    // 接管了就什么都不回：回复由 web 进程跑完 agent 后经 lark 直发。
    // 这里再回一句 ACK 的话，同事会先收到「已收到」再收到真回复，像两个机器人。
    return taken ? undefined : PASS;
  } catch (e) {
    // 异常一律 PASS 回落：让 feedback 把它当成普通反馈收走，
    // 总好过同事的消息因为一次异常彻底消失
    logger.warn('colleague-agent', 'feature 异常，交回后续 feature', { err: e?.message || String(e) });
    return PASS;
  }
}

export default {
  name: 'colleague-agent',
  permission: 'any',
  intents: ['bug', 'feature', 'question', 'material', 'other'],
  handle,
};
