# 飞书会话化收集 + 分层分类 + 文档提取 + 常驻 auto 工作区 设计

## 一、背景与根因

线上暴露三个问题，根因归结为四条：

| 问题 | 根因 |
|---|---|
| 1. 先发文件再发需求描述，无法归并为一个任务 | **根因 A：消息级处理模型**——一条消息即一个独立请求，无会话概念；单发图片只支持「先文字后图」方向，文件消息直接拒收 |
| 3. 联调文档被误判为故障 | **根因 A**（贴文档的消息被迫立案）+ **根因 B：关键词快路先测 bug 正则且全文子串匹配**——长文档必含「错误/异常」等词，抢先命中，LLM 消歧根本没走到；且分类缺少「补充材料」类别 |
| 3'. 坚持修改后报「工作区状态异常」 | **根因 C：共享工作区 + 分支切换的执行模型**——auto-dev 在目标工程主工作区切分支，上个任务异常中断残留 `auto/` 分支，基线守卫只拦截不自愈 |
| 2. 不支持识别飞书文档 | **根因 D：缺提取通道**——`toInbound` 只认 image/text/post；云文档需 docx OpenAPI + 权限，本地文件需下载 + 解析 |

已确认决策：四块一起设计、分阶段实施；归并机制用**材料暂存池**（不做 debounce 聚合窗口）；分类用**分层修正**（收紧关键词快路 + Haiku 结构化分类，新增 material 类别）；文档**云链接与本地文件两条通道都做**；工作区隔离用**常驻 auto worktree**（不做每任务 worktree）。

## 二、材料暂存池（问题 1 核心）

新模块 `src/plugins/team-tools/material-pool.js`：

### 数据结构
- 内存 `Map`，key = `openId:chatId`，value = `[{ kind: 'image'|'file'|'doc'|'text', path?, content?, title?, at }]`
- TTL **10 分钟**，懒清理（与 channels/feishu.js 的 `seen` 去重 Map 同款模式）；单 key 上限 **10 条**防爆
- **不落盘**：10 分钟级临时态，与 task-triage sessions、feedback challenged 窗口同一哲学；进程重启丢失的代价只是用户重发一次（KISS/YAGNI）

### 入池（统一归属顺序：先挂近期任务 → 挂不上入池）
1. 单发图片：先走现有 `attachImageToRecentTask`（10 分钟窗口）；找不到 → 入池，回复「📎 收到材料，请描述对应的需求或问题～」（替代现在的"请随文字一起发"）
2. 文件消息 / 云文档：同上顺序（`attachImageToRecentTask` 泛化为 `attachMaterialToRecentTask`，支持文件路径与文档文本）
3. 被 Haiku 分类为 `material` 的长文本：同上

### 出池
feedback 插件 `handle` 立案时 `drainMaterials(openId, chatId)`，材料以 `[附件] <路径>` / `[参考文档] <标题>\n<内容或路径>` 追加进 `task.detail`——analyze/develop 的 prompt 天然带上，Claude 可直接 Read。

## 三、分层分类（问题 3 核心，改 `src/app/intent.js`）

```
classify(text, { hasMaterials })     // 第二参数可选，默认无材料；老调用方不受影响
  ├─ 1. 寒暄快路（不变）
  ├─ 2. 关键词快路收紧：仅当 文本 ≤120 字 且 bug/feature 恰好单类命中 且 无池内材料
  │       └─ 命中 → 直接返回（省额度路径，覆盖日常大多数短消息）
  ├─ 3. 其余（长文本 / 双类命中 / 带材料）→ Haiku 结构化分类
  │       输入：首 500 字 +「该用户有待归属材料」提示
  │       输出：{"type":"bug"|"feature"|"material"|"other"}
  │       material → 不立案，文本入材料池，回复「收到材料」
  ├─ 4. Haiku 超时/失败兜底：降级现有关键词全文匹配（宁可误判不丢消息）
  └─ 5. action 分类 → other（不变）
```

- 分类超时/abort+race 双保险沿用 intent.js 现有模式（CLASSIFY_TIMEOUT_MS）。
- `dispatch` 从 ctx 取 openId/chatId 查池后传 `hasMaterials`。
- 抽纯函数 `shouldUseKeywordFastPath(text, hasMaterials)` 供单测。
- **职责边界**：intent.js 只产出 `{ intent:'material' }` 不做副作用；入池/挂任务/回复由 feedback 插件接管（`intents: ['bug','feature','material']`），归属顺序与第二节一致。

### 误判案例修复路径（验收标准）
「后端接口文档 # V5.5.2 前端联调文档…」（长文）→ 跳过快路 → Haiku 判 `material` → 入池；
「按这个文档联调宝宝辅食页面」→ 带材料 → Haiku 判 `feature` → 立案并吸附文档。

## 四、飞书文档提取（问题 2，改 `channels/feishu.js` + `integrations/lark.js`）

### 通道 A：本地文件上传（message_type: 'file'）
- `toInbound` 新增 file 分支：解析 file_key + 文件名 → 复用 `downloadMessageResource(messageId, key, 'file')` → `{ kind:'file', files:[{path,name}] }`
- 按扩展名归一化：
  - `md/txt/json/pdf` → 直接附本地路径（Claude Read 原生支持，含 PDF）
  - `docx` → **mammoth**（唯一新增依赖，纯 JS）转 `.md` 存同目录附转换后路径；失败附原路径并标注「(未能解析，docx 原件)」
  - 其他（xlsx/zip 等）→ 暂不解析，回复「暂不支持解析该类型，请转成文档或粘贴关键内容」

### 通道 B：云文档链接/卡片
- 识别：文本/富文本中 `https://<tenant>.feishu.cn/(docx|wiki)/<token>` 正则提取（`extractDocLinks(text)` 纯函数）；分享卡片消息取 URL 后同路
- `integrations/lark.js` 新增：
  - `resolveWikiNode(token)`：wiki 链接换 obj_token（GET /wiki/v2/spaces/get_node）
  - `fetchDocRawContent(docToken)`：GET /docx/v1/documents/:id/raw_content 拉纯文本
- 内容存 `<数据目录>/materials/<token>.md`（带标题头），按材料入池/挂任务
- **前置条件（人工操作）**：开放平台加 `docx:document:readonly` + `wiki:wiki:readonly` 权限并发版；文档对机器人可见（加协作者或组织内可读）

### 权限失败降级（不静默）
403/404 → 回复：「📄 检测到飞书文档链接，但机器人没有阅读权限。请在文档右上角分享给机器人，或把内容粘贴/导出为文件发我～」

### 复用归属逻辑
提取通道只负责"变成文本"，归属（挂任务/入池）零重复（DRY）。

## 五、常驻 auto 工作区（根因 C，改 `auto-dev/`）

### 布局
`git worktree add <projectDir>.auto --detach` —— 与目标工程平级兄弟目录，共享 .git 对象库，分支互通。

### runOne 执行流
```
1. ensureAutoWorktree(repo) → autoDir      不存在则创建；损坏则 worktree prune 后重建
2. baseBranch = currentBranch(主工作区)     语义不变：主工作区停在哪，任务基于哪
3. 自愈：autoDir status 非空 → add -A + commit 到当前分支留痕（不丢残骸）
4. git -C autoDir checkout -B auto/<taskId> <baseBranch>
   （-B 从 baseBranch 的 commit 建分支，不检出 baseBranch 本身——
    绕开 git「同一分支不能双 worktree 检出」限制）
5. develop(task, { cwd: autoDir }) → commitAll(autoDir) → compileDevQrcode({repo: autoDir, branch})
6. 结束不切回——下个任务 checkout -B 直接覆盖；步骤 4 幂等，崩溃重启干净重跑
```

### 删除项（本方案核心收益）
- 基线守卫 `baseBranch.startsWith('auto/')` 整段删除——「目标工程工作区状态异常」从此不存在
- `recoverOnBoot` 的"尽力切回基线"删除（任务退回 analyzed 保留）

### 不变项
- 轻度托管（triage 后台队列）仍在主工作区直接改码（语义即"当场 git diff 审查"）
- `mergeBranch` 仍在主工作区执行（分支互通；merge 只 checkout target，无 worktree 冲突；isClean 前置检查保留）
- `develop(task)` 增加可选 `{ cwd }` 覆盖参数，向后兼容

### 依赖安装
bot 配置新增可选 `setupScript`（如 `npm install`），worktree 首次创建后执行一次，失败告警不阻塞；未配置且检测到 package.json 存在而 node_modules 缺失 → 飞书通知 owner 手动处理。

## 六、错误处理汇总

| 故障点 | 策略 |
|---|---|
| worktree 创建失败 | 任务退回 analyzed + 通知 owner 具体错误；**不降级回主工作区**（隐性降级会静默回到互相干扰的旧模型） |
| Haiku 分类超时/失败 | 降级现有关键词全文匹配（宁可误判不丢消息） |
| 云文档 403/404 | 引导话术，材料不无声丢失 |
| docx 解析失败 | 附原文件路径 + 标注，任务照常立案 |
| 进程重启丢材料池 | 接受（10 分钟级临时态），用户重发 |

## 七、测试策略（沿用 logic.js + logic.test.js 风格）

- **材料池**：入池/出池/TTL 过期/单 key 上限（纯内存直接测）
- **分类收紧**：`shouldUseKeywordFastPath(text, hasMaterials)` 测 120 字边界、双类命中、带材料三种旁路
- **链接提取**：`extractDocLinks(text)` 测 docx/wiki/带查询参数 URL
- **worktree**：参数拼装 + 自愈决策抽纯函数（checkoutArgs 同款）；git.test.js 补用例
- **docx 转换**：mammoth 薄封装 + fixture 测
- **人工走查清单**：① 先发文档再发需求 ② 粘贴长文档（原误判案例）③ challenged 后坚持修改全链路 ④ 残留自愈（手动在 autoDir 制造脏状态后跑任务）

## 八、实施阶段划分

1. **阶段一（止血）**：分层分类（三）+ 材料暂存池（二）——直接消灭误判与归并问题
2. **阶段二**：常驻 auto 工作区（五）——消灭工作区状态异常
3. **阶段三**：文档提取两通道（四）——依赖开放平台权限申请（人工前置）

各阶段独立可交付，互不阻塞。
