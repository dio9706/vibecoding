/**
 * LLM 编辑策略的执行层：refactor（改源码，过测试闸）/ rewrite（改文档）/ createTests（建测试）。
 *
 * 从不抛错（`fix-*` 通用纪律）：一切失败通过返回值的 status 表达。
 *
 * ## 三条路径的安全模型各不相同，不要互相套用
 *
 * | 策略 | 写入范围 | 安全保证 |
 * |---|---|---|
 * | refactor | 一个源文件 | 改前测试绿 → 改后重跑 → 红了回滚**这一个**文件 |
 * | rewrite | 一个文档文件 | 扩展名白名单（只 .md 类）+ 全量备份可还原 |
 * | createTests | 一个**新**测试文件 | 只新建；跑不通就删掉，绝不留下一个红的测试 |
 *
 * createTests 那条尤其要紧：留下一个跑不通的生成测试，会把项目的测试基线弄红，
 * 而下一轮优化的测试闸正是靠基线判断能不能改源码——等于自己把后续所有源码修复堵死了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runScopedEditAgent } from '../../../capabilities/llm-write-agent.js';
import { logger } from '../../../shared/logger.js';
import { verifyAfterEdit, revertFile, snapshotFile } from '../test-gate.js';
import { verdictText } from '../test-gate.logic.js';
import {
  groupIssuesByFile, buildRefactorPrompt, buildRewritePrompt, buildTestPrompt,
  validateEditReport, summarizeReport, testPathFor, isDocFile,
  REFACTOR_SYSTEM, REWRITE_SYSTEM, CREATE_TEST_SYSTEM,
} from './llm-edit.logic.js';

/** 失败原因 → 用户能看懂的话。与 llm-write-agent 的 reason 词表对齐 */
const REASON_TEXT = {
  exhausted: '账号额度已耗尽',
  cancelled: '已按你的要求停止',
  timeout: 'AI 调用超时',
  unparsable: 'AI 未按格式回报（文件可能已改动，请查看 diff）',
};

/**
 * 跑一次单文件编辑，返回 `{wrote, report, reason}`。
 *
 * 抽出来是因为三条策略在这一步完全相同——差别只在 prompt 与 systemPrompt。
 */
async function editOneFile({ dir, rel, prompt, systemPrompt, logTag, signal }) {
  const { data, wrote, denied, reason } = await runScopedEditAgent({
    prompt,
    systemPrompt,
    cwd: dir,
    allowPaths: [rel],
    logTag,
    signal,
  });

  if (denied?.length) {
    // 被拦下的写入是**提示词没说清**的信号，不是模型的错：白名单已经挡住了，
    // 结论仍然可信，但要留痕以便回头收紧 prompt
    logger.warn('llm-edit', '拦截了范围外的操作', { dir, rel, denied });
  }

  return { wrote, report: validateEditReport(data), reason, denied: denied || [] };
}

/**
 * llm-refactor：改源码，每个文件改完立刻过测试闸。
 *
 * 逐文件串行而不是并发：测试是**全局**信号，两个文件并发改完再一起跑测试，
 * 红了根本分不清是谁弄红的，回滚只能整批撤——那就丢掉了「精确回滚到文件级」这个核心优势。
 * 慢是代价，但这是低频操作。
 *
 * @param {object} args
 * @param {string} args.dir
 * @param {object} args.dim 维度声明
 * @param {Array} args.issues 本维度的 issue
 * @param {AbortSignal} [args.signal]
 * @param {(r:object)=>void} [args.onFile] 每个文件出结果就回调一次（用于推 SSE）
 * @returns {Promise<Array>}
 */
export async function runRefactor({ dir, dim, issues, signal, onFile }) {
  const results = [];
  const groups = groupIssuesByFile(issues);

  for (const [rel, list] of groups) {
    if (signal?.aborted) break;

    // 改动前的内容就是回滚基准。必须在调 agent 之前读——
    // agent 改完再读就拿到改后的内容，回滚等于没回滚
    const original = snapshotFile(dir, rel);
    if (original === null) {
      const r = { file: rel, kind: 'refactor', status: 'skipped', reason: '文件读不到（可能已被删除或移动）' };
      results.push(r); onFile?.(r);
      continue;
    }

    const { wrote, report, reason } = await editOneFile({
      dir,
      rel,
      prompt: buildRefactorPrompt({ file: rel, issues: list, dim }),
      systemPrompt: REFACTOR_SYSTEM,
      logTag: `fix/${dim.id}/${rel}`,
      signal,
    });

    // 没写入就不必跑测试（跑一遍要几十秒到几分钟）。
    // 这一步很常见且完全正常——模型判断「这几条我做不好」就该什么都不改
    if (!wrote.length) {
      const r = {
        file: rel,
        kind: 'refactor',
        status: 'skipped',
        reason: report?.skipped?.length
          ? `未改动：${report.skipped.map((s) => s.why || s.what).join('；')}`
          : `未改动（${REASON_TEXT[reason] || 'AI 判断无需或无法修改'}）`,
      };
      results.push(r); onFile?.(r);
      continue;
    }

    const verdict = await verifyAfterEdit(dir);
    if (verdict !== 'ok') {
      const reverted = revertFile(dir, rel, original);
      const r = {
        file: rel,
        kind: 'refactor',
        status: reverted ? 'skipped' : 'failed',
        reason: reverted
          ? verdictText(verdict, rel)
          // 回滚失败是最坏情况：盘上留着改坏的文件，必须让用户看见并去用整份备份还原
          : `${verdictText(verdict, rel)}，但回滚也失败了——请用「还原」撤销本次优化`,
      };
      results.push(r); onFile?.(r);
      continue;
    }

    const r = {
      file: rel,
      kind: 'refactor',
      status: 'done',
      reason: summarizeReport(report, verdictText('ok', rel)),
    };
    results.push(r); onFile?.(r);
  }

  return results;
}

/**
 * llm-rewrite：改文档。不过测试闸（.md 改不坏测试），但严格限定扩展名。
 *
 * 扩展名白名单是这条路径的**唯一**闸：一旦让它碰到源码，就绕过了测试闸——
 * 那是本设计里最不该有的洞（改源码不跑测试）。所以非文档文件一律 skip 而不是「顺便修」。
 */
export async function runRewrite({ dir, dim, issues, sharedContext = '', signal, onFile }) {
  const results = [];

  for (const [rel, list] of groupIssuesByFile(issues)) {
    if (signal?.aborted) break;

    if (!isDocFile(rel)) {
      const r = {
        file: rel,
        kind: 'rewrite',
        status: 'skipped',
        reason: '非文档文件，文档改写策略不处理（改源码必须走带测试闸的重构策略）',
      };
      results.push(r); onFile?.(r);
      continue;
    }

    const { wrote, report, reason } = await editOneFile({
      dir,
      rel,
      prompt: buildRewritePrompt({ file: rel, issues: list, dim, sharedContext }),
      systemPrompt: REWRITE_SYSTEM,
      logTag: `fix/${dim.id}/${rel}`,
      signal,
    });

    const r = wrote.length
      ? { file: rel, kind: 'rewrite', status: 'done', reason: summarizeReport(report, `${rel} 已修订`) }
      : {
        file: rel,
        kind: 'rewrite',
        status: 'skipped',
        reason: report?.skipped?.length
          ? `未改动：${report.skipped.map((s) => s.why || s.what).join('；')}`
          : `未改动（${REASON_TEXT[reason] || 'AI 判断无需修改'}）`,
      };
    results.push(r); onFile?.(r);
  }

  return results;
}

/** 找一份既有测试当写法参考。同目录优先——同目录的测试最能代表这块代码的惯例 */
function findExampleTest(dir, files, sourceRel) {
  const sourceDir = sourceRel.includes('/') ? sourceRel.slice(0, sourceRel.lastIndexOf('/')) : '';
  const tests = files.filter((f) => /\.(?:test|spec)\.\w+$/.test(f.rel));
  const near = tests.find((f) => f.rel.startsWith(`${sourceDir}/`)) || tests[0];
  if (!near) return '';
  try {
    return fs.readFileSync(path.join(dir, near.rel), 'utf8');
  } catch {
    return '';
  }
}

/**
 * llm-create：为缺测试的源文件新建测试。
 *
 * 「跑不通就删掉」不是洁癖，是防止把项目的测试基线弄红——而下一轮优化的测试闸
 * 正是靠基线判断能不能改源码。留一个红测试等于把后续所有源码修复都堵死。
 *
 * @param {object} args
 * @param {Array} args.issues 只处理带具体源文件的（S2_LARGE_FILE_UNTESTED）
 * @param {Array} args.files evidence.files，用于找参考测试
 */
export async function runCreateTests({ dir, issues, files = [], signal, onFile }) {
  const results = [];

  for (const it of issues) {
    if (signal?.aborted) break;

    const sourceRel = String(it.file || '');
    // S3_NO_TESTS 的 file 是 '.'（整个项目没有测试），没有具体目标，交给 advisory
    if (!sourceRel || sourceRel === '.' || !/\.\w+$/.test(sourceRel)) {
      const r = { file: sourceRel || '.', kind: 'create-test', status: 'skipped', reason: '没有具体的被测文件，已写入整改清单' };
      results.push(r); onFile?.(r);
      continue;
    }

    const testRel = testPathFor(sourceRel);
    if (fs.existsSync(path.join(dir, testRel))) {
      const r = { file: testRel, kind: 'create-test', status: 'skipped', reason: '测试文件已存在，不覆盖' };
      results.push(r); onFile?.(r);
      continue;
    }

    const { wrote, report, reason } = await editOneFile({
      dir,
      rel: testRel,
      prompt: buildTestPrompt({
        sourceFile: sourceRel,
        testFile: testRel,
        sourceHint: it.message,
        example: findExampleTest(dir, files, sourceRel),
      }),
      systemPrompt: CREATE_TEST_SYSTEM,
      logTag: `fix/tests/${testRel}`,
      signal,
    });

    if (!wrote.length) {
      const r = {
        file: testRel,
        kind: 'create-test',
        status: 'skipped',
        reason: report?.skipped?.length
          ? `未生成：${report.skipped.map((s) => s.why || s.what).join('；')}`
          : `未生成（${REASON_TEXT[reason] || 'AI 判断无法写出有意义的测试'}）`,
      };
      results.push(r); onFile?.(r);
      continue;
    }

    const verdict = await verifyAfterEdit(dir);
    if (verdict === 'ok') {
      const r = {
        file: testRel,
        kind: 'create-test',
        status: 'done',
        reason: summarizeReport(report, `${testRel} 已生成，测试全绿`),
      };
      results.push(r); onFile?.(r);
      continue;
    }

    // 删掉而不是回滚：这是新建的文件，「改动前」的状态就是不存在
    const removed = revertFile(dir, testRel, null);
    const r = {
      file: testRel,
      kind: 'create-test',
      status: removed ? 'skipped' : 'failed',
      reason: removed
        ? `生成的测试${verdict === 'regressed' ? '未通过' : '未能给出结论'}，已删除`
          + '（不留下红测试——否则会把项目测试基线弄红，堵死后续的源码修复）'
        : `生成的测试未通过且删除失败，请手工删掉 ${testRel}`,
    };
    results.push(r); onFile?.(r);
  }

  return results;
}
