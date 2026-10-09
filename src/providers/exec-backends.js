/**
 * Bash 执行后端运行时（T6 spec §4.5）：引擎探测（docker/podman）+ 后端解析。
 * 纯函数在 exec-backends.logic.js；本模块只管「跑探测命令」与缓存。
 *
 * fail-closed 纪律：配置了 container 但引擎不可用时返回 `unavailable`（Bash 明确报错），
 * **绝不静默退回本地**——owner 选容器就是为了隔离，静默退化等于悄悄取消隔离。
 */
import { runScript } from '../integrations/shell.js';
import { logger } from '../shared/logger.js';
import { pickEngine } from './exec-backends.logic.js';

/** 纯函数 companion 的便捷再导出：调用方（run-openai 等）只认本模块入口 */
export { pickEngine, describeBackend, buildContainerRunArgs, makeBashSpawn } from './exec-backends.logic.js';

const PROBE_TIMEOUT_MS = 5000;
const PROBE_TTL_MS = 60_000;
let _cache = null; // { at, engines: { docker, podman } }

/**
 * 探测 docker/podman 是否可用（`<engine> version`，带超时+缓存）。
 * @param {{runner?:Function, now?:number, ttlMs?:number}} [deps] 测试注入
 * @returns {Promise<{docker:boolean, podman:boolean}>}
 */
export async function probeEngines({ runner = runScript, now = Date.now(), ttlMs = PROBE_TTL_MS } = {}) {
  if (_cache && now - _cache.at < ttlMs) return _cache.engines;
  const engines = {};
  for (const engine of ['docker', 'podman']) {
    let ok = false;
    try {
      const r = await runner(engine, ['version', '--format', '{{.Server.Version}}'], { shell: false, timeoutMs: PROBE_TIMEOUT_MS });
      ok = !!(r && r.ok);
    } catch {
      ok = false;
    }
    engines[engine] = ok;
  }
  _cache = { at: now, engines };
  logger.info('exec-backends', '引擎探测完成', engines);
  return engines;
}

/** 清缓存（测试/设置变更后强制重探） */
export function resetEngineCache() {
  _cache = null;
}

/**
 * 解析 Bash 执行后端。
 * @param {{backend?:'local'|'container', image?:string, network?:boolean}} [execSettings]
 * @param {{runner?:Function}} [deps]
 * @returns {Promise<{kind:'local'}|{kind:'container',engine:string,image:string,network:boolean}|{kind:'unavailable',reason:string}>}
 */
export async function resolveBashBackend(execSettings, deps = {}) {
  const s = execSettings && typeof execSettings === 'object' ? execSettings : {};
  if (s.backend !== 'container') return { kind: 'local' };
  const engines = await probeEngines(deps);
  const engine = pickEngine(engines);
  if (!engine) {
    const reason = '未检测到可用的 docker/podman（已配置容器后端；Bash 将拒绝执行，不静默退回本地）';
    logger.warn('exec-backends', reason, { image: s.image });
    return { kind: 'unavailable', reason };
  }
  return { kind: 'container', engine, image: s.image || 'node:22-bookworm', network: !!s.network };
}
