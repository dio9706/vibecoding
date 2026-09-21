/**
 * 开发人员选人抽屉 —— 评审期「工程配置」卡与开发期右栏共用同一份实现。
 *
 * 为什么是浮层而不是常驻多选控件：开发期右栏（req-chat.js renderRail）每 3s 轮询时
 * 整栏 innerHTML='' 重画，常驻控件的勾选态会被反复冲掉。该文件已经为测试期 bitable
 * 输入框写过一处草稿保护，不该再添同类特例——浮层挂在 body 上，天然免疫重画。
 *
 * 容器与需求变动 / UI 规范统一为右侧抽屉（req-drawer.js）。注意本弹窗**两期都会开**：
 * 评审期走 panel-view、没有右栏，抽屉会自己贴到窗口右边缘（见 req-drawer.js railVisible）。
 *
 * 依赖方向：req-assignee-dialog → api.js；不反向依赖 req-view / req-chat，由后者调用。
 */
import { getJson, putJson } from './api.js';
import { openReqDrawer } from './req-drawer.js';

/**
 * @param {object} opts
 * @param {string} opts.reqId
 * @param {string[]} [opts.current] - 当前已指派的同事 id
 * @param {Function} [opts.onDone] - 保存成功后的回调（刷新页面 / 右栏）
 */
export async function openAssigneeDialog({ reqId, current = [], onDone }) {
  let roles = [];
  let colleagues = [];
  try {
    const { data } = await getJson('/api/colleagues');
    roles = data?.roles || [];
    colleagues = data?.colleagues || [];
  } catch {
    return window.toast.error('网络错误，无法加载同事名册');
  }

  const { root: drawer, close } = openReqDrawer({
    title: '选择开发人员',
    cls: 'rq-assignee-drawer',
    bodyHtml: '<div class="rq-assignee-groups"></div>',
    footHtml: '<button class="btn cancel">取消</button><button class="btn primary ok">保存</button>',
  });

  const groupsBox = drawer.querySelector('.rq-assignee-groups');
  const picked = new Set(current);

  if (!colleagues.length) {
    const tip = document.createElement('div');
    tip.className = 'rq-assignee-empty';
    tip.textContent = '还没有同事，请先到 设置 → 同事设置 添加。';
    groupsBox.appendChild(tip);
  }

  // 按职位分组；名册里的未知职位归到末尾，不静默隐藏（与设置页同一处置）
  const known = new Set(roles.map((r) => r.id));
  const groups = roles.map((r) => ({ label: r.label, items: colleagues.filter((c) => c.role === r.id) }));
  const unknown = colleagues.filter((c) => !known.has(c.role));
  if (unknown.length) groups.push({ label: '未知职位', items: unknown });

  for (const g of groups) {
    if (!g.items.length) continue;
    const sec = document.createElement('div');
    sec.className = 'rq-assignee-group';
    const h = document.createElement('b');
    h.textContent = g.label;
    sec.appendChild(h);
    for (const c of g.items) {
      const row = document.createElement('label');
      row.className = 'rq-assignee-row';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'pretty-check';
      chk.checked = picked.has(c.id);
      chk.addEventListener('change', () => (chk.checked ? picked.add(c.id) : picked.delete(c.id)));
      const name = document.createElement('span');
      name.className = 'nm';
      name.textContent = c.name || '(未命名)';
      const note = document.createElement('span');
      note.className = 'nt';
      // 没填 open_id 的人指派了也收不到智能体提问，这里先标出来，别等到发消息时静默失败
      note.textContent = c.feishuOpenId ? c.note || '' : '未填飞书 ID';
      row.append(chk, name, note);
      sec.appendChild(row);
    }
    groupsBox.appendChild(sec);
  }

  drawer.querySelector('.cancel').addEventListener('click', close);

  const okBtn = drawer.querySelector('.ok');
  okBtn.addEventListener('click', async () => {
    okBtn.disabled = true;
    try {
      const { ok, data } = await putJson('/api/req/assignees', { id: reqId, assignees: [...picked] });
      if (!ok) {
        okBtn.disabled = false;
        return window.toast.error(data?.error || '保存失败');
      }
      close();
      onDone?.();
    } catch {
      okBtn.disabled = false;
      window.toast.error('网络错误');
    }
  });
}
