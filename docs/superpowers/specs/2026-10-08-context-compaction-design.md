# 上下文压缩（T7）· 设计

- 日期：2026-10-08
- 状态：已拍板（2026-10-08，四处决策经确认）；实现中，进度见 §8
- 关联：`next-tasks.md` T7；T2 spec 非目标「不改 conv-messages 200 条截断口径（T7）」；roadmap「上下文压缩：决策=暂缓（2026-07-24）」——repo map 上线后长会话变多，本次重启并定型
- 范围：**openai-compat 路径**（`store/conv-messages.js` + `entrypoints/web/run-openai.js`）。Claude 路径由 SDK `autoCompactEnabled` 覆盖，不动。

## 1. 背景与问题

`store/conv-messages.js` 是 openai 路径的会话历史（AI SDK Message 数组）+ T2-P3 检查点。现状：

- `appendMessages` 在**每次追加时就硬截** `MAX_MESSAGES = 200` 条（`mergeMessages` 尾部 slice）——两个后果：
  1. **切点不看角色**：恰在 tool 序列中间切开时，保留段的头部会留一条「没有对应 tool-call 的 tool 结果」；头部非法序列发给 OpenAI 兼容端点**可能直接 400**（`repairDanglingToolCalls` 只修「调用缺结果」，不修「结果缺调用」）；
  2. **旧消息被物理丢弃**：200 条以外直接消失，模型永久失忆（原文不保留，也无摘要）。
- 200 条对不同窗口模型是一刀切（gpt-4 8k 与 200k 窗口同等待遇）。

## 2. 目标与非目标

**目标**（拍板后的定型）：

1. **边界安全的截断**：任何从头部丢消息的地方（压缩视图、磁盘 backstop），新头部不得是 `tool` 结果；
2. **summary + 原文保留**：历史超限时生成滚动摘要（覆盖被移出模型视野的旧段），模型只见「摘要 + 近期」；**原文留在存储**（可回溯/可复查，磁盘另有 1000 条 backstop）；
3. **同凭证摘要**：摘要用会话自己的 openai 凭证做一次性无工具调用（agent-loop 零工具自然降级纯对话），不引入 Claude token 池依赖；失败 **fail-open**（跳过压缩，本轮按原文继续并出 activity 提示）；
4. **旧数据自愈**：v1 数组读侧兼容；既有的「头部孤儿 tool 结果」在装载时剔除。

**非目标（本期不做）**

- Claude 路径（SDK autoCompact 已覆盖）；
- token 估算触发（本期按条数；纯函数留了参数位，后续可换口径）；
- 历史消息的检索/回填工具（原文保留但不做「按需捞回」的模型工具）；
- 压缩的独立配置开关（与 Claude 路径一致默认开，fail-open 已兜底）。

## 3. 拍板记录（2026-10-08 已确认）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 摘要器来源 | **同凭证一次性无工具调用**（agent-loop 零工具；失败 fail-open） |
| 2 | 触发口径 | **消息条数**：模型可见长度 > 200 触发；保留最近 ≥100（沿 user 边界取整轮）；至少新丢 20 条才动手 |
| 3 | 存储形态 | **`conv-messages.json` 单文件 v2**：`{ [convId]: { v:2, messages, summary } }`；读侧兼容 v1 数组（下次写入升级）；摘要与消息同锁原子更新 |
| 4 | 磁盘 backstop | **`MAX_STORED = 1000`** 条：按「新头部非 tool」的边界裁剪，并同锁平移 `summary.covered` |

## 4. 设计

### 4.1 存储形状（v2，向后兼容）

```jsonc
{
  "c1": { "v": 2, "messages": [/* AI SDK Message，原文保留 */],
           "summary": { "text": "…", "covered": 320, "at": 1728380000000, "model": "glm-4" } }, // covered = 摘要覆盖的前 N 条
  "c2": [/* v1 旧形状：读侧归一为 {messages, summary:null}，首次写入时升级 */]
}
```

- `getMessages(convId)` 仍返回数组（兼容既有调用方）；新增 `getSummary` / `setSummary` / `getConvState`；
- `appendMessages`：合并 → `trimForStorage(messages, MAX_STORED)`（纯函数：必要时从头部丢到新头部非 `tool`；`dropped` 条数同锁平移 `summary.covered`：`max(0, covered - dropped)`，为 0 时摘要文本仍有效——它覆盖的都是更早的内容）；
- `mergeMessages(prev, msgs, max)` 保留原语义（纯函数、测试在用），**追加路径不再用它做 200 截断**。

### 4.2 压缩纯函数（`entrypoints/web/conv-compact.logic.js`）

| 函数 | 职责 |
|---|---|
| `dropLeadingOrphans(messages)` | 剔除头部孤儿 `tool` 结果（v1 遗留脏数据自愈） |
| `shouldCompact({ total, covered })` | `total - covered > COMPACT_TRIGGER(200)` |
| `pickCompactCut(messages, { keepRecent })` | 最大的 `i ≤ len - 100` 且 `messages[i].role === 'user'`（整数轮边界，天然不切 tool 序列）；要求 `i ≥ covered + MIN_DROP(20)`，否则 `-1`（不压） |
| `formatMessagesForSummary(messages)` | 被丢段 → 紧凑转录（角色标签、单条截断、总量头尾截断），防摘要调用本身爆上下文 |
| `buildSummaryPrompt({ previousSummary, dropped })` | 滚动摘要 prompt：旧摘要 + 新增被丢段 → 新摘要（保留目标/约束/决策/改动文件/未完成项/关键 id；不编造） |
| `composeSystemWithSummary(systemPrompt, summaryText)` | 摘要挂到 system 段尾（不造假的 user/assistant 轮） |

### 4.3 运行时（`run-openai.js`）

`runOpenAiSession` 开头（fresh/resume 共用）：

```
messages ← 已修复悬空 + 去头部孤儿的历史（含本轮 user 消息）
summary  ← getSummary(convId)
if shouldCompact: cut = pickCompactCut(messages)
   → 摘要输入 = 旧摘要文本 + messages[covered .. cut)
   → 同凭证一次性调用（零工具；复用 run.abortController）
   → setSummary(convId, { text, covered: cut, at, model })   // 单文件单锁
   → runActivity「📝 历史较长：已生成摘要（覆盖前 N 条，原文保留）」
  失败 → runActivity 警告，继续用原文（fail-open）
system  ← composeSystemWithSummary(systemPrompt, summary)
视图   ← messages.slice(covered)（covered 越界/非法时退化为全量，fail-safe）
```

- checkpoint 游标 `persistedCount = modelMessages.length` 自动对齐视图（system + 视图），尾部兜底 append 只写新增 ✅；
- 摘要调用不弹审批、不落 journal（它是压缩动作，不是会话内容）；失败/跳过都只影响本轮上下文完整度，不影响消息持久化与 resume。

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 摘要调用失败/无凭证 | fail-open：本轮按原文继续（与现状同），activity 可见；不写半截 summary |
| 摘要质量差导致模型丢关键约束 | prompt 固定保留项（目标/约束/决策/文件/未完成/id）；原文保留可人工复查；滚动摘要（旧摘要参与合并）避免多轮失真 |
| 视图切点越界（summary.covered 与消息数组漂移） | 单文件同锁原子更新；视图构建对 covered 做合法性校验，非法退化全量 |
| 摘要自身超长撑爆 system | `SUMMARY_MAX_CHARS` 截断（纯函数，测试钉住） |
| 磁盘无限膨胀 | MAX_STORED=1000 边界安全裁剪 + 每次落盘全文件重写成本可控（约 5~10MB 上限） |
| 行为变化 | 触发阈值与旧 200 同量级；切点从「任意位置」改为「user 边界」只收紧不放松；模型可见内容由「仅近期」变「摘要+近期」为增强 |

## 6. 测试策略

- `conv-compact.logic.test.js`：切点（user 边界/无边界不压/minDrop/keepRecent）、漂移兜底、转录格式化截断、 prompt 组装（含旧摘要）；
- `conv-messages.test.js` 扩写：v1 读兼容与写入升级、`trimForStorage` 边界（新头部非 tool、全 tool 退化）、covered 同锁平移、`setSummary/getSummary` 往返、`getMessages` 兼容；
- `run-openai.resume.test.js` 增集成：构造 >200 条有效历史 → 假 provider 两步脚本（摘要 → 正式回答）→ 断言模型输入 = system(含摘要) + `slice(cut)`、存储未丢原文、summary 落盘、第二轮（再超限）滚动摘要合并旧文本；
- `tests/e2e-openai-resume.mjs` 读盘断言适配 v2 形状（`{v:2, messages, summary}`，v1 数组兜底）——v2 上线后该 e2e 实锤抓出并修复；
- 既有 T2-P3 检查点/悬空修复用例回归；全量 `npm test` + e2e。

## 7. 实施状态

- [x] spec 拍板（2026-10-08，四处决策见 §3）
- [x] 纯函数（`entrypoints/web/conv-compact.logic.js` + 单测：7 用例）
- [x] 存储 v2（`store/conv-messages.js`：单文件摘要、v1 兼容、`MAX_STORED` 安全裁剪 + covered 同锁平移）
- [x] 运行时接线（`run-openai.js#maybeCompactHistory`：同凭证一次性摘要、fail-open、视图 = 摘要 + 近期；`loadRepairedHistory` 追加头部孤儿剔除）
- [x] 集成测试（`run-openai.resume.test.js`：首压 + 滚动摘要两用例；全量 `npm test` 3695 全绿、e2e 12/12）
