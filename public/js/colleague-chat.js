/**
 * 同事对话抽屉：右侧滑出，内含「列表页（谁有未读）→ 对话页（看消息 / 回消息）」两级。
 *
 * 为什么是抽屉而不是居中弹窗（2026-09-22 改）：这个面板的使用场景是**边看主会话边处理同事消息**
 * —— 后端发来接口文档、Claude 正在据此改代码，主机要对照着看。居中 modal 会把整个工作区盖住，
 * 每看一眼消息就得关掉再打开。抽屉只占右侧一条，主会话区始终可见可交互。
 *
 * 因此它是**非模态**的：没有全屏遮罩（遮罩会吃掉主会话区的点击），关闭只认 ✕ 与 Esc。
 * 外层 `.cc-drawer-host` 是个 `pointer-events:none` 的定位壳，纯粹为了复用 bindDialogDismiss 的
 * Esc 绑定与解绑幂等 —— 它收不到 click，所以「点外部关闭」自然不会发生，这正是抽屉要的语义。
 *
 * 两级页面共存于同一个抽屉、用 hidden 切换，而不是开第二个抽屉：同事与消息是「主从」关系，
 * 开两层抽屉既要处理层叠又要处理各自的 Esc 顺序，收益为零。
 *
 * 不塞进 req-assignee-dialog.js：那个管「指派谁」，这个管「跟谁聊」，两件事。
 * 合在一起就会变成一个文件管两种形态的面板，后续任何一边改动都要先读懂另一边。
 *
 * 依赖方向：colleague-chat → api.js / util.js / chat.js；由 req-chat 调用，不反向依赖。
 */
import { getJson, postJson } from './api.js';
import { renderMarkdown, isMarkdownPath, downloadFile } from './util.js';
import { DOWNLOAD_ICON_SVG } from './icons.js';
import { openMarkdownFile } from './chat.js';
import { bindDialogDismiss } from './dialog-dismiss.js';
import { messagesSignature } from './colleague-chat.logic.js';

const POLL_MS = 10_000; // 与需求右栏轮询同量级；飞书消息不是秒级场景

/** 同时只留一个抽屉：重复点「开发人员」不该叠出第二层 */
let openHost = null;

/**
 * 打开同事对话抽屉（落在列表页）。
 * @param {object} opts
 * @param {string} opts.reqId
 * @param {object[]} opts.assigneeList `/api/req/get` 的 assigneeList（含 unreadCount）
 * @param {Function} [opts.onChangeAssignees] 点「修改指派」时回调（交回 req-chat 开指派弹窗）
 */
export function openColleagueList({ reqId, assigneeList, onChangeAssignees }) {
  openHost?.remove();

  const host = document.createElement('div');
  host.className = 'cc-drawer-host';
  host.innerHTML =
    '<aside class="cc-drawer">' +
    '<div class="cc-drawer-head">' +
    '<button type="button" class="cc-back" hidden title="返回列表">←</button>' +
    '<h3 class="cc-drawer-title">开发人员</h3>' +
    '<button type="button" class="cc-close" title="关闭">✕</button>' +
    '</div>' +
    '<div class="cc-page cc-page-list">' +
    '<div class="cc-list"></div>' +
    '<div class="cc-drawer-foot"><button class="btn cc-edit">修改指派</button></div>' +
    '</div>' +
    '<div class="cc-page cc-page-chat" hidden>' +
    '<div class="cc-msgs"></div>' +
    '<div class="cc-compose">' +
    '<textarea class="cc-input" rows="2" placeholder="回复（Enter 发送 / Shift+Enter 换行）"></textarea>' +
    '<button class="btn primary cc-send">发送</button>' +
    '</div>' +
    '</div>' +
    '</aside>';
  document.body.appendChild(host);
  openHost = host;

  const listBox = host.querySelector('.cc-list');
  const pageList = host.querySelector('.cc-page-list');
  const pageChat = host.querySelector('.cc-page-chat');
  const backBtn = host.querySelector('.cc-back');
  const titleEl = host.querySelector('.cc-drawer-title');

  // 对话页的清理器。切回列表 / 关抽屉时都要调，否则轮询定时器会挂在已卸载的 DOM 上
  let disposeChat = null;

  const close = bindDialogDismiss(host, () => {
    disposeChat?.();
    host.remove();
    if (openHost === host) openHost = null;
  });
  host.querySelector('.cc-close').addEventListener('click', close);

  const showList = () => {
    disposeChat?.();
    disposeChat = null;
    pageChat.hidden = true;
    pageList.hidden = false;
    backBtn.hidden = true;
    titleEl.textContent = '开发人员';
  };
  backBtn.addEventListener('click', showList);

  host.querySelector('.cc-edit').addEventListener('click', () => {
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
        pageList.hidden = true;
        pageChat.hidden = false;
        backBtn.hidden = false;
        titleEl.textContent = a.roleLabel ? `${a.name}·${a.roleLabel}` : a.name;
        disposeChat = mountChatPage({ root: pageChat, reqId, colleague: a });
      });
    }
    listBox.appendChild(row);
  }
}

/**
 * 在抽屉的对话页上挂载单个同事的会话（拉取 + 轮询 + 发送）。
 * @returns {Function} dispose：停轮询并清空页面，切页与关抽屉都必须调
 */
function mountChatPage({ root, reqId, colleague }) {
  const msgsBox = root.querySelector('.cc-msgs');
  const input = root.querySelector('.cc-input');
  const sendBtn = root.querySelector('.cc-send');
  let timer = null;
  let lastSig = '';
  let loadSeq = 0;
  let disposed = false;

  msgsBox.innerHTML = '<div class="cc-tip">加载中…</div>';
  input.value = '';

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
        // 附件行 = 文件名（md 可点开查看器）+ 下载按钮。下载对所有类型都给：
        // 查看器只认 md，在此之前 json/yaml/图片这些附件在界面上是纯文本，拿不到手里
        const wrap = document.createElement('span');
        wrap.className = 'cc-file-row';
        const canOpen = isMarkdownPath(f.path);
        const fileEl = document.createElement(canOpen ? 'button' : 'span');
        fileEl.className = 'cc-file';
        fileEl.textContent = '📎 ' + (f.name || f.path);
        fileEl.title = canOpen ? `${f.path}\n点击在 Markdown 查看器中打开` : f.path;
        if (canOpen) {
          fileEl.type = 'button';
          fileEl.addEventListener('click', () => {
            if (!openMarkdownFile(f.path)) window.toast.error('Markdown 查看器未就绪，请刷新页面重试');
          });
        }
        wrap.appendChild(fileEl);
        const dl = document.createElement('button');
        dl.type = 'button';
        dl.className = 'cc-file-dl';
        dl.innerHTML = DOWNLOAD_ICON_SVG; // 常量是本模块内联的 SVG 字面量，非外部文本
        dl.title = '下载';
        dl.setAttribute('aria-label', `下载 ${f.name || f.path}`);
        dl.addEventListener('click', () => downloadFile(f.path, f.name || ''));
        wrap.appendChild(dl);
        row.appendChild(wrap);
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
      // disposed 也要判：用户切回列表后这次响应才到，paint 会往已经隐藏的页面里写一遍旧数据，
      // 下次进同一个同事的对话时 lastSig 已被重置、但 DOM 里挂着上一次的残留
      if (disposed || seq !== loadSeq) return;
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

  const onSend = () => send();
  const onKey = (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      send();
    }
    // Esc 交给抽屉整体关闭，这里不拦
  };
  sendBtn.addEventListener('click', onSend);
  input.addEventListener('keydown', onKey);

  // 打开即标已读；失败无所谓，下次打开再标
  postJson('/api/req/colleague-messages/read', { reqId, colleagueId: colleague.id }).catch(() => {});
  load();
  timer = setInterval(load, POLL_MS);
  input.focus();

  return () => {
    disposed = true;
    clearInterval(timer);
    sendBtn.removeEventListener('click', onSend);
    input.removeEventListener('keydown', onKey);
    msgsBox.innerHTML = '';
  };
}
