# Anime.js 动画集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 web 执行台中引入 anime.js，实现4个动画效果：空页面SVG描边动画、Claude状态文字scramble切换、工具调用最新条目clone过渡、流式输出scramble渲染。

**Architecture:** CDN 引入 anime.js v4（ES module via jsDelivr），在 `public/app.js` 中追加一个 `AnimeAnimations` 模块对象，封装所有动画逻辑；各动画在现有代码的关键节点（`jobStatusText`、`paintJob`、`typeTick`、`newConversation`）处调用。不动 HTML 结构（除 `#empty` 中加 SVG 和在 `index.html` 加 CDN script）。

**Tech Stack:** anime.js v4 (CDN ESM)，vanilla JS，CSS 变量复用现有配色。

---

## 文件变更地图

| 文件 | 操作 | 说明 |
|------|------|------|
| `public/index.html` | 修改 | 加 anime.js CDN script（importmap + ESM），`#empty` 中嵌入 SVG |
| `public/app.js` | 修改 | 追加 `AnimeAnimations` 对象；修改 `jobStatusText` 使用点、`paintJob`、`typeTick`、`newConversation`、`renderToolLog` 调用动画 |
| `public/app.css` | 修改 | 添加 `#empty` SVG 区域样式、`.tool-log` 动画相关样式、`.stream-scramble` 样式 |

---

## Task 1: 引入 anime.js CDN + 改造 #empty 空页面

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.css`

### 背景知识
anime.js v4 是 ES module only，通过 importmap 引入：
```html
<script type="importmap">
  { "imports": { "animejs": "https://cdn.jsdelivr.net/npm/animejs@4.0.2/lib/anime.esm.min.js" } }
</script>
```
然后 `public/app.js` 顶部（因为它是普通 script，不是 module）要改为 module 或改用全局挂载方式。

**注意：** 现有 `app.js` 是普通 `<script src="/app.js">` 加载，不是 ES module。为了避免大改，改用 **UMD/IIFE 版本的 CDN**（anime.js v4 提供 iife 版本）：
```
https://cdn.jsdelivr.net/npm/animejs@4.0.2/lib/anime.iife.min.js
```
这样 anime.js 挂载到全局 `window.anime`，`app.js` 直接使用 `anime` 即可，和 lottie 的引入方式完全一致。

- [ ] **Step 1: 在 index.html 加入 anime.js CDN（iife版本）**

在 `public/index.html` 的 `<!-- Lottie 动画库 -->` 那行**之前**插入：
```html
    <!-- Anime.js 动画库 -->
    <script src="https://cdn.jsdelivr.net/npm/animejs@4.0.2/lib/anime.iife.min.js"></script>
```

最终 script 顺序：
```html
    <script src="/vendor/marked.min.js"></script>
    <!-- Anime.js 动画库 -->
    <script src="https://cdn.jsdelivr.net/npm/animejs@4.0.2/lib/anime.iife.min.js"></script>
    <!-- Lottie 动画库 -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js"></script>
    <script src="/app.js"></script>
```

- [ ] **Step 2: 改造 #empty，嵌入 SVG + VIBE CODING 文案**

在 `public/index.html` 中将现有：
```html
        <div class="empty" id="empty">
          <div class="big">◆</div>
          <div>本机订阅驱动 · 完整 Claude 能力</div>
          <div style="color: var(--faint)">选好工作目录，在下方输入开始对话</div>
        </div>
```

替换为：
```html
        <div class="empty" id="empty">
          <svg class="vibe-svg" id="vibeSvg" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
            <!-- 外框菱形 -->
            <path id="vp1" d="M100 10 L190 100 L100 190 L10 100 Z" stroke="#d97757" stroke-width="1.5"/>
            <!-- 内框菱形 -->
            <path id="vp2" d="M100 35 L165 100 L100 165 L35 100 Z" stroke="#d97757" stroke-width="1" opacity="0.5"/>
            <!-- 中心十字 -->
            <path id="vp3" d="M100 60 L100 140 M60 100 L140 100" stroke="#d97757" stroke-width="1" opacity="0.4"/>
            <!-- 四角小菱形 -->
            <path id="vp4" d="M100 18 L108 26 L100 34 L92 26 Z" stroke="#d97757" stroke-width="1" fill="rgba(217,119,87,0.15)"/>
          </svg>
          <div class="vibe-title" id="vibeTitle">VIBE CODING</div>
          <div class="vibe-sub">本机订阅驱动 · 完整 Claude 能力</div>
          <div class="vibe-hint">选好工作目录，在下方输入开始对话</div>
        </div>
```

- [ ] **Step 3: 添加 #empty 区域的 CSS 样式**

在 `public/app.css` 中找到现有 `.empty` 相关样式（搜索 `.empty`），将其替换/追加以下样式（保留原有的 display:flex 等布局）。在文件末尾追加：
```css
      /* ---- Anime.js 动画：空页面 ---- */
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 16px;
        height: 100%;
        color: var(--muted);
      }
      .vibe-svg {
        width: 120px;
        height: 120px;
        filter: drop-shadow(0 0 12px rgba(217,119,87,0.3));
      }
      .vibe-title {
        font-size: 22px;
        font-weight: 700;
        letter-spacing: 0.18em;
        color: var(--accent);
        font-family: var(--mono);
      }
      .vibe-sub {
        font-size: 13px;
        color: var(--muted);
      }
      .vibe-hint {
        font-size: 12px;
        color: var(--faint);
      }
```

- [ ] **Step 4: 验证 CDN 加载**

打开浏览器开发工具 Console，刷新页面，运行：
```javascript
typeof anime
```
预期输出：`"function"` 或 `"object"`（说明 anime.js 已正确加载到全局）。

---

## Task 2: 空页面 createDrawable SVG 描边动画

**Files:**
- Modify: `public/app.js`（在文件末尾追加 `AnimeAnimations` 对象，并修改 `newConversation` 函数）

### anime.js createDrawable API 说明
```javascript
// createDrawable 让 SVG path 支持 draw 属性（描边从0到1）
const drawable = anime.createDrawable('#vp1');
anime({
  targets: drawable,
  draw: ['0 0', '0 1'],  // [起点偏移, 终点比例]
  duration: 1200,
  easing: 'easeInOutSine'
});
```

- [ ] **Step 5: 在 app.js 末尾追加 AnimeAnimations 模块**

在 `public/app.js` **末尾**（第2027行之后）追加以下完整代码块：

```javascript

      // ============================================================
      // AnimeAnimations：集中管理所有 anime.js 动画
      // ============================================================
      const AnimeAnimations = (() => {
        // 安全检查：anime.js 未加载时静默降级
        function hasAnime() { return typeof anime !== 'undefined'; }

        // ---------- 1. 空页面 SVG 描边动画 ----------
        let _vibeDrawn = false; // 避免重复播放
        function playVibeAnimation() {
          if (!hasAnime()) return;
          const svgEl = document.getElementById('vibeSvg');
          const titleEl = document.getElementById('vibeTitle');
          if (!svgEl || !titleEl) return;

          // 重置状态（每次显示空页面时重新播放）
          _vibeDrawn = false;
          titleEl.style.opacity = '0';

          const paths = ['#vp1', '#vp2', '#vp3', '#vp4'];
          const drawables = paths.map(sel => {
            const el = svgEl.querySelector(sel.slice(1));
            if (!el) return null;
            try { return anime.createDrawable(el); } catch(e) { return null; }
          }).filter(Boolean);

          if (!drawables.length) {
            titleEl.style.opacity = '1';
            return;
          }

          // 描边动画：各路径依次登场
          const tl = anime.createTimeline({ easing: 'easeInOutSine' });
          drawables.forEach((d, i) => {
            tl.add({
              targets: d,
              draw: ['0 0', '0 1'],
              duration: 900,
              delay: i * 180,
            }, i === 0 ? 0 : `<+${i * 180}`);
          });

          // 描边结束后，VIBE CODING 文字淡入
          tl.add({
            targets: titleEl,
            opacity: [0, 1],
            translateY: [8, 0],
            duration: 600,
            easing: 'easeOutCubic',
            complete: () => { _vibeDrawn = true; }
          });
        }

        // ---------- 2. 状态文字 scramble 动画 ----------
        let _statusScramble = null;
        let _lastStatusText = '';
        function animateStatusText(el, newText) {
          if (!hasAnime() || !el) return;
          if (newText === _lastStatusText) return; // 文字未变化，跳过
          _lastStatusText = newText;
          // 取消上一个动画
          if (_statusScramble && typeof _statusScramble.cancel === 'function') {
            _statusScramble.cancel();
          }
          el.textContent = newText; // 先设置，scramble 会接管
          try {
            _statusScramble = anime.scrambleText(el, {
              text: newText,
              duration: 600,
              chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ·▪▫◆◇',
              speed: 0.4,
            });
          } catch(e) {
            // fallback：直接赋文字
            el.textContent = newText;
          }
        }

        // ---------- 3. 工具调用：仅显示最新1条，新条目 clone 过渡 ----------
        let _lastToolText = '';
        function animateToolLine(containerEl, newText) {
          if (!hasAnime() || !containerEl) return;
          if (newText === _lastToolText) return;

          const prevText = _lastToolText;
          _lastToolText = newText;

          // 清空容器，插入新行
          containerEl.innerHTML = '';
          const dot = document.createElement('span');
          dot.className = 'tool-dot';
          const txt = document.createElement('span');
          txt.className = 'tool-text-anim';
          txt.textContent = newText;
          containerEl.appendChild(dot);
          containerEl.appendChild(txt);

          if (!prevText) {
            // 首条直接显示，无需动画
            return;
          }

          try {
            // splitText clone 效果：新文字逐字从下方进入
            const split = anime.splitText(txt, { type: 'chars' });
            anime({
              targets: split.chars,
              opacity: [0, 1],
              translateY: [6, 0],
              duration: 400,
              delay: anime.stagger(25),
              easing: 'easeOutCubic',
            });
          } catch(e) {
            // fallback：简单淡入
            txt.style.opacity = '0';
            anime({ targets: txt, opacity: [0, 1], duration: 300 });
          }
        }

        // ---------- 4. 流式输出 scramble chars 渲染 ----------
        let _streamScramble = null;
        let _streamEl = null;
        function startStreamScramble(el, text) {
          if (!hasAnime() || !el) return;
          _streamEl = el;
          if (_streamScramble && typeof _streamScramble.cancel === 'function') {
            _streamScramble.cancel();
          }
          try {
            _streamScramble = anime.scrambleText(el, {
              text: text,
              duration: Math.min(text.length * 18, 800),
              chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%',
              speed: 0.6,
            });
          } catch(e) {
            el.textContent = text;
          }
        }
        function stopStreamScramble() {
          if (_streamScramble && typeof _streamScramble.cancel === 'function') {
            _streamScramble.cancel();
            _streamScramble = null;
          }
          _streamEl = null;
        }

        // 重置工具行状态（新对话时调用）
        function resetToolState() {
          _lastToolText = '';
          _lastStatusText = '';
          stopStreamScramble();
        }

        return {
          playVibeAnimation,
          animateStatusText,
          animateToolLine,
          startStreamScramble,
          stopStreamScramble,
          resetToolState,
        };
      })();
```

- [ ] **Step 6: 在 newConversation 中触发空页面动画**

在 `app.js` 中找到 `function newConversation()` 函数，它的内容是：
```javascript
      function newConversation() {
        showView('chat');
        currentConvId = null;
        currentSession = null;
        messagesEl.querySelectorAll('.msg').forEach((m) => m.remove());
        emptyEl.style.display = '';
        emptyEl.querySelector('div:nth-child(2)').textContent = '已开始新对话';
        updateComposerRunning();
        renderConvList();
        renderPendingBanner();
      }
```

**问题：** `emptyEl.querySelector('div:nth-child(2)')` 在新 HTML 结构下会选错元素（原来 empty 里有3个 div，现在改成了 SVG + 3个div）。

将其替换为：
```javascript
      function newConversation() {
        showView('chat');
        currentConvId = null;
        currentSession = null;
        messagesEl.querySelectorAll('.msg').forEach((m) => m.remove());
        emptyEl.style.display = '';
        AnimeAnimations.resetToolState();
        // 触发空页面 SVG 描边动画
        requestAnimationFrame(() => AnimeAnimations.playVibeAnimation());
        updateComposerRunning();
        renderConvList();
        renderPendingBanner();
      }
```

- [ ] **Step 7: 初始加载时也触发空页面动画**

在 `app.js` 末尾的 `// ---- 启动初始化 ----` 区块（约第1990行）末尾，在 `setInterval(refreshTokenStatus, 15000);` 之后追加：

```javascript
      // 首次加载：若空页面可见则播放动画
      requestAnimationFrame(() => {
        if (emptyEl && emptyEl.style.display !== 'none') {
          AnimeAnimations.playVibeAnimation();
        }
      });
```

- [ ] **Step 8: 验证空页面动画**

1. 刷新页面（无历史对话时应显示 `#empty`）
2. 预期：SVG 菱形路径依次描边绘制，完成后 "VIBE CODING" 文字从下方淡入
3. 点击"新对话"按钮，预期动画重新播放

---

## Task 3: Claude 状态文字 scramble 切换动画

**Files:**
- Modify: `public/app.js`（修改 `paintJob` 函数中状态行渲染部分）

### 背景
当前 `paintJob` 每次调用都重建整个气泡，包括 `.run-status` 元素：
```javascript
const st = document.createElement('div');
st.className = 'run-status';
st.innerHTML = '<span class="spinner"></span><span class="run-text"></span>';
st.querySelector('.run-text').textContent = jobStatusText(job);
vb.appendChild(st);
```
问题是每次重建元素，无法直接对 `.run-text` 做 scramble 动画（因为元素是新的）。

**解决方案：** 状态行复用（不销毁重建），只更新文字 + 触发 scramble。

- [ ] **Step 9: 修改 paintJob 中的状态行更新逻辑**

在 `app.js` 中找到 `function paintJob(job)` 函数，在其内部找到：
```javascript
        if (job.ask) {
          vb.appendChild(renderAskCard(job)); // 等待用户决策：显示选项卡片（替代 spinner）
        } else {
          const st = document.createElement('div');
          st.className = 'run-status';
          st.innerHTML = '<span class="spinner"></span><span class="run-text"></span>';
          st.querySelector('.run-text').textContent = jobStatusText(job);
          vb.appendChild(st);
        }
```

将此段替换为：
```javascript
        if (job.ask) {
          vb.appendChild(renderAskCard(job)); // 等待用户决策：显示选项卡片（替代 spinner）
        } else {
          // 复用已有 .run-status，避免重建元素导致 scramble 动画断裂
          let st = vb.querySelector('.run-status');
          if (!st) {
            st = document.createElement('div');
            st.className = 'run-status';
            st.innerHTML = '<span class="spinner"></span><span class="run-text"></span>';
            vb.appendChild(st);
          }
          const runTextEl = st.querySelector('.run-text');
          const newStatusText = jobStatusText(job);
          AnimeAnimations.animateStatusText(runTextEl, newStatusText);
        }
```

- [ ] **Step 10: 验证状态文字动画**

1. 发送一条消息
2. 观察 Claude 气泡底部的状态行
3. 预期：启动时显示 "运行中…"，有文字输出后切换为 "生成中…"，切换时文字有 scramble 效果（乱码字符快速变换后定格为正确文字）

---

## Task 4: 工具调用展示 —— 最新1条 + clone 过渡

**Files:**
- Modify: `public/app.js`（修改 `renderToolLog` 函数 + `paintJob` 中工具日志渲染）
- Modify: `public/app.css`（添加 `.tool-log-single` 样式）

### 背景
当前 `renderToolLog(activities)` 展示最近12条工具调用，是个完整的 div 列表。需改为：
- 只显示最新1条
- 新工具出现时，旧文字向上淡出（clone），新文字逐字从下方进入（splitText）

- [ ] **Step 11: 改写 renderToolLog 函数**

在 `app.js` 中找到：
```javascript
      // 工具活动转录（最近若干条）
      function renderToolLog(activities) {
        const box = document.createElement('div');
        box.className = 'tool-log';
        for (const a of activities.slice(-12)) {
          const line = document.createElement('div');
          line.className = 'tool-line';
          const dot = document.createElement('span');
          dot.className = 'tool-dot';
          const txt = document.createElement('span');
          txt.textContent = a;
          line.appendChild(dot);
          line.appendChild(txt);
          box.appendChild(line);
        }
        return box;
      }
```

替换为：
```javascript
      // 工具活动转录（仅展示最新1条，带 clone 过渡动画）
      function renderToolLog(activities) {
        const box = document.createElement('div');
        box.className = 'tool-log tool-log-single';
        if (!activities || !activities.length) return box;
        const latest = activities[activities.length - 1];
        // 动画由 AnimeAnimations.animateToolLine 接管，box 作为容器传入
        // 此处先填充内容（paintJob 结束后 animateToolLine 会被调用）
        const dot = document.createElement('span');
        dot.className = 'tool-dot';
        const txt = document.createElement('span');
        txt.className = 'tool-text-anim';
        txt.textContent = latest;
        box.appendChild(dot);
        box.appendChild(txt);
        box._latestText = latest; // 暂存最新文字，供 paintJob 中使用
        return box;
      }
```

- [ ] **Step 12: 在 paintJob 中调用 animateToolLine**

在 `app.js` 的 `paintJob` 函数中，找到：
```javascript
        if (job.activities && job.activities.length) vb.appendChild(renderToolLog(job.activities));
```

替换为：
```javascript
        if (job.activities && job.activities.length) {
          // 复用已有 tool-log 容器（避免 DOM 重建导致动画重置）
          let toolBox = vb.querySelector('.tool-log-single');
          const latest = job.activities[job.activities.length - 1];
          if (!toolBox) {
            toolBox = renderToolLog(job.activities);
            vb.appendChild(toolBox);
            // 首次插入，无需动画
          } else {
            // 复用容器，仅更新内容并触发动画
            AnimeAnimations.animateToolLine(toolBox, latest);
          }
        }
```

- [ ] **Step 13: 添加 .tool-log-single 样式**

在 `public/app.css` 末尾追加：
```css
      /* ---- Anime.js 动画：工具调用单行展示 ---- */
      .tool-log-single {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        margin-top: 8px;
        border-left: 2px solid var(--accent);
        background: rgba(217,119,87,0.06);
        border-radius: 0 4px 4px 0;
        font-size: 12px;
        color: var(--muted);
        min-height: 28px;
        overflow: hidden;
      }
      .tool-text-anim {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
```

- [ ] **Step 14: 验证工具动画**

1. 发送一个会调用工具的提示（例如："列出当前目录下的文件"）
2. 观察气泡中的工具调用区域
3. 预期：只显示最新一条工具调用文字；新工具出现时，文字逐字从下方淡入（splitText 效果）

---

## Task 5: 流式输出 scramble chars 渲染

**Files:**
- Modify: `public/app.js`（修改 `typeTick` 函数 + `paintJob` 中 markdown 渲染）
- Modify: `public/app.css`（添加 `.stream-cursor` 样式）

### 背景
当前流式输出通过 `typeTick` 控制 `job.shown` 平滑推进，调用 `paintJob` 刷新气泡。

**方案：** 在气泡末尾追加一个 `.stream-tail` 元素，对"最新未渲染的文字片段"进行 scramble 渲染。已完成渲染的部分仍走 markdown。

### 重要约束
- scramble 是短时效果（每个新 chunk 都触发一次，时长约300-500ms）
- `endJob` 时必须停止 scramble，防止动画越界

- [ ] **Step 15: 修改 typeTick，在新 chunk 到来时触发 scramble**

在 `app.js` 中找到 `function typeTick()` 函数：
```javascript
      function typeTick() {
        const job = currentConvId ? runningJobs[currentConvId] : null;
        if (!job) {
          clearInterval(typeTimer);
          typeTimer = null;
          return;
        }
        if (job.shown < job.text.length) {
          // 自适应步进：落后越多走越快，避免大突发长时间追不上
          const backlog = job.text.length - job.shown;
          job.shown = Math.min(job.text.length, job.shown + Math.max(2, Math.ceil(backlog / 8)));
        }
        const status = jobStatusText(job);
        if (
          job.shown !== job._paintedShown ||
          status !== job._paintedStatus ||
          job.rev !== job._paintedRev
        ) {
          job._paintedShown = job.shown;
          job._paintedStatus = status;
          job._paintedRev = job.rev;
          paintJob(job);
        }
      }
```

在 `paintJob(job);` 调用**之前**，追加流式 scramble 触发逻辑，将整个 `typeTick` 替换为：
```javascript
      function typeTick() {
        const job = currentConvId ? runningJobs[currentConvId] : null;
        if (!job) {
          clearInterval(typeTimer);
          typeTimer = null;
          return;
        }
        const prevShown = job.shown;
        if (job.shown < job.text.length) {
          const backlog = job.text.length - job.shown;
          job.shown = Math.min(job.text.length, job.shown + Math.max(2, Math.ceil(backlog / 8)));
        }
        const status = jobStatusText(job);
        if (
          job.shown !== job._paintedShown ||
          status !== job._paintedStatus ||
          job.rev !== job._paintedRev
        ) {
          job._paintedShown = job.shown;
          job._paintedStatus = status;
          job._paintedRev = job.rev;
          paintJob(job);
          // 流式输出时：对最新新增的文字片段触发 scramble
          if (job.shown > prevShown && job.shown < job.text.length + 1) {
            const vb = bubbleAt(job.asstIndex);
            if (vb) {
              let tail = vb.querySelector('.stream-tail');
              if (!tail) {
                tail = document.createElement('span');
                tail.className = 'stream-tail';
                vb.appendChild(tail);
              }
              const newChunk = job.text.slice(prevShown, job.shown);
              if (newChunk.trim()) { // 只对有实质内容的 chunk 做 scramble
                AnimeAnimations.startStreamScramble(tail, newChunk);
              }
            }
          }
        }
      }
```

- [ ] **Step 16: 在 endJob 中清理 stream scramble + 移除 .stream-tail**

在 `app.js` 中找到 `function endJob(convId, isErr)` 函数，在 `delete runningJobs[convId];` 之前追加：
```javascript
        // 停止流式 scramble 动画
        AnimeAnimations.stopStreamScramble();
        // 移除临时 stream-tail 元素（定稿时 renderMarkdown 会重建气泡内容）
        if (convId === currentConvId) {
          const vb = bubbleAt(job.asstIndex);
          if (vb) {
            const tail = vb.querySelector('.stream-tail');
            if (tail) tail.remove();
          }
        }
```

完整的 endJob 函数上下文（修改后）：
```javascript
      function endJob(convId, isErr) {
        const job = runningJobs[convId];
        if (!job) return;
        try {
          job.es.close();
        } catch {}
        if (convId === currentConvId) {
          const vb = bubbleAt(job.asstIndex);
          if (vb) {
            // 停止流式 scramble 动画
            AnimeAnimations.stopStreamScramble();
            const tail = vb.querySelector('.stream-tail');
            if (tail) tail.remove();
            renderMarkdown(vb, job.text);
            if (isErr) vb.classList.add('err');
          }
          if (typeTimer) {
            clearInterval(typeTimer);
            typeTimer = null;
          }
        }
        delete runningJobs[convId];
        if (convId === currentConvId) updateComposerRunning();
        renderConvList();
      }
```

- [ ] **Step 17: 添加 .stream-tail 样式**

在 `public/app.css` 末尾追加：
```css
      /* ---- Anime.js 动画：流式输出 scramble 尾部 ---- */
      .stream-tail {
        display: inline;
        color: var(--accent-hi);
        font-family: var(--mono);
        opacity: 0.9;
      }
```

- [ ] **Step 18: 验证流式输出动画**

1. 发送一条会产生长文输出的提示（例如："写一段100字的自我介绍"）
2. 观察气泡内容的流式输出过程
3. 预期：已渲染文字正常显示，末尾新增的字符有 scramble "解密"效果（乱码字符快速变成正确字母）
4. 输出结束后，scramble 停止，气泡渲染为完整 markdown

---

## Task 6: 收尾与整体验证

**Files:**
- Modify: `public/app.js`（确保 `openConv` 切换时重置状态）

- [ ] **Step 19: 在 openConv 中重置动画状态**

在 `app.js` 的 `function openConv(id)` 函数中，找到 `const c = loadConvs().find((x) => x.id === id);` 之后，在 `messagesEl.querySelectorAll('.msg').forEach((m) => m.remove());` 之前追加：
```javascript
        AnimeAnimations.resetToolState();
        AnimeAnimations.stopStreamScramble();
```

- [ ] **Step 20: 全链路验证**

按以下步骤测试：

1. **空页面动画：** 刷新页面 → SVG 描边 → "VIBE CODING" 淡入 ✓
2. **新对话：** 点"新对话" → 动画重新播放 ✓
3. **状态动画：** 发消息 → 底部状态行 scramble 切换（运行中 → 生成中）✓
4. **工具动画：** 发一个需要工具的提示 → 只显示最新工具，新工具进入时逐字动画 ✓
5. **流式输出：** 发一个长回复提示 → 末尾字符有 scramble 解密效果，结束后正常 markdown ✓
6. **切换会话：** 在两个会话间切换 → 动画状态正确重置，不残留 ✓

- [ ] **Step 21: 提交**

```bash
git add public/index.html public/app.js public/app.css docs/superpowers/plans/2026-07-19-animejs-animations.md
git commit -m "feat: integrate anime.js for vibe coding empty screen, status scramble, tool clone, stream scramble animations"
```

---

## 自我检查

### Spec 覆盖检查
- [x] 空页面 createDrawable SVG 描边 → Task 1 & 2
- [x] "VIBE CODING" 文案 → Task 1（Step 2 HTML 结构）
- [x] 状态切换 scrambleText → Task 3
- [x] 工具调用仅显示最新1条 + clone 过渡 → Task 4
- [x] 流式输出 scramble chars → Task 5

### Placeholder 检查
- 无 TBD / TODO，所有 step 含完整代码

### 类型一致性检查
- `AnimeAnimations.animateStatusText(el, text)` — Task 3 定义，Task 3 Step 9 调用 ✓
- `AnimeAnimations.animateToolLine(box, text)` — Task 2 定义，Task 4 Step 12 调用 ✓
- `AnimeAnimations.startStreamScramble(el, text)` — Task 2 定义，Task 5 Step 15 调用 ✓
- `AnimeAnimations.stopStreamScramble()` — Task 2 定义，Task 5 Step 16 & Task 6 Step 19 调用 ✓
- `AnimeAnimations.resetToolState()` — Task 2 定义，Task 2 Step 6 & Task 6 Step 19 调用 ✓
- `AnimeAnimations.playVibeAnimation()` — Task 2 定义，Task 2 Step 6 & Step 7 调用 ✓
