/**
 * 机器人工程边界提示 —— 飞书侧 Claude 调用统一注入：
 * 文件修改仅限机器人的项目文件夹；本机其他目录/工程只读，可作逻辑参考；工程说明作为背景信息。
 * 纯函数（bot 为 null / 字段为空时返回 ''），调用点每次组装，保存配置后下一条消息生效。
 */
/** persona + 工程边界/说明 组合为 system prompt 追加段（claude-exec / project-qa / task-ops 统一入口） */
export function botSystemAppend(bot) {
  if (!bot) return '';
  return [bot.persona || '', botScopePrompt(bot)].filter(Boolean).join('\n\n');
}

export function botScopePrompt(bot) {
  if (!bot) return '';
  const parts = [];
  if (bot.projectDir) {
    parts.push(
      `你负责的工程目录：${bot.projectDir}\n` +
        `文件修改仅限该目录内。本机其他目录/工程一律只读——可以查阅实现、对比逻辑作为修改参考，但绝不改动其中任何文件。`,
    );
  }
  if (bot.projectNotes) {
    parts.push(`工程说明（处理该工程相关工作时参考）：\n${bot.projectNotes}`);
  }
  return parts.join('\n\n');
}
