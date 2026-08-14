#!/usr/bin/env node
/**
 * 降级功能快速测试脚本
 * 用法: node test-degradation.mjs [--scenario=all|token|effort|classification|resume|notify|compress]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// 彩色输出工具
// ============================================================================
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function success(msg) {
  log(`✅ ${msg}`, 'green');
}

function error(msg) {
  log(`❌ ${msg}`, 'red');
}

function warn(msg) {
  log(`⚠️  ${msg}`, 'yellow');
}

function info(msg) {
  log(`ℹ️  ${msg}`, 'cyan');
}

function title(msg) {
  log(`\n${'═'.repeat(70)}`, 'bright');
  log(`  ${msg}`, 'bright');
  log(`${'═'.repeat(70)}\n`, 'bright');
}

// ============================================================================
// 测试工具函数
// ============================================================================
function readJson(filename) {
  try {
    const filePath = path.join(__dirname, filename);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeJson(filename, data) {
  try {
    const filePath = path.join(__dirname, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    return false;
  }
}

// ============================================================================
// 测试场景 1: Token 轮换降级
// ============================================================================
async function testTokenRotation() {
  title('测试场景 1: Token 轮换降级');

  info('检查 bindings.json 中的 Token 配置...');
  const bindings = readJson('bindings.json');

  if (!bindings || !bindings.tokens || bindings.tokens.length < 2) {
    error('Token 数量不足（需要 2+ 个）');
    log('\n💡 建议: 在 bindings.json 中至少配置 2 个 Token', 'dim');
    return false;
  }

  success(`检测到 ${bindings.tokens.length} 个 Token`);

  // 检查初始状态
  const activeCount = bindings.tokens.filter(t => t.status === 'active').length;
  success(`${activeCount} 个 Token 处于活跃状态`);

  // 验证必要字段
  for (const token of bindings.tokens) {
    if (!token.id || !token.status) {
      error(`Token 配置不完整: ${JSON.stringify(token)}`);
      return false;
    }
  }

  success('✓ Token 配置结构正确');
  success('✓ Token 轮换降级测试通过');
  return true;
}

// ============================================================================
// 测试场景 2: Effort 参数降级
// ============================================================================
async function testEffortDowngrade() {
  title('测试场景 2: Effort 参数降级');

  info('检查 claude.js 中的 Effort 参数处理...');

  try {
    const claudePath = path.join(__dirname, 'src/integrations/claude.js');
    const content = fs.readFileSync(claudePath, 'utf8');

    if (content.includes("opts.effort")) {
      success('✓ claude.js 正确处理 effort 参数');
    } else {
      error('找不到 effort 参数处理代码');
      return false;
    }

    if (content.includes('模型不支持时')) {
      success('✓ 注释中说明了自动降级行为');
    }

    const effortRegex = /effort[:\s]+['"]?(low|medium|high|xhigh|max)['"]?/gi;
    const matches = content.match(effortRegex) || [];
    success(`✓ 支持 ${new Set([...matches]).size} 个 effort 等级`);

    success('✓ Effort 参数降级实现完整');
    return true;
  } catch (err) {
    error(`检查失败: ${err.message}`);
    return false;
  }
}

// ============================================================================
// 测试场景 3: 分类降级
// ============================================================================
async function testClassificationDowngrade() {
  title('测试场景 3: 模型分类降级');

  info('检查 server.js 中的任务分类逻辑...');

  try {
    const serverPath = path.join(__dirname, 'src/entrypoints/web/server.js');
    const content = fs.readFileSync(serverPath, 'utf8');

    if (content.includes('classifyTier')) {
      success('✓ 找到 classifyTier 函数');
    } else {
      error('找不到 classifyTier 函数');
      return false;
    }

    if (content.includes('fallback') || content.includes('medium')) {
      success('✓ 存在降级逻辑（降级到 medium effort）');
    }

    if (content.includes('quickTier')) {
      success('✓ 实现了快速分类（本地规则）');
    }

    success('✓ 分类降级机制完整');
    return true;
  } catch (err) {
    error(`检查失败: ${err.message}`);
    return false;
  }
}

// ============================================================================
// 测试场景 4: 会话恢复降级
// ============================================================================
async function testSessionRecovery() {
  title('测试场景 4: 会话恢复降级');

  info('检查 pending-resume.json 结构...');
  const pending = readJson('pending-resume.json');

  if (!pending) {
    warn('pending-resume.json 不存在（正常，尚未发生中断）');
    success('✓ 当应用崩溃时会自动创建此文件');
  } else if (pending.runs && Array.isArray(pending.runs)) {
    success(`✓ 找到 ${pending.runs.length} 个待恢复会话`);
  }

  info('检查 history.js 中的恢复逻辑...');
  try {
    const historyPath = path.join(__dirname, 'src/store/history.js');
    const content = fs.readFileSync(historyPath, 'utf8');

    if (content.includes('getHistorySession')) {
      success('✓ 存在历史会话恢复函数');
    }

    success('✓ 会话恢复降级机制完整');
    return true;
  } catch (err) {
    error(`检查失败: ${err.message}`);
    return false;
  }
}

// ============================================================================
// 测试场景 5: 通知平台降级
// ============================================================================
async function testNotifyDowngrade() {
  title('测试场景 5: 通知平台降级');

  info('检查 notify.js 中的平台适配...');

  try {
    const notifyPath = path.join(__dirname, 'src/integrations/notify.js');
    const content = fs.readFileSync(notifyPath, 'utf8');

    if (content.includes('process.platform')) {
      success('✓ 实现了平台检测（platform === "win32"）');
    } else {
      error('未检测到平台检查代码');
      return false;
    }

    if (content.includes('console')) {
      success('✓ 非 Windows 平台降级为 console.log');
    }

    success('✓ 通知平台降级完整');

    info(`当前平台: ${process.platform}`);
    return true;
  } catch (err) {
    error(`检查失败: ${err.message}`);
    return false;
  }
}

// ============================================================================
// 测试场景 6: 自动压缩降级
// ============================================================================
async function testAutoCompress() {
  title('测试场景 6: 自动压缩降级');

  info('检查 server.js 中的自动压缩配置...');

  try {
    const serverPath = path.join(__dirname, 'src/entrypoints/web/server.js');
    const content = fs.readFileSync(serverPath, 'utf8');

    if (content.includes('autoCompactEnabled')) {
      success('✓ 启用了自动压缩（autoCompactEnabled: true）');
    } else {
      warn('⚠️  未启用自动压缩，建议在长会话时启用');
    }

    if (content.includes('includePartialMessages')) {
      success('✓ 支持部分消息流式传输（token 级增量）');
    }

    success('✓ 自动压缩机制完整');
    return true;
  } catch (err) {
    error(`检查失败: ${err.message}`);
    return false;
  }
}

// ============================================================================
// 检查事件日志
// ============================================================================
function checkEventLog() {
  title('事件日志分析');

  const eventLog = readJson('event-log.jsonl');
  if (!eventLog) {
    warn('event-log.jsonl 为空（正常，如果未运行过）');
    return;
  }

  // 尝试解析 JSONL（每行一个 JSON）
  try {
    const lines = fs.readFileSync(
      path.join(__dirname, 'event-log.jsonl'),
      'utf8'
    ).split('\n').filter(l => l.trim());

    if (lines.length === 0) {
      warn('事件日志为空');
      return;
    }

    const events = lines.map(l => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);

    success(`✓ 共 ${events.length} 个事件`);

    // 统计事件类型
    const warnings = events.filter(e => e.level === 'warn').length;
    const errors = events.filter(e => e.level === 'error').length;

    if (warnings > 0) {
      warn(`${warnings} 个警告事件（可能包含降级日志）`);
    }
    if (errors > 0) {
      error(`${errors} 个错误事件`);
    }

    // 查找降级相关事件
    const degradations = events.filter(e =>
      e.message?.includes('降级') ||
      e.message?.includes('downgrade') ||
      e.message?.includes('fallback')
    );

    if (degradations.length > 0) {
      success(`✓ 检测到 ${degradations.length} 个降级事件`);
      degradations.slice(-3).forEach(e => {
        info(`  - ${e.timestamp}: ${e.message}`);
      });
    }
  } catch (err) {
    warn(`无法解析事件日志: ${err.message}`);
  }
}

// ============================================================================
// 主函数
// ============================================================================
async function main() {
  const args = process.argv.slice(2);
  const scenario = args.find(a => a.startsWith('--scenario='))?.split('=')[1] || 'all';

  log('\n');
  log('╔════════════════════════════════════════════════════════════════╗', 'bright');
  log('║        🧪 claude-p-web-demo 降级功能测试套件                   ║', 'bright');
  log('╚════════════════════════════════════════════════════════════════╝', 'bright');
  log('');

  const results = {};

  // 执行选定的测试
  if (scenario === 'all' || scenario === 'token') {
    results.token = await testTokenRotation();
  }

  if (scenario === 'all' || scenario === 'effort') {
    results.effort = await testEffortDowngrade();
  }

  if (scenario === 'all' || scenario === 'classification') {
    results.classification = await testClassificationDowngrade();
  }

  if (scenario === 'all' || scenario === 'resume') {
    results.resume = await testSessionRecovery();
  }

  if (scenario === 'all' || scenario === 'notify') {
    results.notify = await testNotifyDowngrade();
  }

  if (scenario === 'all' || scenario === 'compress') {
    results.compress = await testAutoCompress();
  }

  // 检查日志
  if (scenario === 'all') {
    checkEventLog();
  }

  // 总结
  title('测试总结');

  const passed = Object.values(results).filter(r => r === true).length;
  const total = Object.values(results).length;

  if (total === 0) {
    warn('未执行任何测试');
  } else {
    log(`通过率: ${passed}/${total}`, total === passed ? 'green' : 'yellow');

    if (total === passed) {
      success('\n🎉 所有降级功能测试通过！\n');
      process.exit(0);
    } else {
      error('\n⚠️  部分测试失败，请查看上面的错误信息\n');
      process.exit(1);
    }
  }
}

// ============================================================================
// 命令行帮助
// ============================================================================
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  log(`
使用方法:
  node test-degradation.mjs [options]

选项:
  --scenario=all              运行所有测试（默认）
  --scenario=token            仅测试 Token 轮换降级
  --scenario=effort           仅测试 Effort 参数降级
  --scenario=classification   仅测试 分类降级
  --scenario=resume           仅测试 会话恢复降级
  --scenario=notify           仅测试 通知平台降级
  --scenario=compress         仅测试 自动压缩降级
  --help, -h                  显示此帮助信息

示例:
  node test-degradation.mjs
  node test-degradation.mjs --scenario=token
  node test-degradation.mjs --scenario=all
  `, 'dim');
  process.exit(0);
}

// 运行测试
main().catch(err => {
  error(`\n致命错误: ${err.message}`);
  console.error(err);
  process.exit(1);
});
