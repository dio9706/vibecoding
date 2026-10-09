/**
 * Bash 执行后端 —— 纯函数层（T6 spec §4.5）：引擎选择 / 容器参数构造 / spawn 计划。
 *
 * 只服务 **openai 路径的自研 Bash**（Claude 路径的 Bash 由 SDK 的 CLI 子进程执行，
 * 本期不容器化——边界见 spec §2）。设计立场（参考 pi）：权限提示不是安全边界，
 * 无人值守的正解是执行环境隔离，容器是它的配套。
 *
 * 纯函数的原因：容器参数（挂载/网络/工作目录/命令注入点）是安全敏感面，
 * 必须有离线可钉的用例，而不是只能靠真 docker 手工验。
 */
import path from 'node:path';

/** 容器内的工作目录固定路径（宿主工作区挂载到这里） */
export const CONTAINER_WORKDIR = '/workspace';

/**
 * 选一个可用引擎。优先 docker（生态默认），其次 podman。
 * @param {{docker?:boolean, podman?:boolean}} engines
 * @returns {'docker'|'podman'|null}
 */
export function pickEngine(engines = {}) {
  if (engines.docker) return 'docker';
  if (engines.podman) return 'podman';
  return null;
}

/**
 * 构造 `docker run` 参数（含镜像与命令）。
 *
 * - 挂载宿主机工作目录到 CONTAINER_WORKDIR（读写；文件工具在宿主侧按同一路径读写，见 spec 非目标）；
 * - `network=false`（默认）加 `--network none`：容器内无网；
 * - Windows 路径转正斜杠（Docker Desktop 的卷语法对 `C:\a` 兼容但 `C:/a` 更稳）；
 * - 命令经 `sh -lc` 执行：容器内是 Linux 语义，多段命令由容器自己的 shell 解析
 *   （策略层已在宿主侧按命令原文做过安全判定，容器不二次裁决）。
 *
 * @param {{engine:string, image:string, workspace:string, command:string, network?:boolean}} p
 * @returns {string[]} spawn 参数数组（bin = engine）
 */
export function buildContainerRunArgs({ engine, image, workspace, command, network = false }) {
  const host = String(workspace || '').replace(/\\/g, '/');
  const args = [
    'run',
    '--rm',
    '-i',
    '--workdir',
    CONTAINER_WORKDIR,
    '-v',
    `${host}:${CONTAINER_WORKDIR}`,
  ];
  if (!network) args.push('--network', 'none');
  args.push(String(image || ''), 'sh', '-lc', String(command ?? ''));
  return args;
}

/**
 * Bash 后端 → spawn 计划（builtin-tools 的执行核按它起进程，超时/中止/杀进程逻辑不变）。
 * @param {{kind:'local'}|{kind:'container',engine:string,image:string,network?:boolean}|{kind:'unavailable',reason:string}|null} backend
 * @param {string} command
 * @param {string} workspace
 * @returns {{bin:string, args:string[], shell:boolean}}
 */
export function makeBashSpawn(backend, command, workspace) {
  if (backend && backend.kind === 'container') {
    return {
      bin: backend.engine,
      args: buildContainerRunArgs({ engine: backend.engine, image: backend.image, workspace, command, network: !!backend.network }),
      shell: false,
    };
  }
  // local（缺省）与旧行为逐字一致：命令直接交给 shell
  return { bin: command, args: [], shell: true };
}

/** 可读的后端描述（activity 行/日志用） */
export function describeBackend(backend) {
  if (!backend || backend.kind === 'local') return '本地执行';
  if (backend.kind === 'container') return `容器执行（${backend.engine}${backend.network ? '，允许网络' : '，无网络'}）`;
  return `执行后端不可用（${backend.reason || '未知原因'}）`;
}

/** 归一化工作区（绝对路径；容器挂载必须有绝对路径） */
export function normalizeWorkspacePath(workspace) {
  return path.resolve(workspace || process.cwd());
}
