import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldIdleRefresh, IDLE_HOUR, IDLE_WINDOW_MINUTES } from './idle-schedule.logic.js'

/** 造一个「当天本地时间 h:m」的时间戳；判定用本地时区，构造也必须用本地时区 */
function at(h, m = 0, dayOffset = 0) {
  const d = new Date(2026, 8, 3 + dayOffset, h, m, 0, 0)
  return d.getTime()
}

test('关闭时任何时刻都不跑', () => {
  const r = shouldIdleRefresh({ now: at(IDLE_HOUR, 5), enabled: false, lastRunAt: null })
  assert.equal(r.run, false)
  assert.equal(r.reason, 'disabled')
})

test('窗口内首次触发', () => {
  const r = shouldIdleRefresh({ now: at(IDLE_HOUR, 5), enabled: true, lastRunAt: null })
  assert.equal(r.run, true)
  assert.equal(r.reason, 'in-window')
})

test('窗口边界：起点含、终点不含', () => {
  assert.equal(shouldIdleRefresh({ now: at(IDLE_HOUR, 0), enabled: true }).run, true, '3:00 整应当跑')
  assert.equal(
    shouldIdleRefresh({ now: at(IDLE_HOUR, IDLE_WINDOW_MINUTES - 1), enabled: true }).run,
    true,
    '窗口最后一分钟仍应跑',
  )
  assert.equal(
    shouldIdleRefresh({ now: at(IDLE_HOUR, IDLE_WINDOW_MINUTES), enabled: true }).run,
    false,
    '窗口终点已在窗外',
  )
})

test('窗口外不跑', () => {
  for (const [h, m] of [[0, 0], [2, 59], [4, 0], [12, 0], [23, 59]]) {
    const r = shouldIdleRefresh({ now: at(h, m), enabled: true, lastRunAt: null })
    assert.equal(r.run, false, `${h}:${m} 不该跑`)
    assert.equal(r.reason, 'out-of-window')
  }
})

test('同一窗口内重复 tick 只跑一次', () => {
  // ticker 每 10 分钟醒一次，30 分钟窗口内会醒 3 次，不去重就会连跑三轮
  const first = at(IDLE_HOUR, 2)
  const r = shouldIdleRefresh({ now: at(IDLE_HOUR, 12), enabled: true, lastRunAt: first })
  assert.equal(r.run, false)
  assert.equal(r.reason, 'already-ran-today')
})

test('隔天再次进入窗口要能跑', () => {
  const yesterday = at(IDLE_HOUR, 5, -1)
  const r = shouldIdleRefresh({ now: at(IDLE_HOUR, 5), enabled: true, lastRunAt: yesterday })
  assert.equal(r.run, true, '隔了一天应当重新跑')
})

test('隔天但比昨天略早也要能跑（窗口内的抖动不能吃掉一整天）', () => {
  // 昨天在 3:25 跑的，今天 3:05 就醒了 —— 相隔 23h40m，不足 24h。
  // 若判据是「距上次满 24 小时」，今天这一轮会被误判成 already-ran，直接跳过一整天。
  const yesterdayLate = at(IDLE_HOUR, IDLE_WINDOW_MINUTES - 5, -1)
  const r = shouldIdleRefresh({ now: at(IDLE_HOUR, 5), enabled: true, lastRunAt: yesterdayLate })
  assert.equal(r.run, true, '窗口内的先后抖动不该让整天被跳过')
})
