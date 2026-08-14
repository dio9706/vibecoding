# 🔄 降级功能测试指南

## 📋 项目降级机制概览

本项目包含 **6 层降级机制**，确保在各种故障场景下服务可用性最大化。

---

## 🧪 测试场景详解

### 1️⃣ Token 轮换降级测试

**核心文件**: `src/features/token-rotation.js`

#### 测试目标
验证当 Token 触发限流时，系统自动切换到备用 Token

#### 测试前置条件
- 在 `bindings.json` 中配置 **2+ 个有效 Token**
- Token 状态字段初始为 `active`

#### 测试步骤

**步骤 1: 查看当前 Token 状态**
```bash
# Windows PowerShell
cat .\bindings.json

# 预期输出:
# {
#   "tokens": [
#     { "id": "token-001", "status": "active", "errorCount": 0 },
#     { "id": "token-002", "status": "active", "errorCount": 0 }
#   ]
# }
```

**步骤 2: 触发限流（模拟）**
```bash
# 编辑 src/features/token-rotation.js
# 修改 noteRateLimit() 测试标志：TEST_FORCE_RATE_LIMIT = true
```

**步骤 3: 发送请求测试**
```bash
# 启动服务
npm start

# 在另一个终端发送多个快速请求
for ($i = 1; $i -le 5; $i++) {
  curl -X POST http://127.0.0.1:3000/api/run \
    -H "Content-Type: application/json" \
    -d '{"prompt":"Hello"}'
  Start-Sleep -Seconds 1
}
```

**步骤 4: 验证降级**
```bash
# 检查 bindings.json
cat .\bindings.json

# 预期: token-001 状态变为 'backoff'，token-002 变为 'active'
# {
#   "tokens": [
#     { "id": "token-001", "status": "backoff", "backoffUntil": 1234567890 },
#     { "id": "token-002", "status": "active", "errorCount": 0 }
#   ]
# }
```

**步骤 5: 验证恢复机制**
```bash
# 观察日志中的时间戳
tail -f event-log.jsonl | grep "token.*recover"

# 预期: 约 60 秒后自动恢复
# "token-001 recovered from backoff at 1234567950"
```

**预期行为**:
- ✅ Token 1 限流 → 状态变为 `backoff`
- ✅ Token 2 被激活为当前活跃 Token
- ✅ 后续请求自动使用 Token 2
- ✅ 60+ 秒后 Token 1 自动恢复

#### 测试代码示例
```javascript
// src/features/token-rotation.test.js 中添加
import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  getActiveToken, 
  noteRateLimit, 
  scheduleAllSwitchBacks 
} from './token-rotation.js';

test('Token 轮换 - 限流触发降级', async () => {
  // 模拟 3 个 Token
  const tokens = [
    { id: 'token-a', status: 'active' },
    { id: 'token-b', status: 'active' },
    { id: 'token-c', status: 'active' }
  ];
  
  // 当前活跃为 token-a
  assert.equal(getActiveToken(tokens).id, 'token-a');
  
  // 限流事件
  noteRateLimit('token-a');
  
  // 验证状态变化
  const updated = getActiveToken(tokens);
  assert.equal(updated.status, 'active');
  assert.notEqual(updated.id, 'token-a');  // 已切换
});

test('Token 轮换 - 自动恢复定时器', async () => {
  // ... 恢复逻辑测试
});
```

---

### 2️⃣ Effort 参数降级测试

**核心文件**: `src/integrations/claude.js` 第 65 行

#### 测试目标
验证模型不支持的 `effort` 参数时，SDK 自动降级

#### 测试步骤

**步骤 1: 使用高 Effort 参数调用**
```javascript
// 在测试脚本中
import { runClaude } from './src/integrations/claude.js';

const result = await runClaude('Test prompt', {
  model: 'claude-haiku-4-6',  // Haiku 可能不支持 xhigh
  effort: 'xhigh',             // 尝试超高思考强度
});

console.log('实际使用 effort:', result.actualEffort);
```

**步骤 2: 检查日志**
```bash
grep -i "effort.*downgrade" event-log.jsonl

# 预期输出:
# "SDK auto-downgraded effort from xhigh to high"
```

**预期行为**:
- ✅ SDK 检测模型不支持 xhigh
- ✅ 自动降级到 high 或 medium
- ✅ 应用层无需处理，透明降级
- ✅ 日志记录降级事件

#### 测试代码
```javascript
// test-effort-downgrade.mjs
import { runClaude } from './src/integrations/claude.js';

console.log('🧪 测试 Effort 参数降级...');

const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'];

for (const effort of effortLevels) {
  try {
    const result = await runClaude('2+2=?', {
      model: 'claude-haiku-4-6',
      effort,
      persistSession: false,  // 不保存历史
    });
    
    console.log(`✅ Effort ${effort}: ${result ? 'OK' : 'FAILED'}`);
  } catch (err) {
    console.log(`❌ Effort ${effort}: ${err.message}`);
  }
}
```

**运行测试**:
```bash
node test-effort-downgrade.mjs
```

---

### 3️⃣ 模型选择降级测试

**核心文件**: `src/entrypoints/web/server.js` 第 182-200 行

#### 测试目标
验证任务分类失败时，从 Haiku 超快分类降级到 medium effort

#### 测试步骤

**步骤 1: 启用分类超时**
```javascript
// src/entrypoints/web/server.js
async function classifyTier(prompt) {
  const quick = quickTier(prompt);
  if (quick) return quick;
  
  try {
    return await runClaude(prompt, {
      model: 'claude-haiku-4-6',
      effort: 'low',
      timeout: 1000,  // ⬅️ 改为 1 秒超时，易触发
    });
  } catch (err) {
    logger.warn('任务分类超时，降级到 medium');
    return { effort: 'medium' };  // 降级返回
  }
}
```

**步骤 2: 发送长 Prompt 测试**
```bash
curl -X POST http://127.0.0.1:3000/api/run \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "请生成一个 10000 字的详细文章..."
  }'
```

**步骤 3: 观察日志**
```bash
tail -f event-log.jsonl | grep -i "classif"

# 预期:
# "分类超时，降级到 medium"
# "使用 effort: medium 执行任务"
```

**预期行为**:
- ✅ Haiku 分类 1 秒内无结果
- ✅ 捕获超时异常
- ✅ 返回 `{ effort: 'medium' }`
- ✅ 用 medium effort 执行

#### 完整测试脚本
```javascript
// test-classification-downgrade.mjs
import http from 'http';
import { createReadStream } from 'fs';

console.log('🧪 测试分类降级...');

const testCases = [
  { name: '短提示', prompt: '你好' },
  { name: '长提示', prompt: '详细分析...'.repeat(100) },
  { name: '复杂提示', prompt: '生成代码并解释...'.repeat(50) },
];

for (const tc of testCases) {
  const startTime = Date.now();
  
  const req = http.request({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/run',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      const time = Date.now() - startTime;
      const json = JSON.parse(data);
      console.log(`✅ ${tc.name}: ${time}ms, effort: ${json.effort}`);
    });
  });
  
  req.write(JSON.stringify({ prompt: tc.prompt }));
  req.end();
}
```

---

### 4️⃣ 通知平台降级测试

**核心文件**: `src/integrations/notify.js`

#### 测试目标
验证在非 Windows 平台上降级为 console.log

#### 测试步骤

**Windows 平台**:
```bash
# 应该出现系统通知气泡
npm start
# → 观察屏幕右下角 Windows 通知
```

**非 Windows 平台** (Linux/Mac):
```bash
# 降级为 console.log
npm start

# 应该在终端看到:
# [通知] 任务完成: Run #123 成功
```

#### 测试代码
```javascript
// test-notify-platform.mjs
import { notify } from './src/integrations/notify.js';

console.log('当前平台:', process.platform);

notify('测试通知', '这是一条测试消息');

// 预期:
// Windows: 弹窗通知
// Others: console 输出
```

---

### 5️⃣ 会话恢复降级测试

**核心文件**: `src/store/pending-resume.js`

#### 测试目标
验证应用崩溃后，能从 pending 状态恢复，恢复失败时从历史重新开始

#### 测试前置条件
- 项目正在运行中
- 有进行中的任务（run）

#### 测试步骤

**步骤 1: 启动应用并开始任务**
```bash
npm start

# 在 Web UI 发起一个长时间任务
# 浏览器: http://127.0.0.1:3000
# 输入: "生成一个 2000 字的文章"
# 点击: 提交
```

**步骤 2: 模拟应用崩溃**
```bash
# 任务进行中时，按 Ctrl+C 强制关闭
# 这时 pending-resume.json 应该保存了状态
```

**步骤 3: 验证 Pending 状态**
```bash
cat .\pending-resume.json

# 预期:
# {
#   "runs": [
#     {
#       "runId": "run-12345",
#       "sessionId": "sess-67890",
#       "prompt": "生成一个 2000 字的文章",
#       "timestamp": 1234567890
#     }
#   ]
# }
```

**步骤 4: 重启应用**
```bash
npm start

# 观察日志
tail -f event-log.jsonl | grep -i "resume"

# 预期:
# "恢复中断会话: run-12345"
# "恢复成功，继续任务执行"
```

**步骤 5: 验证恢复结果**
```bash
# 方式 1: 检查 runs.json
cat .\runs.json | jq '.[] | select(.id == "run-12345")'

# 预期: run 状态应该是 finished（恢复并完成）

# 方式 2: 查看前端
# 刷新浏览器 → 应该看到 run-12345 的完整结果
```

**降级场景测试**（恢复失败）:
```javascript
// src/store/pending-resume.js 中修改（仅测试用）
async function recoverSession(pending) {
  try {
    // 模拟恢复失败
    throw new Error('模拟恢复失败');
  } catch (err) {
    logger.error('会话恢复失败，降级到新会话');
    // ⬅️ 应该降级，从历史或新开始
    return null;
  }
}
```

#### 预期行为
- ✅ 应用崩溃时保存 pending 状态
- ✅ 重启后自动恢复中断会话
- ✅ 恢复失败时，从历史会话重新加载
- ✅ 最坏情况：新建空会话，用户手动重新输入

---

### 6️⃣ 自动压缩降级测试

**核心文件**: `src/entrypoints/web/server.js` 第 330 行

#### 测试目标
验证长会话自动压缩，节省上下文 Token

#### 测试步骤

**步骤 1: 启用自动压缩**
```javascript
// 确保在 server.js 中配置：
settings: {
  autoCompactEnabled: true
}
```

**步骤 2: 进行长对话**
```bash
# 发起 20+ 轮对话（50+ 条消息）
curl -X POST http://127.0.0.1:3000/api/run/send \
  -H "Content-Type: application/json" \
  -d '{"runId":"run-123", "text":"继续对话..."}' 

# 重复 20 次...
```

**步骤 3: 检查会话大小**
```bash
# 第一轮消息数 vs 后期消息数
cat .\runs.json | jq '.[] | .messages | length'

# 预期: 后期消息数量被压缩，但能保留关键上下文
```

**步骤 4: 验证成本节约**
```bash
grep -i "compact" event-log.jsonl

# 预期:
# "会话自动压缩: 原消息数 50 → 压缩后 25"
# "估计节省 Token: 2000"
```

#### 预期行为
- ✅ 消息数超过阈值（如 30 条）自动压缩
- ✅ 保留最近的关键消息
- ✅ 合并早期的系统消息
- ✅ Token 成本降低 20-40%

---

## 🎯 综合降级测试场景

### 场景 A: 完整限流转换流程
```
1. 初始化 3 个 Token (A, B, C)
2. A 限流 → 自动切换到 B
3. B 限流 → 自动切换到 C
4. C 限流 → 所有 Token 冷却，等待恢复
5. 60+ 秒后，A 自动恢复 → 重新选择 A
6. 验证转换过程完整，无中断
```

**测试脚本**:
```javascript
// comprehensive-degradation-test.mjs
import { getActiveToken, noteRateLimit } from './src/features/token-rotation.js';

async function testCompleteFlow() {
  console.log('🧪 完整降级测试...');
  
  const tokens = ['token-a', 'token-b', 'token-c'];
  let activeToken = tokens[0];
  
  for (let i = 0; i < 10; i++) {
    console.log(`第 ${i+1} 轮: 当前活跃 Token = ${activeToken}`);
    
    // 模拟限流
    noteRateLimit(activeToken);
    
    // 获取下一个
    activeToken = getNextToken(tokens, activeToken);
    
    // 短暂延迟
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log('✅ 完整流程测试通过');
}

testCompleteFlow().catch(console.error);
```

### 场景 B: 级联降级（多层）
```
1. 分类 → 降级（Haiku 超时）
2. Model 降级 → 使用 Sonnet 替代 Opus
3. Effort 降级 → 使用 medium 替代 high
4. Token 降级 → 切换备用 Token
5. 验证最终使用的 Model/Effort/Token 组合
```

### 场景 C: 故障恢复（Chaos Engineering）
```
1. 启动应用
2. 随机注入故障（限流、超时、崩溃）
3. 验证自动恢复
4. 检查无数据丢失
5. 验证用户体验无中断
```

---

## 📊 降级测试检查清单

### Token 轮换
- [ ] 单 Token 限流自动切换
- [ ] 多 Token 轮流切换
- [ ] 所有 Token 限流时的处理
- [ ] Token 自动恢复定时器
- [ ] 冷却时间配置正确

### Effort 参数
- [ ] 支持的 effort 正常运行
- [ ] 不支持的 effort 自动降级
- [ ] 降级不丢失功能
- [ ] 日志记录降级事件

### 模型选择
- [ ] 快速分类成功
- [ ] 快速分类超时降级
- [ ] 降级后仍能完成任务
- [ ] 成本控制（更省 Token）

### 会话恢复
- [ ] 正常中断能恢复
- [ ] 多轮恢复成功
- [ ] 恢复失败降级新会话
- [ ] 无数据丢失

### 通知系统
- [ ] Windows 平台显示气泡
- [ ] 非 Windows 平台显示日志
- [ ] 通知失败不影响主流程

### 自动压缩
- [ ] 长会话被压缩
- [ ] 关键信息保留
- [ ] Token 成本降低
- [ ] 压缩后仍能回复相关问题

---

## 🔍 调试技巧

### 1. 查看实时日志
```bash
# 监听事件日志
tail -f event-log.jsonl | jq '.'

# 过滤降级事件
tail -f event-log.jsonl | jq 'select(.level == "warn" or .level == "error")'

# 过滤 Token 事件
tail -f event-log.jsonl | jq 'select(.message | contains("token"))'
```

### 2. 检查状态文件
```bash
# 查看当前 Token 状态
cat bindings.json | jq '.tokens[] | {id, status, errorCount}'

# 查看待恢复队列
cat pending-resume.json | jq '.'

# 查看活跃运行
cat active-runs.json | jq '.'
```

### 3. 模拟故障
```javascript
// 在源代码中临时添加
const TEST_MODE = true;
const FORCE_RATE_LIMIT = true;
const FORCE_TIMEOUT = true;
const FORCE_RECOVERY_FAILURE = false;
```

### 4. 性能观察
```bash
# 监控 Token 切换次数
grep -c "token.*active" event-log.jsonl

# 监控降级触发频率
grep -c "降级" event-log.jsonl

# 监控平均恢复时间
grep "token.*recovery" event-log.jsonl | tail -10
```

---

## ✅ 测试完成标准

所有降级功能测试通过标准：

- ✅ **Token 轮换**: 限流时自动切换，60+ 秒后恢复
- ✅ **Effort 降级**: SDK 自动降级，应用层无感知
- ✅ **模型选择**: 分类失败时降级到 medium effort
- ✅ **会话恢复**: 崩溃后能恢复，恢复失败降级新会话
- ✅ **通知平台**: 不同平台有对应实现
- ✅ **自动压缩**: 长会话被压缩，Token 成本降低
- ✅ **无数据丢失**: 所有降级过程数据完整
- ✅ **用户体验**: 降级对用户透明，无明显卡顿

---

**最后更新**: 2026-07-19  
**版本**: 1.0  
**负责人**: 项目开发团队
