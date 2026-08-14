/**
 * task-triage 纯逻辑（无副作用，可单测）：分组 / 排序 / 意图解析。
 * 意图解析走「关键词优先」，未命中返回 unknown 交由 feature 层用 Claude 兜底（省额度）。
 */

/**
 * 把待处理 Task 分为「已有方案(ready) / 分析中(analyzing)」两组。
 * 状态机（见 store/tasks.js）：new → confirmed → analyzing → analyzed → developing → done / rejected。
 * 归属判据：
 *  - ready     ：status==='analyzed' 且 analysis.suggestion 非空（真正拿到可执行方案）
 *  - analyzing ：new / confirmed / analyzing（尚未产出方案），以及 analyzed 但 suggestion 为空（需重分析）
 *  - 剔除      ：developing / done / rejected（已在流程中或已完结）；未知状态一律不纳入两组
 */
export function groupPending(tasks) {
  const ready = [];
  const analyzing = [];
  for (const t of tasks) {
    if (t.status === 'analyzed' && t.analysis?.suggestion) ready.push(t);
    else if (t.status === 'new' || t.status === 'confirmed' || t.status === 'analyzing')
      analyzing.push(t);
    else if (t.status === 'analyzed') analyzing.push(t); // analyzed 但方案为空 → 视为仍需分析
  }
  return { ready, analyzing };
}

/** bug 优先，同类按 createdAt 升序；返回新数组，不改入参 */
export function sortForTriage(ready) {
  return [...ready].sort((a, b) => {
    const ab = a.type === 'bug' ? 0 : 1;
    const bb = b.type === 'bug' ? 0 : 1;
    if (ab !== bb) return ab - bb;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

/**
 * 解析流程内动作。命中关键词返回 action；未命中返回 'unknown'。
 * @param {string} text
 * @param {{withNote?:boolean}} [opts] withNote=true 时返回 { action, note }
 */
export function parseAction(text, opts = {}) {
  const s = (text || '').trim();
  let action = 'unknown';
  if (/退出|结束|取消|停止|停$/.test(s)) action = 'exit';
  else if (/补充|修正|重新分析|不对|不太对/.test(s)) action = 'fix';
  else if (/跳过|下一个|skip|先不看/.test(s)) action = 'skip';
  // reject 需先于 start，且补上「不好/不行」等否定，避免「不好」因含单字「好」被误判为 start
  else if (/放弃|拒绝|不做|不用了|算了|不要|不好|不行/.test(s)) action = 'reject';
  // start 关键词：移除误命中面大的单字「干」（如「干嘛」）；「好」限定为句尾以防「好烦/不好」等
  else if (/开始|处理|好的|好$|可以|就这个|就它|ok|OK|^1$|确认/.test(s)) action = 'start';

  if (!opts.withNote) return action;
  let note = '';
  if (action === 'fix') {
    // 取「补充/修正」等词之后的正文（去掉前导标点）
    note = s.replace(/^.*?(补充|修正|重新分析|不对|不太对)[：:，,\s]*/, '').trim();
  }
  return { action, note };
}

/** 解析 listed 步的是否开始。yes/no/unknown */
export function parseYesNo(text) {
  const s = (text || '').trim();
  // 否定优先：以「不/别/甭」开头，或含明确取消/放弃语义，一律 no。
  // 这样「不行/不好/不太行」不会因含单字「行/好」被下面的 yes 分支误判。
  if (/^(不|别|甭)|取消|不了|先不|不用|放弃|no|停/.test(s)) return 'no';
  // yes：肯定动词/短语；「好」「行」限定为句尾或带肯定语气词（好的/好啊/行吧…），避免「好烦」误命中。
  // 「嗯」只在整句为纯「嗯/嗯嗯…」时算 yes，避免「嗯嗯天气」这类含无关正文的误判。
  if (/开始|可以|确认|继续|yes|ok|OK|^1$|^嗯+$|好(的|啊|呀|吧|呢|滴)?$|行(的|啊|吧|呢)?$/.test(s))
    return 'yes';
  return 'unknown';
}
