/**
 * 机器人文案注册表 —— 飞书侧用户可见「门面文案」唯一出口。
 * 覆盖值存当前启用机器人（settings.json bots[].messages，web 写、feishu 读）；
 * readJson 无缓存 → 调用点必须在回复时调 msg()（勿存模块级常量），保存后下一条消息即生效。
 * 可配 key 限 BOT_MESSAGE_KEYS（机器人编辑表单渲染）；welcome/materialAck/execNewChat 恒用默认文案。
 */
import { getActiveBot } from '../store/settings.js';
import { getConfigs } from '../store/action-configs.js';

export const MAX_LEN = 2000;

/** 机器人可配文案 key（per-bot）；welcome/materialAck/execNewChat 不可配，恒用默认 */
export const BOT_MESSAGE_KEYS = ['ackBug', 'ackFeature', 'ackQuestion', 'ackAction', 'execProcessing'];

/**
 * welcome 的核心能力条目 —— **三处文案（REGISTRY 默认值 / buildWelcomeText / buildWelcomeCard）
 * 共用这一份**。此前是三份手抄副本，改一处漏两处只是时间问题。
 *
 * ⚠️ 每条「例:」都不是随手举例，而是**必须真能触发对应功能**的说法（有单测守着）：
 * - 前三条走 `app/intent-keywords.js` 的 L1 强前缀。特别地「提个bug」中间**不能加空格** ——
 *   词表里是无空格字面量，'提个 bug: xxx' 会掉出快路，等于教用户说一句识别不了的话。
 * - 第四条走 `plugins/tracking-stats` 的前缀 match（`TRACKING_PREFIX`，必须在**句首**），
 *   它是插件型 feature、不走 action-configs，所以下面的「已配置功能」段永远列不到它 ——
 *   不写在这里用户就永远不知道有这个功能（生产近 4 天未识别兜底触发 109 次）。
 *   架构阶段会改成插件自声明能力条目，届时这份硬编码清单应当退场。
 *
 * 缩进用空格而非 Tab：飞书文本消息里 Tab 在桌面端/移动端渲染宽度不一致。
 */
const CORE_CAPABILITIES = [
  { title: '提交需求', example: '提个需求: 把背景改成蓝色' },
  { title: '提交故障', example: '提个bug: 聊天主页面语音有问题' },
  { title: '问个问题', example: '问个问题: 我要在聊天页加个弹框, 这个功能复杂吗?' },
  { title: '统计埋点', example: '帮我统计埋点: 最近7天分享功能的点击' },
];

const WELCOME_HEAD = '没有识别到你的意图，我可以进行这些操作：\n';

/** 渲染能力条目；sep 决定条目间是否空行（纯文本紧凑，卡片留白） */
function renderCapabilities(sep) {
  return CORE_CAPABILITIES.map((c) => `· ${c.title}\n    例: ${c.example}`).join(sep);
}

/** 纯文本形态的核心段（末尾带换行，便于直接拼动作段） */
const WELCOME_CORE_TEXT = WELCOME_HEAD + renderCapabilities('\n') + '\n';

export const REGISTRY = {
  welcome: {
    label: '未识别意图兜底提示',
    defaultText:
      WELCOME_CORE_TEXT +
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
  // 动作路径的槽位抽取**若真要调 LLM**（生产实测 8~17s），期间用户看不到任何反馈，
  // 观感上就是「机器人死了」。这条就是为那段静默准备的。
  // ⚠️ 只在真发起模型调用时才发（由 slot-filler 的 onLlmStart 回调驱动）——
  // 变量声明了 enum/pattern 时本地亚毫秒抽完，此时再发这句，用户会紧接着看到
  // 「⏳ 正在执行…」，两条挨在一起反而像卡了一下。别改回「有必填变量就发」。
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

/**
 * 动态构造"未识别意图"兜底文案
 * @param {string|null} botId 机器人 ID；为空/未知 bot 时返回基础文案
 * @param {Array} actions 动作配置列表；若未提供则使用 getConfigs() 读取
 * @returns {string} 完整文案（包含动态获取的动作列表）
 */
export function buildWelcomeText(botId, actions) {
  // 1. 静态核心段（与 REGISTRY.welcome / buildWelcomeCard 同源，见 CORE_CAPABILITIES）
  const core = WELCOME_CORE_TEXT;

  // 2. 读取该 bot 的已启用动作
  // 优先使用传入的 actions 参数，否则调用 getConfigs()
  const configList = actions || getConfigs();
  const enabledActions = configList
    .filter((c) => c && c.botId === botId && c.enabled)
    .slice(0, 5); // 最多 5 条

  // 3. 拼装动作段（或提示段）
  let actionSection = '';
  if (enabledActions.length > 0) {
    actionSection = '\n或其他已配置的功能，比如\n';
    enabledActions.forEach((action, i) => {
      // 优先用 description，否则降级用 name
      const label = (action.description && action.description.trim()) || action.name || '';
      actionSection += `    ${i + 1}. ${label}\n`;
    });

    // 超出 5 条时追加「…等」提示
    const totalEnabled = configList.filter((c) => c && c.botId === botId && c.enabled).length;
    if (totalEnabled > 5) {
      actionSection += `    …等 ${totalEnabled - 5} 项\n`;
    }
  } else {
    // 无已启用动作：显示提示语
    actionSection = '\n或其他已配置的功能（暂未配置）\n';
  }

  // 4. 拼装完整文案
  return core + actionSection + '\n识别到我会及时回复你～';
}

/**
 * 构造 Welcome 飞书卡片（包含操作说明 + 动作快捷按钮）
 * @param {string|null} botId 机器人 ID
 * @param {Array} actions 动作配置列表；若未提供则使用 getConfigs() 读取
 * @returns {object} Feishu schema 1.0 卡片 JSON
 */
export function buildWelcomeCard(botId, actions) {
  // 1. 操作说明段（Markdown 格式；条目间留空行，与纯文本形态的唯一差别）
  const headerText = WELCOME_HEAD + '\n' + renderCapabilities('\n\n');

  // 2. 读取该 bot 的已启用动作，最多 5 条
  // 优先使用传入的 actions 参数，否则调用 getConfigs()
  const configList = actions || getConfigs();
  const enabledActions = configList
    .filter((c) => c && c.botId === botId && c.enabled)
    .slice(0, 5);

  // 3. 生成按钮区（action 元素）
  const actionButtons = enabledActions.map((action) => ({
    tag: 'button',
    type: 'primary',
    text: { tag: 'plain_text', content: action.name },
    value: {
      kind: 'quick-action',
      actionId: action.id,
      actionName: action.name,
      botId: botId,
      _timestamp: Date.now(),
    },
  }));

  // 4. 超过 5 条时追加提示文本
  const totalEnabled = configList.filter((c) => c && c.botId === botId && c.enabled).length;
  if (totalEnabled > 5) {
    actionButtons.push({
      tag: 'text',
      content: `…还有 ${totalEnabled - 5} 项动作，可直接对我说「帮我 [动作名]」`,
    });
  }

  // 5. 拼装卡片（含说明 + 按钮区，或仅说明）
  const elements = [{ tag: 'div', text: { tag: 'lark_md', content: headerText } }];

  if (actionButtons.length > 0) {
    elements.push({ tag: 'action', actions: actionButtons });
  }

  return { elements };
}

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
