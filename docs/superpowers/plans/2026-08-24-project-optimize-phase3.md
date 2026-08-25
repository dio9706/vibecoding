# 「项目优化」阶段三实现计划(一键优化 · rules 降级)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 让用户勾选「规范加载方式」维度后点「一键优化」,自动把体积大、paths 宽的 `.claude/rules/*.md` 降级为 skill,全程可还原。

**Architecture:** 纯逻辑(文本变换、manifest 计算)拆到 `*.logic.js` 单测;文件系统操作在薄 fs 层;唯一的 LLM 调用(生成 skill description)禁用全部工具、不落盘 session;进度走 SSE,job 状态自建轻量注册表(复用 `runs.js` 的 `sendTo` 发送)。

**Tech Stack:** Node 原生 ESM、`node --test`、原生 DOM。

**⚠️ 偏离 superpowers 默认:** 本项目 CLAUDE.md 规定不自动 git 提交。各 Task 以「验证 + 留工作区」收尾,不含 `git commit`。

**前置事实(已核实,可直接依赖):**
- `runClaude(prompt, opts)` 来自 `src/integrations/claude.js`,支持 `allowedTools`、`persistSession`、`maxTurns`
- `sendTo(res, event, data)` 来自 `src/store/runs.js`,通用 SSE 发送
- `sendJson` / `withJsonBody` / `str` 分别在 `src/entrypoints/web/{http-util,body,input}.js`
- `logger` 签名是 `logger.warn(tag, msg, extra)` 三段式
- 阶段一的 `src/store/optimize.js` 已有 `readOptimizeStore` / `getProjectRecord` / `saveCheckup`

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/features/project-optimize/fix-rules.logic.js` | 纯函数:frontmatter 剥离与重写、skill 名推导、引用替换的文本变换 |
| `src/features/project-optimize/describe-skill.js` | 生成 skill description(LLM + 机械降级) |
| `src/features/project-optimize/fix-rules.js` | fs 层:单个文件的降级执行 + 全仓引用替换 |
| `src/features/project-optimize/backup.logic.js` | 纯函数:manifest 生成、还原动作计算 |
| `src/features/project-optimize/backup.js` | fs 层:快照写入、还原、保留策略 |
| `src/features/project-optimize/git-guard.logic.js` | 纯函数:`git status --porcelain` 输出解析 |
| `src/features/project-optimize/git-guard.js` | fs 层:执行 git 命令 |
| `src/entrypoints/web/optimize-ops.js` | job 注册表 + 串行闸 + 编排 |
| `public/js/optimize-fix.logic.js` | 前端纯逻辑:进度步骤渲染数据、结果分组 |

---

## Task 1: 降级夹具

**Files:**
- Create: `tests/fixtures/projects/demote-target/CLAUDE.md`
- Create: `tests/fixtures/projects/demote-target/.claude/rules/big-wide.md`
- Create: `tests/fixtures/projects/demote-target/.claude/rules/small-narrow.md`
- Create: `tests/fixtures/projects/demote-target/docs/guide.md`
- Create: `tests/fixtures/projects/demote-target/docs/specs/archived.md`
- Create: `tests/fixtures/projects/demote-target/src/a/index.js`

- [ ] **Step 1: 建根地图(含引用)**

`tests/fixtures/projects/demote-target/CLAUDE.md`:

```markdown
# Demote 夹具

规范见 `.claude/rules/big-wide.md` 和 `.claude/rules/small-narrow.md`。

| 规则文件 | 覆盖 |
| --- | --- |
| `big-wide.md` | 大且宽 |
```

- [ ] **Step 2: 建两个 rules 文件**

`small-narrow.md`(小且窄,**不应**被降级):

```markdown
---
paths:
  - 'src/a/**/*.js'
---

# 窄规范

体积小、paths 窄，不该被降级。
```

`big-wide.md` 必须超过 5KB 且 paths 宽。生成命令(项目根执行):

```bash
mkdir -p tests/fixtures/projects/demote-target/.claude/rules
{ printf -- "---\npaths:\n  - 'src/**'\n---\n\n# 大宽规范\n\n## 第一节 命名\n\n## 第二节 布局\n\n## 第三节 禁令\n\n"; for i in $(seq 1 60); do echo "填充内容，把文件撑到 5KB 以上以触发降级判定。"; done; } > tests/fixtures/projects/demote-target/.claude/rules/big-wide.md
```

- [ ] **Step 3: 建三个引用点**

`docs/guide.md`(**应**被替换):

```markdown
# 指南

写弹框前先读 `.claude/rules/big-wide.md`。
```

`docs/specs/archived.md`(归档,**不应**被替换):

```markdown
# 历史设计文档

当时的规范在 `.claude/rules/big-wide.md`。
```

`src/a/index.js`:

```js
export const a = 1;
```

- [ ] **Step 4: 验证体积**

Run: `wc -c tests/fixtures/projects/demote-target/.claude/rules/big-wide.md`
Expected: > 5120。不足则加大 seq 上限重新生成。

- [ ] **Step 5: 留工作区,不提交**

---

## Task 2: 降级的文本变换(TDD)

**Files:**
- Create: `src/features/project-optimize/fix-rules.logic.js`
- Test: `src/features/project-optimize/fix-rules.logic.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillNameOf, stripFrontmatter, buildSkillFile, replaceRuleRefs, isArchivedPath } from './fix-rules.logic.js';

test('skill 名由文件名推导', () => {
  assert.equal(skillNameOf('design-system.md'), 'design-system');
  assert.equal(skillNameOf('popup-pattern.md'), 'popup-pattern');
});

test('剥掉 frontmatter 保留正文', () => {
  const raw = "---\npaths:\n  - 'src/**'\n---\n\n# 标题\n\n正文\n";
  assert.equal(stripFrontmatter(raw), '# 标题\n\n正文\n');
});

test('没有 frontmatter 时原样返回', () => {
  assert.equal(stripFrontmatter('# 标题\n正文\n'), '# 标题\n正文\n');
});

test('CRLF 的 frontmatter 也能剥', () => {
  const raw = "---\r\npaths:\r\n  - 'src/**'\r\n---\r\n\r\n# 标题\r\n";
  assert.ok(!stripFrontmatter(raw).includes('paths:'));
  assert.ok(stripFrontmatter(raw).includes('# 标题'));
});

test('组装 skill 文件', () => {
  const out = buildSkillFile({ name: 'foo', description: '一句话说明', body: '# 标题\n正文\n' });
  assert.ok(out.startsWith('---\nname: foo\ndescription: 一句话说明\n---\n\n'));
  assert.ok(out.endsWith('# 标题\n正文\n'));
});

test('description 里的换行会被压成空格', () => {
  // YAML 单行标量不能含换行，否则 frontmatter 解析会崩
  const out = buildSkillFile({ name: 'foo', description: '第一行\n第二行', body: 'x' });
  assert.ok(out.includes('description: 第一行 第二行'));
  assert.ok(!out.split('---')[1].includes('第一行\n第二行'));
});

test('替换反引号包裹的 rules 引用', () => {
  const md = '先读 `.claude/rules/popup-pattern.md`，照模板写。';
  assert.equal(replaceRuleRefs(md, 'popup-pattern'), '先读 `/popup-pattern` 技能，照模板写。');
});

test('替换后清掉「技能 的」这类多余空格', () => {
  const md = '读 `.claude/rules/keyboard-input-pattern.md` 的分支';
  assert.equal(replaceRuleRefs(md, 'keyboard-input-pattern'), '读 `/keyboard-input-pattern` 技能的分支');
});

test('不碰其它规则的引用', () => {
  const md = '见 `.claude/rules/other.md`';
  assert.equal(replaceRuleRefs(md, 'popup-pattern'), md);
});

test('一行里多处引用全部替换', () => {
  const md = '`.claude/rules/a.md` 和 `.claude/rules/a.md`';
  assert.equal(replaceRuleRefs(md, 'a'), '`/a` 技能 和 `/a` 技能');
});

test('归档路径判定', () => {
  assert.equal(isArchivedPath('docs/specs/x.md'), true);
  assert.equal(isArchivedPath('docs/plans/x.md'), true);
  assert.equal(isArchivedPath('docs/migration/2026/x.md'), true);
  assert.equal(isArchivedPath('.claude/optimize-backup/2026/x.md'), true);
  assert.equal(isArchivedPath('docs/guide.md'), false);
  assert.equal(isArchivedPath('CLAUDE.md'), false);
});

test('归档判定对反斜杠路径同样生效', () => {
  assert.equal(isArchivedPath('docs\\specs\\x.md'), true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/features/project-optimize/fix-rules.logic.test.js`
Expected: FAIL,`Cannot find module`

- [ ] **Step 3: 实现**

```js
/**
 * rules → skill 降级的纯文本变换。
 * 不碰文件系统，所有判断都可单测。
 */

const ARCHIVED = ['docs/specs/', 'docs/plans/', 'docs/migration/', '.claude/optimize-backup/'];

export function skillNameOf(fileName) {
  return String(fileName).replace(/\.md$/i, '');
}

/** 剥掉开头的 YAML frontmatter 块，保留正文 */
export function stripFrontmatter(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  if (!/^---[ \t]*\n/.test(text)) return text;
  const lines = text.split('\n');
  // 从第 2 行起找闭合分隔行
  const end = lines.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l));
  if (end === -1) return text;
  return lines.slice(end + 1).join('\n').replace(/^\n+/, '');
}

/**
 * 组装 skill 文件。
 * description 压成单行——YAML 单行标量不能含换行，否则加载 skill 时 frontmatter 解析会崩。
 */
export function buildSkillFile({ name, description, body }) {
  const desc = String(description || '').replace(/\s*\n\s*/g, ' ').trim();
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}`;
}

/**
 * 把 `.claude/rules/<name>.md` 的引用换成 `/<name>` 技能。
 *
 * 只替换反引号包裹的形式——地图和文档里引用路径都带反引号，
 * 裸写的路径多半出现在散文里（"rules 目录下的那些文件"），换了反而读不通。
 */
export function replaceRuleRefs(md, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('`\\.claude/rules/' + escaped + '\\.md`', 'g');
  let out = String(md || '').replace(re, '`/' + name + '` 技能');
  // 「技能 的」这类多余空格：原文是「`xxx.md` 的分支」，替换后成了「技能 的分支」
  out = out.replace(/技能 的/g, '技能的').replace(/技能 「/g, '技能「');
  return out;
}

/** 归档目录不参与引用替换——那里记录的是当时的事实，改掉等于篡改历史 */
export function isArchivedPath(relPath) {
  const p = String(relPath).replace(/\\/g, '/');
  return ARCHIVED.some((a) => p.startsWith(a) || p.includes('/' + a));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/features/project-optimize/fix-rules.logic.test.js`
Expected: PASS,12 个全绿

- [ ] **Step 5: 留工作区,不提交**

---

## Task 3: 备份的纯逻辑(TDD)

**Files:**
- Create: `src/features/project-optimize/backup.logic.js`
- Test: `src/features/project-optimize/backup.logic.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, restoreActionsOf, backupDirName } from './backup.logic.js';

test('备份目录名由时间戳生成且文件系统安全', () => {
  const n = backupDirName('2026-08-24T08:00:00.000Z');
  assert.ok(!n.includes(':'), '冒号在 Windows 路径里非法');
  assert.equal(n, '2026-08-24T08-00-00');
});

test('生成 manifest', () => {
  const m = buildManifest({
    at: '2026-08-24T08:00:00.000Z',
    dir: 'C:/p',
    dimensions: ['rules'],
    entries: [
      { path: '.claude/rules/a.md', action: 'deleted' },
      { path: 'CLAUDE.md', action: 'modified' },
      { path: '.claude/skills/a/SKILL.md', action: 'created' },
    ],
  });
  assert.equal(m.entries.length, 3);
  // created 的不需要备份内容，其余都要
  assert.equal(m.entries.find((e) => e.action === 'created').backed, false);
  assert.equal(m.entries.find((e) => e.action === 'deleted').backed, true);
  assert.equal(m.entries.find((e) => e.action === 'modified').backed, true);
});

test('还原动作：deleted/modified 复制回去，created 删掉', () => {
  const acts = restoreActionsOf({
    entries: [
      { path: '.claude/rules/a.md', action: 'deleted', backed: true },
      { path: 'CLAUDE.md', action: 'modified', backed: true },
      { path: '.claude/skills/a/SKILL.md', action: 'created', backed: false },
    ],
  });
  assert.deepEqual(acts.map((a) => a.op), ['copy', 'copy', 'remove']);
  assert.equal(acts[2].path, '.claude/skills/a/SKILL.md');
});

test('没有 entries 时返回空动作', () => {
  assert.deepEqual(restoreActionsOf({ entries: [] }), []);
  assert.deepEqual(restoreActionsOf({}), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/features/project-optimize/backup.logic.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
/**
 * 快照备份的纯逻辑：manifest 结构与还原动作计算。
 */

/** 时间戳转目录名——冒号在 Windows 路径里非法，必须换掉 */
export function backupDirName(iso) {
  return String(iso).replace(/\.\d+Z$/, '').replace(/:/g, '-');
}

export function buildManifest({ at, dir, dimensions, entries }) {
  return {
    at,
    dir,
    dimensions: dimensions || [],
    entries: (entries || []).map((e) => ({
      path: e.path,
      action: e.action,
      // created 是新建的文件，原本不存在，没有内容可备份；
      // 还原时靠删除它来回到原状。
      backed: e.action !== 'created',
    })),
  };
}

export function restoreActionsOf(manifest) {
  return (manifest?.entries || []).map((e) =>
    e.action === 'created'
      ? { op: 'remove', path: e.path }
      : { op: 'copy', path: e.path },
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/features/project-optimize/backup.logic.test.js`
Expected: PASS,4 个全绿

- [ ] **Step 5: 留工作区,不提交**

---

## Task 4: git 工作区检查(TDD)

**Files:**
- Create: `src/features/project-optimize/git-guard.logic.js`
- Test: `src/features/project-optimize/git-guard.logic.test.js`
- Create: `src/features/project-optimize/git-guard.js`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePorcelain } from './git-guard.logic.js';

test('空输出 = 工作区干净', () => {
  assert.deepEqual(parsePorcelain(''), { dirty: false, count: 0, files: [] });
  assert.deepEqual(parsePorcelain('\n'), { dirty: false, count: 0, files: [] });
});

test('解析已修改与未跟踪', () => {
  const out = ' M src/a.js\n?? new.txt\n M src/b.js\n';
  const r = parsePorcelain(out);
  assert.equal(r.dirty, true);
  assert.equal(r.count, 3);
  assert.deepEqual(r.files, ['src/a.js', 'new.txt', 'src/b.js']);
});

test('带引号的路径去掉引号', () => {
  const r = parsePorcelain(' M "src/带空格 的文件.js"\n');
  assert.deepEqual(r.files, ['src/带空格 的文件.js']);
});

test('重命名取箭头后的新路径', () => {
  const r = parsePorcelain('R  old.js -> new.js\n');
  assert.deepEqual(r.files, ['new.js']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/features/project-optimize/git-guard.logic.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 logic 层**

`git-guard.logic.js`:

```js
/**
 * `git status --porcelain` 输出解析。
 * 只关心「有多少个文件是脏的」——优化前要拦下脏工作区，
 * 否则优化产生的改动会和用户已有改动混在一起，事后分不清谁改的。
 */
export function parsePorcelain(out) {
  const lines = String(out || '').split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const files = lines.map((l) => {
    let p = l.slice(3); // 前两位是状态码，第三位是空格
    // 重命名形如 `R  old -> new`，取新路径
    const arrow = p.indexOf(' -> ');
    if (arrow !== -1) p = p.slice(arrow + 4);
    // 含特殊字符的路径 git 会加引号
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    return p;
  });
  return { dirty: files.length > 0, count: files.length, files };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/features/project-optimize/git-guard.logic.test.js`
Expected: PASS,4 个全绿

- [ ] **Step 5: 实现 fs 层**

`git-guard.js`:

```js
/**
 * 工作区状态检查的执行层。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parsePorcelain } from './git-guard.logic.js';

const exec = promisify(execFile);

/**
 * @returns {Promise<{isRepo:boolean, dirty:boolean, count:number, files:string[]}>}
 *   非 git 仓库返回 isRepo:false——此时无法用 git 还原，只能靠快照，
 *   调用方要据此调整给用户的提示。
 */
export async function checkWorkspace(projectDir) {
  try {
    const { stdout } = await exec('git', ['status', '--porcelain'], {
      cwd: projectDir,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { isRepo: true, ...parsePorcelain(stdout) };
  } catch {
    // git 不存在、或该目录不是仓库，都走这里
    return { isRepo: false, dirty: false, count: 0, files: [] };
  }
}
```

- [ ] **Step 6: 手工验证**

```bash
node -e "import('./src/features/project-optimize/git-guard.js').then(async m=>{
  console.log('本仓库:', JSON.stringify(await m.checkWorkspace('.')).slice(0,120));
  console.log('非仓库:', JSON.stringify(await m.checkWorkspace('C:/Windows')));
})"
```
Expected: 本仓库 `isRepo:true` 且 `dirty:true`(当前有未提交改动);`C:/Windows` 返回 `isRepo:false`

- [ ] **Step 7: 留工作区,不提交**

---

## Task 5: 备份的文件系统层

**Files:**
- Create: `src/features/project-optimize/backup.js`

- [ ] **Step 1: 实现**

```js
/**
 * 快照备份与还原的执行层。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildManifest, restoreActionsOf, backupDirName } from './backup.logic.js';

const BACKUP_ROOT = '.claude/optimize-backup';
const KEEP = 5;

/**
 * 在任何写操作之前调用：把将要改动的文件快照下来。
 * @param {string} projectDir
 * @param {Array<{path:string,action:'deleted'|'modified'|'created'}>} entries 相对路径
 * @returns {{dir:string, relDir:string, manifest:object}}
 */
export function createBackup(projectDir, entries, { at, dimensions } = {}) {
  const stamp = at || new Date().toISOString();
  const relDir = `${BACKUP_ROOT}/${backupDirName(stamp)}`;
  const absDir = path.join(projectDir, relDir);
  fs.mkdirSync(path.join(absDir, 'files'), { recursive: true });

  const manifest = buildManifest({ at: stamp, dir: projectDir, dimensions, entries });

  for (const e of manifest.entries) {
    if (!e.backed) continue;
    const src = path.join(projectDir, e.path);
    if (!fs.existsSync(src)) { e.backed = false; continue; }
    const dst = path.join(absDir, 'files', e.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  fs.writeFileSync(path.join(absDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  pruneOld(projectDir);
  return { dir: absDir, relDir, manifest };
}

/** 保留最近 KEEP 次，其余按时间从旧到新删除 */
function pruneOld(projectDir) {
  const root = path.join(projectDir, BACKUP_ROOT);
  if (!fs.existsSync(root)) return;
  const dirs = fs.readdirSync(root).filter((n) => fs.statSync(path.join(root, n)).isDirectory()).sort();
  for (const n of dirs.slice(0, Math.max(0, dirs.length - KEEP))) {
    fs.rmSync(path.join(root, n), { recursive: true, force: true });
  }
}

export function listBackups(projectDir) {
  const root = path.join(projectDir, BACKUP_ROOT);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((n) => fs.existsSync(path.join(root, n, 'manifest.json')))
    .map((n) => {
      const m = JSON.parse(fs.readFileSync(path.join(root, n, 'manifest.json'), 'utf8'));
      return { at: m.at, dirName: n, fileCount: m.entries.length, dimensions: m.dimensions };
    })
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * 按 manifest 还原。
 * 还原前比对内容：优化后又被人改过的文件跳过，不覆盖用户的手工修改。
 */
export function restoreBackup(projectDir, dirName) {
  const absDir = path.join(projectDir, BACKUP_ROOT, dirName);
  const manifestFile = path.join(absDir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error('备份不存在');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  let restored = 0;
  const skipped = [];

  for (const act of restoreActionsOf(manifest)) {
    const target = path.join(projectDir, act.path);
    if (act.op === 'remove') {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
        // 目录随之变空就一并删掉，避免留下空壳
        const d = path.dirname(target);
        try { if (fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch { /* 删不掉就算了 */ }
        restored += 1;
      }
      continue;
    }
    const src = path.join(absDir, 'files', act.path);
    if (!fs.existsSync(src)) { skipped.push({ path: act.path, reason: '备份内容缺失' }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(src, target);
    restored += 1;
  }

  return { restored, skipped };
}
```

- [ ] **Step 2: 端到端验证(建临时目录跑一遍)**

```bash
node -e "
const fs=require('fs'),path=require('path'),os=require('os');
import('./src/features/project-optimize/backup.js').then(m=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bk-'));
  fs.mkdirSync(path.join(tmp,'sub'),{recursive:true});
  fs.writeFileSync(path.join(tmp,'a.md'),'原始A');
  fs.writeFileSync(path.join(tmp,'sub','b.md'),'原始B');
  const bk=m.createBackup(tmp,[{path:'a.md',action:'deleted'},{path:'sub/b.md',action:'modified'},{path:'new.md',action:'created'}],{dimensions:['rules']});
  // 模拟优化：删 a、改 b、建 new
  fs.rmSync(path.join(tmp,'a.md'));
  fs.writeFileSync(path.join(tmp,'sub','b.md'),'改过的B');
  fs.writeFileSync(path.join(tmp,'new.md'),'新建');
  console.log('优化后:', fs.existsSync(path.join(tmp,'a.md')), fs.readFileSync(path.join(tmp,'sub','b.md'),'utf8'), fs.existsSync(path.join(tmp,'new.md')));
  const r=m.restoreBackup(tmp, bk.relDir.split('/').pop());
  console.log('还原结果:', JSON.stringify(r));
  console.log('还原后:', fs.readFileSync(path.join(tmp,'a.md'),'utf8'), fs.readFileSync(path.join(tmp,'sub','b.md'),'utf8'), fs.existsSync(path.join(tmp,'new.md')));
  fs.rmSync(tmp,{recursive:true,force:true});
});
"
```

Expected:
- 优化后:`false 改过的B true`
- 还原结果:`{"restored":3,"skipped":[]}`
- 还原后:`原始A 原始B false`

**这是本任务的核心判据**——三种 action 都要正确回滚。

- [ ] **Step 3: 验证保留策略**

```bash
node -e "
const fs=require('fs'),path=require('path'),os=require('os');
import('./src/features/project-optimize/backup.js').then(m=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bk2-'));
  fs.writeFileSync(path.join(tmp,'x.md'),'x');
  for(let i=1;i<=8;i++) m.createBackup(tmp,[{path:'x.md',action:'modified'}],{at:new Date(Date.UTC(2026,0,i)).toISOString()});
  console.log('备份数(应为5):', m.listBackups(tmp).length);
  console.log('最新的(应为01-08):', m.listBackups(tmp)[0].at.slice(0,10));
  fs.rmSync(tmp,{recursive:true,force:true});
});
"
```
Expected: `备份数(应为5): 5` / `最新的(应为01-08): 2026-01-08`

- [ ] **Step 4: 留工作区,不提交**

---

## Task 6: skill description 生成

**Files:**
- Create: `src/features/project-optimize/describe-skill.js`

- [ ] **Step 1: 实现**

```js
/**
 * 生成 skill 的 description。
 *
 * description 直接决定这个 skill 能不能被正确唤起——写不好，降级之后
 * 规范就等于失踪了。所以默认走 LLM；LLM 挂了才退回机械拼接，并标注来源
 * 让用户知道要复核。
 */
import { runClaude } from '../../integrations/claude.js';
import { logger } from '../../shared/logger.js';

/** 从 markdown 正文抽取标题结构，作为 LLM 的输入 */
export function outlineOf(body) {
  const lines = String(body || '').split('\n');
  const h1 = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, '').trim() || '';
  const subs = lines.filter((l) => /^#{2,3}\s+/.test(l)).map((l) => l.replace(/^#{2,3}\s+/, '').trim());
  const head = String(body || '').replace(/^#.*$/m, '').trim().slice(0, 500);
  return { h1, subs, head };
}

/** LLM 不可用时的兜底：机械拼接，质量一般但不至于空着 */
export function fallbackDescription({ h1, subs }) {
  const top = subs.slice(0, 3).join('、');
  return `${h1 || '项目规范'}${top ? ` —— 覆盖${top}` : ''}。修改相关内容时调用本技能。`;
}

const PROMPT = (name, o) => `你在为一个 Claude Code skill 写 description 字段。

技能名：${name}
规范标题：${o.h1}
章节：${o.subs.slice(0, 12).join(' / ')}
正文开头：${o.head}

写一句中文 description，必须同时说清两件事：
1. 这份规范是什么（一句话概括内容）
2. 什么时候该调用它（具体的触发场景，这决定了技能能否被正确唤起）

要求：单行、不超过 120 字、不要引号、不要换行、直接输出这句话本身，不要任何前后缀说明。`;

export async function describeSkill(name, body) {
  const o = outlineOf(body);
  try {
    let text = '';
    await runClaude(PROMPT(name, o), {
      // 输入已经是读好的文本，输出是一句话——不需要任何工具。
      // 这个调用发生在破坏性操作中途，多余的文件写入会绕过快照备份。
      allowedTools: [],
      persistSession: false,
      maxTurns: 1,
      onText: (t) => { text += t; },
    });
    const one = text.replace(/\s*\n\s*/g, ' ').trim();
    if (one.length >= 10) return { description: one, source: 'llm' };
    logger.warn('optimize', 'description 生成结果过短，退回机械拼接', { name, len: one.length });
  } catch (e) {
    logger.warn('optimize', 'description 生成失败，退回机械拼接', { name, err: e.message });
  }
  return { description: fallbackDescription(o), source: 'fallback' };
}
```

- [ ] **Step 2: 验证机械降级路径(不耗额度)**

```bash
node -e "import('./src/features/project-optimize/describe-skill.js').then(m=>{
  const body='# 统一弹框规范\n\n## 十条硬规则\n\n## 模板骨架\n\n## 跨分包引用\n\n正文内容。';
  console.log('outline:', JSON.stringify(m.outlineOf(body)).slice(0,150));
  console.log('fallback:', m.fallbackDescription(m.outlineOf(body)));
})"
```
Expected: fallback 输出形如 `统一弹框规范 —— 覆盖十条硬规则、模板骨架、跨分包引用。修改相关内容时调用本技能。`

- [ ] **Step 3: 验证 LLM 路径(会消耗额度,跑一次)**

```bash
node -e "import('./src/features/project-optimize/describe-skill.js').then(async m=>{
  const body='# 统一弹框规范\n\n## 十条硬规则\n\n## 弹框里有输入框\n\n## 跨分包引用弹框\n\n新增弹框必须照模板骨架写。';
  const r=await m.describeSkill('popup-pattern', body);
  console.log('source:', r.source);
  console.log('description:', r.description);
})"
```
Expected: `source: llm`,description 是一句通顺的中文,同时说清「是什么」和「什么时候调」

如果返回 `source: fallback`,把日志里的错误原因报出来。

- [ ] **Step 4: 留工作区,不提交**

---

## Task 7: 降级执行层

**Files:**
- Create: `src/features/project-optimize/fix-rules.js`

- [ ] **Step 1: 实现**

```js
/**
 * rules → skill 降级的执行层。
 */
import fs from 'node:fs';
import path from 'node:path';
import { skillNameOf, stripFrontmatter, buildSkillFile, replaceRuleRefs, isArchivedPath } from './fix-rules.logic.js';
import { describeSkill } from './describe-skill.js';

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

/** 收集仓库内所有 md 文件的相对路径（用于引用替换），跳过归档目录 */
export function collectMarkdown(projectDir) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIR.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue; }
      if (!e.name.endsWith('.md')) continue;
      if (isArchivedPath(r)) continue;
      out.push(r);
    }
  };
  walk(projectDir, '');
  return out;
}

/**
 * 计算某次降级将要改动哪些文件——必须在写任何东西之前调用，
 * 结果喂给 createBackup 做快照。
 */
export function planDemote(projectDir, ruleFileNames) {
  const entries = [];
  const mdFiles = collectMarkdown(projectDir);

  for (const fileName of ruleFileNames) {
    const name = skillNameOf(fileName);
    entries.push({ path: `.claude/rules/${fileName}`, action: 'deleted' });
    entries.push({ path: `.claude/skills/${name}/SKILL.md`, action: 'created' });
    for (const rel of mdFiles) {
      let raw;
      try { raw = fs.readFileSync(path.join(projectDir, rel), 'utf8'); } catch { continue; }
      if (replaceRuleRefs(raw, name) !== raw) entries.push({ path: rel, action: 'modified' });
    }
  }
  // 同一文件可能被多条规则命中，去重
  const seen = new Set();
  return entries.filter((e) => {
    const k = e.action + '|' + e.path;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 降级单个 rules 文件。
 * @returns {{status:'done'|'skipped'|'failed', ...}}
 */
export async function demoteOne(projectDir, fileName, onStep = () => {}) {
  const name = skillNameOf(fileName);
  const srcRel = `.claude/rules/${fileName}`;
  const src = path.join(projectDir, srcRel);
  const skillDir = path.join(projectDir, '.claude', 'skills', name);

  if (fs.existsSync(skillDir)) {
    return { file: srcRel, status: 'skipped', reason: `同名 skill 已存在：.claude/skills/${name}/` };
  }
  let raw;
  try { raw = fs.readFileSync(src, 'utf8'); } catch (e) {
    return { file: srcRel, status: 'failed', reason: `源文件不可读：${e.message}` };
  }

  const body = stripFrontmatter(raw);

  onStep(`生成 ${name} 的技能说明…`);
  const { description, source } = await describeSkill(name, body);

  onStep(`写入 .claude/skills/${name}/SKILL.md`);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), buildSkillFile({ name, description, body }), 'utf8');

  onStep(`删除 ${srcRel}`);
  fs.rmSync(src, { force: true });

  onStep(`替换全仓引用…`);
  let refsUpdated = 0;
  const refsFailed = [];
  for (const rel of collectMarkdown(projectDir)) {
    const abs = path.join(projectDir, rel);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const next = replaceRuleRefs(text, name);
    if (next === text) continue;
    try { fs.writeFileSync(abs, next, 'utf8'); refsUpdated += 1; }
    catch (e) { refsFailed.push({ path: rel, reason: e.message }); }
  }

  return { file: srcRel, status: 'done', skillName: name, refsUpdated, refsFailed, descriptionSource: source };
}
```

- [ ] **Step 2: 对夹具副本端到端验证**

```bash
node -e "
const fs=require('fs'),path=require('path'),os=require('os');
Promise.all([import('./src/features/project-optimize/fix-rules.js'),import('./src/features/project-optimize/backup.js')]).then(async ([fx,bk])=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'demote-'));
  fs.cpSync('tests/fixtures/projects/demote-target',tmp,{recursive:true});
  const plan=fx.planDemote(tmp,['big-wide.md']);
  console.log('计划改动:'); plan.forEach(e=>console.log('  ',e.action.padEnd(9),e.path));
  bk.createBackup(tmp,plan,{dimensions:['rules']});
  const r=await fx.demoteOne(tmp,'big-wide.md',(s)=>console.log('  step:',s));
  console.log('结果:',JSON.stringify(r));
  console.log('--- 验证 ---');
  console.log('原 rules 已删:', !fs.existsSync(path.join(tmp,'.claude/rules/big-wide.md')));
  console.log('skill 已建:', fs.existsSync(path.join(tmp,'.claude/skills/big-wide/SKILL.md')));
  console.log('skill 头部:'); console.log(fs.readFileSync(path.join(tmp,'.claude/skills/big-wide/SKILL.md'),'utf8').split('\n').slice(0,5).map(l=>'    '+l).join('\n'));
  console.log('活文档已替换:', fs.readFileSync(path.join(tmp,'docs/guide.md'),'utf8').includes('/big-wide'));
  console.log('归档未被动(应为 true):', fs.readFileSync(path.join(tmp,'docs/specs/archived.md'),'utf8').includes('.claude/rules/big-wide.md'));
  console.log('小文件未被动:', fs.existsSync(path.join(tmp,'.claude/rules/small-narrow.md')));
  fs.rmSync(tmp,{recursive:true,force:true});
});
"
```

**判据(逐条核对)**:
- 计划改动应含 deleted / created / modified 三类,且 `docs/specs/archived.md` **不在**列表里
- 原 rules 已删 `true`、skill 已建 `true`
- skill 头部是合法 frontmatter,含 `name: big-wide` 和一句 description
- 活文档已替换 `true`
- **归档未被动 `true`**(这条最关键,证明归档排除生效)
- 小文件未被动 `true`

- [ ] **Step 3: 验证幂等/冲突处理**

对同一个临时目录再跑一次 `demoteOne`,应返回 `status: 'skipped'`(skill 已存在),且不破坏任何文件。

- [ ] **Step 4: 留工作区,不提交**

---

## Task 8: 编排与串行闸

**Files:**
- Create: `src/entrypoints/web/optimize-ops.js`
- Modify: `src/store/optimize.js`(补 busy / backups / lastFix 的读写函数)

- [ ] **Step 1: 给 store 补函数**

在 `src/store/optimize.js` 末尾追加:

```js
/** 串行闸：同一项目同时只允许一个优化任务 */
export function setBusy(dir, busy) {
  return updateJson(FILE, EMPTY(), (data) => {
    if (!data.projects) data.projects = {};
    const rec = data.projects[dir] || { history: [], busy: null, backups: [] };
    rec.busy = busy;
    data.projects[dir] = rec;
    return data;
  });
}

export function saveFixResult(dir, lastFix, backupEntry) {
  return updateJson(FILE, EMPTY(), (data) => {
    if (!data.projects) data.projects = {};
    const rec = data.projects[dir] || { history: [], busy: null, backups: [] };
    rec.lastFix = lastFix;
    rec.busy = null;
    if (backupEntry) rec.backups = [...(rec.backups || []), backupEntry].slice(-5);
    data.projects[dir] = rec;
    return data;
  });
}
```

- [ ] **Step 2: 实现编排**

`src/entrypoints/web/optimize-ops.js`:

```js
/**
 * 一键优化的编排层：轻量 job 注册表 + 串行闸 + SSE 进度。
 *
 * 没复用 store/runs.js 的 run 注册表——那套是给 Claude 对话设计的
 * （session / todos / askUser / 额度续跑），优化任务用不上，接进来反而要处理一堆无关状态。
 * 这里只借它的 sendTo 做 SSE 发送。
 */
import { sendTo } from '../../store/runs.js';
import { logger } from '../../shared/logger.js';
import { checkWorkspace } from '../../features/project-optimize/git-guard.js';
import { planDemote, demoteOne } from '../../features/project-optimize/fix-rules.js';
import { createBackup } from '../../features/project-optimize/backup.js';
import { runStaticCheckup } from '../../features/project-checkup/index.js';
import { setBusy, saveFixResult, getProjectRecord } from '../../store/optimize.js';

const jobs = new Map(); // id -> {id, dir, status, steps[], result, subs:Set<res>}
let seq = 0;

function emit(job, event, data) {
  for (const res of job.subs) { try { sendTo(res, event, data); } catch { /* 断开的连接下轮清理 */ } }
}

function step(job, text) {
  job.steps.push(text);
  emit(job, 'step', { text, index: job.steps.length });
}

export function getJob(id) { return jobs.get(id); }

export function attachJob(job, res) {
  job.subs.add(res);
  // 新订阅者先补历史步骤，避免中途接入看不到前面发生了什么
  sendTo(res, 'replay', { steps: job.steps, status: job.status, result: job.result || null });
  res.on('close', () => job.subs.delete(res));
}

/**
 * @returns {{needsConfirm:true, dirtyCount:number}|{jobId:string}}
 */
export async function startFix({ dir, dimensions, force }) {
  const rec = getProjectRecord(dir);
  if (rec?.busy) throw new Error('该项目有正在进行的优化任务');

  const ws = await checkWorkspace(dir);
  if (ws.dirty && !force) return { needsConfirm: true, dirtyCount: ws.count, isRepo: ws.isRepo };

  const report = rec?.lastCheckup;
  if (!report) throw new Error('请先体检');

  const job = { id: `fix_${Date.now()}_${++seq}`, dir, status: 'running', steps: [], result: null, subs: new Set() };
  jobs.set(job.id, job);
  setBusy(dir, { kind: 'fix', jobId: job.id, startedAt: new Date().toISOString() });

  // 异步跑，立即返回 jobId 让前端接 SSE
  runFix(job, { dir, dimensions, report, isRepo: ws.isRepo }).catch((e) => {
    logger.warn('optimize', '优化任务异常', { dir, err: e.message });
    job.status = 'failed';
    job.result = { error: e.message, results: [], notes: [] };
    emit(job, 'done', job.result);
    setBusy(dir, null);
  });

  return { jobId: job.id };
}

async function runFix(job, { dir, dimensions, report, isRepo }) {
  const results = [];
  const notes = [];
  if (!isRepo) notes.push('该目录不是 git 仓库，无法用 git 回退，只能通过本工具的快照还原。');

  const wantRules = dimensions.includes('rules');
  const unsupported = dimensions.filter((d) => d !== 'rules');
  if (unsupported.length) notes.push(`维度 ${unsupported.join('、')} 暂不支持自动修复，本次已跳过。`);

  let backupEntry = null;

  if (wantRules) {
    // 只处理体检报告里标了 fixable 的那些——R2_DEMOTE_UNCERTAIN 是
    // 「有 frontmatter 但解析不出 paths」，故意标成不可自动修，这里必须尊重它
    const targets = (report.dims?.rules?.issues || [])
      .filter((i) => i.fixable && i.file?.startsWith('.claude/rules/'))
      .map((i) => i.file.replace('.claude/rules/', ''));

    if (!targets.length) {
      notes.push('规范加载方式维度没有可自动修复的项。');
    } else {
      step(job, `准备降级 ${targets.length} 个规范文件…`);
      const plan = planDemote(dir, targets);
      step(job, `快照备份 ${plan.filter((e) => e.action !== 'created').length} 个文件…`);
      const bk = createBackup(dir, plan, { dimensions });
      backupEntry = { at: bk.manifest.at, dirName: bk.relDir.split('/').pop(), fileCount: plan.length, dimensions };

      for (const t of targets) {
        step(job, `处理 ${t}`);
        const r = await demoteOne(dir, t, (s) => step(job, `  ${s}`));
        results.push(r);
        // 核心操作失败即停：文件系统已处于半完成状态，继续会越错越多
        if (r.status === 'failed') { notes.push(`在 ${t} 处失败并停止，之前的改动可通过还原撤销。`); break; }
      }

      if (results.some((r) => r.descriptionSource === 'fallback')) {
        notes.push('部分技能说明由机械模板生成（LLM 调用失败），建议人工复核 description。');
      }
      const demoted = results.filter((r) => r.status === 'done').map((r) => r.skillName);
      if (demoted.length) {
        notes.push(`根 CLAUDE.md 的规范索引表需手工调整：把 ${demoted.join('、')} 从「自动加载」表移到「按需调用」表。`);
      }
    }
  }

  step(job, '重新体检…');
  const after = runStaticCheckup(dir);

  job.status = 'done';
  job.result = { results, notes, scoreAfter: after.score, rulesScoreAfter: after.dims?.rules?.score ?? null };
  saveFixResult(dir, { at: new Date().toISOString(), dimensions, results, notes }, backupEntry);
  emit(job, 'done', job.result);
}
```

- [ ] **Step 3: 语法与导入检查**

```bash
node --check src/entrypoints/web/optimize-ops.js && node -e "import('./src/entrypoints/web/optimize-ops.js').then(()=>console.log('imports ok'))"
```
Expected: `imports ok`

- [ ] **Step 4: 留工作区,不提交**

---

## Task 9: 路由扩展

**Files:**
- Modify: `src/entrypoints/web/routes-optimize.js`

- [ ] **Step 1: 加四个接口**

在 `routes-optimize.js` 里补(照阶段一既有两个接口的写法):

```js
import { startFix, getJob, attachJob } from './optimize-ops.js';
import { listBackups, restoreBackup } from '../../features/project-optimize/backup.js';
```

```js
// ==== POST /api/optimize/fix {dir, dimensions, force?} ====
function handleFix(req, res) {
  return withJsonBody(req, res, async (data) => {
    const dir = str(data.dir);
    const dimensions = Array.isArray(data.dimensions) ? data.dimensions.map(str).filter(Boolean) : [];
    if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });
    if (!dimensions.length) return sendJson(res, 400, { error: '未勾选任何维度' });
    try {
      const out = await startFix({ dir, dimensions, force: !!data.force });
      sendJson(res, 200, out);
    } catch (e) {
      logger.warn('optimize', '启动优化失败', { dir, err: e.message });
      sendJson(res, 400, { error: e.message });
    }
  });
}

// ==== GET /api/optimize/fix-stream?jobId= ====
function handleFixStream(req, res, url) {
  const job = getJob(str(url.searchParams.get('jobId')));
  if (!job) return sendJson(res, 404, { error: '任务不存在' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  attachJob(job, res);
}

// ==== GET /api/optimize/backups?dir= ====
function handleBackups(res, url) {
  const dir = str(url.searchParams.get('dir'));
  if (!dir) return sendJson(res, 400, { error: '缺少 dir 参数' });
  try { sendJson(res, 200, { backups: listBackups(dir) }); }
  catch (e) { sendJson(res, 400, { error: e.message }); }
}

// ==== POST /api/optimize/rollback {dir, dirName} ====
function handleRollback(req, res) {
  return withJsonBody(req, res, (data) => {
    const dir = str(data.dir);
    const dirName = str(data.dirName);
    if (!dir || !dirName) return sendJson(res, 400, { error: '缺少参数' });
    try { sendJson(res, 200, restoreBackup(dir, dirName)); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
  });
}
```

在 `handleOptimizeRoutes` 里加四条分发,保持和既有两条一致的写法。

- [ ] **Step 2: curl 验证(起服务,端口冲突就用 PORT=9801)**

先对夹具副本跑一次完整流程:

```bash
node -e "const fs=require('fs'),os=require('os'),path=require('path');const t=path.join(os.tmpdir(),'demo-fix');fs.rmSync(t,{recursive:true,force:true});fs.cpSync('tests/fixtures/projects/demote-target',t,{recursive:true});console.log(t)"
```

用输出的路径:
1. `POST /api/optimize/checkup {dir}` → 拿到报告
2. `POST /api/optimize/fix {dir, dimensions:["rules"]}` → 应返回 `{jobId}`(临时目录非 git 仓库,不会触发 needsConfirm)
3. `GET /api/optimize/fix-stream?jobId=` → 应收到 step 事件流,最后收到 done
4. `GET /api/optimize/backups?dir=` → 应有 1 条
5. `POST /api/optimize/rollback {dir, dirName}` → 应返回 restored 数
6. 再 `POST /api/optimize/checkup` → rules 分应回到降级前

- [ ] **Step 3: 验证脏工作区拦截**

对**本仓库**(有未提交改动)调 fix,应返回 `{needsConfirm: true, dirtyCount: N}`:

```bash
curl -s -X POST http://127.0.0.1:9801/api/optimize/fix -H "Content-Type: application/json" -d "{\"dir\":\"C:/Users/DELL/Desktop/claude-p-web-demo\",\"dimensions\":[\"rules\"]}"
```
Expected: 含 `needsConfirm":true`

> 注意:本仓库根没有 CLAUDE.md,如果它先报「请先体检」,先调一次 checkup 再试。

- [ ] **Step 4: 留工作区,不提交**

---

## Task 10: 前端进度逻辑(TDD)

**Files:**
- Create: `public/js/optimize-fix.logic.js`
- Test: `public/js/optimize-fix.logic.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeResults, canFix, fixButtonLabel } from './optimize-fix.logic.js';

test('可优化条件：有报告 + 有勾选 + 不在跑', () => {
  assert.equal(canFix({ hasReport: true, selected: ['rules'], running: false }), true);
  assert.equal(canFix({ hasReport: false, selected: ['rules'], running: false }), false);
  assert.equal(canFix({ hasReport: true, selected: [], running: false }), false);
  assert.equal(canFix({ hasReport: true, selected: ['rules'], running: true }), false);
});

test('按钮文案随状态变化', () => {
  assert.equal(fixButtonLabel(false), '一键优化');
  assert.equal(fixButtonLabel(true), '优化中…');
});

test('结果分组统计', () => {
  const s = summarizeResults([
    { status: 'done', skillName: 'a', refsUpdated: 3 },
    { status: 'done', skillName: 'b', refsUpdated: 0 },
    { status: 'skipped', reason: 'x' },
    { status: 'failed', reason: 'y' },
  ]);
  assert.equal(s.done, 2);
  assert.equal(s.skipped, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.refsTotal, 3);
  assert.equal(s.text, '成功 2 · 跳过 1 · 失败 1');
});

test('空结果', () => {
  const s = summarizeResults([]);
  assert.equal(s.done, 0);
  assert.equal(s.text, '没有可处理的项');
});

test('summarizeResults 接受 null', () => {
  assert.equal(summarizeResults(null).done, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test public/js/optimize-fix.logic.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

```js
/** 一键优化的前端纯逻辑：不碰 DOM，可在 node 下单测。 */

export function canFix({ hasReport, selected, running }) {
  return !!hasReport && (selected || []).length > 0 && !running;
}

export function fixButtonLabel(running) {
  return running ? '优化中…' : '一键优化';
}

export function summarizeResults(results) {
  const list = results || [];
  const done = list.filter((r) => r.status === 'done').length;
  const skipped = list.filter((r) => r.status === 'skipped').length;
  const failed = list.filter((r) => r.status === 'failed').length;
  const refsTotal = list.reduce((n, r) => n + (r.refsUpdated || 0), 0);
  const text = list.length ? `成功 ${done} · 跳过 ${skipped} · 失败 ${failed}` : '没有可处理的项';
  return { done, skipped, failed, refsTotal, text };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test public/js/optimize-fix.logic.test.js`
Expected: PASS,5 个全绿

- [ ] **Step 5: 留工作区,不提交**

---

## Task 11: 前端接线

**Files:**
- Modify: `public/js/optimize-view.js`
- Modify: `public/index.html`(优化结果区)
- Modify: `public/app.css`(结果区样式)

- [ ] **Step 1: 加结果区 DOM**

在 `public/index.html` 的 `.opt-actions` 之后加:

```html
<div class="opt-progress" id="optProgress" hidden>
  <div class="opt-progress-steps" id="optSteps"></div>
</div>
<div class="opt-result" id="optResult" hidden>
  <div class="opt-result-head" id="optResultHead"></div>
  <div class="opt-result-list" id="optResultList"></div>
  <div class="opt-result-notes" id="optResultNotes"></div>
  <div class="opt-result-actions">
    <button class="btn primary" id="optRecheck">重新体检</button>
    <button class="btn" id="optRollback">还原本次优化</button>
  </div>
</div>
```

- [ ] **Step 2: 加样式**

追加到 `public/app.css`:

```css
.opt-progress { border: 1px solid var(--faint); border-radius: 6px; padding: 10px 12px; max-height: 220px; overflow-y: auto; }
.opt-progress-steps { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); font-family: ui-monospace, monospace; }
.opt-result { border: 1px solid var(--faint); border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.opt-result-head { font-weight: 600; }
.opt-result-list { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.opt-result-row { display: flex; gap: 8px; align-items: baseline; }
.opt-result-row .st-done { color: var(--green); }
.opt-result-row .st-skipped { color: var(--amber); }
.opt-result-row .st-failed { color: var(--red); }
.opt-result-notes { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--amber); }
.opt-result-actions { display: flex; gap: 8px; }
```

- [ ] **Step 3: 接线**

在 `optimize-view.js` 里:

1. import `canFix`、`fixButtonLabel`、`summarizeResults`,以及 `sortIssues` 已有的那些
2. 维护 `selectedDims`(从各维度卡的勾选框读)和 `running` 状态
3. 每次 `render()` 后更新 `#optFix` 的 `disabled = !canFix({hasReport, selected, running})` 和文案
4. `#optFix` 点击 → `runFix()`:
   - `POST /api/optimize/fix {dir, dimensions: selectedDims}`
   - 如果返回 `needsConfirm`,用项目已有的 `confirmDialog`(在 `public/js/ui.js`,先确认它的实际签名)弹确认:「工作区有 N 个未提交改动,优化产生的改动会和它们混在一起,难以区分。是否继续?」;确认后带 `force: true` 重发
   - 拿到 `jobId` → `new EventSource('/api/optimize/fix-stream?jobId=' + jobId)`
   - `replay` 事件:重放历史步骤
   - `step` 事件:往 `#optSteps` 追加一行(`createElement` + `textContent`)
   - `done` 事件:关闭 EventSource,渲染结果区,`running = false`
5. `#optRecheck` → 调 `runCheckup()`
6. `#optRollback` → `GET /api/optimize/backups?dir=` 取最新一条 → 确认框 → `POST /api/optimize/rollback` → 成功后自动重新体检
7. **所有来自后端的文本一律 `createElement` + `textContent`,禁止 innerHTML**

结果区渲染:头部用 `summarizeResults(...).text` + 分数变化(`scoreAfter`);列表每行显示状态图标 + 文件名 + `→ /skillName` + 引用替换数;notes 逐条一行。

- [ ] **Step 4: 端到端验证**

起服务(端口冲突用 `PORT=9801`)。先准备一个夹具副本:

```bash
node -e "const fs=require('fs'),os=require('os'),path=require('path');const t=path.join(os.tmpdir(),'demo-ui');fs.rmSync(t,{recursive:true,force:true});fs.cpSync('tests/fixtures/projects/demote-target',t,{recursive:true});console.log(t)"
```

浏览器里:
1. 项目优化 → 选中该临时目录 → 体检 → rules 维度应有 1 个问题
2. 确认「一键优化」按钮**已可点击**
3. 点它 → 应看到步骤逐条滚出来 → 结束后显示结果区
4. 点「重新体检」→ rules 分应涨到 100
5. 点「还原本次优化」→ 确认 → 应自动重新体检,rules 分回到降级前

如果无法操作浏览器,用 curl 走完全流程并说明 UI 未经肉眼验证。

- [ ] **Step 5: 留工作区,不提交**

---

## Task 12: 真实项目验证与收尾

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全绿(阶段一的 1199 个 + 本期新增)

> 注意:`node --test <目录>` 在 Node v24 下会把目录当入口模块报错,要用 glob 形式 `node --test "src/**/*.test.js"`。

- [ ] **Step 2: 对真实未优化项目跑一次**

**先复制一份副本再动**,不要直接改 `kxmall-app-ui.auto`:

```bash
node -e "const fs=require('fs'),os=require('os'),path=require('path');const t=path.join(os.tmpdir(),'kxmall-fix-test');fs.rmSync(t,{recursive:true,force:true});fs.cpSync('C:/Users/DELL/Desktop/kxmall-app-ui.auto',t,{recursive:true,filter:(s)=>!s.includes('node_modules')&&!s.includes('.git')});console.log(t)"
```

对这个副本:体检 → 记录 rules 分(应为 60)→ 一键优化 → 重新体检 → rules 分应涨到 100 → 还原 → 应回到 60。

**逐项记录实际数字。** 如果优化后分数没涨,说明降级没生效或体检没识别,排查后报告。

- [ ] **Step 3: 人工检查生成的 skill 质量**

打开副本里生成的 `.claude/skills/design-system/SKILL.md`,人工读一遍 description:

- 是否说清了「是什么」和「什么时候调」
- 是否单行、无换行、无引号
- 正文是否完整保留(和原 rules 文件除 frontmatter 外应完全一致)

**这一步不能跳过**——description 质量决定 skill 能否被唤起,机器测不了。

- [ ] **Step 4: 确认改动清单**

Run: `git status --short`
Expected: 只含本计划涉及的文件,无意外改动,无提交(`git log -1` 应仍是开工前那个 commit)

- [ ] **Step 5: 交付说明**

向用户汇报:改动留工作区未提交、真实项目的分数变化数字、生成的 description 示例、以及已知遗留。

---

## 自查结果

**Spec 覆盖(对照 `2026-08-24-project-optimize-phase3-design.md`):**

| Spec 章节 | 覆盖 |
|---|---|
| §2 降级流程五步 | ✅ Task 2(文本变换)+ Task 7(执行层) |
| §2 归档目录排除 | ✅ Task 2 `isArchivedPath` + Task 1 夹具验证 |
| §2 不改根 CLAUDE.md 表格 | ✅ Task 8 产出 notes 提示 |
| §3 description 生成 + 禁用工具 | ✅ Task 6 |
| §3 机械降级 | ✅ Task 6 `fallbackDescription` |
| §4 备份/还原/保留策略 | ✅ Task 3(logic)+ Task 5(fs) |
| §4 还原前内容比对 | ⚠️ Task 5 实现了「备份内容缺失则跳过」,但 spec 要求的是「当前内容与备份不一致则跳过」——**见下方修正** |
| §5 工作区检查 | ✅ Task 4 + Task 8 |
| §5 串行闸 | ✅ Task 8 `setBusy` |
| §5 核心失败即停 | ✅ Task 8 runFix 的 break |
| §6 数据结构 | ✅ Task 8 Step 1 |
| §7 API 四个 | ✅ Task 9 |
| §8 UI | ✅ Task 11 |
| §9 错误处理 | ✅ 分散在 Task 5/6/7/8 |
| §10 测试 | ✅ Task 1 夹具 + 四个 logic 单测 + Task 12 真实验证 |

**发现的偏差(已在计划内修正):** Task 5 的 `restoreBackup` 只判断了备份内容是否存在,没实现 spec §4 要求的「目标文件当前内容与备份不一致时跳过」。执行 Task 5 时**必须补上**:复制回去之前先比对目标文件当前内容与备份内容,不一致则跳过并记 `{path, reason: '优化后又被修改过，跳过以免覆盖手工改动'}`。

**类型一致性:** 降级结果统一为 `{file, status, skillName?, refsUpdated?, refsFailed?, descriptionSource?, reason?}`;`status` 取值固定 `done | skipped | failed`;备份 entry 统一 `{path, action, backed}`,`action` 取值固定 `deleted | modified | created`。前后端共用同一组字段名。
