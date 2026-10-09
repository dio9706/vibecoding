/**
 * 工具策略规则表单测（T6）：档位矩阵表驱动 + 危险命令正/反例 + 安全命令 + 无人值守映射。
 * 反例与正例同样重要：误杀开发例行命令会逼用户切 bypass，整张表就白做了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY_LEVELS,
  MAX_POLICY_BLOCKS,
  classifyTool,
  extractTargetPaths,
  detectDangerousCommand,
  isSafeCommand,
  decideToolAction,
  resolveUnattendedPolicy,
  EXEC_POLICIES,
} from './tool-policy.logic.js';

const WS = process.platform === 'win32' ? 'C:\\bench-ws' : '/bench-ws';
const inside = WS + (process.platform === 'win32' ? '\\a.txt' : '/a.txt');
const outside = process.platform === 'win32' ? 'D:\\elsewhere\\a.txt' : '/elsewhere/a.txt';

const decide = (toolName, input, opts = {}) => decideToolAction({ toolName, input, workspace: WS, ...opts });

test('classifyTool：内置/网络/子代理/未知分类', () => {
  assert.equal(classifyTool('Read'), 'read');
  assert.equal(classifyTool('TodoWrite'), 'read');
  assert.equal(classifyTool('RepoMap'), 'read');
  assert.equal(classifyTool('Write'), 'write');
  assert.equal(classifyTool('MultiEdit'), 'write');
  assert.equal(classifyTool('NotebookEdit'), 'write');
  assert.equal(classifyTool('Bash'), 'execute');
  assert.equal(classifyTool('WebFetch'), 'network');
  assert.equal(classifyTool('WebSearch'), 'network');
  assert.equal(classifyTool('Agent'), 'agent');
  assert.equal(classifyTool('Task'), 'agent');
  assert.equal(classifyTool('mcp__context7__resolve-library-id'), 'other');
  assert.equal(classifyTool(''), 'other');
});

test('extractTargetPaths：file_path / notebook_path / path / edits 子路径', () => {
  assert.deepEqual(extractTargetPaths('Read', { file_path: 'a.txt' }), ['a.txt']);
  assert.deepEqual(extractTargetPaths('MultiEdit', { file_path: 'a.txt', edits: [{ file_path: 'b.txt' }] }), ['a.txt', 'b.txt']);
  assert.deepEqual(extractTargetPaths('NotebookEdit', { notebook_path: 'n.ipynb' }), ['n.ipynb']);
  assert.deepEqual(extractTargetPaths('Grep', { pattern: 'x', path: 'src' }), ['src']);
  assert.deepEqual(extractTargetPaths('Bash', { command: 'x' }), []);
});

test('默认档（default）：区内读放行；写/命令/网络/越界/未知一律 ask；危险命令 deny', () => {
  assert.equal(decide('Read', { file_path: inside }).action, 'allow');
  assert.equal(decide('Write', { file_path: inside }).action, 'ask');
  assert.equal(decide('Write', { file_path: outside }).action, 'ask');
  assert.equal(decide('Read', { file_path: outside }).action, 'ask');
  assert.equal(decide('Bash', { command: 'npm test' }).action, 'ask');
  assert.equal(decide('WebFetch', { url: 'https://x' }).action, 'ask');
  assert.equal(decide('mcp__srv__tool', {}).action, 'ask');
  assert.equal(decide('Agent', {}).action, 'allow');

  const d = decide('Bash', { command: 'rm -rf /' });
  assert.equal(d.action, 'deny');
  assert.equal(d.ruleId, 'dangerous:rm_root');
});

test('acceptEdits：区内写放行；命令/网络仍 ask', () => {
  const lvl = 'acceptEdits';
  assert.equal(decide('Write', { file_path: inside }, { level: lvl }).action, 'allow');
  assert.equal(decide('Write', { file_path: outside }, { level: lvl }).action, 'ask');
  assert.equal(decide('Bash', { command: 'npm test' }, { level: lvl }).action, 'ask');
  assert.equal(decide('WebFetch', {}, { level: lvl }).action, 'ask');
});

test('plan：只读放行，写/命令/网络/未知 deny（计划模式不执行副作用）', () => {
  assert.equal(decide('Read', { file_path: inside }, { level: 'plan' }).action, 'allow');
  assert.equal(decide('Write', { file_path: inside }, { level: 'plan' }).action, 'deny');
  assert.equal(decide('Bash', { command: 'npm test' }, { level: 'plan' }).action, 'deny');
  assert.equal(decide('WebFetch', {}, { level: 'plan' }).action, 'deny');
});

test('bypassPermissions：全放行，但危险命令仍 deny（openai 路径可拦）', () => {
  const lvl = 'bypassPermissions';
  assert.equal(decide('Write', { file_path: outside }, { level: lvl }).action, 'allow');
  assert.equal(decide('Bash', { command: 'curl https://x' }, { level: lvl }).action, 'allow');
  assert.equal(decide('Bash', { command: 'shutdown /s' }, { level: lvl }).action, 'deny');
});

test('unattended-standard：区间读写自动；安全命令放行；其余命令/网络/越界 ask（运行时门再翻译拒绝）', () => {
  const lvl = 'unattended-standard';
  assert.equal(decide('Write', { file_path: inside }, { level: lvl }).action, 'allow');
  assert.equal(decide('Read', { file_path: inside }, { level: lvl }).action, 'allow');
  assert.equal(decide('Bash', { command: 'npm test' }, { level: lvl }).action, 'allow');
  assert.equal(decide('Bash', { command: 'npm test' }, { level: lvl }).ruleId, `level:${lvl}:execute_safe`);
  assert.equal(decide('Bash', { command: 'git push origin main' }, { level: lvl }).action, 'ask');
  assert.equal(decide('Bash', { command: 'curl https://x' }, { level: lvl }).action, 'ask');
  assert.equal(decide('Write', { file_path: outside }, { level: lvl }).action, 'ask');
  assert.equal(decide('WebFetch', {}, { level: lvl }).action, 'ask');
  assert.equal(decide('Bash', { command: 'rm -rf /' }, { level: lvl }).action, 'deny');
});

test('unattended-trusted：除危险命令外全放行', () => {
  const lvl = 'unattended-trusted';
  assert.equal(decide('Bash', { command: 'git push origin main' }, { level: lvl }).action, 'allow');
  assert.equal(decide('Write', { file_path: outside }, { level: lvl }).action, 'allow');
  assert.equal(decide('Bash', { command: 'rm -rf /' }, { level: lvl }).action, 'deny');
});

test('disabledTools / autoAllow / readOnlyExtra：优先级高于矩阵', () => {
  const disabledTools = new Set(['Read']);
  assert.equal(decide('Read', { file_path: inside }, { disabledTools }).action, 'deny');
  assert.equal(decide('Read', { file_path: inside }, { disabledTools }).ruleId, 'disabled_tool');

  const autoAllow = new Set(['mcp__srv__read']);
  assert.equal(decide('mcp__srv__read', {}, { autoAllow }).action, 'allow');
  assert.equal(decide('mcp__srv__other', {}, { autoAllow }).action, 'ask');

  const readOnlyExtra = new Set(['WaitColleagueReply']);
  assert.equal(decide('WaitColleagueReply', {}, { readOnlyExtra }).action, 'allow');
});

test('未知档位按 default 兜底（fail-closed，不静默放行）', () => {
  const d = decide('Write', { file_path: inside }, { level: 'hacker' });
  assert.equal(d.action, 'ask');
  assert.match(d.ruleId, /^level:default:/);
});

test('detectDangerousCommand：灾难性命令必拦', () => {
  const hits = [
    'rm -rf /',
    'rm -rf /*',
    'rm -rf --no-preserve-root /',
    'sudo rm -rf /',
    'cd /tmp && rm -rf /',
    'rm -rf ~',
    'rm -rf ~/',
    'rm -rf $HOME',
    'rm -rf C:\\',
    'rd /s /q C:\\',
    'del /f /s /q D:\\*',
    'mkfs.ext4 /dev/sda1',
    'diskpart',
    'dd if=/dev/zero of=/dev/sda',
    'format C:',
    'shutdown -h now',
    'shutdown /s /t 0',
    'reboot',
    'poweroff',
    ':(){ :|:& };:',
    'chmod -R 777 /',
    'sudo chown -R x /',
    // 进程击杀类（2026-10-08 事故：agent 用 taskkill 按镜像名杀光 node，把承载它的后端也杀了）
    'taskkill /f /im node.exe',
    'taskkill /F /IM node.exe /fi "WINDOWTITLE eq *"',
    'cd workspace && taskkill /f /im node.exe',
    'pkill -f node',
    'killall node',
    'Stop-Process -Name node -Force',
    'kill -9 1234',
  ];
  for (const c of hits) assert.ok(detectDangerousCommand(c), `应命中：${c}`);
});

test('detectDangerousCommand：开发例行命令不得误杀', () => {
  const misses = [
    'rm -rf ./build',
    'rm -rf node_modules',
    'rm -rf ../dist',
    'rm -rf /tmp/cache-x',
    'npm run clean',
    'npm test',
    'git status',
    'eslint --format json .',
    'echo "shutdown is disabled"',
    'npm run shutdown-check',
    'dd if=a.txt of=b.txt',
    'chmod +x ./script.sh',
    'chown user:group ./file',
    'echo "taskkill is blocked"',
    'grep -r taskkill docs/',
    '',
  ];
  for (const c of misses) assert.equal(detectDangerousCommand(c), null, `不应命中：${c}`);
});

test('isSafeCommand：单段例行命令放行；链式/重定向/未知脚本一律不放行', () => {
  const safe = [
    'npm test',
    'npm test -- --grep x',
    'npm run build',
    'npm run typecheck',
    'node --test src/a.test.js',
    'node --check src/a.js',
    'npx --no-install tsc',
    'git status',
    'git diff --stat',
    'git log --oneline -5',
    'ls -la',
    'dir src',
  ];
  for (const c of safe) assert.equal(isSafeCommand(c), true, `应放行：${c}`);

  const unsafe = [
    'npm run dev',
    'npm run publish',
    'npm install',
    'git branch -D foo',
    'git stash',
    'git push',
    'node server.js',
    'npx tsc',
    'npm test && echo ok',
    'npm test | tee out.txt',
    'npm test > out.txt',
    'echo hi $(whoami)',
    'curl https://x',
    'rm -rf build',
    'ls\nrm -rf /',
    '',
  ];
  for (const c of unsafe) assert.equal(isSafeCommand(c), false, `不应放行：${c}`);
});

test('resolveUnattendedPolicy：默认/非法值回退 bypass（与改动前一致）；standard/trusted 映射档位与 SDK mode', () => {
  assert.deepEqual(resolveUnattendedPolicy(undefined), {
    execPolicy: 'bypass',
    unattended: true,
    policyLevel: 'bypassPermissions',
    sdkMode: 'bypassPermissions',
  });
  assert.equal(resolveUnattendedPolicy('乱填').execPolicy, 'bypass');

  const std = resolveUnattendedPolicy('standard');
  assert.equal(std.policyLevel, 'unattended-standard');
  assert.equal(std.sdkMode, 'default', 'standard 必须走 default 让 canUseTool 生效');

  const trusted = resolveUnattendedPolicy('trusted');
  assert.equal(trusted.policyLevel, 'unattended-trusted');
  assert.equal(trusted.sdkMode, 'default');
  assert.deepEqual(EXEC_POLICIES, ['bypass', 'standard', 'trusted']);
});

test('常量口径：POLICY_LEVELS 覆盖全部档位；熔断阈值与续跑熔断同量级', () => {
  assert.deepEqual(POLICY_LEVELS, [
    'default',
    'acceptEdits',
    'plan',
    'bypassPermissions',
    'unattended-standard',
    'unattended-trusted',
  ]);
  assert.equal(MAX_POLICY_BLOCKS, 3);
});
