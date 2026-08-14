/**
 * 机器人文案注册表 —— 飞书侧用户可见「门面文案」唯一出口。
 * 覆盖值存当前启用机器人（settings.json bots[].messages，web 写、feishu 读）；
 * readJson 无缓存 → 调用点必须在回复时调 msg()（勿存模块级常量），保存后下一条消息即生效。
 * 可配 key 限 BOT_MESSAGE_KEYS（机器人编辑表单渲染）；welcome/materialAck/execNewChat 恒用默认文案。
 */
import { getActiveBot } from '../store/settings.js';

export const MAX_LEN = 2000;

/** 机器人可配文案 key（per-bot）；welcome/materialAck/execNewChat 不可配，恒用默认 */
export const BOT_MESSAGE_KEYS = ['ackBug', 'ackFeature', 'ackQuestion', 'ackAction', 'execProcessing'];

export const REGISTRY = {
  welcome: {
    label: '未识别意图兜底提示',
    // ⚠️ 三条「例:」不是随手举例，是**必须能被 intent-keywords.js 的强前缀识别**的说法
    //（intent.test.js 有断言守着）。特别地「提个bug」中间**不能加空格** —— 词表里是
    // 无空格字面量，'提个 bug: xxx' 会掉出 L1 前缀快路，等于教用户说一句识别不了的话。
    // 缩进用空格而非 Tab：飞书文本消息里 Tab 在桌面端/移动端渲染宽度不一致。
    defaultText:
      '没有识别到你的意图，我可以进行这些操作：\n' +
      '· 提交需求\n' +
      '    例: 提个需求: 把背景改成蓝色\n' +
      '· 提交故障\n' +
      '    例: 提个bug: 聊天主页面语音有问题\n' +
      '· 问个问题\n' +
      '    例: 问个问题: 我要在聊天页加个弹框, 这个功能复杂吗?\n' +
      '\n' +
      '或其他已配置的功能，比如\n' +
      '    1. 给我小程序的二维码\n' +
      '    2. 帮我清一下环境数据\n' +
      '    3. 帮我退下款\n' +
      '\n' +
      '识别到我会及时回复你～',
  },
  // 三条即时应答：意图确定后的第一条回复（取代原「已收集」确认文案）
  ackBug: {
    label: '故障即时应答',
    defaultText: '请稍等，我先思考此故障是否由我的项目引发！',
  },
  ackFeature: {
    label: '需求即时应答',
    defaultText: '请稍等，我先思考此需求的复杂度与收益是否值得做！',
  },
  ackQuestion: {
    label: '问询即时应答',
    defaultText: '请稍等，我先去翻阅代码再回来回答你的问题！',
  },
  // 动作路径的槽位抽取要调一次 LLM（生产实测 6~12s），期间用户看不到任何反馈，
  // 观感上就是「机器人死了」。发在抽取之前，让用户第一秒就知道消息收到了。
  ackAction: {
    label: '动作即时应答',
    defaultText: '请稍等，我正在确认执行这个操作所需的信息！',
  },
  materialAck: {
    label: '材料收讫提示',
    defaultText: '📎 已收到材料～请描述对应的需求或问题，我会把材料一并带上（10 分钟内有效）。',
  },
  execNewChat: { label: '新对话确认（owner）', defaultText: '🆕 已开始新对话' },
  execProcessing: { label: '处理中提示（owner）', defaultText: '🤔 处理中…' },
};

/** 纯逻辑：覆盖值（非空）优先；未知 key 抛错，开发期即暴露注册表与调用点不一致 */
export function resolveMessage(key, overrides) {
  const entry = REGISTRY[key];
  if (!entry) throw new Error(`未知文案 key：${key}`);
  const v = overrides?.[key];
  return typeof v === 'string' && v.trim() ? v : entry.defaultText;
}

/** 回复时调用（每次读盘）——覆盖值来自当前启用机器人；无启用机器人或不可配 key 用默认 */
export function msg(key) {
  return resolveMessage(key, getActiveBot()?.messages);
}

/** 供机器人编辑表单：各条可配文案的 key/label/defaultText + 覆盖值（无覆盖回 ''） */
export function listBotMessages(values = {}) {
  return BOT_MESSAGE_KEYS.map((key) => ({
    key,
    label: REGISTRY[key].label,
    defaultText: REGISTRY[key].defaultText,
    value: typeof values?.[key] === 'string' ? values[key] : '',
  }));
}

/** 纯逻辑：机器人文案入参清洗 —— 只收 BOT_MESSAGE_KEYS、trim、剔空；单条超长报错 */
export function sanitizeMessages(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, error: 'values 须为对象' };
  }
  const clean = {};
  for (const key of BOT_MESSAGE_KEYS) {
    const v = values[key];
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!t) continue;
    if (t.length > MAX_LEN) return { ok: false, error: `「${REGISTRY[key].label}」超过 ${MAX_LEN} 字符` };
    clean[key] = t;
  }
  return { ok: true, values: clean };
}
