# ScrambleText 动画统一 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 anime.js 官方 `scrambleText` API 统一状态行和工具调用行的动画效果，实现视觉一致的"乱码→落定"过渡，同时删除 ~85 行手写 rAF scramble 代码。

**Architecture:** 前端无后端改动。替换两处动画实现从手写 rAF + 逐字淡入，统一为官方 `scrambleText` API。CDN 升级最新 anime.js v4，删除 `_manualScramble` 函数及相关变量，简化 `animateStatusText` 和 `animateToolLine` 两个函数。

**Tech Stack:** anime.js v4 IIFE（含 scrambleText text plugin）、纯 JavaScript（无框架依赖）

---

## Task 1: 升级 CDN — 引入官方 scrambleText API

**Files:**
- Modify: `public/index.html:323`

- [ ] **Step 1: 查看当前 anime.js CDN 链接**

打开 `public/index.html`，找到 L323：
```html
<script src="https://cdn.jsdelivr.net/npm/animejs@4.0.2/lib/anime.iife.min.js"></script>
```

- [ ] **Step 2: 更新 CDN 链接到最新稳定版**

替换为：
```html
<script src="https://cdn.jsdelivr.net/npm/animejs/lib/anime.iife.min.js"></script>
```

**原因**：锁定最新 v4，确保 `scrambleText` text plugin 可用。若需要显式加载 txt plugin，则在下行追加（见 Step 3）。

- [ ] **Step 3: 验证 scrambleText 可用性（可选补充）**

若测试发现 IIFE 主包不含 `scrambleText`，在 L323 下添加：
```html
<script src="https://cdn.jsdelivr.net/npm/animejs/lib/plugins/txt.iife.min.js"></script>
```

但通常主 IIFE 已包含，无需此步骤。

- [ ] **Step 4: 提交**

```bash
git add public/index.html
git commit -m "chore: upgrade anime.js to latest v4 with scrambleText support"
```

---

## Task 2: 删除手写 scramble 实现

**Files:**
- Modify: `public/app.js:2556-2831`（AnimeAnimations 对象内）

- [ ] **Step 1: 定位 _manualScramble 函数**

打开 `public/app.js`，找到：
```javascript
function _manualScramble(el, text, duration, chars) {
  // 大约 L2663-2680
}
```

及关联变量：
- `_statusScramble` （L2660）
- `_scrambleChars` （L2662）

- [ ] **Step 2: 验证这些变量仅在 animateStatusText 中使用**

搜索 `_manualScramble` 和 `_statusScramble`，确认只在 `animateStatusText` 函数中调用，无其他依赖。

预期搜索结果：
- `_statusScramble` 仅在 L2660（声明）和 L2690-2696（animateStatusText 中）出现

- [ ] **Step 3: 删除 _manualScramble 函数体**

从 L2663 删除至 L2680（完整函数）。

删除这段：
```javascript
function _manualScramble(el, text, duration, chars) {
  let raf;
  const start = performance.now();
  const len = text.length;
  function frame(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const settled = Math.floor(progress * len);
    let out = '';
    for (let i = 0; i < len; i++) {
      out += i < settled ? text[i] : chars[Math.floor(Math.random() * chars.length)];
    }
    el.textContent = out;
    if (progress < 1) {
      raf = requestAnimationFrame(frame);
    } else {
      raf = null;
    }
  }
  raf = requestAnimationFrame(frame);
  return {
    cancel: () => {
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
```

- [ ] **Step 4: 删除关联变量**

删除：
```javascript
let _statusScramble = null;
let _lastStatusText = '';
const _scrambleChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ·▪▫◆◇';
```

这三行通常在 L2660-2662。

- [ ] **Step 5: 提交**

```bash
git add public/app.js
git commit -m "refactor: remove manual scramble implementation from animateStatusText"
```

---

## Task 3: 重写 animateStatusText 函数

**Files:**
- Modify: `public/app.js:2683-2697`（animateStatusText 函数）

- [ ] **Step 1: 查看当前 animateStatusText 实现**

找到该函数，当前约为：
```javascript
let _lastStatusText = '';
function animateStatusText(el, newText) {
  if (!el || newText === _lastStatusText) return;
  _lastStatusText = newText;
  if (_statusScramble && typeof _statusScramble.cancel === 'function') {
    _statusScramble.cancel();
  }
  el.textContent = newText;
  if (!hasAnime()) return;
  // 用原生 scramble 替代 anime.scrambleText（v4 IIFE 不含此 API）
  _statusScramble = _manualScramble(el, newText, 500, _scrambleChars);
}
```

- [ ] **Step 2: 删除函数内的所有 _statusScramble 相关逻辑**

删除这部分：
```javascript
if (_statusScramble && typeof _statusScramble.cancel === 'function') {
  _statusScramble.cancel();
}
```

- [ ] **Step 3: 替换 scramble 调用为官方 API**

将：
```javascript
_statusScramble = _manualScramble(el, newText, 500, _scrambleChars);
```

替换为：
```javascript
anime.animate(el, {
  scrambleText: newText,
  duration: 500,
});
```

- [ ] **Step 4: 验证最终代码**

最终 `animateStatusText` 应为：
```javascript
let _lastStatusText = '';
function animateStatusText(el, newText) {
  if (!el || newText === _lastStatusText) return;
  _lastStatusText = newText;
  el.textContent = newText;
  if (!hasAnime()) return;
  
  // 使用官方 scrambleText API
  anime.animate(el, {
    scrambleText: newText,
    duration: 500,
  });
}
```

共 ~10 行（删减约 5 行）。

- [ ] **Step 5: 提交**

```bash
git add public/app.js
git commit -m "refactor: use anime.js scrambleText API in animateStatusText"
```

---

## Task 4: 重写 animateToolLine 函数

**Files:**
- Modify: `public/app.js:2700-2749`（animateToolLine 函数）

- [ ] **Step 1: 查看当前 animateToolLine 实现**

找到函数，当前约为：
```javascript
let _lastToolText = '';
function animateToolLine(containerEl, newText) {
  if (!containerEl) return;
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

  if (!prevText || !hasAnime()) {
    // 首条或无动画库：直接显示
    return;
  }

  // 修复：v4 IIFE bundle 不含 anime.splitText，手动拆分字符并逐字动画
  try {
    txt.innerHTML = '';
    const charEls = [...newText].map(ch => {
      const span = document.createElement('span');
      span.style.display = 'inline-block';
      span.textContent = ch === ' ' ? ' ' : ch;
      txt.appendChild(span);
      return span;
    });
    anime.animate(charEls, {
      opacity: [0, 1],
      translateY: [6, 0],
      duration: 400,
      delay: anime.stagger(25),
      easing: 'easeOutCubic',
    });
  } catch(e) {
    // 最终降级：整体淡入
    txt.style.opacity = '0';
    try {
      anime.animate(txt, { opacity: [0, 1], duration: 300 });
    } catch(e2) {
      txt.style.opacity = '1';
    }
  }
}
```

- [ ] **Step 2: 理解新设计**

新设计的关键改变：
- 不再删除/重建 span，而是**复用** `.tool-text-anim` span
- 每次仅更新 `txt.textContent`，再对同一 span 发起新 scramble 动画
- anime.js 自动处理新动画对旧动画的替换（无闪烁）

- [ ] **Step 3: 清空函数体**

删除 try-catch 及逐字动画逻辑，保留基础结构。新函数从这里开始编写。

- [ ] **Step 4: 编写完整新实现**

```javascript
let _lastToolText = '';
function animateToolLine(containerEl, newText) {
  if (!containerEl || newText === _lastToolText) return;
  _lastToolText = newText;

  // 获取或创建 txt span
  let txt = containerEl.querySelector('.tool-text-anim');
  if (!txt) {
    containerEl.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = 'tool-dot';
    txt = document.createElement('span');
    txt.className = 'tool-text-anim';
    containerEl.appendChild(dot);
    containerEl.appendChild(txt);
  }

  txt.textContent = newText;
  if (!hasAnime()) return;
  
  // 使用官方 scrambleText API
  anime.animate(txt, {
    scrambleText: newText,
    duration: 500,
  });
}
```

- [ ] **Step 5: 验证代码长度**

新代码应约 ~15 行（相比原来 ~48 行，减少 ~33 行）。

- [ ] **Step 6: 提交**

```bash
git add public/app.js
git commit -m "refactor: use anime.js scrambleText API in animateToolLine with element reuse"
```

---

## Task 5: 本地测试 — 动画流畅性

**Files:**
- Test: 手动交互测试（无单元测试）

- [ ] **Step 1: 启动开发服务**

```bash
npm start
# 或根据项目启动脚本
node src/entrypoints/web/server.js
```

浏览器打开 `http://127.0.0.1:3000`（或配置的端口）。

- [ ] **Step 2: 发送一条简单任务**

在聊天框输入：
```
你好
```

点击发送。观察运行态：

- [ ] **Step 3: 验收 — 状态行动画**

等待任务运行时，观察状态行（"⏳ 读取 / 执行" 等文字）：
- ✓ 文字从乱码（随机字符）逐步变为真实内容
- ✓ 动画时长约 500ms
- ✓ 乱码字符风格与工具行一致（官方预设，无中文符号）
- ✓ 落定时平滑，无闪烁

**若不符合**：检查 CDN 是否加载成功（打开浏览器开发者工具 → Network → 搜索 `anime`）。

- [ ] **Step 4: 验收 — 工具行动画**

运行涉及多工具调用的任务（如编程任务），观察工具行（"读取 xxx.js / 编辑 yyy.ts" 等）：
- ✓ 第一个工具出现时，从乱码→真实名称，500ms 落定
- ✓ 第二个工具出现时，前一个乱码**无闪烁地**变为新工具名称的乱码→落定
- ✓ 圆点常驻，仅文字部分参与动画
- ✓ 无文字重复、无抖动

**若不符合**：检查 `querySelector('.tool-text-anim')` 是否正确复用了 span。

- [ ] **Step 5: 验收 — 降级测试（可选）**

打开浏览器开发者工具 Console，执行：
```javascript
// 临时禁用 anime
window.anime = undefined;
```

发送新任务，观察：
- ✓ 状态行文字直接显示，无动画（无错误）
- ✓ 工具行文字直接显示，无动画（无错误）
- ✓ 功能完整，仅无动效

- [ ] **Step 6: 提交测试笔记（若有）**

若发现任何问题，记录到 commit message 或 TODO。通常无需额外提交。

```bash
git log --oneline -5
# 应看到最近 3-4 个 commit：
# - "refactor: use anime.js scrambleText API in animateToolLine..."
# - "refactor: use anime.js scrambleText API in animateStatusText"
# - "refactor: remove manual scramble implementation..."
# - "chore: upgrade anime.js to latest v4..."
```

---

## Task 6: 代码审查 — 自检清单

**Files:**
- Review: `public/index.html`、`public/app.js`

- [ ] **Step 1: 检查 CDN 链接有效性**

打开 `public/index.html`，L323 应为：
```html
<script src="https://cdn.jsdelivr.net/npm/animejs/lib/anime.iife.min.js"></script>
```

确认链接格式正确（无拼写错误）。

- [ ] **Step 2: 检查已删除的代码**

搜索以下关键词，确保**不存在**：
- `_manualScramble`
- `_scrambleChars`
- `const _statusScramble`

预期结果：0 个匹配。

- [ ] **Step 3: 检查函数签名一致性**

两个新函数都调用：
```javascript
anime.animate(el, {
  scrambleText: newText,
  duration: 500,
});
```

确认：
- 都用 `duration: 500` （统一）
- 都用 `scrambleText: newText` （无拼写错误）
- `el` 或 `txt` 指向正确的 DOM 元素

- [ ] **Step 4: 检查变量声明**

验证两个 `_lastStatusText` 和 `_lastToolText` 仍在 AnimeAnimations 闭包内，作用域正确。

- [ ] **Step 5: 检查 hasAnime() 调用**

两个函数都有：
```javascript
if (!hasAnime()) return;
```

确认无遗漏（降级保护）。

- [ ] **Step 6: 通过审查**

若所有检查通过，记录：

```bash
git log -1
# 应显示最后一条 commit
```

---

## Task 7: 最终清理 + 提交整合

**Files:**
- Summary: 所有已修改文件

- [ ] **Step 1: 查看完整改动摘要**

```bash
git log --oneline --graph -5
```

预期输出约为：
```
* abc1234 refactor: use anime.js scrambleText API in animateToolLine with element reuse
* def5678 refactor: use anime.js scrambleText API in animateStatusText
* ghi9012 refactor: remove manual scramble implementation from animateStatusText
* jkl3456 chore: upgrade anime.js to latest v4 with scrambleText support
```

- [ ] **Step 2: 确认无未提交文件**

```bash
git status
```

应输出：
```
On branch ...
nothing to commit, working tree clean
```

若有遗漏，执行 `git add` 和 `git commit`。

- [ ] **Step 3: 运行最终手动验证**

重新打开浏览器，清空缓存（Ctrl+Shift+Delete），刷新页面（F5）。

发送一条任务，再次观察：
- ✓ 状态行乱码→落定，500ms
- ✓ 工具行乱码→落定，500ms
- ✓ 无闪烁、无错误

- [ ] **Step 4: 撰写实现摘要**

可选：为项目 README 或变更日志添加：

```markdown
### 改进：anime.js 动画统一化

- 升级 anime.js 到最新 v4，引入官方 `scrambleText` API
- 状态行和工具调用行统一采用"乱码→落定"动画，时长 500ms
- 删除 ~85 行手写 scramble 实现，代码更简洁
- 无缝过渡：快速连续工具调用时自动覆盖，无闪烁
```

- [ ] **Step 5: 最终确认**

```bash
git status
git log --oneline -5
```

所有改动已提交，工作树干净。✓

---

## 自审检查清单

**Spec 覆盖**：
- ✓ "CDN 升级" → Task 1
- ✓ "删除 _manualScramble" → Task 2
- ✓ "状态行改用 scrambleText" → Task 3
- ✓ "工具行改用 scrambleText + 无缝过渡" → Task 4
- ✓ "本地验收测试" → Task 5
- ✓ "代码审查" → Task 6

**代码一致性**：
- ✓ 两处动画都用 `duration: 500`
- ✓ 两处都调用 `anime.animate()`
- ✓ 两处都有 `hasAnime()` 降级保护
- ✓ `_lastStatusText` 和 `_lastToolText` 作用域正确

**无占位符**：
- ✓ 所有 git 命令完整、可直接执行
- ✓ 所有代码展示完整，无 "implement later" 或 "TBD"
- ✓ 测试步骤明确指出验收标准和预期输出
- ✓ 所有函数签名、变量名在多个任务中一致

**测试覆盖**：
- ✓ 手动测试：状态行、工具行、连续工具更新、降级场景
- ✓ 无需单元测试（UI 动画，纯前端渲染）

---

## 执行指南

此计划适合以下两种执行方式：

**选项 1：Subagent-Driven（推荐）**
- 由 `superpowers:subagent-driven-development` 逐任务分派，每任务独立审查
- 快速迭代，较少上下文丢失

**选项 2：Inline Execution**
- 由 `superpowers:executing-plans` 在本会话中顺序执行，设置检查点
- 更快但需手动把握节奏

选择哪种执行方式？
