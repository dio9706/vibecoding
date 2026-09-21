/**
 * 维度「测试健康度」的判定层（纯函数，不碰 fs / 不起进程）。
 *
 * 三个检查项：
 *   S1 测试未全绿（error）—— 唯一需要执行项目代码的检查，执行细节在 check-tests.js
 *   S2 超阈值源文件无配对测试（info）
 *   S3 项目完全没有测试文件（warn）
 */

/** 超过这个行数的源文件才要求有配对测试。取 500 而非 300：300 会一次报出 20 个文件、
 *  且大概率一个都不会改——报了不修的条目就是噪音。 */
export const LARGE_FILE_LINES = 500;

const DEDUCT_TESTS_FAILING = 45; // 测试红了是最严重的健壮性信号
const DEDUCT_NO_TESTS = 30;
const DEDUCT_LARGE_UNTESTED = 5;
const MAX_LARGE_DEDUCT = 30; // 大文件缺口的扣分上限，避免 20 个文件把分数打到 0

/** 单文件组件的测试文件用什么扩展名写。见 testPathsFor 里的说明 */
const SFC_TEST_EXT = { vue: ['ts', 'js'], svelte: ['ts', 'js'] };

/**
 * 这条路径是不是一个测试文件。
 *
 * 三种约定都要认，少认一种就会把「有测试」误判成「零测试」（S3 是 -30 分的重扣项）：
 *   1. `x.test.ts` / `x.spec.ts` —— 同级同名，最通用
 *   2. `__tests__/x.ts` —— Jest / Vitest 的目录约定，**本项目实测就是这一种**
 *   3. `tests/` / `test/` 目录下的文件 —— Python、Go 之外的通用布局
 *
 * 原实现只认 `/\.test\.m?js$/`，在 kxmall-app-ui 上 106 个 `src/**\/__tests__/*.test.ts`
 * 一个都没认出来。
 *
 * @param {string} rel 相对项目根的正斜杠路径
 */
export function isTestFile(rel) {
  const p = String(rel || '');
  if (/\.(test|spec)\.[A-Za-z0-9]+$/i.test(p)) return true;
  if (/(^|\/)(__tests__|__test__)\//i.test(p)) return true;
  if (/(^|\/)tests?\//i.test(p)) return true;
  return false;
}

/**
 * 一个源文件的配对测试候选路径。
 *
 * **保留原扩展名**：`src/a.ts` 的测试是 `src/a.test.ts`，不是 `src/a.test.js`。
 * 原实现写死 `.js`，于是在 TS 项目里永远查不到配对测试——S2「大文件缺测试」会对
 * 每个大文件误报，而那些文件其实测试齐全。
 *
 * 同时给出 `__tests__/` 变体：那是本项目实测使用的组织方式。
 */
export function testPathsFor(rel) {
  const s = String(rel);
  const m = /^(.*)\.([A-Za-z0-9]+)$/.exec(s);
  if (!m) return [`${s}.test.js`];
  const [, base, ext] = m;
  const slash = base.lastIndexOf('/');
  const dir = slash >= 0 ? base.slice(0, slash + 1) : '';
  const name = slash >= 0 ? base.slice(slash + 1) : base;

  // 单文件组件的测试**不会**是 `.test.vue`——组件测试写在 .test.ts / .test.js 里。
  // 不特判的话，每个超过 500 行的 .vue 都会因为「找不到 x.test.vue」被误报成缺测试，
  // 而它其实在 __tests__/x.test.ts 里测得好好的
  const exts = SFC_TEST_EXT[ext.toLowerCase()] || [ext];

  const out = [];
  for (const e of exts) {
    out.push(
      `${base}.test.${e}`,
      `${base}.spec.${e}`,
      `${base}.logic.test.${e}`,
      `${dir}__tests__/${name}.test.${e}`,
      `${dir}__tests__/${name}.spec.${e}`,
    );
  }
  return out;
}

/**
 * @param {Array<{rel:string, lines:number}>} files 候选源文件（已排除测试文件本身）
 * @param {Set<string>} allRelSet 项目内所有文件的相对路径集合，用来查配对测试是否存在
 */
export function findLargeFilesWithoutTest(files, allRelSet, { minLines = LARGE_FILE_LINES } = {}) {
  const all = allRelSet instanceof Set ? allRelSet : new Set();
  return (Array.isArray(files) ? files : [])
    .filter((f) => f && Number(f.lines) > minLines)
    .filter((f) => !testPathsFor(f.rel).some((p) => all.has(p)))
    .map((f) => ({ file: f.rel, lines: Number(f.lines) }));
}

/**
 * @param {object} p
 * @param {{status:'pass'|'fail'|'timeout'|'na', reason?:string}} p.testRun 执行结果
 * @param {Array<{file:string, lines:number}>} p.largeFilesWithoutTest
 * @param {number} p.testFileCount 项目里 *.test.js 的数量
 * @param {number} p.sourceFileCount 非测试源文件数量
 */
export function evaluateTests({
  testRun = { status: 'na' },
  largeFilesWithoutTest = [],
  testFileCount = 0,
  sourceFileCount = 0,
} = {}) {
  // 每个分支都要原样带上 testRun：修复侧的测试闸（decideGate）靠它决定要不要放行
  // 源码重构，而前端要在**用户点修复之前**就能预判闸的开合。
  // 从 issues 里反推（「有没有 S1」）也能算，但那是把判据藏在文案里——
  // 加一个结构化字段，`decideGate(report.dims.tests.testRun)` 一行就是答案。
  const run = { status: testRun?.status || 'na', reason: testRun?.reason || '' };

  // 空仓库/没有源码：不是缺陷，不扣分也不计入总分
  if (!sourceFileCount) {
    return {
      score: null, status: 'na', issues: [], testRun: run, reason: '项目里没有可分析的源文件',
    };
  }

  // 超时必须判 partial 而不是「测试失败」。混为一谈会让所有大项目永久不及格——
  // 超时的语义是「这次没测出来」，不是「测试红了」。
  if (testRun?.status === 'timeout') {
    return {
      score: null,
      status: 'partial',
      issues: [],
      testRun: run,
      reason: testRun.reason || '测试执行超时，本维度不计入总分',
    };
  }

  const issues = [];
  let score = 100;

  if (testRun?.status === 'fail') {
    score -= DEDUCT_TESTS_FAILING;
    issues.push({
      code: 'S1_TESTS_FAILING',
      severity: 'error',
      file: 'package.json',
      line: 1,
      message: testRun.reason || '项目测试未通过',
      // 修失败用例是真正的开发工作，不是机械变换。而且这条 issue 的 file 是
      // `package.json`——它不是「要被修的文件」，只是测试命令的所在处。
      // 不否决的话 llm-create 会认领它、把目标算成 `package.test.json`（实测过）
      fixable: false,
      fixHint: '本地跑一遍测试命令，修掉失败用例后再体检',
    });
  }

  if (testFileCount === 0) {
    // 一个测试文件都没有时，再逐个报「大文件无测试」是把同一件事说 N 遍
    score -= DEDUCT_NO_TESTS;
    issues.push({
      code: 'S3_NO_TESTS',
      severity: 'warn',
      file: '.',
      line: 1,
      message: `项目里没有任何测试文件（扫到 ${sourceFileCount} 个源文件）`,
      // 没有单一的修复目标（file 是 '.'）。零测试项目要先选框架、配跑测试的命令，
      // 机器代定容易选错。下一轮体检会逐个报出 S2，那些才有明确目标
      fixable: false,
      fixHint: '从改动最频繁的模块开始补测试',
    });
  } else {
    const list = Array.isArray(largeFilesWithoutTest) ? largeFilesWithoutTest : [];
    score -= Math.min(list.length * DEDUCT_LARGE_UNTESTED, MAX_LARGE_DEDUCT);
    for (const f of list) {
      issues.push({
        code: 'S2_LARGE_FILE_UNTESTED',
        severity: 'info',
        file: f.file,
        line: 1,
        message: `${f.lines} 行的源文件没有配对测试，改动风险高`,
        // 有明确目标（新建 `<源文件>.test.js`），且只新建不改源码，
        // 产出物还要真跑通才保留。交给 llm-create
        fixable: true,
        fixHint: `新建 ${testPathsFor(f.file)[0]}；文件过大时可先把纯逻辑拆到单独模块再测`,
        meta: { lines: f.lines },
      });
    }
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    status: 'done',
    issues,
    testRun: run,
    reason: testRun?.status === 'na' ? testRun.reason || '未执行测试命令' : '',
  };
}
