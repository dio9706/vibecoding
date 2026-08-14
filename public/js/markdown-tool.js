/**
 * Markdown 查看工具
 * 功能：文件打开、内容渲染、目录导航、搜索、导出
 */

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

    // 绑定事件
    this.bindEvents();
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
  }

  setupDragDrop() {
    const panel = document.querySelector('[data-view="markdown"]');
    if (!panel) return;

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
    if (this.state.currentFile) {
      // 已有文件：显示内容区，展示历史面板
      if (this.els.empty) this.els.empty.hidden = true;
      if (this.els.container) this.els.container.hidden = false;
      if (this.els.openHistoryPanel) this.els.openHistoryPanel.hidden = false;
    } else {
      // 无文件：显示空状态提示，收起历史面板
      if (this.els.empty) this.els.empty.hidden = false;
      if (this.els.container) this.els.container.hidden = true;
      if (this.els.openHistoryPanel) this.els.openHistoryPanel.hidden = true;
    }
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
      const modifiedTime = file.lastModified;

      this.state.currentFile = {
        path: file.name,
        content: content,
        modifiedTime: modifiedTime,
        size: file.size,
      };

      this.renderContent();
      this.updateHistory();
      this.showTool();
    } catch (err) {
      console.error('文件读取失败', err);
      this.showToast('文件读取失败');
    }
  }

  // ===== 内容渲染 =====
  renderContent() {
    if (!this.state.currentFile) return;

    const { path, content, modifiedTime, size } = this.state.currentFile;

    // 更新路径和文件信息
    this.els.fileName.textContent = path;
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
      btn.className = 'md-toc-item';
      btn.setAttribute('data-level', item.level);
      btn.setAttribute('data-id', item.id);
      btn.textContent = item.text || '(无标题)';
      this.els.tocTree.appendChild(btn);
    });
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
    if (e.target.classList.contains('md-toc-item')) {
      const id = e.target.getAttribute('data-id');
      const element = document.getElementById(id);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth' });
        this.updateActiveToc(id);
      }
    }
  }

  updateActiveToc(id) {
    this.els.tocTree.querySelectorAll('.md-toc-item').forEach(item => {
      item.classList.toggle('active', item.getAttribute('data-id') === id);
    });
  }

  // ===== 历史记录 =====
  loadHistory() {
    try {
      const json = localStorage.getItem('md-tool-history');
      return json ? JSON.parse(json) : [];
    } catch (err) {
      console.error('历史记录加载失败', err);
      return [];
    }
  }

  saveHistory() {
    localStorage.setItem('md-tool-history', JSON.stringify(this.history.slice(0, 10)));
  }

  updateHistory() {
    const file = this.state.currentFile;
    if (!file) return;

    // 移除重复项
    this.history = this.history.filter(h => h.path !== file.path);
    // 添加到最前
    this.history.unshift({
      path: file.path,
      name: file.path,
      time: file.modifiedTime,
    });
    // 最多保留 10 项
    this.history = this.history.slice(0, 10);

    this.saveHistory();
    this.renderHistory();
  }

  renderHistory() {
    this.els.historyList.innerHTML = '';
    this.history.forEach((item) => {
      const div = document.createElement('button');
      div.className = 'md-history-item';
      div.setAttribute('data-path', item.path);
      div.innerHTML = `
        <div>${item.name}</div>
        <div class="md-history-time">${new Date(item.time).toLocaleString('zh-CN')}</div>
      `;
      this.els.historyList.appendChild(div);
    });
  }

  handleHistoryClick(e) {
    const item = e.target.closest('.md-history-item');
    if (item) {
      const path = item.getAttribute('data-path');
      const historyItem = this.history.find(h => h.path === path);
      if (historyItem && this.state.currentFile) {
        // 重新加载当前文件（在浏览器环境中）
        const file = new File([this.state.currentFile.content], path, {
          type: 'text/markdown',
        });
        this.openFile(file);
      }
    }
  }

  // ===== 导出功能 =====
  exportHtml() {
    if (!this.state.currentFile) return;

    const { path } = this.state.currentFile;
    const html = this.els.content.innerHTML;
    const css = this.getEmbeddedCss();

    const doc = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${path}</title>
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
    a.download = path.replace('.md', '.html');
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
