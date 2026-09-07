import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBlocks, hasAbsolute, hasQualifier, findCandidates, evaluatePrompts } from './check-prompts.logic.js';

// ---------------------------------------------------------------------------
// 收窄召回：把「规则语句」和「带义务词的描述性正文」分开
// ---------------------------------------------------------------------------

test('splitBlocks 带出所属章节标题链', () => {
  const md = '# 模块\n\n## 这是什么\n\n所有代码都在这里。\n\n## 容易踩的坑\n\n- 必须显式 import\n';
  const blocks = splitBlocks(md);
  const pit = blocks.find((b) => b.text.includes('必须显式'));
  assert.ok(pit.heading.includes('容易踩的坑'));
  const intro = blocks.find((b) => b.text.includes('所有代码'));
  assert.ok(intro.heading.includes('这是什么'));
});

test('YAML frontmatter 是元数据，不进候选', () => {
  const md = '---\nname: add-tool\ndescription: 会自动生成所有必要的代码文件，禁止跳过。\n---\n\n# 向导\n';
  assert.deepEqual(findCandidates(md, 'SKILL.md'), []);
});

test('「所有」是量词，单独出现不构成规则', () => {
  const md = '- 页面用的所有聊天 UI 都在 chat-components 里。\n';
  assert.deepEqual(findCandidates(md, 'x.md'), []);
});

test('「所有」与义务词共现时仍是候选', () => {
  const md = '- 所有组件必须显式 import\n';
  assert.equal(findCandidates(md, 'x.md').length, 1);
});

test('义务词埋在解释段中后部的描述性正文不进候选', () => {
  const md =
    '`scrollToBottomSettled` 收工时会显式把 `isAtBottom` 置 true。受控 `scroll-top` 不保证回调。' +
    '用户主动触摸列表时必须调 `cancelScrollToBottomSettled()`。\n';
  assert.deepEqual(findCandidates(md, 'x.md'), []);
});

test('义务词落在首句的条目仍是候选', () => {
  const md = '- **`v-show` 必须套在原生 `<view>` 上**。Skyline 下写在自定义组件上不生效。\n';
  assert.equal(findCandidates(md, 'x.md').length, 1);
});

test('「为什么…必须…」是解释而不是规则', () => {
  const md = '为什么门禁必须落在服务层而不是 UI 入口：调用点太多，页面级拦截盖不住。\n';
  assert.deepEqual(findCandidates(md, 'x.md'), []);
});

test('「是必须的」是名词化陈述而不是规则', () => {
  const md = '这里的 `await` 是必须的，不等它卡片就会迟到。\n';
  assert.deepEqual(findCandidates(md, 'x.md'), []);
});

test('只出现在括号里的义务词是补充说明，不构成规则', () => {
  const md = '**自动加载**（`.claude/rules/`，只保留了必须被动提醒的两条）：\n';
  assert.deepEqual(findCandidates(md, 'x.md'), []);
});

test('括号外有义务词时不受影响', () => {
  const md = '- 禁止提交无法编译的代码（type-check 必须全绿）\n';
  assert.equal(findCandidates(md, 'x.md').length, 1);
});

test('描述性章节里的条目不进候选', () => {
  const md = '## 关键机制\n\n分包必须至少有一个页面才合法，`placeholder/index.vue` 就是干这个的。\n';
  assert.deepEqual(findCandidates(md, 'x.md'), []);
});

test('规范性章节里的同类条目仍进候选', () => {
  const md = '## 强制规范\n\n分包必须至少有一个页面才合法。\n';
  assert.equal(findCandidates(md, 'x.md').length, 1);
});

test('章节词表按整词匹配，不误伤「参考范例时的雷」这类标题', () => {
  // `参考` 单独当关键词会把「参考范例时的雷」这种规范小节一起吃掉
  const md = '## 参考范例时的雷\n\n- `dish-skus-popup`：接口失败必须走「失败态 + 重试」。\n';
  assert.equal(findCandidates(md, 'x.md').length, 1);
});

test('描述性章节里以义务词开头的祈使句仍进候选', () => {
  const md = '## 这是什么\n\n- **必须显式 `import`**，模板里用 kebab-case。\n';
  assert.equal(findCandidates(md, 'x.md').length, 1);
});

test('⛔ / ✅ 强制标记无视章节与首句限制', () => {
  const md = '## 关键流程\n\n- ✅ 接口失败走「失败态 + 重试」，禁止塞假数据装作成功\n';
  assert.equal(findCandidates(md, 'x.md').length, 1);
});

test('⛔ / ✅ 独立立案，不要求整段另有绝对化措辞', () => {
  // 作者亲手标的强制级别本身就是最强信号，不该因为措辞里没写「禁止/必须」就漏掉
  const md = '- ⛔ 普通表单页根容器用 `position:fixed`\n- ✅ 优先复用 `src/components/`\n';
  assert.equal(findCandidates(md, 'x.md').length, 2);
});

test('强制标记条目仍受范围限定词豁免', () => {
  const md = '## 关键流程\n\n- ⛔ 禁止塞假数据，但 mock 环境除外\n';
  assert.deepEqual(findCandidates(md, 'x.md'), []);
});

test('经验性章节里没有强制标记的条目不进候选', () => {
  const md = '## 容易踩的坑\n\n- **`v-show` 必须套在原生 `<view>` 上**。Skyline 下不生效。\n';
  assert.deepEqual(findCandidates(md, 'x.md'), []);
});

test('经验性章节里带强制标记的条目仍进候选', () => {
  // 作者标了强制级别的，哪怕写在「坑」小节里也要查
  const md = '## 容易踩的坑\n\n- ⛔ 禁止绕开公共组件自行实现\n';
  assert.equal(findCandidates(md, 'x.md').length, 1);
});

test('由事实推出的后果不算规则条款', () => {
  const md = '- **重设 `canvas.width/height` 会清掉 ctx 的状态**，所以 `ctx.scale()` 必须放在它后面。\n';
  assert.deepEqual(findCandidates(md, 'x.md'), []);
});

test('「新会话」这类含「会」的词不误判为因果连接', () => {
  const md = '- **辅食「新会话」必须先 `clearBabyGreeting()` 再 `loadBabyGreeting()`**。\n';
  assert.equal(findCandidates(md, 'x.md').length, 1);
});

test('列表项各算独立段落', () => {
  const md = '- 第一条禁止 A\n- 第二条禁止 B\n';
  const blocks = splitBlocks(md);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].line, 1);
  assert.equal(blocks[1].line, 2);
});

test('空行分隔的普通段落', () => {
  const md = '第一段\n继续第一段\n\n第二段\n';
  const blocks = splitBlocks(md);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].text.includes('继续第一段'));
});

test('识别绝对化指令词', () => {
  assert.equal(hasAbsolute('禁止做出假设'), true);
  assert.equal(hasAbsolute('MUST be green'), true);
  assert.equal(hasAbsolute('一律用节流'), true);
  assert.equal(hasAbsolute('这里没有绝对词'), false);
});

test('识别范围限定词', () => {
  assert.equal(hasQualifier('禁止 X，但 Y 除外'), true);
  assert.equal(hasQualifier('仅当命中缓存时跳过'), true);
  assert.equal(hasQualifier('禁止做出假设'), false);
});

test('捞出无限定的绝对化条目', () => {
  const md = '- 禁止做出假设，结论必须给出依据\n- 禁止提交无法编译的代码，但 WIP 分支除外\n';
  const c = findCandidates(md, 'CLAUDE.md');
  assert.equal(c.length, 1);
  assert.ok(c[0].text.includes('禁止做出假设'));
  assert.equal(c[0].file, 'CLAUDE.md');
  assert.equal(c[0].line, 1);
});

test('没有绝对化词的段落不进候选', () => {
  assert.deepEqual(findCandidates('优先复用公共组件。\n', 'x.md'), []);
});

test('真实反例必须被捞出', () => {
  const md = '- ⛔ **禁止做出假设**——具体结论必须给出 `文件:行号` 依据\n';
  const c = findCandidates(md, 'CLAUDE.md');
  assert.equal(c.length, 1);
});

test('带范围限定的改写版不再是候选', () => {
  // 这是修复后的写法，不该再被捞出来
  const md = '- ⛔ 禁止做出假设——关于代码如何工作的结论必须给出依据。但需求里用户给定的值是输入不是假设，直接用。\n';
  assert.deepEqual(findCandidates(md, 'CLAUDE.md'), []);
});

test('代码围栏内的内容不当规则', () => {
  const md = '正常段落\n\n```bash\npnpm type-check  # 必须全绿\n```\n\n后续段落\n';
  const c = findCandidates(md, 'x.md');
  assert.equal(c.filter((x) => x.text.includes('type-check')).length, 0);
});

test('markdown 表格行不当规则', () => {
  const md = '| 项目 | 说明 |\n| --- | --- |\n| 所有组件 | 必须显式 import |\n';
  assert.deepEqual(findCandidates(md, 'x.md'), []);
});

test('章节标题不当规则', () => {
  const md = '### 禁止规则\n\n- 禁止提交无法编译的代码\n';
  const c = findCandidates(md, 'x.md');
  assert.equal(c.length, 1);
  assert.ok(!c[0].text.startsWith('#'));
});

test('围栏结束后恢复正常捞取', () => {
  const md = '```\n禁止 A\n```\n\n- 禁止 B\n';
  const c = findCandidates(md, 'x.md');
  assert.equal(c.length, 1);
  assert.ok(c[0].text.includes('禁止 B'));
});

test('范围 不再作为限定词豁免', () => {
  // 「影响范围」是描述性用语，不该让这条规则被豁免
  const md = '- 禁止跨模块直接 import，影响范围较大\n';
  assert.equal(findCandidates(md, 'x.md').length, 1);
});

test('检测超长文件', () => {
  const r = evaluatePrompts({ candidates: [], oversizedFiles: ['a.md'], duplicateGroups: [], verdicts: null });
  assert.equal(r.score, 95);
  assert.equal(r.issues[0].code, 'P3_OVERSIZED_RULE');
});

test('检测重复条目', () => {
  const r = evaluatePrompts({ candidates: [], oversizedFiles: [], duplicateGroups: [{ file: 'a.md', text: 'x', lines: [3, 9] }], verdicts: null });
  assert.equal(r.score, 97);
  assert.equal(r.issues[0].code, 'P4_DUPLICATE');
});

test('无 LLM 判定时按候选数保守估计并标 partial', () => {
  const r = evaluatePrompts({
    candidates: [{ file: 'a.md', line: 1, text: 'x' }, { file: 'a.md', line: 2, text: 'y' }],
    oversizedFiles: [], duplicateGroups: [], verdicts: null,
  });
  assert.equal(r.status, 'partial');
  assert.equal(r.score, 92); // 100 - 2*4
});

test('有 LLM 判定时按 verdict 扣分并标 done', () => {
  const r = evaluatePrompts({
    candidates: [{ file: 'a.md', line: 1, text: 'x' }, { file: 'a.md', line: 2, text: 'y' }],
    oversizedFiles: [], duplicateGroups: [],
    verdicts: [
      { line: 1, verdict: 'over-broad', reason: 'r1', suggestion: 's1' },
      { line: 2, verdict: 'acceptable', reason: 'r2' },
    ],
  });
  assert.equal(r.status, 'done');
  assert.equal(r.score, 92); // 100 - 8（只有 over-broad 扣分）
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].code, 'P1_OVER_BROAD');
  // P1/P2 改为可自动修：护栏是「只改 .md（扩展名白名单）+ 定点修订不许重写段落 + 全量备份」，
  // 改动面被限制在文档层。P3（需新建文件）与整改清单仍走人工，见 check-prompts.logic.js 的注释
  assert.equal(r.issues[0].fixable, true);
});

test('conflicting 扣 12 分', () => {
  const r = evaluatePrompts({
    candidates: [{ file: 'a.md', line: 1, text: 'x' }],
    oversizedFiles: [], duplicateGroups: [],
    verdicts: [{ line: 1, verdict: 'conflicting', reason: 'r' }],
  });
  assert.equal(r.score, 88);
  assert.equal(r.issues[0].code, 'P2_CONFLICTING');
});

test('候选为 0 时直接满分 done', () => {
  const r = evaluatePrompts({ candidates: [], oversizedFiles: [], duplicateGroups: [], verdicts: null });
  assert.equal(r.score, 100);
  assert.equal(r.status, 'done'); // 没候选就不用调 LLM，直接定论
});

test('分数下限为 0', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ file: 'a.md', line: i, text: 'x' }));
  const r = evaluatePrompts({ candidates: many, oversizedFiles: [], duplicateGroups: [], verdicts: null });
  assert.equal(r.score, 0);
});

// —— verdictLog：判定层可审计 ——
// 只有 over-broad/conflicting 会变成 issue，acceptable/not-a-rule 连同模型给的 reason 一起被丢弃。
// 后果是出现「0 over-broad」这种结果时，无法区分「模型认真判了且都合格」和「模型摆烂/漏判」。
// verdictLog 把全部判定原样留档，不产 issue、不扣分，纯供事后审计与回归对比。

test('verdictLog 记录全部判定，不只是有问题的那些', () => {
  const r = evaluatePrompts({
    candidates: [
      { file: 'a.md', line: 1, text: '条目一' },
      { file: 'a.md', line: 2, text: '条目二' },
      { file: 'b.md', line: 3, text: '条目三' },
    ],
    oversizedFiles: [], duplicateGroups: [],
    verdicts: [
      { file: 'a.md', line: 1, verdict: 'over-broad', reason: 'r1', suggestion: 's1' },
      { file: 'a.md', line: 2, verdict: 'acceptable', reason: 'r2' },
      { file: 'b.md', line: 3, verdict: 'not-a-rule', reason: 'r3' },
    ],
  });
  assert.equal(r.verdictLog.length, 3);
  assert.deepEqual(r.verdictLog.map((v) => v.verdict), ['over-broad', 'acceptable', 'not-a-rule']);
  // 只有 over-broad 进 issues
  assert.equal(r.issues.filter((i) => i.code === 'P1_OVER_BROAD').length, 1);
});

test('verdictLog 每条带原文与理由，按 file#line 精确回锚', () => {
  const r = evaluatePrompts({
    candidates: [
      { file: 'a.md', line: 47, text: '来自 a 的原文' },
      { file: 'b.md', line: 47, text: '来自 b 的原文' },
    ],
    oversizedFiles: [], duplicateGroups: [],
    verdicts: [
      { file: 'a.md', line: 47, verdict: 'acceptable', reason: 'ra' },
      { file: 'b.md', line: 47, verdict: 'acceptable', reason: 'rb' },
    ],
  });
  const a = r.verdictLog.find((v) => v.file === 'a.md');
  const b = r.verdictLog.find((v) => v.file === 'b.md');
  assert.equal(a.text, '来自 a 的原文');
  assert.equal(a.reason, 'ra');
  assert.equal(b.text, '来自 b 的原文');
  assert.equal(b.reason, 'rb');
});

test('verdictLog 截断超长文本，避免 optimize.json 膨胀', () => {
  const r = evaluatePrompts({
    candidates: [{ file: 'a.md', line: 1, text: 'x'.repeat(500) }],
    oversizedFiles: [], duplicateGroups: [],
    verdicts: [{ file: 'a.md', line: 1, verdict: 'acceptable', reason: 'y'.repeat(800) }],
  });
  assert.ok(r.verdictLog[0].text.length <= 200);
  assert.ok(r.verdictLog[0].reason.length <= 300);
});

test('没有判定时 verdictLog 为空数组', () => {
  const r = evaluatePrompts({
    candidates: [{ file: 'a.md', line: 1, text: 'x' }],
    oversizedFiles: [], duplicateGroups: [], verdicts: null,
  });
  assert.deepEqual(r.verdictLog, []);
});

test('verdictLog 不影响 score', () => {
  const withLog = evaluatePrompts({
    candidates: [{ file: 'a.md', line: 1, text: 'x' }, { file: 'a.md', line: 2, text: 'y' }],
    oversizedFiles: [], duplicateGroups: [],
    verdicts: [
      { file: 'a.md', line: 1, verdict: 'acceptable', reason: 'r' },
      { file: 'a.md', line: 2, verdict: 'not-a-rule', reason: 'r' },
    ],
  });
  assert.equal(withLog.score, 100); // 两条都不扣分
  assert.equal(withLog.verdictLog.length, 2);
});
