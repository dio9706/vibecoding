/**
 * Bash 执行后端运行时单测（T6）：引擎探测缓存 + 后端解析（fail-closed 不退回本地）。
 * 全部注入假 runner，不依赖本机是否装了 docker。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeEngines, resolveBashBackend, resetEngineCache } from './exec-backends.js';

test('probeEngines：探测两引擎并缓存（TTL 内不重探）；reset 后可重探', async () => {
  resetEngineCache();
  let calls = 0;
  const runner = async (bin) => {
    calls++;
    return { ok: bin === 'docker' };
  };
  const e1 = await probeEngines({ runner, now: 1000, ttlMs: 60_000 });
  assert.deepEqual(e1, { docker: true, podman: false });
  assert.equal(calls, 2, '两个引擎各探一次');

  const e2 = await probeEngines({ runner, now: 2000, ttlMs: 60_000 });
  assert.deepEqual(e2, e1);
  assert.equal(calls, 2, 'TTL 内命中缓存，不重复探测');

  resetEngineCache();
  await probeEngines({ runner, now: 3000, ttlMs: 60_000 });
  assert.equal(calls, 4, 'reset 后重新探测');
  resetEngineCache();
});

test('probeEngines：runner 抛错/超时形态不炸，视为不可用', async () => {
  resetEngineCache();
  const runner = async () => {
    throw new Error('boom');
  };
  const e = await probeEngines({ runner, now: 10 });
  assert.deepEqual(e, { docker: false, podman: false });
  resetEngineCache();
});

test('resolveBashBackend：local 不探测；container 有引擎用容器；无引擎 unavailable（绝不静默退回本地）', async () => {
  resetEngineCache();
  let probed = 0;
  const none = async () => {
    probed++;
    return { ok: false };
  };

  assert.deepEqual(await resolveBashBackend({ backend: 'local' }, { runner: none }), { kind: 'local' });
  assert.deepEqual(await resolveBashBackend(undefined, { runner: none }), { kind: 'local' });
  assert.equal(probed, 0, 'local 档不触发探测');

  resetEngineCache();
  const dockerOnly = async (bin) => ({ ok: bin === 'docker' });
  const c = await resolveBashBackend({ backend: 'container', image: 'img', network: true }, { runner: dockerOnly });
  assert.deepEqual(c, { kind: 'container', engine: 'docker', image: 'img', network: true });

  resetEngineCache();
  const un = await resolveBashBackend({ backend: 'container' }, { runner: none });
  assert.equal(un.kind, 'unavailable');
  assert.match(un.reason, /docker\/podman/);
  assert.match(un.reason, /不静默退回本地/);

  resetEngineCache();
});
