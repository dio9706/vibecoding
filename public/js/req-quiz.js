/**
 * 评审期不确定点问卷 —— 生成开发文档的前置闸，就地渲染在主栏。
 *
 * 本模块只做三件事：发起出题、渲染问卷面板、提交答案。**轮询与状态归 req-view 管**——
 * 早先这里自己拿一套 2s 轮询等出题，与 req-view 的 3s busy 轮询并存，且带 2 分钟超时：
 * 一超时就把「还在后台跑的 quizgen」误判成「没找出歧义」，静默丢掉问卷、转头去发 docgen，
 * 而那一刻后端 busy 还没清，docgen 又被 409 挡回来——用户看到的就是转两分钟后一切照旧。
 * 现在没有超时，出题结束由 busy 的下降沿判定，只此一条判据。
 *
 * 必答规则：每题都要选，未选时「下一题」禁用。逃生口不是整体跳过（那会让必答形同
 * 虚设），而是每题末尾的「不确定」—— 用户至少被迫看过一遍这些点，而看一遍本身就
 * 常常触发「哦这个不对」。选「不确定」时自动展开补充框，那是唯一能从「不知道」里
 * 榨出信息的时刻。
 */

/**
 * 「不确定」的保留值，必须与 src/entrypoints/web/req-quiz.logic.js 的 UNSURE_VALUE
 * 一致。前后端分文件不能共享常量，此处漂移会被路由层的选项白名单挡成 400（而不是
 * 静默错答），改动时两边一起改。
 */
const UNSURE_VALUE = '__unsure__';


// ---- 模块态：面板是单例，答案要跨翻页保留 ----
let answers = {}; // { [qid]: { v, note } }
let noteOpen = {}; // { [qid]: boolean }；展开态单独记，翻页回来不丢
let idx = 0;
let panelHost = null; // 当前挂载的面板根节点，翻页/选答后就地重绘用
// 只在「刚展开补充框」那一次抢焦点。paint 每次都重建 textarea，若无条件 focus，
// 用户点选项触发的重绘会把焦点从选项区抢到输入框里。
let focusNote = false;

/** 每次进入问卷重置游标与答案（换需求 / 重新出题都要从头来）。 */
export function resetQuizState() {
  answers = {};
  noteOpen = {};
  idx = 0;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** 已答题数（选了实质项或「不确定」都算）。 */
function answeredCount(questions) {
  return questions.filter((q) => answers[q.id]?.v).length;
}

// ══════════════════════════════════════════════════════════════════════════
// 主入口
// ══════════════════════════════════════════════════════════════════════════

/**
 * 「生成开发文档」的入口：决定走哪条岔路并发起，**不等结果**。
 *
 * 三条岔路（省额度是刻意的：quizgen 每次都要通读需求文档）：
 * - quiz.status==='answered' 且非强制重答 → 结论还在，直接 docgen，不重问
 * - quiz.status==='ready'                → 上次出了题没答完，复用已出的题
 * - 无 quiz / 强制重答                    → 真正发起一次 quizgen
 *
 * 第三条发起后就交给 req-view：busy 一落，它的 3s 轮询接管；出题结束时由 busy 的下降沿
 * 决定「开面板」还是「无歧义降级」。本函数不再自己等，也就不存在超时误判。
 *
 * @param {object} opts
 * @param {object} opts.req 当前需求记录
 * @param {Function} opts.onRefresh 刷新需求页
 * @param {Function} opts.onOpenPanel 占住主栏的问卷面板（题目就绪后才真正渲染出来）
 * @param {boolean} [opts.forceNewQuiz] 「重答」入口传 true，强制重新出题
 * @returns {Promise<{failed?: boolean}|void>} failed=true 表示出题没起来，调用方需收回面板
 */
export async function startGenerateFlow({ req, onRefresh, onOpenPanel, forceNewQuiz = false }) {
  const status = req.quiz?.status;
  const hasQuestions = !!req.quiz?.questions?.length;

  if (!forceNewQuiz && status === 'answered' && hasQuestions) {
    return runDocgenDirect(req.id, onRefresh, '沿用上次问卷结论，开始生成');
  }

  resetQuizState();
  if (!forceNewQuiz && status === 'ready' && hasQuestions) return void onOpenPanel?.();

  // 先占面板再发请求：此刻还没有题，主栏仍是配置卡 + 顶部 busy 条（生成中的观感不变），
  // 占位是为了让出题结束那一刻的下降沿知道「这一轮是用户主动发起的」。
  onOpenPanel?.();
  const started = await postJson('/api/req/quiz', { id: req.id });
  if (started.status !== 202) {
    // 出题都没起来（配置不全 / 已有任务在跑），如实说明，不静默降级：
    // 这类失败用户改配置就能解决，替他跳过反而藏了问题
    window.toast.error(started.data?.error || '问卷生成失败');
    return { failed: true };
  }
  onRefresh?.(); // 立刻刷新，让 busy 态与轮询就位，而不是停在点击前的旧画面上
}

/** 跳过问卷直接 docgen（仅用于降级与"结论已在"两条路径，界面上没有这个按钮）。 */
export async function runDocgenDirect(id, onRefresh, okMsg) {
  const r = await postJson('/api/req/docgen', { id });
  if (r.status === 202) {
    window.toast.success(okMsg);
    onRefresh?.();
    return;
  }
  window.toast.error(r.data?.error || '生成失败');
}

async function postJson(url, body) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch {
    return { status: 0, data: { error: '网络错误' } };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 面板（主栏内联）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 建问卷面板并返回根节点，由 req-view 挂进主栏、取代配置卡的位置。
 *
 * @param {object} req 当前需求记录（题目取自 req.quiz.questions）
 * @param {{onClose: Function, onRefresh: Function}} ctx onClose 收回面板，onRefresh 刷新需求页
 */
export function renderQuizPanel(req, ctx) {
  const questions = req.quiz?.questions || [];
  if (idx >= questions.length) idx = 0; // 换了一份题目时游标可能越界
  panelHost = el('div', 'rqw-quiz');
  paint(req, questions, ctx);
  return panelHost;
}

/** 取消 = 放弃本次生成。不提供「跳过问卷继续生成」，否则必答形同虚设。 */
function cancel(ctx) {
  // 题目已经出好了（存在 store 里），下次点生成会复用，不会白花一次额度
  panelHost = null;
  ctx?.onClose?.();
}

function paint(req, questions, ctx) {
  if (!panelHost) return;
  panelHost.innerHTML = '';

  const total = questions?.length || 0;
  const done = questions ? answeredCount(questions) : 0;

  // ---- 头 ----
  const head = el('div', 'rqw-mhead');
  head.appendChild(el('span', 't', '生成前确认'));
  head.appendChild(el('span', 's', `不确定点 · 共 ${total} 题`));
  head.appendChild(el('span', 'gap'));
  const closeBtn = el('button', 'rqw-mclose', '取消');
  closeBtn.type = 'button';
  closeBtn.title = '放弃本次生成，题目会保留，下次点生成可继续作答';
  closeBtn.onclick = () => cancel(ctx);
  head.appendChild(closeBtn);
  panelHost.appendChild(head);

  const body = el('div', 'rqw-mbody');
  panelHost.appendChild(body);

  // 没有等待态分支：出题期间主栏仍是配置卡 + 顶部 busy 条，本面板只在题目就绪后才被挂上
  const q = questions[idx];
  const a = answers[q.id] || {};
  const unsure = a.v === UNSURE_VALUE;

  // ---- 进度分段：已答绿 / 不确定紫 / 当前橙 ----
  const segs = el('div', 'rqw-qsegs');
  questions.forEach((item, i) => {
    const v = answers[item.id]?.v;
    const cls = i === idx ? 'cur' : v === UNSURE_VALUE ? 'unsure' : v ? 'answered' : '';
    segs.appendChild(el('div', 'rqw-qseg ' + cls));
  });
  body.appendChild(segs);

  const meta = el('div', 'rqw-qmeta');
  meta.appendChild(el('span', null, `第 ${idx + 1} / ${total} 题`));
  meta.appendChild(el('span', 'why', q.why || ''));
  body.appendChild(meta);

  body.appendChild(el('div', 'rqw-qt', q.title));
  if (q.hint) body.appendChild(el('div', 'rqw-qh', q.hint));

  // ---- 选项 ----
  for (const o of q.opts) {
    const btn = el('button', 'rqw-qopt' + (a.v === o.v ? ' on' : ''));
    btn.type = 'button';
    btn.appendChild(el('span', 'rqw-qdot'));
    const tx = el('span', 'rqw-qtx');
    const lab = el('span', 'rqw-qlab', o.lab);
    if (o.guess) lab.appendChild(el('span', 'rqw-guess', '模型倾向'));
    tx.appendChild(lab);
    if (o.desc) tx.appendChild(el('span', 'rqw-qdesc', o.desc));
    btn.appendChild(tx);
    btn.onclick = () => {
      answers[q.id] = { v: o.v, note: answers[q.id]?.note || '' };
      paint(req, questions, ctx);
    };
    body.appendChild(btn);
  }

  // ---- 「不确定」：必答规则下的唯一逃生口 ----
  const uBtn = el('button', 'rqw-qopt unsure' + (unsure ? ' on' : ''));
  uBtn.type = 'button';
  uBtn.appendChild(el('span', 'rqw-qdot'));
  const uTx = el('span', 'rqw-qtx');
  uTx.appendChild(el('span', 'rqw-qlab', '不确定 / 我也不知道'));
  uTx.appendChild(el('span', 'rqw-qdesc', '这题交给模型判断，不影响生成。'));
  uBtn.appendChild(uTx);
  uBtn.onclick = () => {
    const wasOpen = !!noteOpen[q.id];
    answers[q.id] = { v: UNSURE_VALUE, note: answers[q.id]?.note || '' };
    noteOpen[q.id] = true; // 选不确定时自动展开：唯一能从「不知道」里榨出信息的时刻
    focusNote = !wasOpen; // 已经展开着就别再抢焦点
    paint(req, questions, ctx);
  };
  body.appendChild(uBtn);

  // ---- 选「不确定」时摊开模型的默认判断（最后一次纠正机会）----
  const guess = q.opts.find((o) => o.guess);
  if (unsure && guess) {
    const fb = el('div', 'rqw-fallback');
    fb.appendChild(document.createTextNode('模型将按 '));
    fb.appendChild(el('b', null, `「${guess.lab}」`));
    fb.appendChild(document.createTextNode(' 处理。'));
    fb.appendChild(document.createElement('br'));
    fb.appendChild(document.createTextNode('如果这不是你想要的，现在改还来得及。'));
    body.appendChild(fb);
  }

  // ---- 每题补充说明：选项穷举不完，「选 A 但有个前提」只能靠自由文本承载 ----
  const noteLen = (a.note || '').trim().length;
  const open = !!noteOpen[q.id];
  const tog = el('button', 'rqw-note-tog');
  tog.type = 'button';
  if (open) {
    tog.textContent = '收起补充说明 ▴';
  } else if (noteLen) {
    // 收起态也要显性提示字数，否则用户会以为自己写的丢了
    tog.appendChild(document.createTextNode('＋ 补充说明 '));
    tog.appendChild(el('span', 'cnt', `已写 ${noteLen} 字`));
    tog.appendChild(document.createTextNode(' ▾'));
  } else {
    tog.textContent = '＋ 补充说明（可选）';
  }
  tog.onclick = () => {
    noteOpen[q.id] = !open;
    focusNote = !open;
    paint(req, questions, ctx);
  };
  body.appendChild(tog);

  if (open) {
    const nbox = el('div', 'rqw-note-box' + (unsure ? ' urge' : ''));
    const nta = el('textarea', 'rqw-note-ta');
    nta.value = a.note || '';
    nta.placeholder = unsure
      ? '能说两句你的顾虑吗？哪怕不完整也有帮助 —— 比如「得问下设计」「跟旧版逻辑有关，我不确定当时为什么那么做」。'
      : '这题还有什么前提或例外？比如「选这个，但列表页不要跟着改」。';
    // 实时写回，不等失焦：翻页与重绘都会带走输入
    nta.addEventListener('input', () => {
      answers[q.id] = { v: answers[q.id]?.v || '', note: nta.value };
    });
    nbox.appendChild(nta);
    nbox.appendChild(
      el(
        'div',
        'rqw-note-hint',
        unsure
          ? '写了这里，模型会带着你的顾虑去判断，而不是纯靠默认值。'
          : '选项之外的前提、例外、边界都写在这里，会一并进开发文档。',
      ),
    );
    body.appendChild(nbox);
    if (focusNote) {
      focusNote = false;
      nta.focus();
    }
  }

  // ---- 脚 ----
  const foot = el('div', 'rqw-mfoot');
  const prev = el('button', 'rqw-btn sm', '← 上一题');
  prev.type = 'button';
  prev.disabled = idx === 0;
  prev.onclick = () => {
    idx--;
    paint(req, questions, ctx);
  };
  foot.appendChild(prev);
  foot.appendChild(el('span', 'gap'));

  const answered = !!a.v;
  const left = total - done;
  const req_ = el('span', 'req' + (answered ? '' : ' blocked'));
  req_.textContent = answered ? (left ? `还有 ${left} 题未答` : '全部已答') : '本题必答';
  foot.appendChild(req_);

  const isLast = idx === total - 1;
  const next = el('button', 'rqw-btn primary sm', isLast ? '开始生成 →' : '下一题 →');
  next.type = 'button';
  next.disabled = !answered;
  next.onclick = () => {
    if (!answers[q.id]?.v) return;
    if (!isLast) {
      idx++;
      paint(req, questions, ctx);
      return;
    }
    // 最后一题也可能有前面漏答的（用户用「上一题」跳着答），跳到第一个未答处
    const miss = questions.findIndex((x) => !answers[x.id]?.v);
    if (miss >= 0) {
      idx = miss;
      window.toast.error('还有题目未作答，不确定的可以选「不确定」');
      paint(req, questions, ctx);
      return;
    }
    submit(req, questions, ctx, next);
  };
  foot.appendChild(next);
  panelHost.appendChild(foot);
}

async function submit(req, questions, ctx, btn) {
  btn.disabled = true;
  btn.textContent = '提交中…';
  // 只提交问卷里真实存在的题，且必须带 v —— 与路由层的必答校验对齐，
  // 少传一题会被回 400，不如在这里就保证形状正确
  const payload = {};
  for (const q of questions) {
    const a = answers[q.id];
    if (a?.v) payload[q.id] = { v: a.v, note: (a.note || '').trim() };
  }
  try {
    const r = await fetch('/api/req/quiz', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: req.id, answers: payload }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status !== 202) throw new Error(d.error || '提交失败');
    resetQuizState();
    panelHost = null;
    window.toast.success('已提交 · 正在生成开发文档');
    // onClose 收回面板，主栏回到配置卡 + busy 条；docgen 的进度由 req-view 的轮询接管
    ctx?.onClose?.();
  } catch (e) {
    window.toast.error('问卷提交失败：' + (e?.message || e));
    btn.disabled = false;
    btn.textContent = '开始生成 →';
  }
}
