/**
 * 定稿分支弹框 —— 点「定稿，进入开发期」后由用户拍板本次改动落到哪个分支。
 *
 * 为什么要有这一步：定稿原本无条件开一个 `req/<id>-<标题>` 新分支。但「该不该独立成支」
 * 只有人知道——顺手的小改接着当前分支做就行，硬开一支等于凭空多一次合并；而真要并行推进的
 * 需求又确实需要独立分支。机器猜不了，所以把选择交回用户，且**默认不替他选**（输入框留空）。
 *
 * 两个出口都是「确定」，没有主次：
 *   - 沿用当前分支：多工程各自沿用各自的当前分支，不强求同名；
 *   - 新建分支：填了名字才可点；名字已存在时先问清楚，确认后走 checkout（git 侧同一个动作）。
 *
 * 依赖方向：req-branch-dialog → api / ui / dialog-dismiss；不反向依赖 req-view，由后者调用
 * （与 req-assignee-dialog 同一范式）。
 */
import { getJson } from './api.js';
import { confirmDialog } from './ui.js';
import { bindDialogDismiss } from './dialog-dismiss.js';

const ROLE_LABEL = { frontend: '前端', backend: '后端' };

/** 目录尾部标签：C:/foo/bar → bar。全路径太长，弹框里只需认出是哪个工程 */
function dirTail(dir) {
  return String(dir).split(/[/\\]/).filter(Boolean).pop() || dir;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/**
 * @param {object} opts
 * @param {string} opts.reqId
 * @returns {Promise<{mode:'current'}|{mode:'new',branch:string}|null>} null = 用户取消
 */
export async function openBranchDialog({ reqId }) {
  let pre;
  try {
    const { ok, data } = await getJson('/api/req/finalize-precheck?id=' + encodeURIComponent(reqId));
    if (!ok) {
      window.toast?.error(data?.error || '无法读取工程分支信息');
      return null;
    }
    pre = data;
  } catch {
    window.toast?.error('网络错误，无法读取工程分支信息');
    return null;
  }

  const projects = Array.isArray(pre.projects) ? pre.projects : [];
  // 存在性检查按「任一工程里已存在」算：多工程共用一个分支名，只要有一个仓库已有它，
  // 那个仓库走的就是 checkout 而非 create，用户有权先知道
  const existing = new Set(projects.flatMap((p) => p.branches || []));

  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'mask';
    mask.innerHTML =
      '<div class="modal rq-branch-modal">' +
      '<div class="head"><h3>定稿：选择开发分支</h3></div>' +
      '<div class="body"></div>' +
      '<div class="confirm-foot">' +
      '<button class="btn keep">沿用当前分支</button>' +
      '<button class="btn primary create" disabled>新建分支</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(mask);

    const body = mask.querySelector('.body');
    body.appendChild(el('p', 'confirm-msg', '定稿后配置与文档冻结，随后自动开始开发。这次的改动要提交到哪个分支？'));

    // 各工程当前分支：这是「沿用当前分支」到底沿用了什么的唯一依据，不列出来这个按钮就是瞎点
    const list = el('div', 'rq-branch-projects');
    for (const p of projects) {
      const row = el('div', 'rq-branch-proj');
      row.appendChild(el('span', 'rl', ROLE_LABEL[p.role] || p.role));
      const nm = el('span', 'dir', dirTail(p.dir));
      nm.title = p.dir;
      row.appendChild(nm);
      row.appendChild(el('span', 'br', p.current || '（读不到当前分支）'));
      list.appendChild(row);
    }
    body.appendChild(list);

    const label = el('label', 'rq-branch-label', '新分支名');
    body.appendChild(label);

    const input = document.createElement('input');
    input.className = 'prompt-input';
    input.type = 'text';
    input.value = ''; // 刻意留空：预填建议名等于替用户做了「要新建」这个决定
    input.placeholder = pre.suggested ? `留空则不可新建，例如 ${pre.suggested}` : 'feat/xxx';
    input.setAttribute('list', 'rqBranchList');
    input.autocomplete = 'off';
    body.appendChild(input);

    // 现有分支给个 datalist：用户想切到既有分支时不必默写全名，也顺带看出哪些名字已被占
    const dl = document.createElement('datalist');
    dl.id = 'rqBranchList';
    for (const b of [...existing].sort()) dl.appendChild(new Option(b));
    body.appendChild(dl);

    const hint = el('div', 'rq-branch-hint', '');
    body.appendChild(hint);

    const keepBtn = mask.querySelector('.keep');
    const createBtn = mask.querySelector('.create');

    // 收口成「先记结果、再统一走 close」：若在按钮里自己 resolve 再调 close，
    // close 内的 onClose 会抢先 resolve(null)，Promise 只认第一次——两个按钮都会返回 null
    let outcome = null;
    const close = bindDialogDismiss(mask, () => {
      mask.remove();
      resolve(outcome); // Esc / 点遮罩 / 取消时 outcome 仍是 null，语义正好是「放弃定稿」
    });

    const syncState = () => {
      const name = input.value.trim();
      createBtn.disabled = !name;
      if (!name) { hint.textContent = ''; hint.className = 'rq-branch-hint'; return; }
      if (existing.has(name)) {
        hint.textContent = `分支「${name}」已存在，点「新建分支」会问你是否直接切过去。`;
        hint.className = 'rq-branch-hint is-warn';
      } else {
        hint.textContent = '';
        hint.className = 'rq-branch-hint';
      }
    };
    input.addEventListener('input', syncState);
    syncState();

    const finish = (val) => {
      outcome = val;
      close(); // 由它统一移除 DOM、解绑监听并 resolve(outcome)
    };

    keepBtn.addEventListener('click', () => finish({ mode: 'current' }));

    createBtn.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) return;
      if (existing.has(name)) {
        // 已存在时不擅自决定：切过去意味着这次改动落在别人可能也在用的分支上
        const go = await confirmDialog({
          title: '分支已存在',
          message: `新建的分支「${name}」已存在，是否直接切换到它？`,
          confirmText: '是，直接切换',
          cancelText: '否，重新填写',
        });
        if (!go) { input.focus(); input.select(); return; } // 回到弹框，不关窗
      }
      finish({ mode: 'new', branch: name });
    });

    // Enter 等价于点「新建分支」：填完名字顺手回车是最自然的动作。
    // 名字为空时不兜到「沿用当前分支」——那是另一个决定，不能靠回车误触
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !createBtn.disabled) { e.preventDefault(); createBtn.click(); }
    });

    input.focus();
  });
}
