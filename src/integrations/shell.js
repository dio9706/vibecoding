/**
 * 本地脚本 / CLI 执行封装 —— 全项目唯一的子进程入口。
 * 收集 stdout/stderr，返回结构化结果，不抛异常。
 * 注意：仅用于执行受信任的固定命令 + 受控参数；勿把任意用户输入拼进命令行。
 */
import { spawn } from 'node:child_process';

/**
 * 默认超时兜底。取 10 分钟：足够 npm install / 大仓 git 操作跑完，
 * 又能保证「卡住」在可接受时间内被发现。
 * 没有它的后果是真实事故：git push 撞上凭证提示会交互式等待并永不退出，
 * close 事件不来 → Promise 永不 resolve → auto-dev 泵的 running 标志永远为 true
 * → 所有后续自动开发任务无限排队，且零日志、用户侧毫无感知。
 */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** 杀子进程。Windows 上用 taskkill /T 连同子孙一起杀（git 会派生 credential helper 等） */
function killTree(child) {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      return;
    } catch {
      /* 落回下面的 kill */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
}

/**
 * @param {string} bin 可执行文件（如 python）
 * @param {string[]} args 参数数组（固定 flag + 已校验的值）
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {Record<string,string>} [opts.env] 追加到子进程的环境变量（与 process.env 合并）
 * @param {boolean} [opts.shell] 覆盖默认 shell 行为。**默认 false**，见下方安全说明。
 *   仅当命令与全部参数都受信（如 owner 配置的 setupScript）且确实需要 shell 特性
 *   （.cmd/.bat shim、管道重定向）时才显式传 true。
 * @param {string} [opts.input] 写入子进程 stdin 的内容，写完即关流。
 *   **不传时行为与从前完全一致**（立刻 EOF，见下方 stdin 注释）。
 *   用途：给脚本递不适合走命令行的载荷 —— 长文本会撞参数长度上限，
 *   而含引号/换行的内容走 argv 要处理各平台不同的转义规则。
 *   首个使用者是 tracking-stats 的 sql_exec.py（递一段 SQL）。
 * @returns {Promise<{ok:boolean, code?:number, out?:string, err?:string, msg?:string}>}
 */
export function runScript(bin, args, { cwd, env, shell, input, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer = null;
    const done = (r) => {
      if (settled) return; // kill 之后 'close' 仍会派发一次，防重
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    try {
      child = spawn(bin, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        // 安全默认 shell:false —— 曾经在 Windows 下默认 true「以便定位可执行文件」，
        // 但 cmd.exe 只拼接不转义参数（Node 亦为此发 DEP0190 警告）。
        // action-runner 的参数直接来自飞书用户聊天输入（script-runner buildScriptArgs），
        // 实测 `a | whoami` 会真的执行 whoami —— 即任意命令执行。
        // shell:false 走 CreateProcess/execvp，参数以数组语义传递，元字符不再被解释；
        // `node` / `python` 这类 .exe 仍能经 PATH 正常定位（.cmd/.bat shim 需调用方显式给全路径）。
        shell: shell !== undefined ? shell : false,
        windowsHide: true, // 桌面版（无控制台父进程）下经 cmd 执行会弹黑框，必须隐藏
      });
    } catch (e) {
      return done({ ok: false, msg: `无法启动 ${bin}：${e.message}` });
    }
    // stdin 必须**尽快关闭**：不关会让任何读 stdin 的程序（git 问凭证、python input()）
    // 永远等下去。传了 input 就先写进去再关，没传就直接 EOF —— 两条路都保证「一定会关」。
    //
    // stdin 上的 error 必须单独吞掉：子进程若在我们写完之前就退出（比如 python 崩在
    // import 阶段），这里会收到 EPIPE，未处理的 stream error 会直接打挂整个进程。
    try {
      if (child.stdin) {
        child.stdin.on('error', () => {
          /* EPIPE：子进程已退出，输出/退出码由下面的 close 分支如实回报 */
        });
        if (input !== undefined && input !== null) child.stdin.end(String(input), 'utf8');
        else child.stdin.end();
      }
    } catch {
      /* stdio 未走管道时无 stdin */
    }
    // 收集原始 Buffer，close 时整体解码为 UTF-8：
    // 避免多字节字符（中文）跨 data chunk 被逐块 toString 截断成乱码。
    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (d) => outChunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', (e) =>
      done({
        ok: false,
        msg: `无法启动 ${bin}：${e.code === 'ENOENT' ? '找不到可执行文件（检查 PATH）' : e.message}`,
      }),
    );
    child.on('close', (code) =>
      done({
        ok: code === 0,
        code,
        out: Buffer.concat(outChunks).toString('utf8').trim(),
        err: Buffer.concat(errChunks).toString('utf8').trim(),
      }),
    );
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child);
        done({
          ok: false,
          timedOut: true,
          msg: `${bin} 执行超时（${Math.round(timeoutMs / 1000)}s），已强制结束`,
          out: Buffer.concat(outChunks).toString('utf8').trim(),
          err: Buffer.concat(errChunks).toString('utf8').trim(),
        });
      }, timeoutMs);
    }
  });
}
