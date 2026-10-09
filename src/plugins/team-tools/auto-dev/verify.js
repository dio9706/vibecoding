/**
 * 自动开发的「验证门」编排：develop → 验证 →（失败）带失败输出重试一次 → 再验证。
 *
 * 抽成独立模块 + 依赖注入的原因：本流程是「额度敏感」的（一次重试 = 一轮完整开发），
 * 三条链路（首次通过 / 失败重试通过 / 重试仍失败）必须离线可测，不靠真模型真仓库。
 *
 * 通过也不打断提交：调用方拿到 { developOk, verify, verifyOutput } 后照旧 commitAll——
 * 验证失败同样要提交留痕（半成品落分支供人工处理），这是 auto-div 既有语义。
 */
import { resolveVerifyCommand, runVerify } from '../../../capabilities/verifier.js';
import { toVerifyRecord } from '../../../capabilities/verifier.logic.js';
import { updateTask } from '../../../store/tasks.js';
import { develop } from '../task-ops.js';

/**
 * @param {{task:object, repo:string, autoDir:string, verifyCommand?:string}} input
 * @param {{developFn?:Function, verifyFn?:Function, updateTaskFn?:Function, resolveCommandFn?:Function}} [deps] 测试注入点
 * @returns {Promise<{developOk:boolean, verify:object|null, verifyOutput:string}>}
 *   verify 为落任务字段的记录（含 attempts/at）；verifyOutput 为截断输出，供 verifyLog 落盘。
 *   develop 失败早退时 verify 可能是「首次失败现场」（重试也没成功）或 null（首轮就没成）。
 */
export async function developWithVerify({ task, repo, autoDir, verifyCommand }, deps = {}) {
  const { developFn = develop, verifyFn = runVerify, updateTaskFn = updateTask, resolveCommandFn = resolveVerifyCommand } = deps;
  // 命令来源：显式配置 > 工程自动发现（npm 工程 test 脚本 → npm test）> 空串（验证器按「未配置」跳过）。
  // 必须在 develop 之前解析：prompt 的【完成标准】与执行期复跑必须是同一条命令，否则模型按 A 标准做、系统按 B 判。
  const command = await resolveCommandFn({ configured: verifyCommand, cwd: autoDir });
  const baseOpts = { cwd: autoDir, deferStatus: true, mainDir: repo, verifyCommand: command };

  let r = await developFn(task, baseOpts);
  if (!r.ok) return { developOk: false, verify: null, verifyOutput: '' };

  let raw = await verifyFn({ cwd: autoDir, command });
  let attempts = 1;
  if (!raw.skipped && !raw.ok) {
    updateTaskFn(
      task.id,
      { verify: toVerifyRecord(raw, attempts), verifyLog: raw.output },
      '自检未通过（第 1 次），自动重试',
    );
    const retry = await developFn(task, { ...baseOpts, verifyFeedback: raw });
    if (!retry.ok) return { developOk: false, verify: toVerifyRecord(raw, attempts), verifyOutput: raw.output };
    attempts += 1; // 上限 2：上面的条件保证这里只会从 1 到 2
    raw = await verifyFn({ cwd: autoDir, command });
  }

  return { developOk: true, verify: toVerifyRecord(raw, attempts), verifyOutput: raw.output };
}
