/**
 * 落盘前的敏感值脱敏（纯函数）。
 *
 * 背景：action-log 的旧实现**硬编码 fieldName === 'phone'**，其余字段一律原样写盘。
 * 而 action-runner 的变量完全由管理员在设置页自定义、由用户在飞书聊天里填入，
 * password / token / apiKey / secret / 身份证 / 邮箱 因此全部明文进了 action-log.jsonl
 * （该文件无加密、无权限收紧、且长期保留）。
 *
 * 两层防线：
 *   1. **字段名**匹配（凭证类一律全遮蔽；手机/邮箱/身份证保留少量可辨识片段便于排障）
 *   2. **值模式**匹配（字段名无辜但值本身长得像密钥时兜底，如 note: "sk-ant-..."）
 * 同时刻意不做过度脱敏：普通字段必须原样保留，否则日志会退化成一堆星号、失去排障价值。
 */

/** 凭证类字段：整体遮蔽，一个字符都不留 */
const SECRET_KEY_RE = /(pass(word|wd)?|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credential|auth)/i;
/** 手机号 */
const PHONE_KEY_RE = /(phone|mobile|tel)/i;
/** 邮箱 */
const EMAIL_KEY_RE = /(e?mail)/i;
/** 证件号 */
const ID_KEY_RE = /(id[-_]?card|idcard|identity|ssn|passport)/i;

/** 值本身长得像密钥：常见前缀 + 长随机串 */
const SECRET_VALUE_RE = /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/;

/** 完全遮蔽：只保留长度信息，便于确认「确实填了值」 */
function full(v) {
  return `***(${v.length})`;
}

/** 保留首尾的部分遮蔽；太短则退化为完全遮蔽（留了等于没遮） */
function partial(v, head, tail) {
  if (v.length < head + tail + 2) return full(v);
  return v.slice(0, head) + '****' + v.slice(-tail);
}

/**
 * 按字段名 + 值模式脱敏单个值。非字符串原样返回。
 * @param {*} value
 * @param {string} fieldName
 */
export function maskValue(value, fieldName) {
  if (typeof value !== 'string' || !value) return value;
  const k = String(fieldName || '');

  if (SECRET_KEY_RE.test(k)) return full(value);
  if (ID_KEY_RE.test(k)) return partial(value, 3, 2);
  if (PHONE_KEY_RE.test(k)) return value.length >= 7 ? partial(value, 3, 4) : full(value);
  if (EMAIL_KEY_RE.test(k)) {
    const at = value.indexOf('@');
    if (at > 0) return value[0] + '***@' + value.slice(at + 1); // 保留域名便于分辨是哪个账号体系
    return full(value);
  }
  // 字段名无辜，但值本身就是密钥（如 note: "sk-ant-..."）
  if (SECRET_VALUE_RE.test(value)) return full(value);
  return value;
}

/**
 * 递归脱敏。**不修改入参**——脱敏结果只用于落盘，绝不能污染业务对象。
 */
export function maskDeep(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((x) => maskDeep(x));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v && typeof v === 'object' ? maskDeep(v) : maskValue(v, k);
  }
  return out;
}
