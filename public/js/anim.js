/** AnimeAnimations：集中管理全部 anime.js 动画（吉祥物/scramble/工具行）。仅依赖 anime 全局。 */
      // ============================================================
      // AnimeAnimations：集中管理所有 anime.js 动画
      // ============================================================
      export const AnimeAnimations = (() => {
        // 安全检查：anime.js 未加载时静默降级
        function hasAnime() { return typeof anime !== 'undefined'; }

        // anime.js v4 API 兼容层：
        //   - v4 IIFE 中 anime.createDrawable 已移至 anime.svg.createDrawable
        //   - v4 不含 scrambleText / splitText，用原生 rAF 实现等价效果
        //   - v4 timeline.add() 位置参数只支持数值(ms)，不再支持 "<+N" 字符串格式

        // ---------- 1. Claude 卡通吉祥物状态管理 ----------
        let _vibeDrawn = false;
        const vibeSvg = document.getElementById('vibeSvg');

        function playVibeAnimation() {
          const titleEl = document.getElementById('vibeTitle');
          if (!titleEl || !vibeSvg) return;

          _vibeDrawn = false;
          titleEl.style.opacity = '0';
          titleEl.style.transform = 'translateY(8px)';
          vibeSvg.classList.remove('asking', 'error', 'success'); // SVG 的 className 是 SVGAnimatedString，须用 classList

          // 文字淡入
          const delay = 200;
          if (hasAnime()) {
            anime.animate(titleEl, {
              opacity:    [0, 1],
              translateY: [8, 0],
              duration:   520,
              delay,
              easing:     'easeOutCubic',
              onComplete: () => { _vibeDrawn = true; },
            });
          } else {
            setTimeout(() => {
              titleEl.style.transition = 'opacity 0.5s, transform 0.5s';
              titleEl.style.opacity   = '1';
              titleEl.style.transform = 'translateY(0)';
              _vibeDrawn = true;
            }, delay);
          }
        }

        // 更新吉祥物状态
        function setMascotState(state) {
          if (!vibeSvg) return;
          vibeSvg.setAttribute('class', 'vibe-svg'); // SVG 不能直接赋 className
          if (state) vibeSvg.classList.add(state);
        }

        // 显示状态面板（错误/成功）
        // ⚠️ 以下三个节点在 index.html 与 app.css 中均不存在（已核实 0 命中），
        // 因此 showMascotStatus / hideMascotStatus 目前**恒为空操作** ——
        // chat.js 里「成功 / 异常」的吉祥物提示面板从未真正出现过。
        // 保留代码是因为前端改版计划里要重做这块；要启用只需补上这三个节点的 DOM 与样式。
        const mascotStatusPanel = document.getElementById('mascotStatusPanel');
        const mascotStatusText = document.getElementById('mascotStatusText');
        const statusMark = document.getElementById('status-mark');

        function showMascotStatus(type, message) {
          if (!mascotStatusPanel || !mascotStatusText || !statusMark) return;

          // 清除旧标记
          statusMark.innerHTML = '';

          // 添加对应的表情标记（错误：X，成功：✓）
          if (type === 'error') {
            // 错误表情：X 眼睛
            mascotStatusPanel.classList.remove('success');
            mascotStatusPanel.classList.add('error');
            mascotStatusText.className = 'mascot-status-text error';
            statusMark.innerHTML = `
              <g transform="translate(90,137)">
                <line x1="-8" y1="-8" x2="8" y2="8" stroke="#e5687a" stroke-width="4" stroke-linecap="round"/>
                <line x1="8" y1="-8" x2="-8" y2="8" stroke="#e5687a" stroke-width="4" stroke-linecap="round"/>
              </g>
              <g transform="translate(150,137)">
                <line x1="-8" y1="-8" x2="8" y2="8" stroke="#e5687a" stroke-width="4" stroke-linecap="round"/>
                <line x1="8" y1="-8" x2="-8" y2="8" stroke="#e5687a" stroke-width="4" stroke-linecap="round"/>
              </g>
            `;
            mascotStatusText.innerHTML = '<strong>⚠️ 出现异常</strong><br/>' + (message || '执行遇到问题，请查看错误信息');
          } else if (type === 'success') {
            // 成功表情：闭眼微笑
            mascotStatusPanel.classList.remove('error');
            mascotStatusPanel.classList.add('success');
            mascotStatusText.className = 'mascot-status-text success';
            statusMark.innerHTML = `
              <g transform="translate(90,137)">
                <path d="M-8,2 Q0,8 8,2" stroke="#6cc38a" stroke-width="3" fill="none" stroke-linecap="round"/>
              </g>
              <g transform="translate(150,137)">
                <path d="M-8,2 Q0,8 8,2" stroke="#6cc38a" stroke-width="3" fill="none" stroke-linecap="round"/>
              </g>
            `;
            mascotStatusText.innerHTML = '<strong>✓ 完成</strong><br/>' + (message || '任务已完成');
          }

          mascotStatusPanel.hidden = false;
          // 这里原本是 `if (nearBottom()) scrollBottom();` —— 这两个函数是 chat.js 的模块私有函数，
          // 本模块既没定义也没导入，一旦上面三个 DOM 节点被补齐，这行会立刻 ReferenceError。
          // 之所以至今没炸，只是因为 #mascotStatusPanel / #mascotStatusText / #status-mark
          // 在 index.html 与 app.css 中**都不存在**（已核实 0 命中），函数恒在开头早退。
          // 已移除该调用：吸底不是本函数的职责，留着就是给后续补 DOM 的人埋雷。
        }

        function hideMascotStatus() {
          if (mascotStatusPanel) mascotStatusPanel.hidden = true;
        }

        // ---------- 通用 scramble 工具（复刻 anime.js ScrambleText 语义）----------
        // 说明：免费版 anime.js（CDN anime.iife.min.js）不含 scrambleText 插件，
        //   原先的 anime.animate({scrambleText}) 为空操作，动画不生效。
        //   这里用原生 rAF 自研，复刻官方 ScrambleText 的 chars 参数：
        //   chars 支持 'uppercase' | 'lowercase' | 'numbers' | 'symbols' | 自定义字符串 | 上述数组。
        //   参考：https://animejs.com/documentation/text/scrambletext/scrambletext-parameters/chars
        const _CHAR_SETS = {
          uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
          lowercase: 'abcdefghijklmnopqrstuvwxyz',
          numbers: '0123456789',
          symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?/',
        };
        function _resolveChars(chars) {
          if (!chars) return _CHAR_SETS.uppercase + _CHAR_SETS.lowercase + _CHAR_SETS.numbers;
          if (Array.isArray(chars)) return chars.map((c) => _CHAR_SETS[c] || c).join('');
          return _CHAR_SETS[chars] || chars;
        }
        // 对整段文字做「乱码 → 逐字落定」过渡（从左到右）。
        // opts: { chars, duration, onComplete }
        function scrambleTo(el, newText, opts = {}) {
          if (!el) return;
          newText = String(newText == null ? '' : newText);
          if (el._scrambleCancel) el._scrambleCancel(); // 取消上一段，防止叠加
          const n = newText.length;
          if (!n) {
            el.textContent = '';
            return;
          }
          const pool = _resolveChars(opts.chars);
          const rand = () => pool[Math.floor(Math.random() * pool.length)];
          const duration =
            opts.duration != null ? opts.duration : Math.min(Math.max(n * 28, 300), 900);
          const start = performance.now();
          let raf;
          function tick(now) {
            const p = Math.min((now - start) / duration, 1);
            const settled = Math.floor(p * n);
            let out = '';
            for (let i = 0; i < n; i++) {
              const ch = newText[i];
              // 已落定的字符、空白与换行保持原样，未落定的位置显示随机字符
              out += i < settled || ch === ' ' || ch === '\n' || ch === '\t' ? ch : rand();
            }
            el.textContent = out;
            if (p < 1) {
              raf = requestAnimationFrame(tick);
            } else {
              el.textContent = newText;
              el._scrambleCancel = null;
              if (opts.onComplete) opts.onComplete();
            }
          }
          raf = requestAnimationFrame(tick);
          el._scrambleCancel = () => {
            cancelAnimationFrame(raf);
            el.textContent = newText;
            el._scrambleCancel = null;
          };
        }

        // ---------- 2. 状态文字 scramble 动画 ----------
        let _lastStatusText = '';
        function animateStatusText(el, newText) {
          if (!el || newText === _lastStatusText) return;
          _lastStatusText = newText;
          // scrambleTo 为纯 rAF 自研实现，不依赖 anime.js，可独立运行
          scrambleTo(el, newText, { chars: 'lowercase', duration: 450 });
        }

        // ---------- 3. 工具调用：仅显示最新1条，无缝 scramble 过渡 ----------
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

          // scrambleTo 为纯 rAF 自研实现，不依赖 anime.js，可独立运行
          scrambleTo(txt, newText, { chars: 'lowercase', duration: 550 });
        }

        // ---------- 4. 流式输出 scramble chars 渲染 ----------
        // 原地 scramble：对正文最后一个文本节点的尾部新增字符做乱码→落定。
        // 不用独立尾迹元素——正文每帧已含全部新增文字，独立元素会与正文重复、且被挤到附属 UI 之后
        // 与 scrambleTo 共用字符集，保证三处（工具行/状态行/流式正文）视觉一致
        const _streamChars = _resolveChars('lowercase');
        let _streamScramble = null;
        const _STREAM_SKIP = ['tool-log', 'run-status', 'todo-panel', 'ask-card']; // 附属 UI 不参与
        function _lastTextNode(root) {
          for (let i = root.childNodes.length - 1; i >= 0; i--) {
            const n = root.childNodes[i];
            if (n.nodeType === 3) {
              if (n.data.trim()) return n;
            } else if (n.nodeType === 1 && !_STREAM_SKIP.some((c) => n.classList.contains(c))) {
              const r = _lastTextNode(n);
              if (r) return r;
            }
          }
          return null;
        }
        function startStreamScramble(bubbleEl, chunkLen) {
          if (!bubbleEl || !chunkLen) return;
          if (_streamScramble) _streamScramble.cancel();
          _streamScramble = null;
          const node = _lastTextNode(bubbleEl);
          if (!node) return;
          const full = node.data;
          const n = Math.min(chunkLen, full.length);
          const head = full.slice(0, full.length - n);
          const tail = full.slice(full.length - n);
          const duration = Math.min(n * 18, 800);
          const start = performance.now();
          let raf;
          function tick(now) {
            const p = Math.min((now - start) / duration, 1);
            const settled = Math.floor(p * n);
            let out = '';
            for (let i = 0; i < n; i++) {
              out +=
                i < settled ? tail[i] : _streamChars[Math.floor(Math.random() * _streamChars.length)];
            }
            node.data = head + out;
            if (p < 1) {
              raf = requestAnimationFrame(tick);
            } else {
              node.data = full;
              _streamScramble = null;
            }
          }
          raf = requestAnimationFrame(tick);
          _streamScramble = {
            cancel: () => {
              cancelAnimationFrame(raf);
              node.data = full;
            },
          };
        }
        function stopStreamScramble() {
          if (_streamScramble) {
            _streamScramble.cancel();
            _streamScramble = null;
          }
        }

        // 重置工具行状态（新对话时调用）
        function resetToolState() {
          _lastToolText = '';
          _lastStatusText = '';
          stopStreamScramble();
        }

        // ---------- 5. 会话标题 cursor 扫描动画（参考 anime.js ScrambleText cursor）----------
        // 效果：cursor 字符（'░▒▓█' 循环）从文字左端游动到右端，
        //   左侧字符依次「落定」为真实文字，右侧字符持续乱码，扫一遍后短暂停再重复。
        //
        // 架构：全局单一 rAF ticker + 全局时钟相位（见下方 _scanTick）。
        //   不用「每元素独立计时」的原因：conv-list 流式输出期间会被
        //   renderConvListDebounced 每 200ms 整体重渲染（innerHTML=''），title-text 元素
        //   被销毁重建；若动画从元素创建时刻计时，每次重建都把扫描位置重置到开头，
        //   视觉上「只闪一下就没了」。改用全局时钟：相位只与 (now % period) 有关，
        //   元素重建后新元素按当前相位继续渲染，视觉完全连续。
        const _SCAN_CURSOR = '░▒▓█';   // frontier 光标使用的块字符序列

        // 全局单一 rAF ticker + 全局时钟相位（解决 conv-list 重渲染打断动画的问题）
        const _scanTargets = new Map(); // titleTextEl -> { base: 原始标题文字 }
        let _scanRaf = null;
        let _scanT0  = 0; // 全局时钟起点

        function _scanTick(now) {
          if (_scanT0 === 0) _scanT0 = now;
          const elapsed = now - _scanT0;
          for (const [el, info] of _scanTargets) {
            if (!el.isConnected) { _scanTargets.delete(el); continue; } // 离 DOM 自动清理
            const title = info.base;
            const n = title.length;
            if (!n) continue;
            const scanMs  = Math.min(n * 116, 3750); // 扫描一遍时长（较原速快约 20%）
            const pauseMs = 600;                      // 每遍之间停顿
            const period  = scanMs + pauseMs;
            const phase   = elapsed % period;
            if (phase >= scanMs) {
              if (el.textContent !== title) el.textContent = title; // 停顿阶段显示完整
              continue;
            }
            const p   = phase / scanMs;
            const pos = Math.floor(p * n);
            const L   = _SCAN_CURSOR.length; // 光标拖尾长度（4）
            let out = '';
            for (let i = 0; i < n; i++) {
              const ch = title[i];
              const dist = pos - i; // 距 frontier 的距离（0 最亮，向左渐弱）
              if (dist >= 0 && dist < L) {
                // 4 格渐变光标拖尾：frontier(dist=0)=█，向左依次 ▓▒░
                out += _SCAN_CURSOR[L - 1 - dist];
              } else {
                out += ch;              // 其余全部真实文字
              }
            }
            el.textContent = out;
          }
          if (_scanTargets.size > 0) {
            _scanRaf = requestAnimationFrame(_scanTick);
          } else {
            _scanRaf = null;
            _scanT0  = 0;
          }
        }

        /** 为 titleText 元素启动扫描 cursor 动画（running 时调用） */
        function startCursorLoop(titleTextEl) {
          if (!titleTextEl || _scanTargets.has(titleTextEl)) return;
          _scanTargets.set(titleTextEl, { base: titleTextEl.textContent });
          if (!_scanRaf) {
            _scanT0  = 0;
            _scanRaf = requestAnimationFrame(_scanTick);
          }
        }

        /** 停止扫描并恢复原始文字（运行结束时调用） */
        function stopCursorLoop(titleTextEl) {
          if (!titleTextEl) return;
          const info = _scanTargets.get(titleTextEl);
          if (info) {
            titleTextEl.textContent = info.base; // 恢复原文
            _scanTargets.delete(titleTextEl);
          }
        }

        return {
          playVibeAnimation,
          animateStatusText,
          animateToolLine,
          startStreamScramble,
          stopStreamScramble,
          resetToolState,
          setMascotState,
          showMascotStatus,
          hideMascotStatus,
          startCursorLoop,
          stopCursorLoop,
        };
      })();