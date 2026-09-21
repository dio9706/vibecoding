/**
 * 同事对话：列表弹窗（谁有未读）→ 对话面板（看消息 / 回消息）。
 *
 * 不塞进 req-assignee-dialog.js：那个管「指派谁」，这个管「跟谁聊」，两件事。
 * 合在一起就会变成一个文件管两种形态的弹窗，后续任何一边改动都要先读懂另一边。
 *
 * 依赖方向：colleague-chat → api.js / util.js / chat.js；由 req-chat 调用，不反向依赖。
 */
import { getJson, postJson } from './api.js';
import { renderMarkdown, isMarkdownPath } from './util.js';
import { openMarkdownFile } from './chat.js';
import { bindDialogDismiss } from './dialog-dismiss.js';
import { messagesSignature } from './colleague-chat.logic.js';

const POLL_MS = 10_000; // 与需求右栏轮询同量级；飞书消息不是秒级场景

/**
 * 对话列表弹窗。
 * @param {object} opts
 * @param {string} opts.reqId
 * @param {object[]} opts.assigneeList `/api/req/get` 的 assigneeList（含 unreadCount）
 * @param {Function} [opts.onChangeAssignees] 点「修改指派」时回调（交回 req-chat 开指派弹窗）
 */
export function openColleagueList({ reqId, assigneeList, onChangeAssignees }) {
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML =
    '<div class="modal cc-list-modal">' +
    '<div class="head"><h3>开发人员</h3></div>' +
    '<div class="body"><div class="cc-list"></div></div>' +
    '<div class="confirm-foot">' +
    '<button class="btn cc-edit">修改指派</button>' +
    '<button class="btn cancel">关闭</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(mask);

  const listBox = mask.querySelector('.cc-list');
  const close = bindDialogDismiss(mask, () => mask.remove());
  mask.querySelector('.cancel').addEventListener('click', close);
  mask.querySelector('.cc-edit').addEventListener('click', () => {
    close();
    onChangeAssignees?.();
  });

  const list = Array.isArray(assigneeList) ? assigneeList : [];
  if (!list.length) {
    const tip = document.createElement('div');
    tip.className = 'cc-tip';
    tip.textContent = '还没有指派开发人员。';
    listBox.appendChild(tip);
  }
  for (const a of list) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cc-row' + (a.missing ? ' missing' : '');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = a.roleLabel ? `${a.name}·${a.roleLabel}` : a.name;
    row.appendChild(nm);
    if (a.unreadCount > 0) {
      const dot = document.createElement('span');
      dot.className = 'cc-badge';
      dot.textContent = a.unreadCount > 99 ? '99+' : String(a.unreadCount);
      row.appendChild(dot);
    }
    if (a.missing) {
      const t = document.createElement('span');
      t.className = 'tl';
      t.textContent = '已移除';
      row.appendChild(t);
      row.disabled = true;
    } else if (!a.feishuOpenId) {
      // 没号的人收发都不成立，直接禁掉并说明原因，免得点进去发现发不出去
      const t = document.createElement('span');
      t.className = 'tl';
      t.textContent = '未填飞书 ID';
      row.appendChild(t);
      row.disabled = true;
      row.title = '未填飞书 open_id，无法收发消息';
    } else {
      row.addEventListener('click', () => {
        close();
        openColleagueChat({ reqId, colleague: a });
      });
    }
    listBox.appendChild(row);
  }
}

/** 单个同事的对话面板 */
export function openColleagueChat({ reqId, colleague }) {
  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML =
    '<div class="modal cc-chat-modal">' +
    '<div class="head"><h3></h3></div>' +
    '<div class="body"><div class="cc-msgs"><div class="cc-tip">加载中…</div></div></div>' +
    '<div class="cc-compose">' +
    '<textarea class="cc-input" rows="2" placeholder="回复（Enter 发送 / Shift+Enter 换行）"></textarea>' +
    '<button class="btn primary cc-send">发送</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(mask);
  mask.querySelector('.head h3').textContent = colleague.roleLabel
    ? `${colleague.name}·${colleague.roleLabel}`
    : colleague.name;

  const msgsBox = mask.querySelector('.cc-msgs');
  const input = mask.querySelector('.cc-input');
  const sendBtn = mask.querySelector('.cc-send');
  let timer = null;
  let lastSig = '';
  let loadSeq = 0;

  const close = bindDialogDismiss(mask, () => {
    clearInterval(timer);
    mask.remove();
  });

  function paint(messages) {
    // 只在内容变化时重绘：每 10s 无脑重绘会打断用户正在选中的文本
    //（req-chat 的右栏已为同类问题写过草稿保护，这里从一开始就避开）
    // 判据是指纹而非条数 —— 满 MAX_MESSAGES 后条数恒定，按条数会永久停更（见 logic 注释）
    const sig = messagesSignature(messages);
    if (sig === lastSig) return;
    lastSig = sig;
    const atBottom = msgsBox.scrollHeight - msgsBox.scrollTop - msgsBox.clientHeight < 40;
    msgsBox.innerHTML = '';
    if (!messages.length) {
      const tip = document.createElement('div');
      tip.className = 'cc-tip';
      tip.textContent = '还没有消息。可以在下面主动发一条。';
      msgsBox.appendChild(tip);
      return;
    }
    for (const m of messages) {
      const row = document.createElement('div');
      row.className = 'cc-msg ' + (m.dir === 'out' ? 'out' : 'in');
      if (m.text) {
        const body = document.createElement('div');
        body.className = 'cc-body';
        // 同事发来的是外部文本，必须走带消毒的 renderMarkdown（它直接写入元素，不返回字符串）
        renderMarkdown(body, m.text);
        row.appendChild(body);
      }
      for (const f of m.files || []) {
        const canOpen = isMarkdownPath(f.path);
        const fileEl = document.createElement(canOpen ? 'button' : 'span');
        fileEl.className = 'cc-file';
        fileEl.textContent = '📎 ' + (f.name || f.path);
        fileEl.title = f.path;
        if (canOpen) {
          fileEl.type = 'button';
          fileEl.addEventListener('click', () => {
            if (!openMarkdownFile(f.path)) window.toast.error('Markdown 查看器未就绪，请刷新页面重试');
          });
        }
        row.appendChild(fileEl);
      }
      const t = document.createElement('div');
      t.className = 'cc-at';
      t.textContent = new Date(m.at).toLocaleString('zh-CN', { hour12: false });
      row.appendChild(t);
      msgsBox.appendChild(row);
    }
    if (atBottom) msgsBox.scrollTop = msgsBox.scrollHeight;
  }

  async function load() {
    // 轮询与「发完就拉」会并发。没有这道序号闸时：send 那次先回（带新消息），
    // 轮询那次后回（旧快照），指纹不同就把界面重绘回旧数据 ——
    // 用户看到的是「刚发出去的消息闪一下就没了」，要等下一轮才回来。
    const seq = ++loadSeq;
    try {
      const { ok, data } = await getJson(
        `/api/req/colleague-messages?reqId=${encodeURIComponent(reqId)}&colleagueId=${encodeURIComponent(colleague.id)}`,
      );
      if (seq !== loadSeq) return; // 已有更晚发出的请求，本次结果作废
      if (ok) paint(data.messages || []);
    } catch {
      /* 轮询期的网络抖动不打扰用户，下一轮自愈 */
    }
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    try {
      const { ok, data } = await postJson('/api/req/colleague-messages/send', {
        reqId,
        colleagueId: colleague.id,
        text,
      });
      if (!ok) return window.toast.error(data?.error || '发送失败');
      input.value = '';
      lastSig = ''; // 强制重绘，让刚发的消息立刻出现
      await load();
    } catch {
      window.toast.error('网络错误');
    } finally {
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      send();
    }
  });

  // 打开即标已读；失败无所谓，下次打开再标
  postJson('/api/req/colleague-messages/read', { reqId, colleagueId: colleague.id }).catch(() => {});
  load();
  timer = setInterval(load, POLL_MS);
  input.focus();
}
