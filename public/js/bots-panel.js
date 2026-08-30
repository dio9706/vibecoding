/** 机器人面板：列表 / 启用互斥 / 编辑表单（凭证+角色描述+文案）/ 删除（级联删动作）。
 *  副作用模块：自带托管配置 tab 与新增/保存/取消按钮的入口绑定。 */
import { $ } from './util.js';
import { toast, confirmDialog } from './ui.js';
import { setActionsBot } from './actions-panel.js';
import { iconHtml, DELETE_ICON_SVG, EDIT_ICON_SVG } from './icons.js';
import { getJson, postJson, putJson, delJson } from './api.js';

let editingId = null; // 非空 = 编辑既有机器人
let messagesMeta = []; // 可配文案元数据 [{key,label,defaultText}]（GET /api/bots 返回）

// 托管程度：滑块档位 ↔ 枚举值（与后端 AUTONOMY_LEVELS 对齐）
const AUTONOMY = ['light', 'medium', 'full'];
const AUTONOMY_HINTS = {
  light: '轻度托管：脚本动作 + 需求/故障收集与分析，开发需人工确认',
  medium: '中度托管：需求/故障先过 AI 评审；BUG 自动修复（独立分支），需求出方案后等你确认；合并主分支需确认',
  full: '完全托管：评审通过的需求也自动开发；未命中的消息基于工程只读问答；合并主分支仍需确认',
};

function paintAutonomyHint() {
  const level = AUTONOMY[Number($('#botAutonomy').value)] || 'light';
  $('#botAutonomyHint').textContent = AUTONOMY_HINTS[level];
}

async function loadBots() {
  try {
    const { data } = await getJson('/api/bots');
    messagesMeta = data?.messagesMeta || [];
    return data?.bots || [];
  } catch {
    return [];
  }
}

export async function renderBotList() {
  const bots = await loadBots();
  const box = $('#botList');
  box.innerHTML = '';
  if (!bots.length) {
    box.innerHTML = '<div class="cred-empty">暂无机器人，点击「＋ 新增机器人」创建</div>';
    return;
  }
  bots.forEach((b) => {
    const row = document.createElement('div');
    row.className = 'token-row' + (b.enabled ? '' : ' mcp-off');
    row.dataset.id = b.id;
    row.innerHTML =
      '<input type="checkbox" class="pretty-check" title="启用（同时只有一个机器人生效）" />' +
      '<span class="t-label"></span>' +
      '<span class="t-vendor">飞书</span>' +
      '<span class="t-base bot-appid"></span>' +
      '<span class="spacer"></span>' +
      '<button class="t-act edit" title="编辑">' + iconHtml(EDIT_ICON_SVG) + '</button>' +
      '<button class="t-act del" title="删除">' + iconHtml(DELETE_ICON_SVG) + '</button>';
    row.querySelector('.t-label').textContent = b.name || '(未命名)';
    row.querySelector('.bot-appid').textContent = b.appId || '(未配置凭证)';
    const chk = row.querySelector('.pretty-check');
    chk.checked = b.enabled;
    chk.onchange = () => toggleBot(b.id, chk.checked);
    row.querySelector('.edit').onclick = () => openBotForm(b);
    row.querySelector('.del').onclick = () => deleteBot(b);
    box.appendChild(row);
  });
}

async function toggleBot(id, enabled) {
  try {
    const { ok, data: d } = await putJson('/api/bots/' + encodeURIComponent(id), { enabled });
    if (!ok || d?.error) toast(d?.error || '切换失败');
    else toast(enabled ? '已启用，其余机器人自动停用' : '已停用');
  } catch {
    toast('网络错误');
  }
  await renderBotList();
}

/** 渲染文案输入区：编辑用 bot.messages（含覆盖值），新增用 messagesMeta（全空） */
function renderBotMessages(items) {
  const box = $('#botMsgList');
  box.innerHTML = '';
  items.forEach((m) => {
    const field = document.createElement('label');
    field.className = 'set-field msg-field';
    field.textContent = m.label;
    const ta = document.createElement('textarea');
    ta.dataset.key = m.key;
    ta.rows = 2;
    ta.placeholder = m.defaultText;
    ta.value = m.value || '';
    field.appendChild(ta);
    box.appendChild(field);
  });
}

function openBotForm(bot) {
  editingId = bot ? bot.id : null;
  $('#botFormSec').hidden = false;
  $('#botFormTitle').textContent = bot ? `编辑「${bot.name || '(未命名)'}」` : '新增机器人';
  $('#botName').value = bot?.name || '';
  $('#botPlatform').value = bot?.platform || 'feishu';
  $('#botAppId').value = bot?.appId || '';
  $('#botAppSecret').value = '';
  $('#botAppSecret').placeholder = bot?.appSecretMasked ? bot.appSecretMasked + '（留空不改）' : 'App Secret';
  $('#botProjectDir').value = bot?.projectDir || '';
  $('#botPersona').value = bot?.persona || '';
  $('#botProjectNotes').value = bot?.projectNotes || '';
  $('#botSetupScript').value = bot?.setupScript || '';
  $('#botAutonomy').value = String(Math.max(0, AUTONOMY.indexOf(bot?.autonomy || 'light')));
  paintAutonomyHint();
  renderBotMessages(bot ? bot.messages : messagesMeta.map((m) => ({ ...m, value: '' })));
  // 动作 per-bot 独享：新增时机器人还没 id，动作区先隐藏，保存后再配
  $('#botActionsSec').hidden = !bot;
  if (bot) setActionsBot(bot.id);
}

function closeBotForm() {
  editingId = null;
  $('#botFormSec').hidden = true;
  setActionsBot(null);
}

async function saveBot() {
  const messages = {};
  $('#botMsgList').querySelectorAll('textarea').forEach((ta) => (messages[ta.dataset.key] = ta.value));
  const payload = {
    name: $('#botName').value.trim(),
    platform: $('#botPlatform').value,
    appId: $('#botAppId').value.trim(),
    appSecret: $('#botAppSecret').value.trim(),
    projectDir: $('#botProjectDir').value.trim(),
    persona: $('#botPersona').value.trim(),
    projectNotes: $('#botProjectNotes').value.trim(),
    setupScript: $('#botSetupScript').value.trim(),
    autonomy: AUTONOMY[Number($('#botAutonomy').value)] || 'light',
    messages,
  };
  try {
    const url = editingId ? '/api/bots/' + encodeURIComponent(editingId) : '/api/bots';
    const { ok, data: d } = editingId ? await putJson(url, payload) : await postJson(url, payload);
    if (!ok || d?.error) return toast(d?.error || '保存失败');
    toast('机器人已保存，下一条消息生效');
    await renderBotList();
    if (!editingId && d.bot) {
      openBotForm(d.bot); // 新增成功 → 转入编辑态，动作区随之可用
    } else if (editingId && d.bot) {
      $('#botAppSecret').value = '';
      $('#botAppSecret').placeholder = d.bot.appSecretMasked ? d.bot.appSecretMasked + '（留空不改）' : 'App Secret';
    }
  } catch {
    toast('网络错误');
  }
}

async function deleteBot(bot) {
  const ok = await confirmDialog({
    title: '删除机器人',
    message: `确认删除「${bot.name || '(未命名)'}」？其名下全部动作将一并删除。`,
    danger: true,
  });
  if (!ok) return;
  try {
    const { ok, data: d } = await delJson('/api/bots/' + encodeURIComponent(bot.id));
    if (!ok || d?.error) return toast(d?.error || '删除失败');
    if (editingId === bot.id) closeBotForm();
    toast(d?.removedActions ? `已删除（含 ${d.removedActions} 条动作）` : '已删除');
    await renderBotList();
  } catch {
    toast('网络错误');
  }
}

// 项目文件夹「选择」：复用 /api/dirs/pick（后端原生对话框，web/桌面通用）
$('#botProjectDirPickBtn')?.addEventListener('click', async () => {
  const btn = $('#botProjectDirPickBtn');
  btn.disabled = true;
  try {
    const { data: r } = await getJson('/api/dirs/pick');
    if (r?.path) $('#botProjectDir').value = r.path;
    else if (r?.error) toast(r.error);
    // r.path=null：用户取消，忽略
  } catch {
    toast('调用系统对话框失败');
  } finally {
    btn.disabled = false;
  }
});

$('#botAutonomy')?.addEventListener('input', paintAutonomyHint);

$('#botAddBtn')?.addEventListener('click', () => openBotForm(null));
$('#botSaveBtn')?.addEventListener('click', saveBot);
$('#botCancelBtn')?.addEventListener('click', closeBotForm);

// 托管配置 tab 点击时加载机器人列表（显式取元素，避免 id 隐式全局）
const hostingTabBtn = [...$('#settingsTabs').querySelectorAll('button')].find((b) => b.dataset.tab === 'actions');
if (hostingTabBtn) hostingTabBtn.addEventListener('click', () => renderBotList());
