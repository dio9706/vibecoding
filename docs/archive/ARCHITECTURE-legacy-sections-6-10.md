# 【归档】旧架构蓝图 · 第 6~10 节残片

> **归档日期**：2026-08-28 · **归档原因**：文档损坏 + 内容过时
>
> 这段内容原先被错误地拼接在 `docs/ARCHITECTURE.md` 末尾（第 550 行起），
> 紧跟在正文「总结」章节之后，形成两份文档首尾相接的断裂：
>
> - 开头的 `intents: string[];` 是一个 `interface Feature { … }` 的**后半截**，
>   前半截（含 `interface` 声明和 `name` / `permission` 字段）在拼接时丢失了；
> - 章节编号从「## 10. 关键约定」倒回「## 6.」，而正文用的是无编号标题；
> - 内容描述的是 2026-07 期的迁移蓝图，其中「在 `features/index.js` 注册」
>   已与代码矛盾 —— 业务功能现已全部走 `src/plugins/` 插件挂载
>   （`src/features/index.js` 明确写「此处不再登记业务 feature」）。
>
> 保留归档而非直接删除：第 8/9 节记录了当初四个规划功能的落位判断与迁移路线，
> 是理解「为什么会长成现在这样」的一手材料。
>
> **当前架构以 `docs/ARCHITECTURE.md` 为准，本文件仅供追溯。**

---

  intents: string[];                       // 关注的意图，如 ['cleanup']
  match?: (ctx) => boolean;                // 可选：自定义命中（如 owner 的兜底全接）
  handle: (ctx, intentResult) => Promise<void>;
}
```

**加新功能的完整步骤**：
1. `features/<name>/index.js` 导出 `Feature`；
2. 在 `features/index.js` 注册；
3. 若需新意图，在 `intent` 的分类提示里加一类（关键词可留空，靠 Claude + 自学习）。

**不改** 入口、router、store、集成。这就是「加功能 = 加模块」。

---

## 6. 任务状态机（规划 3 / 4 的地基）

bug / 需求 / 大开发都是一个 **Task**，落在 `store/tasks`：

```ts
interface Task {
  id: string;
  type: 'bug' | 'feature' | 'big-feature';
  title: string; detail: string;
  source: { via: 'feishu'; openId: string };
  status: 'new' | 'confirmed' | 'analyzing' | 'analyzed'
        | 'developing' | 'done' | 'rejected';
  docs?: { feishuDoc?: string; figma?: string; apiDoc?: string; notes?: string[] };
  analysis?: { suggestion: string; files: string[] };  // Claude 产出
  history: { at: string; event: string }[];
}
```

- **状态迁移**由 feature（`feedback`/`dev-task`/`doc-driven`）驱动，web 管理台展示与操作（确认/补充/触发）。
- **文档驱动（规划4）**：`doc-driven` 监听某 Task 的 `docs` 补充事件 → 判断「可开发部分」→ 调 `integrations/claude` 开发 → 更新 `status`/`history`。文档分批到、会变化，都只是往 `task.docs` 追加 + 触发一次评估。

---

## 7. 目录结构（目标）

```
src/
├── entrypoints/
│   ├── web/        server.js(瘦)、routes/(run/dirs/logs/tasks 各一文件)、public/
│   └── feishu/     长连接入口、ctx 适配（含表情 react 实现）
├── app/
│   ├── dispatch.js router：权限 + 意图 + 分发
│   └── intent.js   关键词+Claude+自学习
├── features/
│   ├── index.js    注册表
│   ├── claude-exec/    (owner 完整 Claude)
│   ├── data-cleanup/   (现有清理，迁入)
│   ├── qrcode/         (规划1)
│   ├── feedback/       (规划2)
│   ├── dev-task/       (规划3)
│   └── doc-driven/     (规划4)
├── integrations/
│   ├── claude.js       (=现 run-claude)
│   ├── lark.js         (发消息/表情/文件，从 feishu.js 抽出)
│   ├── shell.js        (python/CLI 执行，从 data-cleanup 抽出)
│   ├── miniprogram.js  (规划1：小程序 CLI)
│   ├── notify.js       (规划2：系统通知)
│   └── figma.js        (规划4)
├── store/
│   ├── index.js        (json 读写基座，最多 N 条、原子写)
│   └── <domain>.js     (bindings/cleanupLog/feedback/tasks/docs/…)
└── shared/  config.js · logger.js · util.js
```

---

## 8. 四个规划功能的落位（验证架构够用）

| # | 功能 | feature | 依赖的 integrations / store |
|---|------|---------|------------------------------|
| 1 | 二维码 | `qrcode`（intent: qrcode） | `miniprogram`(CLI 生成) + `lark`(发图) |
| 2 | 需求/bug 记录 | `feedback`（intent: bug/feature） | `store/tasks`(存) + `notify`(系统提示) + web 管理台展示 |
| 3 | 确认→分析→开发 | `dev-task` | `store/tasks`(状态机) + `claude`(分析代码/开发) + web(确认/补充) |
| 4 | 文档驱动开发 | `doc-driven` | `store/tasks.docs` + `claude` + `figma`/飞书文档；docs 补充即触发评估 |

四个都只是「新增一个 feature + 复用集成/存储」，印证架构不需为它们改公共层。

---

## 9. 迁移路线（增量，每步可验证，不推倒重来）

> 现功能全程保持可用；每阶段跑 `node --check` + 手测关键路径。

- **阶段 0（准备）**：建 `src/` 骨架 + `store` 基座 + `shared/config`。
- **阶段 1（抽集成）**：`run-claude`→`integrations/claude`；飞书发消息/表情→`integrations/lark`；python spawn→`integrations/shell`。各 JSON 读写→`store/<domain>`。**行为不变**，只是搬家 + 改引用。
- **阶段 2（抽核心）**：`app/intent`(把 data-cleanup 里的意图/自学习提出来) + `app/dispatch`(权限+路由)。`data-cleanup` 改造成 `features/data-cleanup`（符合 Feature 契约）。
- **阶段 3（瘦入口）**：`feishu.js`/`server.js` 只保留协议适配 + 产出 Context + 调 dispatch；owner 逻辑变 `features/claude-exec`。
- **阶段 4（web 管理台）**：web 从「纯聊天」扩展出 tab：对话 / 清理日志 / 需求任务 / 目录设置（为规划 2/3/4 铺路）。
- **阶段 5+**：按你逐个细化，依次落地 `qrcode`→`feedback`→`dev-task`→`doc-driven`。

---
