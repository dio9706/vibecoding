/**
 * 闲时刷新的窗口判定 —— 纯函数，零 IO（单测目标）。
 *
 * 为什么要「窗口」而不是「精确 3 点」：ticker 每 10 分钟醒一次，
 * 撞不上某个精确时刻。给一段窗口，只要这段时间内醒过一次就能跑到。
 *
 * 为什么要 lastRunAt 去重：窗口有 30 分钟宽，期间会醒 3 次。
 * 不去重就会连跑三轮——虽然增量后大多是零成本空转，但项目多时仍是白白扫盘。
 */

/** 默认在凌晨 3:00–3:30 之间跑。窗口比 tick 间隔（10 分钟）宽，保证一定能命中。 */
export const IDLE_HOUR = 3
export const IDLE_WINDOW_MINUTES = 30

/**
 * 现在该不该跑一轮闲时刷新。
 *
 * @param {object} opts
 * @param {number} opts.now 当前时间戳
 * @param {boolean} opts.enabled 用户是否开启了闲时更新
 * @param {number|null} opts.lastRunAt 上次闲时刷新完成的时间戳
 * @param {number} [opts.hour] 窗口起始整点，默认 3
 * @param {number} [opts.windowMinutes] 窗口长度（分钟），默认 30
 * @returns {{run: boolean, reason: string}} reason 用于日志，能直接看出为什么没跑
 */
export function shouldIdleRefresh({
  now,
  enabled,
  lastRunAt = null,
  hour = IDLE_HOUR,
  windowMinutes = IDLE_WINDOW_MINUTES,
}) {
  if (!enabled) return { run: false, reason: 'disabled' }

  // 用本地时间：用户说的「凌晨 3 点」是他所在时区的 3 点。
  // 若进程时区与用户不一致（服务器常见 UTC），这里会错开，属于部署问题，
  // 不在代码里猜——日志会打出判定用的本地小时，对不上一眼能看出来。
  const d = new Date(now)
  const minuteOfDay = d.getHours() * 60 + d.getMinutes()
  const start = hour * 60
  const end = start + windowMinutes
  if (minuteOfDay < start || minuteOfDay >= end) {
    return { run: false, reason: 'out-of-window' }
  }

  // 同一个窗口内只跑一次。判据是「上次跑完距今不足一天」而非「日期不同」：
  // 后者在跨月/跨年、以及窗口横跨午夜时都要额外处理，前者一个减法就够。
  if (lastRunAt && now - lastRunAt < 24 * 60 * 60 * 1000 - windowMinutes * 60 * 1000) {
    return { run: false, reason: 'already-ran-today' }
  }

  return { run: true, reason: 'in-window' }
}
