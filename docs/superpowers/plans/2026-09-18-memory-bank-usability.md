# 记忆库实用性迭代 实现计划

> **给执行者：** 用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 按任务逐条推进。步骤用 `- [ ]` 复选框跟踪。
>
> ⚠️ **本项目不自动 git 提交**（根 `CLAUDE.md`「协作约定」）。各任务末尾的「验证」步骤跑完即止，改动留工作区，提交时机由维护者掌控。

**目标：** 让记忆库提炼出的条目真正有用——砍掉通识噪声、把项目专属知识关进对应工程、让用户看得见也控得住最终注入了什么。

**架构：** 不改两阶段流水线骨架（Phase 1 逐会话分析 → Phase 2 批量合成 → 渲染落盘 → 挂接 CLAUDE.md）。四处增强全部落在既有接缝上：合成 prompt 加门槛与 scope 判定、session 记录带上来源工程目录、`render.js` 的排序与过滤字段被真正喂饱、面板补上注入预览与逐条开关。

**技术栈：** Node ≥20 原生 ESM、`node:test` 单测、原生 DOM（无框架）、`src/store` 文件锁持久化。

---

## 背景：为什么要做

2026-09-18 实测生产库 56 条 memories，分三类：

| 类别 | 条数 | 例子 | 全局注入价值 |
|---|---|---|---|
| A 跨项目工作方式 | ~15 | 大改前确认、实测取证、溯源到文件:行号 | ✅ 真有用 |
| B 模型默认就会 | ~4 | 「遵循 DRY/KISS/SRP」「极简主义反对冗余装饰」 | ⚠️ 零信息量 |
| C 项目专属技术细节 | ~37 | mp-weixin 禁 `as` 断言、小程序分包、地图商适配器 | ❌ 在别的项目里是噪声 |

**三个确定性缺陷：**

1. **排序退化成随机。** `render.js:39` 的 `normalizeMem` 把每条强制成 `evidenceCount: 1` / `source: 'inferred'`，`createdAt` 又都在同一分钟内，`weight()` 算出来几乎全相等 → 哪 40 条进 CLAUDE.md 纯看数组下标。用户看到 56 条以为都生效，实际随机 40 条。
2. **项目级 scope 是死代码。** `index.js:199` 硬编码 `projectDirs: []`，加上 `normalizeMem` 强制 `scope: 'global'`，工程级 `.claude/memory-bank.md` 永远不会生成。
3. **预算静默截断。** 总量 3949 字符 vs `maxChars: 3000` / `maxItems: 40` → 约 16 条被丢，`truncated` 只写日志，面板不显示。

**存量处置（已拍板）：** 56 条保留不动，作为新旧 prompt 产出质量的对照组。故所有涉及新字段的改动**必须对无该字段的存量条目保持向后兼容**（默认 `scope: 'global'` / `inject: true` / `status: 'active'`）。

---

## 数据模型变更

### memory 条目（`memory-bank.json` 的 `memories[]`）

```js
{
  id: 'mem_...',            // 既有
  category: 'collaboration',// 既有，五类枚举不变
  statement: '...',         // 既有
  reasoning: '...',         // 既有
  createdAt: 1758..,        // 既有
  source: 'synthesized',    // 既有（写入来源标记，勿与 render 的 explicit/inferred 混淆）

  // ── 阶段 A 新增 ──
  explicit: false,          // 用户明说的规矩 vs 从行为推断。render 排序时 explicit 永远压过 inferred
  evidenceCount: 1,         // 强度（1 或 3），排序权重

  // ── 阶段 B 新增 ──
  scope: 'global',          // 'global' | 'project'
  projectDir: '',           // scope==='project' 时的工程绝对路径

  // ── 阶段 C 新增 ──
  inject: true,             // 用户开关：false 则不进 CLAUDE.md，但保留在库里

  // ── 阶段 D 新增 ──
  status: 'active',         // 'active' | 'dormant'
  lastSeenAt: 1758..,       // 最后一次被证据命中的时刻
}
```

### session 记录（`memory-bank.json` 的 `sessions[]`）

```js
{
  id, path, mtime, analyzedAt, findings, status,  // 既有
  cwd: 'C:\\Users\\DELL\\Desktop\\xxx',           // 阶段 B 新增：该会话的工程目录
}
```

### bank 顶层

```js
{ version: 2, lastExtractAt, lastSessionScanAt, sessions, memories,
  blacklist: [],  // 阶段 D 新增：用户移除过的 statement，不再复活
}
```

---

## 文件结构

| 文件 | 改动性质 | 职责 |
|---|---|---|
| `src/features/memory-bank/synthesize.js` | 改 | prompt 门槛、scope 判定、按项目切批、新字段写入 |
| `src/features/memory-bank/synthesize.test.js` | 改 | 配套单测 |
| `src/features/memory-bank/render.js` | 改 | `normalizeMem` 尊重新字段（不再强制覆盖） |
| `src/features/memory-bank/render.test.js` | 改 | 配套单测 |
| `src/features/memory-bank/scan-sessions.js` | 改 | 新增 `extractCwd` 纯函数 |
| `src/features/memory-bank/scan-sessions.test.js` | 改 | 配套单测 |
| `src/features/memory-bank/index.js` | 改 | Phase 1 记录 cwd、Phase 2 逐批传 projectDir、`writeRenders` 传真实 projectDirs |
| `src/store/memory-bank.js` | 改 | `blacklist` 读写、`patchMemory` 已够用 |
| `src/store/memory-bank.test.js` | 改 | 配套单测 |
| `src/entrypoints/web/routes-memory.js` | 改 | 新增 `/api/memory/preview`、`/api/memory/inject` |
| `src/entrypoints/web/routes-memory.test.js` | 改 | 配套单测 |
| `public/js/memory-view.js` | 改 | 注入预览区段、逐条 inject 开关 |
| `public/css/*.css` | 改 | 预览区段与开关样式（沿用既有 `mem-*` 前缀） |

**不新建文件**：所有改动都落在既有模块的既有职责内，`memory-bank/` 已经是「纯函数 + 一个 IO 编排点」的干净结构，新增文件反而会打散它。

---

# 阶段 A · 提炼门槛与排序修复（方向②）

> 先做这一段，因为它成本最低且立刻可验证：改完跑一次手动提炼就能对比新旧产出质量。

## Task 1：合成 prompt 加负面清单与强度字段

**Files:**
- Modify: `src/features/memory-bank/synthesize.js`（`buildSynthesisPrompt`，约 111-161 行）
- Test: `src/features/memory-bank/synthesize.test.js`

- [ ] **Step 1：写失败测试**

在 `synthesize.test.js` 追加：

```js
test('buildSynthesisPrompt 含负面清单，拒绝通识与一次性决策', () => {
  const p = buildSynthesisPrompt([{ type: 'preference', summary: 'x' }]);
  assert.match(p, /不要产出/);
  assert.match(p, /DRY|KISS|SOLID/);          // 点名通识作为反例
  assert.match(p, /一次性/);                   // 拒绝一次性决策
  assert.match(p, /反直觉|默认不会/);          // 正面判据
});

test('buildSynthesisPrompt 要求输出 explicit 与 strength 字段', () => {
  const p = buildSynthesisPrompt([{ type: 'preference', summary: 'x' }]);
  assert.match(p, /"explicit"/);
  assert.match(p, /"strength"/);
});
```

- [ ] **Step 2：跑测试确认失败**

```bash
node --test src/features/memory-bank/synthesize.test.js
```
预期：两条新用例 FAIL（`assert.match` 找不到对应文案）。

- [ ] **Step 3：改 `buildSynthesisPrompt`**

把「重要原则」段落替换为下面内容（保留原有 1/2/3 三条，在其后插入门槛段），并把输出格式示例与硬约束同步更新：

```js
  return [
    '你是一个用户偏好提炼器。下面是从多个开发对话会话中提炼的发现（findings）。',
    '请从中识别出值得长期记住的偏好、模式或规则，并合成为记忆条目（memories）。',
    '',
    '重要原则：',
    '1. 不是每个 finding 都需要变成 memory，要有选择性。只保留真正具有长期价值的条目。',
    '2. statement 必须是具体可执行的规则，不能是模糊描述。',
    '3. category 必须从以下值中选一个：collaboration / code-style / writing / dialogue / tech-pref',
    '   - collaboration：协作方式、沟通风格、工作流程偏好',
    '   - code-style：代码风格、命名规范、格式习惯',
    '   - writing：文档、注释、提交信息的写作风格',
    '   - dialogue：对话风格、反馈偏好、交互习惯',
    '   - tech-pref：技术选型、框架/库偏好、工具链选择',
    '',
    // ── 门槛：这段是整个提炼质量的闸门 ──
    '判据（最重要）：只收「一个不认识这位用户的资深工程师，默认不会这么做」的条目。',
    '一条记忆的价值 = 它能改变行为的程度。写下来却不改变任何行为的，就是纯粹的 token 浪费。',
    '',
    '不要产出以下几类（它们看着像偏好，实际没有价值）：',
    '- 业界通识：DRY、KISS、SOLID、单一职责、「避免过度设计」、「代码要简洁」。',
    '  任何模型默认就会遵守，写进记忆只占预算不改变行为。',
    '- 一次性决策：「本次版本清理时移除已升级字段」这类做完就过期的事，不是长期偏好。',
    '- 复述现象而非规则：「用户很关注性能」太模糊，「要求先测出耗时再优化，禁止凭感觉调」才可执行。',
    '- 从单次对话推断的巧合：只出现过一次、又没被用户明确要求的做法。',
    '',
    '优先产出以下几类：',
    '- 用户明确说过的规矩（「以后都…」「不要再…」「记住…」）。',
    '- 反直觉的约束：与常规做法相反、不写下来下次一定会做错的。',
    '- 踩过坑换来的判据：某个做法失败过，用户纠正过。',
    '',
    '仅输出一个 JSON 对象，不要任何解释文字。格式：',
    '{"memories":[{"category":"tech-pref","statement":"具体规则描述",'
      + '"reasoning":"为什么值得记住（可选）","explicit":true,"strength":"strong"}]}',
    '',
    '字段说明：',
    '- explicit：true 表示用户明确说过这条规矩；false 表示从行为推断。',
    '  这个字段决定注入优先级 —— 判错会让真正的硬性要求被推断出来的条目挤掉，务必如实填。',
    '- strength："strong" 表示跨多个会话反复出现；"normal" 表示证据较少。',
    '',
    '硬约束：',
    '1. 无值得记录的内容时，memories 返回空数组（{"memories":[]}）。宁缺毋滥 —— ',
    '   一轮产出 0 条是完全正常且可接受的结果，凑数比漏掉更有害。',
    '2. statement 不超过 300 字符，必须简洁具体。',
    '3. reasoning 可选，不超过 300 字符。',
    '4. category 必须是上述五个值之一，否则该条目无效。',
    '5. explicit 必须是布尔值，strength 必须是 "strong" 或 "normal"。',
    ...existingBlock,
    '',
    `共 ${list.length} 条 findings：`,
    '',
    items || '（无 findings 内容）',
  ].join('\n');
```

- [ ] **Step 4：跑测试确认通过**

```bash
node --test src/features/memory-bank/synthesize.test.js
```
预期：全部 PASS。

- [ ] **Step 5：验证既有测试未被破坏**

```bash
npm test 2>&1 | tail -20
```
预期：无新增失败。

---

## Task 2：`sanitizeMemories` 收下新字段并写入 bank

**Files:**
- Modify: `src/features/memory-bank/synthesize.js`（`sanitizeMemories` 约 168-185 行、`synthesizeMemories` 约 218-238 行）
- Test: `src/features/memory-bank/synthesize.test.js`

- [ ] **Step 1：写失败测试**

```js
test('sanitizeMemories 归一 explicit 与 strength', () => {
  const out = sanitizeMemories({ memories: [
    { category: 'collaboration', statement: 'a', explicit: true, strength: 'strong' },
    { category: 'code-style', statement: 'b' },                       // 缺字段
    { category: 'writing', statement: 'c', explicit: 'yes', strength: 'HUGE' }, // 非法值
  ]});
  assert.equal(out.length, 3);
  assert.deepEqual([out[0].explicit, out[0].evidenceCount], [true, 3]);
  assert.deepEqual([out[1].explicit, out[1].evidenceCount], [false, 1]); // 缺字段兜底
  assert.deepEqual([out[2].explicit, out[2].evidenceCount], [false, 1]); // 非法值兜底
});
```

- [ ] **Step 2：跑测试确认失败**

```bash
node --test src/features/memory-bank/synthesize.test.js
```
预期：FAIL，`out[0].explicit` 是 `undefined`。

- [ ] **Step 3：改 `sanitizeMemories`**

在 `MAX_REASONING` 常量下方补一个映射常量，并改写循环体：

```js
/** strength → evidenceCount 的映射。用离散两档而非让模型报数字：
 * 模型报「这条基于 7 条 findings」是编出来的，报「强/弱」才是它真能判断的。 */
const STRENGTH_WEIGHT = { strong: 3, normal: 1 };

export function sanitizeMemories(json) {
  if (!json || !Array.isArray(json.memories)) return [];
  const out = [];
  for (const item of json.memories) {
    if (!item || typeof item !== 'object') continue;
    const category = String(item.category || '').trim();
    if (!MEMORY_CATEGORIES.includes(category)) continue;
    const statement = String(item.statement || '').trim();
    if (!statement) continue;
    const reasoning = String(item.reasoning || '').slice(0, MAX_REASONING);
    // 非布尔一律当 false：模型偶尔会回 "yes"/"true" 字符串，宽松解析会把
    // 推断出来的条目误升成「用户明说的」，进而把真正的硬性要求挤出注入预算。
    const explicit = item.explicit === true;
    const evidenceCount = STRENGTH_WEIGHT[String(item.strength || '').trim()] || 1;
    out.push({ category, statement: statement.slice(0, MAX_STATEMENT), reasoning, explicit, evidenceCount });
  }
  return out;
}
```

- [ ] **Step 4：改 `synthesizeMemories` 的写入对象**

把 `for (const c of candidates)` 里的 `memory` 字面量改为：

```js
    const at = Date.now();
    const memory = {
      id: `mem_${at}_${Math.random().toString(36).slice(2, 7)}`,
      category: c.category,
      statement: c.statement,
      reasoning: c.reasoning,
      createdAt: at,
      source: 'synthesized',
      // 注入排序依据。缺了这两个字段，render 的 weight() 对所有条目算出同一个值，
      // 「哪 40 条进 CLAUDE.md」就退化成数组下标顺序（2026-09-18 实测缺陷）。
      explicit: c.explicit,
      evidenceCount: c.evidenceCount,
      lastSeenAt: at,
      status: 'active',
      inject: true,
    };
```

- [ ] **Step 5：跑测试确认通过**

```bash
node --test src/features/memory-bank/synthesize.test.js && npm test 2>&1 | tail -20
```
预期：全部 PASS。

---

## Task 3：`render.js` 真正用上排序字段（修复随机排序）

**Files:**
- Modify: `src/features/memory-bank/render.js`（`normalizeMem` 约 39-51 行）
- Test: `src/features/memory-bank/render.test.js`

- [ ] **Step 1：写失败测试**

```js
test('selectForInjection：explicit 条目压过 inferred，且尊重已有 evidenceCount', () => {
  const now = Date.now();
  const items = [
    { category: 'code-style',    statement: '推断来的', explicit: false, evidenceCount: 1, createdAt: now },
    { category: 'collaboration', statement: '明说的',   explicit: true,  evidenceCount: 1, createdAt: now },
  ];
  const { included } = selectForInjection(items, { scope: 'global', now, maxItems: 2, maxChars: 500 });
  assert.equal(included[0].statement, '明说的');
});

test('normalizeMem 不覆盖条目自带的 inject/status', () => {
  const now = Date.now();
  const items = [{ category: 'writing', statement: '关掉的', inject: false, status: 'active', createdAt: now }];
  const { included } = selectForInjection(items, { scope: 'global', now, maxItems: 5, maxChars: 500 });
  assert.equal(included.length, 0);
});
```

- [ ] **Step 2：跑测试确认失败**

```bash
node --test src/features/memory-bank/render.test.js
```
预期：两条都 FAIL（`normalizeMem` 把 `source` 强制成 `'inferred'`、把 `inject` 强制成 `true`）。

- [ ] **Step 3：改写 `normalizeMem`**

```js
/**
 * 把 v2 memory 对象归一化为 selectForInjection 能处理的形状。
 *
 * 关键：**只补缺失字段，绝不覆盖已有值**。早期版本无条件写死
 * `inject:true / scope:'global' / evidenceCount:1 / source:'inferred'`，
 * 后果是 weight() 对每条算出同一个值、explicit 优先级从未生效 ——
 * 「哪 40 条进 CLAUDE.md」实际由数组下标决定（2026-09-18 实测）。
 *
 * 存量条目（阶段 A 之前产出的）没有这些字段，走下面的默认值，行为与改动前一致。
 */
function normalizeMem(mem) {
  return {
    ...mem,
    status: mem.status || 'active',
    inject: mem.inject !== false,
    scope: mem.scope === 'project' ? 'project' : 'global',
    projectDir: mem.projectDir || '',
    category: mem.category,
    statement: mem.statement,
    evidenceCount: Number(mem.evidenceCount) > 0 ? Number(mem.evidenceCount) : 1,
    lastSeenAt: mem.lastSeenAt || mem.createdAt || 0,
    source: mem.explicit === true ? 'explicit' : 'inferred',
  };
}
```

- [ ] **Step 4：改归一化的触发条件**

`selectForInjection`（约 66-68 行）与 `renderMarkdown`（约 114-116 行）现在都用 `it.status === undefined` 判断要不要归一。新条目自带 `status` 会被跳过归一，`source` 就永远补不上。两处统一改为无条件归一：

```js
  // 无条件归一：normalizeMem 已改为「只补缺失、不覆盖已有」，重复调用是幂等的。
  // 旧的 `status === undefined` 条件会让自带 status 的新条目跳过归一，
  // 于是 explicit → source 的映射永远不发生。
  const normalizedItems = (items || []).map(normalizeMem);
```

```js
  const normalized = (items || []).map(normalizeMem);
```

- [ ] **Step 5：跑测试确认通过**

```bash
node --test src/features/memory-bank/render.test.js && npm test 2>&1 | tail -20
```
预期：全部 PASS。

- [ ] **Step 6：人工验收（阶段 A 交付点）**

1. 启动服务：`npm start`
2. 面板点「立即提炼」，等一轮跑完
3. 对比新产出与存量 56 条：新条目应显著减少 B 类通识
4. 检查 `~/.claude/memory-bank.md`：`explicit: true` 的条目应排在各分节靠前位置

---

# 阶段 B · 分域注入（方向①）

## Task 4：从转录抽取 `cwd`

**背景：** `~/.claude/projects/` 的目录 slug **不可反解**——实测 `C--Users-DELL-Desktop-07-------` 对应 `C:\Users\DELL\Desktop\07_应季食材盲盒`，中文全被抹成 `-`。但 jsonl 内容里 `user`/`assistant` 类型的记录带精确的 `cwd` 字段。

**Files:**
- Modify: `src/features/memory-bank/scan-sessions.js`
- Test: `src/features/memory-bank/scan-sessions.test.js`

- [ ] **Step 1：写失败测试**

```js
test('extractCwd 从转录内容里取出首个 cwd', () => {
  const content = [
    JSON.stringify({ type: 'last-prompt', sessionId: 'a' }),      // 元数据行无 cwd
    JSON.stringify({ type: 'user', cwd: 'C:\\proj\\x', message: {} }),
    JSON.stringify({ type: 'assistant', cwd: 'C:\\proj\\x' }),
  ].join('\n');
  assert.equal(extractCwd(content), 'C:\\proj\\x');
});

test('extractCwd 容忍坏行与空内容，找不到返回空串', () => {
  assert.equal(extractCwd('{坏 JSON\n{"type":"user"}'), '');
  assert.equal(extractCwd(''), '');
  assert.equal(extractCwd(null), '');
});
```

- [ ] **Step 2：跑测试确认失败**

```bash
node --test src/features/memory-bank/scan-sessions.test.js
```
预期：FAIL，`extractCwd is not defined`。记得在测试文件顶部把 `extractCwd` 加进 import。

- [ ] **Step 3：实现 `extractCwd`**

追加到 `scan-sessions.js` 末尾：

```js
/**
 * 纯函数。从会话转录内容里抽出该会话的工程目录。
 *
 * 为什么不从目录名反解：`~/.claude/projects/` 的 slug 是有损编码 ——
 * 实测 `C--Users-DELL-Desktop-07-------` 对应 `C:\Users\DELL\Desktop\07_应季食材盲盒`，
 * 中文与下划线全被抹成 `-`，无法还原。转录里的 `cwd` 字段才是精确来源。
 *
 * 只扫到第一个命中就停：一个会话的 cwd 不会中途变（`/cwd` 切换会开新会话），
 * 而转录动辄几 MB，全量解析纯属浪费。
 *
 * @param {string} content jsonl 全文
 * @returns {string} 工程绝对路径；取不到返回空串（调用方据此归入全局池）
 */
export function extractCwd(content) {
  const text = String(content || '');
  if (!text) return '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // 先做字符串预筛：绝大多数行不含 cwd，JSON.parse 每行都跑一遍在几 MB 的转录上很贵
    if (!line.includes('"cwd"')) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o.cwd === 'string' && o.cwd) return o.cwd;
    } catch {
      continue; // 坏行跳过，与 store/jsonl.js 的读取姿态一致
    }
  }
  return '';
}
```

- [ ] **Step 4：跑测试确认通过**

```bash
node --test src/features/memory-bank/scan-sessions.test.js
```
预期：PASS。

---

## Task 5：Phase 1 把 `cwd` 记进 session

**Files:**
- Modify: `src/features/memory-bank/index.js`（`runOnce` 的 Phase 1 循环，约 108-157 行）

- [ ] **Step 1：补 import**

`index.js` 第 17 行改为：

```js
import { scanForUnanalyzedSessions, extractCwd } from './scan-sessions.js';
```

- [ ] **Step 2：读到 content 后立刻抽 cwd**

在 `content = fs.readFileSync(...)` 的 try/catch 之后插入一行：

```js
      // 会话归属的工程目录。空串表示取不到（转录格式异常），后续按全局池处理。
      const sessionCwd = extractCwd(content);
```

- [ ] **Step 3：三处写 session 的地方都带上 cwd**

「分析中」占位的两支：

```js
      if (preExisting) {
        patchSession(preExisting.id, { status: 'analyzing', analyzingAt: Date.now(), cwd: sessionCwd });
      } else {
        const preId = `ses_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        addSession({ id: preId, path: sessionPath, mtime, analyzedAt: 0, findings: [],
          status: 'analyzing', analyzingAt: Date.now(), cwd: sessionCwd });
      }
```

分析完成的两支：

```js
      if (existing) {
        patchSession(existing.id, { mtime, analyzedAt, findings, status: 'analyzed', cwd: sessionCwd });
      } else {
        const id = `ses_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        addSession({ id, path: sessionPath, mtime, analyzedAt, findings, status: 'analyzed', cwd: sessionCwd });
      }
```

- [ ] **Step 4：验证**

```bash
npm test 2>&1 | tail -20
```
预期：无新增失败（本步无新测试，`index.js` 是 IO 编排层，靠下游任务的集成验收）。

---

## Task 6：按项目分组切批

**设计取舍：** 按 cwd 分组后，同一条跨项目偏好会在多个项目批次里各出现一次。靠既有的 `existingStatements` 去重机制拦截（每批合成成功后把新 statement 追加进去，下一批的 prompt 就带上了）。这比「混合切批 + 让模型给每条标来源项目」更可靠——后者要求模型在几十条 findings 里精确追溯每条的出处，实测容易串台。

**Files:**
- Modify: `src/features/memory-bank/synthesize.js`（`batchSessionsForSynthesis` 约 72-102 行）
- Test: `src/features/memory-bank/synthesize.test.js`

- [ ] **Step 1：写失败测试**

```js
test('batchSessionsForSynthesis 按 cwd 分组，批带 projectDir', () => {
  const mk = (id, cwd, n) => ({ id, cwd, synthesizedAt: 0,
    findings: Array.from({ length: n }, (_, i) => ({ type: 'preference', summary: `${id}-${i}` })) });
  const batches = batchSessionsForSynthesis([
    mk('s1', 'C:\\a', 2), mk('s2', 'C:\\b', 2), mk('s3', 'C:\\a', 2),
  ]);
  assert.equal(batches.length, 2);
  const dirs = batches.map(b => b.projectDir).sort();
  assert.deepEqual(dirs, ['C:\\a', 'C:\\b']);
  const batchA = batches.find(b => b.projectDir === 'C:\\a');
  assert.deepEqual(batchA.sessionIds.sort(), ['s1', 's3']);  // 同项目合并进一批
});

test('batchSessionsForSynthesis：无 cwd 的会话归入空 projectDir 批', () => {
  const batches = batchSessionsForSynthesis([
    { id: 's1', synthesizedAt: 0, findings: [{ type: 'preference', summary: 'x' }] },
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].projectDir, '');
});

test('batchSessionsForSynthesis：单项目超预算时仍按字符切多批', () => {
  const big = (id) => ({ id, cwd: 'C:\\a', synthesizedAt: 0,
    findings: [{ type: 'preference', summary: 'x'.repeat(30_000) }] });
  const batches = batchSessionsForSynthesis([big('s1'), big('s2')]);
  assert.equal(batches.length, 2);
  assert.ok(batches.every(b => b.projectDir === 'C:\\a'));
});
```

- [ ] **Step 2：跑测试确认失败**

```bash
node --test src/features/memory-bank/synthesize.test.js
```
预期：FAIL，`batches[0].projectDir` 是 `undefined`。

- [ ] **Step 3：改写 `batchSessionsForSynthesis`**

```js
/**
 * 纯函数。把「尚未合成过的会话」先按工程目录分组，再在组内按字符预算切批。
 *
 * 为什么以 session 而非单条 finding 为最小单位：合成成功后要按 session 打 `synthesizedAt`
 * 标记来推进游标，findings 一旦跨批，某批失败就会让该 session 处于「一半已合成」的状态 ——
 * 标记打了会丢数据，不打会重复合成。以 session 为粒度，标记与批次天然一一对应。
 *
 * 为什么先按 cwd 分组：合成时要判定每条记忆是「跨项目偏好」还是「本项目技术知识」。
 * 一批里混着五个项目的 findings，模型无从判断；告诉它「这批都来自项目 X」判得准得多。
 * 代价是同一条跨项目偏好会在多个项目批次里各出一次 —— 靠调用方逐批累积的
 * `existingStatements` 去重（见 index.js 的 Phase 2 循环）。
 *
 * @param {Array} sessions bank.sessions
 * @param {{maxChars?:number, maxBatches?:number}} [opts]
 * @returns {Array<{sessionIds:string[], findings:Array, projectDir:string}>}
 */
export function batchSessionsForSynthesis(sessions, opts = {}) {
  if (!Array.isArray(sessions)) return [];
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : BATCH_MAX_CHARS;
  const maxBatches = Number(opts.maxBatches) > 0 ? Number(opts.maxBatches) : MAX_BATCHES_PER_RUN;

  const pending = sessions.filter(
    (s) => s && Array.isArray(s.findings) && s.findings.length > 0 && !s.synthesizedAt
  );

  // 按工程目录分组。Map 保留插入序，让批次顺序稳定可预期（便于复现问题）。
  const groups = new Map();
  for (const s of pending) {
    const dir = String(s.cwd || '');
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(s);
  }

  const batches = [];
  for (const [projectDir, group] of groups) {
    let cur = { sessionIds: [], findings: [], projectDir };
    let curChars = 0;

    for (const s of group) {
      const size = sessionChars(s);
      // 当前批已有内容且再塞就超预算 → 先收口。批为空时无论多大都收下，
      // 否则单个超预算的 session 会被反复跳过、永远合成不了。
      if (cur.findings.length > 0 && curChars + size > maxChars) {
        batches.push(cur);
        if (batches.length >= maxBatches) return batches;
        cur = { sessionIds: [], findings: [], projectDir };
        curChars = 0;
      }
      cur.sessionIds.push(s.id);
      cur.findings.push(...s.findings);
      curChars += size;
    }

    if (cur.findings.length > 0) {
      batches.push(cur);
      if (batches.length >= maxBatches) return batches;
    }
  }

  return batches.slice(0, maxBatches);
}
```

- [ ] **Step 4：跑测试确认通过**

```bash
node --test src/features/memory-bank/synthesize.test.js && npm test 2>&1 | tail -20
```
预期：全部 PASS。

---

## Task 7：prompt 判定 scope，写入 `scope` / `projectDir`

**Files:**
- Modify: `src/features/memory-bank/synthesize.js`（`buildSynthesisPrompt` / `sanitizeMemories` / `synthesizeMemories`）
- Test: `src/features/memory-bank/synthesize.test.js`

- [ ] **Step 1：写失败测试**

```js
test('buildSynthesisPrompt 带 projectDir 时要求判定 scope', () => {
  const p = buildSynthesisPrompt([{ type: 'preference', summary: 'x' }], { projectDir: 'C:\\proj\\demo' });
  assert.match(p, /C:\\proj\\demo/);
  assert.match(p, /"scope"/);
  assert.match(p, /global/);
  assert.match(p, /project/);
});

test('sanitizeMemories 归一 scope，非法值回落 global', () => {
  const out = sanitizeMemories({ memories: [
    { category: 'code-style',    statement: 'a', scope: 'project' },
    { category: 'collaboration', statement: 'b', scope: 'global' },
    { category: 'writing',       statement: 'c', scope: '乱填' },
    { category: 'dialogue',      statement: 'd' },
  ]});
  assert.deepEqual(out.map(m => m.scope), ['project', 'global', 'global', 'global']);
});

test('synthesizeMemories 把批的 projectDir 写进 project 域条目', async () => {
  const fake = async () => ({ memories: [
    { category: 'code-style',    statement: '本项目专属', scope: 'project' },
    { category: 'collaboration', statement: '跨项目通用', scope: 'global' },
  ]});
  const got = await synthesizeMemories([{ type: 'preference', summary: 'x' }],
    { _runner: fake, projectDir: 'C:\\proj\\demo' });
  const proj = got.find(m => m.scope === 'project');
  const glob = got.find(m => m.scope === 'global');
  assert.equal(proj.projectDir, 'C:\\proj\\demo');
  assert.equal(glob.projectDir, '');   // 全局条目不带工程目录
});
```

> 注意：第三条用例会真的写 bank。`synthesize.test.js` 既有用例已有隔离做法（设 `APP_DATA_DIR` 到临时目录），照搬同一套；本仓库 dev 态数据目录就是仓库根，不隔离会污染真实 `memory-bank.json`。

- [ ] **Step 2：跑测试确认失败**

```bash
node --test src/features/memory-bank/synthesize.test.js
```
预期：三条都 FAIL。

- [ ] **Step 3：`buildSynthesisPrompt` 增加 scope 段**

函数签名的 opts 增加 `projectDir`，在「字段说明」段后插入 scope 说明块：

```js
export function buildSynthesisPrompt(findings, opts = {}) {
  const list = Array.isArray(findings) ? findings : [];
  const projectDir = String(opts.projectDir || '').trim();
  // ...（items / existing / existingBlock 部分不变）

  // 本批 findings 的来源工程。切批时已按工程分组，所以一批只对应一个目录。
  const scopeBlock = projectDir
    ? [
        '',
        `本批 findings 全部来自工程：${projectDir}`,
        '',
        '请给每条记忆判定 scope：',
        '- "global"：跨项目通用的工作方式、沟通偏好、调试习惯。换一个技术栈、换一个项目依然成立。',
        '- "project"：只在本工程成立的技术知识 —— 特定框架的坑、本项目的目录约定、',
        '  本项目依赖库的用法、某个平台运行时的限制。',
        '',
        '判据：把这条记忆念给一个正在做完全不同项目（不同语言、不同框架）的工程师听，',
        '他会觉得有用还是莫名其妙？有用 → global，莫名其妙 → project。',
        '拿不准时选 "project"：错判成 global 会污染其它所有项目的每一次对话，',
        '错判成 project 只是少注入一次，代价小得多。',
      ]
    : [];

  return [
    // ...（前面各段不变，在「字段说明」之后插入）
    '字段说明：',
    '- explicit：true 表示用户明确说过这条规矩；false 表示从行为推断。',
    '  这个字段决定注入优先级 —— 判错会让真正的硬性要求被推断出来的条目挤掉，务必如实填。',
    '- strength："strong" 表示跨多个会话反复出现；"normal" 表示证据较少。',
    ...scopeBlock,
    '',
    '硬约束：',
    // ...（其余不变）
  ].join('\n');
}
```

同时把输出格式示例行改为带 scope：

```js
    '{"memories":[{"category":"tech-pref","statement":"具体规则描述",'
      + '"reasoning":"为什么值得记住（可选）","explicit":true,"strength":"strong","scope":"project"}]}',
```

- [ ] **Step 4：`sanitizeMemories` 收 scope**

在 `out.push({...})` 前增加一行，并把 scope 加进产出对象：

```js
    // 非 'project' 一律回落 global：模型偶尔回 'Project'/'PROJECT'/中文，
    // 宽松匹配会让本该全局的条目掉进某个工程里，用户在别处再也看不到它。
    const scope = String(item.scope || '').trim().toLowerCase() === 'project' ? 'project' : 'global';
    out.push({ category, statement: statement.slice(0, MAX_STATEMENT), reasoning,
      explicit, evidenceCount, scope });
```

- [ ] **Step 5：`synthesizeMemories` 接收并写入 projectDir**

```js
export async function synthesizeMemories(findings, opts = {}) {
  if (!Array.isArray(findings) || findings.length === 0) return [];

  const { model, _runner = runClassifierOnce, existingStatements, projectDir = '' } = opts;

  const json = await _runner({
    prompt: buildSynthesisPrompt(findings, { existingStatements, projectDir }),
    model: model || config.intent.classifyModel,
    logTag: 'memory-bank/synthesize',
    timeoutMs: SYNTHESIS_TIMEOUT_MS,
    cwd: classifyCwd(), // 空目录：本调用不读任何文件，项目上下文只会拖慢并带偏输出
  });

  if (!json) {
    logger.warn('memory-bank', '合成调用无结果（超时/额度/解析失败）');
    return null;
  }

  const candidates = sanitizeMemories(json);
  const written = [];

  for (const c of candidates) {
    const at = Date.now();
    const memory = {
      id: `mem_${at}_${Math.random().toString(36).slice(2, 7)}`,
      category: c.category,
      statement: c.statement,
      reasoning: c.reasoning,
      createdAt: at,
      source: 'synthesized',
      explicit: c.explicit,
      evidenceCount: c.evidenceCount,
      lastSeenAt: at,
      status: 'active',
      inject: true,
      scope: c.scope,
      // 只有 project 域才带目录。global 条目留空串，否则 render 的 scope 过滤
      // 会把它误当成某个工程的条目（那里比对的是 projectDir 是否相等）。
      projectDir: c.scope === 'project' ? projectDir : '',
    };
    try {
      addMemory(memory);
      written.push(memory);
    } catch (e) {
      logger.warn('memory-bank', '写入 memory 失败', { id: memory.id, err: e?.message });
    }
  }

  return written;
}
```

- [ ] **Step 6：跑测试确认通过**

```bash
node --test src/features/memory-bank/synthesize.test.js && npm test 2>&1 | tail -20
```
预期：全部 PASS。

---

## Task 8：`index.js` 逐批传 projectDir、`writeRenders` 传真实 projectDirs

**Files:**
- Modify: `src/features/memory-bank/index.js`（Phase 2 循环约 169-191 行、`writeRenders` 调用约 199 行）

- [ ] **Step 1：Phase 2 循环传 projectDir**

```js
      const got = await synthesizeMemories(batch.findings, {
        model, _runner, existingStatements, projectDir: batch.projectDir,
      });
```

- [ ] **Step 2：收集真实 projectDirs 传给 writeRenders**

把 `const renders = await writeRenders(...)` 那几行替换为：

```js
    bank = readBank();
    const memories = bank.memories || [];
    // 项目级渲染的目标目录 = 库里所有 project 域条目涉及的工程。
    // 早先这里硬编码成 `[]`，于是 writeRenders 的项目分支永远跑不到，
    // 工程级 .claude/memory-bank.md 从来没被生成过（2026-09-18 实测缺陷）。
    const projectDirs = [...new Set(
      memories.filter((m) => m.scope === 'project' && m.projectDir).map((m) => m.projectDir)
    )];
    const renders = await writeRenders(memories, { now, settings, projectDirs });
```

- [ ] **Step 3：`routes-memory.js` 的两处 writeRenders 同步改**

`handleRemove`（约 259 行）等处也硬编码了 `projectDirs: []`。抽一个共用函数避免三处各写一遍——在 `memory-bank/index.js` 导出：

```js
/**
 * 从记忆条目里归纳出需要渲染项目级文件的工程目录列表。
 * 渲染落盘有三个调用点（定时提炼 / 手动移除 / 开关注入），口径必须一致，
 * 否则某个入口漏算目录会让那个工程的 memory-bank.md 停在旧内容上。
 */
export function collectProjectDirs(memories) {
  return [...new Set(
    (memories || []).filter((m) => m.scope === 'project' && m.projectDir).map((m) => m.projectDir)
  )];
}
```

`index.js` 的 Step 2 改用它：

```js
    const projectDirs = collectProjectDirs(memories);
```

`routes-memory.js` 的 import 与调用：

```js
import { runOnce, isRunning, stopOnce, writeRenders, collectProjectDirs } from '../../features/memory-bank/index.js';
```

```js
      const bank = readBank();
      const settings = getMemoryBankSettings();
      const memories = bank.memories || [];
      await writeRenders(memories, { now: Date.now(), settings, projectDirs: collectProjectDirs(memories) });
```

- [ ] **Step 4：验证**

```bash
npm test 2>&1 | tail -20
```
预期：无新增失败。

- [ ] **Step 5：人工验收（阶段 B 交付点）**

1. `npm start`，面板点「立即提炼」
2. 检查 `~/.claude/memory-bank.md`：应只剩跨项目偏好，条数明显下降
3. 检查某个近期活跃工程的 `<工程>/.claude/memory-bank.md`：应出现该工程专属条目
4. 检查该工程的 `CLAUDE.md`：应被追加一行 `@.claude/memory-bank.md`
5. **注意**：项目级文件会写进用户的其它工程目录。先在一个可丢弃的工程上验证，确认 `ensureImport` 只追加不改写。

---

# 阶段 C · 注入预览与逐条开关（方向③）

## Task 9：inject 开关的 store 与接口

**Files:**
- Modify: `src/entrypoints/web/routes-memory.js`
- Test: `src/entrypoints/web/routes-memory.test.js`

- [ ] **Step 1：实现 handler**

`store/memory-bank.js` 的 `patchMemory` 已经够用，不需要改 store。在 `routes-memory.js` 追加：

```js
// ==== POST /api/memory/inject {id, inject} ====
// 关掉注入不删除条目：用户可能只是暂时不想要，证据链与内容都该留着。
async function handleInject(req, res) {
  return withJsonBody(req, res, async (data) => {
    const id = str(data.id);
    if (!id) return sendJson(res, 400, { ok: false, error: 'id required' });
    if (typeof data.inject !== 'boolean') {
      return sendJson(res, 400, { ok: false, error: 'inject 必须是布尔值' });
    }
    try {
      patchMemory(id, { inject: data.inject });
      const bank = readBank();
      const settings = getMemoryBankSettings();
      const memories = bank.memories || [];
      // 立刻重渲染：开关的意义就是「马上别注入了」，等下一轮定时提炼才生效等于没生效
      await writeRenders(memories, { now: Date.now(), settings, projectDirs: collectProjectDirs(memories) });
      sendJson(res, 200, { ok: true });
    } catch (e) {
      logger.error('memory-routes', '切换注入开关异常', { id, err: e?.message || String(e) });
      sendJson(res, 500, { ok: false, error: e?.message || String(e) });
    }
  });
}
```

补 import（`patchMemory` 来自 store）：

```js
import { readBank, removeMemory, patchMemory } from '../../store/memory-bank.js';
```

> 执行前先核对 `routes-memory.js` 顶部既有的 store import 行，把 `patchMemory` 合并进去而不是新加一行重复 import。

- [ ] **Step 2：注册路由**

在 `handleMemoryRoutes` 的 `remove` 那行下方插入：

```js
  if (pathname === '/api/memory/inject' && method === 'POST') return handleInject(req, res);
```

- [ ] **Step 3：验证**

```bash
npm test 2>&1 | tail -20
```

---

## Task 10：注入预览接口

**Files:**
- Modify: `src/entrypoints/web/routes-memory.js`
- Test: `src/entrypoints/web/routes-memory.test.js`

- [ ] **Step 1：写失败测试**

`routes-memory.test.js` 既有用例已有纯函数测试的范式（`sessionDisplayStatus` / `groupSessionsForPanel`）。预览的取舍逻辑同样抽成可测纯函数：

```js
test('buildInjectionPreview 分 scope 汇总入选与截断', () => {
  const now = Date.now();
  const memories = [
    { category: 'collaboration', statement: 'g1', scope: 'global',  createdAt: now, explicit: true },
    { category: 'code-style',    statement: 'p1', scope: 'project', projectDir: 'C:\\a', createdAt: now },
    { category: 'writing',       statement: 'off', scope: 'global', inject: false, createdAt: now },
  ];
  const out = buildInjectionPreview(memories, { now, maxItems: 40, maxChars: 3000 });
  assert.equal(out.global.included.length, 1);
  assert.equal(out.global.included[0].statement, 'g1');
  assert.equal(out.projects.length, 1);
  assert.equal(out.projects[0].projectDir, 'C:\\a');
  assert.equal(out.projects[0].included.length, 1);
});
```

- [ ] **Step 2：跑测试确认失败**

```bash
node --test src/entrypoints/web/routes-memory.test.js
```
预期：FAIL，`buildInjectionPreview is not defined`。

- [ ] **Step 3：实现并导出纯函数**

在 `routes-memory.js` 追加（`export` 出来供测试直接调用，与 `groupSessionsForPanel` 同一范式）：

```js
/**
 * 纯函数。算出「当前会注入进 CLAUDE.md 的到底是哪些条目」。
 *
 * 面板此前只显示库里有多少条，用户据此以为全都生效了；实际预算截断掉的部分
 * 只写进日志（`truncated`），界面上毫无痕迹 —— 这正是「规则明明记下了却不起作用」
 * 这类问题最难排查的原因。预览把这层不可见状态摊开。
 *
 * @param {Array} memories bank.memories
 * @param {{now:number, maxItems:number, maxChars:number}} budget
 * @returns {{global:{included:Array,truncated:number}, projects:Array<{projectDir:string,included:Array,truncated:number}>}}
 */
export function buildInjectionPreview(memories, budget) {
  const list = memories || [];
  const global = selectForInjection(list, { scope: 'global', ...budget });

  const dirs = [...new Set(
    list.filter((m) => m.scope === 'project' && m.projectDir).map((m) => m.projectDir)
  )];
  const projects = dirs.map((projectDir) => ({
    projectDir,
    ...selectForInjection(list, { scope: 'project', projectDir, ...budget }),
  }));

  return { global, projects };
}

// ==== GET /api/memory/preview ====
function handlePreview(res) {
  try {
    const bank = readBank();
    const settings = getMemoryBankSettings();
    const preview = buildInjectionPreview(bank.memories || [], {
      now: Date.now(), maxItems: settings.maxItems, maxChars: settings.maxChars,
    });
    sendJson(res, 200, {
      ok: true,
      budget: { maxItems: settings.maxItems, maxChars: settings.maxChars },
      // 只回 id + statement + category：前端要的是「哪些进了」，整条对象徒增传输量
      global: {
        included: preview.global.included.map(pickPreviewFields),
        truncated: preview.global.truncated,
      },
      projects: preview.projects.map((p) => ({
        projectDir: p.projectDir,
        included: p.included.map(pickPreviewFields),
        truncated: p.truncated,
      })),
    });
  } catch (e) {
    logger.error('memory-routes', '注入预览异常', { err: e?.message || String(e) });
    sendJson(res, 500, { ok: false, error: e?.message || String(e) });
  }
}

function pickPreviewFields(m) {
  return { id: m.id, category: m.category, statement: m.statement };
}
```

补 import：

```js
import { selectForInjection } from '../../features/memory-bank/render.js';
```

- [ ] **Step 4：注册路由**

```js
  if (pathname === '/api/memory/preview' && method === 'GET') return handlePreview(res);
```

- [ ] **Step 5：跑测试确认通过**

```bash
node --test src/entrypoints/web/routes-memory.test.js && npm test 2>&1 | tail -20
```

---

## Task 11：前端预览区段与逐条开关

**Files:**
- Modify: `public/js/memory-view.js`
- Modify: `public/css/`（找到定义 `.mem-memory-item` 的文件，在同处追加新样式）

- [ ] **Step 1：定位样式文件**

```bash
rg -n "mem-memory-item" public/css/
```
新样式追加到同一文件，沿用 `mem-` 前缀。

- [ ] **Step 2：模块级状态与拉取**

在 `memory-view.js` 既有模块级变量旁增加：

```js
let _preview = null;   // { budget, global, projects }
```

在 `refresh()` 里并行拉预览（`refresh` 已有 `api('/api/memory/sessions')` 调用，在其后追加）：

```js
    // 预览失败不阻断主面板：它是辅助信息，拿不到就当没有
    try {
      _preview = await (await fetch('/api/memory/preview')).json();
    } catch { _preview = null; }
```

- [ ] **Step 3：渲染预览区段**

在 `render()` 的「已记忆区段」之前插入：

```js
  // ---- 注入状态区段 ----
  if (_preview?.ok) {
    const injected = _preview.global.included.length;
    const cut = _preview.global.truncated;
    frag.appendChild(makeSectionLabel(
      `正在注入全局 CLAUDE.md（${injected} 条${cut > 0 ? `，${cut} 条超预算未注入` : ''}）`
    ));
    if (cut > 0) {
      frag.appendChild(makeHint(
        `预算上限 ${_preview.budget.maxItems} 条 / ${_preview.budget.maxChars} 字符。`
        + '超出的条目不会进 CLAUDE.md —— 关掉一些不需要的条目可以让其它条目补位。'
      ));
    }
    for (const p of _preview.projects) {
      frag.appendChild(makeHint(
        `${shortPath(p.projectDir)}：注入 ${p.included.length} 条`
        + `${p.truncated > 0 ? `，${p.truncated} 条超预算` : ''}`
      ));
    }
  }
```

- [ ] **Step 4：记忆行加注入标记与开关**

`makeMemoryRow(m)` 里，在「移除」按钮之前插入：

```js
  // 注入开关。默认 true（存量条目没有 inject 字段，等同开启）
  const on = m.inject !== false;

  const toggle = document.createElement('button');
  toggle.className = on ? 'mem-inject-btn mem-inject-btn--on' : 'mem-inject-btn';
  toggle.textContent = on ? '已注入' : '不注入';
  toggle.title = on ? '点击停止把这条注入 CLAUDE.md（条目保留）' : '点击恢复注入';
  toggle.onclick = async () => {
    toggle.disabled = true;
    try {
      await api('/api/memory/inject', { id: m.id, inject: !on });
      await refresh();
    } catch (e) {
      window.toast?.error(e.message);
      toggle.disabled = false;
    }
  };
  row.appendChild(toggle);

  // scope 标记：让用户一眼看出这条是全局生效还是只在某个工程生效
  if (m.scope === 'project' && m.projectDir) {
    const tag = document.createElement('span');
    tag.className = 'mem-memory-scope';
    tag.textContent = shortPath(m.projectDir);
    tag.title = `仅在 ${m.projectDir} 生效`;
    body.appendChild(tag);
  }
```

> `shortPath` 已在本文件定义（约 424 行），直接复用。`body.appendChild(tag)` 要放在 `row.appendChild(body)` **之前**——按现有代码顺序，`body` 在第 279 行就已挂上 `row`，所以 scope 标记那段必须插在第 279 行之前。执行时留意这个顺序。

- [ ] **Step 5：补样式**

```css
.mem-inject-btn {
  font-size: 12px; padding: 2px 8px; border-radius: 4px;
  border: 1px solid var(--border, #d0d0d0); background: transparent;
  color: var(--text-muted, #888); cursor: pointer;
}
.mem-inject-btn--on { color: var(--accent, #2d7); border-color: currentColor; }
.mem-memory-scope {
  font-size: 11px; padding: 1px 6px; margin-left: 6px; border-radius: 3px;
  background: var(--bg-subtle, #f0f0f0); color: var(--text-muted, #888);
}
```

> 变量名要对齐项目既有 CSS 变量。先 `rg -n "^\s*--" public/css/ | head -30` 看实际定义，再套用；上面的 fallback 值只是兜底。

- [ ] **Step 6：人工验收（阶段 C 交付点）**

1. `npm start`，打开记忆库面板
2. 顶部应显示「正在注入全局 CLAUDE.md（N 条）」，超预算时显示未注入条数
3. 点某条的「已注入」→ 变「不注入」→ 检查 `~/.claude/memory-bank.md` 该条应消失
4. 再点回来 → 该条应恢复
5. project 域条目应显示工程目录标记

---

# 阶段 D · 淘汰与合并（方向④）

## Task 12：移除即拉黑，不再复活

**Files:**
- Modify: `src/store/memory-bank.js`
- Modify: `src/entrypoints/web/routes-memory.js`（`handleRemove`）
- Modify: `src/features/memory-bank/index.js`（Phase 2 传黑名单）
- Modify: `src/features/memory-bank/synthesize.js`（prompt 下发黑名单）
- Test: `src/store/memory-bank.test.js`、`src/features/memory-bank/synthesize.test.js`

- [ ] **Step 1：写失败测试（store）**

```js
test('blacklist：移除后记入，readBank 能读回', () => {
  addBlacklist('不要再提这条');
  assert.ok(readBank().blacklist.includes('不要再提这条'));
});

test('blacklist 去重且有上限', () => {
  addBlacklist('同一条'); addBlacklist('同一条');
  assert.equal(readBank().blacklist.filter(s => s === '同一条').length, 1);
});
```

> 用 `APP_DATA_DIR` 隔离到临时目录，照搬 `memory-bank.test.js` 既有用例的隔离写法。

- [ ] **Step 2：跑测试确认失败**

```bash
node --test src/store/memory-bank.test.js
```

- [ ] **Step 3：store 支持 blacklist**

`EMPTY_BANK` 增加字段：

```js
export const EMPTY_BANK = {
  version: 2,
  lastExtractAt: 0,
  lastSessionScanAt: 0,
  sessions: [],
  memories: [],
  blacklist: [],  // 用户移除过的 statement 原文，合成时下发给模型让它别再产出
};
```

`readBank` 的返回体增加：

```js
    blacklist: Array.isArray(b.blacklist) ? b.blacklist : [],
```

`writeBank` 与 `updateBank` 的归一体同样各增加一行：

```js
      blacklist: Array.isArray(bank.blacklist) ? bank.blacklist : [],
```

```js
      blacklist: Array.isArray(next.blacklist) ? next.blacklist : [],
```

新增 API：

```js
/** 黑名单容量上限。它会随 prompt 下发，无限增长会把批预算吃光。 */
const MAX_BLACKLIST = 50;

/**
 * 把一条 statement 记入黑名单（幂等）。
 * 用户点「移除」意味着「这条不对/没用」，而合成器下一轮看到同样的证据会原样再产一遍 ——
 * 不记下来的话，用户要反复删同一条（v1 有这个机制，v2 迁移时丢了）。
 * @param {string} statement
 */
export function addBlacklist(statement) {
  const s = String(statement || '').trim();
  if (!s) return;
  updateBank((bank) => {
    if (bank.blacklist.includes(s)) return undefined; // 已有，放弃写盘
    return { ...bank, blacklist: [...bank.blacklist, s].slice(-MAX_BLACKLIST) };
  });
}
```

- [ ] **Step 4：`handleRemove` 先拉黑再删**

```js
    try {
      // 顺序要紧：先读出 statement 再删，删完就拿不到内容了
      const target = getMemory(id);
      if (target?.statement) addBlacklist(target.statement);
      removeMemory(id);
      const bank = readBank();
      const settings = getMemoryBankSettings();
      const memories = bank.memories || [];
      await writeRenders(memories, { now: Date.now(), settings, projectDirs: collectProjectDirs(memories) });
      sendJson(res, 200, { ok: true });
    } catch (e) {
```

补 import：`getMemory`、`addBlacklist`。

- [ ] **Step 5：prompt 下发黑名单**

`buildSynthesisPrompt` 的 opts 增加 `blacklist`，在 `existingBlock` 之后插入：

```js
  const banned = (Array.isArray(opts.blacklist) ? opts.blacklist : [])
    .map((s) => String(s || '').trim()).filter(Boolean);
  const bannedBlock = banned.length
    ? ['', '用户明确否决过以下条目，不要再产出它们，也不要换个说法重说：',
       ...banned.map((s) => `- ${s}`), '']
    : [];
```

并加进返回数组（紧跟 `...existingBlock` 之后）：

```js
    ...existingBlock,
    ...bannedBlock,
```

- [ ] **Step 6：`synthesizeMemories` 与 `index.js` 透传**

`synthesizeMemories` 的解构增加 `blacklist`，并传进 `buildSynthesisPrompt`：

```js
  const { model, _runner = runClassifierOnce, existingStatements, projectDir = '', blacklist } = opts;

  const json = await _runner({
    prompt: buildSynthesisPrompt(findings, { existingStatements, projectDir, blacklist }),
```

`index.js` 的 Phase 2 循环：

```js
    const blacklist = bank.blacklist || [];
```
（放在 `existingStatements` 定义旁），调用处：

```js
      const got = await synthesizeMemories(batch.findings, {
        model, _runner, existingStatements, projectDir: batch.projectDir, blacklist,
      });
```

- [ ] **Step 7：验证**

```bash
npm test 2>&1 | tail -20
```

---

## Task 13：时效衰减（dormant）

**Files:**
- Modify: `src/features/memory-bank/index.js`（`runOnce` 渲染前）
- Modify: `src/features/memory-bank/render.js`（复用既有 dormant 过滤，无需改）
- Test: `src/features/memory-bank/render.test.js`

- [ ] **Step 1：写失败测试**

```js
test('applyMemoryDormancy：超期条目转 dormant，新条目不动', () => {
  const now = Date.now();
  const DAY = 86400000;
  const out = applyMemoryDormancy([
    { id: 'a', statement: '旧', status: 'active', lastSeenAt: now - 100 * DAY },
    { id: 'b', statement: '新', status: 'active', lastSeenAt: now - 10 * DAY },
    { id: 'c', statement: '缺字段', status: 'active', createdAt: now - 10 * DAY },
  ], { now, dormantDays: 90 });
  assert.equal(out.find(m => m.id === 'a').status, 'dormant');
  assert.equal(out.find(m => m.id === 'b').status, 'active');
  assert.equal(out.find(m => m.id === 'c').status, 'active'); // 回落 createdAt，不误杀
});
```

- [ ] **Step 2：跑测试确认失败**

```bash
node --test src/features/memory-bank/render.test.js
```

- [ ] **Step 3：实现（放 `render.js`，与 `weight` 的时效口径同处）**

```js
/** 多久没有新证据就转休眠。与 weight() 的 60 天半衰期同一套时效直觉，留出余量。 */
export const DORMANT_DAYS = 90;

/**
 * 纯函数。把超期无新证据的条目转 dormant：停止注入但**保留全部数据**。
 *
 * 为什么不直接删：条目可能只是这阵子没用上（换了个项目做），数据还有价值
 * （导出档案、日后同样的偏好再出现时可以复活）。注入预算是稀缺资源，
 * 库容量不是 —— 该省的是前者。
 *
 * @param {Array} memories
 * @param {{now:number, dormantDays?:number}} opts
 * @returns {Array} 新数组，超期条目的 status 改为 'dormant'
 */
export function applyMemoryDormancy(memories, { now, dormantDays = DORMANT_DAYS }) {
  const limit = dormantDays * DAY_MS;
  return (memories || []).map((m) => {
    if (m.status !== 'active') return m;
    // lastSeenAt 缺失时回落 createdAt：存量条目没有这个字段，
    // 当成 0 会让它们全部立刻休眠 —— 用户会看到记忆一夜之间全部失效。
    const seen = m.lastSeenAt || m.createdAt || 0;
    if (!seen) return m;
    return now - seen > limit ? { ...m, status: 'dormant' } : m;
  });
}
```

- [ ] **Step 4：在 `runOnce` 渲染前落盘休眠状态**

`index.js` 的渲染段之前插入：

```js
    // 休眠判定必须落盘而非只在渲染时算：面板要显示哪些条目已休眠，
    // 只在内存里算的话界面和实际注入内容会对不上。
    bank = readBank();
    const aged = applyMemoryDormancy(bank.memories || [], { now });
    for (const m of aged) {
      const before = (bank.memories || []).find((x) => x.id === m.id);
      if (before && before.status !== m.status) patchMemory(m.id, { status: m.status });
    }
```

补 import：

```js
import { renderMarkdown, applyMemoryDormancy } from './render.js';
import { readBank, updateBank, addSession, patchSession, patchMemory } from '../../store/memory-bank.js';
```

- [ ] **Step 5：验证**

```bash
node --test src/features/memory-bank/render.test.js && npm test 2>&1 | tail -20
```

- [ ] **Step 6：人工验收（阶段 D 交付点）**

1. 面板移除一条记忆 → 再点「立即提炼」→ 该条不应重新出现
2. `node -e` 直接读 `memory-bank.json` 确认 `blacklist` 有记录
3. dormant 需要 90 天才能自然触发，改 `DORMANT_DAYS` 临时调小验证后改回

---

## 自检

**规格覆盖：**

| 需求 | 落点 |
|---|---|
| 方向② 提炼门槛 | Task 1（负面清单）、Task 2（字段落库） |
| 排序随机缺陷 | Task 3（`normalizeMem` 只补不覆盖 + 无条件归一） |
| 方向① 分域注入 | Task 4-8（抽 cwd → 分组切批 → 判 scope → 真实 projectDirs） |
| 方向③ 预览与开关 | Task 9（开关接口）、Task 10（预览接口）、Task 11（前端） |
| 方向④ 淘汰合并 | Task 12（黑名单）、Task 13（dormant） |
| 存量向后兼容 | Task 3 的 `normalizeMem` 默认值、Task 13 的 `lastSeenAt` 回落 |

**已知未覆盖：** 用户选的方向④里「同类合并」（例如现有第 3 条和第 4 条说的是同一件事）没有单独任务。原因是它需要语义相似度判定，可靠做法是靠 Task 1 的 prompt 门槛 + 既有 `existingStatements` 去重在**产出端**拦截，而不是在存量上做合并——后者要么引入向量检索（超出本次范围），要么让模型两两比对（成本随条数平方增长）。若 Task 1 上线后存量重复仍明显，再单开一轮处理。

**类型一致性核对：**
- `collectProjectDirs` 在 Task 8 定义、Task 9 复用，签名一致
- `buildInjectionPreview` 在 Task 10 定义并导出，测试与 handler 用同一签名
- `applyMemoryDormancy` 在 Task 13 定义于 `render.js`，`index.js` import 同名
- `addBlacklist` / `getMemory` 在 Task 12 定义于 store，routes 侧 import 同名
- memory 条目字段在「数据模型变更」集中定义，Task 2/7/9/13 分别写入 `explicit`+`evidenceCount` / `scope`+`projectDir` / `inject` / `status`，无命名分歧
