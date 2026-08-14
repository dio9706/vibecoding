# ScrambleText 动画统一设计

**日期**: 2026-07-19  
**目标**: 用 anime.js 官方 `scrambleText` API 统一状态行和工具调用行的动画效果，实现"乱码→落定"的视觉一致性

---

## 问题背景

当前前端动画实现存在**两种不同的手段**：

1. **状态行**（`animateStatusText`）：手写 rAF scramble（乱码→落定，500ms）
2. **工具行**（`animateToolLine`）：逐字淡入+上移（opacity + translateY，400ms）

两处动画风格不一致，且状态行的手写 scramble 增加了代码复杂度（`_manualScramble` 函数 ~25 行）。

---

## 解决方案

### 目标状态

**统一使用 anime.js 官方 `scrambleText` API**（via text plugin）实现两处动画，产生一致的"乱码逐步解码为真实文字"效果：

- ✅ 状态行：anime.js `scrambleText` + 官方预设字符集 + 500ms
- ✅ 工具行：anime.js `scrambleText` + 官方预设字符集 + 500ms  
- ✅ 无缝过渡：同一元素重复发起动画无闪烁、自然覆盖
- ✅ 降级安全：无 anime.js 时降级为直接 textContent 替换

---

## 实现细节

### 1. CDN 升级（`public/index.html`）

**当前** L323：
```html
<script src="https://cdn.jsdelivr.net/npm/animejs@4.0.2/lib/anime.iife.min.js"></script>
```

**改为**：
```html
<script src="https://cdn.jsdelivr.net/npm/animejs/lib/anime.iife.min.js"></script>
```

若实测 IIFE 主包不含 `scrambleText`，追加补充插件：
```html
<script src="https://cdn.jsdelivr.net/npm/animejs/lib/plugins/txt.iife.min.js"></script>
```

**原因**：锁定最新 v4 稳定版，确保 text plugin 中的 `scrambleText` 可用。

---

### 2. 状态行重构（`app.js` `animateStatusText` 函数）

**删除以下内容**：
- `_manualScramble` 函数（L2663-2680，~25 行）
- `_statusScramble` 变量（L2660）
- `_scrambleChars` 常量（L2662）

**替换为**（新的 `animateStatusText` 函数）：
```javascript
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

**特点**：
- 直接调用 `anime.animate()` 的 `scrambleText` 选项
- 官方预设字符集（通常为 alphanumeric + 符号）
- 500ms 落定，与工具行时长统一
- 无需手写 rAF，代码简洁

---

### 3. 工具行重构（`app.js` `animateToolLine` 函数）

**删除现有逻辑**：手动拆分字符为 span、逐 span 动画（L2701-2749，~48 行）

**替换为**：
```javascript
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

**特点**：
- 复用容器，每次仅更新 `.tool-text-anim` span 的文字
- 圆点 `.tool-dot` 常驻，不参与动画
- 连续调用时，新动画覆盖旧动画（anime.js 内置处理），无闪烁
- 同样使用官方 `scrambleText`，视觉风格与状态行一致

---

### 4. 无缝过渡行为

当工具调用频繁更新时（例如 Claude 连续调用多个工具）：

1. **第一个工具出现**：txt 从空变为"工具 A"，scramble 动画 500ms 落定
2. **第二个工具出现**：txt 仍为"工具 A"，立即 `anime.animate(txt, scrambleText: '工具 B')`，新动画启动
   - anime.js 自动停止旧动画，启动新动画
   - 用户视觉上看到："工具 A"的乱码迅速变为"工具 B"的乱码→落定
   - **无闪烁、无重置、自然过渡**

---

### 5. 降级策略（无 anime.js）

若 CDN 加载失败或浏览器不支持：

- `hasAnime()` 检查返回 false
- 两个函数均跳过 `anime.animate()` 调用
- 文字已通过 `el.textContent = ...` / `txt.textContent = ...` 设置，直接展示（无动效）
- **功能不破坏，只是无动画**

---

## 代码行数影响

| 部分 | 删除 | 新增 | 净变化 |
|------|------|------|--------|
| `_manualScramble` 函数 | 25 | 0 | -25 |
| 变量声明（`_statusScramble`, `_scrambleChars`) | 2 | 0 | -2 |
| `animateStatusText` | ~10 | ~5 | -5 |
| `animateToolLine` | ~48 | ~15 | -33 |
| **合计** | **~85** | **~20** | **-65 行** |

代码更清晰、更短、更少维护负担。

---

## 测试验收标准

1. **状态行动画**：运行任务时，状态文字（"⏳ 读取 / 执行 / ..." 等）从乱码逐步变为真实文字，500ms 落定 ✓
2. **工具行动画**：工具调用时，工具描述（"读取 xxx.js" 等）从乱码→真实文字，500ms 落定 ✓
3. **无缝过渡**：快速连续更新工具行时，无闪烁、动画平滑衔接 ✓
4. **视觉一致**：状态行和工具行的乱码风格、落定时长一致 ✓
5. **降级正常**：禁用 anime.js 时，文字直接显示（无动效），功能无损 ✓

---

## 部署清单

- [ ] 更新 `public/index.html` L323 CDN 链接
- [ ] 修改 `public/app.js` 删除 `_manualScramble` 等
- [ ] 修改 `public/app.js` 重写 `animateStatusText`
- [ ] 修改 `public/app.js` 重写 `animateToolLine`
- [ ] 本地测试：快速运行任务，观察动画流畅性
- [ ] 提交一份新 commit

---

## 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| CDN scrambleText 不可用 | 低 | 无动画 | 补充 txt plugin，或降级方案 |
| 同时发起两个 animate 冲突 | 极低 | 闪烁 | anime.js 已内置自动停止旧任务 |
| 浏览器兼容性 | 极低 | 无动画 | hasAnime() 检查保护 |

**总体风险等级**：极低（官方 API，自动降级）

---

## 相关代码位置

- `public/index.html` L323
- `public/app.js` 
  - L2556 `AnimeAnimations` 对象起始
  - L2558 `hasAnime()` 函数
  - L2660-2662 变量声明
  - L2663-2680 `_manualScramble` 函数
  - L2683-2697 `animateStatusText` 函数
  - L2701-2749 `animateToolLine` 函数
  - L2814-2818 `resetToolState()` 函数

---

## 后续考虑

此改动后，若要进一步优化：
- 可考虑字符集切换（alpha only vs alphanumeric）
- 可考虑不同字符集的配置化（settings）
- 可为其他文字动画（如对话气泡出现）复用同套 API
