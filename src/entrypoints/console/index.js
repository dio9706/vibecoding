/**
 * 控制台入口 —— 组装层：console 渠道收行 → 统一 Context → dispatch。
 * 本地调试 features 全链（intent 分类/feature 路由/回复），无需飞书。
 * 用法：npm run chat:console；CONSOLE_ROLE=guest 可模拟访客（缺省 owner）。
 * 注意：dispatch 会真实调用意图分类与 feature（可能起 Claude 进程，烧额度）。
 */
import { createConsoleChannel } from '../../channels/console.js';
import { dispatch } from '../../app/dispatch.js';
import { logger } from '../../shared/logger.js';

const role = process.env.CONSOLE_ROLE === 'guest' ? 'guest' : 'owner';
const channel = createConsoleChannel({ userId: 'console-' + role });

async function onInbound(m) {
  const ctx = {
    source: 'console',
    user: { id: m.userId, role },
    text: m.text,
    sessionKey: m.chatKey,
    reply: (t) => channel.send(m.chatKey, { text: t }),
    meta: { messageId: m.messageId },
  };
  await dispatch(ctx);
}

channel
  .start({ onInbound })
  .catch((e) => logger.error('console', 'channel 启动失败', { err: e?.message || String(e) }));

console.log(`\n  控制台调试渠道已启动（role=${role}，Ctrl+C 退出）`);
