# 「项目优化」工具 · 阶段二设计文档(LLM 检测维度)

> 日期: 2026-08-24 · 状态: 待评审 · 前置: 阶段一(静态体检)已完成
> 上游: `2026-08-24-project-optimize-design.md`(总设计 §4 维度②⑤)

## 1. 目标

阶段一交付了两个静态维度(地图、rules 降级),维度②⑤ 在 UI 上是「阶段二支持」的灰态、勾选框禁用。本期把它们做出来:

- **维度② 提示词质量**:找出过度宽泛、会导致 AI 做无用功的规则条目
- **维度⑤ 注释合理性**:找出复述代码、已过期、注释掉的死代码

做完之后这两个维度会有真实分数、可勾选,总分从「只算 map+rules」变成四维加权。

### 本期不做

- 这两个维度的**自动修复**(属阶段三/四,且是高风险维度,需要 diff 逐项确认)
- 维度④ 无用代码(v1 明确排除)

## 2. 成本控制:指纹缓存

**这是本期最重要的设计决策。** 总设计里没定,但不解决会毁掉体验。

LLM 维度每次体检都跑的话:维度⑤ 要把 30 个文件的注释送进去,维度② 要判定所有候选条目。用户对同一个项目连点三次体检就是三倍开销,而项目文件根本没变。

### 方案

每个 LLM 维度记录一个**输入指纹**:参与分析的文件的 `路径 + mtime + size` 拼成的字符串的哈希。

- 体检时先算指纹,与上次记录的一致 → 直接复用缓存结果,标 `cached: true`
- 不一致 → 重新调 LLM,更新缓存
- UI 上对 `cached: true` 的维度显示「复用上次分析」,并提供「强制重新分析」按钮

### 为什么用 mtime+size 而不是内容哈希

读全部文件内容算哈希本身就要遍历一遍磁盘,而 mtime+size 只需 `stat`。代价是碰到「内容变了但 mtime 和 size 都没变」会误判为未变——这种情况需要精确构造,正常开发不会遇到。真遇到了,用户点「强制重新分析」即可。

缓存落在 `optimize.json` 项目记录的 `llmCache` 字段下,按维度分别存。

## 3. 维度② 提示词质量

### 扫描范围

`CLAUDE.md`(各级)、`CLAUDE.local.md`、`.claude/rules/*.md`、`.claude/skills/*/SKILL.md`

### 阶段一:规则库捞候选(静态,不花钱)

**绝对化指令词**:`禁止`、`必须`、`一律`、`所有`、`永远不`、`任何情况下`、`不允许`、`严禁`、`MUST`、`NEVER`、`ALWAYS`

**范围限定词白名单**:`但`、`除非`、`仅当`、`范围`、`例外`、`不适用于`、`以下情况`、`unless`、`except`、`除了`

**判定为候选**:该 bullet 或段落命中绝对化指令词,**且**同段落内不含任何范围限定词。

同时静态检测(不需 LLM):
- 单个规则文件行数 > 200(官方建议上限)
- 同一文件内高度重复的条目(归一化后完全相同的行)

### 阶段二:LLM 判定

把候选条目连同上下文(所在段落 + 前后各 2 行)打包成一次调用,要求对每条给出:

- `verdict`: `over-broad` / `acceptable` / `conflicting`
- `reason`: 必须给出「这条会导致 AI 做什么多余的事」的具体场景,不能是空泛评价
- `suggestion`: 保留原意、补上范围限定的改写建议

**few-shot 用真实案例**(2026-08-24 实测):

> 反例:`禁止做出假设——具体结论必须给出 文件:行号 依据`
> 问题:没区分「代码事实」和「需求输入」。实际后果是 AI 把用户在需求里给定的 agent code 也当成待验证假设,跑到后端仓库翻数据库实体定义,一个定点改动跑了 20 分钟。
> 改法:限定为「关于代码如何工作的结论」,并显式声明「用户给定的值是输入不是假设」。
>
> 正例:`禁止提交无法编译的代码(type-check 必须全绿)`
> 为什么可接受:判据客观、可机器验证、无解释空间,不会诱发额外劳动。

这两个例子要同时给——只给反例,LLM 会倾向把所有 `禁止` 都判成过度。

### 判分

```
基础分 100
- 每条 verdict=over-broad   -8
- 每条 verdict=conflicting  -12
- 每个超 200 行的规则文件    -5
- 每组重复条目              -3
clamp [0, 100]
```

### 降级

LLM 失败(超时/额度/非法 JSON)→ 该维度标 `status: 'partial'`,分数按候选数保守估计(每个候选 -4),UI 标注「仅静态结果,未深度分析」。**不标 `done`**——避免一个未经判定的分数参与总分加权,给用户虚假的确定感。

## 4. 维度⑤ 注释合理性

### 抽样

按 git 最近修改时间排序取前 **30 个**源码文件。排除:测试文件、`node_modules`、构建产物、`.min.js`、生成物。

取不到 git 信息时(非仓库)退化为按 mtime 排序。

### 送什么给 LLM

不送整个文件——太贵且无必要。只送**注释块及其紧邻的 3 行代码**,每个文件最多取 10 处,整体截断到约 12000 字符。

### 检测三类

| 类型 | 说明 |
|---|---|
| `restates-code` | 注释只是把代码翻译成中文,没解释「为什么」 |
| `stale` | 注释描述的行为与当前代码不符 |
| `dead-code` | 被注释掉的代码块(非文档性注释) |

### 判分

```
基础分 100
- (问题数 / 抽样文件数) × 60
clamp [0, 100]
```

### 降级

同维度②:失败标 `partial`,不计入总分。

## 5. LLM 调用规范

**照 `src/entrypoints/web/tier.js` 的既有范式**,这是项目里内部一次性调用的标准写法:

```js
await runClaude(prompt, {
  ...claudeAuthOpts(),        // 备用账号轮换
  model: 'claude-haiku-4-5',  // 判定类任务，不需要顶配模型
  persistSession: false,      // 不落盘——否则在左栏历史生成伪会话，极易误点
  abortController: ac,
  disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  systemPrompt: { type: 'custom', custom: '...' },
  onText: (t) => (out += t),
  onResult: (i) => { if (!out && i.result) out = i.result; },  // onText 没收到时兜底
});
```

**必须禁用全部工具。** 输入是已经读好的文本片段,输出是结构化判定,不需要任何文件访问能力。放开工具会让它自己去翻代码,既慢又不可控。

**输出格式**:要求 LLM 输出 JSON 数组。解析失败重试一次;仍失败走降级路径。

**超时**:单个维度 5 分钟。超时标 `partial`。

## 6. 架构与数据流

```
POST /api/optimize/checkup {dir}
   │
   ├─ 同步：静态检测(map / rules) + 维度②的候选捞取 → 立即返回
   │        dims.prompts = {status:'analyzing', candidates: N}
   │        dims.comments = {status:'analyzing'}
   │
   └─ 异步：两个 LLM 维度并行跑(它们互不依赖，都是只读分析)
            → 各自完成后通过 SSE 推送

GET /api/optimize/checkup-stream?checkupId=  (SSE)
   ← dim 事件：{key:'prompts', result:{...}}
   ← dim 事件：{key:'comments', result:{...}}
   ← done 事件：{score, grade, issueCount}   // 总分重算后推送
```

维度②⑤ **并行**跑,不串行——两个都是只读分析,没有相互依赖,串行白白多等一倍时间。

## 7. 数据结构增量

```json
{
  "lastCheckup": {
    "dims": {
      "prompts": {
        "score": 65, "status": "done", "issues": [],
        "cached": false, "fingerprint": "a1b2c3...",
        "candidateCount": 12
      },
      "comments": {
        "score": 88, "status": "done", "issues": [],
        "cached": true, "fingerprint": "d4e5f6...",
        "sampledFiles": 30
      }
    }
  },
  "llmCache": {
    "prompts": { "fingerprint": "a1b2c3...", "result": { }, "at": "..." },
    "comments": { "fingerprint": "d4e5f6...", "result": { }, "at": "..." }
  }
}
```

`status` 新增两个取值:`analyzing`(LLM 跑着)、`partial`(仅静态结果)。前端的 `dimListFrom` 要相应处理——`analyzing` 显示转圈且不可勾选,`partial` 显示分数但标注未深度分析、可勾选。

## 8. 验证策略(硬约束)

**样本必须跨越多种来源。** 这条是阶段一血的教训:死链检测前三轮只拿根 `CLAUDE.md` 调优,误报率从 90% 压到 50%,自我感觉良好;一接上模块地图,153 条死链里 152 条是误报。

维度②⑤ 的验证样本必须同时包含:

1. 根 `CLAUDE.md`(长、结构化、规则密集)
2. 至少 2 个模块级 `CLAUDE.md`(短、写作风格不同)
3. `.claude/rules/*.md`(规范类文本)
4. 至少 2 个不同项目(`kxmall-app-ui` 和 `claude-p-web-demo`)

**每个维度的验收判据是人工核对误报率**,不是"跑通了不崩"。具体做法:对样本跑一次,逐条核对 LLM 的判定是否成立,记录误报数。误报率超过 30% 就要调提示词重来。

维度② 有个现成的真值:`kxmall-app-ui/CLAUDE.md` 里那条「禁止做出假设」**必须**被判为 `over-broad`(它有实测的 20 分钟事故背书);而同文件里的「禁止提交无法编译的代码」**必须**被判为 `acceptable`。这两条是最低验收线。

## 9. 错误处理

| 场景 | 处理 |
|---|---|
| LLM 超时(>5min) | 该维度 `partial`,UI 提供「重试该维度」 |
| LLM 返回非法 JSON | 重试一次;仍失败 → `partial` |
| 额度耗尽 | `partial` + 明确提示是额度问题,不是项目问题 |
| 扫描范围内无任何文件 | 该维度 `na`,不计入总分 |
| 候选数为 0(维度②) | 直接 100 分 `done`,不调 LLM(省钱) |
| SSE 连接中断 | 后台继续跑完并写缓存;前端重连时通过 `replay` 拿到已完成的维度 |

## 10. 测试策略

**纯逻辑单测**
- `check-prompts.logic.js`:绝对化词匹配、范围限定词白名单、段落切分、候选判定、判分
- `check-comments.logic.js`:抽样排序与过滤、注释块提取、判分
- `fingerprint.logic.js`:指纹计算的稳定性(同输入同输出、文件顺序无关)
- `score.logic.js` 扩展:`analyzing` / `partial` 状态不计入总分

**不写单测的**:LLM 调用本身。改为断言提示词模板包含必需字段说明 + JSON schema 校验函数能正确拒绝非法载荷。

**夹具**:新增 `tests/fixtures/projects/prompt-quality/`,含一份故意写了过度宽泛规则的 CLAUDE.md 和一份规则合理的,用于验证候选捞取的准确性。

## 11. 开放问题

无。
