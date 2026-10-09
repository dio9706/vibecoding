/**
 * 验证器纯函数层：输出截断、耗时/摘要格式化、任务字段归一。
 *
 * 摘要进卡片与任务字段、截断输出进 verifyLog——两条通道共用这里的取数逻辑（对齐
 * task-notify 的 mergeStatusOf 纪律：同一事实只允许一份实现，否则卡片与日志迟早分叉）。
 */

export const HEAD_CHARS = 2000;
export const TAIL_CHARS = 4000;

/** 头+尾截断：失败现场两头都有信息（开头是命令回显/环境，结尾是断言与堆栈） */
export function truncateOutput(text, { head = HEAD_CHARS, tail = TAIL_CHARS } = {}) {
  const s = String(text ?? '');
  if (s.length <= head + tail) return s;
  return s.slice(0, head) + `\n…（略 ${s.length - head - tail} 字符）\n` + s.slice(-tail);
}

/**
 * 从解析后的 package.json 发现默认验证命令：有真实 test 脚本 → `npm test`，否则 ''。
 *
 * 特意剔除 npm init 生成的占位脚本（`echo "Error: no test specified" && exit 1`）：
 * 它不是测试，发现它等于让所有未配置自检的裸 npm 工程必然失败（重试烧额度 + 退回待开发）。
 * 判定做成独立纯函数，Phase 3 openai 路径复用同一「显式配置 > 自动发现 > 未配置」规则。
 */
export function discoverVerifyCommand(pkg) {
  const test = pkg?.scripts?.test;
  if (typeof test !== 'string') return '';
  const t = test.trim();
  if (!t || /no test specified/i.test(t)) return '';
  return 'npm test';
}

/** 毫秒 → 人话时长：45s / 2m13s / 1h2m */
export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '-';
  const total = Math.round(n / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) {
    const s = total % 60;
    return s ? `${m}m${s}s` : `${m}m`;
  }
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** 输出尾部最后一条有信息量的行（失败摘要用）；空输出返回 '' */
export function lastMeaningfulLine(text, max = 120) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  return last.length > max ? last.slice(0, max) + '…' : last;
}

/**
 * 运行结果 → 单行摘要。
 * @param {{command?:string, ok?:boolean, skipped?:boolean, reason?:string, exitCode?:number|null, timedOut?:boolean, durationMs?:number, output?:string}} r
 */
export function buildVerifySummary(r = {}) {
  const cmd = r.command || '验证命令';
  if (r.skipped) {
    return r.reason === '未配置验证命令' ? '未配置验证命令' : `已跳过（${r.reason || '未执行'}）`;
  }
  const dur = formatDuration(r.durationMs);
  if (r.timedOut) return `${cmd} 超时（${dur}）`;
  if (r.ok) return `${cmd} 通过（${dur}）`;
  const tail = lastMeaningfulLine(r.output);
  return `${cmd} 失败（退出码 ${r.exitCode ?? '-'}${tail ? `：${tail}` : ''}）`;
}

/**
 * 运行结果 → 落任务字段的记录（**剥离完整输出**：输出单独进 verifyLog，避免同一份数据两处落盘）。
 */
export function toVerifyRecord(r = {}, attempts = 1, at = new Date().toISOString()) {
  return {
    ok: !!r.ok,
    skipped: !!r.skipped,
    command: r.command || '',
    reason: r.reason || '',
    exitCode: r.exitCode ?? null,
    timedOut: !!r.timedOut,
    durationMs: r.durationMs || 0,
    summary: r.summary || buildVerifySummary(r),
    attempts,
    at,
  };
}
