/**
 * 变量声明契约 —— preset 展开 + 声明合法性校验。**零 IO 纯函数**。
 *
 * 本模块存在的全部意义：让抽取器**永远不需要知道变量叫什么名字**。
 *
 * 改造前的硬伤（三处按变量名硬编码，见 2026-09-04 spec §1.1）：
 *   slot-filler.js  NORMALIZERS = { env: normalizeEnv }        变量不叫 env 就没归一
 *   slot-filler.js  regexExtract 里写死 phone / env            变量不叫这两个就没本地兜底
 *   slot-filler.js  hasEnv = variables.some(v => v.name==='env')  连提示词都按名字分支
 * 用户新加一个动作、变量叫 region / 订单号，三处一处都不生效，表现为「机器人老是追问」。
 *
 * 改造后：抽取规则由变量自己声明（enum/aliases/weakAliases/pattern/preset/example），
 * 抽取器只读这些字段。名字回归它唯一该有的职责 —— 脚本的 `--{name}` 参数名。
 */
import { PRESETS, PRESET_NAMES } from './var-presets.js';

/**
 * 可被**变量声明**覆盖的字段。
 *
 * ⚠️ `junk` 刻意不在此列：它会被拼进 `new RegExp(rv.junk, 'g')`，用户可写任意字符串
 * 就等于开了一个「保存一条 `junk: "["` 就让每次抽取抛异常」的口子，而它既不在 Web 表单里、
 * 也没有任何用户需要自定义它的场景。让它**只能来自 preset**（可信、有单测覆盖）。
 */
const CONTRACT_KEYS = ['enum', 'aliases', 'weakAliases', 'pattern', 'example'];

/**
 * 展开 preset，得到该变量的**有效**抽取契约。
 *
 * 合并语义是**浅覆盖，不是深合并**：变量显式声明的字段整体替换 preset 的同名字段。
 * 为什么不深合并 —— 深合并下「我想删掉 preset 里的某个别名」无法表达（写什么都只会新增）。
 * 要在 preset 基础上增删，Web 表单提供「展开预置为可编辑」把内容实体化。
 *
 * @param {object|null|undefined} v 变量声明
 * @returns {{name:string, label:string, enum:string[]|null, aliases:object, weakAliases:object,
 *            pattern:string|null, example:string, junk:string|null, kind:'enum'|'pattern'|'free'}}
 */
export function resolveVariable(v) {
  const base = v && typeof v === 'object' ? v : {};
  const preset = typeof base.preset === 'string' ? PRESETS[base.preset] : null;

  const merged = { ...(preset || {}) };
  for (const k of CONTRACT_KEYS) {
    if (base[k] !== undefined) merged[k] = base[k];
  }

  const enumVals = Array.isArray(merged.enum) && merged.enum.length ? merged.enum.map(String) : null;
  const pattern = typeof merged.pattern === 'string' && merged.pattern ? merged.pattern : null;

  return {
    name: String(base.name ?? ''),
    label: String(base.label ?? base.name ?? ''),
    enum: enumVals,
    aliases: plainObject(merged.aliases),
    weakAliases: plainObject(merged.weakAliases),
    pattern,
    example: typeof merged.example === 'string' ? merged.example : '',
    junk: typeof merged.junk === 'string' && merged.junk ? merged.junk : null,
    // kind 决定抽取走哪一档。enum 优先于 pattern —— 两者互斥（validateVariable 会拒），
    // 但存量脏数据仍可能同时带上，此时按闭集处理更安全（闭集不会产出集合外的值）。
    kind: enumVals ? 'enum' : pattern ? 'pattern' : 'free',
  };
}

/** 非 null 的普通对象才收，其余一律空对象（配置读坏时不能让下游在 Object.entries 上炸） */
function plainObject(o) {
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
}

/**
 * 校验一条变量声明是否合法。**保存时调用**（Web 路由），运行时不再校验。
 *
 * 全部返回中文错误串（直接给用户看），合法返回 null。
 * 不做「静默修正」：静默丢弃非法字段会让用户以为配置生效了，而机器人行为却对不上。
 *
 * @param {object} v 变量声明（未展开 preset 的原始形态）
 * @returns {string|null} 错误说明；null = 合法
 */
export function validateVariable(v) {
  if (!v || typeof v !== 'object') return '变量声明必须是对象';
  const label = String(v.label || v.name || '(未命名变量)');

  if (v.preset !== undefined) {
    if (typeof v.preset !== 'string' || !PRESET_NAMES.includes(v.preset)) {
      return `「${label}」的预置类型「${v.preset}」不存在，可选：${PRESET_NAMES.join(' / ')}`;
    }
  }

  const hasEnum = v.enum !== undefined && v.enum !== null;
  const hasPattern = v.pattern !== undefined && v.pattern !== null && v.pattern !== '';

  if (hasEnum && hasPattern) {
    return `「${label}」不能同时声明合法值（enum）与正则（pattern）—— 前者是闭集、后者是开集，二选一`;
  }

  if (hasEnum) {
    if (!Array.isArray(v.enum) || !v.enum.length) return `「${label}」的合法值必须是非空数组`;
    if (v.enum.some((x) => typeof x !== 'string' || !x.trim())) {
      return `「${label}」的合法值必须全部是非空字符串`;
    }
  }

  if (hasPattern) {
    if (typeof v.pattern !== 'string') return `「${label}」的正则必须是字符串`;
    // 锚点会让「抽取」这一派生用途失效（^...$ 在自由文本里 matchAll 不到任何东西）。
    // 明确报错而不是默默 strip：strip 会在 `a$|b` 这种中间带 $ 的正则上悄悄改变语义。
    if (v.pattern.startsWith('^') || v.pattern.endsWith('$')) {
      return `「${label}」的正则请去掉首尾锚点（^ 与 $），系统会在校验时自动添加`;
    }
    try {
      new RegExp(v.pattern);
    } catch (e) {
      return `「${label}」的正则无法编译：${e.message}`;
    }
  }

  // 先单独校验用户**显式写的**映射表形状（`aliases: 42` 这类脏声明必须报错，
  // 而不是被 resolveVariable 的 plainObject 兜底成 {} 后静默放过）。
  for (const key of ['aliases', 'weakAliases']) {
    const map = v[key];
    if (map === undefined) continue;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return `「${label}」的${key}必须是对象`;
  }

  // 别名的**值**必须落在 enum 内 —— 否则会归一出 enum 之外的值，
  // 而 enum 常常正是运维用来「禁掉 prod」的那道闸。
  //
  // ⚠️ 校验对象必须是**展开 preset 之后**的映射表，不能只看 `v[key]`。
  // resolveVariable 是浅覆盖：变量声明 enum 只替换 enum，preset 的 aliases 原样保留。
  // 于是「选 preset=env + 把合法值收窄成 dev,test」这条 Web 表单直接可达的路径上，
  // preset 里「正式环境 → prod」从未与新 enum 对过账，用户发「清一下正式环境的数据」
  // 就会拿到一个他刻意禁掉的 prod。（复核实证，2026-09-04）
  const resolved = resolveVariable(v);
  for (const key of ['aliases', 'weakAliases']) {
    const map = resolved[key];
    if (!map || !Object.keys(map).length) continue;
    const fromPreset = v[key] === undefined && v.preset;
    for (const [alias, target] of Object.entries(map)) {
      if (!String(alias).trim()) return `「${label}」的${key}存在空别名`;
      if (!resolved.enum) return `「${label}」声明了${key}但没有合法值（enum），别名无处可映射`;
      if (!resolved.enum.includes(String(target))) {
        return fromPreset
          ? `「${label}」的合法值 ${resolved.enum.join('/')} 与预置「${v.preset}」冲突：` +
              `预置里的别名「${alias}」映射到「${target}」，不在合法值之内。` +
              `请点「展开预置为可编辑」后删掉用不到的别名，或把「${target}」加回合法值。`
          : `「${label}」的别名「${alias}」映射到「${target}」，但它不在合法值 ${resolved.enum.join('/')} 之内`;
      }
    }
  }

  return null;
}

/**
 * 校验一个动作的全部变量声明。
 * @param {object} actionConfig
 * @returns {string|null} 第一条错误；null = 全部合法
 */
export function validateActionVariables(actionConfig) {
  const list = actionConfig?.variables;
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) return 'variables 必须是数组';
  for (const v of list) {
    const err = validateVariable(v);
    if (err) return err;
  }
  return null;
}
