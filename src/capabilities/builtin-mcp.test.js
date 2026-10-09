/**
 * builtin-mcp.js 测试：注册表与白名单一致性、开关/路径/平台/密钥解析、SDK 形态映射、探测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_MCP_IDS } from '../shared/builtin-ids.js';
import {
  BUILTIN_MCP,
  npxInvocation,
  probeBuiltinMcp,
  registryIdsMatchWhitelist,
  resolveBuiltinMcp,
  toClaudeServerConfig,
} from './builtin-mcp.js';

test('注册表与 shared 白名单严格一致（防两处漂移）', () => {
  assert.equal(registryIdsMatchWhitelist(), true);
  assert.deepEqual(
    BUILTIN_MCP.map((d) => d.id).sort(),
    [...BUILTIN_MCP_IDS].sort(),
  );
});

test('默认值：context7 开、figma 全关（空 state）', () => {
  const claude = resolveBuiltinMcp({ provider: 'claude', state: {} });
  assert.deepEqual(claude.map((e) => e.builtinId), ['context7']);
  const openai = resolveBuiltinMcp({ provider: 'openai', state: {} });
  assert.deepEqual(openai.map((e) => e.builtinId), ['context7']);
});

test('显式关掉 context7 后不再产出', () => {
  const r = resolveBuiltinMcp({ provider: 'openai', state: { context7: { enabled: false } } });
  assert.deepEqual(r, []);
});

test('路径过滤：figma-devmode 仅 Claude；figma-framelink 双路径', () => {
  const state = { 'figma-devmode': { enabled: true }, 'figma-framelink': { enabled: true, apiKey: 'k' } };
  const claude = resolveBuiltinMcp({ provider: 'claude', state });
  assert.deepEqual(claude.map((e) => e.builtinId).sort(), ['context7', 'figma-devmode', 'figma-framelink']);
  const openai = resolveBuiltinMcp({ provider: 'openai', state });
  assert.deepEqual(openai.map((e) => e.builtinId).sort(), ['context7', 'figma-framelink']);
});

test('必需密钥缺失：figma-framelink 不产出（UI 提示去配置，而不是连接必失败）', () => {
  const r = resolveBuiltinMcp({ provider: 'openai', state: { 'figma-framelink': { enabled: true } } });
  assert.deepEqual(r.map((e) => e.builtinId), ['context7']);
});

test('平台：win32 走 cmd.exe /c npx，posix 走 npx', () => {
  const win = npxInvocation(['-y', 'pkg'], 'win32');
  assert.equal(win.command, 'cmd.exe');
  assert.deepEqual(win.args, ['/d', '/s', '/c', 'npx', '-y', 'pkg']);
  const posix = npxInvocation(['-y', 'pkg'], 'darwin');
  assert.equal(posix.command, 'npx');
  assert.deepEqual(posix.args, ['-y', 'pkg']);

  const r = resolveBuiltinMcp({ provider: 'openai', state: {}, platform: 'win32' });
  assert.equal(r[0].command, 'cmd.exe');
  assert.deepEqual(r[0].args.slice(0, 4), ['/d', '/s', '/c', 'npx']);
});

test('密钥注入：context7 可选、framelink 必需；都只进 env 不进军命令行', () => {
  const r = resolveBuiltinMcp({
    provider: 'openai',
    state: { context7: { apiKey: 'ctx-key' }, 'figma-framelink': { enabled: true, apiKey: 'fig-key' } },
  });
  const ctx = r.find((e) => e.builtinId === 'context7');
  assert.deepEqual(ctx.env, { CONTEXT7_API_KEY: 'ctx-key' });
  const fig = r.find((e) => e.builtinId === 'figma-framelink');
  assert.deepEqual(fig.env, { FIGMA_API_KEY: 'fig-key' });
  assert.ok(!`${ctx.command} ${ctx.args.join(' ')}`.includes('ctx-key'), '密钥不得出现在命令行');
});

test('context7 带回只读 autoAllow；http 形态的 figma-devmode 无命令字段', () => {
  const r = resolveBuiltinMcp({ provider: 'claude', state: { 'figma-devmode': { enabled: true } } });
  const ctx = r.find((e) => e.builtinId === 'context7');
  assert.deepEqual(ctx.autoAllow, ['resolve-library-id', 'get-library-docs']);
  const fig = r.find((e) => e.builtinId === 'figma-devmode');
  assert.equal(fig.transport, 'http');
  assert.equal(fig.command, undefined);
  assert.equal(fig.url, 'http://127.0.0.1:3845/mcp');
});

test('toClaudeServerConfig：stdio / http 两形态', () => {
  const [ctx] = resolveBuiltinMcp({ provider: 'claude', state: {} });
  const cfg = toClaudeServerConfig(ctx);
  assert.equal(cfg.type, 'stdio');
  assert.equal(cfg.command, process.platform === 'win32' ? 'cmd.exe' : 'npx');
  assert.ok(Array.isArray(cfg.args));

  const [fig] = resolveBuiltinMcp({ provider: 'claude', state: { 'figma-devmode': { enabled: true } } }).filter(
    (e) => e.builtinId === 'figma-devmode',
  );
  assert.deepEqual(toClaudeServerConfig(fig), { type: 'http', url: 'http://127.0.0.1:3845/mcp' });
});

test('settings 形态兼容：既收 state 也收 settings.builtinMcp；脏输入不炸', () => {
  const viaSettings = resolveBuiltinMcp({ provider: 'openai', settings: { builtinMcp: { context7: { enabled: false } } } });
  assert.deepEqual(viaSettings, [], '关掉状态经 settings.builtinMcp 同样生效');
  // 什么都没存 → 走注册表默认（context7 开），这是设计而非漏洞
  assert.deepEqual(resolveBuiltinMcp({ provider: 'openai', state: null, settings: null }).map((e) => e.builtinId), ['context7']);
  // 脏 state：非对象项按缺省值处理
  const dirty = resolveBuiltinMcp({ provider: 'openai', state: { context7: 'yes', 'figma-framelink': [] } });
  assert.deepEqual(dirty.map((e) => e.builtinId), ['context7']);
});

test('probeBuiltinMcp：无 probe 端点返回 null；可达 true；异常/超时 false', async () => {
  assert.equal(await probeBuiltinMcp({ id: 'x' }), null);
  const ok = await probeBuiltinMcp({ probe: 'http://x' }, { fetchImpl: async () => ({ status: 406 }) });
  assert.equal(ok, true);
  const bad = await probeBuiltinMcp({ probe: 'http://x' }, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(bad, false);
});
