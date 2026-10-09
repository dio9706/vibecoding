# 内部 Benchmark（T5）· 设计

- 日期：2026-10-08
- 状态：已拍板（2026-10-08；两处关键决策经确认：**案例来源=本仓历史修复回放（SWE-bench 式）**、**交付形态=独立 CLI + 离线校验**）
- 关联：`next-tasks.md` T5；`roadmap.md`（90 天计划第 4 项）；消费方：auto-dev / 提示词 / 工具集 / 模型的 A/B
- 参考：SWE-bench 的「回放 + 测试判据」思路；本仓既有 `capabilities/verifier.js`（验证命令执行）

## 1. 背景与问题

每次改 auto-dev 提示词、工具集、repo map 注入或换模型，只能凭感觉判断「更自主还是更飘」。需要一个固定题集 + 客观判据 + 三项指标的离线/半离线评测：

- **通过率**：题做没做对（判据 = 测试，不是模型自述）；
- **回合数**：工具调用数与模型回合数（同样的活绕了多少路）；
- **token 成本**：输入/输出 token 与美元成本。

题集来源（拍板）：**本仓历史修复回放**——本仓 115 条提交中 43 条「同改测试与实现」，天然构成可复现题源：把某次修复回退到父提交、植入该提交的测试作为判据，让 agent 重做当时的工作。完全离线、判据客观、无需外部业务仓。

## 2. 概念与流程

```
案例(case) = { 输入(人话反馈) + fixRef(修复提交) + testFiles(判据) + verifyCommand? }
基线 = fixRef 的父提交（baseRef 可显式覆盖）
```

单题流程（runner）：

1. **准备**：`git worktree add --detach <repo>/.bench-ws/<caseId> <baseRef>`（独立干净树；**不含**工作区未提交改动）；
2. **植入判据**：`git checkout <fixRef> -- <testFiles...>`（测试文件取修复后版本；**判据对 agent 可见**——与生产一致：模型本就能运行工程测试、看到失败输出。本案测的是「在明确的完成标准下自主把活干对」，不是猜测试）；
3. **校验**（`--validate`）：先跑一次 verify，**必须失败**——修复前就通过 = 无效题（测试没覆盖改动或环境失配），列入无效并给出原因；
4. **执行**：组装 prompt（**与生产 develop 同模板**，见 §4）→ `runClaude`（bypassPermissions、cwd=工作树、无审批）→ 采集指标；
5. **防篡改**：verify 前把 `<testFiles>` 再 `checkout fixRef --` 重置一次（agent 改测试来通关的做法直接判无效）；
6. **判定**：跑 verify（复用 `capabilities/verifier.js#runVerify`）→ pass/fail + 输出摘要；
7. **收尾**：`git worktree remove --force`（`--keep` 保留现场）。

## 3. 目录与分层

```
benchmarks/
  README.md            # 用法
  run.mjs              # CLI 入口（--list/--scan/--validate/--run）
  cases/*.json         # 题集（入库；每条一文件便于 diff/审阅）
  results/             # 产出（gitignore）：<stamp>.json + <stamp>.md
  lib/
    cases.logic.js     # 纯函数：schema 校验/归一、扫描候选判定、verify 命令构造、git log 解析
    cases.logic.test.js
    report.logic.js    # 纯函数：结果聚合（三张表）+ markdown 渲染
    report.logic.test.js
    runner.js          # 编排（worktree/agent/verify/清理），依赖注入（git/agent/verify/时钟）
    runner.test.js     # 注入 fake 的编排测试
    runner.fs.test.js  # 真 git：临时仓库上验证 worktree/overlay/reset 全链
```

- 测试进 `npm test`：`package.json` 的 test glob 增加 `"benchmarks/**/*.test.js"`；
- 工作树固定放 `<repo>/.bench-ws/`（gitignore）：Node 模块解析向上找到仓库根 `node_modules`，老提交无需重装依赖；
- 旧提交的测试依赖后续才出现的工具 → `--validate` 拦截并报告，不进题集。

## 4. Prompt 复用（关键纪律）

benchmark 必须与生产 `develop` 用**同一份模板**，否则「改提示词」这个变量在评测里测不出来。把 `task-ops.js#develop` 里的模板抽为纯函数：

- `src/plugins/team-tools/auto-dev/prompt.logic.js#buildDevelopPrompt({ type, detail, analysis, scopeSection, scopeFix, verifyCommand, verifyFeedback })`
- `develop()` 与 benchmark runner 均调用它（benchmark 传基准工作区说明 `scopeFix`，bot scope 段传空串）。

## 5. 案例 schema（v1）

```json
{
  "id": "git-selector-four-defects",
  "title": "分支选择器完全不可用",
  "type": "bug",                          // bug | feature
  "input": "分支选择器点开是空的，切分支也不刷新…",   // 用户口吻的原始反馈（agent 可见）
  "analysis": "",                         // 可选：分析建议（对齐 develop 的输入形态）
  "fixRef": "c971660",                    // 修复提交（testFiles 的权威来源）
  "baseRef": null,                        // 缺省 fixRef^
  "testFiles": ["public/js/git-selector.test.js"], // 判据（overlay + 防篡改重置）
  "verifyCommand": "",                    // 缺省 `node --test <testFiles…>`
  "tags": ["git", "ui"]
}
```

校验规则（`validateCase`）：id 必填且唯一、type ∈ {bug,feature}、input 必填、testFiles 非空且都是 `*.test.js` 相对路径（拒绝绝对路径与 `..`）、fixRef 形如 hex、verifyCommand 为空或显式给出（**只允许人写进案例文件的值**，绝不接受运行时输入）。

## 6. 指标口径

| 指标 | 来源 |
|---|---|
| ok（通过） | `verify.ok === true`（skipped 视为无效：判据必须真实执行） |
| toolCalls | `runClaude` 的 `onActivity` 次数（工具调用数） |
| numTurns | SDK result 的 `num_turns`（`integrations/claude.js` 增补透传；缺失为 null） |
| inputTokens / outputTokens | SDK result usage（同 web run 口径） |
| costUsd | SDK result `total_cost_usd`（可能为 null） |
| durationMs | runner 计时（准备完成 → agent 返回） |

报告：`results/<stamp>.json`（机器可读）+ `<stamp>.md`（三张表：通过率 / 回合数 / token 成本 + 汇总行）。案例失败/报错均如实入表（`error` 字段），不因单题异常中断整轮。

## 7. CLI

```
node benchmarks/run.mjs --list                          # 题集概览
node benchmarks/run.mjs --scan [--limit 60] [--write]   # 扫描可成案的提交；--write 写 draft 案例文件
node benchmarks/run.mjs --validate [--case <id>] [--keep]  # 离线校验（判据必须失败）
node benchmarks/run.mjs --run [--case <id>] [--model m] [--keep] [--timeout <min>]
```

`--run` 消耗真实额度，**只手动触发**；不进任何自动泵/CI。`--scan` 产出的 draft 必须人工把 `input` 改写成用户口吻反馈后才算有效题（draft 带 `"draft": true` 标记，`--list/--run` 会提示）。

## 8. 非目标（本期不做）

- web UI / auto-dev 周报挂接（runner 以纯函数 + JSON 产出预留接口）；
- 并行执行与多模型自动横评（额度敏感；串行 + 手动指定模型）；
- openai-compat 路径的 benchmark（auto-dev 生产路径是 Claude；留 `--provider` 扩展位）。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| agent 改测试来通关 | prompt 反绕过纪律（`buildVerifySection` 自带）+ verify 前重置 testFiles + 判据只看重置后的结果 |
| 旧提交在当前依赖下跑不起来 | `--validate` 预检（判据必须「修复前失败」），跑不动的题直接剔除 |
| worktree 残留 / 污染主仓 | 工作树只在 `<repo>/.bench-ws/`（gitignore）、收尾强制 remove、启动时 `worktree prune`；主仓工作区与未提交改动完全不被触碰 |
| 大杂烩提交（几百文件）成题 | 扫描器按 `changedFiles ≤ 12` 且主体非 `docs/test` 过滤；draft 人工审 |
| 额度失控 | 串行执行、单题超时（默认 30min）、`--run` 手动触发、结果成本入表可审计 |

## 10. 实施状态

- [x] spec 拍板（2026-10-08；案例来源=本仓历史修复回放、交付=独立 CLI + 离线校验）
- [x] `integrations/claude.js` numTurns 透传 + `prompt.logic.js` 抽取（develop 共用，含单测）
- [x] `benchmarks/lib`（cases/report/runner + 单测，含真 git fs 级：worktree/植入/防篡改重置/清理）
- [x] `benchmarks/run.mjs` CLI + README + `package.json` test glob（`benchmarks/**/*.test.js`）
- [x] 题集初版：**25 条**（扫描 28 候选 → 3 条剔除 → 人工改写 input；`--validate` 25/25 全部「修复前失败」）
- [ ] 首次真跑（消耗额度，维护者手动）与 baseline 存档 —— 真跑命令：`node benchmarks/run.mjs --run`
