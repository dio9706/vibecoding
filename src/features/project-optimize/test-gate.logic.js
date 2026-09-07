/**
 * 测试闸的判定层（纯函数）：源码级自动重构的**准入条件**。
 *
 * ## 为什么源码重构必须有闸
 *
 * 《修改代码的艺术》（Working Effectively with Legacy Code）的核心论点：
 * **没有测试的代码不该被重构**——因为「重构」的定义就是「在不改变外部行为的前提下改进结构」，
 * 而没有测试就无从知道行为有没有变。这不是保守，是这件事的定义本身。
 *
 * 本功能把它落成硬闸，而不是一句建议：
 *
 *   1. 项目有可跑的测试命令吗？    没有 → 整个策略降级为「只出清单」
 *   2. 跑一遍，全绿吗？            不绿 → 降级（红着改会分不清是谁弄红的）
 *   3. 每改完一个文件重跑          红了 → 回滚**这一个**文件，继续下一个
 *
 * 第 2 条容易被当成过度谨慎，实则相反：在一个已经有 3 个失败用例的项目上改代码，
 * 改完还是 3 个失败——你无法判断是「原来那 3 个」还是「修好 2 个又弄坏 2 个」。
 * 基线不干净，闸就没有信号。
 *
 * ## 降级不是失败
 *
 * 降级后 advisory 策略会照常产出可执行的整改清单，并在首行写明「本维度因缺少测试安全网
 * 未自动修改」。**必须写出来**——否则用户看到「优化完成」，会合理地以为源码已经改过了。
 */

/** 允许放行的测试状态。只有真跑绿了才算 */
const PASS = 'pass';

/**
 * 闸的开合判定。
 *
 * @param {{status:'pass'|'fail'|'timeout'|'na', reason?:string}|null} testRun
 * @returns {{allowed:boolean, reason:string}} reason 在 allowed 为 false 时是给用户看的降级说明
 */
export function decideGate(testRun) {
  const status = testRun?.status;

  if (status === PASS) return { allowed: true, reason: '' };

  if (status === 'fail') {
    return {
      allowed: false,
      reason: '项目测试当前未通过，无法作为安全基线'
        + '（在已经红的基线上改代码，改完仍然红，分不清是原有失败还是新引入的；'
        + '生成的新测试也会被连带判成「未通过」而删掉，哪怕它本身完全正确）。'
        + '本维度改为只产出整改清单；修好现有失败用例后再跑一次优化即可自动修复。',
    };
  }

  if (status === 'timeout') {
    return {
      allowed: false,
      reason: '项目测试执行超时，拿不到可信基线。本维度改为只产出整改清单。',
    };
  }

  // na 与任何未知状态都走这里：没有测试命令 = 没有安全网
  return {
    allowed: false,
    reason: `项目没有可执行的测试命令（${testRun?.reason || '未检测到 test 脚本'}），`
      + '缺少改坏了能立刻发现的安全网。本维度改为只产出整改清单；'
      + '先让「测试健康度」维度把测试补起来，下一轮优化就能自动修复源码。',
  };
}

/**
 * 一次文件改动之后的裁决。
 *
 * 只认「从绿变红」为回归。**不要**把 timeout 也当回归：那说明这次没测出来，
 * 而把「没测出来」当「改坏了」会白白回滚一个可能完全正确的修改。
 * 但也不能当通过——所以单列一档，交给调用方决定（当前实现是保守回滚并如实标注）。
 *
 * @param {{status:string}|null} after
 * @returns {'ok'|'regressed'|'unknown'}
 */
export function judgeAfterEdit(after) {
  if (after?.status === PASS) return 'ok';
  if (after?.status === 'fail') return 'regressed';
  return 'unknown';
}

/** 裁决 → 结果文案。三档各自对应一种用户需要知道的情况 */
export function verdictText(verdict, file) {
  if (verdict === 'ok') return `${file} 已修改，测试仍全绿`;
  if (verdict === 'regressed') return `${file} 的修改让测试变红，已回滚该文件`;
  return `${file} 修改后测试未能给出结论（超时或无法执行），已保守回滚该文件`;
}
