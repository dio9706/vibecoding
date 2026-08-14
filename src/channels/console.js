/**
 * 控制台开发渠道 —— Channel 契约的第二个实现（Phase 2 契约验证），兼本地调试用：
 * stdin 逐行 → InboundMessage(kind=text)；出站直接打印。无外部依赖，离线可用。
 * 真实用法见 entrypoints/console（接 dispatch 全链，无需飞书即可调试 features）。
 */
import readline from 'node:readline';

export function createConsoleChannel({ userId = 'console-user', input, output } = {}) {
  let rl = null;
  let seq = 0;
  return {
    id: 'console',
    capabilities: { text: true, richText: false, image: false, reaction: false },

    async start({ onInbound }) {
      rl = readline.createInterface({
        input: input || process.stdin,
        output: output || process.stdout,
        prompt: '你> ',
      });
      rl.prompt();
      rl.on('line', (line) => {
        const text = line.trim();
        if (!text) return rl.prompt();
        Promise.resolve(
          onInbound({
            channelId: 'console',
            chatKey: 'console',
            messageId: 'con_' + ++seq,
            userId,
            kind: 'text',
            text,
            images: [],
            raw: { line },
          }),
        )
          .catch((e) => console.error('[console-channel] 处理失败:', e?.message || e))
          .finally(() => rl?.prompt());
      });
    },

    stop() {
      rl?.close();
      rl = null;
    },

    send(_chatKey, { text }) {
      (output || process.stdout).write('\n🤖 ' + text + '\n');
      return Promise.resolve();
    },
  };
}
