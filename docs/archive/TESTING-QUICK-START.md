# 🚀 降级功能测试 - 快速开始

## 📋 一句话概括

本项目包含 **6 层自动降级机制**，在 Token 限流、模型超时、平台不支持等故障场景下，自动降级到可用服务，确保应用 **永不停服**。

---

## 🎯 快速测试（3 步）

### 第 1 步：检查项目结构
```bash
cd C:\Users\DELL\Desktop\claude-p-web-demo
node test-degradation.mjs
```

**预期输出**:
```
✅ Token 轮换降级测试通过
✅ Effort 参数降级测试通过
✅ 分类降级测试通过
✅ 会话恢复降级测试通过
✅ 通知平台降级测试通过
✅ 自动压缩降级测试通过

🎉 所有降级功能测试通过！
```

### 第 2 步：启动应用
```bash
npm start
# 或
node server.js
```

### 第 3 步：访问 Web UI
```
http://127.0.0.1:3000
```

---

## 🔄 6 层降级机制一览

| # | 降级机制 | 触发条件 | 降级动作 | 文件位置 |
|---|--------|--------|--------|---------|
| 1️⃣ | **Token 轮换** | Token 限流 | 切换备用 Token | `src/features/token-rotation.js` |
| 2️⃣ | **Effort 降级** | 模型不支持 effort | 自动降级到低等级 | `src/integrations/claude.js` |
| 3️⃣ | **模型分类** | 分类超时 | 降级到 medium effort | `src/entrypoints/web/server.js` |
| 4️⃣ | **会话恢复** | 应用崩溃 | 自动恢复进度 | `src/store/pending-resume.js` |
| 5️⃣ | **通知平台** | 非 Windows | 降级到 console.log | `src/integrations/notify.js` |
| 6️⃣ | **自动压缩** | 长会话 | 压缩历史消息，节省 Token | `src/entrypoints/web/server.js` |

---

## 📝 单独测试各个降级机制

### 1️⃣ 测试 Token 轮换
```bash
# 快速检查
node test-degradation.mjs --scenario=token

# 详细测试
node extended-tool-test.mjs
```

**验证方法**:
1. 在 `bindings.json` 配置 2+ 个 Token
2. 观察 `event-log.jsonl` 中的 Token 切换日志
3. 限流时应自动切换到下一个 Token

### 2️⃣ 测试 Effort 降级
```bash
# 快速检查
node test-degradation.mjs --scenario=effort

# 实际测试
curl -X POST http://127.0.0.1:3000/api/run \
  -H "Content-Type: application/json" \
  -d '{"prompt":"test","effort":"xhigh"}'
```

**验证方法**:
- Haiku 模型不支持 `xhigh` 时，SDK 自动降级
- 查看日志确认实际使用的 effort 等级

### 3️⃣ 测试分类降级
```bash
# 快速检查
node test-degradation.mjs --scenario=classification

# 实际触发
npm start
# 发送长提示词（>500 字）
```

**验证方法**:
- 长提示词分类超时 → 自动降级到 medium
- 日志中应有 "分类超时，降级" 提示

### 4️⃣ 测试会话恢复
```bash
# 快速检查
node test-degradation.mjs --scenario=resume

# 实际触发
# 1. npm start
# 2. 发起长时间任务
# 3. Ctrl+C 强制关闭
# 4. 重新 npm start
# 5. 观察 pending-resume.json 是否被恢复
```

**验证方法**:
- 应用崩溃时 `pending-resume.json` 保存进度
- 重启后自动恢复中断的会话

### 5️⃣ 测试通知平台降级
```bash
# 快速检查
node test-degradation.mjs --scenario=notify

# 实际测试（Windows）
npm start
# 应该在屏幕右下角看到 Windows 通知气泡

# 实际测试（非 Windows）
npm start
# 应该在终端看到通知输出
```

### 6️⃣ 测试自动压缩
```bash
# 快速检查
node test-degradation.mjs --scenario=compress

# 实际触发
npm start
# 进行 20+ 轮对话
# 观察消息数是否被压缩
```

---

## 📊 监控降级事件

### 实时查看降级日志
```bash
# 持续监听所有降级事件
tail -f event-log.jsonl | jq 'select(.message | contains("降级") or contains("downgrade") or contains("fallback"))'

# 监听限流事件
tail -f event-log.jsonl | jq 'select(.message | contains("limit") or contains("rate"))'

# 统计降级事件数量
grep -o "降级" event-log.jsonl | wc -l
```

### 检查 Token 状态
```bash
# 查看当前 Token 状态
cat bindings.json | jq '.tokens[] | {id, status, errorCount, backoffUntil}'

# 监听 Token 变化
watch -n 1 'cat bindings.json | jq ".tokens[] | {id, status}"'
```

### 检查待恢复队列
```bash
# 查看有多少会话待恢复
cat pending-resume.json | jq '.runs | length'

# 查看最近的待恢复项
cat pending-resume.json | jq '.runs[-1]'
```

---

## 🧪 完整测试场景

### 场景 A: 降级链（3 层）
```
1. Token 限流 → Token 降级（切换备用）
2. 分类超时 → Effort 降级（medium）
3. 长会话 → 自动压缩（节省 Token）
```

**测试步骤**:
```bash
# 终端 1
npm start

# 终端 2（模拟限流）
for i in {1..10}; do
  curl http://127.0.0.1:3000/api/run \
    -d '{"prompt":"test"}' &
done
wait

# 观察日志
tail -50 event-log.jsonl | jq '.'
```

### 场景 B: 应用恢复（崩溃恢复）
```bash
# 终端 1
npm start

# 终端 2（发起长任务）
curl http://127.0.0.1:3000/api/run \
  -d '{"prompt":"生成 5000 字文章"}'

# 任务进行中，终端 1 按 Ctrl+C 强制关闭
# 等待 5 秒

# 终端 1（重启）
npm start

# 观察是否恢复了之前的任务
tail -f event-log.jsonl | grep "recover"
```

---

## 🐛 调试技巧

### 1. 启用测试模式（强制降级）
编辑 `src/features/token-rotation.js` 顶部：
```javascript
// 测试模式开关
const TEST_MODE = true;
const FORCE_RATE_LIMIT = true;  // 强制限流降级
const FORCE_TIMEOUT = false;     // 强制超时降级
```

### 2. 查看详细日志
```bash
# 过滤所有降级日志
grep -i "degrad\|fallback\|switchback" event-log.jsonl

# 查看最后 50 行
tail -50 event-log.jsonl | jq '.'

# 查看特定时间段的日志
grep "2026-07-19T14:" event-log.jsonl | jq '.'
```

### 3. 监控内存和性能
```bash
# Windows PowerShell
Get-Process node | Select-Object -Property Name, WorkingSet, CPU

# Linux/Mac
ps aux | grep node
```

---

## ✅ 测试检查清单

- [ ] **Token 轮换**: 限流时自动切换 ✓
- [ ] **Effort 降级**: SDK 自动降级不抛错 ✓
- [ ] **分类降级**: 超时时降级到 medium ✓
- [ ] **会话恢复**: 崩溃后能恢复进度 ✓
- [ ] **通知平台**: 不同平台有对应实现 ✓
- [ ] **自动压缩**: 长会话被压缩，成本降低 ✓
- [ ] **无数据丢失**: 所有降级过程数据完整 ✓
- [ ] **用户体验**: 降级对用户透明 ✓

---

## 📚 完整文档

- 📄 **[PROJECT-STRUCTURE.md](./PROJECT-STRUCTURE.md)** - 项目完整目录结构
- 📄 **[DEGRADATION-TEST-GUIDE.md](./DEGRADATION-TEST-GUIDE.md)** - 详细测试指南
- 📄 **[README.md](./README.md)** - 项目说明
- 📄 **[QUICK-REFERENCE.txt](./QUICK-REFERENCE.txt)** - 快速参考

---

## 💡 常见问题

### Q1: 怎样验证 Token 已切换？
**A**: 查看 `bindings.json` 中 `status` 字段的变化
```bash
cat bindings.json | jq '.tokens[] | {id, status}'
```

### Q2: 降级会影响功能吗？
**A**: 不会。所有降级是自动且透明的，只是性能/成本有调整：
- Token 降级：功能完全相同
- Effort 降级：思考时间减少，但仍能完成任务
- 分类降级：使用更保险的参数，避免失败
- 会话降级：新建会话，无进度丢失

### Q3: 多久会自动恢复？
**A**: 依降级类型而定：
- Token 限流：60 秒后自动尝试恢复
- 会话恢复：立即恢复（应用启动时）
- 其他：立即恢复

### Q4: 怎样强制测试降级？
**A**: 见上面 "调试技巧" 部分，启用 `TEST_MODE`

---

## 🎯 最后一步

现在运行测试：
```bash
node test-degradation.mjs
```

如果所有项都显示 ✅，说明降级机制已完整部署！ 🎉

---

**更新时间**: 2026-07-19  
**测试工具版本**: 1.0  
**支持状态**: ✅ 生产环境可用
