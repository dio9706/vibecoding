/**
 * 自动开发的**入队 API** —— 从 `auto-dev/index.js` 拆出来的零重依赖门面。
 *
 * ## 为什么必须单独一个文件
 *
 * 「队列模型：任务状态即队列」（见 `index.js` 文件头）——入队就是锁内把任务置 `queued`，
 * 只需要 `store/tasks.js`。而**执行**才需要 git 工作区、编译、飞书回发、Claude 调用。
 * 两件事的依赖面差了一个数量级，混在同一个文件里造成两个真实问题：
 *
 * ### 问题一：import 环（2026-09-04 实测检出两个）
 *
 * ```
 * task-ops → task-notify → auto-dev/index → task-ops     （三文件环）
 * task-notify ⇄ auto-dev/index                            （二文件环）
 * ```
 *
 * 环的成因是 `task-notify.js`（卡片通知模块）为了一个「点按钮 → 入队」的动作，
 * 不得不 import 整个 `auto-dev/index.js`，而后者又要 import `task-notify` 去发完成卡片。
 * ESM 环下顶层求值顺序不可预期——`src/app/CLAUDE.md` 记着这个项目已经为此吃过一次亏
 * （「ESM 循环 + 顶层 await 会死锁在模块图上」，那是 `signals.js` 被拆成零依赖叶子的原因）。
 *
 * 把入队 API 拆到这里，`task-notify` 只依赖本文件（叶子），环立刻消失。
 *
 * ### 问题二：依赖面被无谓放大
 *
 * 5 个引用方里有 4 个只要「入队」，却因此拖进了 git / compile / lark / shell / notify /
 * task-ops / task-notify 整条链。最刺眼的是 `entrypoints/web/routes-ops.js`——
 * 一个 HTTP 路由模块把整个自动开发管线拉进了自己的模块图。
 *
 * ## 纪律
 *
 * **本文件只允许依赖 `store/tasks.js`。** 一旦这里出现 git / 网络 / LLM 的 import，
 * 上面两个问题就会原样回来——那时请把新东西放进 `index.js`，而不是放宽这条纪律。
 */
import { getTask, updateTask } from '../../../store/tasks.js';

/**
 * owner 强行开始被评审质疑/拒绝的任务？
 *
 * 纯谓词，只读 task 字段。web 入口与飞书 triage 入口共用，保证判例记录口径一致
 * （两处各写一份条件必然分叉，而分叉的后果是同一个任务在两个入口下判定不同）。
 */
export function isOverrideStart(task) {
  return task.status === 'challenged' || ['ask', 'reject'].includes(task.review?.verdict);
}

/**
 * 请求自动开发（任意进程可调）：锁内置 `queued`，web 泵按序执行。
 *
 * 幂等：已在 `queued`/`developing` 的任务不重复入队——重复入队会让同一个任务
 * 被泵取两次，而泵在 git 工作区里改码，两次并发就是互相覆盖。
 */
export function requestAutoDevelop(taskId, event = '加入自动开发队列') {
  const task = getTask(taskId);
  if (!task) return null;
  if (task.status === 'queued' || task.status === 'developing') return task; // 已排队/执行中
  return updateTask(taskId, { status: 'queued', auto: true }, event);
}
