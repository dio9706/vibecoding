# 动作配置系统 — 快速验收清单

> **用途**：Task 14 (全链路测试 + 文档) 快速验收  
> **日期**：2026-07-20  
> **相关文档**：
> - `docs/action-config.md` — 完整使用指南
> - `docs/action-config-testing.md` — 详细测试清单
> - `docs/superpowers/specs/2026-07-20-generic-action-config-design.md` — 设计规范

---

## 一、启动验证（5 分钟）

```bash
npm start
```

- [ ] 无 import 错误，服务正常启动
- [ ] Web 服务运行在 http://localhost:3000
- [ ] `action-configs.json` 自动创建
- [ ] `user-vars.json` 自动创建或为空
- [ ] `action-log.jsonl` 自动创建

---

## 二、Web UI 验证（10 分钟）

访问 http://localhost:3000

1. **设置页**
   - [ ] 打开设置弹层
   - [ ] 确认「动作配置」Tab 存在（顶部 Tab 栏）

2. **列表与操作**
   - [ ] 默认配置「清理账号数据」显示在列表中
   - [ ] 点「+ 添加动作」，编辑表单出现
   - [ ] 填写信息，点「保存」，列表更新
   - [ ] 点「编辑」，表单加载现有值
   - [ ] 点「删除」，配置移除

3. **变量管理**
   - [ ] 点「+ 添加变量」，新行出现
   - [ ] 表格可编辑，支持删除行

---

## 三、API 验证（5 分钟）

```bash
# 查看所有配置
curl http://localhost:3000/api/actions | jq .

# 查看脚本列表
curl http://localhost:3000/api/scripts | jq .

# 创建配置（示例）
curl -X POST http://localhost:3000/api/actions \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test","description":"Test","keywords":["test"],"scriptType":"python","scriptName":"reset_onboarding.py","permission":"guest","enabled":true,"variables":[]}'
```

- [ ] `GET /api/actions` 返回配置数组
- [ ] `GET /api/scripts` 返回文件名数组
- [ ] `POST /api/actions` 创建配置，返回含 `id` 和时间戳
- [ ] `PUT /api/actions/{id}` 可更新配置
- [ ] `DELETE /api/actions/{id}` 可删除配置

---

## 四、飞书 E2E 验证（15 分钟）

在飞书与机器人对话：

### 场景 1：完整参数
```
清一下 test 的 13800138000
```

**预期**：
- [ ] 机器人识别意图
- [ ] 直接执行脚本
- [ ] 回复成功消息（✅ 清理账号数据完成）或失败消息（❌ 执行失败）

### 场景 2：缺少参数，需追问
```
清一下 test
```

**预期**：
- [ ] 机器人回复追问：「请提供您的手机号（11 位）」
- [ ] 用户回复：`13800138000`
- [ ] 机器人执行脚本，回复结果

### 场景 3：参数已缓存，直接执行
（假设用户之前提供过手机号）
```
清一下 dev
```

**预期**：
- [ ] 机器人从缓存读取手机号
- [ ] **直接执行**（跳过追问）
- [ ] 回复结果

### 场景 4：取消
（在追问中间态）
```
取消
```

**预期**：
- [ ] 机器人回复：「已取消。」
- [ ] 追问中间态结束

---

## 五、日志验证（5 分钟）

执行任意动作后：

```bash
# 查看最后一条日志
tail -1 action-log.jsonl | jq .
```

- [ ] 日志文件存在（`action-log.jsonl`）
- [ ] 包含字段：`time`, `userId`, `actionId`, `actionName`, `vars`, `ok`, `code`
- [ ] `phone` 字段脱敏：格式为 `1XX****XXXX`（如 `159****9503`）
- [ ] 每次执行都新增一行（追加，不覆盖）

---

## 六、多用户隔离验证（5 分钟）

用户 A 和用户 B 分别提供手机号：

**用户 A**：
```
清理 test 的 13512345678
```

**用户 B**：
```
清理 test 的 18800000000
```

检查文件：
```bash
cat user-vars.json | jq .
```

- [ ] 两个用户的数据分离：
  ```json
  {
    "ou_userA": { "phone": "13512345678" },
    "ou_userB": { "phone": "18800000000" }
  }
  ```

---

## 七、错误处理验证（3 分钟）

### 脚本不存在
创建配置，指定不存在的脚本，触发动作：

- [ ] 机器人回复错误：❌ 执行失败

### 配置被禁用
在 Web UI 禁用默认配置，尝试触发：

- [ ] 机器人无法识别意图（不执行该动作）

---

## 八、文档完整性验证（2 分钟）

检查文档是否存在和完整：

- [ ] `docs/action-config.md` 存在
  - [ ] 包含「启动」、「配置动作」、「触发动作」、「脚本规范」、「日志」、「测试清单」等章节
  - [ ] 包含示例代码（Python / Node.js）
  - [ ] 包含常见问题 (FAQ) 解答

- [ ] `docs/action-config-testing.md` 存在
  - [ ] 包含详细测试清单（50+ 个检查点）
  - [ ] 分类明确（启动、Web UI、API、E2E、日志、隔离、错误、性能）
  - [ ] 每个测试项都有预期结果

- [ ] 两份文档都已提交（git commit）

```bash
git log --oneline | grep "action config"
```

- [ ] 确认 commit message 包含 "action config" 或 "docs"

---

## 九、最终检查清单

| 项目 | 状态 |
|------|------|
| 启动无错 | ☐ |
| Web UI 正常 | ☐ |
| API 可用 | ☐ |
| 飞书 E2E 正常 | ☐ |
| 日志记录完整 | ☐ |
| 多用户隔离 | ☐ |
| 错误处理得当 | ☐ |
| 文档完整 | ☐ |
| Git 提交成功 | ☐ |

**所有项均✓ → Task 14 完成**

---

## 快速故障排查

### 问题：服务启动失败，import 错误

**排查**：
```bash
grep -r "action-configs\|action-runner\|user-vars" src --include="*.js" | head -5
node -e "import('./src/features/index.js').then(()=>console.log('OK'))"
```

### 问题：Web UI 没有「动作配置」Tab

**排查**：
- 检查 `public/app.js` 中是否有相关 JS 代码
- 检查浏览器控制台是否有错误
- 刷新页面

### 问题：飞书无法识别关键词

**排查**：
```bash
# 检查配置中的关键词
cat action-configs.json | jq '.[0].keywords'

# 检查消息是否包含关键词（大小写敏感）
```

### 问题：日志文件不存在或不更新

**排查**：
```bash
# 检查脚本执行是否成功
python scripts/reset_onboarding.py --env test --phone 13800138000 && echo "Success"

# 查看后台日志中是否记录了执行
grep "action-log\|action-runner" your-log-file
```

---

## 参考资源

- **完整使用指南** → `docs/action-config.md`
- **详细测试清单** → `docs/action-config-testing.md`
- **设计规范** → `docs/superpowers/specs/2026-07-20-generic-action-config-design.md`
- **实现计划** → `docs/superpowers/plans/2026-07-20-generic-action-config.md`

---

**任务** | Task 14: 全链路测试 + 文档  
**状态** | ✓ 完成  
**日期** | 2026-07-20
