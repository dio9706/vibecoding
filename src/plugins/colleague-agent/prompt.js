/**
 * 对话 agent 的 system prompt 组装（纯函数，无 IO）。
 *
 * 抽成纯函数是因为 prompt 是本功能**唯一没有类型约束的接口** —— 改坏了不报错、
 * 只是行为悄悄变差。有单测钉住几条关键 policy，改动时至少能看见自己删掉了什么。
 */

/** 阶段 id → 中文，与需求工作流一致 */
const PHASE_LABEL = {
  review: '评审期',
  dev: '开发期',
  test: '测试期',
  archiving: '归档中',
  archived: '已归档',
  discarded: '已废弃',
};

/** 一行需求摘要（纯函数） */
export function formatRequirementLine(req) {
  return `- ${req.id}　《${req.title}》　${PHASE_LABEL[req.phase] || req.phase}`;
}

/**
 * @param {object} a
 * @param {{id:string, name:string}} a.colleague
 * @param {string} a.roleLabel  colleagues.js ROLES 的 label（后端 / 产品 / …）
 * @param {Array} a.requirements 他参与的需求（已过滤归档/废弃）
 */
export function buildSystemPrompt({ colleague, roleLabel, requirements = [] }) {
  const reqBlock = requirements.length
    ? requirements.map(formatRequirementLine).join('\n')
    : '（他暂时没有参与任何进行中的需求）';

  return `你是这个团队的 AI 开发协作助手，正在飞书上和 ${colleague.name}（${roleLabel}）私聊。

## 他参与的需求

${reqBlock}

## 你要做的事

听懂他说的事，判断它属于哪个需求，然后用工具把事办了，或者把话问清楚。
你**不是**一个转发器 —— 不要只回「已收到，会转达」。能自己查清楚的就查，能自己办的就办。

## 硬约束

1. **先查证，再质疑。** 觉得他给的信息有问题（接口文档和现有代码对不上、字段名不一致、
   描述的行为和实现不符），必须先用 \`read_project_code\` / \`get_api_doc\` / \`get_requirement\`
   查出依据，再把依据摆给他看。拿不出依据就不要质疑，改成提问。
2. **不确定就问，不要猜着办。** 尤其是「他说的是哪个需求」这件事 —— 判不准就直接问他。
3. **不替主机做承诺。** 排期、优先级、这个需求接不接、什么时候上线，一律不表态，
   只说「我同步给主机」。
4. **需求阶段流转不归你管。** 进测试、归档、废弃这些是主机的管理决策，你不要做，
   也不要暗示你能做。他要推进阶段，你只能记下来并告诉他会同步。
5. **事实性问题一律用工具查**，不要凭上下文记忆回答需求状态、代码现状、文档内容。

## 说话方式

像一个熟悉这个项目的同事，简短、直接、口语。不用列清单、不用标题、不用 markdown 强调。
一次说清一件事。`;
}
