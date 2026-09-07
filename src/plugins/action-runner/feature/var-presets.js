/**
 * 变量声明的内置预置（preset）—— **零依赖纯数据模块**。
 *
 * preset 不是类型系统，只是一份**预置默认值**：变量里显式写的字段永远赢（见 var-contract.js
 * 的 resolveVariable）。没有任何能力只能通过 preset 获得 —— 不用它手写 enum/aliases 完全等价。
 *
 * 存在的理由是防分叉：env 这套别名表若让每个动作各抄一份，加到第四个动作时必然走样。
 * 历史实证：Node 侧的 ENV_ALIASES 与 scripts/get_qrcode.py 的同名表就已经分叉过
 *（前者收了「正式」「生产」，后者没有），表现为「帮我清一下正式环境的数据」识别不出。
 *
 * ⚠️ 改动 preset 会**立即影响所有引用它的变量**（运行时展开，不落盘快照）。这是有意的
 * —— 修一处全局生效。不想被影响的配置应在 Web 表单点「展开预置为可编辑」实体化。
 *
 * 首版只做 env / phone 两个（YAGNI）：date/url/email 目前无使用场景，等真有需求再加。
 */

/**
 * 环境别名 → 规范值。
 *
 * 分成 aliases / weakAliases 两档是**事故驱动**的：
 * - 裸词「测试」「开发」在自由文本里几乎都是动词（「帮我测试一下这个功能」「开发那边说…」），
 *   放进 aliases 会把无关消息误判成带环境；
 * - 但在追问轮（已经问出「要哪个环境？」）整条消息就是对该字段的回答，此时用户只回
 *   「测试」两个字也必须认。
 * 故：aliases 自由文本 + 追问轮都生效，weakAliases **仅**追问轮生效。
 */
const ENV_ALIASES = {
  // —— dev ——
  dev: 'dev',
  development: 'dev',
  develop: 'dev',
  开发版: 'dev',
  开发环境: 'dev',
  // —— test ——
  test: 'test',
  trial: 'test',
  体验版: 'test',
  体验环境: 'test',
  测试版: 'test',
  测试环境: 'test',
  // —— prod ——
  prod: 'prod',
  production: 'prod',
  线上版: 'prod',
  线上环境: 'prod',
  正式版: 'prod',
  正式环境: 'prod',
  生产版: 'prod',
  生产环境: 'prod',
};

/**
 * 歧义别名：仅在追问轮生效。
 * `online` 也归在这里 —— 英文散文里「is it online」几乎都不是指环境。
 */
const ENV_WEAK_ALIASES = {
  开发: 'dev',
  测试: 'test',
  体验: 'test',
  正式: 'prod',
  线上: 'prod',
  生产: 'prod',
  online: 'prod',
};

/**
 * 归一前剥掉的尾巴词：「正式版二维码」→「正式版」、「dev 环境」→「dev」。
 * 只在**精确归一**（把一个候选串映射到规范值）时使用，不参与自由文本扫描。
 */
const ENV_JUNK = '(?:二维码|预览码|小程序码|的|环境|数据|订单|\\s)';

export const PRESETS = {
  env: {
    enum: ['dev', 'test', 'prod'],
    aliases: ENV_ALIASES,
    weakAliases: ENV_WEAK_ALIASES,
    junk: ENV_JUNK,
    example: '体验版',
  },
  phone: {
    // 不带锚点：pattern 有抽取（matchAll 定位）与校验（自动加锚点）两个派生用途，
    // 写成 ^...$ 会让抽取永远匹配不到自由文本里的号码。契约见 var-contract.js。
    pattern: '1[3-9]\\d{9}',
    example: '13800138000',
  },
};

/** 已知 preset 名（保存校验用；未知 preset 一律拒绝，静默忽略会让用户以为生效了） */
export const PRESET_NAMES = Object.keys(PRESETS);
