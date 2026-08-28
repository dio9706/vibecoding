/** 共享 DOM/文本工具：$ 选择器、escapeHtml、debounce。 */
export const $ = (s) => document.querySelector(s);

      // ---- 工具函数 ----
      export function escapeHtml(text) {
        if (!text) return '';
        const map = {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#039;'
        };
        return String(text).replace(/[&<>"']/g, (m) => map[m]);
      }

      /** 通用防抖：返回防抖包装后的函数 */
      export function debounce(fn, ms) {
        let t = null;
        const wrapped = (...args) => {
          clearTimeout(t);
          t = setTimeout(() => { t = null; fn(...args); }, ms);
        };
        wrapped.flush = (...args) => { clearTimeout(t); t = null; fn(...args); };
        return wrapped;
      }

/** 目录路径 → 末段目录名（req-view / req-chat 的工程芯片共用） */
      export function dirTail(p) {
        if (!p) return '';
        const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
        return parts[parts.length - 1] || p;
      }

/**
 * 是否为 Markdown 文件路径 —— 即「点了能进 Markdown 查看器」的判据，
 * 与 /api/fs/read 的扩展名白名单一一对应，两边必须同进同退。
 *
 * 放在 util 而不是 chat.js：聊天气泡的路径 chip 与需求右栏的 API 文档都要判，
 * 各写一份正则迟早会漂移。
 */
      export function isMarkdownPath(p) {
        return /\.(md|markdown)$/i.test(p);
      }

/** 时间戳 → 本地中文时间串（logs / tasks 共用） */
      export function fmtTime(iso) {
        try {
          return new Date(iso).toLocaleString('zh-CN', { hour12: false });
        } catch {
          return iso;
        }
      }

/** markdown 渲染（window.marked 可用则富文本，否则纯文本兜底；chat 气泡与任务卡共用） */
      export function renderMarkdown(el, text) {
        const s = text == null ? '' : String(text);
        // 消毒是**强制**的，不是可选增强：喂进来的全是不可信输入（模型输出、模型读到的
        // 文件/网页内容、飞书用户消息、AI 分析结论），且会话存 localStorage 刷新即重放。
        // marked 自 v5 起已移除 sanitize 选项，原始 HTML 默认透传。
        // 在 Tauri 下这条会升级成本机 RCE（webview 可达 shell:allow-execute），
        // 因此 DOMPurify 缺失时宁可退化成纯文本，也绝不把未消毒的 HTML 写进 DOM。
        if (window.marked && typeof marked.parse === 'function'
            && window.DOMPurify && typeof DOMPurify.sanitize === 'function') {
          try {
            el.innerHTML = DOMPurify.sanitize(marked.parse(s));
            el.classList.add('md');
            return;
          } catch {}
        }
        el.textContent = s;
      }

/**
 * 安全写 localStorage —— 绝不让存储异常打断调用方的主流程。
 *
 * 背景：全前端 30 处裸 localStorage.setItem，其中 send() 的第一行就是一处。
 * 一旦触发 QuotaExceededError（claude_convs 保存每个会话的每条消息全文且无任何裁剪/过期策略，
 * 长期使用后必然突破 ~5MB）或 Safari 无痕模式的写入限制，
 * 抛出的异常会让**按 Enter 完全没反应，连自己刚输入的消息都不上屏**。
 * 写失败是可以接受的降级（下次刷新丢一点 UI 偏好），把交互打断则不可接受。
 *
 * @returns {boolean} 是否写入成功，调用方需要时可据此提示
 */
export function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn('[localStorage] 写入失败（配额满或隐私模式）:', key, e?.name || e);
    return false;
  }
}

/** 安全读 localStorage：隐私模式下 getItem 也可能抛异常 */
export function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
