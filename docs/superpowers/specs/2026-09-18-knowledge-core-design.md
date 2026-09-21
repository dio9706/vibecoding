# knowledge 内核 设计（子项目 1）

> 五个子项目中的第一个。本文只设计内核与记忆库接入，其余八类知识的迁移各自出 spec。

## 背景

本项目有九类功能会产出「工程知识」，各自为政：

| 产物 | 生产者 | 落点 | 归属粒度 | 生效方式 |
|---|---|---|---|---|
| 记忆条目 | memory-bank | `~/.claude/memory-bank.md` | 全局（项目级是死代码） | `@` 引用注入 |
| 项目地图 | project-optimize/gen-map | `<工程>/CLAUDE.md`、`<工程>/src/*/CLAUDE.md` | 项目 / 模块 | 直接写 CLAUDE.md 正文 |
| 避坑清单 | req-pitfalls | `<工程>/.claude/pitfalls.md` | 项目 | `@` 引用注入 |
| 优化整改清单 | project-optimize/advisory | `<工程>/.claude/optimize/PLAN.md` + `<维度>.md` | 项目 | 只给人看 |
| 体检豁免 | project-checkup/ignore | `checkup-ignores.json` + `.claude/optimize/IGNORED.md` | 项目 | 回喂检测器召回 |
| UI 规范 | req-uispec | `APP_DATA_DIR/ui-specs/<slug>.md` | 项目 | 喂 `buildRestorePrompt` |
| 需求地图 | req-map | `APP_DATA_DIR/requirements/<id>/map-v<n>.json` | 需求 | 喂需求 prompt |
| 功能账本 | feature-index | `feature-index.json` | 功能标签 | 喂 `buildSeedPrompt` |
| 评审判例 | review-log | `review-log.jsonl` | 项目 | 喂评审 prompt |

### 分离处理已造成的四个实际缺陷

1. **注入逻辑重复实现两遍。** `shared/claude-md.js` 的 `ensureImport` 与 `req-pitfalls.js:126` 的 `ensureClaudeMdRef` 做同一件事。`src/shared/CLAUDE.md:72` 明文规定该用前者——规矩写了没人遵守，因为没有强制的统一入口。

2. **两种相反的 CLAUDE.md 写入策略并存。** 项目地图整份覆写正文（`fix-map.js:178`，已存在则跳过），记忆库与避坑清单追加 `@` 引用行。两套逻辑操作同一文件，互不知情。

3. **归属粒度五种，各实现一遍。** 全局 / 项目 / 模块 / 需求 / 功能标签，每套自己实现「这条属于谁」的判定与路径计算。

4. **CLAUDE.md 总预算无人统管——最痛的一条。** 只有记忆库有 `maxItems`/`maxChars`，且只管自己。地图、避坑清单往 CLAUDE.md 塞时不计预算。三家共写一个文件，总量无人负责。

### 实测佐证

2026-09-18 生产库 56 条 memories，其中约 37 条是项目专属技术细节（mp-weixin、小程序分包、Skyline、Figma、腾讯地图、uni-app）。本次会话期间 `~/.claude/memory-bank.md` 被重写为 41 条，28 条是某小程序项目的知识——而当时正在 Principal（Node + 原生 JS）里工作。**全局池被单个项目的知识淹没，是分域缺失的直接后果。**

**提炼门槛上线后的实测（同日，371 会话 / 1599 findings 跑一批）：** 产出 21 条 / 1390 字符，业界通识条目从约 4 条降到 0 条，`explicit` 判定生效（15 explicit / 6 inferred，weight 分 1 与 3 两档）。但两类问题门槛解决不了，正是本内核要承担的：

- **归属错位仍在。** 产出里有「产品命名应作为隐喻系统的种子…例：Hire→招聘新终端」「设计美学…参考案例：bloub 吉祥物」——有价值但只属于特定工程，全局注入是噪声。门槛能砍掉「没价值的」，砍不掉「有价值但不属于这里的」，那是 `scope` 的活。
- **自相矛盾的条目。** 见下文「矛盾检测与裁决」。

**待观察项：** 21 条里 15 条判为 `explicit=true`，比例偏高（如「设计美学追求极简主义」标成用户明说的规矩略勉强）。若后续几批仍然偏高，需收紧 prompt 里 explicit 的判据——它直接决定注入排序，判宽了等于没有优先级。

## 目标与非目标

**目标**
- 一套数据模型容纳九类知识的归属、生命周期、用户控制
- 一个注入编排层统管 CLAUDE.md 预算，收口 `ensureImport`
- 加一类知识 = 注册表加一条 + 写一个渲染器，内核不动
- 记忆库作为首个使用者完成接入

**非目标（本子项目不做）**
- 其余八类的迁移（子项目 2~4）
- 统一面板（子项目 5）
- 提炼质量改进（独立进行，见「与既有计划的关系」）

## 已拍板决策

| 决策 | 结论 | 理由 |
|---|---|---|
| 系统边界 | 九类全收 | 用户拍板 |
| 统一程度 | 存储 + 生效全统一 | 用户拍板 |
| 注入层级 | `global` + `project` 入 CLAUDE.md；`module` 靠 Claude Code 原生按需加载；`requirement`/`feature` 只喂特定 prompt | 模块级 CLAUDE.md 是读到该目录文件时才加载的，零预算成本，不该拉进来争 |
| 落盘形态 | 按类型分文件 + CLAUDE.md 多行 `@` 引用 | 手写正文永不被改；地图改动不牵连避坑清单；每类可单独开关 |
| 存储形态 | 索引表 + 内容分片 | 见下 |

### 为什么是索引表 + 内容分片

`store/index.js` 的 `updateJson` 是整份读改写 + 文件锁。项目地图几千字、UI 规范几千字、需求地图是结构化图——混进同一张表后，改一条记忆也要序列化整份地图。`memory-bank.json` 现已 728KB 是这个病的前兆，`src/store/CLAUDE.md` 里「日志族不走整份读改写，会越写越慢」正是本项目踩过的同一个坑。

索引表只存元数据与短正文，注入编排只读索引就能算出预算分配，真要渲染时才按 `contentRef` 读大正文。

## 数据模型

### 索引条目（`knowledge.json`）

```js
{
  version: 1,
  items: [{
    id: 'kn_<ts>_<rand>',
    kind: 'memory',                        // KIND_REGISTRY 的键
    scope: { level: 'global', key: '' },
    delivery: 'claude-md',                 // claude-md | prompt | detector | human

    // 正文二选一，由 kind 注册表的 storage 字段声明该用哪种
    inline: '大改前先问我',                 // storage==='inline' 时有值
    contentRef: null,                      // storage==='file' 时为 'knowledge/kn_xxx.md'

    lifecycle: {
      createdAt, updatedAt, lastSeenAt,
      status: 'active',                    // active | dormant | archived | conflicted
      producer: 'memory-bank',
      conflictWith: null,                  // status==='conflicted' 时指向对立条目的 id
    },
    control: {
      inject: true,                        // 用户开关：false 则不注入，条目保留
      pinned: false,                       // 钉住：不受预算截断
      weight: 1,                           // 排序权重（证据强度）
      explicit: false,                     // 用户明说的规矩，优先级压过推断
    },
    meta: { category: 'collaboration' },   // kind 私有区，store 不解释
  }]
}
```

**`scope.key` 的语义按 `level` 定：**

| level | key | 例 |
|---|---|---|
| `global` | 空串 | `''` |
| `project` | 工程绝对路径 | `C:\Users\DELL\Desktop\demo` |
| `module` | `<工程>#<相对目录>` | `C:\...\demo#src/features` |
| `requirement` | 需求 id | `req_123` |
| `feature` | 功能标签 | `宝宝辅食` |

五种归属粒度装进一个字段，不为每种粒度加列。

**`meta` 是 kind 私有区。** 记忆条目的 `category`、体检豁免的 `(dim, code, file)` 三元组、需求地图的版本号形状差太远，提到顶层会让条目结构被九类的并集撑爆。store 不解释 `meta`，只有对应 kind 的渲染器懂它。

**`control` 聚合用户可改项。** 统一面板只操作这一个子对象，不必知道每类知识的内部结构。

### 内容分片

`storage: 'file'` 的条目，正文落 `APP_DATA_DIR/knowledge/<id>.md`（或 `.json`）。

- 删条目时连带删文件
- `contentRef` 指向的文件不存在时，条目降级为「内容缺失」而非崩溃——渲染时跳过并记 `logger.warn`
- 提供 `pruneOrphans()`：删除无索引引用的内容文件，由手动触发（不做定时，误删的代价远大于占几 KB 磁盘）

## kind 注册表

照搬 `project-checkup/dimensions/registry.js` 的模式：一份声明派生渲染、落点、预算归属、面板展示。

```js
// src/features/knowledge/kinds/registry.js
export const KIND_REGISTRY = {
  memory: {
    id: 'memory',
    label: '记忆条目',
    producer: 'memory-bank',
    storage: 'inline',                            // inline | file
    delivery: 'claude-md',
    defaultScope: 'global',
    globalTarget: 'memory-bank.md',               // ~/.claude/ 下的文件名
    projectTarget: '.claude/knowledge/memory.md', // <工程>/ 下的相对路径
    budgetWeight: 1,
    render: renderMemory,                         // (items) => string
  },
};
```

**全局文件名保持 `memory-bank.md` 不变。** 用户的 `~/.claude/CLAUDE.md` 已含 `@memory-bank.md`，改名会让引用静默断掉。

**验收判据：** 子项目 2~4 接入其余八类时，若发现需要改 `inject.js` / `budget.logic.js`，说明抽象错了。接一类知识应当只需：注册表加一条 + 写一个渲染器 + 生产者改调 knowledge API。

## 注入编排与预算

### 两个预算池

```js
const BUDGETS = {
  global:  { maxChars: 3000, maxItems: 40 },   // ~/.claude/ 下所有 knowledge 文件合计
  project: { maxChars: 6000, maxItems: 80 },   // 单个工程 .claude/knowledge/ 下合计
};
```

全局更紧：全局的每个字符要在**所有项目的所有会话**里付费，工程级只在那一个工程付费。

预算可在 `settings.knowledge` 覆盖，沿用 `settings.memoryBank` 的归一模式（`DEFAULTS` + `normalizeSettings` 透传）。

### 分配策略（`budget.logic.js`，纯函数）

```
allocate(items, budget) →
  1. pinned 条目先占位，不受截断
  2. 剩余额度按各 kind 的 budgetWeight 分摊
  3. 某 kind 未用完的份额让渡给其它 kind
  4. kind 内部排序：explicit 降序 → weight 降序 → lastSeenAt 降序
  5. 逐条累加字符数，超出即停
→ { included: Map<kind, items[]>, truncated: Map<kind, number> }
```

**第 3 条（份额让渡）是必要的**：一个工程还没生成地图时，硬性按权重切会让那份额度白白浪费。

**`truncated` 必须如实返回并向上暴露。** 静默丢弃会让用户以为规则生效了、实际没有——这是最难排查的一类问题（现有 `render.js` 头注释已记录同一条铁律）。

### 落盘（`inject.js`，IO）

```js
planInjection(items, { projectDir, budgets })   // 纯函数，在 inject.logic.js
// → [{ targetPath, importLine, claudeMdPath, text, included, truncated }]

applyInjection(plans)                            // IO：写盘 + ensureImport
```

两条从现有 `writeRenders` 继承的铁律：

1. **渲染结果为空串也必须写盘。** 用户关掉最后一条后渲染变空，跳过写盘会让磁盘旧内容继续被 `@` 引用，被否掉的规则在此后每轮对话里静默注入且用户无感知。
2. **`ensureImport` 只在有内容时调用。** 没有任何条目时不必去动用户的 CLAUDE.md 加引用行。

**`ensureImport` 收口：全项目只有 `knowledge/inject.js` 能调 `shared/claude-md.js`。** 子项目 2 迁移避坑清单时，`req-pitfalls.js` 的 `ensureClaudeMdRef` 随之删除。

## 矛盾检测与裁决

### 为什么必须有

2026-09-18 用新 prompt 实跑一批（371 会话 / 1599 findings），21 条产出里出现一对直接打架的条目：

> 「默认使用 Claude Opus 5 作为基础模型」
> 「用户倾向于使用 deepseek 模型而非 Claude」

两条都会被注入，模型看到互斥指令。**根因是 v2 迁移时丢了 v1 的冲突机制**——`promote.js` 有 `conflict` 状态与裁决流程（「不覆盖，两边停注入交用户裁决」），v2 的平坦 `memories` 数组没有对应物。

提炼门槛管不了这个：它判的是单条质量，判不了两条之间的关系。这个缺口必须在内核层补，否则每接入一类知识就多一类可能自相矛盾的内容。

### 检测：搭合成调用的便车

`existingStatements` 已经随 prompt 下发（供模型自行去重），让模型顺手判矛盾**不增加任何额外调用**：

```
输出格式增加可选字段：
  "contradicts": "<与之矛盾的已有条目 statement 前 40 字>"

判据（写进 prompt）：
  矛盾 = 两条不可能同时成立（「用 A 工具」vs「不要用 A 工具」）。
  互补、细化、适用场景不同的，不算矛盾。
  拿不准就不填 —— 误报会把两条正常条目一起冻结，代价比漏报大。
```

生产者侧按前缀匹配回 `existingStatements` 对应的条目 id。匹配不上（模型改写了措辞）则丢弃该标记并 `logger.warn`——**宁可漏报**：凭模糊匹配冻结错误的条目，用户完全无从察觉。

### 裁决：两边冻结，不自动选

检测到矛盾时：

1. 新条目与被指的旧条目**双双转 `status: 'conflicted'`**，互填 `lifecycle.conflictWith`
2. `budget.logic` 的 allocate **跳过所有 `conflicted` 条目**——两边都不注入
3. 等用户裁决

**不自动选一个。** 模型判不出哪个对：上例里 deepseek 那条可能来自某次临时测试的对话，Opus 5 那条可能是常态，但也可能反过来。v1 的注释已经定过这个调子，此处沿用。

代价是矛盾未裁决期间两条都不生效——这是刻意的：注入一条可能错的规则，比暂时少注入一条危害大。

### 子项目 1 提供的接口

```
GET  /api/knowledge/conflicts            → 待裁决的冲突对列表
POST /api/knowledge/:id/resolve-conflict → { keep: 'this' | 'other' | 'both' }
```

`keep: 'both'` 用于误报：两条都恢复 `active` 并互清 `conflictWith`。面板留到子项目 5，本子项目只提供接口。

### 已知缺口

**存量条目之间的矛盾检测不了。** 迁移是纯数据搬运、不调 LLM，无从判断存量 56 条里是否已有互斥的。它们会以 `active` 状态进入新系统。修正路径同 scope 缺口：后续重新提炼时，新条目与存量比对会触发检测。此缺口不在子项目 1 内解决。

## 记忆库接入

### 迁移边界

**迁移：** `memory-bank.json` 的 `memories[]` → knowledge items（`kind: 'memory'`）。

**不迁移：** `sessions[]` 留在 `memory-bank.json`。它是提炼流水线的中间状态（哪些会话分析过、findings、游标），不是知识。这条边界不划死，knowledge store 会变成什么都装的垃圾桶。

### 字段映射

| memory 字段 | knowledge 字段 |
|---|---|
| `id` | `id`（保留原值，不重新生成——便于出问题时对账） |
| `statement` | `inline` |
| `category` | `meta.category` |
| `reasoning` | `meta.reasoning` |
| `createdAt` | `lifecycle.createdAt` / `lifecycle.lastSeenAt` |
| `source: 'synthesized'` | `lifecycle.producer: 'memory-bank'` |
| （无） | `kind: 'memory'`、`delivery: 'claude-md'` |

阶段 A（见「与既有计划的关系」）执行后产出的条目会多带几个字段，迁移脚本必须同时认这两代形状：

| 阶段 A 产出的字段 | knowledge 字段 | 缺失时的兜底 |
|---|---|---|
| `explicit` | `control.explicit` | `false` |
| `evidenceCount` | `control.weight` | `1` |
| `inject` | `control.inject` | `true` |
| `status` | `lifecycle.status` | `'active'` |
| `lastSeenAt` | `lifecycle.lastSeenAt` | 回落 `createdAt` |
| `scope: 'global'\|'project'` + `projectDir` | `scope: { level, key }` | `{ level: 'global', key: '' }` |

`scope` 的两代形状差异要注意：阶段 A 写的是扁平的 `scope: 'project'` + `projectDir: '<路径>'`，knowledge 用的是 `{ level: 'project', key: '<路径>' }`。迁移时按 `projectDir` 填 `key`；`scope === 'global'` 时 `key` 必须是空串而非 `projectDir` 的残值。

### 存量 scope 的已知缺口

存量 56 条没有来源工程信息（`memories` 未关联回 `sessions`），迁移时**一律标 `scope: { level: 'global', key: '' }`**，行为与迁移前一致。

这意味着那约 37 条项目专属知识仍会污染全局池。两条修正路径：

1. 子项目 1 提供 `PATCH /api/knowledge/:id/scope` 批量改归属（面板留到子项目 5）
2. 记忆库后续重新提炼时带上 scope 判定，新条目自然归位

此缺口在 spec 中显式记录，不在子项目 1 内解决。

### 迁移执行

一次性脚本，幂等，带备份——照搬 `store/memory-bank.js` 的 `migrateV1IfNeeded` 做法：

1. 读 `memory-bank.json`，若 `memories` 为空或已标记 `_migratedToKnowledge` 则跳过
2. 备份 `memory-bank.pre-knowledge.bak.json`
3. 逐条转换写入 `knowledge.json`
4. 在 `memory-bank.json` 打 `_migratedToKnowledge: true`，**保留 `memories` 原数组不删**（回退余地；子项目 5 确认稳定后再清理）

## 文件结构

遵循本目录的 `X.js`（IO）+ `X.logic.js`（纯函数，带 `*.test.js`）铁律。

```
src/store/knowledge.js            # 索引 CRUD + 内容分片读写（经 index.js 的 updateJson）
src/store/knowledge.test.js

src/features/knowledge/
  index.js                        # 唯一 IO 编排点：upsert / remove / renderAndInject
  schema.logic.js                 # 条目归一化与校验（纯）
  scope.logic.js                  # selectForContext / scope 匹配（纯）
  budget.logic.js                 # allocate 分配与截断（纯）
  inject.js                       # 落盘 + ensureImport（IO）
  inject.logic.js                 # planInjection（纯）
  kinds/registry.js               # kind 声明
  kinds/memory.js                 # memory 渲染器
  migrate-memory-bank.js          # 一次性迁移
```

分层依赖：`features/knowledge → store/knowledge → store/index → shared`。`features/memory-bank` 改为调 `features/knowledge` 的 API，不再自己渲染落盘——`memory-bank/render.js` 与 `writeRenders` 随之退役。

## 错误处理

沿用本项目已验证的姿态：

- **渲染 / 落盘失败不抛异常**，返回 `{ status, reason }`。上层是循环，一次抛错会把整批停在半路（`project-optimize` 的同一条铁律）。
- **索引损坏**走 store 基座既有机制：`parseFileOrThrow` 备份 `.corrupt.bak` 并拒绝写盘。
- **内容分片丢失**：`contentRef` 文件不存在时跳过该条并 `logger.warn`，不影响其余条目渲染。
- **`ensureImport` 失败**（CLAUDE.md 只读等）：记 `logger.error` 但不回滚已写的 knowledge 文件——文件在盘上比引用行更重要，用户可手动加引用。

## 测试

| 层 | 测什么 | 方式 |
|---|---|---|
| `schema.logic.js` | 归一化补全、非法值回落、向后兼容（缺字段的存量条目） | `node:test` 纯函数 |
| `scope.logic.js` | 五种 level 的匹配、`selectForContext` 只出 global+project | `node:test` 纯函数 |
| `budget.logic.js` | pinned 优先、权重分摊、份额让渡、`truncated` 计数准确、**`conflicted` 条目被跳过** | `node:test` 纯函数 |
| 矛盾裁决 | 双双转 `conflicted` 并互填 `conflictWith`；`keep: this/other/both` 三种裁决；前缀匹配不上时丢弃标记不冻结 | `node:test` 纯函数 + store 隔离 |
| `inject.logic.js` | 空内容也产出写盘计划、多 kind 合并到同一 target | `node:test` 纯函数 |
| `store/knowledge.js` | CRUD 幂等、内容分片读写、孤儿清理 | `APP_DATA_DIR` 隔离到临时目录 |
| `migrate-memory-bank.js` | 幂等、备份生成、字段映射完整 | `APP_DATA_DIR` 隔离 |
| 端到端 | 建条目 → 渲染 → 落盘 → CLAUDE.md 含引用行 | `APP_DATA_DIR` + 临时 HOME |

**测试必须隔离 `APP_DATA_DIR`。** dev 态数据目录就是仓库根，不隔离会污染真实 `knowledge.json` 与用户的 `~/.claude/`。

## 与既有计划的关系

`docs/superpowers/plans/2026-09-18-memory-bank-usability.md` 的处置：

- **阶段 A（Task 1-3）照常执行，但两部分去向不同：**
  - **Task 1-2（提炼门槛、`explicit`/`strength` 字段）是纯增益。** 它们改的是 `synthesize.js`——合成器在本重构后依然存在（它是 knowledge 的生产者之一，只是改为调 knowledge API 写入而非自己 `addMemory`）。越早做越好：决定了往新系统里灌的是干净数据还是噪声。
  - **Task 3（`render.js` 的 `normalizeMem` 排序修复）是过渡性的。** `render.js` 在本重构后退役，其排序规则（explicit 压过 inferred、weight × 时效衰减）**搬进 `budget.logic.js` 的 allocate 第 4 步**，不是丢弃。仍建议先做：它让阶段 A 的效果当场可验证，否则 Task 1-2 产出的 `explicit` 字段要等整个内核建成才看得出作用，中间失去了一次校准 prompt 的机会。
- **阶段 B / C / D 作废，并入本设计。** 分域注入 → `scope` 模型；注入预览与 inject 开关 → `budget.logic` + `control.inject`；淘汰机制 → `lifecycle.status`。只给记忆库做一遍、两周后再为地图和避坑清单做第二遍是纯浪费。

## 后续子项目

| 子项目 | 内容 | 依赖 |
|---|---|---|
| 2 · CLAUDE.md 注入类 | 项目地图、避坑清单 | 1 |
| 3 · prompt 喂料类 | UI 规范、需求地图、评审判例、功能账本 | 1 |
| 4 · 非注入类 | 优化整改清单、体检豁免 | 1 |
| 5 · 统一面板 | 一个入口看全部、改归属、开关注入 | 1-4 |
