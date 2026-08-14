# 「新需求」全生命周期工作流（评审设计期→开发期→测试期→归档）—— 设计

日期：2026-08-04
状态：已确认（用户 2026-08-04 批准；布局经视觉伴侣两轮确认，五项关键口径经问答拍板）

## 1. 背景与目标

web 执行台新增「新需求」入口（侧栏 ＋新对话 右侧），作为**独立于对话的全新逻辑**，
承载一条需求从评审设计、开发、测试到归档的完整链条：

1. **评审设计期**：录入前/后端工程目录（各自标记 开发/只读参考）＋需求文档＋补充说明（可带附件），
   AI 产出「开发文档」（说人话总结＋逐工程 新增/删除/更新 明细）；补充说明可反复提交自动修订；
   本期**不支持对话**。定稿后进入开发期。
2. **开发期**：定稿即自动开始可进行的开发；前端工程可随时补「后端 API 文档」（多份，增/删/改后自动对照修正代码）
   与「设计准则」（输入框直填）；纯后端工程无需输入；可自由对话调整实现。顶部横幅展示两工程名＋需求文档，
   右侧按钮［完成开发］。
3. **测试期**：贴飞书多维表格链接，自动筛「属于自己」的 BUG——确定的直接开修，疑问的等本人确认；
   可自由对话；横幅按钮［测试通过］。
4. **归档期**：禁用对话，仅一个备注输入框，确认后归入档案（可回看）。

## 2. 用户拍板的决策记录

| 决策点 | 结论 |
|---|---|
| Git 隔离策略 | **工程目录内切需求分支**（定稿时逐开发工程 `checkout -b req/<id>-<slug>`，不用 worktree） |
| 双开发工程会话形态 | **单会话跨双工程**（SDK `additionalDirectories`，sdk.d.ts:1293 已核验） |
| 补充说明 → 文档更新 | **提交即自动修订**（沿用同一 docgen session 增量改，版本 v1/v2/… 可回看） |
| 测试期「自己」的认定 | **全局设置填一次**（设置页「我的飞书 open_id」，回退可信提交人名单第一个） |
| 前端实现路线 | **寄生复用 chat.js**（需求会话=特殊 conv，聊天核心能力全部免费；文档/归档视图独立模块） |
| 评审期布局 | **文档为主＋底部补充框**（配置收顶部芯片条；视觉稿 layout-b） |
| 开发/测试期布局 | **右侧固定栏**（开发期=API 文档＋设计准则；测试期=BUG 面板；窄屏收成横幅芯片） |

## 3. 数据模型

新增 `src/store/requirements.js`（`requirements.json`，走 store/index.js 文件锁，与 tasks.json 同范式）：

```js
{
  id: 'r_' + Date.now().toString(36) + rand4,
  title: '',                       // 创建时填
  phase: 'review' | 'dev' | 'test' | 'archiving' | 'archived',
  projects: {
    frontend: { dir, dev: true } | null,   // dev=false 即只读参考工程
    backend:  { dir, dev: false } | null,
  },
  reqDoc: { name, path } | null,   // 粘贴文本也落成 md 文件
  supplements: [{ id, text, files: [{name, path}], at }],
  devDoc: { versions: [{ v, path, summary, at }] },  // path=完整 md；summary=「说人话总结」节纯文本
  docSession: null,                // 评审期 docgen 的 Claude session_id（增量修订）
  convId: null,                    // 开发/测试期聊天 conv（前端 localStorage conv，meta.reqId 反向关联）
  devSession: null,                // 开发会话 session_id（onInit 回填；换浏览器重建 conv 时续接）
  branches: [{ dir, branch, baseBranch }],   // 定稿时逐开发工程记录
  apiDocs: [{ id, name, path, updatedAt }],
  designGuidelines: '',
  bitable: { url, appToken, tableId } | null,
  bugs: [{ id, recordId, title, detail, verdict: 'sure'|'doubt', reason,
           status: 'pending'|'fixing'|'fixed'|'ignored'|'failed', at }],
  busy: { kind: 'docgen'|'develop'|'api-fix'|'bug-fix', runId, startedAt } | null,  // 串行闸落盘镜像
  archive: { note, summary, archivedAt } | null,
  createdAt, updatedAt, history: [{ at, event }],
}
```

文件布局：`APP_DATA_DIR/requirements/<id>/`（req-doc.md、supplements/、api-docs/、dev-doc-v1.md…、archive.md）。

**隔离原则**：需求 conv 带 `meta.reqId`，chat.js 的「本次会话」列表将其过滤；对话体系不感知需求语义，
需求语义（阶段/横幅/右栏）全部由 req-view 挂载。

## 4. 阶段状态机

```
review ──定稿──▶ dev ──完成开发──▶ test ──测试通过──▶ archiving ──确认归档──▶ archived
```

- **定稿守卫**：devDoc 至少 1 版 + 至少 1 个开发工程；逐开发工程建分支（工作区脏 → 返回警告，
  前端确认后可 force；建分支失败整体中止，不推进 phase）。定稿后配置与文档冻结（PUT config 返回 409）。
- **完成开发/测试通过/确认归档**：前端 confirmDialog 二次确认；服务端守卫——`busy` 非空或该需求 conv
  存在活跃 run 时返回 409（提示等当前任务完成或先停止），防止阶段切换时任务悬在半空。
- 所有阶段流转 API 幂等：phase 不匹配返回 409，不重复执行副作用。

## 5. 后端设计

### 5.1 模块

| 模块 | 职责 |
|---|---|
| `store/requirements.js` | CRUD + 锁内更新（getRequirements/getRequirement/createRequirement/updateRequirement） |
| `entrypoints/web/requirement-ops.js` | 编排：docgen / finalize 建分支 / 系统任务队列（串行闸）/ bitable 巡检 / 归档摘要 |
| `entrypoints/web/routes-requirements.js` | HTTP 路由薄壳（鉴权 body 校验 → ops） |
| `integrations/claude.js` | 新增 `additionalDirectories` 透传（一行） |
| `store/settings.js` + 设置页 | 新增 `myFeishuOpenId`（基础 tab 一个输入框） |

### 5.2 路由

```
POST /api/req/create {title}
GET  /api/req/list                       → [{id,title,phase,updatedAt,busy}]（列表徽标用）
GET  /api/req/get?id                     → 完整记录 + devDoc 最新版内容（前端渲染）
PUT  /api/req/config {id,projects,reqDoc}          // 仅 review 期
POST /api/req/docgen {id}                           // 生成初版 / 失败重试
POST /api/req/supplement {id,text,files}            // 落盘 + 自动入队 docgen 修订
POST /api/req/finalize {id,force}                   // 定稿：建分支 → phase=dev → 自动首轮开发
POST /api/req/apidoc {id,name,path}  DELETE /api/req/apidoc {id,docId}   // 变更后自动入队 api-fix
PUT  /api/req/guidelines {id,text}
POST /api/req/conv {id,convId}                      // 前端建需求 conv 后回填
POST /api/req/dev-done {id}                         // phase=test
POST /api/req/bitable {id,url}                      // 解析→映射→筛选→逐条评审→bugs[]
POST /api/req/bug/confirm {id,bugId}  POST /api/req/bug/ignore {id,bugId}
POST /api/req/test-pass {id}                        // phase=archiving
POST /api/req/archive {id,note}                     // 生成档案 → phase=archived
GET  /api/req/doc?id&v                              // 某版开发文档 md 原文
```

附件/文档上传复用现有 `/api/upload`，返回路径后由上述接口登记。

### 5.3 AI 任务形态

**docgen（评审期，无对话）**：前置守卫——至少配置 1 个工程目录且需求文档已录入，否则报错引导先补配置。
`runClaude` 直连——只读工具（Read/Grep/Glob）、`cwd`=前端工程优先、无则后端（全篇「第一个（开发）工程」
均按此序），`additionalDirectories`=其余工程目录、`persistSession` 存/续 `docSession`。prompt 注入：需求文档全文、
全部补充说明（按时间序）、工程角色表（开发/只读）。**输出契约**：纯 markdown，
第一节 `## 一、说人话总结`（概括改动点），第二节 `## 二、详细设计`（逐开发工程 新增/删除/更新 明细）。
后端从 result 落盘为 `dev-doc-vN.md`，`summary` 由纯函数抽取第一节文本（解析失败取前 300 字）。
AI 无写权限——文档由后端落盘，从物理上杜绝评审期越界改码。超时：`Promise.race` 15 分钟，
超时/失败版本号不推进，前端可点重试。

**开发/测试期系统任务（develop / api-fix / bug-fix）**：走现有 `startClaudeRun` 基建，
带 `convId`=需求 conv → 前端聊天流天然获得流式/工具活动/审批/续跑全部能力。
`cwd`=第一个开发工程，`additionalDirectories`=其余已配置工程；只读参考工程靠 prompt 声明
「仅作参考，禁止修改其中任何文件」约束（additionalDirectories 无只读粒度，靠归档前 diff 复核兜底）。
权限模式对齐 auto-dev：系统任务 `bypassPermissions`；用户手动对话沿用 FAB 偏好。
`devSession` 由 onInit 回填，所有系统任务与用户对话 resume 同一 session（上下文连续）。

- develop prompt：开发文档终稿路径（让 AI Read）+ 工程角色 + 设计准则 + 现有 API 文档列表 + 「按文档开始可进行的开发」。
- api-fix prompt：API 文档「X」已新增/更新/删除（附路径）→ 对照修正本需求已实现代码。
- bug-fix prompt：BUG 标题+详情（含表格记录字段）→ 修复；run 正常结束置 `fixed`，异常/中断置 `failed`（可重试）。

**同需求串行闸**：requirement-ops 内存队列（web 进程单泵，5s tick），出队条件 =
`requirement.busy == null` **且** runs 注册表中该 convId 无活跃 run（用户正在对话时系统任务等待）。
任务启动写 busy，settle 清 busy。进程重启：启动扫描 busy 残留 → 清空并在 history 记「任务因重启中断」，
不自动重跑（用户可从面板重新触发）。用户对话不经队列（chat.js 原生 send/steer/排队机制照旧；
系统任务运行中用户发消息 = 现有「运行中排队/插话」行为，可接受）。

### 5.4 测试期 bitable（复用 \10001 基建）

直接 import 复用：`lark.js`（listBitableTables/listBitableFields/searchBitableRecords）、
`plugins/team-tools/bug-patrol/logic.js`（parseBitableLink / buildFieldMappingPrompt / validateFieldMapping /
buildStatusFilter / isAssignedToMe / recordTitle / buildRecordDetail）、`review/index.js` 的 `reviewTask`。
差异点：

- 「自己」= `settings.myFeishuOpenId` || 可信提交人名单[0]；两者皆空 → 接口报错引导去设置页。
- 评审判决映射：`fix` → `verdict:'sure'` 自动入队 bug-fix；`ask`/`reject` → `verdict:'doubt'`（带 reason）等确认。
- **不回写多维表格状态**（与 \10001 不同——表格归测试团队管理），仅面板内状态流转。
- 重复贴同一表格：按 recordId 去重，已存在的 bug 不重复立项，新增记录追加。

### 5.5 归档

`archive`：汇总纯函数生成 `archive.md`——开发文档终稿引用、branches（逐工程 `git log baseBranch..branch --oneline`
提交摘要 + 计数）、BUG 修复统计（fixed/ignored/failed 各几条+清单）、用户备注。写盘后 phase=archived。
git 命令失败降级为「无法读取提交摘要」，不阻塞归档。

## 6. 前端设计

### 6.1 侧栏（index.html + chat.js 一处钩子 + req-view）

- `＋新需求` 按钮加在 `#sidebarNew` 右侧（同排双按钮）。
- `#convList` 上方新增 `#reqList` 区：「本次需求」分组（阶段徽标：评审=橙/开发=蓝/测试=紫/归档中=灰），
  「已归档」折叠组（默认收起）。数据源 `GET /api/req/list`，打开需求视图时刷新 + 30s 轮询徽标。
- chat.js `renderConvList` 过滤 `meta.reqId` 的 conv（唯一列表侧改动）。

### 6.2 `js/req-view.js`（新模块，自带样式挂 app.css）

- **需求打开**：`openRequirement(id)` → fetch 记录 → 按 phase 分流：
  - `review`/`archiving`/`archived` → 文档模式：panelView 新增 `panel-page[data-view="req"]`，
    自带底部输入框（评审=补充说明+📎附件；archiving=归档备注+确认归档；archived=只读档案），
    **不触碰 chat composer**。
  - `dev`/`test` → 聊天模式：`openConv(record.convId)`（无 conv 则新建并绑 `devSession` 续接，回填 /api/req/conv）
    → 挂横幅 + 右栏。
- **评审期文档模式**：顶部配置芯片条（前端/后端工程+开发/只读、需求文档状态、［编辑配置］）；
  未生成文档 → 空态引导+［生成开发文档］；已生成 → 版本页签 v1/v2/…（`/api/req/doc` 取 md，
  复用 util.renderMarkdown）+「说人话总结」高亮块 + ［定稿，进入开发期］；docgen 进行中 → 顶部进度条
  （3s 轮询 busy）。
- **横幅**（聊天模式，messages 区上方）：工程芯片×2 + 需求文档芯片（点开抽屉看原文/开发文档）+
  阶段按钮（［完成开发］/［测试通过］，confirmDialog 确认）。
- **右栏**（聊天模式，messages 区右侧固定 300px；≤960px 收成横幅芯片点开浮层）：
  - 开发期：API 文档列表（上传/替换/删除，每次变更 toast「已入队自动修正」）+ 设计准则文本域（失焦保存）。
  - 测试期：贴表格链接输入框 + BUG 卡列表（sure=绿边：修复中/已修复；doubt=橙边：reason + ［确认修复］［忽略］；
    failed：［重试］）。3s 轮询刷新状态。
- **卸载**：切回普通 conv / 其他视图时移除横幅右栏（openConv 钩子里按 conv.meta.reqId 判断挂/卸）。

### 6.3 chat.js 钩子清单（全部改动面）

1. `renderConvList`：过滤 `meta.reqId` conv；
2. `openConv`：conv.meta.reqId 存在 → 通知 req-view 挂横幅/右栏，否则卸载；
3. 导出 `createReqConv(reqId, cwd, session)`（内部复用 newConversation 逻辑，不进列表）。

聊天核心（send/steer/attachStream/paintJob/审批/排队）**零改动**。

## 7. 错误处理与恢复

- docgen 失败/超时：busy 清空 + history 记原因，版本不推进，前端展示错误态+重试按钮。
- 定稿建分支：脏工作区 → `{warn:'dirty', files:[...]}` 前端确认后 force；`checkout -b` 失败 → 整体中止回告。
- 系统任务崩溃恢复：启动清 busy 残留（§5.3），不自动重跑。
- bitable 权限/映射失败：复用 \10001 的错误话术（权限引导/字段映射失败原因），bugs 不写入。
- 换浏览器：conv 丢失 → 用 `devSession` 重建 conv 续接（§6.2）。
- 归档 git 摘要失败：降级占位文本，不阻塞。

## 8. 测试策略

- 纯函数单测（node --test）：requirements store 状态机守卫、summary 抽取、归档摘要拼装、
  bug 判决映射/去重、队列出队条件（依赖注入 runs 查询）。
- 路由集成：临时 APP_DATA_DIR 起 server 走 create→config→docgen(桩)→supplement→finalize(桩 git)→
  apidoc→bitable(桩)→archive 全链路。
- e2e（Playwright，对齐 tests/e2e-panels-smoke.mjs）：侧栏按钮/需求列表/评审期文档模式/横幅右栏挂卸载，
  零 pageerror 断言。
- AI 任务真机验证列入交付走查清单（docgen 产出质量、修正管线、bug 修复流）。

## 9. 实施里程碑（每段独立可验收）

| 段 | 内容 | 验收 |
|---|---|---|
| P1 | store + routes + 侧栏（按钮/列表/徽标）+ 评审期端到端（配置/需求文档/docgen/补充自动修订/版本页签/定稿建分支） | 建需求→出文档→补充修订→定稿建分支全流程真机走通 |
| P2 | 开发期：定稿自动首轮开发 + 需求 conv 寄生 + 横幅/右栏 + API 文档 CRUD 与自动修正 + 设计准则 + 完成开发 | 对话调整/修正管线/串行闸真机走通 |
| P3 | 测试期：bitable → BUG 面板 → sure 自动修 / doubt 确认修 / 忽略 / 重试 + 测试通过 | 真表格全流程 |
| P4 | 归档期 + 档案生成 + 已归档分组 + 窄屏断点/错误态打磨 + e2e | 全链条回归 |

## 10. 非目标（YAGNI，明确不做）

多人协作/权限体系、需求内多会话、bitable 状态回写、需求模板、飞书通知联动、
评审期对话（按需求禁用）、worktree 隔离（用户选了工程内分支）、开发文档在线编辑（只能靠补充说明修订）。

## 11. 风险与边界

- **只读参考工程无物理写保护**：additionalDirectories 不分读写，靠 prompt 约束+归档 diff 复核；实测越界再加档。
- **需求分支占用工作区**：用户选定方案自担——需求进行中该工程的手工开发需自行切分支协调。
- **docgen 长耗时**：15min race 上限；大工程首次生成慢属预期，进度条+可重试兜底。
- **localStorage conv 与后端记录跨端不一致**：devSession 续接兜底（§7）。
- **串行闸单泵在 web 进程**：飞书侧不感知需求队列——需求系统任务与飞书 auto-dev 泵分别串行、互不感知，
  同一工程若同时被两边改码存在理论冲突；实际上飞书 auto-dev 在 <repo>.auto worktree，物理隔离，无冲突。
