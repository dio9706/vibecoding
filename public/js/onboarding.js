/** 新用户首次引导：接管启动罩 → LOGO 单次旋转后左移 → 右侧展开配置面板。
 *  判定与校验的纯逻辑在 onboarding.logic.js，本模块只做 DOM 编排、动画时序与请求。
 *  入口 maybeStartOnboarding 由 app.js 注册给 boot-gate 的撤罩 handoff。 */
import { isNewUser, validateOnboardForm } from './onboarding.logic.js';
import { VENDOR_PRESETS } from './vendor-presets.js';
import { importConfigFile } from './config-import.js';
import { toast } from './ui.js';

// 动画时序（ms）。SPIN_MS 必须与 onboarding.css 里 vibeSpinOnce 的时长一致，
// 否则左移会在旋转还没结束时就开始。
const SPIN_MS = 780;
const SETTLE_MS = 320; // 转完停一下，给「停稳」的落定感
const PANEL_DELAY_MS = 180;
const PANEL_IN_MS = 380;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduceMotion = () =>
  !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const el = (id) => document.getElementById(id);

/** boot-gate 的撤罩接管者。返回 true 表示接管罩子（引导已启动，罩子不撤）。 */
export async function maybeStartOnboarding(overlay) {
  if (!overlay) return false;

  let settings;
  try {
    const r = await fetch('/api/settings', { cache: 'no-store' });
    if (!r.ok) return false;
    settings = await r.json();
  } catch {
    // 判定拿不到就不接管。漏一次引导可以接受（用户还能自己进设置页），
    // 把用户锁在一个空罩子里不行。这条同时覆盖了「点了仍然进入但后端其实没通」的场景。
    return false;
  }

  if (!isNewUser(settings)) return false;

  const panel = el('obPanel');
  if (!panel) {
    console.warn('[Onboarding] 缺少 #obPanel 骨架，放弃引导');
    return false; // HTML 未更新时宁可不引导，也不留一个撤不掉的空罩子
  }

  startOnboarding(overlay, panel); // 不 await：让 boot-gate 立刻拿到 true 去 return
  return true;
}

// ---- 引导启动与动画时序 ----

async function startOnboarding(overlay, panel) {
  fillVendorOptions();
  bindTabs();
  bindCollapse();
  bindVendorChange();
  bindImport();
  bindSubmit();
  bindLiveValidate();
  syncSubmitState();

  if (reduceMotion()) {
    overlay.classList.add('ob-arm', 'ob-open');
    panel.hidden = false;
    focusFirst();
    return;
  }

  overlay.classList.add('ob-arm');
  void overlay.offsetWidth; // 强制 reflow，让单次 keyframe 从头起播而不是接着上一轮

  // 时序用 setTimeout 链而不是监听 animationend：后台标签页会节流动画事件，
  // 动画被 CSS 覆盖或 reduced-motion 置 none 时根本不触发 —— 漏一次事件，
  // 引导就永久停在半路，用户对着一个不动的罩子干等。
  await sleep(SPIN_MS + SETTLE_MS);
  overlay.classList.add('ob-open');
  await sleep(PANEL_DELAY_MS);
  panel.hidden = false;
  await sleep(PANEL_IN_MS);
  focusFirst();
}

function focusFirst() {
  const pane = document.querySelector('.ob-pane:not([hidden])');
  pane?.querySelector('input')?.focus();
}

// ---- 表单填充与绑定 ----

/** 厂商下拉从 VENDOR_PRESETS 生成。设置页的 #credVendor 是硬编码 option（已经是第二份
 *  厂商清单），这里不再添第三份 —— 加厂商只需改 vendor-presets.js。 */
function fillVendorOptions() {
  const sel = el('obCredVendor');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- 选择厂商 --</option>';
  for (const [key, preset] of Object.entries(VENDOR_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = preset.label;
    sel.appendChild(opt);
  }
}

function bindTabs() {
  const tabs = el('obModelTabs');
  if (!tabs) return;
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.ob-tab');
    if (!btn) return;
    const tab = btn.dataset.tab;
    tabs.querySelectorAll('.ob-tab').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.ob-pane').forEach((p) => {
      p.hidden = p.dataset.pane !== tab;
    });
    syncSubmitState(); // 换 Tab 等于换校验分支，按钮可用性要跟着变
    focusFirst();
  });
}

function bindCollapse() {
  for (const id of ['obOpenIdSec', 'obBotSec']) {
    const sec = el(id);
    sec?.querySelector('.ob-toggle')?.addEventListener('click', () => {
      sec.classList.toggle('collapsed');
    });
  }
}

/** 选厂商时带入预设的 baseURL 与模型建议。
 *  模型框恒为自由输入：预设列表天然滞后于厂商上新，锁成只读下拉会逼用户
 *  改走「其他（自定义）」并重填 baseURL，白丢预设最有价值的那部分。 */
function bindVendorChange() {
  const sel = el('obCredVendor');
  const baseURL = el('obCredBaseURL');
  const model = el('obCredModel');
  const list = el('obCredModelList');
  if (!sel || !baseURL || !model || !list) return;

  sel.addEventListener('change', () => {
    const preset = VENDOR_PRESETS[sel.value];
    list.innerHTML = '';
    model.value = '';

    if (!sel.value || !preset) {
      model.placeholder = '先选厂商';
      baseURL.disabled = false;
      baseURL.value = '';
      syncSubmitState();
      return;
    }

    preset.models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      list.appendChild(opt);
    });

    if (sel.value === 'custom') {
      // 其他（自定义）：无预设可依，baseURL 与模型都由用户填
      model.placeholder = '模型名，如 my-model';
      baseURL.disabled = false;
      baseURL.placeholder = 'https://api.xxx.com/v1';
      baseURL.value = '';
    } else {
      model.placeholder = preset.models[0] || '模型名';
      model.value = preset.models[0] || '';
      baseURL.disabled = true;
      baseURL.value = preset.baseURL;
    }
    syncSubmitState();
  });
}

/** 逐键同步「完成」按钮可用性：模型段一填齐就解锁，用户不用先点一次才知道缺什么 */
function bindLiveValidate() {
  const ids = ['obTokenValue', 'obCredApiKey', 'obCredBaseURL', 'obCredModel'];
  for (const id of ids) el(id)?.addEventListener('input', syncSubmitState);
}

/** 「完成」只看模型段 —— 飞书两段是选填，它们的校验留到提交时报，
 *  否则用户展开了选填段填错一个字符，必填都填好了却点不动按钮 */
function syncSubmitState() {
  const btn = el('obSubmitBtn');
  if (!btn) return;
  const { errors } = validateOnboardForm(readForm());
  btn.disabled = !!errors.model;
  btn.title = errors.model || '';
}

function bindImport() {
  const btn = el('obImportBtn');
  const input = el('obImportFile');
  if (!btn || !input) return;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = ''; // 允许再次选同一文件
    if (!file) return;
    btn.disabled = true;
    // 不传 confirm：新用户本来是空配置，「将覆盖当前全部配置」那句危险确认在这里是误导
    const r = await importConfigFile(file);
    if (!r.ok) {
      btn.disabled = false;
      showErr('导入失败：' + r.error);
      return;
    }
    toast(
      r.actionConfigsImported
        ? '配置已导入（含托管配置），正在重新加载…'
        : '配置已导入。该文件为旧版，不含托管配置，需到设置页重新配置动作',
    );
    await sleep(r.actionConfigsImported ? 800 : 2400);
    location.reload();
  });
}

// ---- 读表单与提交 ----

const val = (id) => (el(id)?.value || '').trim();

function readForm() {
  const activeTab = document.querySelector('.ob-tab.active')?.dataset.tab || 'claude';
  return {
    modelTab: activeTab,
    claude: { label: val('obTokenLabel'), token: val('obTokenValue') },
    custom: {
      vendor: val('obCredVendor'),
      apiKey: val('obCredApiKey'),
      baseURL: val('obCredBaseURL'),
      model: val('obCredModel'),
    },
    openId: val('obOpenId'),
    bot: { name: val('obBotName'), appId: val('obBotAppId'), appSecret: val('obBotSecret') },
  };
}

function showErr(msg) {
  const box = el('obErr');
  if (box) box.textContent = msg || '';
}

/** POST 并归一化结果：成功返回 null，失败返回可直接展示的错误文案。
 *  后端有「200 + ok:false」的约定（前置条件不齐时），必须一起判。 */
async function post(url, body) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error || d.ok === false) return d.error || 'HTTP ' + r.status;
    return null;
  } catch (e) {
    return (e && e.message) || String(e);
  }
}

function bindSubmit() {
  el('obSubmitBtn')?.addEventListener('click', submit);
}

async function submit() {
  const state = readForm();
  const { ok, errors } = validateOnboardForm(state);
  if (!ok) {
    showErr(errors.model || errors.bot || errors.openId);
    // 报错在哪段就把那段展开，否则折叠着的错误提示指不到具体字段
    if (errors.bot) el('obBotSec')?.classList.remove('collapsed');
    else if (errors.openId) el('obOpenIdSec')?.classList.remove('collapsed');
    return;
  }

  const btn = el('obSubmitBtn');
  btn.disabled = true;
  btn.textContent = '正在保存…';
  showErr('');

  // ① 模型是硬门槛：存不进去就必须停在这里。放行等于把用户丢进一个必然报错的界面
  const modelErr = await saveModel(state);
  if (modelErr) {
    showErr('模型保存失败：' + modelErr);
    btn.disabled = false;
    btn.textContent = '完成，开始使用';
    return;
  }

  // ②③ 飞书两段是选填：失败只提示不阻塞，别拿一个可选配置把用户挡在门外
  const soft = [];
  if (state.openId) {
    const e = await post('/api/settings', { section: 'profile', myFeishuOpenId: state.openId });
    if (e) soft.push('open_id：' + e);
  }
  if (state.bot.appId) {
    // enabled:true 是必需的 —— 不带这个字段，用户填完机器人却不生效，等于白填
    const e = await post('/api/bots', {
      name: state.bot.name,
      platform: 'feishu',
      appId: state.bot.appId,
      appSecret: state.bot.appSecret,
      enabled: true,
    });
    if (e) soft.push('机器人：' + e);
  }

  if (soft.length) {
    toast('模型已保存。飞书配置未保存（' + soft.join('；') + '），可稍后到设置页补');
    await sleep(2600); // 留出读 toast 的时间再刷新
  }

  // reload 而不是就地初始化：app.js 的启动初始化早在罩子后面跑完了，
  // 它读的是引导前的空配置。重来一遍最省事，且此时已是老用户路径。
  location.reload();
}

async function saveModel(state) {
  if (state.modelTab === 'custom') {
    const c = state.custom;
    return await post('/api/credentials', {
      apiKey: c.apiKey,
      baseURL: c.baseURL,
      model: c.model,
      vendor: c.vendor,
    });
  }
  return await post('/api/settings', {
    section: 'tokens',
    action: 'add',
    label: state.claude.label,
    token: state.claude.token,
  });
}
