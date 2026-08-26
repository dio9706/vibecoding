/**
 * 机器人日志的文案渲染（纯函数，无 DOM 依赖 → 可被 node --test 直接 import）。
 * logs-panel.js 顶层 import 了 ui.js 并操作 DOM，测试里 import 会炸，故按项目既有的
 * `.logic.js` 约定把纯逻辑单独放这里。
 */

/** 机器人名；缺失（botId 已被删除或历史条目无此字段）显示占位符 */
export function botLabel(entry) {
  return (entry && entry.botName) || '机器人 —';
}

/**
 * 用户名；解析失败（飞书未开通 contact 权限等）回退 id 尾 6 位。
 * 尾号比整串 openId 短且足以区分不同人，适合固定行高的单行展示。
 */
export function userLabel(entry) {
  const e = entry || {};
  if (e.userName) return e.userName;
  const id = String(e.userId || '');
  return id ? `用户 …${id.slice(-6)}` : '用户 —';
}

/**
 * 一条日志 → { ok, text }。ok 供行首 ✅/❌ 使用。
 * ok 字段缺失按成功处理：旧条目容错，不能让缺字段的记录整行标红。
 */
export function formatBotLogEntry(entry) {
  const e = entry || {};
  const ok = e.ok !== false;
  const bot = botLabel(e);
  const user = userLabel(e);
  const detail = e.detail || '—';

  if (e.kind === 'chat') {
    // 引号内是**用户原话**，不是机器人的回复内容
    // 失败后缀与 action 文案的「· 成功」对齐：「」紧跟 ·，不留额外空格
    return { ok, text: `${bot} 回复了 ${user}：「${detail}」${ok ? '' : '· 处理失败'}` };
  }
  // 未知 kind 一并走动作文案兜底，避免出现空白行
  const tail = ok ? '成功' : `失败(code ${e.code ?? '-'})`;
  return { ok, text: `${bot} 为 ${user} 执行了「${detail}」· ${tail}` };
}
