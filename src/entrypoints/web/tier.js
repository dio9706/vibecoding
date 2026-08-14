/** web 入口：任务档位判定（关键词快判 + Haiku 极速分类，自动选 model/effort 省额度） */
import { runClaude } from '../../integrations/claude.js';
import { claudeAuthOpts } from '../../features/token-rotation.js';

/** 关键词快速判档（省一次分类往返）；命中返回 {model,effort}，未命中返回 null */
export function quickTier(prompt) {
  const p = prompt.trim();
  if (p.length < 12 || /^(你好|您好|hi|hello|在吗|在么|谢谢|多谢|你是谁|介绍一下|自我介绍)/i.test(p))
    return { model: 'claude-haiku-4-5', effort: 'medium' };
  if (
    /(重构|refactor|架构|多个文件|整个项目|全项目|迁移|migrat|实现一个|开发|新增功能|修复|排查|debug|部署|设计方案)/i.test(
      p,
    )
  )
    return { model: 'claude-opus-4-8', effort: 'high' };
  return null;
}

/** 用 Haiku 极速判定任务档位 → 自动选 model/effort（省额度）；失败/超时降级 medium */
export async function classifyTier(prompt) {
  const quick = quickTier(prompt);
  if (quick) return quick;
  let out = '';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000); // 分类超时兜底，避免拖住发送
  try {
    await runClaude(prompt.slice(0, 800), {
      ...claudeAuthOpts(), // 判档也跟随备用账号轮换
      model: 'claude-haiku-4-5',
      permissionMode: 'default',
      persistSession: false, // 内部一次性调用不落盘——否则在左栏历史里生成与真会话同标题的伪会话，极易误点
      abortController: ac,
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      systemPrompt: {
        type: 'custom',
        custom:
          '你是任务档位分类器。只输出一个词：light / medium / heavy，不要任何解释。\n' +
          'light：闲聊、问候、无需读代码的简单问答。\n' +
          'medium：一般代码问题、小改动、单文件分析、常规任务。\n' +
          'heavy：复杂开发或重构、多文件排障、架构设计、长链路 agentic 任务。',
      },
      onText: (t) => (out += t),
      onResult: (i) => {
        if (!out && i.result) out = i.result;
      },
    });
  } catch {
    /* 超时/失败 → medium 兜底 */
  } finally {
    clearTimeout(timer);
  }
  const t = out.toLowerCase();
  if (t.includes('heavy')) return { model: 'claude-opus-4-8', effort: 'high' };
  if (t.includes('light')) return { model: 'claude-haiku-4-5', effort: 'medium' };
  return { model: 'claude-sonnet-4-6', effort: 'medium' };
}
