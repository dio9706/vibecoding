/**
 * Markdown 查看工具
 * 功能：文件打开、内容渲染、目录导航、搜索、导出
 */

const MD_HISTORY_KEY = 'md-tool-history';
const MD_HISTORY_MAX = 10;
// 浏览器安全模型下拿不到本地绝对路径，历史要能「点开即看」只能把正文一起缓存。
// localStorage 常见配额 5MB，这里单篇 512KB / 总量 2MB 封顶，超限的条目只留元信息，
// 点击时降级为「重新选文件」，不至于把整个 localStorage 撑爆连累其他功能。
const MD_CACHE_MAX_ONE = 512 * 1024;
const MD_CACHE_MAX_TOTAL = 2 * 1024 * 1024;

class MarkdownTool {
  constructor() {
    // DOM 元素缓存
    this.els = {
      // 工具入口
      toolBtn: document.getElementById('toolMarkdown'),
      openHistoryPanel: document.getElementById('mdHistory'),
      openFileBtn2: document.getElementById('mdOpenFileBtn2'),
      historyList: document.getElementById('mdHistoryList'),

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

    // 历史记录
    this.history = this.loadHistory();

    // 目录滚动联动的内部状态
    this._activeTocId = null;
    this._spySuppressUntil = 0;
    this._spyTicking = false;
    this._pinnedTocId = null;
    this._pinnedAtScroll = 0;

    // 绑定事件
    this.bindEvents();

    // 冷启动就把已存历史铺出来：原来只在 updateHistory() 里渲染，
    // 导致重开应用后侧栏历史一直是空的
    this.renderHistory();

    // 侧栏「会话 / 工具」切换时由 app.js 回调，决定历史面板是否露出
    window._syncMdHistoryPanel = () => this.syncHistoryPanel();
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

    // 历史点击
    this.els.historyList?.addEventListener('click', (e) => this.handleHistoryClick(e));

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
    this.syncHistoryPanel();
  }

  // 历史面板只在「侧栏处于工具态」且「确实有历史」时露出。
  // 之前它只跟当前是否打开了文件走，结果切回会话列表后仍挂在侧栏底部
  syncHistoryPanel() {
    const panel = this.els.openHistoryPanel;
    if (!panel) return;
    const inToolsMode = document.getElementById('toolsList')?.hidden === false;
    panel.hidden = !inToolsMode || this.history.length === 0;
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

  // 取路径末段。history 持久化在 localStorage，老条目的 name 存的是全路径，
  // 所以短名一律渲染时现算，不改存储结构，老数据自动兼容。
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
   * Tauri 模式：按绝对路径打开。
   *
   * 与 openFile(File) 的区别是拿得到真实路径，于是历史条目在正文缓存被配额挤掉之后
   * 仍能重新读盘——Web 模式做不到这点（浏览器不给绝对路径），只能请用户重选。
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

  // 装载一份文档：磁盘打开与历史回看共用这一条路径，保证两边行为一致
  loadDocument({ path, content, modifiedTime, size }) {
    this.state.currentFile = { path, content, modifiedTime, size };
    this.els.content.scrollTop = 0; // 换文档回到顶部，否则会停在上一篇的滚动位置
    this.renderContent();
    this.updateHistory();
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

  // ===== 历史记录 =====
  loadHistory() {
    try {
      const json = localStorage.getItem(MD_HISTORY_KEY);
      const list = json ? JSON.parse(json) : [];
      return Array.isArray(list) ? list : [];
    } catch (err) {
      console.error('历史记录加载失败', err);
      return [];
    }
  }

  saveHistory() {
    // 从最旧的一条开始逐条丢正文重试：宁可退化成「点击重新选文件」，
    // 也不能让写入失败导致整份历史（含文件名/时间）都存不下
    const attempt = (list) => {
      localStorage.setItem(MD_HISTORY_KEY, JSON.stringify(list));
    };
    try {
      attempt(this.history);
      return;
    } catch (err) {
      console.warn('历史写入超配额，开始丢弃正文缓存', err);
    }

    for (let i = this.history.length - 1; i >= 0; i--) {
      if (!this.history[i].content) continue;
      delete this.history[i].content;
      try {
        attempt(this.history);
        return;
      } catch { /* 继续丢下一条 */ }
    }

    try {
      attempt(this.history);
    } catch (err) {
      console.error('历史记录保存失败，已放弃', err);
    }
  }

  updateHistory() {
    const file = this.state.currentFile;
    if (!file) return;

    // 同名视为同一份文档：先摘掉旧记录再插到队首
    this.history = this.history.filter((h) => h.path !== file.path);
    this.history.unshift({
      path: file.path,
      name: file.path,
      time: file.modifiedTime,
      size: file.size,
      // 超过单篇上限就不缓存正文，点击时降级
      content: file.content.length <= MD_CACHE_MAX_ONE ? file.content : undefined,
    });
    this.history = this.history.slice(0, MD_HISTORY_MAX);

    // 总量封顶：从最旧的开始摘正文，直到落回预算内
    let total = this.history.reduce((n, h) => n + (h.content ? h.content.length : 0), 0);
    for (let i = this.history.length - 1; i >= 0 && total > MD_CACHE_MAX_TOTAL; i--) {
      if (!this.history[i].content) continue;
      total -= this.history[i].content.length;
      delete this.history[i].content;
    }

    this.saveHistory();
    this.renderHistory();
  }

  renderHistory() {
    const list = this.els.historyList;
    if (!list) return;

    list.textContent = '';
    const currentPath = this.state.currentFile?.path;

    this.history.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'md-history-item';
      btn.classList.toggle('active', item.path === currentPath);
      btn.setAttribute('data-path', item.path);

      // 文件名来自用户磁盘，走 textContent 而非 innerHTML，避免带标签的文件名注入侧栏
      const name = document.createElement('span');
      name.className = 'md-history-name';
      name.textContent = this.baseName(item.name);

      const time = document.createElement('span');
      time.className = 'md-history-time';
      const stamp = new Date(item.time).toLocaleString('zh-CN');
      time.textContent = item.content ? stamp : `${stamp} · 需重新选择`;

      btn.append(name, time);
      // 列表只显示短名，完整路径留给悬停
      btn.title = item.content ? item.path : `${item.path}（正文未缓存，点击后需重新选择文件）`;
      list.appendChild(btn);
    });

    this.syncHistoryPanel();
  }

  handleHistoryClick(e) {
    const el = e.target.closest('.md-history-item');
    if (!el) return;

    const path = el.getAttribute('data-path');
    const item = this.history.find((h) => h.path === path);
    if (!item) return;

    if (!item.content) {
      // 正文没缓存（超限或被配额挤掉）。Tauri 下 path 是真实绝对路径，可直接重读盘。
      // 但 Web 模式存进 history 的 path 是裸文件名（浏览器不给绝对路径），
      // 而 dev 模式下 webview 与浏览器同源、共享 localStorage，桌面版完全可能读到这种老条目——
      // 拿裸文件名去 /api/fs/read 只会换回一句「仅支持绝对路径」的天书，不如直接请用户重选。
      // 正则覆盖 Windows 盘符 / UNC / Unix 三种形态，与后端 path.isAbsolute 的判定对齐，不更严。
      const reReadable = window.tauriApi?.isTauri && /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(item.path);
      if (reReadable) {
        this.openFileByPath(item.path);
      } else {
        this.showToast(`「${this.baseName(item.name)}」正文未缓存，请重新选择该文件`);
        this.promptOpenFile();
      }
      return;
    }

    this.loadDocument({
      path: item.path,
      content: item.content,
      modifiedTime: item.time,
      size: item.size ?? item.content.length,
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
