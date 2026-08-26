/** 新用户引导的纯逻辑：判定与表单校验。
 *  无 DOM、无 fetch —— 这层单独拆出来就是为了能在 node 下直接单测，
 *  DOM 编排与请求发送全在 onboarding.js。 */

const APP_ID_RE = /^cli_[0-9a-fA-F]{16}$/; // 与后端 cleanBotInput 的校验保持一致
const OPEN_ID_MAX = 128;                   // 与后端 handleSettings section:'profile' 的上限一致

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** 新用户 = 一个模型凭证都没有。
 *  tokens 是两类模型（Claude 账号池 / openai-compat 自定义凭证）的唯一存储，
 *  所以一个条件就覆盖两类。
 *  非数组（字段缺失 / 脏数据 / 读盘异常）一律按「未配置」处理：多引导一次只是打扰，
 *  漏引导会把真新用户丢进一个必然报错的界面。 */
export function isNewUser(settings) {
  const tokens = settings && settings.tokens;
  return !Array.isArray(tokens) || tokens.length === 0;
}

/**
 * 校验引导表单。
 * @param {{
 *   modelTab?: 'claude' | 'custom',
 *   claude?: { label?: string, token?: string },
 *   custom?: { vendor?: string, apiKey?: string, baseURL?: string, model?: string },
 *   openId?: string,
 *   bot?: { name?: string, appId?: string, appSecret?: string },
 * }} state
 * @returns {{ ok: boolean, errors: { model?: string, openId?: string, bot?: string } }}
 */
export function validateOnboardForm(state) {
  const s = state || {};
  const errors = {};

  // ① 模型段：必填。modelTab 非 'custom' 一律按 claude 分支走 ——
  //    脏枚举值不能让整段校验被跳过，那会放一个空模型进去
  if (s.modelTab === 'custom') {
    const c = s.custom || {};
    if (!str(c.apiKey)) errors.model = '请填写 API Key';
    else if (!str(c.baseURL)) errors.model = '请填写 Base URL';
    else if (!str(c.model)) errors.model = '请填写模型名';
  } else {
    if (!str((s.claude || {}).token)) errors.model = '请填写 Token';
  }

  // ② open_id：选填，填了才校验长度
  if (str(s.openId).length > OPEN_ID_MAX) {
    errors.openId = `open_id 不能超过 ${OPEN_ID_MAX} 字符`;
  }

  // ③ 机器人：选填。三字段全空 = 这段没动，合法；
  //    一旦动了任一个就要求 appId/appSecret 齐全且格式对 ——
  //    否则就是拿一个后端存不进去的半截配置去调 /api/bots
  const b = s.bot || {};
  const botTouched = !!(str(b.name) || str(b.appId) || str(b.appSecret));
  if (botTouched) {
    const appId = str(b.appId);
    if (!appId) errors.bot = '请填写 App ID';
    else if (!APP_ID_RE.test(appId)) errors.bot = 'App ID 格式应为 cli_ 加 16 位十六进制';
    else if (!str(b.appSecret)) errors.bot = '请填写 App Secret';
  }

  return { ok: Object.keys(errors).length === 0, errors };
}
