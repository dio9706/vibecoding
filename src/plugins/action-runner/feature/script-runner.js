/**
 * 脚本执行和脱敏日志 —— 组装脚本参数、脱敏敏感字段、记录执行日志。
 * - buildScriptArgs：按配置顺序拼装参数数组（--varName value）
 * - maskVars：脱敏变量对象中的敏感字段（phone）
 * - pickOutput：决定回给用户的脚本输出（失败时 stdout 不许丢）
 * - describeTarget：执行目标的可读描述（哪个环境、哪个号）
 * - runAction：完整执行流程（组装参数 → 调用 runScript → 记录日志）
 */
import path from 'node:path';
import { logger } from '../../../shared/logger.js';
import { config } from '../../../shared/config.js';
import { runScript } from '../../../integrations/shell.js';
import { appendActionLog } from '../../../store/action-log.js';
import { recordBotActivity } from '../../../shared/bot-activity.js';
import { getConfig } from '../../../store/action-configs.js';

/**
 * 从配置和收集的变量组装脚本参数数组
 * 按 config.variables 定义的顺序遍历，拼装 --varName value 对
 * 变量不存在则跳过（无论 required 是否为 true）
 *
 * @param {Object} actionConfig - 动作配置 { scriptName, variables: [{name, required}] }
 * @param {Object} collectedVars - 收集到的变量 { varName: value }
 * @returns {string[]} 参数数组，如 ['--env', 'test', '--phone', '15901039503']
 */
export function buildScriptArgs(actionConfig, collectedVars) {
  const args = [];

  if (!actionConfig.variables || !Array.isArray(actionConfig.variables)) {
    return args;
  }

  for (const varDef of actionConfig.variables) {
    const { name } = varDef;
    // 变量存在则拼装 --name value，不存在则跳过
    if (name in collectedVars && collectedVars[name] != null) {
      args.push(`--${name}`);
      args.push(String(collectedVars[name]));
    }
  }

  return args;
}

/**
 * 脱敏变量对象中的敏感字段（仅手机号）
 * 手机号脱敏规则：保留前 3 位和后 4 位，中间用 * 替换（如 159****9503）
 * 递归处理嵌套对象和数组
 *
 * @param {*} value - 待脱敏的值（可能是对象、数组或基本类型）
 * @param {string} [fieldName] - 字段名（仅在递归调用时传递）
 * @returns {*} 脱敏后的值
 */
function maskValue(value, fieldName) {
  // 仅脱敏 phone 字段且值为长度 >= 7 的字符串
  if (fieldName === 'phone' && typeof value === 'string' && value.length >= 7) {
    const prefix = value.slice(0, 3);
    const suffix = value.slice(-4);
    return `${prefix}****${suffix}`;
  }
  return value;
}

function maskValueRecursive(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskValueRecursive(item));
  }

  const masked = {};
  for (const [key, val] of Object.entries(value)) {
    if (val === null || typeof val !== 'object') {
      // 基本类型：检查字段名是否需要脱敏
      masked[key] = maskValue(val, key);
    } else {
      // 递归处理对象/数组
      masked[key] = maskValueRecursive(val);
    }
  }
  return masked;
}

/**
 * 脱敏变量对象
 * @param {Object} vars - 变量对象
 * @returns {Object} 脱敏后的变量对象
 */
export function maskVars(vars) {
  if (!vars || typeof vars !== 'object') {
    return vars;
  }
  return maskValueRecursive(vars);
}

/**
 * 决定回给用户的脚本输出。
 *
 * ⚠️ 失败时 **stdout 必须一起带上**（事故驱动，勿改回只取 stderr）：
 * 本项目的脚本把失败原因 `print()` 到 stdout 再 `exit 1`
 *（`reset_onboarding.py` / `refund_orders.py` 都是 `print(f"❌ {e}")`），
 * 只取 stderr 会让用户收到「❌ 执行失败 (无输出)」而真实原因被静默丢弃 ——
 * 实证 2026-09-11 两次 test 环境清理失败全是这个空壳提示（app-2026-09-11.log:777）。
 * 成功路径保持只取 stdout：stderr 上的 DeprecationWarning 之类不该污染回执。
 *
 * @param {{ok:boolean, out?:string, err?:string, msg?:string}} result runScript 的返回
 * @returns {string}
 */
export function pickOutput(result) {
  if (result?.ok) return result.out || '';
  return [result?.out, result?.err, result?.msg].filter(Boolean).join('\n').trim();
}

/**
 * 执行目标的可读描述（给 ⏳ 与结果回执用，phone 经 maskVars 脱敏）。
 *
 * 为什么必须回显：`phone` 这类变量声明为 `persistent: true` 后，用户不报号时会
 * **静默复用上次的值**。实测用户 2026-09-07 为帮别人退款报过一次手机号，它进了
 * user-vars 成为永久默认目标，此后 11 天所有清理/退款都打在那个号上，而回执里
 * 只有脚本那句「清理账号数据完成」—— 清错对象在用户侧零可观测，表现为「说清了但没清」。
 * 回显不阻断执行（用户 2026-09-18 拍板「只回显不拦」），但让清错号当场可见。
 *
 * @param {Object} actionConfig 动作配置（按 variables 声明顺序取值）
 * @param {Object} collectedVars 本次收集到的变量
 * @returns {string} 如 `环境 dev ｜ 手机号 133****0092`；无可显示变量时返回空串
 */
export function describeTarget(actionConfig, collectedVars) {
  const masked = maskVars(collectedVars || {}) || {};
  const parts = [];
  for (const varDef of actionConfig?.variables || []) {
    const val = masked[varDef.name];
    if (val === undefined || val === null || val === '') continue;
    parts.push(`${varDef.label || varDef.name} ${val}`);
  }
  return parts.join(' ｜ ');
}

/**
 * 完整执行流程：组装参数 → 调用脚本 → 记录日志
 * - 组装脚本路径：path.join(config.scripts.dir, scriptName)
 * - 选择解释器：node 或 python（根据文件扩展名）
 * - 调用 runScript
 * - 记录执行日志（含脱敏变量）
 *
 * @param {Object} actionConfig - 动作配置 { id, name, scriptName, variables: [{name, required}] }
 * @param {string} userId - 用户 ID
 * @param {Object} collectedVars - 收集到的变量
 * @returns {Promise<{ok: boolean, output: string}>}
 */
export async function runAction(actionConfig, userId, collectedVars) {
  const { id: actionId, name: actionName, scriptName } = actionConfig;

  // 1. 记录执行开始（日志级别：INFO）
  logger.info(
    'script-runner',
    `执行脚本：${actionName}`,
    { actionId, scriptName, userId },
  );

  // 2. 组装脚本参数
  const args = buildScriptArgs(actionConfig, collectedVars);

  // 3. 确定解释器和脚本路径
  const scriptPath = path.join(config.scripts.dir, scriptName);
  const isPython = scriptName.endsWith('.py');
  const bin = isPython ? config.scripts.pythonBin : 'node';

  // 4. 脚本执行选项（Python 脚本设置 PYTHONIOENCODING）
  const opts = { env: {} };
  if (isPython) {
    opts.env.PYTHONIOENCODING = 'utf-8';
  }

  // 5. 调用 runScript 执行脚本
  const result = await runScript(bin, [scriptPath, ...args], opts);

  // 6. 提取输出（失败时 stdout 不许丢，见 pickOutput 文档）
  const output = pickOutput(result);

  // 7. 记录执行日志（脱敏变量）
  try {
    await appendActionLog({
      time: new Date().toISOString(),
      userId,
      actionId,
      actionName,
      vars: maskVars(collectedVars),
      ok: result.ok,
      code: result.code || (result.ok ? 0 : 1),
    });
  } catch (err) {
    logger.warn(
      'script-runner',
      '记录日志失败',
      { error: err?.message || String(err) },
    );
  }

  // 8. 记录机器人日志（面板展示用；action-log 是审计用途，两者并行不互相替代）
  // botId 由 actionId 反查：动作 per-bot 独享，配置里带 botId
  await recordBotActivity({
    kind: 'action',
    botId: getConfig(actionId)?.botId,
    userId,
    detail: actionName,
    ok: result.ok,
    code: result.code || (result.ok ? 0 : 1),
  });

  return { ok: result.ok, output };
}
