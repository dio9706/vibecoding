# src/store · 模块地图

> 持久化层：本项目所有跨进程状态读写的唯一入口。分层纪律见根 `CLAUDE.md`「持久化经 store」与 `docs/ARCHITECTURE.md` §3。

## 这层的骨架（先读这段）

`store` 分三圈，改任何东西前先认清目标属于哪圈：

1. **基座**（`index.js` / `lock.js` / `jsonl.js` / `mask.js`）：不含业务语义，只提供「原子读改写 + 文件锁 + 脱敏」，所有领域 store 都站在它们肩上。
2. **领域 JSON store**：一个业务概念一个 `<name>.json`，全部经 `index.js` 落盘。
3. **两个特例**：`runs.js` 是全模块**唯一的纯内存注册表**（不落盘）；JSONL 日志族（`event-log`/`action-log`/`bot-log`/`user-log`）走追加写而非整份读改写。

一句话判入口：**要落盘 JSON → `index.js`；要写日志 → `jsonl.js`；要存进行中的生成任务 → `runs.js`。**

## 文件清单

（每个源文件旁均有同名 `*.test.js`，下表从略；另有两个无对应源码的测试：`corruption.test.js` 测 `index.js` 的损坏兜底、`runs-held.test.js` 测 `runs.js` 的插话缓冲。）

### 基座（无业务语义，被下面所有文件依赖）
- `index.js` — 存储基座，全项目唯一持久化入口。`readJson`/`writeJson`/`updateJson` + `dataPath`；损坏即抛拒写、tmp+fsync+rename 原子落盘；日后换 sqlite 只改这里。
- `lock.js` — 跨进程文件锁（`<file>.lock` 写归属令牌）。web / feishu / 桌面版共享同一批 JSON，读改写必须在锁内。
- `jsonl.js` — JSONL 存储底座：`readJsonl`/`compactJsonl`/`withinRetention`，日志 store 共用（追加各自实现，只有读与压缩下沉到此）。
- `mask.js` — 落盘前敏感值脱敏纯函数（`maskValue`/`maskDeep`）：字段名 + 值模式双层匹配。

### 运行任务（内存 + 崩溃续跑）
- `runs.js` — 进行中的 Claude 生成任务，纯内存注册表；SSE 订阅、看门狗、审批队列、五个终结口 + settle 事件。
- `active-runs.js` — `runs` 的最小落盘镜像（`active-runs.json`），供进程重启后孤儿续跑；`partitionActiveRuns` 区分孤儿 / 他人所有。
- `pending-resume.js` — 额度用尽 / 孤儿恢复的待续跑队列（`pending-resume.json`），含 `shouldAbandonResume` 续跑熔断。

### 日志族（追加写 JSONL）
- `event-log.js` — 通用事件日志（API 访问 / 错误），3 天窗 + 1000 条上限，最新在前。
- `action-log.js` — 动作执行审计日志，落盘前 `maskDeep` 脱敏，500 条上限。
- `bot-log.js` — 机器人业务日志（前端「访问日志」面板数据源），独立于上两者的理由见文件头注释。
- `user-log.js` — 用户输入原始日志，记忆库的**采集层**：无损落原文、**加锁**、按字节偏移游标读。

### 记忆库数据管线
- `memory-bank.js` — 记忆库偏好条目唯一真相源（`memory-bank.json`），两个游标分别对应两条数据源。
- `transcript.js` — 读 `~/.claude/projects` 会话转录原始事件（终端场景 / 历史回填），保留 tool 块结构。
- `history.js` — 历史会话检索：扫描解析历史 JSONL，面向「给人看的列表」（与 `transcript.js` 的分工见其注释）。
- `read-first-lines.js` — 只读文件开头若干行，拿够即停。

### 设置 / 配置迁移
- `settings.js` — 设置持久化唯一入口（`settings.json`）：飞书凭证 + token 池 + bots + 文案 + UI 偏好；含明文密钥（已 gitignore）。
- `config-transfer.js` — 配置导入导出纯函数（无 I/O）：`buildExport`/`parseImport`，类型 + 版本校验。
- `bots-migration.js` — bots 迁移编排：旧单凭证 → 机器人实体 + 收养孤儿动作，幂等。
- `action-configs.js` — 通用动作配置 CRUD（`action-configs.json`），按 bot 归属。
- `var-contract-migration.js` — 动作变量抽取契约的一次性迁移：给存量 `env`/`phone` 变量补 `preset`。**用条目上的 `_varContractMigrated` 标记位保证只跑一次**，不是每次按变量名重扫（后者会让用户手动删掉的 `preset` 一重启就被加回来）。

### 业务领域 store
- `requirements.js` — 「新需求」全生命周期，含状态机 `PHASE_FLOW` + `canTransition`。
- `tasks.js` — 需求 / 故障任务存储（feedback / dev-task / doc-driven 共用）。
- `conv-notify.js` — 会话飞书通知登记表 + 补充内容收件箱（web 写、飞书读）。
- `conv-messages.js` — 应用自持会话消息（per convId 的 ModelMessage 数组）。
- `feature-index.js` — 功能账本：按功能标签记 git diff 收割的文件频次，开发期优先读。
- `optimize.js` — 项目优化记录（`optimize.json`），含串行闸 `acquireBusy` + LLM 缓存。
- `review-log.js` — 评审判例库（`review-log.jsonl`，追加写）。
- `ui-specs.js` — 按工程目录归属的 UI 规范文本。
- `user-vars.js` — 用户变量 CRUD。
- `saved-dirs.js` — web 端常用工作目录（最多 20）。

## 关键流程

### 流程 A · JSON 状态的跨进程读改写（本模块主干）
几乎所有领域 store 的写操作都收敛到 `index.js` 的 `updateJson(name, fallback, fn)`：

`领域 store（settings/requirements/pending-resume/conv-notify/memory-bank/feature-index…）` → `index.js updateJson` → `lock.js acquireLock`（在 `<file>.lock` 写入归属令牌）→ `parseFileOrThrow`（**只有 ENOENT 退回 fallback；空文件 / JSON 解析失败一律备份 `.corrupt.bak` 并抛错、拒绝写盘**）→ 执行 `fn(cur)`（返回 `undefined` = 放弃写盘）→ 写盘前 `isLockOwned` 复核锁未被抢占 → `writeFileAtomic`（tmp + `fsync` + rename，失败重试 5 次）→ `finally releaseLock`（只删自己的锁）。

读路径更短：`readJson` → `parseFileOrThrow`。**判据**：任何「读出来 normalize 再整份写回」都必须走 `updateJson`；裸 `readJson`→`writeJson` 会让 web / feishu 两进程互相覆盖（token 状态、任务更新丢失）——这正是 `index.js` / `lock.js` 大段注释在防的历史事故。

### 流程 B · JSONL 日志的追加与压缩
日志族不走流程 A（整份读改写会越写越慢）。追加与压缩分离：
- **追加**：各 store 自己 `appendFile(Sync)` 单行（`event-log`/`bot-log` 无锁，单行 <4KB 近似原子；`action-log` 追加前先经 `mask.js maskDeep` 脱敏；`user-log` 是唯一加锁的——用户原文可能超 4KB，交错写会永久损坏这份「无损」证据）。
- **压缩**：每 `COMPACT_EVERY` 次追加、外加模块加载后 `setTimeout(compact, 3000).unref()`，调 `jsonl.js compactJsonl` → `acquireLock`（抢不到即跳过）→ `readJsonl` → 时间窗 / 条数过滤 → tmp+rename。
- **读取**：`jsonl.js readJsonl`（文件序旧→新、坏行跳过），日志面板侧 `reverse()` 取最新在前。

### 流程 C · Run 生命周期与崩溃续跑（内存 ↔ 磁盘配对）
`runs.js` 是内存态，`active-runs.js` 是它的落盘锚点，两者生命周期严格配对：
1. provider 起跑 → `createRun`（内存，启看门狗）+ `active-runs.addActiveRun`（落最小续跑锚点：含 pid / startedAt / 续跑代次）。
2. 运行中 → provider 回调 `runText`/`runActivity`/`runTodos`/`askUser`… 推进内存状态并 `fanout` 广播 SSE；`onInit` 到达后 `active-runs.patchActiveRun` 回填 `session_id`。
3. 终结 → 五个收口之一（`finishRun`/`failRun`/`blockRun`/`retryRun`/`stopRun`，均先判 `status!=='running'` 早退，保证每个 run 只广播一次）→ `emitSettled` 通知上层监听器（store 不 import 业务模块，监听器由上层 `registerRunSettleListener` 注册）；settle 收尾时由上层调 `active-runs.removeActiveRun`。
4. 进程崩溃重启 → `active-runs.json` 残留条目即孤儿，web 入口用 `partitionActiveRuns`（按 pid 存活 + `startedAt >= bootTimeMs`）区分「可回收孤儿 / 他人（桌面版）所有」，孤儿转 `pending-resume.addPending`（reason=`orphan_recovery`），每轮续跑代次 +1，`shouldAbandonResume` 到顶熔断。

看门狗关键取舍（都在 `runs.js` 常量）：静默 15min、硬超时 2h、等待审批「有人看 15min / 无人值守 6h」（`shouldResolveWaiting`）；审批用 `pending` + `pendingQueue` 串行呈现，**严禁覆盖 `run.pending`**（否则被覆盖者的 resolve 永久丢失、CLI 等权限挂死——已实测事故）。

### 流程 D · 记忆库数据管线（双数据源汇入一处）
偏好条目的真相源是 `memory-bank.json`，上游两条互不顶替的数据源各带一个游标：
- **主链路**：起跑 / 插话路径埋点 `user-log.appendUserLog`（无损原文）→ 提炼层按**字节偏移** `readUserLog({offset})` 消费 → 结果写 `memory-bank.writeBank`，游标存 `userLogOffset`。
- **终端 / 回填链路**：`transcript.listTranscriptsSince`（按 **mtime**）+ `readTranscriptEvents` 扫 `~/.claude/projects` 原始事件（用户直接敲 `claude` 时不经后端埋点）→ 汇入同一 bank，游标存 `lastScannedAt`。

两个游标语义不同（字节数 vs 时间戳），`memory-bank.js` 注释明确警告不可复用同一字段，否则一次误读就跳过整段历史。

### 流程 E · 配置导入导出与 bots 迁移
`config-transfer.js` 是纯函数：`buildExport(settings, actionConfigs)` 把两个文件（`settings.json` + `action-configs.json`）包成带 `__type`/`version` 的对象；导入侧 `parseImport` 校验类型 + 版本（v1/v2 兼容），`actionConfigs` 为 `null` 表示「本次不涉及托管配置」，调用方须**跳过**而非用空数组覆盖（否则清空用户现有动作）。导入落盘后由 `bots-migration.migrateToBots` 幂等收尾：旧单凭证迁到 bots 实体（`settings.migrateLegacySettingsToBot`）+ 收养 botId 失配的动作（`action-configs.adoptOrphanConfigs`）。

## 常见改动入口

- **要新增一类持久化状态** → 建 `src/store/<name>.js`，读用 `index.js` 的 `readJson(name, fallback)`，写一律走 `updateJson`（禁裸 `readJson`→`writeJson`）；在 `docs/ARCHITECTURE.md` 的 store 清单登记。
- **要改并发 / 原子性 / 损坏兜底语义** → 只改 `index.js`（`parseFileOrThrow` 的 fallback 条件、`writeFileAtomic` 的 fsync/重试、`updateJson` 的锁复核）。
- **要调文件锁陈旧阈值 / 等待上限 / 抢占策略** → `lock.js`（`LOCK_STALE_MS` / `LOCK_MAX_WAIT_MS` / 令牌归属）。
- **要新增一类追加日志** → 底座复用 `jsonl.js`，把「保留窗 / 条数上限 / 压缩频率」等策略写在新日志文件里（参照 `event-log.js`）。
- **要改脱敏的字段名或值模式规则** → `mask.js`（`SECRET_KEY_RE` 等正则与 `full`/`partial` 策略）。
- **要改 run 状态机 / 看门狗阈值 / 审批队列 / SSE 事件类型** → `runs.js`。
- **要改崩溃续跑的锚点字段或孤儿判定** → `active-runs.js`（`partitionActiveRuns`）；改续跑熔断次数 → `pending-resume.js`（`shouldAbandonResume`）。
- **要改设置结构 / 默认值 / 归一逻辑** → `settings.js`（`DEFAULTS` + `normalizeSettings`，新字段必须在 normalize 里透传，否则整份回写时会被丢掉）。
- **要改需求阶段流转** → `requirements.js`（`PHASE_FLOW` + `canTransition`）。
- **要改飞书通知登记 / 补充收件箱** → `conv-notify.js`。
- **要改记忆库条目结构或扫描游标** → `memory-bank.js`；改用户输入采集埋点 → `user-log.js`；改终端转录扫描 → `transcript.js`。
- **要改配置导入导出的版本兼容** → `config-transfer.js`（`CONFIG_VERSION` / `SUPPORTED_VERSIONS`）；改迁移编排 → `bots-migration.js`。
- **要改功能账本的收割 / 取用** → `feature-index.js`（`harvestFiles` / `getTopFiles`）。
