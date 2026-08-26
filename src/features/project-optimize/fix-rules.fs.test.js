/**
 * fix-rules.js（降级执行层）的文件系统测试。
 *
 * 每个用例把 tests/fixtures/projects/demote-target 拷进临时目录再动手——
 * 这一层做的是删文件、改写全仓引用这类不可逆操作，直接对夹具跑会把夹具本身毁掉。
 *
 * describeSkill 一律注入桩件：真调用一次 $0.22 且要等一分钟，
 * 而这一层要验证的是「五步顺序、归档排除、失败即停」，与 description 写得好不好无关。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMarkdown, planDemote, demoteOne } from './fix-rules.js';
import { stripFrontmatter } from './fix-rules.logic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'projects', 'demote-target');

/** 把夹具拷成一个用完即弃的项目目录 */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demote-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

/** description 生成桩：返回定长文本，不发任何请求 */
const stubDescribe = async (name) => ({ description: `${name} 的测试用描述，说明范围与触发场景。`, source: 'llm' });

// ---------- collectMarkdown ----------

test('收集仓库内的 md，路径为正斜杠相对路径', () => {
  const dir = makeProject();
  const got = collectMarkdown(dir);
  assert.deepEqual(got, [
    '.claude/rules/big-wide.md',
    '.claude/rules/small-narrow.md',
    'CLAUDE.md',
    'docs/guide.md',
  ]);
  clean(dir);
});

test('归档目录里的 md 不收', () => {
  // docs/specs 记录的是当时的事实，改掉等于篡改历史
  const dir = makeProject();
  assert.ok(!collectMarkdown(dir).includes('docs/specs/archived.md'));
  clean(dir);
});

test('依赖与构建产物目录不收', () => {
  const dir = makeProject();
  for (const sub of ['node_modules/pkg', 'dist', '.claude/worktrees/feat-x']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.writeFileSync(path.join(dir, sub, 'README.md'), '# x');
  }
  const got = collectMarkdown(dir);
  assert.ok(!got.some((p) => p.includes('node_modules')), 'node_modules 应被跳过');
  assert.ok(!got.some((p) => p.startsWith('dist/')), 'dist 应被跳过');
  // worktree 是另一个分支的完整签出，往里写等于污染别的分支的工作区
  assert.ok(!got.some((p) => p.includes('worktrees')), 'worktrees 应被跳过');
  clean(dir);
});

test('非 md 文件不收', () => {
  const dir = makeProject();
  assert.ok(!collectMarkdown(dir).some((p) => p.endsWith('.js')));
  clean(dir);
});

// ---------- planDemote ----------

test('计划涵盖删除、新建、引用改写三类', () => {
  const dir = makeProject();
  const plan = planDemote(dir, ['big-wide.md']);
  const byPath = new Map(plan.map((e) => [e.path, e.action]));

  assert.equal(byPath.get('.claude/rules/big-wide.md'), 'deleted');
  assert.equal(byPath.get('.claude/skills/big-wide/SKILL.md'), 'created');
  assert.equal(byPath.get('CLAUDE.md'), 'modified');
  assert.equal(byPath.get('docs/guide.md'), 'modified');
  clean(dir);
});

test('没有引用该规则的文件不进计划', () => {
  const dir = makeProject();
  const paths = planDemote(dir, ['big-wide.md']).map((e) => e.path);
  assert.ok(!paths.includes('.claude/rules/small-narrow.md'));
  assert.ok(!paths.includes('docs/specs/archived.md'), '归档文件不该进计划');
  clean(dir);
});

test('planDemote 不产生任何副作用', () => {
  // 它的结果要喂给 createBackup 做快照，一旦它自己先改了盘，快照记录的就不是原始状态
  const dir = makeProject();
  const before = collectMarkdown(dir).map((p) => read(dir, p));
  planDemote(dir, ['big-wide.md']);
  const after = collectMarkdown(dir).map((p) => read(dir, p));
  assert.deepEqual(after, before);
  clean(dir);
});

// ---------- demoteOne 正常路径 ----------

test('降级写出 skill、删除原文件、改写引用', async () => {
  const dir = makeProject();
  const body = stripFrontmatter(read(dir, '.claude/rules/big-wide.md'));

  const r = await demoteOne(dir, 'big-wide.md', { describe: stubDescribe });

  assert.equal(r.status, 'done');
  assert.equal(r.skillName, 'big-wide');
  assert.equal(r.descriptionSource, 'llm');

  const skill = read(dir, '.claude/skills/big-wide/SKILL.md');
  assert.ok(skill.startsWith('---\nname: big-wide\ndescription: big-wide 的测试用描述'));
  assert.ok(skill.endsWith(body), '正文应与原文剥掉 frontmatter 后完全一致');

  assert.ok(!fs.existsSync(path.join(dir, '.claude/rules/big-wide.md')), '原 rules 文件应被删除');

  assert.ok(read(dir, 'CLAUDE.md').includes('`/big-wide` 技能'));
  assert.ok(read(dir, 'docs/guide.md').includes('`/big-wide` 技能'));
  assert.deepEqual(r.refsUpdated.sort(), ['CLAUDE.md', 'docs/guide.md']);
  assert.deepEqual(r.refsFailed, []);
  clean(dir);
});

test('归档目录里的引用一个字都不改', async () => {
  const dir = makeProject();
  const before = read(dir, 'docs/specs/archived.md');
  await demoteOne(dir, 'big-wide.md', { describe: stubDescribe });
  assert.equal(read(dir, 'docs/specs/archived.md'), before);
  clean(dir);
});

test('没有引用的文件不被改写', async () => {
  const dir = makeProject();
  const before = read(dir, '.claude/rules/small-narrow.md');
  const r = await demoteOne(dir, 'big-wide.md', { describe: stubDescribe });
  assert.equal(read(dir, '.claude/rules/small-narrow.md'), before);
  assert.ok(!r.refsUpdated.includes('.claude/rules/small-narrow.md'));
  clean(dir);
});

test('onStep 按五步顺序回调', async () => {
  const dir = makeProject();
  const steps = [];
  await demoteOne(dir, 'big-wide.md', { describe: stubDescribe, onStep: (s) => steps.push(s.step) });
  assert.deepEqual(steps, ['describe', 'write-skill', 'delete-rule', 'replace-refs']);
  clean(dir);
});

test('回报生成的 description 全文与 skill 文件路径', async () => {
  // UI 要把 description 原文摊给用户当场核对（它决定 skill 能不能被唤起，而写砸了不会报错）；
  // 只给 source 的话用户还得自己去翻文件
  const dir = makeProject();
  const r = await demoteOne(dir, 'big-wide.md', { describe: stubDescribe });
  assert.equal(r.description, 'big-wide 的测试用描述，说明范围与触发场景。');
  assert.equal(r.skillFile, '.claude/skills/big-wide/SKILL.md');
  assert.equal(read(dir, r.skillFile).includes(r.description), true, '回报的应当就是真正写进文件的那一句');
});

test('跳过与失败时 description 为空但 skillFile 仍给出', async () => {
  const dir = makeProject();
  fs.mkdirSync(path.join(dir, '.claude/skills/big-wide'), { recursive: true });
  const r = await demoteOne(dir, 'big-wide.md', { describe: stubDescribe });
  assert.equal(r.description, null);
  assert.equal(r.skillFile, '.claude/skills/big-wide/SKILL.md', '路径要给，用户才知道是哪个文件挡住了');
  clean(dir);
});

test('兜底生成的 description 会如实标注来源', async () => {
  // source 是上层提示用户「这条要人工复核」的唯一依据，不能被吞掉
  const dir = makeProject();
  const r = await demoteOne(dir, 'big-wide.md', {
    describe: async () => ({ description: '机械兜底文案，长度够。', source: 'fallback' }),
  });
  assert.equal(r.descriptionSource, 'fallback');
  clean(dir);
});

// ---------- demoteOne 前置校验 ----------

test('目标 skill 已存在时跳过，且不删原文件', async () => {
  const dir = makeProject();
  fs.mkdirSync(path.join(dir, '.claude/skills/big-wide'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/skills/big-wide/SKILL.md'), '手工写的，不许覆盖');

  const r = await demoteOne(dir, 'big-wide.md', { describe: stubDescribe });

  assert.equal(r.status, 'skipped');
  assert.ok(fs.existsSync(path.join(dir, '.claude/rules/big-wide.md')), '跳过时原文件必须保留');
  assert.equal(read(dir, '.claude/skills/big-wide/SKILL.md'), '手工写的，不许覆盖');
  clean(dir);
});

test('源文件不存在时失败，但不算核心失败', async () => {
  // 什么都还没写，文件系统是干净的，后续文件可以照常处理
  const dir = makeProject();
  const r = await demoteOne(dir, 'nope.md', { describe: stubDescribe });
  assert.equal(r.status, 'failed');
  assert.equal(r.fatal, false);
  assert.ok(!fs.existsSync(path.join(dir, '.claude/skills/nope')), '失败时不该留下半个 skill 目录');
  clean(dir);
});

test('前置校验失败时不调用 describe（不白烧额度）', async () => {
  const dir = makeProject();
  let called = 0;
  await demoteOne(dir, 'nope.md', { describe: async (...a) => { called += 1; return stubDescribe(...a); } });
  assert.equal(called, 0);
  clean(dir);
});

test('describe 抛异常也不外泄，算非核心失败', async () => {
  // demoteOne 的契约是「从不抛异常，一切通过 status 表达」——
  // 上层是个循环，一次抛错会把整批降级掀翻在半路
  const dir = makeProject();
  const r = await demoteOne(dir, 'big-wide.md', {
    describe: async () => { throw new Error('炸了'); },
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.fatal, false, '还没写任何东西，后续文件可以照常处理');
  assert.ok(fs.existsSync(path.join(dir, '.claude/rules/big-wide.md')));
  assert.ok(!fs.existsSync(path.join(dir, '.claude/skills/big-wide')));
  clean(dir);
});

// ---------- demoteOne 核心失败 ----------

test('写 skill 失败标记为核心失败，且不删原文件', async () => {
  // .claude/skills 被占成普通文件 → mkdir 必然失败
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, '.claude/skills'), 'not a dir');

  const r = await demoteOne(dir, 'big-wide.md', { describe: stubDescribe });

  assert.equal(r.status, 'failed');
  assert.equal(r.fatal, true, '文件系统处于半完成状态，必须让上层停下来');
  assert.ok(fs.existsSync(path.join(dir, '.claude/rules/big-wide.md')), '写不成 skill 就绝不能删原文件');
  clean(dir);
});

test('引用替换失败不算核心失败', async () => {
  // 引用没替全只是文档里留了旧路径，skill 本身照常可用，不该阻断后续文件
  const dir = makeProject();
  const guide = path.join(dir, 'docs/guide.md');
  fs.chmodSync(guide, 0o444); // Windows 上映射为只读属性，写入抛 EPERM

  const r = await demoteOne(dir, 'big-wide.md', { describe: stubDescribe });

  assert.equal(r.status, 'done', '核心三步都成了，整体就算成功');
  assert.equal(r.fatal, false);
  assert.deepEqual(r.refsUpdated, ['CLAUDE.md']);
  assert.equal(r.refsFailed.length, 1);
  assert.equal(r.refsFailed[0].path, 'docs/guide.md');

  fs.chmodSync(guide, 0o666); // 不改回来 rmSync 删不掉
  clean(dir);
});
