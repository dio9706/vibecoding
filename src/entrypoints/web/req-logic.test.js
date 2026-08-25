import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectRoleLines, buildDocgenPrompt, buildRevisePrompt, extractSummary, nextDocVersion,
  buildDevelopPrompt, buildApiFixPrompt, buildBugFixPrompt,
  verdictToBug, mergeBugs, buildArchiveSummary, reqBranchName, pickCwdAndDirs,
  buildSeedPrompt, extractPitfalls, splitPitfallsByProject, mergePitfalls, parseFeatureTag,
} from './req-logic.js';

const PROJECTS = {
  frontend: { dir: 'D:/work/ui', dev: true },
  backend: { dir: 'D:/work/server', dev: false },
};

test('projectRoleLines：开发/只读角色显式声明；null 工程跳过', () => {
  const lines = projectRoleLines(PROJECTS).join('\n');
  assert.match(lines, /前端工程.*D:\/work\/ui.*【开发工程】/);
  assert.match(lines, /后端工程.*D:\/work\/server.*【只读参考工程，禁止修改其中任何文件】/);
  assert.equal(projectRoleLines({ frontend: null, backend: null }).length, 0);
});

test('pickCwdAndDirs：前端优先为 cwd，其余目录进 addDirs；单工程 addDirs 空', () => {
  assert.deepEqual(pickCwdAndDirs(PROJECTS), { cwd: 'D:/work/ui', addDirs: ['D:/work/server'] });
  assert.deepEqual(pickCwdAndDirs({ frontend: null, backend: { dir: 'D:/s', dev: true } }),
    { cwd: 'D:/s', addDirs: [] });
  assert.equal(pickCwdAndDirs({ frontend: null, backend: null }).cwd, null);
});

test('extractSummary：抽「说人话总结」节；解析失败取前 300 字', () => {
  const md = '## 一、说人话总结\n本次要在前端加扫码收银页。\n改动 6 个文件。\n\n## 二、详细设计\n...';
  assert.equal(extractSummary(md), '本次要在前端加扫码收银页。\n改动 6 个文件。');
  const noSec = 'x'.repeat(400);
  assert.equal(extractSummary(noSec), 'x'.repeat(300));
});

test('nextDocVersion：空=1，否则 max+1', () => {
  assert.equal(nextDocVersion({ versions: [] }), 1);
  assert.equal(nextDocVersion({ versions: [{ v: 1 }, { v: 3 }] }), 4);
});

test('buildDocgenPrompt/buildRevisePrompt：注入需求文档、补充、角色表与输出契约', () => {
  const p = buildDocgenPrompt({ reqDocText: '需求正文', supplements: [{ text: '补充1', files: [] }], projects: PROJECTS });
  assert.match(p, /需求正文/);
  assert.match(p, /补充1/);
  assert.match(p, /## 一、说人话总结/);
  assert.match(p, /只输出 markdown/);
  const rp = buildRevisePrompt({ supplement: { text: '新补充', files: [{ name: 'a.png', path: 'C:/a.png' }] } });
  assert.match(rp, /新补充/);
  assert.match(rp, /C:\/a\.png/);
});

test('verdictToBug：fix→sure/pending；ask|reject→doubt 带 reason', () => {
  const b = verdictToBug({ recordId: 'rec1', title: 'T', detail: 'D' }, { verdict: 'fix', reason: '' });
  assert.equal(b.verdict, 'sure');
  assert.equal(b.status, 'pending');
  assert.equal(b.recordId, 'rec1');
  assert.match(b.id, /^b_/);
  const d = verdictToBug({ recordId: 'rec2', title: 'T2', detail: 'D2' }, { verdict: 'ask', reason: '无法定位' });
  assert.equal(d.verdict, 'doubt');
  assert.equal(d.reason, '无法定位');
});

test('mergeBugs：按 recordId 去重，已存在保留原状态，新记录追加', () => {
  const old = [{ id: 'b1', recordId: 'rec1', status: 'fixed' }];
  const merged = mergeBugs(old, [{ id: 'b9', recordId: 'rec1', status: 'pending' }, { id: 'b2', recordId: 'rec2', status: 'pending' }]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((b) => b.recordId === 'rec1').status, 'fixed');
});

test('buildDevelopPrompt：设计准则/API 文档非空才附，为空则不出现对应段落', () => {
  const bare = buildDevelopPrompt({ req: { projects: PROJECTS, designGuidelines: '', apiDocs: [] }, docPath: 'D:/dev-doc-v1.md' });
  assert.match(bare, /D:\/dev-doc-v1\.md/);
  assert.doesNotMatch(bare, /设计准则/);
  assert.doesNotMatch(bare, /API 文档/);
  const full = buildDevelopPrompt({
    req: { projects: PROJECTS, designGuidelines: '统一走扫码组件', apiDocs: [{ name: '支付回调', path: 'D:/api/pay.md' }] },
    docPath: 'D:/dev-doc-v1.md',
  });
  assert.match(full, /设计准则/);
  assert.match(full, /统一走扫码组件/);
  assert.match(full, /API 文档/);
  assert.match(full, /支付回调.*D:\/api\/pay\.md/);
});

test('buildApiFixPrompt：删除动作不附路径段，新增/更新附路径引导 Read', () => {
  const del = buildApiFixPrompt({ action: '删除', doc: { name: '支付回调', path: 'D:/api/pay.md' } });
  assert.match(del, /已删除/);
  assert.doesNotMatch(del, /D:\/api\/pay\.md/);
  const upd = buildApiFixPrompt({ action: '更新', doc: { name: '支付回调', path: 'D:/api/pay.md' } });
  assert.match(upd, /已更新/);
  assert.match(upd, /D:\/api\/pay\.md/);
});

test('buildBugFixPrompt：标题与详情注入', () => {
  const p = buildBugFixPrompt({ bug: { title: '扫码闪退', detail: '安卓机型偶现' } });
  assert.match(p, /扫码闪退/);
  assert.match(p, /安卓机型偶现/);
});

test('reqBranchName：req/<id去前缀>-<slug 截断>', () => {
  assert.match(reqBranchName({ id: 'r_abc123', title: '扫码支付改造' }), /^req\/abc123-/);
});

test('buildArchiveSummary：文档版次/分支提交/BUG 统计/备注齐备；分支日志按 dir 索引（同名分支多工程不互相覆盖）', () => {
  const s = buildArchiveSummary({
    req: {
      title: 'T',
      devDoc: { versions: [{ v: 3, path: 'D:/reqs/r1/dev-doc-v3.md' }] },
      // 前后端两个工程共用同一 branch 名（finalize 多工程定稿的真实产出），只有 dir 不同
      branches: [
        { dir: 'D:/ui', branch: 'req/x', baseBranch: 'main' },
        { dir: 'D:/server', branch: 'req/x', baseBranch: 'main' },
      ],
      bugs: [{ status: 'fixed', title: 'b1' }, { status: 'ignored', title: 'b2' }],
    },
    note: '注意灰度',
    branchLogs: [
      { dir: 'D:/ui', log: 'abc1234 前端提交' },
      { dir: 'D:/server', log: null },
    ],
  });
  assert.match(s, /开发文档.*v3/);
  assert.match(s, /终稿引用：D:\/reqs\/r1\/dev-doc-v3\.md/); // spec §5.5：契约演进，终稿须留文件路径引用
  // 按 dir 索引：即便两个工程 branch 同名，各自仍渲染各自的提交摘要，互不覆盖
  assert.match(s, /- D:\/ui 分支 req\/x（基线 main）\n```\nabc1234 前端提交\n```/);
  assert.match(s, /- D:\/server 分支 req\/x（基线 main）\n（无法读取提交摘要）/);
  assert.match(s, /修复 1/);
  assert.match(s, /注意灰度/);
});

test('buildArchiveSummary：无开发文档版本记录 → 终稿引用降级为「（无路径记录）」', () => {
  const s = buildArchiveSummary({ req: { title: 'T', devDoc: { versions: [] }, branches: [], bugs: [] }, note: '', branchLogs: [] });
  assert.match(s, /终稿引用：（无路径记录）/);
});

test('buildSeedPrompt：包含需求标题、分支、工程角色、开发文档、设计准则', () => {
  const req = {
    id: 'r_abc123',
    title: '扫码支付改造',
    projects: PROJECTS,
    devDoc: { versions: [{ v: 1, path: 'D:/reqs/r1/dev-doc-v1.md' }] },
    designGuidelines: '统一走扫码组件',
  };
  const seed = buildSeedPrompt(req);
  assert.match(seed, /扫码支付改造/);
  assert.match(seed, /req\/abc123-/);
  assert.match(seed, /前端.*开发/);
  assert.match(seed, /后端.*只读/);
  assert.match(seed, /D:\/reqs\/r1\/dev-doc-v1\.md/);
  assert.match(seed, /统一走扫码组件/);
  assert.match(seed, /避坑清单已由仓库 CLAUDE\.md 引入/);
});

test('buildSeedPrompt：设计准则为空时省略', () => {
  const req = {
    id: 'r_xyz',
    title: '功能A',
    projects: PROJECTS,
    devDoc: { versions: [{ v: 1, path: 'D:/doc.md' }] },
    designGuidelines: '',
  };
  const seed = buildSeedPrompt(req);
  assert.match(seed, /功能A/);
  assert.doesNotMatch(seed, /【设计准则】/);
});

test('buildSeedPrompt：无工程配置时 cwd 为 null，略过角色段', () => {
  const req = {
    id: 'r_no_proj',
    title: '无工程需求',
    projects: { frontend: null, backend: null },
    devDoc: { versions: [] },
  };
  const seed = buildSeedPrompt(req);
  assert.match(seed, /无工程需求/);
  assert.doesNotMatch(seed, /【前端】/);
  assert.doesNotMatch(seed, /【后端】/);
});

test('extractPitfalls：正确识别 PITFALLS-BEGIN/END 块（含注释）', () => {
  const text = `前面的文字
<!-- PITFALLS-BEGIN -->
- [前端] 去抖逻辑需谨慎
- [后端] 缓存更新顺序不能乱
<!-- PITFALLS-END -->
后面的文字`;
  const block = extractPitfalls(text);
  assert.ok(block);
  assert.match(block, /PITFALLS-BEGIN/);
  assert.match(block, /PITFALLS-END/);
  assert.match(block, /去抖逻辑/);
  assert.match(block, /缓存更新顺序/);
});

test('extractPitfalls：无块时返回 null', () => {
  const text = '普通文本，没有 PITFALLS 块';
  assert.equal(extractPitfalls(text), null);
});

test('extractPitfalls：空白不敏感', () => {
  const text = `<!-- PITFALLS-BEGIN   -->
- [前端] 测试
<!--   PITFALLS-END -->`;
  const block = extractPitfalls(text);
  assert.ok(block);
  assert.match(block, /测试/);
});

test('extractPitfalls：null/undefined 防御，返回 null', () => {
  assert.equal(extractPitfalls(null), null);
  assert.equal(extractPitfalls(undefined), null);
});

test('splitPitfallsByProject：按前缀分流前端/后端条目', () => {
  const block = `<!-- PITFALLS-BEGIN -->
- [前端] 去抖逻辑需谨慎
- [前端] 防止多次点击
- [后端] 缓存更新顺序不能乱
- [后端] 并发控制要加锁
<!-- PITFALLS-END -->`;
  const { frontend, backend } = splitPitfallsByProject(block);
  assert.deepEqual(frontend, ['去抖逻辑需谨慎', '防止多次点击']);
  assert.deepEqual(backend, ['缓存更新顺序不能乱', '并发控制要加锁']);
});

test('splitPitfallsByProject：非前端/后端前缀的列表项被略过', () => {
  const block = `<!-- PITFALLS-BEGIN -->
- [其他] 杂项
- [前端] 有效条目
- 无标签条目
<!-- PITFALLS-END -->`;
  const { frontend, backend } = splitPitfallsByProject(block);
  assert.deepEqual(frontend, ['有效条目']);
  assert.deepEqual(backend, []);
});

test('splitPitfallsByProject：null 防御，返回空数组结构', () => {
  const result = splitPitfallsByProject(null);
  assert.deepEqual(result, { frontend: [], backend: [] });
});

test('mergePitfalls：去重合并，不超 30 条', () => {
  const existing = ['前端：避免使用全局变量造成副作用的问题很严重'];
  const incoming = ['前端：避免使用全局变量造成副作用的问题很的边界', '后端：缓存一致性问题'];
  const { items, truncated, removed } = mergePitfalls(existing, incoming);
  // 前两条首 20 字相同（都是 "前端：避免使用全局变量造成副作用的问题很"），所以第二条不加入
  assert.deepEqual(items, ['前端：避免使用全局变量造成副作用的问题很严重', '后端：缓存一致性问题']);
  assert.equal(truncated, false);
  assert.equal(removed, 0);
});

test('mergePitfalls：超 30 条时截断，返回 truncated:true 与移除计数', () => {
  const existing = Array.from({ length: 20 }, (_, i) => `条目${i + 1}`);
  const incoming = Array.from({ length: 15 }, (_, i) => `新条目${i + 1}`);
  const { items, truncated, removed } = mergePitfalls(existing, incoming);
  assert.equal(items.length, 30);
  assert.equal(truncated, true);
  assert.equal(removed, 5); // 20 + 15 = 35 > 30，移除 5 条
  // 倒数第 3 条（index 28）应是截断标记
  assert.match(items[28], /已超限/);
});

test('mergePitfalls：空输入默认为空数组', () => {
  const { items } = mergePitfalls(undefined, []);
  assert.deepEqual(items, []);
});

test('parseFeatureTag：标准格式解析成功', () => {
  const doc = `## 一、说人话总结\n功能改造。\n\n## 二、详细设计\n文件清单。\n\n## 三、功能模块标签\n暂无模块，请新建。\n本需求所属功能模块：宝宝辅食`;
  assert.equal(parseFeatureTag(doc), '宝宝辅食');
});

test('parseFeatureTag：带书名号也能解析', () => {
  const doc = `## 三、功能模块标签\n已有模块列表。\n本需求所属功能模块：「宝宝辅食」`;
  assert.equal(parseFeatureTag(doc), '宝宝辅食');
});

test('parseFeatureTag：混合引号和圆括号也能解析', () => {
  const doc = `## 三、功能模块标签\n提示信息。\n本需求所属功能模块：【盘子需求】`;
  assert.equal(parseFeatureTag(doc), '盘子需求');
});

test('parseFeatureTag：无 §三 返回 null', () => {
  const doc = `## 一、说人话总结\n功能改造。\n\n## 二、详细设计\n文件清单。`;
  assert.equal(parseFeatureTag(doc), null);
});

test('parseFeatureTag：值为空字符串返回 null', () => {
  const doc = `## 三、功能模块标签\n已有模块。\n本需求所属功能模块：   `;
  assert.equal(parseFeatureTag(doc), null);
});

test('parseFeatureTag：值为纯引号返回 null', () => {
  const doc = `## 三、功能模块标签\n提示。\n本需求所属功能模块：「」`;
  assert.equal(parseFeatureTag(doc), null);
});

test('buildDocgenPrompt：prime 单独成节，且不与 supplements 混排', () => {
  const p = buildDocgenPrompt({
    reqDocText: '需求正文',
    prime: { text: '旧版本地筛选卡死过，务必走后端', files: [{ name: '复盘.md', path: '/t/复盘.md' }] },
    supplements: [{ text: '补充1', files: [] }],
    projects: PROJECTS,
  });
  assert.match(p, /旧版本地筛选卡死过/);
  assert.match(p, /复盘\.md/);
  // prime 是"文档之外的已知背景"，supplements 是"对已有文档提的调整"，
  // 两节标题必须不同，否则模型分不清哪个是背景哪个是修订意见
  assert.match(p, /背景与理解/);
  assert.match(p, /补充说明/);
  // prime 必须排在 supplements 之前：背景是前提，修订意见是在前提之上的增量
  assert.ok(p.indexOf('背景与理解') < p.indexOf('补充说明'));
});

test('buildDocgenPrompt：无 prime 时不产出空背景节', () => {
  const p = buildDocgenPrompt({ reqDocText: '需求正文', projects: PROJECTS });
  assert.doesNotMatch(p, /背景与理解/);
});

test('buildDocgenPrompt：prime 只有附件没正文时仍要输出', () => {
  // 用户可能只拖一份复盘文档进来、一个字不写，这时附件路径必须进 prompt
  const p = buildDocgenPrompt({
    reqDocText: '需求正文',
    prime: { text: '', files: [{ name: '复盘.md', path: '/t/复盘.md' }] },
    projects: PROJECTS,
  });
  assert.match(p, /背景与理解/);
  assert.match(p, /复盘\.md/);
});

test('buildDocgenPrompt：existingTags 注入到输出契约', () => {
  const p = buildDocgenPrompt({
    reqDocText: '需求正文',
    supplements: [],
    projects: PROJECTS,
    existingTags: ['宝宝辅食', '盘子需求'],
  });
  assert.match(p, /宝宝辅食/);
  assert.match(p, /盘子需求/);
  assert.match(p, /## 三、功能模块标签/);
  assert.match(p, /本需求所属功能模块：/);
});

test('buildDocgenPrompt：无 existingTags 显示新建提示', () => {
  const p = buildDocgenPrompt({
    reqDocText: '需求正文',
    supplements: [],
    projects: PROJECTS,
    existingTags: [],
  });
  assert.match(p, /暂无已有模块/);
  assert.match(p, /## 三、功能模块标签/);
});

test('buildRevisePrompt：currentTag 注入到输出契约 hint', () => {
  const p = buildRevisePrompt({
    supplement: { text: '新补充', files: [] },
    existingTags: ['宝宝辅食'],
    currentTag: '宝宝辅食',
  });
  assert.match(p, /当前已识别为「宝宝辅食」/);
  assert.match(p, /若无变化直接保持/);
});

test('buildRevisePrompt：无 currentTag 时不显示已识别提示', () => {
  const p = buildRevisePrompt({
    supplement: { text: '新补充', files: [] },
    existingTags: [],
  });
  assert.doesNotMatch(p, /当前已识别/);
  assert.match(p, /## 三、功能模块标签/);
});

const mockReqWithSnapshot = {
  id: 'r_babyFood',
  title: '改宝宝辅食',
  projects: { frontend: { dir: '/kxmall-app-ui', dev: true }, backend: null },
  devDoc: { versions: [{ v: 1, path: '/data/req/r_abc/dev-doc-v1.md', summary: '', at: '' }] },
  branches: [{ dir: '/kxmall-app-ui', branch: 'req/r_abc-babyFood', baseBranch: 'main' }],
  designGuidelines: '',
};

test('buildSeedPrompt：无 featureSnapshot 时不包含快照节', () => {
  const seed = buildSeedPrompt(mockReqWithSnapshot);
  assert.ok(!seed.includes('功能快照'));
});

test('buildSeedPrompt：有 featureSnapshot 时注入快照及开发规范', () => {
  const snapshot = {
    tag: '宝宝辅食',
    files: [
      { path: 'src/views/BabyFood.vue', count: 3 },
      { path: 'src/api/babyFood.js', count: 1 },
    ],
  };
  const seed = buildSeedPrompt(mockReqWithSnapshot, { featureSnapshot: snapshot });
  assert.ok(seed.includes('【功能快照·宝宝辅食】'));
  assert.ok(seed.includes('src/views/BabyFood.vue（出现 3 次）'));
  assert.ok(seed.includes('禁止全局 glob/grep'));
  assert.ok(seed.includes('[快照过期]'));
});
