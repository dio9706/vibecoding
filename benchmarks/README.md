# 内部 Benchmark（T5）

改 auto-dev 提示词 / 工具集 / repo map 注入 / 模型之后，用一个固定题集回答「更自主还是更飘」。
设计见 [`docs/superpowers/specs/2026-10-08-internal-benchmark-design.md`](../docs/superpowers/specs/2026-10-08-internal-benchmark-design.md)。

## 题源：本仓历史修复回放（SWE-bench 式）

每条案例绑定本仓的一次修复提交：

- **基线**：`fixRef` 的父提交（`git worktree` 独立检出，**不含**工作区未提交改动）；
- **判据**：该提交里的 `*.test.js`（overlay 到基线；评分前会再重置一次，改测试作弊无效）；
- **输入**：人写的用户口吻反馈（`input` 字段），agent 在基线工作树上重做这次修复；
- **判定**：`node --test <testFiles…>`（也可在案例里显式配置 `verifyCommand`）。

## 用法

```bash
node benchmarks/run.mjs --list                             # 题集概览
node benchmarks/run.mjs --scan                             # 扫描可回放的提交（测试+实现同改、规模可控）
node benchmarks/run.mjs --scan --write                     # 把候选写成 draft 案例到 cases/
node benchmarks/run.mjs --validate                         # 离线校验：修复前判据必须失败（不消耗额度）
node benchmarks/run.mjs --run                              # 真跑（消耗额度；串行；出三张表）
node benchmarks/run.mjs --run --case <id> --keep           # 单题 + 保留工作树现场（.bench-ws/<id>）
```

`--run` 产出 `results/<stamp>.json`（机器可读）与 `results/<stamp>.md`（通过率 / 回合数 / token 成本）。

## 新增一条案例

1. `--scan --write` 生成 draft（`input` 只是提交主题的占位）；
2. 人工把 `input` 改写成**用户口吻的反馈**（现象/预期，别贴实现细节），必要时补 `analysis`；
3. 删掉 `"draft": true`，`--validate` 确认「修复前判据失败」；
4. 校验通过后与其它案例一起入库（`cases/*.json`）。

### 案例 schema（v1）

```json
{
  "id": "abc1234-add-sum-fix",
  "title": "加法算错",
  "type": "bug",
  "input": "add(2,3) 结果是 -1，应该是 5",
  "analysis": "",
  "fixRef": "abc1234",
  "baseRef": null,
  "testFiles": ["lib/calc.test.js"],
  "verifyCommand": "",
  "tags": ["calc"]
}
```

- `fixRef` / `baseRef`：git 引用（7~40 位 hex）；`baseRef` 缺省 `fixRef^`；
- `testFiles`：必须 `*.test.js` 相对路径（拒绝绝对路径与 `..`）；判据命令缺省 `node --test <files…>`；
- `verifyCommand`：只允许案例文件里的固定值（verifier 命令来源硬约束，见 `src/capabilities/verifier.js`）。

## 指标口径

| 指标 | 来源 |
| --- | --- |
| 通过 | `runVerify` 判定 `ok`（skipped 视为无效，不计通过） |
| 工具调用数 | `runClaude` 的 `onActivity` 次数 |
| 模型回合 | SDK result 的 `num_turns`（缺失为 `-`） |
| token / 成本 | SDK result `usage` 与 `total_cost_usd`（缺失为 `-`） |
| 耗时 | 单题从准备完成到 agent 返回 |

## 纪律与边界

- prompt 与生产 `develop` **同一模板**（`src/plugins/team-tools/auto-dev/prompt.logic.js`），改提示词两边同时生效，A/B 才成立；
- 工作树只在仓库根 `.bench-ws/`（gitignore，模块解析向上复用根 `node_modules`）；跑完默认清理，`--keep` 留现场；
- `--run` 只手动触发，不挂任何自动泵；单题默认 30 分钟超时；
- 旧提交在上古依赖下跑不动的题，会被 `--validate` 拦下（判据必须失败才算有效题）；
- 测试进 `npm test`（`benchmarks/**/*.test.js`）；注意 `runner.fs.test.js` 里主动摘掉 `NODE_TEST_CONTEXT` 的原因注释（嵌套 `node --test` 会假通过）。
