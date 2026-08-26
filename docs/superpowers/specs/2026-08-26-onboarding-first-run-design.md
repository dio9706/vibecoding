# 新用户首次引导 — 设计文档

- 日期：2026-08-26
- 状态：已拍板，待实现计划
- 关联：`public/js/boot-gate.js`（启动罩）、`src/store/config-transfer.js`（配置导入导出）

## 1. 背景与问题

刚安装的用户第一次打开应用时，`settings.json` 里没有任何模型凭证。此时应用**实质不可用**：发消息必然失败，但界面上侧栏、顶栏、输入框全都可点，用户得不到任何指引，只能自己摸到设置页。

同时发现一个既有缺陷：配置导出包**不含 `action-configs.json`**（设置页「托管配置」tab 的全量数据）。老用户导出配置换机导入后会以为配齐了，实际托管配置为空，而且 `bots` 里的 botId 引用关系直接断裂（`deleteConfigsByBot` 证明两者有关联）。这个缺陷会直接坑到本需求的「一键导入」。

## 2. 目标与非目标

**目标**

1. 首次打开（无任何模型）时用全屏引导接管界面，走完才放行。
2. 引导内可完成：添加模型（必填）、我的飞书 open_id（选填）、飞书机器人（选填）。
3. 引导内提供「一键导入已有配置文件」，让老用户一步到位。
4. 补全导出包：纳入 `action-configs.json`，让「一键导入」真正可信。

**非目标**

- 不做老用户的任何行为变更（判定为老用户则一行代码都不执行，照常撤罩）。
- 不引入独立的 first-run 标记位。
- 不把 `user-vars.json` / `bindings.json` / `saved-dirs.json` / `memory-bank.json` 纳入导出（本次范围外）。
- 不在引导里铺开机器人的 persona / projectDir / autonomy / 文案等字段，那些留在设置页。

## 3. 关键决策与理由

| # | 决策 | 理由 |
|---|---|---|
| D1 | 新用户判定 = `settings.tokens.length === 0` | `tokens[]` 是两类模型（Claude 账号池 + `openai-compat` 凭证）的唯一存储，一个条件覆盖两类 |
| D2 | 不加 first-run flag | YAGNI。用户删光所有模型后应用确实又变成不可用状态，此时重新引导是正确行为而非 bug |
| D3 | 复用启动罩 `#bootOverlay`，不新建 overlay | LOGO 视觉零闪断（无卸载重建），且启动罩天然全屏，能挡住「点了会报错」的侧栏/顶栏/输入框 |
| D4 | 单页三段式，不做分步 wizard | 字段总量小（模型 3~4 个 + open_id 1 个 + 机器人 3 个），上步骤状态机是过度设计 |
| D5 | 模型两类都给，Tab 切换 | 硬约束：引导不可跳过（模型必填）。只给一类会把只用另一类的用户死锁在引导里 |
| D6 | 引导完成后 `location.reload()` | 与现有「导入配置后 reload」一致；reload 时已是老用户路径，无需在内存里同步一堆已初始化的状态 |
| D7 | 导出只补 `actionConfigs`，升 version 2 | 只有它会造成引用关系断裂；其余几个文件都是可重建的弱数据。导入侧兼容 v1 |
| D8 | 引导无关闭按钮 | 没有模型就是不可用，给关闭按钮等于把用户放进一个必然报错的界面 |

## 4. 模块划分与改动清单

| 文件 | 性质 | 职责 |
|---|---|---|
| `public/js/onboarding.js` | 新增 | 引导编排：接管罩子 → 动画时序 → 表单提交 |
| `public/js/onboarding.logic.js` | 新增 | 纯函数：新用户判定 + 表单校验（无 DOM/无 fetch） |
| `public/js/onboarding.logic.test.js` | 新增 | 上者单测 |
| `public/css/onboarding.css` | 新增 | 引导态样式（`app.css` 已 110KB，不再往里堆） |
| `public/js/vendor-presets.js` | 新增 | 从 `settings-panel.js` **抽出** `VENDOR_PRESETS` / `BASEURL_TO_VENDOR` |
| `public/js/vendor-presets.test.js` | 新增 | 取代 `settings-panel.vendor.test.js`（后者靠 `fs` 读源码切片跑，常量抽出即失效） |
| `public/js/config-import.js` | 新增 | 从 `settings-panel.js` **抽出**「解析文件 → 校验 → 确认 → POST」流程 |
| `public/index.html` | 改 | `#bootOverlay` 内包一层 `.ob-brand`、新增 `.ob-status` 与 `#obPanel` 静态骨架；引入 `onboarding.css` |
| `public/js/boot-gate.js` | 改 | 新增撤罩 handoff 协议 |
| `public/app.js` | 改 | 注册 handoff |
| `public/js/settings-panel.js` | 改 | 改为 import 两个抽出模块 |
| `src/store/config-transfer.js` | 改 | `CONFIG_VERSION` 升 2，`buildExport`/`parseImport` 处理 `actionConfigs` |
| `src/store/config-transfer.test.js` | 改 | v2 往返 + v1 兼容用例 |
| `src/entrypoints/web/routes-settings.js` | 改 | export 带上 `getConfigs()`，import 落 `saveConfigs()` |

**为什么必须抽 `vendor-presets.js` 和 `config-import.js`**：不抽就得在 `onboarding.js` 里复制一份厂商预设表和导入流程。厂商预设是会长期增补的数据（加一个厂商要改两处），导入流程是有校验分支的逻辑（两份实现必然漂移）。抽出后 `settings-panel.js` 净减约 60 行。

## 5. 判定与交接协议

### 5.1 boot-gate 的 handoff

`boot-gate.js` 的职责保持「等后端就绪 + 撤罩」，只在撤罩前多问一句「有人要接管吗」：

```js
let _handoff = null;

/** 注册撤罩接管者：boot-gate 在撤罩前 await 它，返回 true 表示接管
 *  （罩子不撤，生命周期移交给接管者）。用于新用户引导复用启动罩，避免 LOGO 卸载重建闪断。 */
export function setOverlayHandoff(fn) { _handoff = fn; }
```

`_run()` 末尾、原撤罩代码之前插入：

```js
if (_handoff) {
  let taken = false;
  try {
    taken = await _handoff(overlay);
  } catch (e) {
    // 引导炸了也不能把用户永久锁在罩子里 —— 咽掉异常照常撤罩
    console.error('[Boot] 撤罩接管者异常，照常撤罩', e);
  }
  if (taken) return; // 罩子已移交，不再 hide/remove
}
```

`app.js` 在顶层（现有启动 IIFE **之前**）注册：

```js
import { whenBackendReady, setOverlayHandoff } from './js/boot-gate.js';
import { maybeStartOnboarding } from './js/onboarding.js';
setOverlayHandoff(maybeStartOnboarding);
```

注册必须早于 `whenBackendReady()` 的调用点（`app.js` 现第 216 行）。放在现有 `bindConvNotify(...)` 一组视图桥调用附近即可。

### 5.2 判定

`onboarding.js` 的 `maybeStartOnboarding(overlay)`：

1. `GET /api/settings` 取 `tokens`。
2. **任何异常（网络失败 / 非 JSON / 后端未就绪）一律返回 `false`** —— 宁可漏一次引导，不可把用户卡在罩子里。这条同时覆盖了用户点「仍然进入」跳过等待、后端实际未通的场景。
3. `isNewUser({ tokens })` 为 false → 返回 `false`，boot-gate 照常撤罩。
4. 为 true → 启动引导，返回 `true`。

### 5.3 与 app.js 启动初始化的关系

`whenBackendReady()` 依然正常 resolve（`return` 只是跳过撤罩），所以 `initChat()` / `initReqView()` 等启动初始化**照常在罩子后面跑完**，不被引导阻塞。用户看不到，但界面在 reload 前就已就绪。

引导完成 → `location.reload()` → 重走一遍 boot-gate，此时 `tokens` 非空、判定为老用户、正常撤罩。

## 6. 动画编排

### 6.1 DOM 结构调整

```
.boot-overlay#bootOverlay
├── .ob-brand#obBrand              ← 新增包裹层（承载左移 transform）
│   ├── svg.boot-star#bootStar       （原样）
│   ├── .vibe-title#bootTitle        （原 .vibe-title，补 id）
│   └── .ob-status#bootStatus      ← 新增包裹层，注意是 brand 的**子节点**
│       ├── .boot-text#bootText      （原样）
│       └── .boot-skip#bootSkip      （原样）
└── .ob-panel#obPanel[hidden]      ← 新增引导面板骨架（静态 HTML，不用 JS 拼）
```

`.ob-brand` 与 `.ob-status` 都用 `flex column / align-center / gap:16px` —— 与改造前 `.boot-overlay` 的参数完全一致，非引导态视觉零回归。

**`.ob-status` 必须是 `.ob-brand` 的子节点而非兄弟节点**：`.ob-brand` 为了做位移动画必须绝对定位（见 6.2），一旦如此，做兄弟节点的 `.ob-status` 就得靠硬编码 `top` 偏移跟着 LOGO 走 —— 而 brand 的高度取决于标题字号与 LOGO 尺寸，那个偏移值极脆。作为子节点则完全不需要垂直偏移：引导态 status `display:none` 后 brand 高度自然收缩，而它靠 `translate(-50%, -50%)` 定位，收缩后仍然居中。垂直方向一个魔数都不需要。

面板骨架写在静态 HTML 而非 JS 拼装：与启动罩同源，页面第一帧就在 DOM 里，无二次挂载抖动，也便于直接改样式调试。

### 6.2 布局数值

绝对定位 + **纯 transform** 位移（不做 width/flex 动画 —— 那类属性不上合成层，会掉帧）：

```css
/* 视觉盒推导：LOGO 96(=120×0.8) + gap 56 + 面板 420 = 572 → 左边缘 -286 */
--ob-logo-x:  -238px;  /* -286 + 96/2 */
--ob-panel-x:   76px;  /* -286 + 96 + 56 + 420/2 */
--ob-panel-w:  420px;
```

`.ob-brand` 与 `.ob-panel` 均 `position:absolute; left:50%; top:50%`，初始 `transform: translate(-50%, -50%)`（与现有 flex 居中视觉一致），引导态各自平移到上述 x。`transform-origin` 默认 center，`scale(.8)` 不改变中心点。

### 6.3 时序

| t (ms) | 动作 |
|---|---|
| 0 | 罩子加 `.ob-arm`：六芒星从 `vibeSpinPause 2.6s infinite` 切为新建的 `vibeSpinOnce 780ms` 单次，强制 reflow 重起播 |
| 0 → 780 | 旋转 120°，沿用现有 easing `cubic-bezier(.7, 0, .25, 1)` |
| 780 → 1100 | 静止 320ms，给「转完停稳」的落定感 |
| 1100 | 罩子加 `.ob-open`：<br>· `#bootTitle` opacity 1→0 + translateY 0→-6px，220ms<br>· `.ob-status` 立即 `hidden`（引导态下「正在启动服务…」「仍然进入」都已无意义）<br>· `.ob-brand` → `translate(calc(-50% + var(--ob-logo-x)), -50%) scale(.8)`，460ms `cubic-bezier(.22, 1, .36, 1)` |
| 1280 | `#obPanel` 去 `hidden`，opacity 0→1、translateX 从 `+120px` 收到 `var(--ob-panel-x)`，380ms |
| ~1660 | 焦点落到第一个输入框 |

新建 keyframes（`onboarding.css`）：

```css
@keyframes vibeSpinOnce    { from { transform: rotate(0deg); }  to { transform: rotate(120deg); } }
@keyframes vibeSpinOnceRev { from { transform: rotate(0deg); }  to { transform: rotate(-120deg); } }
```

**为什么重起播而不是等当前周期的 `animationend`**：罩子在后端冷启动期间已经转了不定圈数，等当前周期结束的话等待时间是 0~2.6s 随机。重起播给「引导开场」一个确定起点，也才符合「动画播放一次后左移」的语义。780 + 320 = 1100ms 是口感值，可单点调整。

### 6.4 降级

```css
@media (prefers-reduced-motion: reduce) { /* 全部 transition/animation 置 none */ }
```

对应 JS 分支：检测到 `prefers-reduced-motion: reduce` 时跳过 0→1100ms 的等待，直接加 `.ob-open` 并立刻显示面板。

时序推进用 `setTimeout` 链而非 `animationend` 监听：`animationend` 在标签页后台节流、动画被 CSS 覆盖、或 `prefers-reduced-motion` 置 none 时不一定触发，会让引导永久停在半路。

## 7. 引导面板：表单与提交语义

单页三段，段头标 `*必填` / `选填`，两个选填段可整段折叠（默认折叠）。面板顶部一个「⇪ 一键导入已有配置文件」。面板 `max-height: 78vh`，内部滚动。

### 7.1 ① 添加模型（必填，Tab 二选一）

两个 Tab，**任一填完即解锁「完成」**：

- **Claude 账号**：名称（选填，默认空）/ Token（必填）
  → `POST /api/settings` body `{section:'tokens', action:'add', label, token}`

**不给「订阅类型」下拉**：`SUBSCRIPTION_TYPES` 全库无使用点（`#tokenSubscription` 的 options 硬编码在 `index.html`），而后端 `handleSettings` 的 `tokens/add` 分支只调 `addToken(str(data.label), str(data.token))` —— `subscription` 传了也被丢弃。不该在引导里放一个唯一选项、且存不下去的字段。该字段的既有问题不在本次范围内修。
- **自定义模型**：厂商（`VENDOR_PRESETS`，选中即自动带入预设 `baseURL` 与模型候选）/ API Key / Base URL / 模型，后三者均必填
  → `POST /api/credentials` body `{apiKey, baseURL, model, vendor}`

自定义模型 Tab **不给「名称」字段**：`label` 在后端是选填的纯展示元数据，引导阶段只有一个凭证，加字段只是增加干扰，需要时到设置页改。Claude 账号 Tab 保留「名称」，因为账号池本就是多账号场景，`★ 首选` 排序时要靠它区分。

### 7.2 ② 我的飞书 open_id（选填）

单字段，长度上限 128（对齐后端 `handleSettings` 的 `section:'profile'` 校验）。
→ `POST /api/settings` body `{section:'profile', myFeishuOpenId}`

### 7.3 ③ 飞书机器人（选填）

名称 / App ID / App Secret。前端预校验与后端 `cleanBotInput` 保持一致：

- App ID 须匹配 `/^cli_[0-9a-fA-F]{16}$/`
- App ID 填了则 App Secret 必填
- 三者全空 = 未填，跳过该段

→ `POST /api/bots` body `{name, platform:'feishu', appId, appSecret, enabled: true}`

**`enabled: true` 是必需的**：不带这个字段，用户填完机器人却不生效，等于白填。

### 7.4 提交与失败语义

按 ① → ② → ③ 串行提交。

- **模型段失败 → 阻塞**：toast 报错、保留表单内容、不撤罩、「完成」恢复可点。模型是硬门槛，存不进去就不能放行。
- **飞书两段失败 → 仅提示不阻塞**：`toast('飞书配置未保存，可稍后到设置页补：<原因>')` 后照常放行。选填项不该把用户挡在门外。
- 「完成」在提交期间 `disabled`，防重复提交产生重复凭证。
- 全部走完 → `location.reload()`。

### 7.5 「完成」按钮的启用条件

模型段当前 Tab 校验通过即启用。未通过时 `disabled` 且 `title` 写明缺什么（例如「请先填写 API Key 与模型」）。

### 7.6 一键导入

复用抽出的 `config-import.js`。引导场景**跳过「将覆盖当前全部配置」的危险确认**——新用户本来就是空配置，那句话是误导。

导入成功 → toast + `location.reload()`。导入结果提示区分包版本：

- v2 包：`配置已导入（含托管配置）`
- v1 包：`配置已导入。该文件为旧版，不含托管配置，需到设置页重新配置动作`

## 8. 导出补全（只补 action-configs）

### 8.1 `src/store/config-transfer.js`

```js
export const CONFIG_VERSION = 2;

/** 把 settings + 托管配置包成带类型/版本/时间戳的导出对象 */
export function buildExport(settings, actionConfigs, exportedAt) { /* ... */ }
```

- `buildExport` 多带一个 `actionConfigs` 数组字段（非数组归一为 `[]`）。
- `parseImport` **同时接受 version 1 与 2**：
  - v2 → `{ok:true, settings, actionConfigs: [...]}`
  - v1 → `{ok:true, settings, actionConfigs: null}`
  - 其他版本 → `{ok:false, error:'配置文件版本不支持'}`
- `actionConfigs: null` 的语义是「本次导入不涉及托管配置」，导入侧据此**不动** `action-configs.json`。老包不该把用户现有动作清空。

### 8.2 `src/entrypoints/web/routes-settings.js`

- `handleSettingsExport`：`buildExport(getSettings(), getConfigs(), new Date().toISOString())`
- `handleSettingsImport`：`replaceSettings()` 之后，`parsed.actionConfigs !== null` 时调 `saveConfigs(parsed.actionConfigs)`（`src/store/action-configs.js` 已有此接口，无需新增）

顺序上先 `replaceSettings` 再 `saveConfigs`：`migrateToBots()` 会做「孤儿动作收养」（`adoptOrphanConfigs`），必须在动作落盘之后跑。因此调用顺序为 `replaceSettings` → `saveConfigs` → `migrateToBots` → `scheduleAllSwitchBacks`。

### 8.3 本次不动的文件

`user-vars.json` / `bindings.json` / `saved-dirs.json` / `memory-bank.json` / `conv-notify.json` 均不纳入导出。理由：都是可重建的弱数据，且不存在跨文件引用断裂问题。

明确**不该**导出的运行时状态与业务数据：`active-runs` / `conv-messages` / `feature-index` / `optimize` / `pending-resume` / `requirements` / `tasks`。

## 9. 纯逻辑与测试

### 9.1 `public/js/onboarding.logic.js`

```js
/** 新用户判定：tokens 为空即视为未配置任何模型（两类 providerId 共用此存储） */
export function isNewUser(settings)

/** 引导表单校验。返回 { ok, errors: {模型段?, 机器人段?} }
 *  模型段按 activeTab 分支校验；飞书两段全空视为未填（合法）。 */
export function validateOnboardForm(state)
```

### 9.2 `onboarding.logic.test.js` 用例

- `isNewUser`：`{tokens: []}` → true；`{tokens: [{}]}` → false；`{}` → true；`{tokens: 'x'}` → true（非数组按未配置处理）；`null` → true
- `validateOnboardForm`：
  - Claude Tab：token 空 → 报错；token 有值 → 通过
  - 自定义 Tab：apiKey/baseURL/model 各缺一个 → 分别报错；三者齐 → 通过
  - open_id 超 128 字符 → 报错；空 → 通过
  - 机器人：三字段全空 → 通过；appId 格式错 → 报错；appId 有值而 secret 空 → 报错；appId + secret 齐 → 通过

### 9.3 `config-transfer.test.js` 增补

- v2 往返：`buildExport(s, ac)` → `parseImport` 拿回同样的 `settings` 与 `actionConfigs`
- v1 包导入：`{__type, version:1, settings}` → `ok:true` 且 `actionConfigs === null`
- version 3 → 被拒
- `buildExport(s, 'not-array')` → `actionConfigs` 归一为 `[]`
- `buildExport(s, undefined)` → `actionConfigs` 归一为 `[]`

### 9.4 运行

`npm test`（`node --test "src/**/*.test.js" "public/**/*.test.js"`，glob 已覆盖新增的 `public/js/onboarding.logic.test.js`）。

### 9.5 手工验证清单

动画与 DOM 编排不写自动化测试（项目现无浏览器测试基建），改为手工验证：

1. 清空 `settings.json` 的 `tokens` → 重启 → 罩子应转一次后左移、面板展开
2. 只填 Claude Token → 完成 → reload 后应正常进入对话界面，设置页能看到该账号
3. 只填自定义模型（换厂商时 baseURL 应自动带入）→ 完成 → 同上
4. 模型故意填错（如 API Key 为空）→「完成」应 disabled
5. 飞书 App ID 填 `cli_123`（格式错）→ 应报错阻塞该段
6. 有 token 时启动 → 罩子应照常撤掉，无引导（老用户零影响）
7. 断开后端 → 点「仍然进入」→ 应照常撤罩，不卡在引导
8. `prefers-reduced-motion: reduce`（系统开启「减少动态效果」）→ 应无动画直接到位
9. 导出→清空 `action-configs.json`→导入 → 托管配置应恢复
10. 用旧的 v1 包导入 → 应提示「不含托管配置」且现有动作不被清空

## 10. 风险

| 风险 | 处置 |
|---|---|
| 引导逻辑抛异常把用户锁在罩子里 | boot-gate 的 handoff 调用包 try/catch，异常一律照常撤罩 |
| 判定请求失败导致老用户被误引导 | 判定失败一律返回 false（漏引导优于误引导） |
| 时序用 `animationend` 可能不触发 | 改用 `setTimeout` 链，不依赖动画事件 |
| 布局数值（-238/76）随面板宽度改动失效 | 收进 CSS 变量并在注释里写清推导公式 |
| 抽出 `vendor-presets` 破坏设置页 | 抽出后 `settings-panel.js` 只改 import，行为不变；手工验证清单第 2、3 项覆盖 |
