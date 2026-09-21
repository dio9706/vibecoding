/** 同事名册面板：按职位分组列出成员 / 新增 / 编辑 / 删除。
 *  副作用模块：自带「同事设置」tab 与表单按钮的入口绑定（范式对齐 bots-panel.js）。 */
import { $ } from './util.js';
import { toast, confirmDialog } from './ui.js';
import { iconHtml, DELETE_ICON_SVG, EDIT_ICON_SVG } from './icons.js';
import { getJson, postJson, putJson, delJson } from './api.js';
import { openImportDialog } from './colleagues-import.js';

let editingId = null; // 非空 = 编辑既有同事
let roles = []; // [{id,label}]，由 GET /api/colleagues 返回

async function loadColleagues() {
  try {
    const { data } = await getJson('/api/colleagues');
    roles = data?.roles || [];
    return data?.colleagues || [];
  } catch {
    toast('网络错误，无法加载同事名册');
    return [];
  }
}

/** 按职位分组。名册里出现的未知职位归到末尾「未知职位」组——
 *  静默隐藏会让用户以为数据丢了，显示出来他才能自己改。 */
function groupByRole(colleagues) {
  const known = new Set(roles.map((r) => r.id));
  const groups = roles.map((r) => ({ id: r.id, label: r.label, items: colleagues.filter((c) => c.role === r.id) }));
  const unknown = colleagues.filter((c) => !known.has(c.role));
  if (unknown.length) groups.push({ id: '', label: '未知职位', items: unknown });
  return groups;
}

export async function renderColleagues() {
  const colleagues = await loadColleagues();
  const box = $('#colleagueGroups');
  box.innerHTML = '';
  for (const g of groupByRole(colleagues)) {
    const sec = document.createElement('div');
    sec.className = 'set-sec';

    const head = document.createElement('div');
    head.className = 'set-sec-head';
    const label = document.createElement('span');
    label.className = 'sec-label';
    label.textContent = `${g.label}（${g.items.length}）`;
    head.appendChild(label);
    // 未知职位组不给「＋」：新增必须落到合法职位上
    if (g.id) {
      const add = document.createElement('button');
      add.className = 'btn';
      add.textContent = '＋ 新增';
      add.addEventListener('click', () => openForm(null, g.id));
      head.appendChild(add);
    }
    sec.appendChild(head);

    const list = document.createElement('div');
    list.className = 'token-list';
    if (!g.items.length) {
      const empty = document.createElement('div');
      empty.className = 'cred-empty';
      empty.textContent = '暂无成员';
      list.appendChild(empty);
    }
    for (const c of g.items) {
      list.appendChild(makeRow(c));
    }
    sec.appendChild(list);
    box.appendChild(sec);
  }
}

function makeRow(c) {
  const row = document.createElement('div');
  row.className = 'token-row';
  row.dataset.id = c.id;
  row.innerHTML =
    '<span class="t-label"></span>' +
    '<span class="t-vendor"></span>' +
    '<span class="t-base"></span>' +
    '<span class="spacer"></span>' +
    '<button class="t-act edit" title="编辑">' + iconHtml(EDIT_ICON_SVG) + '</button>' +
    '<button class="t-act del" title="删除">' + iconHtml(DELETE_ICON_SVG) + '</button>';
  // 姓名/备注是用户输入，一律 textContent 赋值，不拼进上面的 innerHTML
  row.querySelector('.t-label').textContent = c.name || '(未命名)';
  row.querySelector('.t-vendor').textContent = c.note || '';
  const idCell = row.querySelector('.t-base');
  idCell.textContent = c.feishuOpenId || '(未填飞书 ID)';
  idCell.title = c.feishuOpenId || '未填飞书 open_id，智能体无法主动询问该同事';
  row.querySelector('.edit').onclick = () => openForm(c, c.role);
  row.querySelector('.del').onclick = () => removeColleague(c);
  return row;
}

function openForm(colleague, roleId) {
  editingId = colleague ? colleague.id : null;
  $('#colleagueFormSec').hidden = false;
  $('#colleagueFormTitle').textContent = colleague ? `编辑「${colleague.name || '(未命名)'}」` : '新增同事';

  const sel = $('#colleagueRole');
  sel.innerHTML = '';
  for (const r of roles) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.label;
    sel.appendChild(opt);
  }
  sel.value = roleId || roles[0]?.id || '';

  $('#colleagueName').value = colleague?.name || '';
  $('#colleagueNote').value = colleague?.note || '';
  $('#colleagueOpenId').value = colleague?.feishuOpenId || '';
  $('#colleagueName').focus();
}

function closeForm() {
  editingId = null;
  $('#colleagueFormSec').hidden = true;
}

async function saveColleague() {
  const payload = {
    name: $('#colleagueName').value.trim(),
    role: $('#colleagueRole').value,
    note: $('#colleagueNote').value.trim(),
    feishuOpenId: $('#colleagueOpenId').value.trim(),
  };
  try {
    const url = editingId ? '/api/colleagues/' + encodeURIComponent(editingId) : '/api/colleagues';
    const { ok, data } = editingId ? await putJson(url, payload) : await postJson(url, payload);
    if (!ok) return toast(data?.error || '保存失败');
    toast('已保存');
    closeForm();
    await renderColleagues();
  } catch {
    toast('网络错误');
  }
}

async function removeColleague(c) {
  const ok = await confirmDialog({
    title: '删除同事',
    message: `确认删除「${c.name || '(未命名)'}」？已指派给他的需求会显示为「已移除的同事」。`,
    danger: true,
  });
  if (!ok) return;
  try {
    const { ok: httpOk, data } = await delJson('/api/colleagues/' + encodeURIComponent(c.id));
    if (!httpOk) return toast(data?.error || '删除失败');
    if (editingId === c.id) closeForm();
    toast('已删除');
    await renderColleagues();
  } catch {
    toast('网络错误');
  }
}

$('#colleagueSaveBtn')?.addEventListener('click', saveColleague);
$('#colleagueCancelBtn')?.addEventListener('click', closeForm);

// 从飞书群导入：roles 由本模块持有（renderColleagues 时已从 /api/colleagues 拿到），
// 传给弹窗复用，省掉一次重复请求
$('#colleagueImportBtn')?.addEventListener('click', async () => {
  if (!roles.length) await loadColleagues(); // 用户没点过 tab 直接点按钮的极端情况
  openImportDialog({ roles, onDone: () => renderColleagues() });
});

// 同事设置 tab 点击时加载名册（显式取元素，避免 id 隐式全局）
const colleagueTabBtn = [...$('#settingsTabs').querySelectorAll('button')].find((b) => b.dataset.tab === 'colleagues');
if (colleagueTabBtn) colleagueTabBtn.addEventListener('click', () => renderColleagues());
