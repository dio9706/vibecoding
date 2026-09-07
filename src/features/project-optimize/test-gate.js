/**
 * 测试闸的 IO 层：跑项目测试、判定闸的开合、单文件回滚。
 *
 * 复用 `project-checkup/check-tests.js` 的 `runProjectTests` 而不是自己起进程——
 * 那边已经解决了两个 Windows 上的坑（npm.cmd 不能走 execFile；Node 的 timeout 选项
 * 杀不掉 shell 的孙进程，要自己 taskkill）。重造一份必然把这两个坑再踩一遍。
 *
 * 从不抛错：调用方是修复循环，抛异常会把整批停在半路。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runProjectTests } from '../project-checkup/check-tests.js';
import { logger } from '../../shared/logger.js';
import { decideGate, judgeAfterEdit } from './test-gate.logic.js';

/**
 * 基线检测的超时预算。
 *
 * 给得比逐次校验宽：基线只跑一次，而且它决定「整个源码维度做不做」，
 * 为它多等一会儿是值得的；逐次校验要跑 N 遍，预算必须收紧否则总耗时线性爆炸。
 */
const BASELINE_TIMEOUT_MS = 240_000;
const VERIFY_TIMEOUT_MS = 180_000;

/**
 * 开闸：跑一次测试拿基线。
 *
 * @returns {Promise<{allowed:boolean, reason:string, baseline:object|null}>}
 */
export async function openGate(dir) {
  let testRun = null;
  try {
    testRun = await runProjectTests(dir, { timeoutMs: BASELINE_TIMEOUT_MS });
  } catch (e) {
    // 跑测试本身炸了（命令不存在、权限问题）等同于「没有可信基线」
    logger.warn('test-gate', '基线测试执行异常', { dir, err: e?.message || String(e) });
    testRun = { status: 'na', reason: `测试命令执行异常：${e?.message || e}` };
  }
  const gate = decideGate(testRun);
  return { ...gate, baseline: testRun };
}

/**
 * 一次改动之后的校验。
 *
 * @returns {Promise<'ok'|'regressed'|'unknown'>}
 */
export async function verifyAfterEdit(dir) {
  try {
    return judgeAfterEdit(await runProjectTests(dir, { timeoutMs: VERIFY_TIMEOUT_MS }));
  } catch (e) {
    logger.warn('test-gate', '校验测试执行异常', { dir, err: e?.message || String(e) });
    return 'unknown';
  }
}

/**
 * 把单个文件回滚到给定内容。
 *
 * 为什么不走 `backup.js` 的 `restoreBackup`：那个接口是**整份快照**级别的还原，
 * 而这里要的是「只回滚刚改坏的这一个文件，其余已经改好并验证通过的保留」。
 * 用整份还原会把前面所有成功的修复一起撤掉。
 *
 * @param {string} dir
 * @param {string} rel
 * @param {string|null} original 改动前的内容；null 表示原本不存在（此时删除）
 * @returns {boolean} 是否回滚成功
 */
export function revertFile(dir, rel, original) {
  const full = path.join(dir, rel);
  try {
    if (original === null) {
      if (fs.existsSync(full)) fs.rmSync(full);
    } else {
      fs.writeFileSync(full, original, 'utf8');
    }
    return true;
  } catch (e) {
    // 回滚失败是最坏的情况：盘上留着一个改坏了的文件，而我们连撤回都做不到。
    // 必须告警并让调用方把它如实报给用户（备份快照仍然可以整体还原）
    logger.warn('test-gate', '单文件回滚失败，请用整份备份还原', { dir, rel, err: e?.message || String(e) });
    return false;
  }
}

/** 读一个文件的当前内容，供回滚用。不存在返回 null（语义即「原本没有这个文件」） */
export function snapshotFile(dir, rel) {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8');
  } catch {
    return null;
  }
}
