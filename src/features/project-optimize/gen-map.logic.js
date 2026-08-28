/**
 * 地图生成的纯逻辑：prompt 构造与产出质量闸。
 *
 * ## 质量闸为什么必须存在
 *
 * 这里的失败模式和 describe-skill.js 开头写的是同一个：写一份糊弄的地图，
 * M1/M2 不再报缺失、map 分数上涨，**而地图内容是错的**。分数变好、实际变差，
 * 没有任何自动信号能发现。而地图比 skill description 更糟一层——
 * description 写砸只是让一份规范唤不起来，地图写砸会**主动误导之后的每一次会话**。
 *
 * 所以判据是「宁可不生成」：闸没过就不写文件、进 blocked 列表让用户看到，
 * 而不是写一个半成品上去。
 */

/** 根地图行数上限，对齐 check-map.logic.js 的 M5 阈值——刚生成就超标等于用新问题换旧问题 */
const ROOT_MAX_LINES = 200;
/** 判「模型这次没写出东西」的最短长度：三个小节的地图不可能短于此 */
const MIN_MAP_LEN = 200;
/** 核对条目上限：超过这个数说明地图已经全面失效，该重写而不是打补丁，列再多也没人看 */
const MAX_FINDINGS = 20;

/**
 * 系统提示词。
 *
 * 「你只能读」这一句是只读沙箱的第 4 层（软约束）。前三层硬闸在
 * llm-readonly-agent.js 里，这里的作用是掐掉「我先写个文件试试」这个念头本身——
 * 模型每试一次都要吃掉一轮 maxTurns，而它注定会被 canUseTool 拒掉。
 */
export const MAP_SYSTEM_PROMPT = {
  type: 'custom',
  custom:
    '你在为一个代码仓库撰写 CLAUDE.md 项目地图。这份地图会被 AI 在每次会话开始时读取，'
    + '用来快速定位「要改的东西在哪」。\n'
    + '你只能读取文件（Read/Grep/Glob），禁止写入、修改或执行任何东西——'
    + '写入请求会被拒绝，白白浪费你的轮次。生成的内容通过你的最终回复交出去即可。\n'
    + '写作要求：具体、可验证、不写空话。宁可少写一条，也不要写你没有读到证据的内容。\n'
    + '只输出一个 JSON 对象，不要任何解释文字，不要 markdown 代码围栏。',
};

/** 两个生成 prompt 共用的收尾约定，避免重复（DRY） */
function jsonTail(field) {
  return [
    '',
    '## 输出格式',
    '',
    `严格输出一个 JSON 对象（${field} 是字段，不要直接输出字符串）：`,
    `{"${field}":"...完整的 markdown 正文..."}`,
    '注意 markdown 里的换行要写成 \\n，引号要转义。',
  ];
}

/**
 * 根地图 prompt。
 *
 * 三项必写内容直接对齐 check-map.logic.js 里 M1 的 fixHint
 * （「项目定位 + 常用命令 + 模块路由表」）——检测器说缺什么，生成端就补什么，
 * 两边对不上的话会出现「生成完了，体检还在报同一个问题」。
 */
export function buildRootMapPrompt(factText) {
  return [
    '请为这个仓库写一份根 `CLAUDE.md` 项目地图。',
    '',
    '下面「已知事实」是程序扫描出来的，**可以直接采信**。',
    '你还有 Read/Grep/Glob 工具，请用它们读关键入口文件，补充事实包里看不出来的部分——',
    '尤其是「这个项目是干什么的」和「改动通常从哪里下手」。',
    '',
    '## 必须包含的三部分',
    '',
    '1. **项目定位**：一两句话说清这个项目是什么、解决什么问题。',
    '2. **常用命令**：怎么跑、怎么测、怎么构建。命令要从事实包的 scripts 里取，不要杜撰。',
    '3. **模块路由表**：表格形式，列出主要模块目录及其职责，让人一眼看出「要改 X 该去哪个目录」。',
    '   已有模块地图的，路由表里要指向那份地图。',
    '',
    '## 硬约束',
    '',
    `- 总长度不超过 ${ROOT_MAX_LINES} 行。这是官方建议值，超了会挤占上下文并降低遵循度。`,
    '- 只写你有证据的内容。没读到的不要猜，宁可不写这一条。',
    '- 不要写「本文档介绍了……」这类摘要腔，直接给信息。',
    '- 引用文件/目录路径时用反引号包裹，且必须是真实存在的路径。',
    '- 忽略仓库根目录下的临时文件（`tmp-*`、一次性脚本），它们不是项目结构的一部分。',
    ...jsonTail('markdown'),
    '',
    '## 已知事实',
    '',
    factText || '（扫描未产出事实，请完全依靠工具自行探索）',
  ].join('\n');
}

/**
 * 模块地图 prompt。
 *
 * 三项必写内容对齐 check-map.logic.js 里 M2 的 fixHint
 * （「文件清单 + 关键流程 + 常见改动入口」）。
 *
 * 后两项是这份地图存在的全部理由：文件清单机器自己就能列，
 * 而「关键流程」和「改动入口」必须读懂代码才写得出来——
 * 这也正是本方案给模型只读工具、而不是纯事实包单轮生成的原因。
 */
export function buildModuleMapPrompt(moduleRel, factText) {
  return [
    `请为模块 \`${moduleRel}\` 写一份 \`CLAUDE.md\` 模块地图。`,
    '',
    '下面「已知事实」是程序扫描出来的，**可以直接采信**。',
    '文件清单和导出符号已经给全了，你要用 Read/Grep/Glob 去读代码，',
    '补出事实包里没有的那两部分——它们才是这份地图存在的理由。',
    '',
    '## 必须包含的三部分',
    '',
    '1. **文件清单**：每个文件一行，说清它负责什么。可以直接用事实包里的职责摘要。',
    '2. **关键流程**：这个模块的主要执行路径是什么，数据/控制从哪个文件流到哪个文件。',
    '   这一部分必须读代码才写得出来，不要拿文件清单敷衍。',
    '3. **常见改动入口**：想改 X 应该从哪个文件下手。用「要做……就改……」的句式。',
    '',
    '## 硬约束',
    '',
    '- 只写你有证据的内容。没读到的不要猜。',
    '- 引用文件路径时用反引号包裹，路径要相对模块目录或仓库根，且必须真实存在。',
    '- 不要复述代码，写代码里看不出来的判断（为什么这么分层、哪个文件是入口）。',
    ...jsonTail('markdown'),
    '',
    '## 已知事实',
    '',
    factText || '（扫描未产出事实，请完全依靠工具自行探索）',
  ].join('\n');
}

/**
 * 过期地图的差异核对 prompt。
 *
 * 反复强调「不要重写」是必要的：模型看到一份过期文档的本能就是给你一份新的。
 * 而 M3 的全部承诺就是不覆盖人写的内容——提示词这一层拦不住的话，
 * 就要靠调用方丢弃整个产出，白烧一次额度。
 */
export function buildStaleAuditPrompt(mapRel, mapBody, factText) {
  return [
    `\`${mapRel}\` 这份地图比代码旧。请核对它与当前代码的差异。`,
    '',
    '**你的任务只是列出差异，不是重写地图。**',
    '不要输出新版地图，不要给修改建议的完整文本——只列出「地图里写的和代码现状对不上」的具体条目。',
    '',
    '## 重点核对',
    '',
    '- 地图里提到的文件/目录，现在还存在吗？',
    '- 地图描述的流程，和代码里的实际调用顺序一致吗？',
    '- 模块里新增了重要文件，但地图没收录吗？',
    '',
    '## 硬约束',
    '',
    '- 每条差异一句话说清，带上具体文件路径（反引号包裹）。',
    '- 只报你用工具读过、确认过的差异。拿不准的不要写——',
    '  误报会让人去改一个本来正确的地方。',
    `- 最多 ${MAX_FINDINGS} 条。没发现差异就返回空数组，这是完全正常的结果。`,
    '',
    '## 输出格式',
    '',
    '严格输出一个 JSON 对象：',
    '{"findings":["第一条差异","第二条差异"]}',
    '',
    '## 地图当前内容',
    '',
    mapBody || '（地图为空）',
    '',
    '## 程序扫描出的模块现状',
    '',
    factText || '（扫描未产出事实）',
  ].join('\n');
}

/** 质量闸的统一失败构造 */
const bad = (reason) => ({ ok: false, reason });

/** 两个 validate 共用的基础检查：类型与长度 */
function baseCheck(md) {
  if (typeof md !== 'string') return bad('产出不是字符串');
  const text = md.trim();
  if (text.length < MIN_MAP_LEN) return bad(`产出过短（${text.length} 字符），判定为模型未按要求生成`);
  return null;
}

/**
 * 根地图质量闸。
 *
 * 小节判定用宽松的关键词匹配而不是严格的标题结构：模型可能写「## 怎么跑起来」
 * 而不是「## 常用命令」，语义对了就该放行。卡格式只会把合格产出误杀。
 */
export function validateRootMap(md) {
  const base = baseCheck(md);
  if (base) return base;
  const text = md.trim();

  const lines = text.split('\n').length;
  if (lines > ROOT_MAX_LINES) {
    return bad(`产出 ${lines} 行，超过 ${ROOT_MAX_LINES} 行上限（刚生成就会被体检判为 M5 超长）`);
  }
  if (!/命令|scripts|npm |yarn |pnpm |怎么跑|运行|启动|构建/i.test(text)) {
    return bad('产出缺少「常用命令」相关内容');
  }
  if (!/模块|目录|结构|路由|架构/.test(text)) {
    return bad('产出缺少「模块路由表」相关内容');
  }
  return { ok: true, reason: '' };
}

/**
 * 模块地图质量闸。
 *
 * 「关键流程 / 改动入口」是硬性要求：没有这两部分的模块地图就是 `ls` 的复述，
 * 而文件清单机器自己就能列——不值得为它花一次 LLM 调用，更不值得让它去
 * 消掉一条 M2 告警（消掉之后就再没人提醒这个模块缺真正有用的地图了）。
 */
export function validateModuleMap(md) {
  const base = baseCheck(md);
  if (base) return base;
  const text = md.trim();

  if (!/流程|调用|执行路径|数据流|时序/.test(text)) {
    return bad('产出缺少「关键流程」相关内容，只有文件清单的地图没有导航价值');
  }
  if (!/改动|修改|入口|要做|新增/.test(text)) {
    return bad('产出缺少「常见改动入口」相关内容');
  }
  return { ok: true, reason: '' };
}

/**
 * 核对结果的规整。
 *
 * 空数组是**合法**结果：核对过、确实没发现差异。把它判成失败会让
 * 「地图其实还准」这种好情况走进错误分支。
 *
 * @param {unknown} findings
 * @returns {{ok:boolean, findings:string[], reason:string}}
 */
export function validateStaleFindings(findings) {
  if (!Array.isArray(findings)) return { ok: false, findings: [], reason: 'findings 不是数组' };
  const list = findings
    .map((f) => String(f ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_FINDINGS);
  return { ok: true, findings: list, reason: '' };
}
