import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureImport, hasImport } from './claude-md.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claudemd-'));

test('无 CLAUDE.md → 创建，仅含引用行', () => {
  const dir = tmp();
  const p = path.join(dir, 'CLAUDE.md');
  const r = ensureImport(p, '@.claude/memory-bank.md');
  assert.equal(r.created, true);
  assert.equal(r.appended, true);
  assert.equal(fs.readFileSync(p, 'utf8').trim(), '@.claude/memory-bank.md');
});

test('已有手写内容 → 逐字保留，仅追加一行', () => {
  const dir = tmp();
  const p = path.join(dir, 'CLAUDE.md');
  const original = '# 我的规矩\n\nAlways respond in Chinese-simplified\n';
  fs.writeFileSync(p, original, 'utf8');
  ensureImport(p, '@.claude/memory-bank.md');
  const after = fs.readFileSync(p, 'utf8');
  assert.ok(after.startsWith(original), '原内容必须逐字保留在开头');
  assert.match(after, /@\.claude\/memory-bank\.md/);
});

test('幂等：已含引用行则不重复追加', () => {
  const dir = tmp();
  const p = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(p, 'x\n@.claude/memory-bank.md\n', 'utf8');
  const r = ensureImport(p, '@.claude/memory-bank.md');
  assert.equal(r.appended, false);
  const body = fs.readFileSync(p, 'utf8');
  assert.equal(body.match(/@\.claude\/memory-bank\.md/g).length, 1);
});

test('引用行出现在注释或正文中间也算已存在，不重复追加', () => {
  const dir = tmp();
  const p = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(p, '见 @.claude/memory-bank.md 里的偏好\n', 'utf8');
  assert.equal(hasImport(p, '@.claude/memory-bank.md'), true);
  assert.equal(ensureImport(p, '@.claude/memory-bank.md').appended, false);
});

test('原文件末尾无换行时，追加不会粘连成一行', () => {
  const dir = tmp();
  const p = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(p, '最后一行没换行', 'utf8');
  ensureImport(p, '@.claude/memory-bank.md');
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  assert.equal(lines[0], '最后一行没换行');
  assert.ok(lines.includes('@.claude/memory-bank.md'));
});

test('目标目录不存在 → 自动创建', () => {
  const dir = tmp();
  const p = path.join(dir, 'nested', 'deep', 'CLAUDE.md');
  ensureImport(p, '@.claude/memory-bank.md');
  assert.ok(fs.existsSync(p));
});

test('防回归：claude.js 不得设置 settingSources —— 否则 CLAUDE.md 不再自动加载，记忆库静默失效', () => {
  const src = fs.readFileSync(new URL('../integrations/claude.js', import.meta.url), 'utf8');
  assert.ok(
    !/settingSources\s*:/.test(src),
    'claude.js 出现了 settingSources 配置。SDK 文档：omitted 时按 CLI 默认加载全部来源，'
    + '必须含 project 才会读 CLAUDE.md。若确需设置，请显式包含 "project"，并同步更新本断言与 spec §9.3。',
  );
});
