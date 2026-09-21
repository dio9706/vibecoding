/**
 * UI 规范抽屉 —— 项目级（按工程目录归属）的字体/圆角/组件约定/禁止项。
 *
 * 还原设计稿时这份文本会作为**硬约束**注入 prompt（见 req-uispec.logic.js buildRestorePrompt），
 * 所以这里编辑的是「以后每次还原都要守的规矩」，不是某个页面的一次性说明。
 *
 * 容器是右侧抽屉（req-drawer.js）：写规范要比对 AI 刚生成的代码，聊天区必须还能看。
 */
import { sendMessageProgrammatically } from './chat.js';
import { iconHtml, DESIGN_ICON_SVG } from './icons.js';
import { openReqDrawer } from './req-drawer.js';

const PLACEHOLDER = `## 字体
- 正文：14px / 22px，400
- 辅助：12px / 18px，#8b8b9a
- 标题：16px / 24px，600

## 圆角与间距
- 卡片 / 弹框：12px
- 按钮 / 输入框：8px
- 栅格基数 4px，常用间距 8 / 12 / 16 / 24

## 组件约定（还原时只准用这些）
- 弹框：<OpModal>，遮罩 rgba(0,0,0,.45)，宽度档位 480/640/880
- 输入框：<OpInput>，高 36px
- 按钮：主色实心 / 次色描边，高 32px，间距 8px

## 禁止项
- 不要自造弹框、不要用裸 <input>、不要内联写死颜色值
- 不要从设计稿直接抄圆角与阴影，一律回落到本规范档位`;

/**
 * @param {object} opts
 * @param {string} opts.dir - 工程目录（规范的归属键）
 * @param {boolean} opts.hasConv - 会话就绪时才允许「从代码抽草稿」（要靠会话跑 AI）
 */
export function openUiSpecDialog({ dir, hasConv }) {
  const { root: drawer, close } = openReqDrawer({
    title: 'UI 规范',
    icon: iconHtml(DESIGN_ICON_SVG),
    cls: 'rq-spec-drawer',
    bodyHtml:
      '<div class="rq-spec-meta"></div>' +
      '<textarea class="rq-spec-text" spellcheck="false"></textarea>',
    footHtml:
      '<button class="btn rq-spec-draft">从代码抽草稿</button>' +
      '<span class="rq-spec-gap"></span>' +
      '<button class="btn cancel">取消</button>' +
      '<button class="btn primary ok">保存</button>',
  });

  const ta = drawer.querySelector('.rq-spec-text');
  const draftBtn = drawer.querySelector('.rq-spec-draft');
  drawer.querySelector('.rq-spec-meta').textContent = dir + ' · 本工程的所有需求共用这一份';
  ta.placeholder = PLACEHOLDER;

  drawer.querySelector('.cancel').addEventListener('click', close);

  if (!hasConv) {
    draftBtn.disabled = true;
    draftBtn.title = '会话未就绪，重新打开需求后可用';
  }

  (async () => {
    try {
      const r = await fetch('/api/req/uispec?dir=' + encodeURIComponent(dir));
      const d = await r.json();
      if (r.ok) ta.value = d.text || '';
    } catch {
      window.toast.error('读取 UI 规范失败');
    }
  })();

  draftBtn.addEventListener('click', async () => {
    draftBtn.disabled = true;
    try {
      const r = await fetch('/api/req/uispec/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '生成失败');
      close();
      // 与 UI 还原同款范式：服务端只给 prompt，发送由会话侧完成；
      // 抽出来的草稿在对话里，用户看过之后自己贴回本面板保存（不自动落盘，免得覆盖手写规范）
      sendMessageProgrammatically(d.prompt, { mode: 'bypassPermissions' });
      window.toast.success('已让 Claude 抽草稿，产出后复制回本面板保存');
    } catch (e) {
      window.toast.error('抽草稿失败：' + (e?.message || e));
      draftBtn.disabled = false;
    }
  });

  drawer.querySelector('.ok').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await fetch('/api/req/uispec', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir, text: ta.value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '保存失败');
      close();
      window.toast.success('UI 规范已保存（' + d.chars + ' 字）');
    } catch (err) {
      window.toast.error('保存失败：' + (err?.message || err));
      btn.disabled = false;
    }
  });
}
