/**
 * builtin-skills.js 测试：注册表一致性、白名单形状、安装判定、清单与 plugins 解析，
 * 以及 Phase 3 per-skill 启用视图（物化镜像）的幂等/fail-open 性质。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_SKILL_IDS } from '../shared/builtin-ids.js';
import {
  BUILTIN_SKILLS,
  SUPERPOWERS_SKILL_WHITELIST,
  isSuperpowersInstalled,
  listSuperpowersSkillItems,
  materializeSkillPlugin,
  resolveBuiltinSkills,
  resolveSkillPlugins,
  skillRegistryIdsMatchWhitelist,
} from './builtin-skills.js';

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** 造一个最小可用的 superpowers 插件目录（plugin.json + 全部白名单技能 + VERSION） */
function makeSourcePlugin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-src-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{"name":"superpowers"}');
  for (const id of SUPERPOWERS_SKILL_WHITELIST) {
    fs.mkdirSync(path.join(dir, 'skills', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', id, 'SKILL.md'), `---\nname: ${id}\ndescription: ${id} 描述\n---\n# ${id}\n`);
  }
  fs.writeFileSync(path.join(dir, 'VERSION'), 'v1');
  return dir;
}

function makeActiveDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-active-'));
  tmpDirs.push(base);
  return path.join(base, 'view');
}

test('注册表与 shared 白名单一致；白名单为合法目录名且无重复', () => {
  assert.equal(skillRegistryIdsMatchWhitelist(), true);
  assert.ok(SUPERPOWERS_SKILL_WHITELIST.length >= 8 && SUPERPOWERS_SKILL_WHITELIST.length <= 12);
  const seen = new Set();
  for (const name of SUPERPOWERS_SKILL_WHITELIST) {
    assert.match(name, /^[a-z][a-z0-9-]*$/, `非法技能名：${name}`);
    assert.ok(!seen.has(name), `技能重复：${name}`);
    seen.add(name);
  }
  assert.ok(seen.has('brainstorming') && seen.has('verification-before-completion'));
});

test('isSuperpowersInstalled：plugin.json 与 skills 同时存在才算装好', () => {
  const existsAll = () => true;
  assert.equal(isSuperpowersInstalled({ exists: existsAll, dir: 'D' }), true);
  assert.equal(isSuperpowersInstalled({ exists: (p) => !p.includes('plugin.json'), dir: 'D' }), false);
  assert.equal(isSuperpowersInstalled({ exists: (p) => !p.endsWith('skills'), dir: 'D' }), false);
  assert.equal(isSuperpowersInstalled({ exists: () => false, dir: 'D' }), false);
});

test('resolveBuiltinSkills：默认关闭；installed 透传；state enabled 生效', () => {
  const off = resolveBuiltinSkills({ state: {}, installed: false });
  assert.equal(off.length, 1);
  assert.equal(off[0].id, 'superpowers');
  assert.equal(off[0].enabled, false);
  assert.equal(off[0].installed, false);
  assert.match(off[0].installHint, /setup:superpowers/);

  const on = resolveBuiltinSkills({ state: { superpowers: { enabled: true } }, installed: true });
  assert.equal(on[0].enabled, true);
  assert.equal(on[0].installed, true);
});

test('resolveSkillPlugins：仅启用且已安装时注入 SDK 本地插件', () => {
  assert.deepEqual(resolveSkillPlugins({ state: { superpowers: { enabled: false } }, installed: true }), []);
  assert.deepEqual(resolveSkillPlugins({ state: { superpowers: { enabled: true } }, installed: false }), []);
  // 注入直通物化桩：本用例只钉「启用 × 已安装 → 产出本地插件」，不碰真实 assets 目录
  const plugins = resolveSkillPlugins({ state: { superpowers: { enabled: true } }, installed: true, materializeFn: ({ dir }) => dir });
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].type, 'local');
  assert.equal(plugins[0].skipMcpDiscovery, true, '内置 MCP 由宿主注入，插件不得自带 mcp 发现');
  assert.ok(plugins[0].path.endsWith('superpowers'));
});

test('resolveBuiltinSkills：listItems 时附带 per-skill 清单与停用状态', () => {
  const off = resolveBuiltinSkills({ state: { superpowers: { enabled: true, disabledSkills: ['brainstorming'] } }, installed: true, listItems: true, readFileFn: () => '' });
  assert.deepEqual(off[0].disabledSkills, ['brainstorming']);
  assert.equal(off[0].skills.length, SUPERPOWERS_SKILL_WHITELIST.length);
  assert.equal(off[0].skills.find((s) => s.id === 'brainstorming').enabled, false);
  assert.equal(off[0].skills.find((s) => s.id === 'writing-plans').enabled, true);

  // 未安装：不读盘、清单为空
  const notInstalled = resolveBuiltinSkills({ state: {}, installed: false, listItems: true });
  assert.deepEqual(notInstalled[0].skills, []);
  assert.deepEqual(notInstalled[0].disabledSkills, []);
});

test('listSuperpowersSkillItems：白名单顺序 + 停用标记 + frontmatter 读取 fail-open', () => {
  const items = listSuperpowersSkillItems({
    dir: 'D',
    disabled: ['brainstorming', 'nope'],
    readFileFn: (f) => {
      if (f.endsWith(`brainstorming${path.sep}SKILL.md`) || f.endsWith('brainstorming/SKILL.md')) {
        return '---\nname: 头脑风暴\ndescription: "先想清楚再动手"\n---\n';
      }
      throw new Error('missing');
    },
  });
  assert.equal(items.length, SUPERPOWERS_SKILL_WHITELIST.length);
  const b = items.find((x) => x.id === 'brainstorming');
  assert.equal(b.enabled, false, '停用项如实标记');
  assert.equal(b.label, '头脑风暴', 'label 用 frontmatter name');
  assert.equal(b.desc, '先想清楚再动手', '去引号');
  const w = items.find((x) => x.id === 'writing-plans');
  assert.equal(w.enabled, true);
  assert.equal(w.label, 'writing-plans', '无 frontmatter 回退目录名');
  assert.equal(w.desc, '');
});

test('materializeSkillPlugin：物化启用视图、幂等缓存、变化重建、全停用/全启用', () => {
  const src = makeSourcePlugin();
  const activeDir = makeActiveDir();
  const state = { superpowers: { enabled: true, disabledSkills: ['brainstorming', 'writing-plans'] } };

  const out = materializeSkillPlugin({ state, installed: true, dir: src, activeDir });
  assert.equal(out, activeDir);
  assert.ok(fs.existsSync(path.join(activeDir, '.claude-plugin', 'plugin.json')), '插件清单须在镜像里');
  assert.ok(fs.existsSync(path.join(activeDir, 'skills', 'systematic-debugging')));
  assert.ok(!fs.existsSync(path.join(activeDir, 'skills', 'brainstorming')), '停用技能不进镜像');

  // 幂等：命中戳直接复用，镜像内的额外文件不被清掉
  fs.writeFileSync(path.join(activeDir, 'marker.txt'), 'x');
  assert.equal(materializeSkillPlugin({ state, installed: true, dir: src, activeDir }), activeDir);
  assert.ok(fs.existsSync(path.join(activeDir, 'marker.txt')), '状态未变不得重建');

  // 开关变化 → 重建（marker 被清、先前停用的技能回来）
  const allOn = { superpowers: { enabled: true, disabledSkills: ['brainstorming'] } };
  assert.equal(materializeSkillPlugin({ state: allOn, installed: true, dir: src, activeDir }), activeDir);
  assert.ok(!fs.existsSync(path.join(activeDir, 'marker.txt')), '开关变化应重建');
  assert.ok(fs.existsSync(path.join(activeDir, 'skills', 'writing-plans')));

  // 全部停用 → 不注入
  const allOff = { superpowers: { enabled: true, disabledSkills: [...SUPERPOWERS_SKILL_WHITELIST] } };
  assert.equal(materializeSkillPlugin({ state: allOff, installed: true, dir: src, activeDir }), null);

  // 回到全启用 → 用原目录并清理镜像
  assert.equal(materializeSkillPlugin({ state: { superpowers: { enabled: true } }, installed: true, dir: src, activeDir }), src);
  assert.ok(!fs.existsSync(activeDir), '全启用后不留镜像');
});

test('materializeSkillPlugin：源缺文件 → fail-open 回退原目录；未安装 → null', () => {
  const src = makeSourcePlugin();
  fs.rmSync(path.join(src, 'skills', 'using-superpowers'), { recursive: true, force: true });
  const activeDir = makeActiveDir();
  const out = materializeSkillPlugin({ state: { superpowers: { disabledSkills: ['brainstorming'] } }, installed: true, dir: src, activeDir });
  assert.equal(out, src, '物化失败不得阻塞（回退原目录）');
  assert.equal(materializeSkillPlugin({ state: {}, installed: false, dir: src, activeDir }), null);
});

test('resolveSkillPlugins：停用部分技能注入镜像；全停用不注入', () => {
  const src = makeSourcePlugin();
  const activeDir = makeActiveDir();
  const materializeFn = (o) => materializeSkillPlugin({ ...o, dir: src, activeDir });

  const one = resolveSkillPlugins({ state: { superpowers: { enabled: true, disabledSkills: ['brainstorming'] } }, installed: true, materializeFn });
  assert.equal(one.length, 1);
  assert.equal(one[0].path, activeDir, '注入的是物化镜像而非原目录');

  const none = resolveSkillPlugins({ state: { superpowers: { enabled: true, disabledSkills: [...SUPERPOWERS_SKILL_WHITELIST] } }, installed: true, materializeFn });
  assert.deepEqual(none, [], '全部技能停用等同不注入');
});

test('BUILTIN_SKILLS 白名单一致性锚点', () => {
  assert.deepEqual(BUILTIN_SKILLS.map((d) => d.id), [...BUILTIN_SKILL_IDS]);
});
