# 项目地图功能扩展：设计文档

日期：2026-09-02  
状态：设计已批准，待实现计划  
关键决策：方案 B（通用画布内核 + 两套适配层）、累积模块上下文、自动 rescan

---

## 1. 背景与目标

### 痛点

1. **生成项目地图** —— 用户选项目后无法看到页面/模块结构，无法快速定位开发改动点
2. **token 消耗 & 功能漏落** —— 手工描述需求容易遗漏功能块，LLM 单独扫码无法准确汇总
3. **对话中的上下文低效** —— 开发久了对逻辑不熟，每次都要问 LLM "这个模块干什么的"
4. **地图与代码脱节** —— 改完代码后地图仍显示旧信息

### 目标（三层递进）

| # | 目标 | 交付内容 |
|---|---|---|
| ① | 生成项目地图 | 自动扫代码库 → 生成模块/页面关联图，可视化呈现 |
| ② | 点选加入对话 | 模块节点新增「添加到对话」按钮，相关代码自动注入 |
| ③ | 地图驱动开发 | 累积加载多个模块，改完后自动 rescan 地图 |

### 共同原则

- **确定性 + LLM 补语义** —— 导出/导入/依赖由 AST 确定，description 由 LLM 补
- **前后端清晰分工** —— 后端生成数据，前端负责渲染和交互
- **复用现有能力** —— minimap/缩放/布局共享，llm-classify 用于搜索，llm-readonly-agent 用于补语义
- **累积模式** —— 同一对话中多次「添加到对话」模块会累积，不替换

---

## 2. 系统架构

### 2.1 前端架构

```
┌─────────────────────────────────────────────────────────────────┐
│ 两类地图，共用一套画布内核                                       │
│                                                                   │
│  需求地图 (req-map.js)          项目地图 (project-map.js)      │
│  ├─ 页面节点渲染                 ├─ 模块节点渲染                │
│  ├─ 逻辑点 + 标注                ├─ 导出/导入 + 关键流程       │
│  └─ figma 挂稿                   └─ 依赖关系 tag               │
│         │                              │                         │
│         └──────┬──────────────────────┘                          │
│                ▼                                                  │
│        【通用画布内核】map-canvas.js                             │
│        ├─ minimap (req-map-minimap.logic.js)                    │
│        ├─ 滚轮缩放 + fitView                                    │
│        ├─ 连线 (贝塞尔 + 箭头)                                  │
│        ├─ 布局算法 (req-map-layout.logic.js)                    │
│        └─ 节点渲染 callback 机制                                │
│                ▲                                                  │
│                │                                                  │
│        ┌───────┴────────────────────┐                            │
│        │ 对话侧栏：已加载模块栏      │                           │
│        │ • 累积显示 N 个模块        │                           │
│        │ • 点击可移除               │                           │
│        │ • 悬停显示依赖关系         │                           │
│        └────────────────────────────┘                            │
│                                                                   │
└──────────────────┬──────────────────────────────────────────────┘
                   │ HTTP/WebSocket
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│ 后端：需求地图 + 项目地图 两条链路                              │
│                                                                   │
│  需求工作流（现有，不动）                                        │
│  ├─ quizgen → quiz JSON                                          │
│  ├─ docgen → doc markdown                                        │
│  ├─ mapgen → map JSON (pages/edges/points)                      │
│  └─ mapfix / mapchange / mapregen                                │
│                                                                   │
│  项目地图工作流（新增）                                          │
│  ├─ POST /api/project-map/generate                              │
│  │  └─ collectModuleFacts (确定性) + runReadonlyAgent (LLM)     │
│  ├─ GET /api/project-map/get                                    │
│  ├─ GET /api/project-map/search-modules (llm-classify 搜索)    │
│  ├─ POST /api/chat/add-module-context (注入到对话)              │
│  └─ POST /api/project-map/rescan-module (改后自动重扫)          │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 前端模块拆分

| 文件 | 职责 | 改动类型 |
|---|---|---|
| `public/js/map-canvas.js` | 通用画布内核：minimap、缩放、连线、布局、节点渲染 callback | 🆕 新建（从 req-map.js 提炼） |
| `public/js/map-canvas.logic.js` | 布局算法 + minimap 逻辑 | ✅ 复用现有 req-map-layout.logic.js |
| `public/js/req-map.js` | 需求地图适配层：页面/点/标注/figma 渲染 | 🔄 删除冗余，保留语义 |
| `public/js/project-map.js` | 项目地图适配层：模块/导出/依赖 渲染 + 模块详情抽屉 | 🆕 新建 |
| `public/js/project-map-overlay.js` | 项目地图浮层（可选，暂不做） | ⏸️ 预留 |
| `public/js/req-chat.js` | 对话 + 需求地图（现有） | ✅ 不动 |
| `public/js/project-chat.js` | 对话 + 项目地图集成（侧栏模块栏） | 🆕 新建 |

### 2.3 后端模块拆分

| 路径 | 职责 | 类型 |
|---|---|---|
| `src/features/project-map/` | 项目地图核心目录 | 🆕 新建 |
| `├─ gen-map.js` | 项目地图生成入口（调度 collect-facts + LLM） | 🆕 |
| `├─ gen-map.logic.js` | prompt 构造 + LLM 输出解析与校验 | 🆕 |
| `├─ collect-facts.js` | 确定性扫描：AST 解析、导出符号、文件清单 | 🆕 |
| `├─ collect-facts.logic.js` | 导出符号提取（各语言）、文件分析、依赖关系 | 🆕 |
| `└─ persist.js` | 读写 APP_DATA_DIR/project-maps/ | 🆕 |
| `src/entrypoints/web/` | Web 入口 | - |
| `├─ routes-project-map.js` | 路由：生成/查询/加载/rescan | 🆕 |
| `└─ project-map-ops.js` | 编排：调度 LLM + 持久化 + 集成 afterRunHook | 🆕 |

---

## 3. 数据结构与 API 契约

### 3.1 项目地图 JSON 格式

落盘位置：`APP_DATA_DIR/project-maps/<projectId>.json`

```json
{
  "projectId": "abc123",
  "projectPath": "/path/to/project",
  "scanAt": "2026-09-02T10:00:00Z",
  "version": 1,
  
  "modules": [
    {
      "id": "m1",
      "name": "认证系统",
      "path": "src/features/auth",
      "description": "处理用户登录、权限验证、session 管理",
      "files": [
        { 
          "path": "src/features/auth/index.ts", 
          "lines": 150, 
          "exports": ["login", "logout", "verify"]
        },
        { 
          "path": "src/features/auth/service.ts", 
          "lines": 200, 
          "exports": ["AuthService"]
        }
      ],
      "imports": ["lodash", "jsonwebtoken"],
      "dependsOn": ["db"],
      "usedBy": ["user", "admin"],
      "keyFunctions": ["login()", "logout()", "verify()"],
      "lastModified": "2026-08-25T14:30:00Z"
    }
  ],
  
  "edges": [
    { 
      "from": "m1", 
      "to": "m2", 
      "label": "m2 depends on m1" 
    }
  ],
  
  "externalDeps": ["db", "cache", "logger"],
  "summary": "19 modules, 2847 source files, avg 150 lines/module"
}
```

### 3.2 前端消费的简化版本

对话加载时使用（减少传输量）：

```json
{
  "projectId": "abc123",
  "modules": [
    {
      "id": "m1",
      "name": "认证系统",
      "path": "src/features/auth",
      "description": "处理用户登录、权限验证、session 管理",
      "dependsOn": ["db"],
      "usedBy": ["user", "admin"]
    }
  ],
  "edges": [
    { "from": "m1", "to": "m2", "label": "m2 depends on m1" }
  ]
}
```

### 3.3 新增 API 端点

```
POST /api/project-map/generate
  请求：{ projectId, projectPath }
  响应：{ id, status: 'queued' | 'busy', version }
  说明：入队生成任务，返回进度 id

GET /api/project-map/get
  请求：?projectId=...&v=latest
  响应：完整 project-map JSON
  说明：获取项目地图

GET /api/project-map/search-modules
  请求：?projectId=...&query=支付功能
  响应：[{id, name, path, score, reason}]
  说明：语义搜索相关模块（llm-classify 单轮）

POST /api/chat/add-module-context
  请求：{ convId, moduleIds: ['m1', 'm2'] }
  响应：{ success, contextSize, modules: [...] }
  说明：将模块代码注入到对话的 messages

POST /api/project-map/rescan-module
  请求：{ projectId, moduleId }
  响应：{ id, status: 'queued' }
  说明：单个模块重新扫描并更新
```

### 3.4 对话中的模块注入格式

改完代码后，系统往对话 messages 里追加一条系统消息：

```
【系统提示】已加载模块上下文：

📦 auth/ (src/features/auth)
  ├─ index.ts (150 行) → 导出：login, logout, verify
  ├─ service.ts (200 行) → 导出：AuthService
  ├─ 依赖：db/
  └─ 被依赖：user/, admin/

📦 user/ (src/features/user)
  ├─ index.ts (120 行) → 导出：getProfile, updateProfile
  ├─ model.ts (80 行) → 导出：UserModel
  ├─ 依赖：auth/, db/
  └─ 被依赖：无

【预加载的代码片段】

--- src/features/auth/index.ts ---
export function login(username: string, password: string) {
  // ... 完整代码 ...
}

export function logout() {
  // ... 完整代码 ...
}

--- src/features/auth/service.ts ---
export class AuthService {
  // ... 完整代码 ...
}

--- src/features/user/index.ts ---
// ... (后续代码) ...
```

---

## 4. 关键实现细节

### 4.1 画布内核拆分（边界划定）

**通用内核 `map-canvas.js` 对外接口：**

```js
const canvas = createMapCanvas(container, {
  nodes,           // [{id, x, y, width, height}]
  edges,           // [{from, to, label}]
  renderNode,      // (node, el) => void  ← 适配层提供
  onNodeClick,     // (nodeId) => void
  onNodeHover,     // (nodeId, isHover) => void
})

canvas.setNodes(nodes)         // 更新节点
canvas.highlightNodes(ids)     // 高亮节点
canvas.fitView()               // 适应视窗
canvas.zoom(factor)            // 缩放
canvas.pan(dx, dy)             // 平移
canvas.destroy()               // 销毁
```

**需求地图适配层 `req-map.js`（精简后）：**

```js
- renderNodes()     // 页面/点/标注/figma 渲染（原有逻辑保留）
- renderDrawer()    // 抽屉详情
- onNodeClick()     // 触发抽屉
- onAnnotSubmit()   // 标注交互
```

**项目地图适配层 `project-map.js`（新建）：**

```js
- renderNodes()        // 模块/依赖/tag 渲染
- renderModuleDetail() // 右侧抽屉：文件清单、导出、依赖
- renderAddButton()    // 「添加到对话」按钮
- onModuleClick()      // 展示抽屉
- onAddToChat()        // 调用 POST /api/chat/add-module-context
```

### 4.2 模块识别规则（任意代码库通用）

**三层优先级识别：**

```
优先级 1：显式配置
  项目根目录 .project-map.json
  { "modules": [{ "name": "认证", "path": "src/features/auth" }] }

优先级 2：目录约定（自动检测）
  src/features/*     → 每个子目录 = 一个模块
  src/pages/*        → 同上
  packages/*         → monorepo 场景
  src/modules/*      → 通用模块目录

优先级 3：兜底（import 聚类）
  按强 import 关系自动聚类，关联文件作为一个模块
```

**LLM 的职责（有限）：**

```
确定性扫描（100% 准确）→ 产出：
  { id, path, files[], exports[], imports[], dependsOn[], usedBy[] }

LLM 补语义（单次 classify，不给工具）→ 补充：
  { description, keyFunctions, summary }

失败降级：LLM 补语义失败时，用文件清单和导出列表兜底，
模块结构仍完整，地图可用。
```

### 4.3 地图顶部语义搜索

**实现方式：llm-classify 单轮**

```
输入给 LLM：
  用户查询：「修改支付逻辑」
  
  当前项目模块列表（压缩，最多 50 条）：
  - m1: 认证系统 (auth/) → 用户登录、权限验证
  - m2: 支付系统 (payment/) → 订单、退款、微信支付
  - m3: 用户管理 (user/) → 资料、统计
  ...

  返回格式 JSON：
  {
    "matches": [
      { "id": "m2", "reason": "直接匹配支付业务", "score": 0.95 },
      { "id": "m1", "reason": "支付需要权限验证", "score": 0.6 }
    ]
  }

前端交互（地图顶部输入框）：
  用户输入 → 防抖 500ms → GET /api/project-map/search-modules?query=...
  → 返回 [{id, score, reason}]
  → 命中节点高亮蓝色，其余降透明度，按 score 排序
  → 用户点高亮节点 → 查看详情 → 点「添加到对话」
```

### 4.4 自动 Rescan 触发机制

**时机和策略：**

```
触发点：对话任务完成后（run 状态变 done）

流程：
1. finishRun() 执行完毕
   → 调用 afterRunHook('on-run-finished', {runId, convId, files})
   
2. detectChangedModules(projectId, prevRunFiles)
   → 对比 project-map.json 中各模块文件的 mtime
   → 返回 [changed moduleIds]
   
3. 对每个 changed module 调用：
   POST /api/project-map/rescan-module {projectId, moduleId}
   → 后端：只重扫 module.path 下的文件
   → collect-facts + llm-classify 补语义
   → 局部更新 project-map.json（替换对应 module 条目）
   → 响应 200 + 新的 module 数据
   
4. 前端收到 SSE：
   { type: 'map-updated', changedModules: ['m2', 'm3'] }
   
5. 地图画布：
   → 变化节点闪一下（animation）
   → 刷新节点内容（description 等字段）
   → 侧栏「已加载模块」里更新对应模块信息
```

**重扫成本：** 单个模块 ≈ $0.01（只扫一个目录，LLM 只补 description）

---

## 5. 工作流与用户交互

### 5.1 完整用户工作流

#### 第一次使用

```
1. 用户打开「项目地图」标签页
2. 系统检测是否有 project-map.json
   ├─ 有 → 直接加载，显示地图
   └─ 无 → 显示「生成地图」按钮 + 说明

3. 用户点「生成地图」
   → POST /api/project-map/generate {projectId, projectPath}
   → 前端：进度条「扫描中...」（30-60s）
   → 后端：collectModuleFacts + runReadonlyAgent
   → 落盘 project-maps/<id>.json
   → 前端自动刷新，地图呈现
```

#### 常规使用

```
1. 用户在地图顶部输入框输入「修改支付」
   → 防抖 500ms
   → GET /api/project-map/search-modules?query=修改支付
   → llm-classify 返回 [{id, score}]
   → 前端：匹配节点高亮蓝色，其余淡灰

2. 用户点「支付系统」节点
   → 右侧弹出「模块详情抽屉」
   → 展示：文件清单、导出函数、依赖、最后修改时间
   → 底部有「添加到对话」按钮

3. 用户点「添加到对话」
   → POST /api/chat/add-module-context {convId, moduleIds: ['m2']}
   → 后端：读 project-map.json，提取模块代码和依赖，注入 messages
   → 前端：侧栏「已加载模块」栏新增 payment/，显示依赖

4. 用户在对话消息框输入：
   「支付系统加个退款功能，调用支付宝 API」
   → 发送对话
   → LLM 看到 payment/ 代码 + 依赖，直接改

5. 改完后，用户点「接受改动」
   → 后端 finishRun()
   → afterRunHook 触发
   → detectChangedModules() 发现 payment/ 文件变了
   → POST /api/project-map/rescan-module {projectId, moduleId: 'm2'}
   → 重新扫 payment/，补新的 description
   → 前端 SSE: {type: 'map-updated', changedModules: ['m2']}
   → 地图中 payment/ 节点闪一下，刷新内容

6. 用户继续在同一对话中点「数据库」模块的「添加到对话」
   → POST /api/chat/add-module-context {convId, moduleIds: ['db']}
   → 侧栏「已加载模块」变成 [payment/, db/]，累积显示

7. 继续对话...
```

### 5.2 错误处理与降级

| 场景 | 处理 |
|---|---|
| 生成地图超时（>5min） | 用户可点「中止」；已扫的模块保留，标记为 partial |
| LLM 补语义失败 | 跳过 description/keyFunctions，用文件清单兜底 |
| 语义搜索无结果 | 返回空列表，提示「尝试关键词：...」 |
| rescan 单个模块失败 | 保留旧数据不覆盖，日志记录，下次自动重试 |
| 对话注入代码过大（>200KB） | 截断到前 N 个关键文件，其余用「还有 M 个文件」占位 |
| 多用户同时编辑同一模块 | 文件锁保护 rescan，先到先得 |

### 5.3 权限与隔离

```
【权限】
- 生成地图：需要有项目读权限（扫代码库）
- 对话注入模块：无需额外权限（读已生成的地图）
- 改代码后 rescan：需要读新文件权限

【隔离】
- 每个项目的地图独立落盘：APP_DATA_DIR/project-maps/<projectId>.json
- 多用户打开同一项目：共享同一张地图（读）
- rescan 改地图：用文件锁保护（原子操作）

【信息安全】
- 项目地图包含完整代码清单 → 只给 owner 看
- 前端不暴露地图数据到浏览器控制台
- 搜索查询历史不记录
```

---

## 6. 测试计划（后续补充）

### 单元测试

- `collect-facts.logic.js`：导出符号提取（各语言 parse）
- `gen-map.logic.js`：prompt 构造和 LLM 输出解析
- `map-canvas.logic.js`：节点高亮、搜索排序算法

### 集成测试

- 小项目（5 模块）→ 地图生成 → JSON 结构校验
- 大项目（100+ 模块）→ 性能验证（<2min）
- 完整链路：生成 → 搜索 → 加载 → 改代码 → rescan

### UI 测试

- 地图画布：缩放、minimap、高亮
- 搜索框：输入→高亮、清空→恢复
- 侧栏模块栏：加减、依赖展示、右键删除

---

## 7. 实施阶段规划

**Phase 1：模块地图生成 + 基础画布**
- 实现 collect-facts（确定性扫描）
- 实现 gen-map（LLM 补语义）
- 创建通用画布内核 map-canvas.js
- 新建 project-map.js 适配层
- 新建路由：/api/project-map/generate、/get

**Phase 2：对话集成**
- 新建 project-chat.js（侧栏模块栏）
- 实现 POST /api/chat/add-module-context
- 模块代码注入格式定型

**Phase 3：语义搜索 + 交互**
- 实现 GET /api/project-map/search-modules（llm-classify）
- 地图顶部输入框、高亮交互
- 模块详情抽屉

**Phase 4：自动 rescan**
- 实现 afterRunHook 集成
- 实现 detectChangedModules
- 实现 POST /api/project-map/rescan-module

**Phase 5：测试 + 打磨**
- 单元 + 集成测试
- UI 交互打磨
- 错误处理和降级

---

## 8. 关键风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| LLM 补语义失败率高 | 地图信息不完整 | 有完整降级（文件清单兜底），不阻塞渲染 |
| 大项目扫描超时 | 无法生成地图 | 分阶段扫（模块 concurrency=3），支持中止 |
| 对话注入代码太大爆 token | 对话上下文溢出 | 截断策略（前 N 文件 + 占位） |
| rescan 与改代码竞态 | 地图数据不一致 | 文件锁保护 |
| 需求地图 vs 项目地图耦合 | 改动成本高 | 方案 B 彻底解耦（通用画布内核） |

---

## 9. 核心决策记录

| 决策点 | 选择 | Why |
|---|---|---|
| 画布复用方案 | 方案 B（通用内核 + 两套适配层） | 复用最大化，维护成本最低 |
| 模块上下文模式 | 累积（不替换） | 逻辑上关联的模块会被一起用到 |
| 模块重扫时机 | 改完代码后自动 rescan | 保证地图与代码同步，用户体验好 |
| 模块识别方式 | 确定性（AST）+ LLM 补语义 | 结构准确，语义美观 |
| 搜索实现 | llm-classify 单轮 | token 效率高，响应快 |
| 地图存储 | APP_DATA_DIR（不入代码仓库） | 避免污染项目仓库 |

---

## 10. 附录

### 10.1 术语表

| 术语 | 定义 |
|---|---|
| 项目地图 | 代码库的模块结构图（nodes=模块，edges=依赖） |
| 模块 | 代码的逻辑单元，通常是一个目录（src/features/auth） |
| 事实包 | 确定性扫描产出的导出/导入/依赖等硬数据 |
| 语义补充 | LLM 对模块的描述和关键函数，基于代码理解 |
| Rescan | 改代码后重新扫描并更新地图 |
| 累积模式 | 多次「添加到对话」模块会都保留在上下文 |

### 10.2 相关文档链接

- [[requirement-workflow-impl]] —— 需求工作流背景
- [[web-console-enhancements]] —— 对话侧栏扩展
- `docs/ARCHITECTURE.md` —— 项目整体架构

