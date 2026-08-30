# 项目全面体检与优化 · 实施记录

> 日期：2026-08-28 · 触发：用户要求「对整个项目进行优化，包括架构健壮性、文档、
> 是否可以封装通用性组件、项目中可能存在的漏洞」
>
> 用户拍板范围：**全部 B1~B5**；vendor 治理选 **npm 管理 + 同步脚本**。

---

## 一、体检基线

- 全量测试 **1825 通过 / 0 失败**（体检前后均如此，见各批的回归记录）
- 代码量：`src/` 181 个非测试 js、`public/js/` 前端、`docs/` 193 份文档
- 最大文件：`app.css` 4047 / `chat.js` 3403 / `req-view.js` 3332 行

---

## 二、⚠️ 必读：三条被实测推翻的初判

**这一节是本文档最重要的部分。** 三条初判都「看起来很有道理」，全部经不起实测。

### 推翻 1：DOMPurify 的 CVE 对本项目不适用

`npm audit` 报 dompurify 3.4.12 有 XSS 漏洞（GHSA-55q2-fjhq-7xh7），
而项目正用它渲染 LLM 产出 —— 看起来是必然的高危链。

**实际不适用。** 该 CVE 的触发条件是 `IN_PLACE` 模式 + `addHook`，
而全仓仅 3 处调用，全是默认的 `DOMPurify.sanitize(html)`，无 hook、无 IN_PLACE。

**教训**：advisory 标题只说「什么漏洞」，不说「什么条件下触发」。
把 CVE 编号当结论、不读触发条件，就会把「运气」当成「已防护」，
或者反过来把不适用的漏洞报成高危。**升级仍然要做**，但理由是治理（见 B1），不是这条 CVE。

### 推翻 2：`serveStatic` 的路径穿越不成立

`routes-files.js` 的 `filePath.startsWith(PUBLIC_DIR)` 是教科书级的错误前缀校验
（经典反例：`/../public-evil/x` 能通过 startsWith）。

**实测 7 组穿越向量全部落在 `public/` 内**，攻击不成立。原因是两个不显然的性质叠加：
1. `url.pathname` 恒以 `/` 开头，而 `path.normalize('/../x')` 会**吃掉根上的 `..`**，得到 `\x`；
2. WHATWG URL 解析已把 `\` 归一成 `/`，`%2e%2e` 不解码。

所以 `path.join` 的结果永远在 `PUBLIC_DIR` 之内，`public-evil` 那种兄弟目录混淆
根本构造不出来（join 出来的是 `public/public-evil/`）。

**教训**：「这段代码长得像已知漏洞模式」不等于「这里有漏洞」。
判定路径安全必须**实际跑一遍向量**，因为结论取决于 normalize / URL 解析的具体行为，
而这些行为跨平台、跨函数各不相同。仍建议改成 `path.relative` 加固（不依赖隐含性质），
但这是防御性重构，不是修漏洞。

### 推翻 3：「全仓无进程级异常兜底」是错的（我自己的检索错误）

体检报告曾把它列为 P0，依据是 grep `uncaughtException|unhandledRejection`
只命中若干注释，加上 `body.js` 的注释明确写着「全仓也没有进程级兜底」。

**实际早已存在**：`src/shared/process-guard.js` 实现完整，
且已在 `web/server.js:14`、`feishu/index.js:25` 两处接线，还配了 5 个子进程集成测试
（含「不装兜底则必死」的对照组）。

**误判根因有两条，叠加成一个完整的假象**：
1. 我的 grep 命令带了 `| head`，默认只出 10 行，`process-guard.js` 的命中被**截断掉了**；
2. `body.js:79` 那条注释是 process-guard 落地**之前**写的，从未更新 —— 它把过时状态
   陈述成了当前事实，恰好「印证」了被截断的检索结果。

**教训**：
- 用于**否定性结论**（「全仓没有 X」）的检索**绝不能带 head/limit**。
  否定性结论对完整性的要求比肯定性结论高一个量级。
- 代码注释里的**否定性断言**（「全仓没有…」「目前还不…」）是最容易腐烂的一类文字，
  它描述的是全局状态，而写它的人只改了局部。引用前必须自己验证。
  该注释已修正（保留历史信息 + 说明现状）。

---

## 三、五批修复的实际落地

### B1 · vendor 纳入 npm 管理 ✅

**问题的真实形态**（比「依赖版本旧」严重）：`public/index.html` 加载的三份
`public/vendor/*.js` 是**手工拷进来的**，`src/`、`public/` 里没有任何一处
`import 'dompurify'` —— package.json 的 `dompurify` 是**死依赖**。
后果是 `npm audit fix` 升 node_modules，而前端实际运行的副本一行都不会变；
版本只能靠翻文件头注释，升级没有入口。

**做法**：三个库进 `dependencies` 锁版本 + 新增 `scripts/sync-vendor.mjs` 单向同步。

| 库 | 旧 | 新 | 验证方式 |
|---|---|---|---|
| dompurify | 3.4.12 | 3.4.14 | `util.render.test.js` 9 个 XSS 注入用例全过 |
| marked | 12.0.2 | 18.0.11 | 18 组代表性 markdown 渲染输出与 v12 **逐字节一致** |
| animejs | 4.1.4 | 4.5.0 | API 表面对比：**零移除**，项目点用的 `animate` / `svg.createDrawable` 均在 |

**跨 6 个大版本的 marked 为什么敢升**：不是因为「同大版本才安全」这种规则，
而是真跑了对比 —— 在 jsdom 里同时加载 v12 的 UMD 与 v18 的 ESM，
拿 18 组样本（标题/列表/表格/代码块/裸链接/中文标点/三类 HTML 注入/混合）
逐一比对输出字符串。零差异才动手。

**目标文件名刻意改了**（`marked.min.js`→`marked.umd.js`、
`anime.iife.min.js`→`anime.umd.min.js`）：npm 已不提供 IIFE 构建，
marked 的 UMD 也不是压缩版，沿用旧名就是名不符实。改名同步更新了 2 处引用。

**同步脚本的两个设计点**：
- `--check` 模式（构建前跑，`tauri:build*` 三条命令都已接）。拦两类事故：
  升级依赖后忘同步、以及有人手改 vendor 文件（那种改动下次同步会被静默冲掉）。
  **突变测试验证过不是空洞的**：手动往 vendor 文件尾部追加一行 → check 报错、
  退出码 1；恢复后退出码 0。退出码单独验过 —— 因为 `| tail` 会掩盖真实退出码，
  而构建链的 `&&` 正依赖它。
- 孤儿文件检测：vendor 根目录出现未登记文件就告警。首次同步即报出两份历史副本。

**⚠️ 必须记住**：`scripts/*` 被 `.gitignore` 整体忽略，新脚本要显式加
`!scripts/sync-vendor.mjs` 白名单。漏掉这条，同步机制不入库 = 等于没做。

**剩余 2 个 npm 漏洞（hono / ip-address）刻意不动**：
- 来源单一：`@modelcontextprotocol/sdk`（devDependency），
  且该 SDK 全仓只被 `tests/fixtures/echo-mcp-server.mjs` 使用 —— 不在生产运行路径；
- 已是最新版 1.30.0，其依赖范围（`hono: ^4.11.4`）上限仍是有漏洞的 4.12.30，
  修复版需 >4.12.33。`npm audit fix` 实测**零改动**（added/removed/changed 全 0）
  且修完仍剩这 2 个 —— 「fix available」是假提示；
- 用 `overrides` 强制升级会绕过上游兼容性声明，风险大于收益。等上游放宽范围。

### B2 · 进程级异常兜底 ✅（范围因推翻 3 而缩小）

既有实现完整且其「记日志后**继续存活**」的取舍已有充分论证
（进程持有运行中的 run / SSE 订阅 / 审批 pending 等不可恢复内存态），
**不推翻**。只补三项真实增量：

1. **日志节流**（真实风险）。「继续存活」的副作用是错误源不会自行消失 ——
   若 rejection 来自 5s 一轮的轮询，它就每轮抛一次、永不停止。
   而 logger 是**同步 `appendFileSync`**：记日志本身会拖慢事件循环，
   且几小时就能把日志撑到几百 MB（logger 只按天分文件，无切割）。
   现按错误指纹 60s 窗口内只记一条，并把被压制条数带在下一条里
   —— 丢掉次数会让「偶发一次」和「每秒十次」在日志里长得一样。
2. **非 Error 值的信息提取**。原 `reason?.message || String(reason)` 遇到
   `Promise.reject({ code: 'ECONNRESET' })` 会输出 `[object Object]`，信息全丢，
   而这恰是网络类 rejection 的常见形状。
3. 修 `body.js` 的过时注释（推翻 3 的根因）。

指纹取「错误名 + 消息 + 栈首帧」：同一处代码反复抛出归为一类，
不同位置的同名错误分开计数。

**测试 12 → 17 条**，含两个端到端：同一 rejection 连抛 5 次日志只出 1 条、
两个不同 rejection 各出 1 条（证明节流没把不同错误一起吞掉）。

> 过程中写错过一个测试：断言「同名错误在不同位置 → 指纹不同」，
> 但两个 Error 都在同一个工厂函数 `mk()` 里 `new` 出来，栈首帧当然相同。
> **是测试错了，实现是对的**（指纹取的是 Error 被创建的那一帧）。
> 已拆成两条：不同源码位置各建一个 → 指纹不同；同一工厂反复创建 → 指纹相同。

### B3 · 文档修复 ✅

1. **`docs/ARCHITECTURE.md` 文档损坏**。第 549 行正文已用「既保留了…协作场景」收尾，
   第 550 行突然接 `intents: string[];` —— 是另一份旧文档第 6~10 节的残片被拼进来，
   且 `interface Feature {` 的开头丢失、章节编号从无编号倒回「## 6.」。
   残片内容还与代码直接矛盾（说「在 `features/index.js` 注册」，
   而该文件明确写「此处不再登记业务 feature」）。

   处理：残片归档到 `docs/archive/ARCHITECTURE-legacy-sections-6-10.md`（不丢历史），
   正文补两节对齐现状的内容 —— **先读 `dispatch.js` / `plugins/index.js` 才写**，
   因此写进去的契约包含残片里根本没提的 `hasPending` 与 `PASS` 交还机制。
   「## 总结」改为「## 七大特性总结」（它只总结特性部分，不是全文结尾）。

2. **根目录 5 份过期文档归档**。其中 3 份（`CHANGES_SUMMARY` /
   `IMPLEMENTATION_COMPLETE` / `QUICK_START`）讲的是**同一件事** ——
   2026-08-12 修 `Response stalled mid-stream`，一次修复留下四份互相引用的文档
   堆在项目根。`START-HERE.md` 引用的 `test-degradation.mjs` 已不存在。

   **`RETRY_LOGIC.md` 没有归档**：先 grep 确认它描述的指数退避重试机制仍在跑
   （`claude.js:137,253-290`），故移到 `docs/RETRY_LOGIC.md` 继续作为现役文档。
   新建 `docs/archive/README.md` 说明归档物性质（否则 20 个文件会被后人误当现状）。

3. 顺带修 `dispatch.js:4` 同样过时的「只在 features/index.js 注册」。

### B4 · api.js 统一网络层 ✅（范围经事实修正后收窄）

**开工后发现体检报告的 D1/D2 两条判断都不准，据此收窄了范围：**

- **D1「130 处裸 fetch 没有统一入口」不准。** `bootstrap.js` 里有一个**全局 fetch
  monkey-patch**，已经统一负责 Tauri 打包态的相对路径改写 + reject 路径分类 +
  掉线守卫上报（规则在 `net-error.js`）。组合是存在的，只是不以显式封装的形式。
  → 所以 `api.js` 刻意**不碰**错误分类与上报，只消除样板。再包一层会造成两套语义打架。
- **D2「innerHTML 缺统一安全渲染工具」基本不成立。** 逐个查完 124 处：
  `bots-panel` / `actions-panel` 等都是**静态 HTML 骨架 + `textContent` 填数据**，
  或**模板串 + `escapeHtml`**；而 `escapeHtml` 转义了 `& < > " '`，属性上下文
  （`value="${...}"`）也覆盖到了。前端这块整体是规范的。
  → 全仓只有 `dir-popover.js` 一处真漏洞（见下），修掉即可，不需要新造工具。

**交付物**：`public/js/api.js` + 17 个契约测试。导出 `getJson` / `postJson` /
`putJson` / `delJson` / `postJsonQuiet`，统一返回 `{ok, status, data}` 三元组。

几个设计决定及其理由：

- **返回三元组而不是裸 data**：57 处调用点判过 `r.ok`，只回 body 会把这个信息丢掉，
  逼调用方退回裸 fetch。
- **JSON 解析失败给 `data: null` 而不抛**：后端 500 时可能回 HTML（`serveStatic`
  的 404 分支就是纯文本），此时 `r.json()` 抛 SyntaxError，会被调用方的 catch
  当成网络故障、显示「后端未连接」，而后端明明活着。
- **不统一错误策略**：各调用点的处置是刻意不同的（UI 偏好保存静默失败、任务操作弹
  toast、拿不到结果退化成 `{ok:false}`）。强行统一会破坏既有取舍。
  为「发出去就不管」那十几处提供具名的 `postJsonQuiet`，让「静默是刻意的」不必每处写注释。
- **`body === undefined` 时不带 Content-Type**：无体请求（典型是 DELETE）声明一个
  JSON 体的类型是误导。

**已迁移**（按用户拍板「只迁中小文件」）：`dir-popover.js`（7 处→0）、
`bots-panel.js`（5 处→0）、`actions-panel.js`（4 处→1）。

`actions-panel` 保留的那 1 处是**刻意的**：请求体是 `File` 二进制，
`postJson` 会强加 JSON 类型并把它 `JSON.stringify` 掉。已就地注明。

**未迁移**：`chat.js`(20) / `req-view.js`(33) / `req-chat.js`(11) / `req-map.js`(7)
/ `settings-panel.js`(12) / `tasks-panel.js`(5) 等。理由见「六、未完成事项」。

#### 迁移过程中揪出的两个真问题

**① `dir-popover.js` 在浏览器代码里用了 `process.platform`（真 bug）。**

```js
editor: process.platform === 'win32' ? 'explorer' : 'open'   // ← 浏览器里没有 process
```

前端**无 process polyfill**，这是全前端唯一一处 `process.` 引用，必然抛
ReferenceError，而它被外层 `catch {}` 吞掉 —— 「在文件管理器中打开」这个右键菜单项
**从上线起就没工作过**，且没有任何报错痕迹。

修法是把平台判断挪回后端（前端只传语义值 `'filemanager'`）：后端才是执行 `execFile`
的一方，它知道自己在什么平台。顺带补上 Linux 的 `xdg-open`（原实现只有 win/mac 两分支），
以及 Windows `explorer.exe` 成功时退出码就是 1 这个系统怪癖的特判。

**② `/api/open-in-vibe` 的 `editor` 参数可执行任意程序（安全收窄）。**

`editor` 来自请求体且直接进 `execFile(editor, [path])`。execFile 不走 shell，
所以没有命令拼接注入问题，但它照样能启动 **PATH 里的任意程序** ——
这个接口的真实语义因此是「执行任意程序」，而本意只是「打开编辑器」。
本地服务无鉴权，攻击面不该白送。已收窄为白名单 `windsurf|cursor|code` + `filemanager` 语义。

**③ 同时修掉**：`dir-popover.js` 把后端错误文本（含用户输入的路径）拼进 innerHTML
的 self-XSS；抽了个 `hintRow()` 消除该文件 5 处相似的提示行拼接。

### B5-1 · 表驱动路由 ✅

`server.js` 的 59 个顺序 `if` → 58 条路由表（原先 grep 到的 59 里有一条是访问日志的
`startsWith('/api/')`，不是路由）。

**为什么用顺序数组而不是 Map**：匹配顺序有语义 —— `/api/history` 的精确匹配必须先于
`/api/history/` 的前缀；`/api/credentials` 的 GET/POST 必须先于 `/api/credentials/`
的 PUT/DELETE。Map 表达不了顺序，拆成「精确 Map + 前缀数组」又要额外论证两者间的优先级。
58 条线性字符串比较对本地服务可忽略（原实现同样是 58 个顺序 if）。

**为什么每条包一层箭头函数**：现有 handler 的签名**并不统一** —— `(req,res)`、`(res)`、
`(url,res)`、`(req,res,url)`，还有 `(res,url)`（`handleActionsGet` 独一份）。
在表里做适配，就不必为统一签名去改 30 多个 handler 和它们的测试。

**`handler 返回 false = 继续往后匹配`**：原来 conv-notify 的「子路由未命中不自行 404」
是一个特例 if 块，现在成了通则。

**两件原计划没有、但必须有的东西**：

1. **匹配逻辑抽到独立模块 `route-match.js`**。因为 `server.js` 在模块求值时就
   `server.listen()`，测试只要 import 它就会真起服务、占端口、挂定时器，`node --test`
   都不退出。分发逻辑必须能在不起服务的前提下测。
2. **启动时的遮蔽自检 `findShadowedRoutes`**。新加端点时把顺序放错（精确排在能覆盖它的
   前缀之后）会导致该端点静默 404 或被错误的 handler 接走 —— 端点明明在表里，
   请求却被上面某条 prefix 抢先按自己的语义处理了。现在启动即报错。

**验证**：17 个契约测试（含「顺序颠倒会让精确路由永不命中」这条反向用例）
+ **22 项真实端到端**（起 server 打端点）。端到端不可省 —— 纯逻辑测试能证明匹配算法对，
但证明不了 58 个适配箭头函数的**参数顺序**写对了，那类错误语法合法、启动无警告，
只在请求真打进来时才炸。重点覆盖了 4 种不同签名、方法约束正反向、前缀委托、静态兜底。

### B5-2 · 空 catch 判定与卫生清理 ✅

**9 处空 catch 逐个判定的结论：大部分是合理的**，体检报告里「9 处吞异常」的说法偏重了。

| 位置 | 吞的是什么 | 判定 |
|---|---|---|
| `chat.js` × 4 | `EventSource.close()` | 规范上不抛，过度防御但无害。4 处完全重复，可抽 helper —— **刻意没动**：收益最小而 chat.js 是 3403 行核心文件，改动风险不成比例 |
| `chat.js` × 2 | `JSON.parse(e.data)` | 有默认值兜底，合理 |
| `util.js:69` | sanitize 失败 | 有 `textContent` 兜底，合理 |
| `req-view.js:103` | `localStorage.setItem` | 合理，但**没用 util.js 已有的 `lsSet`** → 已改（DRY，且至少留一行 console.warn） |
| `dir-popover.js` | 见 B4-① | **这一处掩盖了真 bug** |

**结论**：空 catch 本身不是问题，问题是「吞掉的东西里混着真故障」。9 处里只有 1 处如此，
但那 1 处让一个功能静默失效了几个月。

**卫生清理**（用户确认后执行）：删除根目录 24 个调试残留（23 个未跟踪的 `tmp-*` +
已入库的 `verify-css.mjs`）、`public/` 下 7 个原型 html（约 6600 行，删前已确认零引用）。
根目录 md 从 7 份降到 2 份（README + PROJECT-STRUCTURE）。

### B5-3 · 大文件拆分 ❌ 未做（用户拍板单独立项）

**关键发现：`chat.js` 正是上一轮拆分的终局产物。**
`specs/2026-07-24-appjs-split-design.md` 记录了 app.js 4342 行 → 108 行壳 + 16 模块的
全过程，当时用 census 实锤判定「唯一合理刀位不是拆聊天体内部，而是把聊天体整体迁出」，
并明确写下「最大单模块即聊天体本体」。

它现已从 1742 涨到 3403 行（+96%）—— 新功能持续往这里堆，确实又到了该拆的时候。
但**拆它的安全网当时就是那四道 e2e，而这套门禁已经锈掉**（见下）。

那份 spec 的「抽离检查清单」记录了两类**静默**故障，只有 e2e 能逼出来：
- 调用型普查抓不到**读取型引用**（`activeView` 实锤：census 干净但运行时 ReferenceError）；
- 浏览器的 **id 隐式全局**（`window.<elementId>`）会静默兜住同名引用，行为恰好相同纯属踩运气
  （`settingsTabs` 实锤：三道 e2e 全绿毫无征兆）。

所以正确顺序是：**先修门禁 → 再做 census → 出拆分 spec → 分阶段拆**，不是体检顺带。

---

## 四、e2e 门禁：从「锈掉」到「能跑」

体检发现 `tests/e2e-*.mjs`（当年拆分 app.js 的安全网）有两个**流程**缺陷：

1. 不在 `npm test` 的 glob 里（那只收 `*.test.js`），跑它得靠人记得；
2. 每个脚本都要求「先手动起 localhost:3000」，多一道门槛就少一次执行。

结果是**长期无人执行、失效而无人知晓**。安全网锈掉最危险的地方，在于它让人以为重构有保护。

**已交付**：`scripts/run-e2e.mjs` + `npm run test:e2e`
（自动起后端 / 复用已有的 → 依次跑 → 汇总；支持 `-- 关键字` 过滤）。

**首次跑出的真实状态：10 个门禁只有 2 个通过。修完为 10/10。**

失效原因归为四类，没有一类是「被测功能真坏了」——**全部是断言腐烂或环境前提变化**：

#### 类型一：硬编码 UI 结构（3 个）

| 门禁 | 失效原因 |
|---|---|
| `panels-smoke` | 硬编码 `['basic','lark','messages','tokens',...]`，而 lark/messages/tokens 早被重构掉。改为**从 DOM 动态读取**，并按 `offsetParent` 过滤不可见项（`desktop` tab 带 hidden，只在 Tauri 下显示）。**补了 `tabs.length < 3` 下限断言** —— 选择器一旦失效会返回空数组，for 循环直接跳过 → 假绿通过 |
| `approval-badge` | 断言 `typeof refreshAskChip === 'function'`。它在 `js/chat.js` 里是 `export function`，**模块作用域的符号本就不是全局变量**（那次拆分刻意只留 4 个 window 接口）。这条从模块化那天起就必然失败，且测的东西与模块化目标相反。改为验证徽标可交互 |
| `ask-chip` | 正则要求 `⏳` emoji，而图标已改成内联 SVG（`setIconText` + `WAITING_ICON_SVG`），textContent 里自然没有 emoji。改为断言文字部分 + 单独查 SVG 存在 |

#### 类型二：onboarding 引导罩挡住一切（4 个，**最高杠杆**）

`conv-notify` / `no-auto-switch` / `req-review` / `retro-summary` 都**自起独立 server**
（`mkdtemp` 临时 APP_DATA_DIR），而 onboarding 的 `isNewUser(settings)` 判据就一条：
`settings.tokens` 为空。空数据目录 → 必然判为新用户 → 引导罩接管启动罩
（`#bootOverlay` 带上 `ob-arm ob-open`）覆盖全屏 → **此后所有点击都被拦截**。

2026-08-26 上线 onboarding 这一个功能，一次性废掉了四个门禁。

症状极具迷惑性：报的是「element is not visible」或
「`<div class="ob-titlebar-drag">` … intercepts pointer events」，元素明明在 DOM 里、
也确实可见，而且**没有任何 pageerror**。我最初据此怀疑过被测功能坏了，
甚至怀疑过是不是 e2e 污染了用户真实 settings —— 查证后都不是（用户 settings 的
mtime 停在前一天，tokens 始终是 2）。

修法：新增 `tests/helpers.mjs` 的 `seedConfiguredSettings(dataDir)`，
四个用例在起 server 前各调一次。

**衍生的一个坑**：`conv-notify` 中途还会**整体覆写** settings.json 去配飞书，
只写 `bots` + `myFeishuOpenId`，把刚 seed 的 tokens 又冲掉了 —— 于是后面的阶段重新被罩住。
为此 helper 另导出 `writeSettings(file, patch)`，覆写时自动补上 tokens。
（`getSettings()` 是整体读盘、无合并，所以「覆写漏字段」这个坑对任何字段都成立。）

#### 类型三：可见入口变了（2 个）

`composer-draft` 点 `#sidebarNew`、`req-review` 点 `#sidebarNewReq` —— 侧栏改成
「对话/需求」双模式后（2026-08-25），这两个按钮都变成了**隐藏的代理按钮**，
可见入口是底部那个随模式改文案的 `#sidebarCreateBtn`，由 `app.js:188` 委托到对应代理。
改为走真实用户路径（必要时先点 `.switch-btn[data-target="req"]` 切模式）。

> 排查途中我一度以为 `#sidebarCreateBtn` **没有任何绑定**（`grep` 全 `public/js/` 零命中，
> 看起来是「新建对话按钮失效」的真 bug）。用 CDP 的 `DOMDebugger.getEventListeners`
> 一查，它有 click 监听 —— 绑定在 `public/app.js` 那个 108 行的**壳**里，
> 而我只搜了 `public/js/`。**又一次「否定性结论 + 搜索范围不全」**，与 §2 推翻 3 同源。

#### 类型四：启动时序（2 个）

`steer-bubble` / `composer-draft` 在 `goto(waitUntil:'load')` 后**立即**操作。
`load` 只保证资源加载完，而 cwd / UI 偏好是**异步拉取**的；点太早时 `send()`
因 cwd 未就绪提前返回，现象是「点了没反应、不建 EventSource」，
后续 `waitForFunction` 超时且无任何 pageerror 可查。
改为等 `#dirLabel` 出现文本（该标签由启动初始化回填）这个语义化就绪信号。

#### 类型五：req v2 重写了评审期主栏（`req-review`，12 个场景中的前 6 个）

评审期主栏在 req v2 里整体重写成「工作台」，**class 前缀由 `req-*` 改为 `rqw-*`**：

| 旧断言目标 | 现状 | 换成 |
|---|---|---|
| `.req-edit-config-btn` / `.req-config-modal` | **代码中完全不存在**（配置从弹层改为主栏内联） | `.rqw-cfg` + `.rqw-slot` 槽位 + 前端/后端工程文案 |
| `.req-doc-empty button` | 只剩 CSS，JS 不再生成 | `.rqw-btn.primary.full`（「生成开发文档 →」） |
| `.req-doc-vtab` | 改名 | `.rqw-vtab` |
| `.req-chips` | 仍在 DOM 但属条件渲染、未必可见 | `.rqw-phase-badge`（阶段徽标，恒在主栏顶部） |

**关键收窄**：只有**评审期**被重写，dev / test / 归档期的元素（`#reqBanner`、`#reqRail`、
`req-supplement-*`、`req-bitable-form`、`req-bug-*`）全部照旧 —— 所以 12 个场景里
后 6 个一行没改。先花几分钟确认这一点，把「重写整个用例」缩成了「改 6 处选择器」。

> **顺带发现一处死代码**：`req-chat.js:417` 有段草稿保护在 `railEl.querySelector('.req-guidelines')`，
> 而 `renderDevRail` 早已不再创建这个元素 —— `prevTa` 恒为 null，整段保护逻辑不起作用。
> 设计准则输入框已从 dev 期右栏移除，只剩 `app.css` 里的样式和这段查它的代码。

**教训**：
- 门禁必须有**一条命令**能跑起来，否则失效只是时间问题；
- 硬编码 UI 结构（tab 列表、emoji 文案、全局符号名、隐藏的内部按钮 id）的断言腐烂最快，
  能从 DOM 动态读的就别写死，写死了就要配下限断言防「空集合假绿」；
- 新增一个全局性的启动期功能（onboarding 这类）时，要顺带想一想
  **它会不会挡住所有自动化测试** —— 这次一个功能废掉了四个门禁。

---

## 四点五、架构评审与修复

门禁修复后做了一次架构评审，方法是**检验项目自己声明的约束是否真的成立**（而不是凭印象）。

### 结论：架构基本合理，问题是局部的

站得住的部分：dispatch 四段匹配 + PASS 交还、插件停用即不加载、
store 的跨进程锁 + 原子写、run 与 SSE 观察窗解耦。
**插件之间零横向 import**——这条约定是真守住了。

### 已修：两处分层倒挂

**① `store/ui-specs.js` → `entrypoints/web/req-uispec.logic.js`**（最底层依赖最上层）

被依赖的 `dirSlug` 只是个零依赖纯函数（路径归一 + 短哈希），**放错了层**。
已迁到 `shared/dir-slug.js`，5 个单测同步迁至 `shared/dir-slug.test.js`。

**② `shared/card-actions.js` → `plugins/action-runner/feature/index.js`**

更值得记的一处：该文件的注释**明确写着**它独立成模块就是为了避免
`entrypoint → features → plugins → entrypoint` 的环，而且它**已经提供了注册表机制**
（`registerCardKindHandler`）——却又直接 import 了一个具体插件。
解耦机制建好了，没贯彻到底。

对照发现另外三个 kind 处理器（feishu-relay 的会话卡、feedback 的评审结论、
task-notify 的任务卡）**一直都是各自插件自注册的**，只有 `quick-action` 是例外。
已把它的实现迁至 `plugins/action-runner/card-action.js` 自注册，
`shared/card-actions.js` 只留注册表机制。

> 附带修正一处语义：原先 action-runner 即使被停用，`quick-action` 的处理器仍然注册着；
> 现在它随插件一起不加载，与「停用插件不载入业务代码」一致。
> 已实测：加载插件后 `getCardKindHandler('quick-action')` 返回函数。

### 已修：`src/features/` 的语义漂移

原先目录里混了三类性质不同的东西，导致「feature 之间不互相 import」这条约定**必然失效**
——`llm-classify` 被 4 个插件依赖、`token-rotation` 被 3 个，而它们本就是基础能力而非业务功能。

新增 **`src/capabilities/`** 层，迁入 `llm-classify` / `token-rotation` / `llm-readonly-agent`
（含 2 个测试文件），**23 个文件的 import 路径同步更新**。迁移后：

```
entrypoints → app → features / plugins → capabilities → integrations / store → shared
```

四条检验命令全部为空（下层不 import 上层、插件之间不互相 import、capabilities 不认识业务）。

> 迁移前特意确认过：`memory-bank` / `project-checkup` / `project-optimize` 虽然也不走 dispatch，
> 但**不被任何插件依赖**，不造成约定冲突，故留在 `features/` 未动 —— 改动面因此收窄。

### 已修：约定改写为可判定形式

原来的「持久化只经 store」实测有 21 处越界，但其中多数是**正当的**
（project-optimize 改用户项目文件、logger 写日志、integrations 落临时文件）。
约定没区分「本项目状态」与「外部文件操作」，导致既无法判断谁违规、也就无人再当回事。

`docs/ARCHITECTURE.md` 的「关键约定」已重写：每条都给出**怎么验**（可执行的 grep）
和**正当例外**。同时修正了架构图与 `PROJECT-STRUCTURE.md` 里大面积失真的目录树
（还列着早已迁走的 `task-ops.js` / `feedback/` / `task-triage/` 和根本不存在的 `data-cleanup/`，
且整个 `plugins/` 层缺失）。

> 写检验命令时自己先踩了一次：`grep "plugins/"` 匹配的是**文件所在路径**而非 import 目标，
> 于是把每一行 `../../shared/...` 都算成违规。已在文档里连同这个陷阱一起写明。

### 已清理：一处死代码

`req-chat.js` 的草稿保护在查 `.req-guidelines`，而 `renderDevRail` 早已不再创建该元素——
`prevTa` 恒 null、算出的 `draft`/`hadFocus` 从未被使用（函数签名接收了但函数体一次没用）。
连同 `app.css` 里的孤儿样式一并删除。

### 未做（建议单独立项）

**大文件拆分**。`chat.js` 3403 行涨到今天是**功能堆积**的症状而非病根 ——
建议先理清模块归属再决定刀口位置，否则拆完还会涨回来。

## 四点六、内存优化（基于实测，非猜测）

先测量再动手。用 `process.memoryUsage()` 逐模块采样，定位到两类问题。

### 结果

| 指标 | 优化前 | 优化后 | 降幅 |
|---|---|---|---|
| web 进程就绪 RSS | 131.2MB | **84.1MB** | **−47MB (−36%)** |
| web 进程就绪 heap | 51.7MB | **22.6MB** | **−29MB (−56%)** |
| `/api/history` 单次耗时 | 108.1ms | **2.9ms** | **−97%** |
| `/api/history` 单次临时分配 | 0.57MB | **0.01MB** | **−98%** |

### 问题一：大依赖被无条件静态 import（占常驻内存的大头）

逐个 import 实测各依赖的体积，结果很集中：

| 依赖 | Δheap | Δrss | web 进程真的需要常驻吗 |
|---|---|---|---|
| **飞书 SDK** | **25.6MB** | **40.3MB** | 否 —— 只在「开了会话飞书通知」「需求流程发卡片」等按需路径用到 |
| Claude Agent SDK | 8.3MB | 22.1MB | **是**，web 的核心功能就是跑任务，不动 |
| `ai` + `@ai-sdk/openai-compatible` | 8.5MB | 11.4MB | 否 —— 默认 provider 是 claude-agent，只用 Claude 的用户碰不到 |
| mammoth（docx） | 3.6MB | 3.7MB | 否 —— 只在用户丢 Word 材料进来时用 |

三处改成按需 `await import()`：

1. **`integrations/lark.js`**：删掉顶部 `import * as Lark`，加 `sdk()` 懒加载器。
   19 个 `await getClient().xxx` 调用点全部在 async 上下文内，机械替换为 `await (await getClient()).xxx`。
   `createWsClient` / `larkSdk` 导出转 async（后者改名 `getLarkSdk`），
   `channels/feishu.js` 的 `dispatcher` 随之改为懒创建单例（它只在 `startWs` 里用一次）。
   > `resetApiClient(creds)` **刻意保持同步**：它在凭证热重载路径上被同步调用，
   > 改 async 会传染。改成「记下凭证 + 清空 client」，真正的 `new` 延后到 `getClient()`
   > （本就是 async）里做 —— 下一次发请求之前 client 根本用不上，语义完全一致。
2. **`providers/openai-compat.js`**：模型层改按需加载。`run()` 仍**同步**返回
   `{ done, abort }`（调用方拿 abort 的时机不变），加载挪进 `done` 那条 Promise 链里。
   注入点 `deps.buildModelRun` 现在 `await` 一下 —— await 非 Promise 值会立即 resolve，
   所以既有的同步测试注入照常工作。
3. **`integrations/docx.js`**：mammoth 挪进函数体内。

### 问题二：`/api/history` 每次请求重复解析全部会话文件

列表接口对目录下**每个** jsonl 都要开文件、解析前 50 行。实测 98 个会话时
单次 108ms / 0.57MB 临时对象 —— 但这些文件里只有**当前正在写的那个**会变，
其余 97 份每次都在重复解析出完全相同的结果。

加 `mtime` 缓存：`fullPath → { mtimeMs, meta }`，stat（廉价）后比对 mtime，
没变就复用解析结果。变了才重新解析，语义与原来一致。

**不会无限增长**：每次扫描结束用「本轮实际见到的路径」重建缓存，
已删除的会话自然被淘汰，缓存大小恒等于目录下文件数。

顺带修掉那行**每次请求都打印**的 `console.log`（前端一轮询就刷屏）。
改成只在真有文件变化时记一行，日志因此变得有信息量：它现在表示「几个会话变了」。

**补了 4 条缓存失效测试** —— 缓存最典型的故障不是慢，而是改了文件却仍返回旧数据：
内容变化后必须返回新标题（显式改 mtime 避免「两次写入落在同一毫秒」的偶发假绿）、
mtime 未变时结果一致、文件删除后不得再出现、新增文件能被发现。

### 刻意没做的

- **`store.readJson` 不加同款缓存**。它返回**可变对象**，而 `updateJson` 正是
  「读-改-写」模式 —— 缓存并共享引用会让调用方的修改污染缓存，
  这种数据污染极其隐蔽。风险远大于 0.5MB/次临时分配的收益。
- **Claude Agent SDK 不懒加载**。它迟早会被用到（web 的核心功能），懒加载只是把
  成本推迟到用户第一次发消息时，反而增加首次延迟。

### 验证

全量 1875 通过、e2e 10/10 通过（`conv-notify` 正是飞书通知链路）。
另外单独验证了飞书加载链：`createFeishuChannel()` / `getLarkSdk()` /
`createWsClient()` 均正常，WSClient 实例能创建。

> ⚠️ **openai-compat provider 的真实执行路径未端到端验证**（需要真实的 OpenAI 兼容凭证）。
> 它的单测覆盖了 `run()` 的流程（用注入的 buildModelRun），但真跑一次模型调用没做过。
> 配置该 provider 的用户首次使用时值得留意。

## 五、测试与验证汇总

| 项 | 体检前 | 体检后 |
|---|---|---|
| `npm test` | 1825 通过 / 0 失败 | **1871 通过 / 0 失败**（+46） |
| `npm run test:e2e` | 无此命令，10 个门禁靠手动跑 | **10/10 通过**（此前实际 2/10，且无人知晓） |
| 分层倒挂 | 2 处（store→entrypoints、shared→plugins） | **0 处**（四条检验命令全空） |
| `npm audit`（生产） | 3 个（含 dompurify XSS） | 2 个（均在 devDep 的测试夹具路径，上游未放宽范围） |

新增测试：`process-guard` +5、`api.js` +17、`route-match` +17、其余 +7。

一次性验证（未固化为测试，需要时照做）：
- marked v12↔v18 的 18 组样本渲染输出比对（jsdom 同时加载两版）
- anime 4.1.4↔4.5.0 的 API 表面比对（`<script>` 注入 + `pretendToBeVisual`）
- 表驱动路由 22 项端到端（真起 server 打端点）
- 前端 12 项浏览器验证（vendor 全局就位 / 渲染消毒 / 目录弹层真实渲染 / 零 pageerror）

## 六、未完成事项（交接）

1. **`req-chat.js:417` 的死代码**：查 `.req-guidelines` 的草稿保护，
   而该元素已不再被创建（`prevTa` 恒 null）。连同 `app.css` 里的孤儿样式一并清理。
2. **B5-3 大文件拆分**：`chat.js` 3403 / `req-view.js` 3332 / `app.css` 4047。
   **前置条件已就绪**（门禁 10/10，含守护 `_bubbleMap` 三方同序不变量的
   `steer-bubble` 与全视图零 pageerror 的 `panels-smoke`）。
   按 `specs/2026-07-24-appjs-split-design.md` 的方法论单独立项：
   census → 分阶段 → 每步过门禁 → 抽离检查清单。
3. **B4 剩余约 110 处 fetch 未迁移**（`chat.js` / `req-view.js` / `req-chat.js` /
   `req-map.js` / `settings-panel.js` / `tasks-panel.js` 等）。
   刻意停在这里：样板消除是次要收益，**没有安全收益**（见 B4 对 D2 的修正），
   而每处迁移都是一次无自动化覆盖的运行时改动，且门禁当前只有 4/10 可用。
   建议门禁恢复后再推进，或随功能改动就近迁移。
4. **`chat.js` 里 4 处重复的 `try { job.es.close() } catch {}`** 可抽 helper，
   本轮刻意没动（同上，风险不成比例）。
5. **`serveStatic` 的前缀校验建议改 `path.relative` 加固**。当前**安全**
   （见 §2 推翻 2），但它的正确性依赖「pathname 恒以 `/` 开头 + normalize 吃掉根上的 `..`」
   这两个不显然的性质，属于「对了但脆」。
6. **anime 4.5.0 已官方提供 `scrambleText` / `splitText`**，而 `anim.js` 里是 4.1.4
   时期自己用 rAF 实现的等价效果。刻意不迁移（现有实现工作正常，换成官方 API 是纯重写风险），
   已在代码注释里记录，日后动这块动画时可考虑。

## 七、协作约定（沿用）

1. **不要自动 git 提交**，改动留工作区。
2. 大改动前先出 spec 和实现计划，等用户拍板。
3. 文档与注释用中文，注释解释「为什么」而非复述代码。
4. 删除**未入 git** 的文件必须逐项确认（本轮删的 23 个 `tmp-*` 属此类，不可恢复）；
   已入库文件的移动/删除可直接做（git 可恢复）。
5. **用于否定性结论的检索绝不能带 `head`/limit**（见 §2 推翻 3 的教训）。
