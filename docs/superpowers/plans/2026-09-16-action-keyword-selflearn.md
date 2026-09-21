# 动作关键词自学习 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让飞书机器人把「花了一次 LLM 才认出来的动作说法」沉淀成关键词写回动作配置，下次同样的说法走 L2 本地匹配秒出，且新增关键词绝不干扰其他动作的识别。

**Architecture:** L3 语义分类命中 action 时打 `via:'llm'` 标记 → action-runner 在槽位填充链上透传触发原句 → 脚本执行成功后 fire-and-forget 调一次 haiku 提候选词 → 本地纯函数硬闸七条逐条把关（双向子串冲突检查是核心）→ store 在文件锁内原子写入 `keywords[]` + `autoKeywords[]` → web 面板标识「·自动」，人工删除即进 `rejectedKeywords[]` 永不再学。

**Tech Stack:** Node ESM、`node --test` 单测、`capabilities/llm-classify.js`（haiku 单轮零工具）、`store/index.js`（跨进程文件锁 + 原子写）。

**设计文档：** `docs/superpowers/specs/2026-09-16-action-keyword-selflearn-design.md`

**⚠️ 项目约定（覆盖 skill 默认行为）：本项目不自动 git 提交**（根 `CLAUDE.md`「协作约定」）。因此每个任务的收尾步骤是**跑测试验证**，改动一律留在工作区，提交时机由维护者掌控。

---

## 文件结构

| 文件 | 职责 | 类型 |
|---|---|---|
| `src/plugins/action-runner/feature/keyword-guard.js` | 硬闸纯函数：候选词能不能学 | 新增 |
| `src/plugins/action-runner/feature/keyword-guard.test.js` | 硬闸七条规则单测 | 新增 |
| `src/plugins/action-runner/feature/learn-keywords.js` | 学习管线：拼 prompt → 调模型 → 过闸 → 写盘 | 新增 |
| `src/plugins/action-runner/feature/learn-keywords.test.js` | 管线编排单测（依赖注入，不联网不写盘） | 新增 |
| `src/store/action-configs.js` | 新增 `appendAutoKeyword`（锁内原子）+ `reconcileAutoKeywords`（纯函数对账） | 改 |
| `src/store/action-configs.test.js` | 上述两函数单测 | 改 |
| `src/app/intent.js` | L3 action 分支加 `via:'llm'` | 改 |
| `src/app/intent.test.js` | 回归：L2 命中不带 `via` | 改 |
| `src/plugins/action-runner/feature/index.js` | `setPending` 继承 `learnSrc`、执行成功触发学习 | 改 |
| `src/plugins/action-runner/feature/index.test.js` | 触发条件单测（成功才学 / 无 via 不学 / 失败不学） | 改 |
| `src/entrypoints/web/routes-ops.js` | `handleActionsPut` 保存时对账 | 改 |
| `public/js/actions-panel.js` | 自动词标「·自动」 | 改 |
| `src/app/CLAUDE.md` / `src/plugins/CLAUDE.md` / `src/store/CLAUDE.md` | 同步模块地图 | 改 |

任务顺序即依赖顺序：Task 1（纯函数）→ Task 2（store）→ Task 3（intent 标记）→ Task 4（管线）→ Task 5（接线）→ Task 6/7（面板闭环）→ Task 8（文档）。Task 1–4 各自独立可测，Task 5 才把链路接通。

---

### Task 1: 硬闸纯函数 `keyword-guard.js`

**Files:**
- Create: `src/plugins/action-runner/feature/keyword-guard.js`
- Test: `src/plugins/action-runner/feature/keyword-guard.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/plugins/action-runner/feature/keyword-guard.test.js`：

```js
/**
 * 关键词自学习硬闸单测 —— 七条规则逐条钉死。
 *
 * 重点是规则 5（双向子串冲突）的**两个方向**：只查一边等于留一半的洞，
 * 而漏掉的那一半会让别的动作从「L2 秒出」退化成「L3 花钱等几秒」，用户完全看不出原因。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canLearnKeyword, MAX_AUTO_KEYWORDS } from './keyword-guard.js';

const ACTION = {
  id: 'ac_clean',
  botId: 'bot_t',
  name: '清理测试数据',
  keywords: ['清一下'],
  autoKeywords: [],
  rejectedKeywords: [],
};

const OTHERS = [
  { id: 'ac_qr', botId: 'bot_t', name: '获取二维码', keywords: ['二维码', '重置密码'] },
  { id: 'ac_deploy', botId: 'bot_t', name: '部署', keywords: ['清理缓存'] },
];

/** 用例默认上下文：原句一定包含候选词，好让规则 1 不误伤其他规则的用例 */
function ask(word, o = {}) {
  return canLearnKeyword({
    word,
    action: o.action || ACTION,
    otherActions: o.otherActions || OTHERS,
    sourceText: o.sourceText ?? `帮我${word}好吗`,
  });
}

test('规则 1：候选词不是原句的连续片段 → 拒（防模型凭空造词）', () => {
  const r = canLearnKeyword({
    word: '重置测试环境',
    action: ACTION,
    otherActions: [],
    sourceText: '帮我把测试环境的数据清掉',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-in-source');
});

test('规则 2：纯中文 2 字太泛 → 拒；3 字放行', () => {
  assert.equal(ask('清掉').reason, 'too-short');
  assert.equal(ask('清掉数').ok, true);
});

test('规则 2：含英文数字的候选词少于 4 字符 → 拒', () => {
  assert.equal(ask('qr码').reason, 'too-short');
});

test('规则 2：超过 12 字的候选词 → 拒（学了也不会再命中第二次）', () => {
  assert.equal(ask('把测试环境里所有的业务数据都清理干净').reason, 'too-long');
});

test('规则 3：通用停用词 → 拒', () => {
  // 刻意用 3 字以上的停用词：2 字的（帮我 / 一下 / 数据）会先被长度闸判 too-short，
  // 走不到这一条。黑名单里保留它们只是防线冗余（万一日后有人调低长度门槛）。
  assert.equal(ask('能不能').reason, 'stop-word');
  assert.equal(ask('下午好').reason, 'stop-word');
});

test('规则 4：命中 L1 强前缀词表 → 拒（否则「提交需求：…」会被动作抢走）', () => {
  const r = canLearnKeyword({
    word: '提交需求',
    action: ACTION,
    otherActions: [],
    sourceText: '提交需求单的入口在哪',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'strong-intent-prefix');
});

test('规则 5 正向：候选词包含其他动作的关键词 → 拒', () => {
  // 「清理缓存数据」含 ac_deploy 的「清理缓存」：今后这句话会同时命中两个动作，
  // L2 多命中 → 退回 L3，把原本秒出的部署动作也拖慢了。
  const r = ask('清理缓存数据');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conflict:ac_deploy');
});

test('规则 5 反向：其他动作的关键词包含候选词 → 拒', () => {
  // 候选「重置密」被 ac_qr 的「重置密码」包含：今后「帮我重置密码」会同时命中两边。
  const r = ask('重置密');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conflict:ac_qr');
});

test('规则 5：只与**其他**动作比，本动作自己的 id 要跳过', () => {
  // otherActions 里混进本动作自己（调用方可能没过滤干净），不该因此自我冲突
  const r = ask('清掉业务表', { otherActions: [...OTHERS, ACTION] });
  assert.equal(r.ok, true);
});

test('规则 6：与本动作已有关键词互为子串 → 冗余不加', () => {
  const r = canLearnKeyword({
    word: '清一下数据',
    action: ACTION,
    otherActions: [],
    sourceText: '帮我清一下数据',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'redundant');
});

test('规则 6：自动词配额已满 → 拒', () => {
  const full = {
    ...ACTION,
    autoKeywords: Array.from({ length: MAX_AUTO_KEYWORDS }, (_, i) => ({ word: `词${i}` })),
  };
  assert.equal(ask('清掉业务表', { action: full }).reason, 'quota-full');
});

test('规则 7：用户删过的词不再学回来（撤销必须永久有效）', () => {
  const withRejected = { ...ACTION, rejectedKeywords: ['清掉业务表'] };
  assert.equal(ask('清掉业务表', { action: withRejected }).reason, 'rejected-before');
});

test('全部通过的正常候选词 → 放行', () => {
  const r = canLearnKeyword({
    word: '清掉业务表',
    action: ACTION,
    otherActions: OTHERS,
    sourceText: '帮我把 test 的清掉业务表吧',
  });
  assert.deepEqual(r, { ok: true, reason: '' });
});

test('空词 / 空白词 → 拒', () => {
  assert.equal(canLearnKeyword({ word: '  ', action: ACTION, sourceText: 'x' }).reason, 'empty');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/plugins/action-runner/feature/keyword-guard.test.js
```

预期：FAIL，`Cannot find module './keyword-guard.js'`。

- [ ] **Step 3: 实现硬闸**

创建 `src/plugins/action-runner/feature/keyword-guard.js`：

```js
/**
 * 动作关键词自学习的本地硬闸（纯函数）。
 *
 * 模型提的候选词说了不算 —— 最终裁决全在这里。理由：L2 匹配（`消息.includes(关键词)`）
 * 是**全局共享的资源**，给 A 动作加一个词可能让 B 动作原本秒出的消息变成多命中而退回 L3。
 * 这种伤害对用户不可见、对提词的模型更不可见，只能靠确定性规则挡。
 *
 * ⚠️ 依赖纪律：本文件只许 import `app/intent-keywords.js` —— 它是刻意允许的零依赖叶子
 * （见 `src/app/CLAUDE.md` §C，`src/import-graph.test.js` 有测试钉住它保持零 import）。
 * **不得** import `app/intent.js` 的 `isChitchat`：那个文件依赖 llm-classify 与 store，
 * 引进来是把整条分类链拖进插件层的真实反向依赖。寒暄拦截由长度闸 + 黑名单承担
 * （常见寒暄本就 2 字：你好 / 在吗 / 谢谢，长度闸已经卡掉）。
 */
import { matchStrongIntent } from '../../../app/intent-keywords.js';

/** 每个动作最多自动学 5 个词：够覆盖常见说法，又不至于让关键词表膨胀到没人看得懂 */
export const MAX_AUTO_KEYWORDS = 5;

/** 纯中文候选词的最短长度：2 字词（「清理」「重置」）语义太弱，必然泛命中 */
const MIN_LEN_CJK = 3;
/** 含英文 / 数字的候选词最短长度 */
const MIN_LEN_MIXED = 4;
/** 候选词最长长度：再长的说法学了也不会再命中第二次，白占配额 */
const MAX_LEN = 12;

/**
 * 通用停用词 + 寒暄词黑名单。
 * 寒暄放在这里而不是调 `intent.js` 的 `isChitchat`，理由见文件头的依赖纪律；
 * 这里只需补 3 字以上的少数几个，2 字的（你好 / 在吗 / 谢谢）由长度闸拦。
 *
 * 注：表里的 2 字条目（帮我 / 一下 / 数据…）实际永远走不到这一条 —— 长度闸在前。
 * 保留它们是**冗余防线**：万一日后有人调低 MIN_LEN_CJK，这层还在。
 */
const STOP_WORDS = new Set([
  // 口语填充
  '帮我', '一下', '麻烦', '可以', '这个', '那个', '什么', '怎么', '现在',
  '我要', '我想', '需要', '能不能', '可不可以', '给我', '一个',
  // 语义太泛的业务名词
  '数据', '环境', '系统', '问题', '功能', '页面', '账号', '用户',
  // 寒暄（3 字以上）
  '早上好', '中午好', '下午好', '晚上好', '辛苦了', '谢谢你', '麻烦了',
]);

const CJK_ONLY_RE = /^[一-龥]+$/;

/** 归一化：去首尾空白 + 小写（候选词比对比 L2 的 includes 宽松一档，防大小写差异漏判冲突） */
function norm(s) {
  return String(s ?? '').trim().toLowerCase();
}

/** a 与 b 互为子串（含相等）—— 双向子串冲突的判据本体 */
function overlaps(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

/**
 * 判断一个候选关键词能否学。
 *
 * 规则编号对齐设计文档 §4 步骤 3；代码里的判断顺序按「成本从低到高」排，
 * 与编号顺序不完全一致，不影响结果（任一条不过即弃）。
 *
 * @param {object} o
 * @param {string} o.word 候选词
 * @param {object} o.action 命中的动作配置（读 keywords / autoKeywords / rejectedKeywords / id）
 * @param {object[]} [o.otherActions] 同 bot 其余**启用**动作
 * @param {string} [o.sourceText] 触发本次动作的用户原句
 * @returns {{ok:boolean, reason:string}} ok=false 时 reason 说明卡在哪条，用于排查「为什么没学到」
 */
export function canLearnKeyword({ word, action, otherActions = [], sourceText = '' }) {
  const w = String(word ?? '').trim();
  if (!w) return { ok: false, reason: 'empty' };

  // 规则 1：必须是原句里原样出现的连续片段 —— 严格档的地基，防模型凭空造词
  if (!norm(sourceText).includes(norm(w))) return { ok: false, reason: 'not-in-source' };

  // 规则 2：长度
  if (w.length > MAX_LEN) return { ok: false, reason: 'too-long' };
  if (w.length < (CJK_ONLY_RE.test(w) ? MIN_LEN_CJK : MIN_LEN_MIXED)) {
    return { ok: false, reason: 'too-short' };
  }

  // 规则 3：停用词
  if (STOP_WORDS.has(norm(w))) return { ok: false, reason: 'stop-word' };

  // 规则 4：不得命中 L1 强前缀词表，否则「提交需求：清一下数据后白屏」会被动作抢走
  if (matchStrongIntent(w)) return { ok: false, reason: 'strong-intent-prefix' };

  // 规则 7：用户删过的词永不再学（否则面板上的「删除」形同虚设）
  if ((action?.rejectedKeywords || []).some((r) => norm(r) === norm(w))) {
    return { ok: false, reason: 'rejected-before' };
  }

  // 规则 6：与本动作已有词冗余 / 自动词配额已满
  if ((action?.keywords || []).some((k) => overlaps(w, k))) return { ok: false, reason: 'redundant' };
  if ((action?.autoKeywords || []).length >= MAX_AUTO_KEYWORDS) {
    return { ok: false, reason: 'quota-full' };
  }

  // 规则 5：双向子串冲突（本闸的核心）。
  //   正向（候选含别人的词）：今后含候选的消息必然也含那个词 → 多命中 → L2 失效，
  //                          把**别的动作**也从秒出拖回花钱的 L3。
  //   反向（别人的词含候选）：别人那条消息今后会同时命中两边 → 同样多命中。
  // 两个方向都得拦，只查一边等于留一半的洞。
  for (const other of otherActions) {
    if (!other || other.id === action?.id) continue;
    for (const k of other.keywords || []) {
      if (overlaps(w, k)) return { ok: false, reason: `conflict:${other.id}` };
    }
  }

  return { ok: true, reason: '' };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/plugins/action-runner/feature/keyword-guard.test.js
```

预期：PASS，14 个用例全绿。

- [ ] **Step 5: 确认没破坏分层**

```bash
node --test src/import-graph.test.js
```

预期：PASS（`keyword-guard.js` 只 import 了零依赖叶子 `intent-keywords.js`，不引入环）。

---

### Task 2: store 原子写入与对账

**Files:**
- Modify: `src/store/action-configs.js`（在文件末尾 `deleteConfig` 之后追加）
- Test: `src/store/action-configs.test.js`（在文件末尾追加）

- [ ] **Step 1: 写失败测试**

在 `src/store/action-configs.test.js` 末尾追加。先把顶部的 import 行改为包含新函数：

```js
const {
  getConfigs, saveConfigs, getConfig, addConfig, updateConfig, deleteConfig,
  appendAutoKeyword, reconcileAutoKeywords, DEFAULT_AUTO_KEYWORD_MAX,
} = await import('./action-configs.js');
```

然后追加用例：

```js
test('appendAutoKeyword：双写 keywords 与 autoKeywords', () => {
  cleanup();
  const c = addConfig({ botId: 'bot_t', name: '清理', keywords: ['清一下'] });

  assert.equal(appendAutoKeyword(c.id, '清掉业务表', { sourceText: '帮我清掉业务表' }), true);

  const after = getConfig(c.id);
  assert.deepStrictEqual(after.keywords, ['清一下', '清掉业务表']);
  assert.equal(after.autoKeywords.length, 1);
  assert.equal(after.autoKeywords[0].word, '清掉业务表');
  assert.equal(after.autoKeywords[0].sourceText, '帮我清掉业务表');
  assert.ok(after.autoKeywords[0].learnedAt, 'learnedAt 必须落盘，否则面板无从判断学于何时');
});

test('appendAutoKeyword：已存在的词不重复写', () => {
  cleanup();
  const c = addConfig({ botId: 'bot_t', name: '清理', keywords: ['清一下'] });
  assert.equal(appendAutoKeyword(c.id, '清一下', {}), false);
  assert.deepStrictEqual(getConfig(c.id).keywords, ['清一下']);
});

test('appendAutoKeyword：配额在锁内复核（调用方判断时读到的是快照）', () => {
  cleanup();
  const c = addConfig({ botId: 'bot_t', name: '清理', keywords: [] });
  for (let i = 0; i < DEFAULT_AUTO_KEYWORD_MAX; i += 1) {
    assert.equal(appendAutoKeyword(c.id, `自动词${i}`, {}), true);
  }
  assert.equal(appendAutoKeyword(c.id, '再来一个', {}), false, '超出配额必须拒写');
  assert.equal(getConfig(c.id).autoKeywords.length, DEFAULT_AUTO_KEYWORD_MAX);
});

test('appendAutoKeyword：max 可被调用方覆盖（单一真相源在 keyword-guard）', () => {
  cleanup();
  const c = addConfig({ botId: 'bot_t', name: '清理', keywords: [] });
  assert.equal(appendAutoKeyword(c.id, '自动词甲', { max: 1 }), true);
  assert.equal(appendAutoKeyword(c.id, '自动词乙', { max: 1 }), false);
});

test('appendAutoKeyword：动作不存在 → 返回 false 且不写盘', () => {
  cleanup();
  assert.equal(appendAutoKeyword('ac_nope', '随便什么词', {}), false);
  assert.deepStrictEqual(getConfigs(), []);
});

test('reconcileAutoKeywords：用户删掉的自动词进 rejectedKeywords', () => {
  const prev = {
    keywords: ['清一下', '清掉业务表', '清空 test'],
    autoKeywords: [{ word: '清掉业务表' }, { word: '清空 test' }],
    rejectedKeywords: ['重置'],
  };
  // 用户在面板上删掉了「清掉业务表」
  const r = reconcileAutoKeywords(prev, ['清一下', '清空 test']);
  assert.deepStrictEqual(r.autoKeywords, [{ word: '清空 test' }]);
  assert.deepStrictEqual(r.rejectedKeywords, ['重置', '清掉业务表']);
});

test('reconcileAutoKeywords：删掉手工词不影响 rejectedKeywords', () => {
  const prev = {
    keywords: ['清一下', '清掉业务表'],
    autoKeywords: [{ word: '清掉业务表' }],
    rejectedKeywords: [],
  };
  const r = reconcileAutoKeywords(prev, ['清掉业务表']); // 删的是手工词「清一下」
  assert.deepStrictEqual(r.autoKeywords, [{ word: '清掉业务表' }]);
  assert.deepStrictEqual(r.rejectedKeywords, []);
});

test('reconcileAutoKeywords：rejectedKeywords 不重复堆积', () => {
  const prev = {
    keywords: ['清掉业务表'],
    autoKeywords: [{ word: '清掉业务表' }],
    rejectedKeywords: ['清掉业务表'],
  };
  const r = reconcileAutoKeywords(prev, []);
  assert.deepStrictEqual(r.rejectedKeywords, ['清掉业务表']);
});

test('reconcileAutoKeywords：字段缺省的存量配置不炸', () => {
  const r = reconcileAutoKeywords({}, ['清一下']);
  assert.deepStrictEqual(r, { autoKeywords: [], rejectedKeywords: [] });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/store/action-configs.test.js
```

预期：FAIL，`appendAutoKeyword is not a function`。

- [ ] **Step 3: 实现两个函数**

在 `src/store/action-configs.js` 末尾（`deleteConfig` 之后）追加：

```js
/**
 * 自动关键词的默认配额。真正的单一真相源是
 * `plugins/action-runner/feature/keyword-guard.js` 的 `MAX_AUTO_KEYWORDS`，
 * 调用方经 `meta.max` 传进来；此处的默认值只为「万一没传」兜底 ——
 * store 是下层，不能 import plugins（分层单向依赖）。
 */
export const DEFAULT_AUTO_KEYWORD_MAX = 5;

/**
 * 追加一个自动学来的关键词（关键词自学习的专用写入口）。
 *
 * ⚠️ 合并全过程必须在 `updateJson` 回调**内部**完成。web 与飞书是两个进程、共享同一份
 * action-configs.json，在外面 `getConfig()` 再 `updateConfig()` 是读-改-写竞态，
 * 两边同时学到词会互相覆盖（见本模块 CLAUDE.md 流程 A）。
 * 去重与配额也必须在锁内**重做一次** —— 调用方过闸时读到的是快照。
 *
 * @param {string} id 动作 id
 * @param {string} word 关键词
 * @param {{sourceText?:string, max?:number}} [meta] sourceText 为触发原句（截断存证，便于事后复盘）
 * @returns {boolean} 是否真的写入（false = 动作不存在 / 该词已在 / 配额已满）
 */
export function appendAutoKeyword(id, word, meta = {}) {
  const w = String(word ?? '').trim();
  if (!w) return false;
  const max = Number(meta.max) > 0 ? Number(meta.max) : DEFAULT_AUTO_KEYWORD_MAX;
  let written = false;

  updateConfigs((configs) => {
    const i = configs.findIndex((c) => c.id === id);
    if (i < 0) return undefined; // 动作不存在，不写盘

    const cur = configs[i];
    const keywords = Array.isArray(cur.keywords) ? cur.keywords : [];
    const autoKeywords = Array.isArray(cur.autoKeywords) ? cur.autoKeywords : [];

    if (keywords.includes(w)) return undefined;        // 锁内复核：已存在
    if (autoKeywords.length >= max) return undefined;  // 锁内复核：配额

    const now = new Date().toISOString();
    configs[i] = {
      ...cur,
      keywords: [...keywords, w],
      autoKeywords: [
        ...autoKeywords,
        { word: w, sourceText: String(meta.sourceText ?? '').slice(0, 200), learnedAt: now },
      ],
      updatedAt: now,
    };
    written = true;
    return configs;
  });

  return written;
}

/**
 * 人工编辑关键词后的元数据对账（纯函数，供 `PUT /api/actions/:id` 调用）。
 *
 * 语义：用户在面板上删掉某个**自动词** = 明确否决这个词，它必须进 `rejectedKeywords`。
 * 否则下次同样的话再来一次，自学习会把用户刚删的词原样加回去 —— 撤销就形同虚设。
 * 删手工词不算否决（那只是用户在维护自己的词表），不进黑名单。
 *
 * @param {object} prev 更新前的动作配置
 * @param {string[]} nextKeywords 用户提交的新关键词数组
 * @returns {{autoKeywords:object[], rejectedKeywords:string[]}}
 */
export function reconcileAutoKeywords(prev, nextKeywords) {
  const kept = new Set(
    (Array.isArray(nextKeywords) ? nextKeywords : []).map((k) => String(k ?? '').trim()),
  );
  const prevAuto = Array.isArray(prev?.autoKeywords) ? prev.autoKeywords : [];
  const prevRejected = Array.isArray(prev?.rejectedKeywords) ? prev.rejectedKeywords : [];

  const autoKeywords = prevAuto.filter((a) => kept.has(String(a?.word ?? '').trim()));
  const removed = prevAuto
    .map((a) => String(a?.word ?? '').trim())
    .filter((w) => w && !kept.has(w));

  return {
    autoKeywords,
    rejectedKeywords: [...new Set([...prevRejected, ...removed])],
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/store/action-configs.test.js
```

预期：PASS，含原有用例全绿。

---

### Task 3: intent.js 打 `via` 标记

**Files:**
- Modify: `src/app/intent.js:150-154`
- Test: `src/app/intent.test.js`（末尾追加）

- [ ] **Step 1: 写失败测试**

在 `src/app/intent.test.js` 末尾追加：

```js
test('L2 关键词命中不带 via 标记（自学习据此判断「这次没花钱」）', async () => {
  // 关键词自学习只在 L3 兜底命中时才该触发。L2 是本地匹配，本来就零成本，
  // 若它也带 via 会导致每次执行都白调一次提词模型。
  const r = await classify('帮我清一下 test 环境');
  assert.equal(r.intent, 'action');
  assert.equal(r.actionId, 'ac_clean');
  assert.equal(r.via, undefined, 'L2 命中必须不带 via');
});
```

- [ ] **Step 2: 跑测试确认它现在就通过（这是回归锚点，不是红灯）**

```bash
node --test src/app/intent.test.js
```

预期：PASS。这条用例的作用是**钉住** Step 3 改动不会误给 L2 加上 `via`。

- [ ] **Step 3: 给 L3 分支加标记**

修改 `src/app/intent.js`，把 L3 命中分支（原 150-154 行）改为：

```js
  const r = await quickClassify(text, { hasMaterials, actions: poolAll.slice(0, ACTION_POOL_MAX) });
  if (r && r.type !== 'other') {
    logger.info('intent', 'L3 语义分类命中', { type: r.type, actionId: r.actionId ?? null });
    // via:'llm' 只打在 L3 这一层：它是「这次动作是花了一次模型调用才认出来的」的唯一凭据，
    // 下游 action-runner 据此决定执行成功后要不要学关键词（L2 命中的不学，本来就零成本）。
    return result(
      r.type,
      r.actionId ? { actionId: r.actionId, actionName: r.actionName, via: 'llm' } : {},
    );
  }
```

同时把 `result()` 上方的注释补一句（原 52-56 行的 JSDoc 块内）：

```js
 * via：仅 L3 语义分类命中 action 时为 'llm'，其余层一律不带该字段（action-runner 据此决定是否学关键词）。
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/app/intent.test.js
```

预期：PASS，新增的 L2 无 `via` 用例仍绿。

---

### Task 4: 学习管线 `learn-keywords.js`

**Files:**
- Create: `src/plugins/action-runner/feature/learn-keywords.js`
- Test: `src/plugins/action-runner/feature/learn-keywords.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/plugins/action-runner/feature/learn-keywords.test.js`：

```js
/**
 * 学习管线编排单测 —— 全部依赖注入替身，不联网、不写盘。
 * 关心的是编排正确性：谁被调用、被调用几次、拒绝时是否真的不写盘。
 * 规则本身的正确性由 keyword-guard.test.js 覆盖，这里不重复。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnKeywords } from './learn-keywords.js';

const ACTION = {
  id: 'ac_clean',
  botId: 'bot_t',
  name: '清理测试数据',
  description: '清空 test 环境业务表',
  keywords: ['清一下'],
  autoKeywords: [],
  rejectedKeywords: [],
};

/** 造一组替身；appended 收集实际写盘调用 */
function depsOf({ keywords = [], others = [], appendOk = true } = {}) {
  const appended = [];
  const calls = { classify: 0 };
  return {
    appended,
    calls,
    deps: {
      classify: async () => {
        calls.classify += 1;
        return { keywords };
      },
      listConfigs: () => [ACTION, ...others],
      append: (id, word, meta) => {
        appended.push({ id, word, meta });
        return appendOk;
      },
    },
  };
}

test('候选词全部合格 → 逐个写盘并返回已学到的词', async () => {
  const { deps, appended } = depsOf({ keywords: ['清掉业务表'] });
  const learned = await learnKeywords(
    { action: ACTION, sourceText: '帮我把 test 的清掉业务表吧' },
    deps,
  );
  assert.deepEqual(learned, ['清掉业务表']);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].id, 'ac_clean');
  assert.equal(appended[0].meta.sourceText, '帮我把 test 的清掉业务表吧');
});

test('候选词被硬闸拒绝 → 不写盘', async () => {
  // 「重置测试环境」不是原句的连续片段（规则 1）
  const { deps, appended } = depsOf({ keywords: ['重置测试环境'] });
  const learned = await learnKeywords(
    { action: ACTION, sourceText: '帮我把测试环境的数据清掉' },
    deps,
  );
  assert.deepEqual(learned, []);
  assert.equal(appended.length, 0);
});

test('与其他动作冲突的候选词 → 不写盘（不许拖慢别的动作）', async () => {
  const other = { id: 'ac_deploy', botId: 'bot_t', name: '部署', keywords: ['清理缓存'], enabled: true };
  const { deps, appended } = depsOf({ keywords: ['清理缓存数据'], others: [other] });
  const learned = await learnKeywords(
    { action: ACTION, sourceText: '帮我清理缓存数据' },
    deps,
  );
  assert.deepEqual(learned, []);
  assert.equal(appended.length, 0);
});

test('模型返回空 / 非法 → 静默退出，不写盘', async () => {
  for (const bad of [null, {}, { keywords: [] }, { keywords: 'nope' }]) {
    const appended = [];
    const learned = await learnKeywords(
      { action: ACTION, sourceText: '帮我清掉业务表' },
      { classify: async () => bad, listConfigs: () => [ACTION], append: (...a) => { appended.push(a); return true; } },
    );
    assert.deepEqual(learned, []);
    assert.equal(appended.length, 0);
  }
});

test('一轮最多学 2 个词（不激进）', async () => {
  const { deps, appended } = depsOf({ keywords: ['清掉业务表', '清空订单表', '清理留存表'] });
  const learned = await learnKeywords(
    { action: ACTION, sourceText: '帮我清掉业务表、清空订单表、清理留存表' },
    deps,
  );
  assert.equal(learned.length, 2, '一句话最多沉淀 2 个词，避免一次吃光配额');
  assert.equal(appended.length, 2);
});

test('本轮已学的词参与后续候选的冗余判定（快照不会自动更新）', async () => {
  // 第二个候选「清掉业务」是第一个「清掉业务表」的子串，必须被判冗余
  const { deps, appended } = depsOf({ keywords: ['清掉业务表', '清掉业务'] });
  const learned = await learnKeywords(
    { action: ACTION, sourceText: '帮我清掉业务表' },
    deps,
  );
  assert.deepEqual(learned, ['清掉业务表']);
  assert.equal(appended.length, 1);
});

test('配额已满 → 连模型都不调（省一次调用）', async () => {
  const full = { ...ACTION, autoKeywords: [1, 2, 3, 4, 5].map((i) => ({ word: `词${i}` })) };
  const { deps, calls, appended } = depsOf({ keywords: ['清掉业务表'] });
  const learned = await learnKeywords({ action: full, sourceText: '帮我清掉业务表' }, deps);
  assert.deepEqual(learned, []);
  assert.equal(calls.classify, 0, '配额满时不该发起模型调用');
  assert.equal(appended.length, 0);
});

test('原句为空 / 动作无 id → 直接返回，不调模型', async () => {
  const { deps, calls } = depsOf({ keywords: ['清掉业务表'] });
  assert.deepEqual(await learnKeywords({ action: ACTION, sourceText: '   ' }, deps), []);
  assert.deepEqual(await learnKeywords({ action: {}, sourceText: '帮我清掉业务表' }, deps), []);
  assert.equal(calls.classify, 0);
});

test('append 返回 false（锁内复核拒写）→ 不计入已学', async () => {
  const { deps, appended } = depsOf({ keywords: ['清掉业务表'], appendOk: false });
  const learned = await learnKeywords({ action: ACTION, sourceText: '帮我清掉业务表' }, deps);
  assert.deepEqual(learned, []);
  assert.equal(appended.length, 1, '仍然尝试过一次写入');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/plugins/action-runner/feature/learn-keywords.test.js
```

预期：FAIL，`Cannot find module './learn-keywords.js'`。

- [ ] **Step 3: 实现管线**

创建 `src/plugins/action-runner/feature/learn-keywords.js`：

```js
/**
 * 动作关键词自学习 —— 「这次花了一次模型调用才认出来的说法，下次让它走本地快路」。
 *
 * 触发条件（由 feature/index.js 把关）：L3 语义兜底命中 action **且** 脚本执行成功。
 * 「执行成功」是用户用行为给出的确认，比模型自己的置信度可靠得多 ——
 * 中途取消、脚本失败都不学，避免把一次误判固化成永久关键词。
 *
 * 全程 fire-and-forget：调用方不 await、不看返回值。学关键词失败绝不该影响用户拿到执行结果。
 *
 * 模型只负责**提词**，能不能加由 keyword-guard.js 的确定性规则裁决（见该文件头）。
 */
import { runClassifierOnce } from '../../../capabilities/llm-classify.js';
import { getConfigs, appendAutoKeyword } from '../../../store/action-configs.js';
import { canLearnKeyword, MAX_AUTO_KEYWORDS } from './keyword-guard.js';
import { config } from '../../../shared/config.js';
import { logger } from '../../../shared/logger.js';

/** 一轮最多沉淀几个词：多了会让一句话吃光配额，也超出「不激进」的口径 */
const MAX_PER_ROUND = 2;

/** 触发原句喂给模型的长度上限（长文只取前段，够用且省 token） */
const SOURCE_TEXT_MAX = 300;

/** 拼提词 prompt。其他动作全列进去，让模型先自己避一道；最终裁决仍在硬闸。 */
function buildPrompt(action, otherActions, sourceText) {
  const others = otherActions
    .map((c, i) => `${i + 1}. ${c.name} —— ${c.description || '（无描述）'}（关键词：${(c.keywords || []).join('、') || '无'}）`)
    .join('\n');

  return (
    `你在维护一个聊天机器人的「动作关键词表」。关键词的用法是：用户消息只要**包含**某个关键词，就直接触发对应动作，不再调用模型。\n\n` +
    `这次用户说了一句话，系统花了一次模型调用才认出他想执行哪个动作。现在要把这个说法沉淀成关键词。\n\n` +
    `用户原话：「${String(sourceText).slice(0, SOURCE_TEXT_MAX)}」\n` +
    `本次命中的动作：${action.name} —— ${action.description || '（无描述）'}\n` +
    `该动作已有关键词：${(action.keywords || []).join('、') || '无'}\n\n` +
    (others ? `同一机器人下的其他动作（必须避开会与它们混淆的说法）：\n${others}\n\n` : '') +
    `请给出 1-3 个候选关键词，规则：\n` +
    `1. 必须是用户原话里**原样出现的连续片段**，一个字都不能改、不能调换顺序、不能补字。\n` +
    `2. 要能代表「想做这件事」的意图，通常是动宾短语。\n` +
    `3. 不要给变量值：环境名、手机号、用户 ID、日期这类是参数，不是意图。\n` +
    `4. 不要给通用词：帮我、一下、麻烦、数据、环境、系统……它们在任何消息里都可能出现。\n` +
    `5. 放进上面任何一个其他动作的语境里也说得通的词，一律不要给。\n` +
    `6. 想不出合格的就给空数组，宁缺毋滥。\n\n` +
    `只输出一行 JSON，不要任何解释：{"keywords":["…"]}`
  );
}

/**
 * 学一轮关键词。
 *
 * @param {{action: object, sourceText: string}} o action 为命中的动作配置，sourceText 为触发原句
 * @param {object} [deps] 依赖注入口（单测用）
 * @returns {Promise<string[]>} 本轮真正写入的词
 */
export async function learnKeywords({ action, sourceText }, deps = {}) {
  const {
    classify = runClassifierOnce,
    listConfigs = getConfigs,
    append = appendAutoKeyword,
    guard = canLearnKeyword,
  } = deps;

  const text = String(sourceText ?? '').trim();
  if (!action?.id || !text) return [];

  // 配额先看一眼：满了连模型都不用调（省一次调用）
  if ((action.autoKeywords || []).length >= MAX_AUTO_KEYWORDS) {
    logger.info('action-learn', '自动关键词已满，跳过本次学习', { actionId: action.id });
    return [];
  }

  // 冲突判据只取**同 bot 的其余启用动作**：动作 per-bot 独享，跨 bot 不会互相干扰；
  // 已禁用的动作不参与 L2 匹配，拿它做冲突判断会无谓地卡掉合法候选。
  const otherActions = listConfigs().filter(
    (c) => c && c.enabled !== false && c.botId === action.botId && c.id !== action.id,
  );

  const data = await classify({
    prompt: buildPrompt(action, otherActions, text),
    model: config.intent.classifyModel,
    logTag: 'action/learn-kw',
  });
  const candidates = Array.isArray(data?.keywords) ? data.keywords : [];
  if (!candidates.length) {
    logger.info('action-learn', '模型未给出候选词', { actionId: action.id });
    return [];
  }

  const learned = [];
  for (const raw of candidates) {
    if (learned.length >= MAX_PER_ROUND) break;
    const word = String(raw ?? '').trim();

    // 本轮已学的词必须参与后续候选的判重与配额 —— action 是进函数时的快照，
    // 逐个写盘不会让它自动更新（否则「清掉业务表」和「清掉业务」会双双写进去）。
    const snapshot = {
      ...action,
      keywords: [...(action.keywords || []), ...learned],
      autoKeywords: [...(action.autoKeywords || []), ...learned.map((w) => ({ word: w }))],
    };

    const verdict = guard({ word, action: snapshot, otherActions, sourceText: text });
    if (!verdict.ok) {
      logger.info('action-learn', '候选词未通过硬闸', {
        actionId: action.id,
        word,
        reason: verdict.reason,
      });
      continue;
    }

    if (append(action.id, word, { sourceText: text, max: MAX_AUTO_KEYWORDS })) {
      learned.push(word);
      logger.info('action-learn', '已学到新关键词', { actionId: action.id, word });
    }
  }

  return learned;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test src/plugins/action-runner/feature/learn-keywords.test.js
```

预期：PASS，9 个用例全绿。

---

### Task 5: 接进 action-runner 执行链

**Files:**
- Modify: `src/plugins/action-runner/feature/index.js`（`setPending`、`handle`、`proceedWithAction`、`handlePendingResponse`、`executeAction`）
- Test: `src/plugins/action-runner/feature/index.test.js`（末尾追加）

- [ ] **Step 1: 写失败测试**

在 `src/plugins/action-runner/feature/index.test.js` 末尾追加。注意本文件既有的 `ctxOf` / `depsOf` 辅助函数可直接复用，但学习相关用例需要自己的 deps（要注入 `learn` 替身 + 控制 `run` 的成败）：

```js
/**
 * 关键词自学习的触发条件 —— 三道闸必须同时满足才学：
 * ① 这次是 L3 兜底认出来的（intentResult.via === 'llm'）
 * ② 脚本真的跑成功了（result.ok）
 * ③ 学的是**触发原句**，不是最后一条补槽位的回答
 */
describe('关键词自学习触发条件', () => {
  const CFG_NO_VAR = { id: 'ac_clean', name: '清理测试数据', permission: 'guest', variables: [] };

  /** ok 控制脚本成败；learned 收集学习调用 */
  function learnDeps(ok = true, learned = []) {
    return {
      deps: {
        getConfig: () => CFG_NO_VAR,
        extract: async () => ({}),
        run: async () => ({ ok, output: ok ? '执行完成' : '脚本报错' }),
        saveVar: () => {},
        learn: async (arg) => { learned.push(arg); },
      },
      learned,
    };
  }

  it('L3 兜底命中 + 执行成功 → 学，且学的是触发原句', async () => {
    const { deps, learned } = learnDeps(true);
    const { ctx } = ctxOf('u_learn_1', '帮我把 test 的业务表清掉');
    await handle(ctx, { actionId: 'ac_clean', via: 'llm' }, deps);
    // fire-and-forget：让微任务队列排空
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(learned.length, 1);
    assert.equal(learned[0].sourceText, '帮我把 test 的业务表清掉');
    assert.equal(learned[0].action.id, 'ac_clean');
  });

  it('L2 关键词命中（无 via）→ 不学', async () => {
    const { deps, learned } = learnDeps(true);
    const { ctx } = ctxOf('u_learn_2', '帮我把 test 的业务表清掉');
    await handle(ctx, { actionId: 'ac_clean' }, deps);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(learned.length, 0);
  });

  it('脚本执行失败 → 不学（误判不许固化成关键词）', async () => {
    const { deps, learned } = learnDeps(false);
    const { ctx } = ctxOf('u_learn_3', '帮我把 test 的业务表清掉');
    await handle(ctx, { actionId: 'ac_clean', via: 'llm' }, deps);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(learned.length, 0);
  });

  it('学习抛异常 → 用户仍拿到执行结果（fire-and-forget 不许带崩主流程）', async () => {
    const { ctx, replies } = ctxOf('u_learn_4', '帮我把 test 的业务表清掉');
    await handle(ctx, { actionId: 'ac_clean', via: 'llm' }, {
      getConfig: () => CFG_NO_VAR,
      extract: async () => ({}),
      run: async () => ({ ok: true, output: '执行完成' }),
      saveVar: () => {},
      learn: async () => { throw new Error('模型挂了'); },
    });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(replies.some((r) => r.includes('执行完成')), '执行结果必须照常送达');
  });

  it('经过多轮追问后执行成功 → 学的仍是触发原句，不是最后那句「test」', async () => {
    const CFG_ONE_VAR = {
      id: 'ac_clean',
      name: '清理测试数据',
      permission: 'guest',
      variables: [{ name: 'env', label: '环境', prompt: '要哪个环境？', required: true }],
    };
    const learned = [];
    const deps = {
      getConfig: () => CFG_ONE_VAR,
      // 首轮抽不出 env（触发追问），追问轮抽得出
      extract: async (cfg, text) => (text === 'test' ? { env: 'test' } : {}),
      run: async () => ({ ok: true, output: '执行完成' }),
      saveVar: () => {},
      learn: async (arg) => { learned.push(arg); },
    };

    const first = ctxOf('u_learn_5', '帮我把业务表清掉');
    await handle(first.ctx, { actionId: 'ac_clean', via: 'llm' }, deps);
    assert.ok(first.replies.some((r) => r.includes('环境')), '首轮应追问环境');

    const second = ctxOf('u_learn_5', 'test');
    await handle(second.ctx, null, deps);
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(learned.length, 1);
    assert.equal(learned[0].sourceText, '帮我把业务表清掉', 'sourceText 必须是触发原句');
  });
});
```

文件顶部若尚未 import `describe`，把首行改为：

```js
import { describe, it } from 'node:test';
```

（现有文件已是这一行，无需改动。）

- [ ] **Step 2: 跑测试确认失败**

```bash
node --test src/plugins/action-runner/feature/index.test.js
```

预期：FAIL —— 学习从未被调用（`learned.length` 为 0 而期望 1）。

- [ ] **Step 3: 改 `setPending`（透传 learnSrc）**

修改 `src/plugins/action-runner/feature/index.js` 的 `setPending`（原 45-47 行）：

```js
/** 写入/刷新中间态（ts 每轮刷新：用户在正常互动就不该被超时打断） */
function setPending(userId, entry) {
  const prev = pendingState.get(userId);
  // learnSrc 只在 proceedWithAction 首轮写一次，此后靠这里在追问链上透传。
  // 不透传的话，走到 executeAction 时手里只剩最后一条补槽位的回答（「test」），
  // 而关键词要学的是**触发那句话**。在这里继承，比让 4 个调用点各自记得带一次可靠。
  const learnSrc = entry.learnSrc !== undefined ? entry.learnSrc : (prev?.learnSrc ?? null);
  pendingState.set(userId, { ...entry, learnSrc, ts: Date.now() });
}
```

同时把顶部 `pendingState` 的形状注释（原 22-23 行）补上新字段：

```js
// pendingState: userId(open_id) → { actionId, collected: {...}, waitingFor: varName, ts: number,
//                                    extracting?: boolean, inbox?: string[],
//                                    learnSrc?: { text: string } | null }
```

- [ ] **Step 4: 改 `handle` 与 `proceedWithAction`（记下触发原句）**

把 `handle` 末尾的调用（原 106 行）改为：

```js
  // via==='llm' 才带触发原句下去：只有 L3 兜底认出来的动作值得学关键词，
  // L2 命中的本来就零成本，卡片按钮入口（card-action.js）更是压根不经过意图识别。
  return proceedWithAction(ctx, actionConfig, deps, intentResult?.via === 'llm' ? text : null);
```

把 `proceedWithAction` 的签名与首个 `setPending`（原 134、143 行）改为：

```js
async function proceedWithAction(ctx, actionConfig, deps, learnText = null) {
  const userId = ctx.user.id;
  const text = ctx.text || '';

  // ⚠️ 占位必须写在**发起抽取之前**（事故驱动，勿挪到 await 之后）。
  // 旧实现把 setPending 放在抽取结束后，于是抽取那 8~17s 里 hasPending 一直为 false：
  // 用户等不及先答了「test环境」，这条消息绕过本 feature 走常规意图识别 → 判 other →
  // 回一张「没有识别到你的意图」帮助卡，随后首轮才姗姗来迟地追问同一个字段
  //（实证 app-2026-09-01.log:231-255）。占位后窗口内的消息由 handlePendingResponse 收进 inbox。
  setPending(userId, {
    actionId: actionConfig.id,
    collected: {},
    waitingFor: null,
    extracting: true,
    inbox: [],
    learnSrc: learnText ? { text: learnText } : null,
  });
```

- [ ] **Step 5: 改两处 `executeAction` 调用（在清态前取出 learnSrc）**

`proceedWithAction` 里（原 169-171 行）：

```js
    // 所有必填变量已收集 → 执行脚本
    // 先取 learnSrc 再清态：delete 之后就再也拿不到触发原句了
    const learnSrc = pendingState.get(userId)?.learnSrc || null;
    pendingState.delete(userId);
    return executeAction(ctx, actionConfig, collected, deps, learnSrc);
```

`handlePendingResponse` 里（原 267-269 行）：

```js
    // 全齐 → 执行
    const learnSrc = pending.learnSrc || null;
    pendingState.delete(userId);
    return executeAction(ctx, actionConfig, collected, deps, learnSrc);
```

- [ ] **Step 6: 改 `executeAction` 并加 `fireLearn`**

把 `executeAction`（原 277-303 行）改为：

```js
/** 执行脚本并回复结果（含持久变量落盘） */
async function executeAction(ctx, actionConfig, collectedVars, deps, learnSrc = null) {
  const userId = ctx.user.id;

  try {
    // 保存永久变量（persistent=true），下次跳过追问
    for (const v of actionConfig.variables || []) {
      if (v.persistent && collectedVars[v.name]) {
        deps.saveVar(userId, v.name, collectedVars[v.name]);
      }
    }

    await ctx.reply(`⏳ 正在执行「${actionConfig.name}」…`);

    const result = await deps.run(actionConfig, userId, collectedVars);
    const tail = (result.output || '').slice(-800);

    if (result.ok) {
      // 关键词自学习：只在「这次是 L3 兜底认出来的」+「脚本真的跑成功了」时触发。
      // 执行成功是用户用行为给出的确认 —— 中途取消、脚本失败都不学，
      // 免得把一次误判固化成永久关键词（见 learn-keywords.js 文件头）。
      if (learnSrc?.text) fireLearn(actionConfig, learnSrc.text, deps);
      // 成功：直接回脚本自身输出（脚本已精简为用户关心的一句话），不加框架前缀
      return ctx.reply(tail.trim() || `✅ ${actionConfig.name}完成`);
    }
    return ctx.reply(`❌ 执行失败\n${tail || '(无输出)'}`);
  } catch (e) {
    logger.error('action-runner', '执行脚本异常', { actionId: actionConfig.id, err: e?.message });
    return ctx.reply('执行脚本时出错，请稍后重试。');
  }
}

/**
 * 触发关键词自学习：绝不 await、绝不让异常冒泡（与 sendAck 同款姿态）。
 * 学关键词是锦上添花，失败了用户照样该拿到执行结果。
 *
 * 动态 import：学习链要拉起 llm-classify + store，而绝大多数执行根本不走这条路
 *（L2 命中的、卡片按钮触发的都不学），没必要在模块加载期就把它们拖进来。
 */
function fireLearn(actionConfig, sourceText, deps) {
  const swallow = (e) =>
    logger.warn('action-runner', '关键词自学习失败（不影响执行结果）', {
      actionId: actionConfig.id,
      err: e?.message || String(e),
    });
  try {
    const run = deps.learn
      ? deps.learn({ action: actionConfig, sourceText })
      : import('./learn-keywords.js').then((m) =>
          m.learnKeywords({ action: actionConfig, sourceText }));
    if (run && typeof run.catch === 'function') run.catch(swallow);
  } catch (e) {
    swallow(e);
  }
}
```

注意：`DEFAULT_DEPS`（原 55 行）**不加** `learn` 键——默认走动态 import，只有单测注入替身时才走 `deps.learn`。

- [ ] **Step 7: 跑测试确认通过**

```bash
node --test src/plugins/action-runner/feature/index.test.js
```

预期：PASS，含原有追问状态机用例全绿。

- [ ] **Step 8: 跑全量单测确认没有回归**

```bash
npm test
```

预期：全绿。重点看 `dispatch.test.js` / `intent.test.js` / `race-window.test.js` / `persistent-vars.test.js` 未受 `setPending` 改动影响。

---

### Task 6: PUT 路由对账（撤销闭环）

**Files:**
- Modify: `src/entrypoints/web/routes-ops.js:259-278`

- [ ] **Step 1: 改 `handleActionsPut`**

```js
/** PUT /api/actions/:id — 更新动作配置（botId 归属不可改，剥离） */
export async function handleActionsPut(req, res, url) {
  const id = actionIdFromPath(url);
  if (id === null) return sendJson(res, 404, { error: 'not found' });
  return withJsonBody(req, res, async (payload) => {
    try {
      const { botId: _ignored, ...data } = payload;
      const varErr = await checkVariables(data);
      if (varErr) return sendJson(res, 422, { error: varErr });
      const { updateConfig, getConfig, reconcileAutoKeywords } = await import(
        '../../store/action-configs.js'
      );
      // 人工编辑过关键词 → 对账自动词元数据：用户删掉的自动词进 rejectedKeywords。
      // 不做的话，下次同样的话一来，自学习会把用户刚删的词原样加回去 —— 撤销形同虚设。
      if (data.keywords !== undefined) {
        const prev = getConfig(id);
        if (prev) Object.assign(data, reconcileAutoKeywords(prev, data.keywords));
      }
      const updated = updateConfig(id, data);
      if (!updated) {
        return sendJson(res, 404, { error: '配置不存在' });
      }
      sendJson(res, 200, updated);
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
  });
}
```

- [ ] **Step 2: 语法自检**

```bash
node --check src/entrypoints/web/routes-ops.js
```

预期：无输出（通过）。

- [ ] **Step 3: 造一个自动词备用**

后面 Task 6/7 的手工验证都需要一个真实的自动词。先列出动作 id：

```bash
node --input-type=module -e "const s=await import('./src/store/action-configs.js');console.log(s.getConfigs().map(c=>c.id+' '+c.name).join('\n'))"
```

挑一个 id，给它塞一个自动词（把 `<id>` 换成真实 id）：

```bash
node --input-type=module -e "const s=await import('./src/store/action-configs.js');console.log(s.appendAutoKeyword('<id>','清掉业务表',{sourceText:'帮我清掉业务表'}))"
```

预期输出 `true`。

- [ ] **Step 4: 验证撤销闭环**

```bash
npm start
```

浏览器打开 `http://127.0.0.1:3000` → 设置 → 动作配置 → 编辑刚才那个动作 → 从关键词框里删掉 `清掉业务表` → 保存。然后读回配置：

```bash
node --input-type=module -e "const s=await import('./src/store/action-configs.js');const c=s.getConfig('<id>');console.log(JSON.stringify({keywords:c.keywords,autoKeywords:c.autoKeywords,rejectedKeywords:c.rejectedKeywords},null,2))"
```

预期：`keywords` 与 `autoKeywords` 都不含该词，`rejectedKeywords` 含 `清掉业务表`。

---

### Task 7: 面板标识自动词

**Files:**
- Modify: `public/js/actions-panel.js`（`renderActionsList` 及其上方）

- [ ] **Step 1: 加格式化 helper**

在 `renderActionsList` 函数**之前**插入：

```js
      /**
       * 关键词展示：自动学来的词标上「·自动」，让人一眼看出哪些不是自己配的。
       * 删掉某个自动词 = 否决它（后端 reconcileAutoKeywords 会记进 rejectedKeywords，永不再学）。
       */
      function formatKeywords(a) {
        const auto = new Set((a.autoKeywords || []).map((x) => x && x.word).filter(Boolean));
        return (a.keywords || []).map((k) => (auto.has(k) ? `${k} ·自动` : k)).join(', ');
      }
```

- [ ] **Step 2: 改卡片渲染那一行**

把 `renderActionsList` 里的关键词行（原文件第 54 行）：

```js
            <div class="action-meta">关键词：${escapeHtml((a.keywords || []).join(', ') || '—')}</div>
```

改为：

```js
            <div class="action-meta">关键词：${escapeHtml(formatKeywords(a) || '—')}</div>
```

编辑对话框里的输入框（原文件第 95 行）**不动**：自动词与手工词混在同一个逗号分隔框里，用户正常删除即可，`·自动` 只是列表的展示后缀，不进输入框。

- [ ] **Step 3: 语法自检**

```bash
node --check public/js/actions-panel.js
```

预期：无输出。（这条命令同时是「前端 import 图有无语法错误」的最快判据 —— 语法错会让页面卡在启动页。）

- [ ] **Step 4: 手工验证**

Task 6 Step 4 已经把那个词删掉了，先重新造一个（`<id>` 同前）：

```bash
node --input-type=module -e "const s=await import('./src/store/action-configs.js');console.log(s.appendAutoKeyword('<id>','清掉业务表',{sourceText:'帮我清掉业务表'}))"
```

```bash
npm start
```

打开 `http://127.0.0.1:3000` → 设置 → 动作配置，刷新后确认：

1. 列表里该词显示为 `清掉业务表 ·自动`，同动作的手工词不带后缀。
2. 点「编辑」，输入框里是干净的逗号分隔词（**不含** `·自动` 后缀）——后缀只是列表的展示层，混进输入框会被当成词的一部分存回去。

---

### Task 8: 同步模块地图

**Files:**
- Modify: `src/app/CLAUDE.md`
- Modify: `src/plugins/CLAUDE.md`
- Modify: `src/store/CLAUDE.md`

- [ ] **Step 1: 改 `src/app/CLAUDE.md`**

在「B. 意图分层短路」的 **L3 语义分类** 条目末尾追加一句：

```markdown
命中 action 时额外带 `via:'llm'` —— 这是「本次动作是花了一次模型调用才认出来的」的唯一凭据，`plugins/action-runner` 据此决定执行成功后要不要学关键词（L2 命中的不带，本来就零成本）。
```

- [ ] **Step 2: 改 `src/plugins/CLAUDE.md`**

在「### action-runner/ —— 配置驱动的通用动作执行」的文件清单里，`permission.js` 那条之后插入两行：

```markdown
- `action-runner/feature/keyword-guard.js` — **关键词自学习的本地硬闸**（纯函数）：候选词能不能学，七条确定性规则说了算（模型只负责提词）。核心是**双向子串冲突检查** —— 给 A 动作加词可能让 B 动作原本 L2 秒出的消息变成多命中而退回 L3，这种伤害对用户和模型都不可见。⚠️ 只许 import `app/intent-keywords.js`（零依赖叶子），**不得** import `app/intent.js`。
- `action-runner/feature/learn-keywords.js` — 关键词自学习管线：拼提词 prompt → 调一次 haiku → 逐个过硬闸 → `store/action-configs.js#appendAutoKeyword` 原子写盘。只在「L3 兜底命中 + 脚本执行成功」时触发，fire-and-forget。
```

在「### D. action-runner 槽位填充状态机」段落末尾追加一段：

```markdown
**关键词自学习**（挂在这条状态机的成功出口上）：`intent.js` 的 L3 命中给 `intentResult` 打 `via:'llm'` → `handle` 把触发原句写进 `pendingState.learnSrc`（`setPending` 负责在追问链上透传，否则走到执行时只剩最后一条补槽位的回答）→ `executeAction` 的 `result.ok` 分支 `fireLearn` fire-and-forget 调 `learn-keywords.js`。三道闸缺一不学：L3 兜底认出来的、脚本真跑成功了、原句还在。学到的词直接进 `keywords[]` 参与下次 L2 匹配，元数据留在 `autoKeywords[]`，人工在面板删掉即进 `rejectedKeywords[]` 永不再学。
```

在「## 常见改动入口」里，`要改动作执行（槽位填充/脚本/逐动作权限）` 那条之后插入：

```markdown
- **要调关键词自学习的松紧**（长度门槛 / 停用词 / 配额 / 冲突判据）→ 改 `action-runner/feature/keyword-guard.js`；改提词 prompt 或一轮学几个 → `learn-keywords.js`；改触发条件 → `feature/index.js` 的 `fireLearn` 调用点。**不要**改 `app/intent.js` 的 L2 匹配逻辑，那是全局共享资源。
```

- [ ] **Step 3: 改 `src/store/CLAUDE.md`**

把「业务领域 store」上方「设置 / 配置迁移」分组里 `action-configs.js` 那条改为：

```markdown
- `action-configs.js` — 通用动作配置 CRUD（`action-configs.json`），按 bot 归属。另含关键词自学习的两个专用口：`appendAutoKeyword`（**整个合并过程都在 `updateJson` 回调内**完成，去重与配额在锁内重做一次 —— 调用方过闸时读到的是快照，在外面读改写会被另一进程覆盖）与 `reconcileAutoKeywords`（纯函数对账：人工删掉的自动词进 `rejectedKeywords`，否则下次同样的话一来会被原样学回去）。
```

在「## 常见改动入口」追加一条：

```markdown
- **要改自动学来的关键词怎么落盘 / 怎么对账** → `action-configs.js` 的 `appendAutoKeyword` / `reconcileAutoKeywords`；配额的单一真相源在 `plugins/action-runner/feature/keyword-guard.js#MAX_AUTO_KEYWORDS`，经 `meta.max` 传进来（store 是下层，不能反向 import plugins）。
```

- [ ] **Step 4: 全量验证**

```bash
npm test
```

预期：全绿。

---

## 验收清单

实现完成后逐条确认：

- [ ] `npm test` 全绿
- [ ] `node --test src/import-graph.test.js` 通过（没有新增 import 环，两个零依赖叶子仍零 import）
- [ ] 飞书实测：对一个已配置动作说一句**关键词表里没有的**说法 → 走 L3 → 执行成功 → 查 `action-configs.json` 确认多了一个 `autoKeywords` 条目
- [ ] 同一句话再说一次 → 日志里出现 `L2 动作关键词单命中`（不再调 L3）
- [ ] 在面板删掉那个自动词并保存 → `rejectedKeywords` 里出现它 → 再说同样的话不会把它学回来
- [ ] 造一个会与其他动作冲突的说法 → 日志 `候选词未通过硬闸 reason=conflict:<其他动作id>`，配置无变化
