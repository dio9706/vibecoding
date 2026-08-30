# 归档说明

> **这里的文档不代表项目当前状态。** 它们是完成后的阶段性产物：修复报告、
> 测试清单、已完成的迁移蓝图。保留是为了追溯「当时为什么这么决定」，
> 不是为了指导现在怎么做。
>
> 查当前状态请看：[../ARCHITECTURE.md](../ARCHITECTURE.md)（架构）、
> [../../README.md](../../README.md)（概览）、[../README.md](../README.md)（文档导航）。

---

## 2026-08-28 归档（项目全面体检）

| 文件 | 原位置 | 归档原因 |
|---|---|---|
| `ARCHITECTURE-legacy-sections-6-10.md` | `docs/ARCHITECTURE.md` 第 550 行起 | 两份文档被错误拼接，且内容与现状矛盾（详见该文件头部说明） |
| `CHANGES_SUMMARY.md` | 项目根 | ↓ |
| `IMPLEMENTATION_COMPLETE.md` | 项目根 | ↓ |
| `QUICK_START.md` | 项目根 | ↓ |
| `START-HERE.md` | 项目根 | 引用的 `test-degradation.mjs` 已不存在，指令跑不通 |

前四份里有三份（`CHANGES_SUMMARY` / `IMPLEMENTATION_COMPLETE` / `QUICK_START`）
讲的是**同一件事** —— 2026-08-12 修 `Response stalled mid-stream` 错误，
一次修复留下了四份互相引用的文档堆在项目根目录。

同批的 `RETRY_LOGIC.md` **没有归档**：它描述的指数退避重试机制现在仍然在跑
（`src/integrations/claude.js`），已移到 [../RETRY_LOGIC.md](../RETRY_LOGIC.md) 继续作为现役文档维护。
所以本目录里几份文档提到的「见 RETRY_LOGIC.md」，指的是那个新位置。

## 更早的会话归档

`TASK*-*`、`ANIMATION-TEST-REPORT.md`、`DEGRADATION-TEST-GUIDE.md`、
`TESTING-QUICK-START.md`、`VERIFICATION-REPORT.md`、以及几份 `.txt`
是更早的开发会话留下的任务完成报告与测试记录，归档时间早于本文件，具体批次未逐一登记。
