import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRun, parseHm } from './schedule.js';

// 用本地时间构造，避免时区差异导致用例在别的机器上飘
const at = (h, m = 0) => new Date(2026, 7, 11, h, m, 0, 0).getTime();
const SEC = 1000;

const settings = (over = {}) => ({
  enabled: true, nightStart: '03:00', nightEnd: '08:00', minIntervalHours: 6, ...over,
});
const healthy = (windowResetsAt) => [
  { id: 't1', providerId: 'claude-agent', status: 'healthy', windowResetsAt },
];

test('parseHm 解析为当天分钟数', () => {
  assert.equal(parseHm('03:00'), 180);
  assert.equal(parseHm('08:30'), 510);
  assert.equal(parseHm('bad'), null);
});

test('功能未开启 → 不跑', () => {
  const r = shouldRun({ now: at(4), settings: settings({ enabled: false }), tokens: healthy(0), activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, false);
  assert.equal(r.reason, 'disabled');
});

test('有活跃 run → 绝不跑（不跟用户抢额度）', () => {
  const r = shouldRun({ now: at(4), settings: settings(), tokens: healthy(0), activeRunCount: 1, lastExtractAt: 0 });
  assert.equal(r.run, false);
  assert.equal(r.reason, 'busy');
});

test('距上次提炼不足最小间隔 → 冷却中', () => {
  const now = at(4);
  const r = shouldRun({ now, settings: settings(), tokens: healthy(0), activeRunCount: 0, lastExtractAt: now - 3600000 });
  assert.equal(r.run, false);
  assert.equal(r.reason, 'cooldown');
});

test('token 池全耗尽 → 不跑', () => {
  const tokens = [{ id: 't1', providerId: 'claude-agent', status: 'exhausted', resetsAt: 999 }];
  const r = shouldRun({ now: at(4), settings: settings(), tokens, activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, false);
  assert.equal(r.reason, 'exhausted');
});

test('窗口①：额度正常且距重置 <30 分钟 → 跑', () => {
  const now = at(14);
  const resetsAt = Math.floor((now + 20 * 60 * SEC) / 1000);
  const r = shouldRun({ now, settings: settings(), tokens: healthy(resetsAt), activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, true);
  assert.equal(r.window, 'window-end');
});

test('窗口①：距重置还有 2 小时且不在凌晨 → 不跑', () => {
  const now = at(14);
  const resetsAt = Math.floor((now + 120 * 60 * SEC) / 1000);
  const r = shouldRun({ now, settings: settings(), tokens: healthy(resetsAt), activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, false);
  assert.equal(r.reason, 'out-of-window');
});

test('窗口①：重置时刻已过（负数）不得误判为命中', () => {
  const now = at(14);
  const resetsAt = Math.floor((now - 10 * 60 * SEC) / 1000);
  const r = shouldRun({ now, settings: settings(), tokens: healthy(resetsAt), activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, false);
});

test('窗口②：凌晨窗口内即可跑，不依赖 windowResetsAt（降级路径）', () => {
  const r = shouldRun({ now: at(4), settings: settings(), tokens: healthy(null), activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, true);
  assert.equal(r.window, 'night');
});

test('窗口②：08:00 为开区间上界，08:30 不再跑', () => {
  const r = shouldRun({ now: at(8, 30), settings: settings(), tokens: healthy(null), activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, false);
});

test('凌晨窗口可跨零点配置（22:00-02:00）', () => {
  const s = settings({ nightStart: '22:00', nightEnd: '02:00' });
  assert.equal(shouldRun({ now: at(23), settings: s, tokens: healthy(null), activeRunCount: 0, lastExtractAt: 0 }).run, true);
  assert.equal(shouldRun({ now: at(1), settings: s, tokens: healthy(null), activeRunCount: 0, lastExtractAt: 0 }).run, true);
  assert.equal(shouldRun({ now: at(12), settings: s, tokens: healthy(null), activeRunCount: 0, lastExtractAt: 0 }).run, false);
});

// —— I1：跨 provider 混放的 token 池必须先按 providerId 过滤，不能拿别的号的窗口时刻做判断 ——
test('跨 provider：非目标 provider 的号处于窗口末尾，不得用它的重置时刻误判 claude-agent 该跑（I1）', () => {
  const now = at(14);
  const otherResetsAt = Math.floor((now + 20 * 60 * SEC) / 1000); // openai-compat 20 分钟后重置——落在窗口①
  const claudeResetsAt = Math.floor((now + 5 * 3600 * SEC) / 1000); // claude-agent 自己 5 小时后重置——不该跑
  const tokens = [
    { id: 'o1', providerId: 'openai-compat', status: 'healthy', windowResetsAt: otherResetsAt },
    { id: 'c1', providerId: 'claude-agent', status: 'healthy', windowResetsAt: claudeResetsAt },
  ];
  const r = shouldRun({ now, settings: settings(), tokens, activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, false, '不该被 openai-compat 的窗口末尾误判为该跑——提炼实际用的是 claude-agent 的号');
  assert.equal(r.reason, 'out-of-window');
});

// —— I2：warning 是 pickActive 语义里的「可用」状态，退而取之而非视为不可用 ——
test('目标 provider 的号处于 warning 且临近重置 → 仍应跑（I2：warning 是可用状态，与 pickActive 对齐）', () => {
  const now = at(14);
  const resetsAt = Math.floor((now + 10 * 60 * SEC) / 1000); // 10 分钟后重置，落在窗口①
  const tokens = [{ id: 'c1', providerId: 'claude-agent', status: 'warning', windowResetsAt: resetsAt }];
  const r = shouldRun({ now, settings: settings(), tokens, activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, true, 'warning 即将作废的额度正是窗口①设计意图里最该跑的时刻，不该被当成不可用');
  assert.equal(r.window, 'window-end');
});

// —— I3：耗尽判定必须分 provider，否则会放行到 claudeAuthOpts() 而无人值守地烧用户主账号额度 ——
test('目标 provider 已耗尽、但其它 provider 健康 → 不得跑（I3：耗尽判定要分 provider）', () => {
  const tokens = [
    { id: 'o1', providerId: 'openai-compat', status: 'healthy' },
    { id: 'c1', providerId: 'claude-agent', status: 'exhausted', resetsAt: 999 },
  ];
  const r = shouldRun({ now: at(4), settings: settings(), tokens, activeRunCount: 0, lastExtractAt: 0 });
  assert.equal(r.run, false, 'claude-agent 侧全 exhausted 时不能被 openai-compat 的健康状态掩盖');
  assert.equal(r.reason, 'exhausted');
});

// —— M6：lastExtractAt 落在未来（时钟回拨/落盘坏值）不该让冷却判定恒为真、功能静默死掉 ——
test('lastExtractAt 为未来时刻不应导致永久冷却（M6：minIntervalHours=0 时负数恒小于 0 会永远判定冷却）', () => {
  const now = at(4);
  const future = now + 3600000; // 比 now 还晚 1 小时——系统时钟回拨或落盘坏值的典型形态
  const s = settings({ minIntervalHours: 0 }); // 未设最小间隔：理应随时可跑，不该被负数 elapsed 卡死
  const r = shouldRun({ now, settings: s, tokens: healthy(null), activeRunCount: 0, lastExtractAt: future });
  assert.equal(r.run, true, 'now - lastExtractAt 为负数时不该被当成"刚提炼过"而永久卡在 cooldown');
  assert.equal(r.window, 'night');
});

// —— M3：纯函数不得修改入参，防止未来"优化"引入原地排序/回写之类的副作用（同 promote.test.js 末尾用例）——
test('shouldRun 不得修改传入的 tokens / settings（M3：纯函数调用方有权假设旧引用不被污染）', () => {
  const tokens = [
    { id: 'c1', providerId: 'claude-agent', status: 'warning', windowResetsAt: 100 },
    { id: 'c2', providerId: 'claude-agent', status: 'healthy', windowResetsAt: 200 },
  ];
  const tokensSnapshot = JSON.parse(JSON.stringify(tokens));
  const s = settings();
  const settingsSnapshot = JSON.parse(JSON.stringify(s));

  shouldRun({ now: at(14), settings: s, tokens, activeRunCount: 0, lastExtractAt: 0 });

  assert.deepEqual(tokens, tokensSnapshot, '调用后 tokens 内容不该被改动（例如排序、状态回写）');
  assert.deepEqual(s, settingsSnapshot, '调用后 settings 内容不该被改动');
});
