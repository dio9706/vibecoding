/**
 * Bash 执行后端纯函数单测（T6）：引擎选择 / 容器参数构造（安全敏感面）/ spawn 计划。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickEngine, buildContainerRunArgs, makeBashSpawn, describeBackend, CONTAINER_WORKDIR } from './exec-backends.logic.js';

test('pickEngine：docker 优先，其次 podman，都不可用为 null', () => {
  assert.equal(pickEngine({ docker: true, podman: true }), 'docker');
  assert.equal(pickEngine({ docker: false, podman: true }), 'podman');
  assert.equal(pickEngine({ docker: false, podman: false }), null);
  assert.equal(pickEngine({}), null);
});

test('buildContainerRunArgs：挂载/工作目录/镜像/命令；无网默认，可显式放开', () => {
  const args = buildContainerRunArgs({
    engine: 'docker',
    image: 'node:22-bookworm',
    workspace: 'C:\\proj',
    command: 'npm test',
  });
  assert.deepEqual(args, [
    'run',
    '--rm',
    '-i',
    '--workdir',
    CONTAINER_WORKDIR,
    '-v',
    `C:/proj:${CONTAINER_WORKDIR}`, // Windows 反斜杠转正斜杠（Docker 卷语法）
    '--network',
    'none', // 默认无网
    'node:22-bookworm',
    'sh',
    '-lc',
    'npm test',
  ]);

  const net = buildContainerRunArgs({ engine: 'docker', image: 'img', workspace: '/home/u/p', command: 'x', network: true });
  assert.ok(!net.includes('--network'), '允许网络时不加 --network none');
  assert.equal(net[net.length - 1], 'x');
});

test('makeBashSpawn：local 与旧行为逐字一致（命令交 shell）；container 走引擎参数数组', () => {
  assert.deepEqual(makeBashSpawn({ kind: 'local' }, 'npm test', 'C:\\proj'), { bin: 'npm test', args: [], shell: true });
  assert.deepEqual(makeBashSpawn(null, 'echo hi', 'C:\\proj'), { bin: 'echo hi', args: [], shell: true }, '缺省按 local');

  const plan = makeBashSpawn({ kind: 'container', engine: 'podman', image: 'img', network: false }, 'npm test', '/ws');
  assert.equal(plan.bin, 'podman');
  assert.equal(plan.shell, false);
  assert.deepEqual(plan.args.slice(0, 2), ['run', '--rm']);
  assert.ok(plan.args.includes('/ws:/workspace'));
});

test('describeBackend：三种后端的可读文案', () => {
  assert.equal(describeBackend({ kind: 'local' }), '本地执行');
  assert.match(describeBackend({ kind: 'container', engine: 'docker', network: false }), /容器执行（docker，无网络）/);
  assert.match(describeBackend({ kind: 'container', engine: 'podman', network: true }), /允许网络/);
  assert.match(describeBackend({ kind: 'unavailable', reason: '没引擎' }), /执行后端不可用（没引擎）/);
});
