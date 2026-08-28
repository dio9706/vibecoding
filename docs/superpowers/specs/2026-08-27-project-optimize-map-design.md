# 一键优化：维度① 项目地图自动修复 设计

> 2026-08-27 ｜ 前置：`2026-08-24-project-optimize-design.md`（总设计）、`2026-08-26-project-optimize-handoff.md`（阶段三交接）

## 一、范围

维度① 地图的 **M1~M4 全套**自动修复。M5（根地图超长）保持 `fixable: false` 不变——拆分策略因项目而异，机器分不清哪些内容该下沉。

用户已拍板的三项：

| 决策 | 选择 |
|---|---|
| 模型怎么拿项目事实 | **事实包打底 + 只读工具深挖** |
| M3 怎么处理已有地图 | **只追加不覆盖** |
| M2 的模块数量 | **不限制，全量生成** |

## 二、四条 issue 的本质分类

| code | 动作 | 需要 LLM | 落盘 action | 风险 |
|---|---|---|---|---|
| M1 无根地图 | 新建 `CLAUDE.md` | 是 | `created` | 低（无中生有） |
| M2 缺模块地图 | 新建 `<mod>/CLAUDE.md` | 是 | `created` | 低 |
| M3 地图过期 | 在已有地图**末尾追加**核对块 | 是 | `modified` | 中 |
| M4 死链 | 改一行里的路径字面量 | **否** | `modified` | 中 |

M4 不需要 LLM：`check-map.js:51` 的 `buildPathIndex` 已经建好全仓相对路径索引，拿 basename 做唯一性匹配就能确定性算出候选。引入模型只会增加不确定性和成本。

## 三、mtime 陷阱（本设计最重要的一条）

`check-map.js:106-108` 判过期的算法是：

```
staleDays = (模块内代码文件的最新 mtime - 地图文件 mtime) / 天
```

**任何写入地图文件的动作都会把地图 mtime 推到当下，`staleDays` 直接归零。** 后果：

- M4 修完一条死链 → 那份地图的 M3 告警在下次体检时消失，**但地图内容并没有变新鲜**；
- M3 追加完核对块 → 同样归零，而追加块只是「列出差异」，并没有真正把地图改对。

两种情况下 map 分数都会上涨，实际新鲜度却原地不动。这与 `describe-skill.js:6-8` 记录的失败形状完全一致：**分数变好、实际变差，没有任何自动信号能发现**。

### 应对（三条，缺一不可）

1. **M3 的清单必须在任何写盘之前从体检报告里固化**，不能边写边算——否则 M4 先跑就会把 M3 的对象吃掉一部分。
2. **M3 追加块要足够醒目且自带日期**，让人读地图时一眼看到「这份地图有已知的未对齐项」，不依赖体检分数来提醒。
3. **优化结果里显式告知**：新增一条 note——「本次写入已刷新 N 份地图的时间戳，M3 过期告警将不再出现；请以地图内的 ⚠️ 自动核对块为准」。不说这句，用户就会把分数上涨误读成问题已解决。

## 四、执行顺序

```
① 判断 M1 是否命中
   ├─ 是 → 生成根地图 → 写盘 → 重新 checkMap(dir) 拿到真实的 M2/M3/M4 清单
   └─ 否 → 直接用体检报告里的 M2/M3/M4 清单
② 固化 M3 清单（此时还没有任何写盘）
③ 打快照 createBackup
④ M4 死链修复（确定性，最快，先做完可以让后续 LLM 阶段的失败不影响它）
⑤ M2 模块地图生成（受限并发）
⑥ M3 追加核对块（受限并发）
⑦ recordPostState → refreshStaticReport
```

**为什么 M1 之后必须重扫**：`check-map.logic.js:95-109` 在 `!hasRootMap` 时 early-return，只产出 M1 一条 issue——M2/M3/M4 在那份报告里**根本不存在**。不重扫的话，一个没有根地图的项目（比如本仓库）优化完只会生成一份根地图就结束，用户还得再点一次。

**为什么 M4 在 M3 之前**：M4 按 `line` 定位改写行内容，M3 追加在文件末尾。先改行、后追加，行号不漂移；反过来则要处理偏移。

## 五、M1 / M2：事实包 + 只读工具

### 5.1 工具权限（安全底线）

这是全篇最容易写错的一节，本仓库已经为它交过两次学费，两条教训方向相反、缺一不可：

**教训 A（`describe-skill.js:15-24`）：`allowedTools` 不是白名单。** 官方原文「This does not restrict Claude to only these tools」——它只是免确认列表，`allowedTools: ['Read']` 的实际效果是「全部工具可用，其中 Read 免确认」。

**教训 B（`llm-classify.js:125-129`）：列名黑名单补不全。** 2026-08-24 实测中，模型调 `ToolSearch` 把被禁的 `Read` 重新捞了出来。「SDK 每加一个新工具，黑名单就多一个洞」。

两条合起来意味着：**静态的工具名单，无论正列还是反列，都给不了「只读」保证**。唯一可靠的是运行时逐次裁决。

**教训 C（`run-claude.js:117-119`）：光传 `canUseTool` 也会被架空。** 用户全局 `settings.json` 把 `Bash`/`Edit`/`Write` 整体 `allow` 时，**allow 规则优先于 `canUseTool`，回调根本不会被调用，工具直接执行**。必须用 `PreToolUse` 钩子返回 `ask`，把裁决权夺回来——这是 SDK 官方推荐做法，`run-claude.js:120-134` 已有现成实现可照搬。

因此本功能的只读沙箱是**三层**，顺序不能少：

```js
// 第 1 层：夺回裁决权。没有它，下面两层在某些用户的 settings.json 下会被完全跳过
hooks: {
  PreToolUse: [{ hooks: [async () => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
  })] }],
},

// 第 2 层：运行时白名单。无论模型用什么手段把工具捞回来，执行前都要过这里
canUseTool: async (name) => (READONLY_TOOLS.has(name)
  ? { behavior: 'allow' }
  : { behavior: 'deny', message: '生成地图只允许读取，禁止任何写入或执行' }),

// 第 3 层：静态黑名单。挡不住 ToolSearch，但能减少模型的尝试次数、省 token 和轮次
disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash', 'BashOutput', 'KillShell',
                  'Task', 'WebFetch', 'WebSearch', 'SlashCommand'],
```

`READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'ToolSearch'])`——`ToolSearch` 放行是刻意的：它本身只返回工具的 schema 文本、不产生任何副作用，而模型被禁掉工具后的第一反应就是去搜；拦它只会白白吃掉轮次，真正的闸在第 2 层，它捞回 `Write` 也照样执行不了。

系统提示词里再加一句「你只能读，禁止写入任何文件」作为第 4 层软约束（照 `describe-skill.js:198-207` 的做法），目的是掐掉念头本身、省下无谓的轮次。

`permissionMode` 用 `'default'`——第 1 层钩子已经把所有工具都变成 `ask`，第 2 层回调会当场裁决，不会挂起等人。**不能用 `bypassPermissions`**：那会连同第 1、2 层一起绕过。

### 5.2 事实包（Node 确定性产出）

**它的作用不是省 token，而是保底**：模型偷懒只读两个文件就下结论时，事实包保证文件清单和命令这类硬事实至少是对的。

根地图事实包：
- 一级 + 二级目录树（复用 `scan-dirs.logic.js` 的 `shouldSkipDir`）
- `package.json` 的 name / description / scripts / 主要 deps
- 入口文件（main / bin / 常见 index）
- README 首 60 行
- 已存在的模块 `CLAUDE.md` 清单
- git 最近 20 条提交的 subject（看得出项目在往哪走）

模块地图事实包：
- 该模块完整文件树 + 每个文件的行数
- 每个文件顶部块注释首行（本仓库注释密度高，这一条信息量极大）
- 该模块的导出符号（正则抽 `export function|const|class`）
- 谁 import 了这个模块（全仓 grep）

### 5.3 输出与写盘

**模型只返回 markdown 文本，一律由 Node 写盘。** 这是 5.1 的直接推论（模型没有写工具），也换来备份、幂等、校验三件事都在 Node 侧可控。

复用 `runClassifierOnce` 的 JSON 提取约定，要求返回 `{"markdown":"..."}`。

### 5.4 质量闸（拒绝写半成品）

生成失败或产出不合格时**绝不写文件**，该条进 `blocked` 列表。理由同 mtime 陷阱：写一份糊弄的模块地图，M2 不再报缺失、分数上涨，而地图内容是错的——比没有地图更糟，因为它会误导后续所有会话。

不合格判定：
- 返回空 / 无 `markdown` 字段
- 正文短于 200 字符
- 根地图未包含「命令」与「模块」相关小节（正则松匹配）
- 根地图超过 200 行（对齐 M5 阈值，超了就是刚生成就带病）

### 5.5 模型与超时

- 模型：跟随会话默认（`null`），理由同 `describe-skill.js:29-37`——这是写作任务且产出会长期留在用户仓库。
- 超时：`describe-skill` 单轮无工具实测长尾已到 127s（那份注释记录得很详细），地图生成是**多轮 + 工具调用**，起步定 **600s**，实现阶段按真实项目校准后回填注释。
- `maxTurns`: 30（够探索，也兜住失控）。

## 六、M3：只追加不覆盖

在过期地图末尾追加：

```markdown
<!-- checkup:stale-audit -->
## ⚠️ 自动核对（2026-08-27）

代码比本地图新 23 天。以下条目与当前代码不符，**地图正文尚未更新**：

- `src/foo/bar.js` 已不存在（可能改名或删除）
- 「关键流程」一节描述的 3 步流程，代码里现在是 5 步
- 新增了 `src/foo/baz.js`，地图未收录
```

**幂等**：用 `<!-- checkup:stale-audit -->` 作锚点，已存在就整块替换，不无限追加。

人写的内容一字不动——模块地图里的踩坑记录和口径约定恰恰是模型从代码里看不出来的，这类内容一旦被重写就永久丢失，而备份要用户主动去翻才发现。

## 七、M4：确定性死链修复

无 LLM。算法：

1. 复用 `buildPathIndex(projectDir)` 拿全仓索引；
2. 对每条死链的 `ref`，取 basename，在索引中找同名条目；
3. **唯一命中** → 改写；**零命中或多命中** → 进手工待办，不动；
4. 改写前校验：报告给的 `line` 那一行确实含有 `` `ref` `` 字面量。行内容对不上就跳过（体检与优化之间文件可能被改过）。

**零命中不动这一条正好化解已知误报**：`check-map.logic.js:55-57` 记录了 OSS/CDN 资源引用（`static/font-webp/icon-star-white.webp`）无法与本地路径区分，会被误判成死链。这类引用在仓库里找不到同名文件 → 零命中 → 不动。误报天然被过滤掉。

**绝不自动删除引用**：删引用是信息净损失，且机器判不出该删还是该改。

## 八、编排层改造

现有 `optimize-ops.js` 把 rules 写死在两处：`startFix` 的 `selectFixableRules`（`:303`）、`runFix` 的 `demoteOne` 循环（`:370`）。需要抽象成统一任务模型：

```js
task = {
  dim: 'rules' | 'map',
  kind: 'demote' | 'gen-root-map' | 'gen-module-map' | 'stale-audit' | 'fix-dead-link',
  path: '相对路径',              // 备份 entries 用
  action: 'created' | 'modified' | 'deleted',
  payload: { /* kind 特有 */ },
}
```

`fix-plan.logic.js` 的 `SUPPORTED_DIMENSIONS` 加上 `'map'`；`selectFixableRules` 保持不动（它的语义就是 rules 专用），另加 `selectFixableMap(report)`，上层合并。

`buildFixNotes` 需要相应扩展——`:75` 那句「本次只处理了 rules 降级」的硬编码文案要改成按实际处理的维度生成。

## 九、并发与中断

用户选了「全量生成」，代价是 10+ 模块串行可能 10-20 分钟。必须补偿：

- **受限并发 3**。不能更高：`describe-skill.js:44-50` 实测记录，连续调用赶上限流排队时长尾达单跑的 4 倍，并发拉高只会加剧。
- **可中断**：`AbortController` 贯穿到 `runClaude`（它已支持 `abortController`），新增 `POST /api/optimize/fix/:id/cancel`。中断后照常走 `recordPostState`——已落盘的部分仍可还原。
- **逐任务 SSE 进度**：沿用现有 `pushEvent(job, 'file', r)`，让用户看到「第 3/12 个模块」而不是干等。

## 十、验收

`docs/superpowers/plans/2026-08-26-project-optimize-handoff.md` 的「坑 5」写得很清楚：**单测只能证明代码符合我的预期，证明不了我的预期符合现实**，检测规则必须跨样本验证。同一条纪律适用于生成：

| 样本 | 验的是什么 |
|---|---|
| `claude-p-web-demo`（本仓库，map=0） | M1 全链路：生成根地图 → 重扫 → 发现 M2 → 全量生成模块地图 |
| `kxmall-app-ui` | M3/M4：真实项目里的过期地图和死链（已知有 2 条死链，1 真 1 假） |
| `tests/fixtures/projects/no-map` | M1 单点 |
| `tests/fixtures/projects/kxmall-like` | M4 死链的唯一/多/零命中三种分支 |

生成质量**必须人工读一遍**，不能只看「文件生成了、分数涨了」——这正是 mtime 陷阱和质量闸两节反复强调的同一件事。

## 十一、明确不做

- M5 根地图拆分（保持 `fixable: false`）
- 重写已有地图正文（M3 只追加）
- 自动删除死链引用
- 让模型直接写文件
