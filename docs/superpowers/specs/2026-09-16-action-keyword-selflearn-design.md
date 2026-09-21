# 动作关键词自学习 · 设计文档

- 日期：2026-09-16
- 状态：设计已拍板，待实现
- 关联模块：`src/app/intent.js`、`src/plugins/action-runner/`、`src/store/action-configs.js`、`public/js/actions-panel.js`

## 1. 背景与问题

飞书机器人的意图识别是逐层短路的（见 `src/app/CLAUDE.md` §B）：

- **L2 动作关键词单命中**：`action-configs.json` 里配的 `keywords[]` 用 `text.includes(kw)` 匹配，恰好单命中即判 `action`。纯本地字符串匹配，亚毫秒返回。
- **L3 语义分类**：L2 没命中才调一次 Haiku（10s 预算），花钱且让用户等。

问题：关键词表完全靠人在 web 面板手工维护。用户的真实说法千变万化，配置里永远漏掉大半，于是同一个动作反复走 L3——**每次都花一次 LLM 调用 + 让用户等几秒，去认一句上次已经认过的话**。

目标：LLM 认出某个动作后，把这次的说法沉淀成关键词写回配置，下次同样的说法走 L2 秒出。

**核心约束（用户明确要求）**：加关键词必须分析是否会影响其他动作的识别，会影响就不加，不要太激进。

## 2. 拍板结论

| 决策点 | 结论 | 理由 |
|---|---|---|
| 学习触发时机 | **动作脚本执行成功后**（`result.ok === true`） | 用户用行为确认了「LLM 判对了」。中途取消 / 脚本失败都不学，避免把误判固化成永久关键词 |
| 候选词来源 | **执行成功后异步单独调一次 LLM** | 不污染 L3 那个已校准、用户在等的 10s 关键路径 prompt；离线任务可以把全部同 bot 动作喂进去做冲突分析 |
| 落地方式 | **直接写入生效 + 可追溯可撤销** | 符合「后台直接改动作配置」的诉求；同时记元数据，面板可见、可一键删 |
| 保守度 | **严格：只学原句里真出现过的词** | 泛化词是模型幻觉的重灾区，误伤面大 |
| 频次门槛 | **不设，一次成功执行即学** | 「执行成功」+「严格硬闸」已是两道闸；再叠频次会让低频动作永远学不到，且需新增跨进程计数器 |

## 3. 触发链路

```
用户消息
  │
  ├─ L2 关键词命中 ────────────────────→ 秒出 action，【不学】（本来就没花钱）
  │
  └─ L3 LLM 兜底命中 action（via:'llm'）
        │
        ├─ 用户「取消」 ───────────────→ 【不学】
        ├─ 槽位填充异常 / 追问超时 ────→ 【不学】
        └─ 脚本执行 result.ok === true ─→ 【后台异步学习】
```

三个信号的传递方式：

1. `src/app/intent.js` 的 L3 命中 `action` 时，返回值多带一个 `via: 'llm'` 字段（L2 命中分支**不带**）。
2. `action-runner/feature/index.js` 的 `proceedWithAction` 在开始槽位填充时，把 `{ text: 触发原句, via }` 记进该用户的 `pendingState.learnSrc`。
   - `setPending` 内部改为**继承已有条目的 `learnSrc`**，这样多轮追问链路上不必逐处透传（只改一个函数，不改 4 个调用点）。
   - 用「触发原句」而非 `ctx.text`：走到 `executeAction` 时 `ctx.text` 可能是最后一条补槽位的回答（如「test」），不是触发那句。
3. `executeAction` 的 `result.ok` 分支 fire-and-forget 调 `learnKeywords()`。

卡片按钮入口（`action-runner/card-action.js`）构造虚拟 ctx 直调 `handle`，`intentResult` 不含 `via` → 天然不学，无需额外判断。

## 4. 学习管线

新文件 `src/plugins/action-runner/feature/learn-keywords.js`，四步：

### 步骤 1：取上下文

- 触发原句（`learnSrc.text`）
- 命中动作：`name` / `description` / 现有 `keywords`
- **同 bot 其余启用动作**的 `name` / `description` / `keywords`（冲突分析的依据；动作 per-bot 独享，跨 bot 不会互相干扰，不必纳入）

### 步骤 2：LLM 提词

调 `capabilities/llm-classify.js` 的 `runClassifierOnce`：

- `model`: `config.intent.classifyModel`（与 L3 同一个 haiku）
- `timeoutMs`: 不传，用默认 30s（后台任务，不抢用户时间）
- `logTag`: `'action/learn-kw'`
- 输出契约：`{"keywords":["…","…"]}`，1–3 个候选

prompt 要点：

- 明确要求候选词**必须是原句里的连续子串**，不得改写、不得泛化
- 给出其他动作清单，要求避开会与它们混淆的说法
- 要求给「能代表这个动作意图的动宾短语」，而不是变量值（`test`、`13800138000` 这类是槽位值，不是意图词）

模型的冲突判断只是**第一层过滤**，最终裁决权在步骤 3 的本地硬闸。

### 步骤 3：本地硬闸（`feature/keyword-guard.js`，纯函数）

`canLearnKeyword({ word, action, otherActions, sourceText })` → `{ ok: boolean, reason: string }`

按顺序判七条，任一不过即弃并记日志（`reason` 用于排查「为什么没学到」）：

| # | 规则 | 理由 |
|---|---|---|
| 1 | 必须是 `sourceText` 的连续子串（归一化大小写与空白后比较） | 防模型凭空造词，这是「严格档」的地基 |
| 2 | 长度：纯中文 ≥3 字；含英文/数字 ≥4 字符；总长 ≤12 | 2 字中文词（「清理」「重置」）语义太弱必然泛命中；超长词学了也不会再命中 |
| 3 | 不在通用停用词黑名单里（两类：通用词 `帮我`/`一下`/`麻烦`/`可以`/`这个`/`那个`/`什么`/`怎么`/`现在`/`数据`/`环境`/`系统`/`问题`…；寒暄词 `早上好`/`下午好`/`晚上好`/`辛苦了`/`谢谢你`…） | 这类词在任何消息里都可能出现 |
| 4 | 不得命中 `app/intent-keywords.js` 的 L1 强前缀词表（`matchStrongIntent`） | 否则「提交需求：清一下数据后白屏」这类消息会被动作抢走，破坏 L1 短路语义 |
| 5 | **双向子串冲突**：候选词与**其他启用动作**的任一现有关键词，互不为子串 | 见下方 §4.1，这是「会不会影响其他动作」的判据本体 |
| 6 | 与**本动作**已有关键词互不为子串（冗余）；且本动作 `autoKeywords.length < 5` | 冗余词不增加召回只增加噪声；上限防无限膨胀 |
| 7 | 不在本动作 `rejectedKeywords[]` 里 | 用户手动删过的词不再学回来（否则「撤销」形同虚设） |

#### 4.0 规则 4 的分层边界（实现时勿踩）

`keyword-guard.js` 只许 import `app/intent-keywords.js`——它是**刻意允许的零依赖叶子**，`features/claude-exec/logic.js` 已有同样的反向 import 先例（理由见 `src/app/CLAUDE.md` §C，`src/import-graph.test.js` 有专门的测试钉住它保持零依赖）。

**不得** import `app/intent.js` 的 `isChitchat`：那个文件依赖 `llm-classify` 与 `store`，引进来是一条真实的反向依赖，会把整条分类链拖进插件层。寒暄拦截改由规则 2（长度）+ 规则 3（黑名单里的寒暄词）承担——常见寒暄词本就 2 字（`你好`/`在吗`/`谢谢`），长度闸已经卡掉绝大多数，3 字以上的少数几个直接列进黑名单即可。

#### 4.1 为什么是双向子串检查

L2 的匹配是 `消息.includes(关键词)`。设候选词 `W`（要加给动作 A），其他动作 B 已有关键词 `K`：

- **正向（`W.includes(K)`）**：例 `W='清理测试数据'`、`K='清理'`。今后任何含 `W` 的消息必然也含 `K` → 同时命中 A 和 B → `hit.length === 2` → L2 失效，退回 L3。**结果是把原本秒出的 B 也拖慢了**，净负收益。
- **反向（`K.includes(W)`）**：例 `W='重置'`、`K='重置密码'`。今后「帮我重置密码」同时命中 A 和 B → 同样多命中。

两个方向都必须拦。只查一边等于留一半的洞。

判据只看**其他动作**，不看本动作的 name/description（那是给 LLM 看的语义材料，不参与 L2 匹配，拿来做子串判断会无谓地卡掉合法候选）。

### 步骤 4：原子写入

`src/store/action-configs.js` 新增：

```js
appendAutoKeyword(id, word, meta) // meta = { sourceText, learnedAt }
```

必须在 `updateJson` 的回调**内部**完成「读当前条目 → 复核上限与去重 → 双写 `keywords` 和 `autoKeywords`」。

不能在外面 `getConfig()` 再 `updateConfig()`：web 与飞书是两个进程、共享同一份 `action-configs.json`，读改写之间会互相覆盖（`src/store/CLAUDE.md` 流程 A 已明确这条纪律）。上限复核也必须在锁内重做一次——步骤 3 判断时读到的是快照。

## 5. 数据结构

`action-configs.json` 的动作条目新增两个字段，均可缺省（存量配置零迁移）：

```js
{
  id: 'ac_xxx',
  keywords: ['清一下', '清数据', '清掉测试数据'],   // L2 读这个，匹配逻辑一行不动
  autoKeywords: [                                   // 自动学来的词的元数据
    { word: '清掉测试数据', sourceText: '帮我把测试环境数据清掉', learnedAt: '2026-09-16T…' }
  ],
  rejectedKeywords: ['重置'],                       // 用户删过的自动词，永不再学
}
```

设计取舍：自动词**同时**写进 `keywords[]`，而不是让 L2 去读两个数组。这样 `intent.js` 的 L2 匹配逻辑完全不动，也不会出现「两处词表语义分叉」的隐患。`autoKeywords` 纯粹是旁路元数据。

## 6. 可见性与撤销

- **面板展示**（`public/js/actions-panel.js`）：动作卡片的关键词行把自动词标成 `清掉测试数据 ·自动`；编辑对话框里自动词与手工词混在同一个逗号分隔输入框，用户正常删除即可。
- **撤销闭环**（`web/routes-ops.js` 的 `handleActionsPut`）：保存时 reconcile
  1. `autoKeywords` 收敛为 `keywords` 的子集（用户删掉的自动词从元数据里也消失）
  2. 被删掉的那些 `word` 追加进 `rejectedKeywords`
  
  于是硬闸第 7 条生效：同样的话再来一次也不会把词加回来。撤销是永久的。

## 7. 失败姿态与成本

- **全程 fire-and-forget**：`executeAction` 回复结果后立即返回，学习在后台跑。异常一律 catch 吞掉 + `logger.warn`，绝不影响用户拿到执行结果。
- **额度耗尽自动跳过**：`runClassifierOnce` 内置 `isPoolExhausted` fail-fast，池子空时直接返回 null → 不学，不产生任何额外调用。
- **成本边界**：只在「L3 兜底命中 + 执行成功」这个交集上触发。L2 已命中的路径零成本。随着关键词积累，触发频率本身会自然衰减——这正是这个功能的目的。
- **不会越学越糟**：硬闸第 5 条保证新词不制造多命中，第 6 条封住膨胀，第 7 条让人工纠正永久生效。

## 8. 测试

- `keyword-guard.test.js`：七条规则逐条钉死，重点是第 5 条的**两个方向各一个用例**（正向 `清理测试数据` vs `清理`；反向 `重置` vs `重置密码`）。纯函数，无 IO。
- `learn-keywords.test.js`：依赖注入替身（假 LLM、假 store），验证编排——候选全被拒时不写盘、部分通过时只写通过的、LLM 返回 null 时静默退出。不联网不写盘。
- 回归：`intent.test.js` 补一条断言，确认 L2 命中分支**不带** `via` 字段。

## 9. 改动清单

| 文件 | 改动 | 类型 |
|---|---|---|
| `src/app/intent.js` | L3 action 分支加 `via:'llm'` | 改（1 行） |
| `src/plugins/action-runner/feature/index.js` | `setPending` 继承 `learnSrc`；`proceedWithAction` 写入；`executeAction` 成功分支 fire-and-forget 触发 | 改 |
| `src/plugins/action-runner/feature/keyword-guard.js` | 硬闸纯函数 | 新增 |
| `src/plugins/action-runner/feature/keyword-guard.test.js` | 七条规则单测 | 新增 |
| `src/plugins/action-runner/feature/learn-keywords.js` | LLM 提词 + 管线编排 | 新增 |
| `src/plugins/action-runner/feature/learn-keywords.test.js` | 编排单测 | 新增 |
| `src/store/action-configs.js` | `appendAutoKeyword` + `reconcileAutoKeywords` | 改 |
| `src/store/action-configs.test.js` | 原子写入与 reconcile 单测 | 改 |
| `src/entrypoints/web/routes-ops.js` | `handleActionsPut` 保存时 reconcile | 改 |
| `public/js/actions-panel.js` | 自动词标识 | 改 |
| `src/app/CLAUDE.md` / `src/plugins/CLAUDE.md` / `src/store/CLAUDE.md` | 同步模块地图 | 改 |

## 10. 原则落点

- **SRP**：提词（`learn-keywords.js`）、判词（`keyword-guard.js`）、写词（`store`）三件事三个模块，各自可独立测试。
- **OCP**：`intent.js` 只新增一个字段，L2 匹配逻辑与 L1 词表零改动；能力全部长在 action-runner 插件内部，符合「加功能 = 加插件」纪律。
- **KISS**：自动词直接混入 `keywords[]`，不引入第二套匹配路径。
- **YAGNI**：不做频次计数器、不做影子词观察期、不做历史消息回放验证、不做跨 bot 冲突分析。这些都是可以事后按实际误伤情况再加的，先不预留。

## 11. 明确不做

- 不学**变量值**（`test` / 手机号 / 用户 ID）——它们是槽位，不是意图。prompt 里明确禁止，硬闸第 2、3 条兜底。
- 不做同义词泛化（「清掉」→「重置」），只学原句里真出现过的词。
- 不自动淘汰已有关键词。即便某个词后来造成多命中，也只记日志，由人决定删不删——自动删配置比自动加更危险。
