/**
 * 侧栏「项目优化」卡片上的状态标签（体检中 / 修复中）。
 *
 * ## 为什么独立成一个模块
 *
 * 这块状态要在**面板关闭时**也保持正确 —— 体检跑十几分钟，用户多半会切走。
 * 而 `optimize-view.js` 已经上千行，且它的状态是围绕「面板打开着」组织的。
 * 拆开之后两者的职责很清楚：面板管面板，这里只管侧栏那一个小标签。
 *
 * ## 两条驱动路径
 *
 * 1. 面板开着 → `optimize-view.js` 在四个流开关处直接调 `setOptimizeBadge`，零延迟；
 * 2. 面板没开 / 刚刷新 → `probeOptimizeBadge` 探测一次 `/api/optimize/report` 的 busy，
 *    **只有探测到活跃任务时才开轮询**，任务结束立刻停。
 *
 * 不做常驻轮询：体检是低频操作（一天可能一次），给它挂一条永久心跳不值当。
 */

const POLL_MS = 30_000;

const LABEL = { checkup: '体检中', fix: '修复中' };

let timer = null;
let pollDir = '';
/**
 * 当前项目目录读取器，由 chat.js 经 `bindOptimizeBadgeCwd` 注入。
 *
 * 与 `bindOptimizeCwd` / `bindGitSelector` 同一范式：**惰性读**。
 * chat.js 的 `let cwd` 在模块顶层那几行绑定语句之后才初始化，
 * 直接取值会撞 TDZ（既有代码的注释里明写了这一点）。
 */
let _getCwd = () => '';

/** 注入当前项目目录读取器（chat.js 在 import 后立即调用） */
export function bindOptimizeBadgeCwd({ getCwd }) {
  _getCwd = getCwd || (() => '');
}

function node() {
  return document.getElementById('optToolTag');
}

/**
 * 直接设置标签。
 * @param {'checkup'|'fix'|''} kind 空串即摘掉标签
 */
export function setOptimizeBadge(kind) {
  const el = node();
  if (!el) return;
  const text = LABEL[kind] || '';
  el.textContent = text;
  el.hidden = !text;
}

function stopPoll() {
  if (timer) clearInterval(timer);
  timer = null;
  pollDir = '';
}

async function pollOnce(dir) {
  try {
    const r = await fetch(`/api/optimize/report?dir=${encodeURIComponent(dir)}`);
    const data = await r.json();
    const busy = data?.busy;
    // alive 为 false = 占用记录还在但任务已死（服务重启过），不该继续显示「体检中」
    if (busy?.alive && LABEL[busy.kind]) {
      setOptimizeBadge(busy.kind);
      return true;
    }
  } catch {
    // 网络抖动不该让标签乱跳，保持现状等下一轮
    return true;
  }
  setOptimizeBadge('');
  return false;
}

/**
 * 探测一次某项目的占用状态；有活跃任务就开轮询，没有就收手。
 *
 * 换目录时重复调用是安全的：旧轮询会先被停掉。
 */
export async function probeOptimizeBadge(dir) {
  stopPoll();
  setOptimizeBadge('');
  if (!dir) return;

  const running = await pollOnce(dir);
  if (!running) return;

  pollDir = dir;
  timer = setInterval(async () => {
    // 目录在轮询期间被换掉的话，这一轮的结果已经不作数了
    if (pollDir !== dir) return;
    const still = await pollOnce(dir);
    if (!still) stopPoll();
  }, POLL_MS);
}

/**
 * 按当前项目探测一次。给「展开工具列表」这类拿不到 cwd 的调用方用。
 *
 * 挂在工具列表展开的时机上，正好解决「刷新页面后标签不见了」——
 * 页面刷新会清掉内存里的 SSE 状态，而用户要看到这张卡片必然先展开工具列表，
 * 那一刻探测既及时又天然节流（不展开就不请求）。
 */
export function refreshOptimizeBadge() {
  return probeOptimizeBadge(_getCwd());
}
