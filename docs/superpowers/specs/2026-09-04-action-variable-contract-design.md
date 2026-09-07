# 动作变量抽取契约 — 设计规范

> **日期**：2026-09-04
> **状态**：**已实施**（2026-09-04）。测试基线 2236 → 2351 passed / 0 failed。
> 实施中相对本文的两处收紧：① `junk` 移出 `CONTRACT_KEYS`，只能来自 preset（用户可写任意正则
> 等于开了「保存一条坏配置就让抽取抛异常」的口子）；② 前端纯逻辑抽到
> `public/js/actions-panel.logic.js`（`actions-panel.js` 顶层有 DOM 副作用，无法单测）。
> **前置**：本次快修批次（超时 10s→25s、`ENV_SCAN_RE` 补词、`shared/roles.js`、welcome 文案合并、抽取竞态窗口）已落工作区

---

## 1. 背景与目标

### 1.1 现状的硬伤

槽位抽取按**变量名**硬编码，共三处：

| 位置 | 代码 | 后果 |
|---|---|---|
| `slot-filler.js:103` | `const NORMALIZERS = { env: normalizeEnv }` | 变量不叫 `env` 就没有归一 |
| `slot-filler.js:211` | `regexExtract` 里写死 `phone` / `env` | 变量不叫这两个名字就没有本地兜底 |
| `slot-filler.js:186` | `const hasEnv = variables.some((v) => v.name === 'env')` | 变量不叫 `env`，LLM 提示词里就不给候选值与归一要求 |

新增一个动作、变量叫 `region` / `订单号` / `environment`，这三处**一处都不生效**：抽不到、归一不了、模型也不知道合法值是什么。用户加脚本时无从察觉，只会表现为「机器人老是追问」。

### 1.2 顺带解决的延迟问题

生产实测（`app-2026-09-04.log`）：每次槽位抽取要 spawn 一个 Claude Code 子进程，`init` 单独就要 **2.7~3.7s**，整体 **8~17s**。而现有三个动作的**全部变量**是：

| 变量 | 值域 | 本该怎么抽 |
|---|---|---|
| `env` | 闭集 `dev`/`test`/`prod` | 查表 |
| `phone` | `1[3-9]\d{9}` | 正则 |

两者都不需要推理。把抽取规则下放到变量声明后，这类变量**本地确定性抽取，零 LLM**，主路径延迟从 8~17s 降到亚毫秒级。

### 1.3 目标

1. **抽取器不再认识任何变量名** —— 规则由变量自己声明。
2. **能本地抽的绝不调 LLM**；LLM 退居兜底位。
3. **向后兼容**：现有配置不改一个字，行为与今天一致。
4. **别名表收敛为一份**（今天 Node 侧与 `scripts/get_qrcode.py` 各存一份，已分叉）。

### 1.4 非目标

- 不改意图识别分层（L0~L4 结构不动）。
- 不合并「分类」与「抽取」两次 LLM 调用 —— 生产日志显示主路径是 L2 关键词单命中（09-04 五次交互全部 L2、L3 零次），合并只对罕见的 L3 路径有收益，性价比不足。
- 不引入新的 LLM provider 或调用通道。

---

## 2. 核心契约：变量声明

### 2.1 Schema

`ActionConfig.variables[]` 在现有五个字段之外新增四个**全部可选**的字段：

```jsonc
{
  // —— 现有字段，语义不变 ——
  "name": "region",              // 脚本参数名 --region
  "label": "机房",                // Web UI 显示名
  "prompt": "要操作哪个机房？",     // 缺失时的追问文案
  "required": true,
  "persistent": false,

  // —— 新增（均可选）——
  "preset": "env",               // 继承内置预置的 enum/aliases/pattern，见 §4
  "enum": ["sh", "bj", "sz"],    // 合法值白名单（规范值）
  "aliases": {                   // 别名 → 规范值。值必须落在 enum 内
    "上海": "sh", "沪": "sh",
    "北京": "bj", "深圳": "sz"
  },
  "weakAliases": {               // 歧义别名，仅在追问轮生效，见 §3.3
    "南方": "sz"
  },
  "pattern": "1[3-9]\\d{9}",     // 值本身的形状，**不带锚点**（与 enum 互斥）
  "example": "上海"               // 示例值，仅用于喂给 LLM 提示词
}
```

> **`pattern` 必须不带锚点** —— 它有两个派生用途，锚点会让其中一个失效：
> - **抽取**：`new RegExp(pattern, 'g')` 在自由文本里 `matchAll` 定位值。写成 `^1[3-9]\d{9}$` 则「帮我清一下 13800138000」一个都抽不到。
> - **校验**：`new RegExp('^(?:' + pattern + ')$')` 由代码自动加锚点后全串匹配。
>
> 保存时校验：`pattern` 以 `^` 开头或以 `$` 结尾 → 返回 422 并提示「请去掉锚点，系统会自动添加」。这比默默 strip 掉好：strip 会在 `a$|b` 这种中间带 `$` 的正则上悄悄改变语义。

**字段约束**

- `enum` 与 `pattern` **互斥**（一个是闭集，一个是开集）。同时声明 → 配置校验失败，拒绝保存。
- `aliases` / `weakAliases` 的**值**必须是 `enum` 的成员；不在 enum 内的映射在保存时被拒绝（否则会归一出脚本不认识的值）。
- `enum` 成员自身天然是自己的别名，无需在 `aliases` 里重复声明。
- 四个字段全缺省 = **自由文本变量**，行为与今天完全一致（走 LLM）。

### 2.2 为什么 `aliases` 是「别名 → 规范值」而不是反过来

- 抽取时是 O(1) 查表，反向结构要先展开。
- 与现有 `ENV_ALIASES` 的形状一致，迁移是平移而非重写。
- Web 表单渲染时可以按规范值分组显示，不影响存储形状。

---

## 3. 抽取管线

### 3.1 三档分派（抽取器只读声明，永不读 `v.name`）

```
对每个必填变量，按声明选择抽取方式：

  有 enum（含 preset 展开后）  →  ① 词表扫描 + 归一        零成本
  有 pattern                  →  ② 正则抽取               零成本
  两者都无                     →  ③ 标记为「需 LLM」        延后
```

**关键控制流**：先把 ①② 全部跑完，只有当**仍有必填变量落在 ③ 或 ①② 弃权**时，才发起一次 LLM 调用；且该次调用的提示词里**只列剩余字段**，已本地填好的不参与。

```
extractVars(actionConfig, text, userId, opts)
  ├─ 1. 持久化变量（persistent=true）从 user-vars 取回        —— 不变
  ├─ 2. localExtract(variables, text)  ← 纯函数，零 IO
  │      对每个变量按 §3.1 分派，返回 { values, unresolved[] }
  ├─ 3. unresolved 为空 → 直接返回（零 LLM）★ 主路径
  ├─ 4. unresolved 非空 → llmExtract(unresolved, text)
  │      提示词由 buildExtractPrompt(unresolved) 自动生成，见 §5
  └─ 5. normalizeAll(variables, merged) 统一归一 + 校验
         归一失败/不在 enum 内的键**删除**（按缺失处理，走追问）—— 现有语义保留
```

### 3.2 扫描正则的生成与护栏

从 `enum ∪ aliases.keys()` 自动编译扫描正则。**四条硬性规则**（前两条是正确性，后两条是安全）：

1. **长词优先**：候选按字符长度降序排列，避免 `dev` 抢先命中把 `development` 截成 `dev` + `elopment`。
2. **边界按字符集区分**：纯 ASCII 候选加 `\b`（`\bdev\b`），含 CJK 的候选不加（中文无词边界，加了反而匹配不上）。
3. **正则转义**：候选一律 `escapeRegExp`，用户可能在别名里写 `+` `(` `.`。
4. **灾难性回溯护栏（勿删）**：本项目已有前科 —— `intent.js` 的 `CHITCHAT_RE` 因「一个候选能由其他候选拼出」触发斐波那契级回溯，实测 `'bye'.repeat(44)` 要 87 秒，占死整个事件循环（WS 心跳、去重、所有会话全停，abort 与 timeout 都救不了，它们也要事件循环）。故：
   - 生成的正则**不带外层 `+`/`*` 量词**（只做单次 `matchAll`，不做重复组合匹配）；
   - 候选**去重**后再拼；
   - 编译时校验：若任一候选可由其余候选拼接得到，记 `logger.warn` 并保留（不带量词时不会爆炸，但仍是配置异味）；
   - 输入长度上限护栏沿用现有做法。

### 3.3 保守弃权策略（泛化现有的两条，事故换来的，不得放宽）

现有 `scanEnv` 有两条弃权规则，泛化到**所有 enum 变量**：

| 规则 | 场景 | 处置 |
|---|---|---|
| 多值冲突 | 一句话扫出两个不同规范值（「别清 test，清 dev」） | 弃权 → 该字段判缺失 |
| 否定词修饰 | 值所在**分句**内出现 `别/不要/不是/不用/无需/除了/而不是` | 弃权 → 该字段判缺失 |

弃权 ≠ 失败：弃权的字段进 `unresolved`，交给 LLM（模型能读懂「别…要…」）；LLM 也拿不准就追问。

> **判据**：猜错的代价是清错环境 / 退错款（不可逆），多问一句的代价是一轮对话。不对称，永远选后者。

**`weakAliases` 的存在理由**：裸词「测试」「开发」在自由文本里几乎都是动词（「帮我测试一下这个功能」「开发那边说…」），收进主 `aliases` 会把无关消息误判成带环境。但在**追问轮**（`forVar` 已指明在等哪个字段）整条消息就是对该字段的回答，此时「测试」两个字必须认。故：

- `aliases` —— 自由文本 + 追问轮都生效
- `weakAliases` —— **仅**追问轮生效

### 3.4 抽不到时的行为

与今天一致：`pickMissingVars` 找出缺失项 → 写 `pendingState` 追问第一个 → `hasPending` 劫持该用户下一条消息。快修批次新增的「占位提前 + inbox 抢答并入 + 抽取期间被取消则放弃执行」全部保留。

---

## 4. preset：内置预置，可被覆盖

### 4.1 动机与取舍

纯配置最可插拔，但你三个动作要手抄三遍同一份 env 别名表，加第四个再抄一遍 —— 迟早分叉（Node 侧与 `get_qrcode.py` 今天就已经是两份）。内置类型系统省事，但「新类型必须改代码」是死结。

**取舍**：`preset` 只是一份**预置默认值**，写在变量里的字段永远赢。不用 preset 就手写 `enum`/`aliases`，效果完全等价 —— 没有任何能力只能通过 preset 获得。

### 4.2 合并语义

```
effective = { ...PRESETS[v.preset], ...pick(v, ['enum','aliases','weakAliases','pattern','example']) }
```

- 变量显式声明的字段整体覆盖同名 preset 字段（**不是深合并** —— 深合并会让「我想删掉某个别名」无法表达）。
- 要在 preset 基础上**追加**别名：把 preset 的别名连同新增的一起写进 `aliases`。Web 表单提供「展开 preset 为可编辑内容」按钮降低这个成本。
- `preset` 名未知 → 配置校验失败，拒绝保存（静默忽略会让用户以为生效了）。

### 4.3 内置 preset 清单（首版只做两个，YAGNI）

| preset | 形态 | 内容 |
|---|---|---|
| `env` | enum | `["dev","test","prod"]` + 现有 `ENV_ALIASES` 全量中英别名；`weakAliases`: 裸词「开发/测试/正式/线上/生产/体验」 |
| `phone` | pattern | `^1[3-9]\d{9}$` |

`date` / `url` / `email` 等**不做** —— 现无使用场景，等真有需求再加。

---

## 5. LLM 兜底：提示词由声明自动生成

替换 `tryClaudeExtract` 里写死的 `hasEnv` 分支。新函数 `buildExtractPrompt(unresolved, text)` 为每个待抽字段拼出约束段：

```
从用户消息提取变量，仅输出一行 JSON。

- region（机房）：只能取 sh / bj / sz 之一。
  用户说法需归一：上海·沪 → sh；北京 → bj；深圳 → sz
  示例：上海
- reason（退款原因）：自由文本，原样提取。

用户没提到、或说的是列表外的值时，**省略该字段，不要猜**。
用户消息：「…」
输出：{"变量名":"值"}，找不到的字段省略。
```

要点：

- **只列 `unresolved`**，已本地抽好的字段不出现在提示词里（省 token，也避免模型改写已确定的值）。
- enum 变量把合法值与别名映射一并给出 —— 这正是今天只有 `env` 才享受到的待遇。
- `example` 若声明则附上。
- 「不要猜」的指令保留（现有提示词已有，是正确的）。
- `model` 仍为 `claude-haiku-4-5`（已是最低档）。

### 5.1 `effort: 'low'` —— 在 `llm-classify` 层设默认，可逐点覆盖

**已拍板：本版一起做。**

`runClaude` 第 149 行早已透传 `effort`，而 `llm-classify.js` 从未设置过它 —— 管线铺好了没人用。

**放在哪一层**：设为 `runClassifierDetailed` 的**默认值**，而不是只给抽取点加。理由是 `llm-classify` 的全部调用点都是浅层任务：

| 调用点 | 任务 | 需要思考预算吗 |
|---|---|---|
| `app/intent.js` | 6 选 1 分类 | 否 |
| `action-runner/slot-filler` | 闭集/正则抽取 | 否 |
| `team-tools/task-triage` | 动作消歧 | 否 |
| `team-tools/bug-patrol` | 表格字段映射 | 否 |
| `features/memory-bank/extract` | 抽条目成 JSON | 否 |
| `features/project-checkup` | 打分归类 | 否 |
| `tracking-stats/understand` | 解析时间区间 + 检索词 | **边界情况，见下** |

只给抽取点加会留下「同样是一行 JSON 的浅层调用，有的设了有的没设」的不一致，下一个人加调用点时无从判断该不该设。

**契约**：

```js
// llm-classify.js
export const DEFAULT_EFFORT = 'low';
// runClassifierDetailed({ ..., effort })：调用点不传则用 DEFAULT_EFFORT；
// 传 effort:null 显式关闭（退回 SDK 默认），传具体档位则覆盖。
```

**唯一需要观察的点**：`tracking-stats/understand.js` 的阶段 A（自然语言 → 时间区间 + 检索目标）比其余调用点略深。本版一并设为 `low`，但在该文件加一条注释记下这个判断，若召回质量下降就单点覆盖回默认档。这属于**可回退的单点决策**，不影响契约本身。

> 注意：`effort` 只影响生成阶段的思考 token，**砍不掉那 2.7~3.7s 的 SDK 冷启**（实测：一次鉴权即失败的调用，`init` 仍耗 2.7s）。所以它是锦上添花，真正的收益来自 §3 的「本地抽取，根本不调」。

### 5.2 即时应答只在真调模型时才发

`ackAction`（「请稍等，我正在确认执行这个操作所需的信息！」）原判据是「这个动作有必填变量」。本改造后主路径本地亚毫秒抽完，仍按老判据发的话，用户会先看到「请稍等…」、紧接着看到「⏳ 正在执行…」，两条挨在一起反而像卡了一下 —— 这条文案本来就是为那段 8~17s 静默准备的。

实现：`extractVars` 新增 `opts.onLlmStart`，**即将真发起 LLM 调用**时同步回调一次；`feature/index.js` 用它触发 `sendAck`。

为什么用回调而不是让 feature 层自己判断：要判断就得把「哪些字段还缺、持久值顶不顶得住、是不是弃权」整套规则在 feature 层再实现一遍，两份规则迟早分叉。回调让 slot-filler 保持唯一裁决方。回调抛异常一律吞掉（它只负责发一条锦上添花的提示，不该带崩动作）。

---

## 6. 脚本侧契约

**今天**：`scripts/get_qrcode.py` 自带一份 `ENV_ALIASES`，`slot-filler.js` 注释要求两边「必须保持一致」—— 这是两份真相，注定分叉。

**改为**：Node 侧归一后**只传规范值**给脚本。

**已拍板：脚本从不手动执行**（唯一调用方是 `script-runner.js`）。所以那份别名表没有任何独立价值 —— 它服务的是「人手敲中文参数」的场景，而该场景不存在。处置：

- **删除** `scripts/get_qrcode.py` 的 `ENV_ALIASES` 及其归一逻辑；
- **删除** `slot-filler.js` 里那句「必须与 `scripts/get_qrcode.py` 的 ENV_ALIASES 保持一致」的注释，改为说明新契约（归一唯一发生在 Node 侧）；
- 若日后确实要手跑脚本，`--env dev|test|prod` 三个规范值本来就能手打，不构成障碍。

**保留** `argparse choices=[...]` —— 它是最后一道防线。Node 侧出 bug 传了脏值时，应该让脚本以非零码干净退出，而不是拿着非法值去执行破坏性操作。这一条与「删别名表」不矛盾：`choices` 校验的是规范值集合，不做任何翻译。

---

## 7. 迁移

### 7.1 向后兼容

四个新字段全部可选。**未声明任何一个的变量 = 自由文本 → 走 LLM**，这与今天的行为一致（今天除 `env`/`phone` 外的变量本来就只能靠 LLM）。所以：**不迁移也不会坏**，只是享受不到零 LLM 快路。

### 7.2 一次性数据迁移

仿照 `store/bots-migration.js` 的做法，启动时执行：

- 变量 `name === 'env'` 且未声明 `preset`/`enum`/`pattern` → 补 `"preset": "env"`
- 变量 `name === 'phone'` 且未声明 → 补 `"preset": "phone"`

> 这里按变量名判断是**可以**的：它是一次性的数据修复，不是运行时逻辑。运行时抽取器永远不看变量名。

**已拍板：用标记位而非每次重扫。** 迁移在**动作条目**上写 `_varContractMigrated: 1`，只处理没有该标记的条目，处理完打标。

理由（这是真问题，不是洁癖）：若每次启动都按变量名重扫补 preset，用户在设置页**手动删掉** `preset: "env"`（比如他想改成自己的 enum，或就是不想要本地抽取）后一重启就被加回去 —— 等于这个字段用户改不掉，而 UI 上又摆着让他改。标记位让「迁移」和「用户意图」分开：迁移只发生一次，之后配置完全归用户。

配套约束：

- 标记写在**动作条目**层级而非全局，这样导入的旧配置（未打标）仍会被迁移一次，而已迁移的不受影响。
- 字段名带 `_` 前缀表示内部字段；Web 表单不渲染它，`config-transfer` 导出时保留（见 §7.4）。
- 迁移经 `updateJson` 走文件锁，与其余 store 写入同款；web / feishu 双进程同时启动不会互相覆盖。

迁移后你现有三个动作（清理账号数据 / 帮我退款 / 获取小程序二维码）的全部必填变量都落进本地快路，**主路径彻底零 LLM**。

### 7.3 迁移未覆盖的路径 —— 行为回退风险

`env`/`phone` 今天**有**硬编码抽取。改造后这套硬编码删除，抽取能力改由声明提供。于是任何**绕过迁移**的配置会从「本地能抽」退化为「只能靠 LLM」：

| 路径 | 是否被迁移覆盖 | 处置 |
|---|---|---|
| 存量 `action-configs.json` | 是（启动时） | — |
| 设置页新建动作 | 否 | Web 表单的「预置类型」下拉在变量名为 `env`/`phone` 时给出**默认选中建议**（仅 UI 提示，用户可改） |
| `config-transfer` 导入的旧配置 | 是（条目无标记 → 迁移） | — |
| 手改 JSON | 是（同上） | — |

这是**已知的、可接受的**退化：没有声明的变量本就该走 LLM，行为仍然正确，只是慢。spec 明确记下，避免日后被当成 bug 排查。

### 7.4 配置导入导出

`store/config-transfer.js` 的 `buildExport`/`parseImport` 按整份 `action-configs` 透传，新字段**自动被带上**，无需改动。

`CONFIG_VERSION` **不升**：新字段全部可选，旧版本导入新配置时会忽略它们（退化为自由文本变量，行为正确）；新版本导入旧配置时由 §7.2 的迁移接住。升版本反而会让旧版本拒绝导入，收益为负。

### 7.5 删除的死代码

- `intent.js:27` 的 `extractEnv` —— 全仓无调用方，且只认 dev/test 不认 prod。
- `slot-filler.js` 的 `NORMALIZERS` / `hasEnv` 分支 / `regexExtract` 里的 `phone`/`env` 硬编码。
- `src/capabilities/CLAUDE.md` 里「`config.intent.classifyModel`…那是分类用的 sonnet」—— 与 `config.js:56` 实际值（Haiku）不符的过时注释。

---

## 8. Web 表单

`public/js/settings-panel.js` 的变量编辑行新增：

| 控件 | 行为 |
|---|---|
| 预置类型（下拉） | 空 / `env` / `phone`；选中后下方字段显示 preset 内容（灰显占位） |
| 合法值（标签输入） | 对应 `enum`，与「正则」二选一，互斥时禁用另一个 |
| 别名（键值对表） | 对应 `aliases`；值列是 `enum` 的下拉，从根上杜绝映射到非法值 |
| 歧义别名（键值对表） | 对应 `weakAliases`，折叠区，旁注「仅在机器人追问时识别」 |
| 正则 | 对应 `pattern`，输入时即时校验可编译性 |
| 示例值 | 对应 `example` |
| 「展开预置为可编辑」按钮 | 把 preset 内容实体化进 `aliases`/`enum`，便于增删 |

服务端校验（`routes-ops.js` 的动作保存路径）：enum/pattern 互斥、aliases 值域合法、preset 名已知、pattern 可编译。**校验失败返回 422 并说明哪个变量的哪个字段** —— 不静默丢弃。

---

## 9. 文件结构

```
src/plugins/action-runner/feature/
  var-contract.js        【新】纯函数：resolveVariable(v) 展开 preset、校验声明合法性
  var-presets.js         【新】内置 preset 表（env / phone），零依赖数据模块
  local-extract.js       【新】纯函数：词表扫描（含正则编译+护栏）、正则抽取、弃权规则
  extract-prompt.js      【新】纯函数：buildExtractPrompt(unresolved, text)
  slot-filler.js         【改】退化为编排：本地抽 → 判 unresolved → 按需调 LLM → 归一
  *.test.js              【新/改】见 §10

src/capabilities/llm-classify.js    【改】DEFAULT_EFFORT='low' + 透传 effort（见 §5.1）
src/entrypoints/web/routes-ops.js   【改】动作保存时的变量声明校验
public/js/settings-panel.js         【改】变量编辑表单
src/store/var-contract-migration.js 【新】一次性迁移（独立模块，仿 bots-migration.js）
scripts/get_qrcode.py               【改】删除 ENV_ALIASES 与归一逻辑，保留 argparse choices
src/plugins/tracking-stats/understand.js 【改】仅加一条注释：effort 档位的观察点（§5.1）
src/capabilities/CLAUDE.md          【改】修正「classifyModel 是 sonnet」的过时描述
src/app/intent.js                   【改】删除死代码 extractEnv
```

四个新模块全部是**零 IO 纯函数**，可被完整单测覆盖 —— 这是把逻辑从 `slot-filler.js` 里拆出来的主要动机。

---

## 10. 测试闸

实施完成的判据（缺一不可）：

1. **抽取器不认识变量名**：同一份声明，变量分别命名为 `env` / `region` / `环境` / `x`，抽取结果必须完全相同。这是本次改造的**核心断言**。
2. **零 LLM 主路径**：注入一个「一旦被调用就抛错」的 `llmExtract` 替身，跑完现有三个动作的典型输入，不得抛错。
3. **preset 覆盖语义**：变量显式 `aliases` 完全覆盖 preset 的同名字段（不是深合并）。
4. **弃权规则泛化**：多值冲突 / 否定词修饰，在**非 env** 的 enum 变量上同样生效。
5. **`weakAliases` 边界**：自由文本不认，追问轮（`forVar`）认。
6. **回溯护栏**：构造一份「候选可由其他候选拼出」的恶意 aliases，扫描 4KB 输入必须在 50ms 内返回。
7. **向后兼容**：未声明任何新字段的变量，行为与改造前逐字节一致。
8. **校验拒绝**：enum+pattern 并存、aliases 值不在 enum 内、未知 preset、非法正则 —— 四种情况保存均返回 422。
9. **迁移只跑一次**：跑一次迁移 → 手动删掉某变量的 `preset` → 再跑迁移，该 `preset` **不得**被加回来（`_varContractMigrated` 标记生效）。这条直接守 §7.2 那个「用户改不掉」的坑。
10. **`effort` 默认与覆盖**：`runClassifierDetailed` 不传 `effort` 时透传 `'low'`；传具体档位时覆盖；传 `null` 时不向 `runClaude` 传该键。用替身断言传给 `runClaude` 的 options，不真调模型。
11. 全量 `npm test` 保持全绿（当前基线 2236 passed / 0 failed）。

---

## 11. 边界与风险

| 风险 | 处置 |
|---|---|
| 用户手写的 aliases 触发正则回溯 | §3.2 四条护栏 + 无外层量词 + 长度上限；测试闸第 6 条守 |
| 归一出脚本不认识的值 | aliases 值域强制落在 enum 内（保存时校验）+ 脚本 `argparse choices` 兜底 |
| preset 内容变更影响存量配置 | preset 是运行时展开而非落盘快照，改 preset 会影响所有引用者 —— 这是**有意的**（修一处全局生效）；不想被影响就用「展开为可编辑」实体化 |
| 本地抽取比 LLM 更容易误判 | 弃权规则（§3.3）优先于命中；拿不准一律交 LLM 或追问 |
| 迁移把不该改的配置改了 | 迁移只在「未声明任何新字段」时补 preset，幂等；不改已声明的 |

## 12. 不在本次范围内

- 意图识别分层重构、L3 与抽取合并（§1.4）
- welcome 卡片按权限过滤按钮（等「插件自声明能力条目」一起做）
- 插件自声明能力条目（下一个 spec）
- 换 LLM 调用通道（直连 Messages API）—— 与「复用 CLI 订阅登录」的产品定位冲突，需单独决策
- `date`/`url`/`email` 等更多 preset
