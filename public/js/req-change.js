/**
 * 需求变动弹框 —— 开发期右栏「⚡ 需求变动」入口。
 *
 * 解决的问题：开发中途需求变了，现在只能跟 Claude 反复对话描述，token 贵且没留痕。
 * 这里把它变成一次结构化提交：写清变了什么 → AI 先比对需求地图算出**命中哪些逻辑点** →
 * 用户决定「只改地图」还是「地图+代码一起改」。
 *
 * 依赖方向：req-change → chat.js（发消息）；不反向依赖 req-chat，由后者调用 openChangeDialog。
 */
import { sendMessageProgrammatically } from './chat.js';

const IMPACT_MIN_CHARS = 10; // 太短的描述预估不出东西，白跑一次 LLM
const IMPACT_DEBOUNCE_MS = 900;

/**
 * @param {object} opts
 * @param {string} opts.reqId
 * @param {boolean} opts.hasMap - 无地图时不做影响预估，也不提示（能力降级但不挡提交）
 * @param {boolean} opts.hasConv - 会话未就绪时禁掉「改代码」，避免消息静默丢失
 * @param {Function} [opts.onDone] - 提交成功后的回调（刷新右栏/时间线）
 */
export function openChangeDialog({ reqId, hasMap, hasConv, onDone }) {
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML =
    '<div class="modal rq-change-modal">' +
    '<div class="head"><h3>⚡ 需求变动</h3></div>' +
    '<div class="body">' +
    '<p class="rq-change-sub"></p>' +
    '<textarea class="rq-change-text" rows="6" placeholder="例：产品刚说导出范围要支持「全部筛选结果」，不能只导选中行；另外导出格式砍掉 CSV，只留 xlsx。"></textarea>' +
    '<div class="rq-impact" hidden></div>' +
    '<div class="rq-scope">' +
    '<button type="button" data-scope="both" class="on">同步改地图 + 改代码</button>' +
    '<button type="button" data-scope="map">只改地图，先不动代码</button>' +
    '</div>' +
    '</div>' +
    '<div class="confirm-foot">' +
    '<button class="btn cancel">取消</button>' +
    '<button class="btn primary ok">提交变动</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(mask);

  const ta = mask.querySelector('.rq-change-text');
  const impactBox = mask.querySelector('.rq-impact');
  const okBtn = mask.querySelector('.ok');
  const scopeBtns = [...mask.querySelectorAll('.rq-scope button')];
  mask.querySelector('.rq-change-sub').textContent = hasMap
    ? '描述这次变了什么。提交前会先比对需求地图，算出命中哪些逻辑点。'
    : '描述这次变了什么。当前需求还没有需求地图，本次只记录并转达给 Claude。';

  let scope = 'both';
  let hits = [];
  let impactToken = 0; // 竞态令牌：用户还在打字时旧请求回来了要丢弃
  let debounceTimer = null;
  let submitting = false;

  if (!hasConv) {
    // 会话没就绪时「改代码」这条路走不通（消息发不出去），直接锁到「只改地图」
    scope = 'map';
    scopeBtns.forEach((b) => {
      b.classList.toggle('on', b.dataset.scope === 'map');
      if (b.dataset.scope === 'both') {
        b.disabled = true;
        b.title = '会话未就绪，重新打开需求后可用';
      }
    });
  }

  const close = () => {
    clearTimeout(debounceTimer);
    impactToken++; // 让在途的预估响应作废
    document.removeEventListener('keydown', onKey);
    mask.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !submitting) close();
  };
  document.addEventListener('keydown', onKey);
  mask.addEventListener('mousedown', (e) => {
    if (e.target === mask && !submitting) close();
  });
  mask.querySelector('.cancel').addEventListener('click', () => !submitting && close());

  scopeBtns.forEach((b) =>
    b.addEventListener('click', () => {
      if (b.disabled) return;
      scope = b.dataset.scope;
      scopeBtns.forEach((x) => x.classList.toggle('on', x === b));
    }),
  );

  // —— 影响预估：停止输入 900ms 后拉一次 ——
  const renderImpact = (state, list) => {
    if (state === 'loading') {
      impactBox.hidden = false;
      impactBox.innerHTML = '<div class="rq-impact-title">正在比对需求地图…</div>';
      return;
    }
    if (state === 'empty') {
      impactBox.hidden = false;
      impactBox.innerHTML = '<div class="rq-impact-title rq-impact-none">没有命中已有逻辑点，将作为新增诉求处理</div>';
      return;
    }
    const SYM = { add: '＋', mod: '~', del: '－' };
    impactBox.hidden = false;
    impactBox.innerHTML =
      '<div class="rq-impact-title">AI 影响预估 · 命中需求地图 <b>' + list.length + '</b> 个逻辑点</div>' +
      '<div class="rq-impact-list"></div>';
    const listBox = impactBox.querySelector('.rq-impact-list');
    for (const h of list) {
      const row = document.createElement('div');
      row.className = 'rq-impact-item';
      const sym = document.createElement('i');
      sym.className = 'rq-sym rq-' + h.type;
      sym.textContent = SYM[h.type] || '~';
      const main = document.createElement('span');
      main.textContent = h.pageName + ' · ' + h.title;
      const why = document.createElement('em');
      why.textContent = h.why ? '（' + h.action + '：' + h.why + '）' : '（' + h.action + '）';
      row.append(sym, main, why);
      listBox.appendChild(row);
    }
  };

  const fetchImpact = async () => {
    const text = ta.value.trim();
    if (!hasMap || text.length < IMPACT_MIN_CHARS) {
      impactBox.hidden = true;
      hits = [];
      return;
    }
    const my = ++impactToken;
    renderImpact('loading');
    try {
      const r = await fetch('/api/req/change/impact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reqId, text }),
      });
      const d = await r.json().catch(() => ({}));
      if (my !== impactToken) return; // 用户又改了输入 / 弹框已关：丢弃
      hits = Array.isArray(d.hits) ? d.hits : [];
      renderImpact(hits.length ? 'list' : 'empty', hits);
    } catch {
      if (my !== impactToken) return;
      hits = [];
      impactBox.hidden = true; // 预估是锦上添花，失败就当没有，不打扰用户
    }
  };

  ta.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fetchImpact, IMPACT_DEBOUNCE_MS);
  });

  okBtn.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) {
      window.toast.error('先描述一下变了什么');
      ta.focus();
      return;
    }
    submitting = true;
    okBtn.disabled = true;
    okBtn.textContent = '提交中…';
    try {
      const r = await fetch('/api/req/change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: reqId, text, scope, hits }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '提交失败');
      // 先关弹框再发消息：sendMessageProgrammatically 会滚动聊天区，弹框还开着会挡住
      close();
      if (d.prompt) sendMessageProgrammatically(d.prompt, { mode: 'bypassPermissions' });
      window.toast.success(d.mapQueued ? '已提交 · 需求地图更新已入队' : '已提交');
      onDone?.();
    } catch (e) {
      window.toast.error('需求变动提交失败：' + (e?.message || e));
      submitting = false;
      okBtn.disabled = false;
      okBtn.textContent = '提交变动';
    }
  });

  setTimeout(() => ta.focus(), 50);
}
