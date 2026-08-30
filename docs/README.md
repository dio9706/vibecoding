# 文档导航

> Principal 的完整文档体系。根据你的需求选择对应文档。

---

## 🚀 快速开始（5 分钟）

**第一次接触这个项目？**

1. **阅读主 README**：[../../README.md](../README.md)
   - 项目概览
   - 7 大特性对照表
   - 快速启动命令
   - 生产守护配置（PM2）

2. **如果要让 Claude 自动部署**：
   - 把 [DEPLOYMENT_GUIDE.md](#deployment_guide) 里的「7 步部署指令」复制给 Claude
   - Claude 会自动处理安装、配置、验证

3. **如果要手动配置**：
   - 继续看本页面的"深度学习"部分

---

## 📚 文档速查表

| 文档 | 适合场景 | 关键内容 |
|------|---------|---------|
| [README.md](../README.md) | 新用户、快速了解 | 7 大特性、快速启动、配置表 |
| [ARCHITECTURE.md](#architecture) | 开发者、深度理解 | 架构图、数据流、设计模式、故障排查 |
| [DEPLOYMENT_GUIDE.md](#deployment_guide) | Claude 自动部署、运维 | 7 步自动化、常见操作、故障排查链接 |
| [CONFIGURATION.md](#configuration) | 初次配置、敏感文件 | 环境变量、凭证来源、安全自查 |
| [HISTORY_FEATURE.md](#history) | 历史检索 | 如何查看和恢复历史会话 |
| [action-config*.md](#action_config) | 自定义脚本 | 如何添加触发词动作、脚本配置格式 |
| [RETRY_LOGIC.md](RETRY_LOGIC.md) | 排查任务随机失败 | `Response stalled mid-stream` 的指数退避重试机制 |
| [archive/](archive/README.md) | 追溯历史决策 | 已完成阶段的报告与蓝图，**不代表当前状态** |

---

## 🎯 按需求选文档

### 「我想快速跑起来」
→ [README.md](../README.md) 的「快速开始」 + [DEPLOYMENT_GUIDE.md](#deployment_guide) 的「7 步部署」

### 「我想理解这个项目的架构」
→ [ARCHITECTURE.md](#architecture)
- 全景架构图
- 7 大特性的实现细节
- 模块依赖与数据流
- 设计模式
- 故障排查速查表

### 「我想配置多个 Claude 账号（特性④）」
→ [README.md](../README.md) 的「特性④ 多 Claude 订阅账户」
或 Web 设置页 ⚙ → Claude 账号 tab

### 「我想接入飞书（特性③）」
→ [README.md](../README.md) 的「特性③ 接入飞书」
+ [CONFIGURATION.md](#configuration) 的「环境变量」

### 「我想添加自定义脚本（特性⑤）」
→ [README.md](../README.md) 的「特性⑤ 自定义脚本」
+ [action-config.md](#action_config)

### 「我想用历史检索（特性②）」
→ [README.md](../README.md) 的「特性② 快速查询历史对话」
+ [HISTORY_FEATURE.md](#history)

### 「部署后遇到问题」
→ [ARCHITECTURE.md](#architecture) 的「故障排查速查表」
或 [DEPLOYMENT_GUIDE.md](#deployment_guide) 的「故障排查快速链接」

### 「我要把这个项目交给团队 / 文档让 Claude 自动部署」
→ 提供给 Claude：
  - 项目仓库
  - [README.md](../README.md) 和 [DEPLOYMENT_GUIDE.md](#deployment_guide)
  - 飞书凭证（如需飞书）
  - Anthropic token（可选但推荐多账号轮换）

---

## 📖 各文档详细说明

### README.md {#readme}
**入口文档，所有人的第一选择。**

**包含**：
- 概览（目的、后端架构）
- ✨ 相比原生 Claude Code 的增强（7 大特性对照表）
- 🚀 快速开始（依赖、命令、PM2 守护）
- 🔧 七大特性的配置方法
  - 原理、配置步骤、相关 env、接口
- ⚙️ 配置速查表（所有 env、敏感文件）
- 🏗️ 简化架构图
- ⚠️ 用量提示（订阅 vs API）
- 🤖 「把本文档交给 Claude 自动部署」指令

**什么时候读**：
- ✓ 第一次了解项目
- ✓ 想知道「关窗续跑」怎么做的
- ✓ 想配置多账号轮换
- ✓ 想接飞书

---

### ARCHITECTURE.md {#architecture}
**开发者 / 深度学习必读。融合 7 大特性的完整技术文档。**

**包含**：
- 全景架构图（清晰的模块分层）
- 7 大特性的**完整实现方案**
  - 每个特性的「原理 → 流程 → 关键代码」
  - 特性之间的协作关系
- 模块依赖图
- 设计模式（状态持久化、流式多路复用、权限序列化、自动选号）
- 关键算法（`pickActive()` 如何自动选号）
- 日志体系（应用日志、事件日志、活动日志）
- **故障排查速查表**（现象 → 根因 → 修复）

**什么时候读**：
- ✓ 想理解「为什么这样设计」
- ✓ 遇到 bug，想根据日志定位
- ✓ 想扩展新功能
- ✓ 想改动架构

---

### DEPLOYMENT_GUIDE.md {#deployment_guide}
**面向 Claude 的自动化部署指南 + 运维手册。**

**包含**：
- 部署流程概览
- 环境准备检查清单（Node、Claude CLI、PM2）
- **7 步自动化部署指令**（可直接复制给 Claude）
  - 第 1-7 步详细说明
  - 每步的期望输出
  - 中途报错的处理建议
- 部署后的常见操作
  - 启动 / 停止 / 重启
  - 看日志
  - 设置页配置
  - 添加自定义脚本
- **故障排查快速链接**
  - 按现象分类（Web 打不开、任务起不了、飞书无响应）
  - 指向 ARCHITECTURE.md 详细方案

**什么时候读**：
- ✓ 第一次部署，想让 Claude 自动化
- ✓ 部署后想要常见操作速查（pm2 命令）
- ✓ 遇到故障，想快速定位

---

### CONFIGURATION.md {#configuration}
**凭证 / 敏感信息 / 安全自查。**

**包含**：
- 快速开始（clone → npm install → .env → 启动）
- 所有环境变量的完整表
  - 飞书相关（LARK_APP_ID/SECRET、OWNER_OPEN_IDS）
  - Web 相关（PORT、SCRIPTS_DIR）
  - 模型选择（CLASSIFY_MODEL）
  - 代码目录（FRONTEND_DIR / BACKEND_DIR）
- 运行时敏感文件清单（从哪来、怎么产生、为什么忽略）
- 动作脚本 `scripts/` 目录说明（如何放脚本，避免硬编码密钥）
- 提交前安全自查（git 检查命令）

**什么时候读**：
- ✓ 第一次 clone 后配置环境变量
- ✓ 换新机器，想知道哪些文件需要配置
- ✓ 要提交代码前，检查有没有泄露密钥

---

### HISTORY_FEATURE.md {#history}
**历史检索特性（特性②）的详细说明。**

**包含**：
- 历史检索的工作原理
- 如何在侧栏查找历史会话
- 如何恢复和继续历史对话
- 按项目归档
- 搜索语法

**什么时候读**：
- ✓ 想用历史检索功能
- ✓ 想理解 `CLAUDE_PROJECT_ID` 的作用

---

### action-config.md & action-config-quick-checklist.md {#action_config}
**自定义脚本（特性⑤）的完整指南。**

**包含**：
- `action-configs.json` 的配置格式
- 脚本文件的存放位置（`scripts/`）
- 如何定义触发词
- 如何定义参数槽位
- 安全约束（不硬编码密钥）
- 快速清单（一步步添加脚本）

**什么时候读**：
- ✓ 想添加第一个自定义脚本
- ✓ 不确定 action-configs.json 怎么写

---

## 💡 学习路径建议

### 🟢 初级用户（只想快速跑起来）
1. [README.md](../README.md) —— 5 分钟了解项目
2. [DEPLOYMENT_GUIDE.md](#deployment_guide) —— 把 7 步指令给 Claude 自动部署
3. 部署完成后，试用 Web 界面，点击设置页 ⚙ 配置多账号

### 🟡 中级用户（想理解特定特性）
1. [README.md](../README.md) —— 全面了解 7 大特性
2. 针对感兴趣的特性，阅读 [ARCHITECTURE.md](#architecture) 的对应小节（如「特性④ 多 Claude 订阅账户」）
3. 根据需求阅读 [CONFIGURATION.md](#configuration) 或 [action-config.md](#action_config)

### 🔴 高级用户（开发者 / 扩展功能）
1. [ARCHITECTURE.md](#architecture) —— 全面理解架构
2. [docs/PROJECT-STRUCTURE.md](PROJECT-STRUCTURE.md) —— 代码文件组织
3. 阅读源码：`src/store/`, `src/features/`, `src/integrations/`
4. 参考「设计模式」和「故障排查」章节

---

## 🔗 快速链接

- **项目仓库**：当前目录
- **Web 服务**：http://127.0.0.1:3000（启动后）
- **PM2 日志**：`pm2 logs`
- **应用日志**：`logs/app-YYYY-MM-DD.log`
- **飞书开放平台**：https://open.feishu.cn/
- **Claude 官网**：https://claude.ai/

---

## 📞 遇到问题？

1. **第一步**：查看 [ARCHITECTURE.md](#architecture) 的「故障排查速查表」
2. **第二步**：看应用日志 `logs/app-*.log` 或 `pm2 logs`
3. **第三步**：在 [DEPLOYMENT_GUIDE.md](#deployment_guide) 的「故障排查快速链接」找对应场景
4. **第四步**：确认环境（[CONFIGURATION.md](#configuration) 的「前置条件」）

---

## 📝 文档维护

这份文档体系配合 README.md 和项目代码，可以让**任何开发者**快速理解和部署本项目。

**如果你发现文档有误或不清楚的地方**，欢迎反馈或改进。

**如果你添加了新功能**，请同步更新：
- [README.md](../README.md) —— 增强特性对照表
- [ARCHITECTURE.md](#architecture) —— 特性实现方案
- [action-config.md](#action_config) —— 如果涉及脚本
- [CONFIGURATION.md](#configuration) —— 如果新增 env

---

祝你使用愉快！ 🚀
