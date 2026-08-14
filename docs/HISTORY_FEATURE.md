# 历史对话功能使用指南

## 概述

web 执行台支持磁盘持久化的历史对话浏览与续接。所有通过 claude-p-web-demo（底层 Agent SDK = headless Claude Code）发起的会话，都会自动写入本地磁盘的 `.jsonl` 文件，即使关闭网页或重启服务也不会丢失。历史面板直接读取这些文件，无需任何云端服务。

## 功能

- **历史列表**：顶栏「📜 历史」按钮打开右侧抽屉，展示所有磁盘历史会话，按最近更新时间倒序。
- **标题与元信息**：优先取会话的 AI 生成标题（`ai-title`），无则回退到首条用户消息文本；每条显示「日期 时间 · N 条消息」。
- **搜索**：输入关键词按标题 / sessionId 实时过滤（300ms 防抖），Esc 关闭面板。
- **续接对话**：点击「续接」按钮，加载该会话的全部消息到一个新的本地会话并展示；`sessionId` 会作为续接 id，之后继续发送时通过 SDK `resume` 接续原对话上下文。
- **去重**：若本地已存在同一 `sessionId` 的会话，续接时直接打开已有会话，不重复新建。

## 使用流程

1. 点击顶栏「📜 历史」打开历史面板。
2. 浏览或在搜索框输入关键词筛选。
3. 点击目标会话的「续接」按钮。
4. 消息区加载该会话的完整历史，并落入本地会话列表（刷新 / 切换后仍可复现）。
5. 直接在下方输入新消息即可在原上下文上继续对话。

## 技术实现

- **后端读取**：`src/store/history.js`
  - `getHistoryDir()` — 历史目录路径
  - `listHistorySessions(limit=100, offset=0)` — 会话列表（含 `sessionId / title / createdAt / updatedAt / messageCount`，按 `updatedAt` 倒序，支持分页）
  - `getHistorySession(sessionId)` — 单会话完整记录（`messages / events / messageCount`）；含 `sessionId` 正则校验（防路径遍历）与 50MB 文件大小上限
  - `searchHistorySessions(query, limit=100)` — 按标题 / sessionId 过滤
- **后端接口**：`src/entrypoints/web/server.js`
  - `GET /api/history?q=&limit=&offset=` → `{ ok: true, data: [...] }`
  - `GET /api/history/:sessionId` → `{ ok: true, data: {...} }`（找不到 404，出错 500，错误详情仅记本地日志不外泄）
- **前端**：`public/app.js`（面板逻辑 / 搜索 / 续接 / 加载三态 / toast）、`public/index.html`（顶栏按钮 + `#historyPanel` 抽屉）、`public/app.css`（深色主题样式）

## 数据存储位置

- **位置**：`~/.claude/projects/C--Users-DELL-Desktop-claude-p-web-demo/`
- **格式**：JSONL 文件（每行一个 JSON 事件；`type` 区分 `user` / `assistant` / `ai-title` 等）
- **项目目录覆盖**：默认项目 ID 为 `C--Users-DELL-Desktop-claude-p-web-demo`，可用环境变量 `CLAUDE_PROJECT_ID` 覆盖（换项目 / 换机部署时）。

## 隐私与安全

- 所有会话数据仅存储在本地磁盘，不上传任何云端。
- 与 Claude Code CLI 共享同一套本地存储（同为 Agent SDK 写入）。
- 服务仅监听 `127.0.0.1`；接口对非法 `sessionId` 做正则校验，错误响应不回传服务器路径等内部信息。
