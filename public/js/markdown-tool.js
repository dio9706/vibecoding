/**
 * Markdown 查看工具
 * 功能：文件打开、内容渲染、目录导航、搜索、导出
 */

// 一次性清理：「打开历史」功能已移除（2026-08-25），但它曾按 2MB 上限把文档正文缓存在这个 key 里。
// localStorage 总配额通常 5MB，且与 claude_convs（会话记录 + 未发送草稿）共享——不清掉，
// 老用户那 2MB 死数据会永久挤压会话存储。若干版本后可删掉这行。
try { localStorage.removeItem('md-tool-history'); } catch { /* 隐私模式等 */ }

class MarkdownTool {
  constructor() {
    // DOM 元素缓存
    this.els = {
      // 工具入口
      toolBtn: document.getElementById('toolMarkdown'),
      toolsFooter: document.getElementById('toolsFooter'),
      openFileBtn2: document.getElementById('mdOpenFileBtn2'),

      // 工具面板（id 与 index.html 中 markdownContainer 对齐）
      container: document.getElementById('markdownContainer'),
      empty: document.getElementById('mdEmpty'),
      openFileBtn: document.getElementById('mdOpenFileBtn'),

      // 工具栏
      fileName: document.getElementById('mdFileName'),
      fileInfo: document.getElementById('mdFileInfo'),
      exportHtmlBtn: document.getElementById('mdExportHtmlBtn'),
      copyAllBtn: document.getElementById('mdCopyAllBtn'),

      // 目录树
      tocTree: document.getElementById('mdTocTree'),

      // 搜索框
      searchInput: document.getElementById('mdSearchInput'),
      searchCount: document.getElementById('mdSearchCount'),
      searchClearBtn: document.getElementById('mdSearchClearBtn'),

      // 内容区
      content: document.getElementById('mdContent'),
    };

    // 状态
    this.state = {
      currentFile: null,  // { path, content, modifiedTime, size }
      currentToc: [],     // 目录树数组
      searchQuery: '',
      searchMatches: [],
      searchCurrentIndex: -1,
    };

    // 目录滚动联动的内部状态
    this._activeTocId = null;
    this._spySuppressUntil = 0;
    this._spyTicking = false;
    this._pinnedTocId = null;
    this._pinnedAtScroll = 0;

    // 绑定事件
    this.bindEvents();

    // 侧栏「会话 / 工具」切换时由 app.js 回调，决定工具态底栏是否露出
    window._syncToolsFooter = () => this.syncToolsFooter();
    this.syncToolsFooter();
  }

  // ===== 事件绑定 =====
  bindEvents() {
    // 工具入口点击
    this.els.toolBtn?.addEventListener('click', () => this.showTool());

    // 打开文件按钮
    this.els.openFileBtn?.addEventListener('click', () => this.promptOpenFile());
    this.els.openFileBtn2?.addEventListener('click', () => this.promptOpenFile());

    // 拖拽上传
    this.setupDragDrop();

    // 工具栏按钮
    this.els.exportHtmlBtn?.addEventListener('click', () => this.exportHtml());
    this.els.copyAllBtn?.addEventListener('click', () => this.copyAllText());

    // 搜索
    this.els.searchInput?.addEventListener('input', (e) => this.handleSearch(e));
    this.els.searchClearBtn?.addEventListener('click', () => this.clearSearch());

    // 目录树点击跳转
    this.els.tocTree?.addEventListener('click', (e) => this.handleTocClick(e));

    // 内容区滚动 → 目录高亮联动
    this.setupScrollSpy();
  }

  // 内容区是唯一滚动容器，滚动时把「当前所处章节」同步到目录高亮
  setupScrollSpy() {
    const content = this.els.content;
    if (!content) return;
    content.addEventListener(
      'scroll',
      () => {
        if (this._spyTicking) return;
        this._spyTicking = true;
        requestAnimationFrame(() => {
          this._spyTicking = false;
          this.syncActiveToc();
        });
      },
      { passive: true },
    );
  }

  syncActiveToc() {
    // 点击目录后有一段平滑滚动，期间途经的标题会挨个"闪一下"，这里先让位给点击结果
    if (Date.now() < this._spySuppressUntil) return;

    const toc = this.state.currentToc;
    const content = this.els.content;
    if (!toc.length || !content) return;

    // 点击落在"已到底"的尾部章节时高亮被钉住；一旦用户自己滚动就交回联动
    if (this._pinnedTocId) {
      if (Math.abs(content.scrollTop - this._pinnedAtScroll) < 2) {
        if (this._activeTocId !== this._pinnedTocId) {
          this.updateActiveToc(this._pinnedTocId, { revealInToc: true });
        }
        return;
      }
      this._pinnedTocId = null;
    }

    // 判定线取内容区顶部下方 24px：最后一个越线的标题即当前章节
    const line = content.scrollTop + 24;
    let currentId = toc[0].id;
    for (const item of toc) {
      if (item.element.offsetTop <= line) currentId = item.id;
      else break;
    }
    // 末章太短时永远越不过判定线，滚到底就直接钉在最后一项
    if (content.scrollTop + content.clientHeight >= content.scrollHeight - 4) {
      currentId = toc[toc.length - 1].id;
    }

    if (currentId !== this._activeTocId) {
      this.updateActiveToc(currentId, { revealInToc: true });
    }
  }

  setupDragDrop() {
    const panel = document.querySelector('[data-view="markdown"]');
    if (!panel) return;

    // Tauri 原生拖拽：HTML5 drop 在原生模式下不再触发，改由总线按落点分派。
    // 本文件以传统 <script> 引入，不是 ES module，拿不到 import，只能走 window 桥。
    if (window.dragBus) {
      window.dragBus.registerDropZone({
        el: panel,
        onDrop: (paths) => { if (paths[0]) this.openFileByPath(paths[0]); },
      });
    } else {
      // dragBus 由 drag-bus.js 模块顶层无条件挂载，取不到只可能是模块图断了
      // （脚本引入顺序被改、import 被摘掉）。任何模式下都是缺陷，无条件喊出来。
      //
      // 这里刻意不加 isTauri 门禁：那样看似更精确，实则不可达（dragBus 在浏览器里同样会挂上），
      // 且 tauriApi 由异步 IIFE 产出，真出事时可能还没 settle，反而把唯一的报错吞掉——
      // 「看起来有防护、实际从不生效」正是本次改造在清理的东西，不能自己再造一个
      console.error('[MarkdownTool] window.dragBus 缺失，Markdown 拖拽区将失效');
    }

    // Web 模式保留 HTML5 路线：浏览器拿不到绝对路径，只能走 File 对象
    panel.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        this.openFile(files[0]);
      }
    });
  }

  // ===== 文件操作 =====
  showTool() {
    // 面板切换由 app.js showView('markdown') 统一处理，这里只负责工具内部 UI 状态
    const hasFile = !!this.state.currentFile;
    if (this.els.empty) this.els.empty.hidden = hasFile;
    if (this.els.container) this.els.container.hidden = !hasFile;
    this.syncToolsFooter();
  }

  // 工具态底栏（「打开…」按钮）只在侧栏处于工具态时露出，
  // 否则它会挂在会话列表底下。原实现还要求「确实有历史」，历史功能移除后该条件已无意义。
  syncToolsFooter() {
    const panel = this.els.toolsFooter;
    if (!panel) return;
    panel.hidden = document.getElementById('toolsList')?.hidden !== false;
  }

  promptOpenFile() {
    // 触发文件选择对话框
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,text/markdown,text/plain';
    input.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        this.openFile(e.target.files[0]);
      }
    });
    input.click();
  }

  // 取路径末段（标题栏展示与导出文件名共用）：存的是全路径，短名一律现算。
  baseName(p) {
    return String(p || '').split(/[/\\]/).filter(Boolean).pop() || String(p || '');
  }

  async openFile(file) {
    // 验证文件类型
    if (!file.name.endsWith('.md') && !file.name.endsWith('.markdown')) {
      this.showToast('仅支持 .md 或 .markdown 文件');
      return;
    }

    // 验证文件大小
    if (file.size > 10 * 1024 * 1024) {
      this.showToast('文件过大（> 10MB），请选择较小文件');
      return;
    }

    try {
      const content = await file.text();
      this.loadDocument({
        path: file.name,
        content,
        modifiedTime: file.lastModified,
        size: file.size,
      });
    } catch (err) {
      console.error('文件读取失败', err);
      this.showToast('文件读取失败');
    }
  }

  /**
   * Tauri 模式 / 聊天气泡里的 md chip：按绝对路径打开（走 /api/fs/read 读盘）。
   *
   * 与 openFile(File) 的区别是拿得到真实路径；Web 模式的拖拽/选择拿不到绝对路径，
   * 只能走 File 对象读内容。
   */
  async openFileByPath(absPath) {
    const name = this.baseName(absPath);
    if (!name.endsWith('.md') && !name.endsWith('.markdown')) {
      this.showToast('仅支持 .md 或 .markdown 文件');
      return;
    }
    // 大小上限交给后端（/api/fs/read 有 10MB 拦截）：前端要判就得先把内容传完，
    // 那时候流量已经花掉了，拦不住任何东西
    try {
      const r = await fetch('/api/fs/read?path=' + encodeURIComponent(absPath));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '读取失败');
      this.loadDocument({
        path: absPath,
        content: d.content,
        modifiedTime: d.mtime,
        size: d.size,
      });
    } catch (err) {
      console.error('文件读取失败', err);
      this.showToast('文件读取失败：' + (err?.message || err));
    }
  }

  // 装载一份文档（磁盘打开 / 聊天气泡里的 md chip 点击共用这一条路径，保证行为一致）
  loadDocument({ path, content, modifiedTime, size }) {
    this.state.currentFile = { path, content, modifiedTime, size };
    this.els.content.scrollTop = 0; // 换文档回到顶部，否则会停在上一篇的滚动位置
    this.renderContent();
    this.showTool();
  }

  // ===== 内容渲染 =====
  renderContent() {
    if (!this.state.currentFile) return;

    const { path, content, modifiedTime, size } = this.state.currentFile;

    // 更新路径和文件信息
    // 路径改为真实绝对路径后，整条塞进文件名栏会撑爆布局；完整路径移到 title
    this.els.fileName.textContent = this.baseName(path);
    this.els.fileName.title = path;
    const time = new Date(modifiedTime).toLocaleString('zh-CN');
    const sizeStr = this.formatFileSize(size);
    this.els.fileInfo.textContent = `${sizeStr} · ${time}`;

    // 文件大小检查
    const maxSize = 30 * 1024 * 1024;  // 30MB 限制
    if (size > maxSize) {
      this.showToast('文件过大（> 30MB），渲染可能较慢或失败，建议分割文件');
      console.warn('大文件警告：', this.formatFileSize(size));
    }

    // 使用 requestIdleCallback 延迟渲染（性能优化）
    if ('requestIdleCallback' in window) {
      requestIdleCallback(() => {
        this.parseAndRender(content);
      });
    } else {
      setTimeout(() => {
        this.parseAndRender(content);
      }, 100);
    }
  }

  parseAndRender(content) {
    try {
      const html = marked.parse(content, {
        breaks: true,
        gfm: true,
      });
      const cleaned = DOMPurify.sanitize(html);
      this.els.content.innerHTML = cleaned;
    } catch (err) {
      console.error('Markdown 解析失败', err);
      this.els.content.textContent = content;
    }

    // 生成目录树
    this.generateToc();

    // 清除搜索
    this.clearSearch();
  }

  generateToc() {
    const content = this.els.content;
    const headings = Array.from(content.querySelectorAll('h1, h2, h3, h4, h5, h6'));

    this.state.currentToc = headings.map((h, i) => {
      const level = parseInt(h.tagName[1]);
      const text = h.textContent;
      const id = `md-heading-${i}`;
      h.id = id;
      return { level, text, id, element: h };
    });

    this.renderTocTree();
  }

  renderTocTree() {
    const toc = this.state.currentToc;
    this.els.tocTree.innerHTML = '';

    toc.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'md-toc-item';
      btn.setAttribute('data-level', item.level);
      btn.setAttribute('data-id', item.id);
      btn.textContent = item.text || '(无标题)';
      // 面板只有 220px，深层标题基本都会被省略号截断，挂 title 让悬停能看全
      btn.title = item.text || '(无标题)';
      this.els.tocTree.appendChild(btn);
    });

    // 换文档后重置联动状态，并按当前滚动位置立刻定一次高亮
    this._activeTocId = null;
    this._spySuppressUntil = 0;
    this._pinnedTocId = null;
    this.syncActiveToc();
  }

  // ===== 搜索功能 =====
  handleSearch(e) {
    const query = e.target.value.trim();
    if (!query) {
      this.clearSearch();
      return;
    }

    this.state.searchQuery = query;
    this.highlightMatches(query);
  }

  highlightMatches(query) {
    // 清除之前的高亮
    this.els.content.querySelectorAll('mark').forEach(mark => {
      const parent = mark.parentNode;
      if (parent) {
        while (mark.firstChild) {
          parent.insertBefore(mark.firstChild, mark);
        }
        parent.removeChild(mark);
      }
    });

    if (!query) return;

    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const walker = document.createTreeWalker(
      this.els.content,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    let node;
    const matches = [];
    const nodesToProcess = [];

    while (node = walker.nextNode()) {
      if (regex.test(node.textContent)) {
        nodesToProcess.push(node);
      }
    }

    nodesToProcess.forEach((textNode) => {
      const span = document.createElement('span');
      const text = textNode.textContent;
      let lastIndex = 0;

      const replacements = [];
      let match;
      regex.lastIndex = 0;
      while ((match = regex.exec(text)) !== null) {
        replacements.push(
          { text: text.substring(lastIndex, match.index), isMatch: false },
          { text: match[0], isMatch: true }
        );
        lastIndex = regex.lastIndex;
      }
      replacements.push({ text: text.substring(lastIndex), isMatch: false });

      replacements.forEach(item => {
        if (item.isMatch) {
          const mark = document.createElement('mark');
          mark.textContent = item.text;
          span.appendChild(mark);
          matches.push(mark);
        } else {
          span.appendChild(document.createTextNode(item.text));
        }
      });

      textNode.parentNode.replaceChild(span, textNode);
    });

    this.state.searchMatches = matches;
    this.updateSearchCount();
  }

  updateSearchCount() {
    const count = this.state.searchMatches.length;
    if (count > 0) {
      this.els.searchCount.textContent = `${count} 匹配`;
      this.els.searchCount.hidden = false;
      this.els.searchClearBtn.hidden = false;
    } else {
      this.els.searchCount.hidden = true;
      this.els.searchClearBtn.hidden = true;
    }
  }

  clearSearch() {
    this.els.searchInput.value = '';
    this.state.searchQuery = '';
    this.state.searchMatches = [];
    this.highlightMatches('');
    this.els.searchCount.hidden = true;
    this.els.searchClearBtn.hidden = true;
  }

  // ===== 目录树交互 =====
  handleTocClick(e) {
    const btn = e.target.closest('.md-toc-item');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const element = document.getElementById(id);
    if (!element) return;

    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.updateActiveToc(id);
    // 压住联动 500ms，等平滑滚动落定；到点再对一次账，防止最终位置与点击项不符
    this._spySuppressUntil = Date.now() + 500;
    setTimeout(() => {
      const c = this.els.content;
      // 文末几节的标题已经没法再滚到顶（容器到底了），此时联动会按"顶部是谁"
      // 把高亮抢回最后一节，跟用户刚点的那一项对不上。钉住点击项，直到用户自己再滚
      const atBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 4;
      this._pinnedTocId = atBottom ? id : null;
      this._pinnedAtScroll = c.scrollTop;
      this.syncActiveToc();
    }, 520);
  }

  updateActiveToc(id, { revealInToc = false } = {}) {
    this._activeTocId = id;
    this.els.tocTree.querySelectorAll('.md-toc-item').forEach((item) => {
      const isActive = item.getAttribute('data-id') === id;
      item.classList.toggle('active', isActive);
      // 长目录里被联动选中的项可能在可视区外，滚动它自己的面板把它带回来。
      // block:'nearest' 保证已经可见时不做任何滚动，避免目录跟着乱跳
      if (isActive && revealInToc) item.scrollIntoView({ block: 'nearest' });
    });
  }

  // ===== 导出功能 =====
  exportHtml() {
    if (!this.state.currentFile) return;

    const { path } = this.state.currentFile;
    const base = this.baseName(path);
    // 未转义的路径直接进 <title> 是既有 XSS 隐患，路径变长后更值得顺手堵掉
    const safeTitle = base.replace(/[<>&"]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
    const html = this.els.content.innerHTML;
    const css = this.getEmbeddedCss();

    const doc = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>
    ${css}
  </style>
</head>
<body>
  <div class="md-content">
    ${html}
  </div>
</body>
</html>`;

    const blob = new Blob([doc], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // 绝对路径含 \ 与 :，直接作为下载名会失败，必须取 basename；
    // 且原写法 replace('.md','.html') 会命中路径中间的 .md 子串
    a.download = base.replace(/\.(md|markdown)$/i, '') + '.html';
    a.click();
    URL.revokeObjectURL(url);

    this.showToast('已导出为 HTML');
  }

  getEmbeddedCss() {
    return `
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        line-height: 1.6;
        color: #333;
        max-width: 800px;
        margin: 0 auto;
        padding: 20px;
      }
      .md-content h1, .md-content h2, .md-content h3 { margin-top: 20px; }
      .md-content code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
      .md-content pre { background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; }
      .md-content a { color: #0066cc; text-decoration: none; }
      .md-content a:hover { text-decoration: underline; }
      .md-content table { border-collapse: collapse; width: 100%; }
      .md-content th, .md-content td { padding: 8px 12px; border: 1px solid #ddd; text-align: left; }
    `;
  }

  copyAllText() {
    const text = this.els.content.textContent;
    if (!text) return;

    navigator.clipboard.writeText(text).then(() => {
      this.showToast('已复制全文');
    }).catch(err => {
      console.error('复制失败', err);
      this.showToast('复制失败');
    });
  }

  // ===== 工具函数 =====
  formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }

  showToast(message) {
    // 复用现有 toast 系统（如果有）
    if (window.showToast && typeof window.showToast === 'function') {
      try {
        window.showToast(message);
      } catch (err) {
        console.warn('Toast 系统调用失败', err);
        console.log('消息：', message);
      }
    } else {
      // 降级方案：使用 console，确保消息不会丢失
      if (typeof console !== 'undefined' && console.info) {
        console.info('[Markdown Tool]', message);
      }
    }
  }
}

// 导出类
if (typeof window !== 'undefined') {
  window.MarkdownTool = MarkdownTool;
}
