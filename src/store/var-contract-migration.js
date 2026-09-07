/**
 * 动作变量抽取契约的一次性迁移（2026-09-04）。
 *
 * ## 为什么需要
 *
 * 改造前 `slot-filler.js` 按变量名硬编码了两套抽取规则（`env` 查别名表、`phone` 走正则）。
 * 改造后规则改由变量**声明**提供（`preset` / `enum` / `aliases` / `pattern`），硬编码删除。
 * 存量配置里的 `env`/`phone` 变量没有这些声明，不迁移就会从「本地能抽」退化成
 * 「只能靠 LLM」—— 行为仍正确，但每次都要多花 8~17s，等于白丢了这次改造的主要收益。
 *
 * ## 为什么用标记位而不是每次按变量名重扫
 *
 * 重扫等于「用户改不掉」：他在设置页手动删掉 `preset: "env"`（比如想换成自己的 enum，
 * 或就是不想要本地抽取），一重启又被加回来，而 UI 上还摆着那个可编辑的字段。
 * 标记位把「一次性数据修复」和「用户的持续意图」分开：迁移只发生一次，之后配置完全归用户。
 *
 * 标记写在**动作条目**层级而非全局 —— 这样后来导入的旧配置（没有标记）仍会被迁移一次，
 * 而已经迁过的条目不受影响。
 *
 * ## 为什么这里可以按变量名判断
 *
 * 它是一次性的数据修复，不是运行时逻辑。**运行时抽取器永远不看变量名**（见
 * `plugins/action-runner/feature/var-contract.js` 的文件头），这条纪律不因本文件而破。
 */
import { updateJson } from './index.js';

const FILE = 'action-configs.json';

/** 标记字段：带 `_` 前缀表示内部字段，Web 表单不渲染它 */
export const MIGRATION_FLAG = '_varContractMigrated';

/** 当前迁移代次。日后若有第二轮迁移，比较数值即可，不必新增字段。 */
export const MIGRATION_VERSION = 1;

/** 变量名 → 该补哪个 preset。仅用于本次一次性修复。 */
const NAME_TO_PRESET = { env: 'env', phone: 'phone' };

/** 已经自带抽取声明的变量不动（用户显式配置优先于迁移） */
function alreadyDeclared(v) {
  return v?.preset !== undefined || v?.enum !== undefined || v?.pattern !== undefined;
}

/**
 * 纯函数：把一条动作配置迁移到新契约。
 * @param {object} cfg
 * @returns {{ config: object, changed: boolean }} changed=false 表示无需写盘
 */
export function migrateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { config: cfg, changed: false };
  if (Number(cfg[MIGRATION_FLAG]) >= MIGRATION_VERSION) return { config: cfg, changed: false };

  const vars = Array.isArray(cfg.variables) ? cfg.variables : null;
  let touched = false;
  const nextVars = vars
    ? vars.map((v) => {
        if (!v || typeof v !== 'object') return v;
        const preset = NAME_TO_PRESET[v.name];
        if (!preset || alreadyDeclared(v)) return v;
        touched = true;
        return { ...v, preset };
      })
    : vars;

  // 即使一个变量都没补，也要打标 —— 否则每次启动都要重扫这条配置，
  // 且用户日后删掉某个 preset 时会被再次加回（正是标记位要防的事）。
  const config = { ...cfg, [MIGRATION_FLAG]: MIGRATION_VERSION };
  if (nextVars) config.variables = nextVars;
  return { config, changed: true, touchedVars: touched };
}

/**
 * 执行迁移（幂等）。经 `updateJson` 走文件锁，web / feishu 双进程同时启动不会互相覆盖。
 * @returns {{ scanned: number, migrated: number }}
 */
export function migrateVarContract() {
  let scanned = 0;
  let migrated = 0;

  updateJson(FILE, [], (configs) => {
    if (!Array.isArray(configs)) return undefined;
    scanned = configs.length;
    let any = false;
    const next = configs.map((c) => {
      const r = migrateConfig(c);
      if (r.changed) {
        any = true;
        migrated += 1;
      }
      return r.config;
    });
    return any ? next : undefined; // 无改动不写盘
  });

  return { scanned, migrated };
}
