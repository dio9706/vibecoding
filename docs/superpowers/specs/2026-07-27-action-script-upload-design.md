# 动作脚本上传 —— 设计文档

日期：2026-07-27
状态：待评审

## 背景与目标

动作配置（ActionConfig）通过 `scriptName` 引用一个脚本文件，由 action-runner 执行。现状问题：

- 脚本靠"手填文件名"，文件必须**预先存在于脚本目录**；桌面版（Tauri）打包时 `prepare-sidecar.mjs` 未把 `scripts/` 打进包，导致桌面版根本没有脚本可跑。
- `config.scripts.dir` 默认 `'scripts'` 是**相对进程 cwd** 的：PM2（cwd=仓库根）解析到 `仓库根/scripts`，桌面版（cwd=APP_DATA_DIR）解析到 `AppData/scripts`——两个运行时指向**不同目录**，行为不一致。

**目标**：把"手填脚本名"改为"**上传代码文件**"。上传的脚本存到**可写的数据目录**，动作配置引用它；桌面版与 PM2 用同一份脚本目录。加/改脚本不再需要重新打包。

## 非目标（YAGNI）

- 不做在线代码编辑器（只上传，不在页面里编辑脚本内容）。
- 不做脚本版本管理 / 历史。
- 删除动作时不联动删除脚本文件。
- 不把脚本内容内嵌进 action-configs.json（已评估的"思路 2"，不采纳）。

## 关键决策（已与用户确认）

1. 表单里去掉"脚本文件名"手填框与"脚本类型"下拉，改为**上传按钮**；脚本类型按扩展名自动判定。
2. 上传脚本以**原文件名**（清洗后）作为 `scriptName`；**同名覆盖**（= 更新脚本）。
3. 存储位置：`<数据目录>/scripts/`；`config.scripts.dir` 改为**基于数据目录的绝对路径**。

## 架构与数据流

```
设置页「动作表单」
  → 选择 .py / .js 文件
  → POST /api/scripts/upload?name=<原文件名>   （请求体=文件二进制）
      服务端：校验扩展名/大小/文件名安全 → 写入 <scriptsDir>/<清洗后原名>（同名覆盖）
      返回 { scriptName, scriptType }
  → 前端把 scriptName / scriptType 写入表单状态
  → 保存动作：POST /api/actions（新建）或 PUT /api/actions/:id（编辑）

运行时（飞书/web 触发动作）：
  script-runner: scriptPath = path.join(config.scripts.dir, scriptName)   // scripts.dir 已是绝对路径
  → runScript(python|node, [scriptPath, ...args])
```

## 组件设计

### 1. 脚本目录解析统一（`src/shared/config.js`）

`config.scripts.dir` 改为**绝对路径**，优先级：

1. `process.env.SCRIPTS_DIR`（显式覆盖，原样使用）
2. `process.env.APP_DATA_DIR` 存在 → `path.join(APP_DATA_DIR, 'scripts')`
3. 兜底（dev，无 APP_DATA_DIR）→ `path.join(<仓库根>, 'scripts')`，其中仓库根由 `config.js` 的 `import.meta.url` 上溯两级（`src/shared` → 仓库根）得到。

理由：数据目录已通过迁移统一为 `AppData`，桌面版与 PM2 都注入 `APP_DATA_DIR`，故两者都解析到 `AppData/scripts`，与上传落点一致；dev 态仍用仓库根 `scripts/`（现有脚本所在），行为不变。

### 2. 上传接口（`src/entrypoints/web/routes-files.js` 新增 handler + `server.js` 路由）

`POST /api/scripts/upload?name=<原文件名>`

- 方法非 POST → 405。
- 读请求体为二进制（复用 `handleUpload` 的分块+大小上限写法）。
- 校验：
  - 扩展名 ∈ {`.py`, `.js`}，否则 400。
  - 大小上限 **1MB**，超限 413。
  - 文件名：`path.basename(name)` 后按 `/[^\w.\-一-龥]/g → '_'` 清洗；清洗后仍须保留合法扩展名，否则 400。
- 写入：确保 `config.scripts.dir` 存在（`mkdirSync recursive`），写 `<scriptsDir>/<清洗后原名>`（**覆盖**）。
- 返回 200 `{ scriptName: '<清洗后原名>', scriptType: 'python' | 'node' }`（`.py`→python，`.js`→node）。
- 失败 500 `{ error }`。

注：该接口写入 `config.scripts.dir`，与用于"给 Claude 读取的拖拽文件"的 `.uploads/` 是**不同目录、不同用途**，不复用 `.uploads`。

### 3. 列脚本接口修正（`src/entrypoints/web/routes-ops.js handleScripts`）

`GET /api/scripts` 当前 `const dir = join(process.cwd(), config.scripts.dir)`；因 `scripts.dir` 已是绝对路径，改为 `const dir = config.scripts.dir`（去掉 cwd 拼接）。其余（过滤 `.py/.js`、目录不存在返回 `[]`）不变。

### 4. 运行时定位（`src/plugins/action-runner/feature/script-runner.js`）

`scriptPath = path.join(config.scripts.dir, scriptName)` 保持不变——`scripts.dir` 变绝对后，`path.join(绝对, 相对名)` 得到绝对脚本路径，`runScript` 不再依赖 spawn 的 cwd。无需改逻辑（仅受 config 变更影响）。

### 5. UI（`public/js/actions-panel.js`）

动作表单改动：

- 删除 `#scriptName` 手填 `<input>` 与 `#scriptType` `<select>`。
- 新增「上传脚本」控件：一个隐藏 `<input type="file" accept=".py,.js">` + 一个按钮 + 一行"当前脚本：`<scriptName>`"文本。
- 选择文件后：`fetch('/api/scripts/upload?name=' + encodeURIComponent(file.name), { method:'POST', body:file })` → 成功则把返回的 `scriptName`/`scriptType` 存入表单状态并更新"当前脚本"显示；失败 `toast`。
- 编辑动作时：用已有 `action.scriptName` 初始化"当前脚本"显示；未重新上传即沿用原值。
- `saveAction` 的 payload：`scriptName` 取表单状态（上传结果或原值），`scriptType` 同理；其余字段不变。
- 校验：保存时若无 `scriptName`（新建且未上传）→ `toast` 提示"请先上传脚本"，不提交。

## 错误处理

| 场景 | 处理 |
|---|---|
| 扩展名非 .py/.js | 400，前端 toast |
| 文件 >1MB | 413，前端 toast |
| 清洗后文件名非法/无扩展名 | 400 |
| 磁盘写入失败 | 500 `{error}`，前端 toast |
| scripts 目录不存在 | 上传时 `mkdirSync recursive` 自动创建 |
| 新建动作未上传脚本就保存 | 前端拦截，提示先上传 |
| 运行时脚本文件缺失 | 沿用现有 action-runner 失败回复（脚本执行失败 → ❌ 文案） |

## 向后兼容

- 老配置以 `scriptName` 引用照常工作：现有 `reset_onboarding.py` / `get_qrcode.py` 已放入 `AppData/scripts`。
- `prepare-sidecar.mjs` 不再需要为脚本打包做改动（上传取代内置）。默认动作（清理）依赖的脚本以"已存在于 scripts 目录"为前提；`initializeDefaults` 逻辑不变。

## 测试

**单元测试**
- 上传 handler：`.py`/`.js` 成功并返回正确 `scriptType`；非法扩展名 400；超 1MB 413；文件名穿越（`../x.py`）被 `basename`+清洗拦成安全名；同名覆盖生效。
- `config.scripts.dir` 解析：设 `APP_DATA_DIR` → `<APP_DATA_DIR>/scripts`；未设 → `<仓库根>/scripts`；设 `SCRIPTS_DIR` → 原样。
- `handleScripts`：用绝对 `scripts.dir` 列出 `.py/.js`；目录不存在返回 `[]`。

**手动测试**
- 设置页动作表单上传 `get_qrcode.py` → 新建/编辑动作 → 保存 → 列表显示脚本名。
- 飞书发"正式版二维码" → 命中动作 → 跑 `AppData/scripts/get_qrcode.py` → 正常回复。
- 上传同名脚本 → 覆盖生效（改动能被下次执行读到）。

## 涉及文件

- `src/shared/config.js`：`scripts.dir` 改绝对路径解析。
- `src/entrypoints/web/routes-files.js`：新增 `handleScriptUpload`。
- `src/entrypoints/web/server.js`：路由 `POST /api/scripts/upload`。
- `src/entrypoints/web/routes-ops.js`：`handleScripts` 去掉 cwd 拼接。
- `public/js/actions-panel.js`：表单改上传控件。
- 测试：上传 handler、config 解析、handleScripts 各自的测试文件。
