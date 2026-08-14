/**
 * 评审门纯逻辑 —— AI 只打分，判决矩阵在此（可单测）。
 * 反偏置设计：默认保守（不确定一律 ask）、bug 未定位不自动修、
 * 需求收益不抵复杂度转询问、非本项目直接拒绝；prompt 强制先写反方论证。
 */

export const CONFIDENCE_MIN = 0.6;

/**
 * 判决矩阵：评审打分 → verdict。
 * @param {object|null} r 评审 JSON（parseReviewJson 产出）
 * @returns {{ verdict: 'reject'|'ask'|'fix'|'plan', reason: string }}
 *   reject=拒绝并回复理由；ask=质疑并二次询问；fix=BUG 直接自动修；plan=需求生成方案
 */
export function decideVerdict(r) {
  if (!r || typeof r !== 'object') {
    return { verdict: 'ask', reason: '评审输出无法解析，需人工确认' };
  }
  if (!r.belongs || !String(r.evidence || '').trim()) {
    return { verdict: 'reject', reason: String(r.reasons || '').trim() || '不属于本项目职责范围或未找到对应代码依据' };
  }
  const conf = Number(r.confidence);
  if (!(conf >= CONFIDENCE_MIN)) {
    return { verdict: 'ask', reason: String(r.reasons || '').trim() || '评审置信度不足，需人工确认' };
  }
  if (r.type === 'bug') {
    if (r.located) return { verdict: 'fix', reason: String(r.reasons || '').trim() };
    return { verdict: 'ask', reason: '未能定位到具体原因（文件/逻辑），不宜自动修复，需人工确认' };
  }
  const benefit = Number(r.benefit);
  const complexity = Number(r.complexity);
  if (!Number.isFinite(benefit) || !Number.isFinite(complexity)) {
    return { verdict: 'ask', reason: '复杂度/收益打分缺失，需人工确认' };
  }
  if (benefit - complexity >= 0) return { verdict: 'plan', reason: String(r.reasons || '').trim() };
  return {
    verdict: 'ask',
    reason: `实现复杂度(${complexity}/5)高于预期收益(${benefit}/5)，不建议修改${r.counterArgument ? '：' + r.counterArgument : ''}`,
  };
}

/** 从模型输出提取最后一个 JSON 对象（括号配平截取，从后往前尝试）；失败返回 null（decideVerdict 会落 ask） */
export function parseReviewJson(text) {
  const s = String(text || '');
  const starts = [];
  for (let i = 0; i < s.length; i++) if (s[i] === '{') starts.push(i);
  for (let k = starts.length - 1; k >= 0; k--) {
    let depth = 0;
    for (let i = starts[k]; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') {
        depth--;
        if (depth === 0) {
          try {
            const j = JSON.parse(s.slice(starts[k], i + 1));
            if (j && typeof j === 'object') return j;
          } catch {
            /* 该候选不合法，试更前面的起点 */
          }
          break;
        }
      }
    }
  }
  return null;
}

/** 构造评审 prompt：守门人立场 + 强制反方论证 + 历史判例校准 + 单行 JSON 输出 */
export function buildReviewPrompt(task, { projectDir, projectNotes, precedents = [] } = {}) {
  const isBug = task.type === 'bug';
  const precedentBlock = precedents.length
    ? `\n历史判例（人工最终裁定，用于校准你的打分尺度——人工推翻你的判决说明当时打分有偏差）：\n` +
      precedents.map((e) => `- [${e.type === 'bug' ? '故障' : '需求'}]「${e.title}」AI 判 ${e.verdict}，人工最终裁定：${e.override === 'proceed' ? '要求修改' : e.override}`).join('\n') +
      '\n'
    : '';
  return (
    `你是严格的技术评审守门人，评审一条用户提交的${isBug ? '故障报告' : '需求'}是否应该被处理。\n` +
    `你的立场：默认怀疑。轻率接受一条不该做的提交，比拒绝一条该做的提交代价更大。不合理的提交必须被拒绝或质疑。\n\n` +
    `用户提交：「${task.detail}」\n\n` +
    `请在当前工程中实际查证（只读，不修改任何文件）后评审。\n` +
    (projectNotes ? `工程说明（参考）：\n${projectNotes}\n\n` : '') +
    `评审要求：\n` +
    `1. 先写「反方论证」：认真论证为什么这条提交应该被拒绝（不属于本项目/描述不清无法查证/收益低/风险高/已有等价实现等），不许敷衍。\n` +
    `2. belongs：该提交是否属于本工程（${projectDir || '当前目录'}）的职责范围？必须在代码中找到对应模块/功能作为 evidence，找不到就是 false。\n` +
    (isBug
      ? `3. 故障必须定位到具体原因（文件/函数/逻辑链）才算 located=true；只能猜测、无法在代码中证实 → located=false。\n`
      : `3. 需求评估实现复杂度 complexity（1-5，5=牵涉面极广）与业务收益 benefit（1-5，5=极高收益）。改动大而受益面小的需求必须打低 benefit。\n`) +
    `4. confidence：你对以上判断的把握（0-1），查证不充分就打低。\n` +
    precedentBlock +
    `\n最终回复只输出一行 JSON，不要任何其他文字：\n` +
    `{"belongs":true|false,"evidence":"代码依据","type":"${isBug ? 'bug' : 'feature'}","located":true|false,"locatedAt":"文件/原因（未定位留空）","complexity":1,"benefit":1,"risk":1,"confidence":0.0,"counterArgument":"反方论证摘要","reasons":"给用户看的一句话结论理由"}`
  );
}
