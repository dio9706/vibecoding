# 访问日志 3 天保留 + 手动清空

- 日期：2026-07-22
- 状态：已与用户口头确认设计，待写实现计划

## 1. 背景与目标

"访问日志"视图背后是通用 event-log（`src/store/event-log.js`），存 access / dialog / 任务操作等混合事件。当前**仅按条数保留**（`MAX=1000`，`compact()` 在模块加载 + 每 2000 次追加时裁剪），无时间维度。

目标：
1. 访问日志**仅保留最近 3 天**（超期自动丢弃）。
2. 前端新增**"清空日志"按钮**，主动一键清空全部访问日志。

作用范围：整个 event-log（该视图展示的全部事件），非仅 `type:'access'`。

## 2. 保留策略（`src/store/event-log.js`）

- 新增常量 `RETAIN_MS = 3 * 24 * 60 * 60 * 1000`（3 天，硬编码，不做配置 UI）。
- **双重上限，时间为主**（方案 A：读时过滤 + compact 落盘瘦身）：
  - `getEvents()`：合并当前 JSONL 与遗留 `event-log.json` 后，按 `time` 过滤 >3 天条目，再保留最新 `MAX=1000` 作安全上限。读时即正确，即使 compact 尚未运行。
  - `compact()`：在现有"超 MAX 裁剪"基础上，增加"丢弃 >3 天条目"。触发点不变（模块加载 + 每 2000 次追加）。
  - `time` 缺失或不可解析的条目 → **保留**（避免因坏时间戳误删；`appendEvent` 恒写入 ISO `time`）。
- 遗留 `event-log.json` 条目同样走时间过滤，旧数据自然被滤除。
- 弃用方案：仅读时过滤（文件无限增长）；定时器清理（YAGNI，增加移动部件）。

## 3. 清空能力

### 3.1 store（`src/store/event-log.js`）
- 新增导出 `clearEvents()`：
  - 将 `event-log.jsonl` 截空（写入空内容）。
  - 若存在遗留 `event-log.json`，一并删除，保证"清空"彻底。
  - 失败抛出（由调用方转 500）。

### 3.2 接口（`src/entrypoints/web/server.js`）
- 新增路由 `POST /api/logs/clear` → `handleLogsClear(req, res)`：非 POST 返回 405；调用 `clearEvents()`；成功返回 `{ ok: true }`，异常返回 500 `{ ok: false }`。
- 从 `event-log.js` 导入 `clearEvents`。
- 将 `/api/logs/clear` 加入 `ACCESS_LOG_SKIP`，避免清空操作自身又写入一条访问日志、导致清空后列表非空。

## 4. 前端（`public/app.js` 访问日志视图）

- 在日志视图头部新增"清空日志"按钮，样式沿用现有视图控件约定。
- 点击流程：`confirm('确定清空全部访问日志？此操作不可恢复')` → 确认则 `POST /api/logs/clear` → 成功后调用现有 `loadLogs()` 刷新（列表变空）；失败弹出错误提示。

## 5. 错误处理

- `clearEvents()` 写/删失败 → 抛错 → 接口 500 → 前端提示失败，不影响主流程。
- 保留过滤对坏 `time` 采取"保留"策略，不误删。
- 并发：应用为单一 web 进程（Tauri sidecar），event-log 沿用"追加近原子、可容忍极端丢一行"的既有哲学；`clearEvents` 为单次写空，接受该模型。

## 6. 测试（`src/store/event-log.test.js`，新建）

用临时 `APP_DATA_DIR`（`t.after` 清理）：
1. **保留过滤**：写入含"4 天前"与"刚刚"两类 `time` 的 JSONL → `getEvents()` 只返回新条目。
2. **清空**：`clearEvents()` 后 `getEvents()` 返回空数组。

## 7. 改动文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/store/event-log.js` | 修改 | 3 天保留过滤 + `clearEvents()` |
| `src/store/event-log.test.js` | 新建 | 保留与清空的单元测试 |
| `src/entrypoints/web/server.js` | 修改 | `POST /api/logs/clear` 路由 + handler + skip |
| `public/app.js` | 修改 | 清空按钮 + 交互 |

## 8. 非目标（超范围）

- 不做保留天数的配置化 UI（固定 3 天）。
- 不改动其它日志（action-log、backend.log 等）。
- 不引入定时任务框架。
