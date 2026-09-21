/**
 * 「从飞书群导入同事」弹窗。
 *
 * 为什么走群成员而不是通讯录：`im/v1/chats/:id/members` 只要 `im:chat:readonly`，
 * 机器人在群里就能拉；而全量通讯录（contact/v3/users/find_by_department）除了 scope
 * 还要企业管理员在后台配「通讯录可见范围」，没配的话调用返回 200 但 items 为空——
 * 一个排查起来很费劲的静默失败。何况一个群通常就对应一个团队，正是要指派的那批人。
 *
 * 职位必须人工指定：群成员接口不返回职务，实测本租户 contact 的 job_title 也普遍为空。
 * 与其猜错（猜错的后果是智能体去问错的人），不如让用户点一下——所以提供了
 * 「批量设为某职位」，避免二十几个人逐个拉下拉框。
 *
 * 依赖方向：colleagues-import → api.js；由 colleagues-panel 调用，不反向依赖。
 */
import { toast } from './ui.js';
import { getJson, postJson } from './api.js';
import { bindDialogDismiss } from './dialog-dismiss.js';

/**
 * @param {object} opts
 * @param {{id:string,label:string}[]} opts.roles - 职位枚举（调用方已从 /api/colleagues 拿到，不重复请求）
 * @param {Function} [opts.onDone] - 导入成功后的回调（刷新名册）
 */
export async function openImportDialog({ roles, onDone }) {
  if (!roles?.length) return toast('职位枚举未就绪，请重新打开设置页');

  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML =
    '<div class="modal cl-import-modal">' +
    '<div class="head"><h3>从飞书群导入同事</h3></div>' +
    '<div class="body">' +
    '<div class="cl-import-pick">' +
    '<span class="cl-lb">飞书群</span>' +
    '<select class="cl-chat-sel set-select"><option value="">加载中…</option></select>' +
    '<div class="cl-import-meta"></div>' +
    '</div>' +
    '<div class="cl-import-tools" hidden>' +
    '<input type="text" class="cl-search" placeholder="搜索姓名…" autocomplete="off" />' +
    '<span class="cl-sp"></span>' +
    '<button type="button" class="cl-linkbtn cl-all">全选</button>' +
    '<button type="button" class="cl-linkbtn cl-none">全不选</button>' +
    '<select class="cl-bulk-role set-select sm"></select>' +
    '</div>' +
    '<div class="cl-import-list"><div class="cl-import-tip">请先选择一个群</div></div>' +
    '</div>' +
    '<div class="confirm-foot">' +
    '<span class="cl-import-count"></span>' +
    '<button class="btn cancel">取消</button>' +
    '<button class="btn primary ok" disabled>导入</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(mask);

  const chatSel = mask.querySelector('.cl-chat-sel');
  const metaEl = mask.querySelector('.cl-import-meta');
  const tools = mask.querySelector('.cl-import-tools');
  const searchEl = mask.querySelector('.cl-search');
  const bulkRole = mask.querySelector('.cl-bulk-role');
  const listBox = mask.querySelector('.cl-import-list');
  const okBtn = mask.querySelector('.ok');
  const countEl = mask.querySelector('.cl-import-count');

  const close = bindDialogDismiss(mask, () => mask.remove());
  mask.querySelector('.cancel').addEventListener('click', close);

  /**
   * 填充职位下拉。首项一律留空并强制显式选择：
   * 默认选中「运营」会让用户稀里糊涂把二十几个人全导成运营，而且界面上看不出异常。
   * 批量下拉同理——首项必须是「批量设职位…」而不是某个真实职位。
   */
  const fillRoles = (sel, blankText) => {
    sel.innerHTML = '';
    const o = document.createElement('option');
    o.value = '';
    o.textContent = blankText;
    sel.appendChild(o);
    for (const r of roles) {
      const op = document.createElement('option');
      op.value = r.id;
      op.textContent = r.label;
      sel.appendChild(op);
    }
  };
  fillRoles(bulkRole, '批量设职位…');

  // 当前群的成员行：[{ openId, name, exists, chk, roleSel }]
  let rows = [];

  const refreshFoot = () => {
    const picked = rows.filter((r) => r.chk.checked);
    const missingRole = picked.filter((r) => !r.roleSel.value).length;
    countEl.textContent = picked.length
      ? missingRole
        ? `已选 ${picked.length} 人 · ${missingRole} 人未选职位`
        : `已选 ${picked.length} 人`
      : '';
    okBtn.disabled = !picked.length || missingRole > 0;
    okBtn.textContent = picked.length ? `导入 ${picked.length} 人` : '导入';
  };

  async function loadMembers(chatId) {
    rows = [];
    tools.hidden = true;
    listBox.innerHTML = '<div class="cl-import-tip">加载成员中…</div>';
    refreshFoot();
    let members;
    try {
      const { ok, data } = await getJson('/api/colleagues/feishu/members?chatId=' + encodeURIComponent(chatId));
      if (!ok) {
        listBox.innerHTML = '';
        listBox.appendChild(tipEl(data?.error || '拉取群成员失败'));
        return;
      }
      members = data.members || [];
    } catch {
      listBox.innerHTML = '';
      listBox.appendChild(tipEl('网络错误'));
      return;
    }
    if (!members.length) {
      listBox.innerHTML = '';
      listBox.appendChild(tipEl('这个群里没有成员'));
      return;
    }

    // 已在名册的排到末尾：可操作的人集中在上方，不必在灰行之间来回跳
    const ordered = [...members.filter((m) => !m.exists), ...members.filter((m) => m.exists)];
    const existsCount = members.filter((m) => m.exists).length;
    metaEl.textContent = `共 ${members.length} 人 · 可导入 ${members.length - existsCount} 人`
      + (existsCount ? ` · ${existsCount} 人已在名册` : '');

    listBox.innerHTML = '';
    for (const m of ordered) {
      const row = document.createElement('label'); // label：点整行即可勾选，命中区域比 14px 的方框大得多
      row.className = 'cl-import-row' + (m.exists ? ' exists' : '');
      row.title = m.openId;

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'pretty-check';
      chk.disabled = m.exists; // 已在名册的不重复导入（后端也会按 open_id 兜底跳过）
      chk.addEventListener('change', refreshFoot);

      const name = document.createElement('span');
      name.className = 'nm';
      name.textContent = m.name;

      row.append(chk, name);

      if (m.exists) {
        // 已存在的不给职位下拉：一个永远禁用的空下拉只是噪音，22 行里有 8 个就更明显
        const tag = document.createElement('span');
        tag.className = 'tl';
        tag.textContent = '已在名册';
        row.appendChild(tag);
      } else {
        const roleSel = document.createElement('select');
        roleSel.className = 'set-select sm';
        fillRoles(roleSel, '选择职位');
        // 下拉自己吃掉点击：否则点它会冒泡到外层 label 把勾选状态翻掉
        roleSel.addEventListener('click', (ev) => ev.preventDefault());
        roleSel.addEventListener('change', () => {
          if (roleSel.value) chk.checked = true; // 选了职位显然是要导这个人，省一次点击
          refreshFoot();
        });
        row.appendChild(roleSel);
        rows.push({ openId: m.openId, name: m.name, chk, roleSel, row });
      }
      listBox.appendChild(row);
    }
    tools.hidden = rows.length === 0;
    searchEl.value = '';
    refreshFoot();
  }

  /** 姓名过滤：只改可见性，不重建行——重建会丢掉已勾选与已选职位 */
  function applySearch() {
    const q = searchEl.value.trim().toLowerCase();
    for (const r of rows) r.row.hidden = q ? !r.name.toLowerCase().includes(q) : false;
  }

  function tipEl(text) {
    const d = document.createElement('div');
    d.className = 'cl-import-tip';
    d.textContent = text;
    return d;
  }

  // 全选/全不选只作用于**搜索后可见**的行：搜了「张」再点全选却把隐藏的十几个人也选上，
  // 用户看不到自己选了谁，底部数字与眼前列表对不上
  const visibleRows = () => rows.filter((r) => !r.row.hidden);
  mask.querySelector('.cl-all').addEventListener('click', () => {
    visibleRows().forEach((r) => (r.chk.checked = true));
    refreshFoot();
  });
  mask.querySelector('.cl-none').addEventListener('click', () => {
    visibleRows().forEach((r) => (r.chk.checked = false));
    refreshFoot();
  });
  searchEl.addEventListener('input', applySearch);
  bulkRole.addEventListener('change', () => {
    if (!bulkRole.value) return; // 选回「批量设职位…」不该把大家的职位清空
    // 只改已勾选且可见的：没勾的人被顺手设了职位，用户下次勾上时会以为是自己选的
    visibleRows().filter((r) => r.chk.checked).forEach((r) => (r.roleSel.value = bulkRole.value));
    bulkRole.value = ''; // 复位成提示项，保持「这是一次动作」而非「一个当前状态」
    refreshFoot();
  });

  chatSel.addEventListener('change', () => {
    if (chatSel.value) loadMembers(chatSel.value);
  });

  okBtn.addEventListener('click', async () => {
    const payload = rows
      .filter((r) => r.chk.checked && r.roleSel.value)
      .map((r) => ({ role: r.roleSel.value, name: r.name, note: '', feishuOpenId: r.openId }));
    if (!payload.length) return;
    okBtn.disabled = true;
    try {
      const { ok, data } = await postJson('/api/colleagues/batch', { colleagues: payload });
      if (!ok) {
        okBtn.disabled = false;
        return toast(data?.error || '导入失败');
      }
      toast(data.skipped ? `已导入 ${data.added} 人（${data.skipped} 人已存在，跳过）` : `已导入 ${data.added} 人`);
      close();
      onDone?.();
    } catch {
      okBtn.disabled = false;
      toast('网络错误');
    }
  });

  // 群列表：弹窗一打开就拉，失败时把后端的指路文案原样显示（多半是没启用飞书机器人）
  try {
    const { ok, data } = await getJson('/api/colleagues/feishu/chats');
    if (!ok) {
      chatSel.innerHTML = '<option value="">加载失败</option>';
      listBox.innerHTML = '';
      listBox.appendChild(tipEl(data?.error || '拉取群列表失败'));
      return;
    }
    const chats = data.chats || [];
    chatSel.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = chats.length ? `选择群（共 ${chats.length} 个）` : '机器人未加入任何群';
    chatSel.appendChild(blank);
    for (const c of chats) {
      const o = document.createElement('option');
      o.value = c.chatId;
      o.textContent = c.name;
      chatSel.appendChild(o);
    }
  } catch {
    chatSel.innerHTML = '<option value="">加载失败</option>';
    listBox.innerHTML = '';
    listBox.appendChild(tipEl('网络错误'));
  }
}
