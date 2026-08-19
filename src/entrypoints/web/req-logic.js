/**
 * 需求工作流纯逻辑 —— prompt 构造 / 文档解析 / BUG 判决映射 / 档案拼装（单测目标，零 IO）。
 * 例外：verdictToBug 内部用 Date.now()/Math.random() 生成时间戳与随机 ID，非严格意义的纯函数
 * （相同输入不保证相同输出），但仍零 IO、零外部依赖。
 */

/** 工程键 → 中文角色标签；顺序即「第一个工程」的判定序（前端优先，无则后端）。 */
const PROJECT_LABELS = { frontend: '前端工程', backend: '后端工程' };

/**
 * 工程角色声明行，逐条 `- <角色>：<dir> 【开发工程】` / `【只读参考工程，禁止修改其中任何文件】`。
 * null 工程（未配置）直接跳过。
 */
export function projectRoleLines(projects) {
  if (!projects) return [];
  return Object.keys(PROJECT_LABELS)
    .map((key) => {
      const p = projects[key];
      if (!p) return null;
      const tag = p.dev ? '【开发工程】' : '【只读参考工程，禁止修改其中任何文件】';
      return `- ${PROJECT_LABELS[key]}：${p.dir} ${tag}`;
    })
    .filter(Boolean);
}

/**
 * 选取 AI 任务的 cwd 与 additionalDirectories：全篇「第一个工程」按 前端优先、无则后端 的顺序，
 * 其余已配置工程目录进 addDirs。仅有一个工程时 addDirs 为空数组；两个都未配置时 cwd 为 null。
 */
export function pickCwdAndDirs(projects) {
  const list = Object.keys(PROJECT_LABELS)
    .map((key) => projects && projects[key])
    .filter(Boolean);
  return {
    cwd: list.length ? list[0].dir : null,
    addDirs: list.slice(1).map((p) => p.dir),
  };
}

/** docgen/revise 共用的输出契约段：只输出 markdown，三节固定结构（新增功能模块标签节）。 */
function docOutputContract({ existingTags = [], currentTag = null } = {}) {
  const tagLine = existingTags.length
    ? `已有功能模块（从中选一个，或新建 2-4 字简短名称）：${existingTags.join('、')}`
    : `（暂无已有模块，请新建一个 2-4 字简短名称，如「宝宝辅食」「盘子需求」）`;
  const hint = currentTag ? `（当前已识别为「${currentTag}」，若无变化直接保持）` : '';
  return (
    `输出契约（严格遵守）：只输出 markdown 正文，不要任何解释性开场白。结构必须是——\n` +
    `## 一、说人话总结\n（用大白话概括要改什么、影响哪些地方，非技术人员能看懂）\n\n` +
    `## 二、详细设计\n（逐【开发工程】列出：新增 / 删除 / 更新 的文件与内容要点，精确到文件路径；只读参考工程仅作依据引用）\n\n` +
    `## 三、功能模块标签${hint}\n${tagLine}\n本需求所属功能模块：`
  );
}

/** 附件列表 → prompt 片段：非空才输出 `（附件：<name> → <path>、…，请先 Read）`，否则空串。 */
function attachmentsPart(files) {
  return (files || []).length
    ? `（附件：${files.map((f) => `${f.name} → ${f.path}`).join('、')}，请先 Read）`
    : '';
}

/** 补充说明列表 → prompt 片段：`<序号>. <text>（附件：<name> → <path>、…，请先 Read）`。 */
function supplementLines(supplements) {
  return supplements
    .map((s, i) => `${i + 1}. ${s.text}${attachmentsPart(s.files)}`)
    .join('\n');
}

/** 评审期 docgen prompt：需求文档全文 + 补充说明（按时间序）+ 工程角色表 + 输出契约。 */
export function buildDocgenPrompt({ reqDocText, supplements = [], projects, existingTags = [] }) {
  const sup = supplements.length
    ? `\n补充说明（按时间序，后者优先级更高）：\n${supplementLines(supplements)}\n`
    : '';
  return (
    `你是资深架构师，请阅读需求文档并实际查证下列工程后，产出一份开发文档。\n\n` +
    `工程角色（只读查证，本次不做任何修改）：\n${projectRoleLines(projects).join('\n')}\n\n` +
    `需求文档全文：\n「${reqDocText}」\n${sup}\n` +
    docOutputContract({ existingTags })
  );
}

/** 补充说明 → 增量修订 prompt：resume 同一 docgen session，在上一版基础上修订，输出契约同 docgen。 */
export function buildRevisePrompt({ supplement, existingTags = [], currentTag = null }) {
  const { text, files } = supplement || {};
  return (
    `用户对开发文档提出新的补充说明如下：\n「${text}」${attachmentsPart(files)}\n\n` +
    `请在你上一版开发文档基础上修订，输出完整新版文档。\n\n` +
    docOutputContract({ existingTags, currentTag })
  );
}

/** 从开发文档 markdown 中抽「说人话总结」节纯文本；解析失败（无该节）降级取前 300 字。 */
export function extractSummary(md) {
  const text = String(md ?? '');
  const m = text.match(/##\s*一、说人话总结\s*\n([\s\S]*?)(?:\n##\s|$)/);
  return m ? m[1].trim() : text.trim().slice(0, 300);
}

/**
 * 从 docgen/revise 输出文本中解析「## 三、功能模块标签」节的标签值。
 * 支持格式：`本需求所属功能模块：宝宝辅食` 或 `：「宝宝辅食」`。
 * 解析失败（无该节或格式异常）返回 null。
 */
export function parseFeatureTag(docText) {
  const m = String(docText ?? '').match(
    /##\s*三、功能模块标签[\s\S]*?\n本需求所属功能模块[：:]\s*([^\n]+)/,
  );
  if (!m) return null;
  // 移除各种引号和书名号
  const raw = m[1].trim().replace(/[`'"「」【】（）()]/g, '').trim();
  return raw || null;
}

/** 开发文档下一版本号：versions 空 → 1，否则 max(v)+1。 */
export function nextDocVersion(devDoc) {
  const versions = (devDoc && devDoc.versions) || [];
  return versions.length ? Math.max(...versions.map((v) => v.v)) + 1 : 1;
}

/**
 * 开发期首轮/续轮开发 prompt：工程角色表 + 开发文档路径 + 设计准则（非空才附）+
 * API 文档列表（非空才附）+ 开工指令。
 */
export function buildDevelopPrompt({ req, docPath }) {
  const parts = [
    `工程角色（本次开发遵守）：\n${projectRoleLines(req.projects).join('\n')}`,
    `开发文档路径：${docPath}（请先完整 Read）`,
  ];
  if (req.designGuidelines) {
    parts.push(`设计准则：\n${req.designGuidelines}`);
  }
  if ((req.apiDocs || []).length) {
    parts.push(`后端 API 文档：\n${req.apiDocs.map((d) => `- ${d.name} → ${d.path}`).join('\n')}`);
  }
  parts.push('请按开发文档开始本需求当前可进行的开发；只读参考工程禁止修改。');
  return parts.join('\n\n');
}

/** API 文档变更 → 对照修正 prompt；action ∈ 新增/更新/删除，非删除附路径引导 Read。 */
export function buildApiFixPrompt({ action, doc }) {
  const pathPart = action === '删除' ? '' : `（路径 ${doc.path}，请先 Read）`;
  return (
    `后端 API 文档「${doc.name}」已${action}${pathPart}\n\n` +
    `请对照该 API 文档变更，检查并修正本需求已实现代码中所有相关调用。`
  );
}

/** BUG 修复 prompt：标题 + 详情 + 只读工程约束。 */
export function buildBugFixPrompt({ bug }) {
  return (
    `修复以下 BUG：「${bug.title}」\n详情：\n${bug.detail}\n\n` +
    `修复后自查；只读参考工程禁止修改。`
  );
}

/**
 * 测试期评审判决 → bug 记录：fix → sure（自动入队修复，reason 清空）；
 * ask/reject → doubt（带 reason，等本人确认）。
 */
export function verdictToBug(record, { verdict, reason }) {
  const rand4 = Math.random().toString(36).slice(2, 6);
  return {
    id: 'b_' + Date.now().toString(36) + rand4,
    recordId: record.recordId,
    title: record.title,
    detail: record.detail,
    verdict: verdict === 'fix' ? 'sure' : 'doubt',
    reason: verdict === 'fix' ? '' : String(reason || ''),
    status: 'pending',
    at: new Date().toISOString(),
  };
}

/**
 * 合并新评审出的 bug 到既有列表：按 recordId 去重——已存在的记录保留原样（不覆盖状态），
 * 仅追加真正新增的 recordId；不修改入参数组。
 */
export function mergeBugs(oldBugs = [], incoming) {
  const existingIds = new Set(oldBugs.map((b) => b.recordId));
  return [...oldBugs, ...incoming.filter((b) => !existingIds.has(b.recordId))];
}

/**
 * 子会话轻量种子：需求基本信息 + 工程角色 + 开发文档 + 功能文件快照（有才注入）+ 设计准则。
 * 返回 300-500 token 左右的纯文本 prompt 前缀。
 * @param {object} req - 需求对象
 * @param {object} options - 选项对象
 * @param {object|null} options.featureSnapshot - 功能快照：{ tag: string, files: [{path, count}, ...] } | null
 */
export function buildSeedPrompt(req, { featureSnapshot = null } = {}) {
  const { cwd: reqCwd, addDirs } = pickCwdAndDirs(req.projects);
  const parts = [];

  // 需求基本信息
  const branchName = reqBranchName(req);
  parts.push(`【需求】${req.title} · 分支 ${branchName}`);

  // 工程角色（前端优先，后端次之）
  if (reqCwd) {
    const dirs = [reqCwd, ...addDirs];
    const roles = dirs
      .map((dir) => {
        const isBackend = req.projects?.backend && req.projects.backend.dir === dir;
        const isDev = isBackend ? req.projects.backend.dev : req.projects.frontend?.dev;
        const role = isDev ? '开发' : '只读参考，禁止修改';
        const label = dirTail(dir);
        return `【${isBackend ? '后端' : '前端'}】${label}（${role}）`;
      });
    parts.push(roles.join('\n'));
  }

  // 开发文档（若有最新版本）
  const latest = req.devDoc?.versions?.at(-1);
  if (latest) {
    parts.push(`【开发文档】${latest.path}（需要时自行 Read）`);
  }

  // 功能文件快照（有才注入）——基于历史 git diff 收割，频次越高置信度越强
  if (featureSnapshot?.files?.length) {
    const fileLines = featureSnapshot.files
      .map((f) => `- ${f.path}（出现 ${f.count} 次）`)
      .join('\n');
    parts.push(
      `【功能快照·${featureSnapshot.tag}】基于历史开发记录，本功能模块涉及以下文件（按改动频次排序）：\n${fileLines}\n\n` +
        `开发规范：先读快照文件定位实现，范围不足时再局部探索；禁止全局 glob/grep 扫整个工程。` +
        `若快照中有文件不存在，请在首条回复标注「[快照过期]」并说明变动文件。`,
    );
  }

  // 设计准则（非空才附）
  if (req.designGuidelines) {
    parts.push(`【设计准则】\n${req.designGuidelines}`);
  }

  // 末尾导语
  parts.push('避坑清单已由仓库 CLAUDE.md 引入，启动时自动加载。请按上下文开展工作。');

  return parts.join('\n\n');
}

/**
 * 从 Claude 回答中提取 `<!-- PITFALLS-BEGIN/END -->` 块（含注释）；
 * 无匹配块返回 null。
 */
export function extractPitfalls(text) {
  if (!text) return null;
  const match = text.match(/<!--\s*PITFALLS-BEGIN\s*-->([\s\S]*?)<!--\s*PITFALLS-END\s*-->/);
  return match ? match[0] : null;
}

/**
 * 将避坑清单块按 [前端]/[后端] 前缀分流为两个数组。
 * 输入为 extractPitfalls 的返回值（整个注释块），返回 { frontend: [], backend: [] }。
 */
export function splitPitfallsByProject(pitfallsBlock) {
  if (!pitfallsBlock) return { frontend: [], backend: [] };
  const lines = pitfallsBlock
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'));

  const frontend = [];
  const backend = [];

  for (const line of lines) {
    const content = line.replace(/^-\s*/, '');
    if (content.startsWith('[前端]')) {
      frontend.push(content.replace(/^\[前端\]\s*/, ''));
    } else if (content.startsWith('[后端]')) {
      backend.push(content.replace(/^\[后端\]\s*/, ''));
    }
  }

  return { frontend, backend };
}

/**
 * 去重合并两个避坑清单数组：新条目只在首 20 字不重复时才追加。
 * 超 30 条时截断：倒数第 3 条位置插入截断标记，返回 { items, truncated, removed }。
 */
export function mergePitfalls(existing = [], incoming = []) {
  const LIMIT = 30;
  const combined = [...existing];
  const seen = new Set(existing.map((item) => item.slice(0, 20)));

  let added = 0;
  for (const item of incoming) {
    const key = item.slice(0, 20);
    if (!seen.has(key)) {
      combined.push(item);
      seen.add(key);
      added++;
    }
  }

  let truncated = false;
  let removed = 0;
  if (combined.length > LIMIT) {
    const truncIdx = LIMIT - 2;
    combined[truncIdx] = '…（已超限，更多清单见完整报告）…';
    removed = combined.length - LIMIT;
    combined.length = LIMIT;
    truncated = true;
  }

  return { items: combined, truncated, removed };
}

/**
 * 目录尾部标签：C:/foo/bar/baz → baz；C:\foo\bar\baz → baz。
 * 用于工程角色行的简化显示。
 */
function dirTail(dir) {
  return dir.split(/[/\\]/).filter(Boolean).pop() || dir;
}

/** 需求分支名：req/<id 去 r_ 前缀>-<title 中文/字母数字片段拼接，截 20 字符，空则 task>。 */
export function reqBranchName(req) {
  const idPart = req.id.replace(/^r_/, '');
  const segments = (req.title || '').match(/[A-Za-z0-9一-龥]+/g) || [];
  const slug = segments.join('-').slice(0, 20) || 'task';
  return `req/${idPart}-${slug}`;
}

/**
 * 归档摘要 markdown：开发文档终稿版次、逐分支提交摘要（git 失败降级占位）、
 * BUG 修复统计与清单、用户备注。
 *
 * branchLogs 按 dir 索引（而非 branch）：finalize 定稿时多工程共用同一 branch 字符串
 * （前后端各自仓库里建同名分支，见 finalizeRequirement 头注释），若按 branch 建 Map，
 * 双工程场景下后写入的那条会把先写入的覆盖掉，档案里两个工程会显示同一份提交摘要。
 * dir 在同一需求内对每个工程唯一，天然避免这个碰撞。
 */
export function buildArchiveSummary({ req, note, branchLogs = [] }) {
  const versions = (req.devDoc && req.devDoc.versions) || [];
  const finalVersion = versions.length ? Math.max(...versions.map((v) => v.v)) : 0;
  const finalDocPath = versions.at(-1)?.path || '（无路径记录）'; // spec §5.5：档案须留终稿文件的引用路径，供日后查阅原文
  const branches = req.branches || [];
  const bugs = req.bugs || [];
  const logByDir = new Map(branchLogs.map((b) => [b.dir, b.log]));
  const countByStatus = (status) => bugs.filter((b) => b.status === status).length;

  const branchLines = branches.map((b) => {
    const log = logByDir.get(b.dir);
    const body = log ? '\n```\n' + log + '\n```' : '\n（无法读取提交摘要）'; // 契约已收敛 string|null，无需再判 Array
    return `- ${b.dir} 分支 ${b.branch}（基线 ${b.baseBranch}）${body}`;
  });

  const bugLines = bugs.map((b) => `- [${b.status}] ${b.title}`);

  return [
    `# 需求档案：${req.title}`,
    '',
    `## 开发文档（终稿 v${finalVersion}）`,
    '',
    `终稿引用：${finalDocPath}`,
    '',
    '## 分支改动',
    branchLines.join('\n'),
    '',
    '## BUG 处理',
    `修复 ${countByStatus('fixed')} · 忽略 ${countByStatus('ignored')} · 失败 ${countByStatus('failed')}`,
    bugLines.join('\n'),
    '',
    '## 备注',
    note || '（无）',
  ].join('\n');
}

/**
 * 优化汇总 map 阶段提示词：根据会话转录生成小结提示。
 * @param {object} session - 会话元数据 {title, kind, sessionId, ...}
 * @param {array} messages - 转录消息数组 [{role, content}, ...]
 * @returns {string} map 阶段的提示词字符串
 */
export function buildRetroMapPrompt(session, messages) {
  // 将转录消息格式化为纯文本对话
  let text = (messages || []).map((m) => `${m.role}: ${m.content}`).join('\n\n');

  // 截断保护：超过 30000 字符时首尾各取 15000
  const LIMIT = 30000;
  if (text.length > LIMIT) {
    const half = Math.floor(LIMIT / 2);
    text =
      text.slice(0, half) +
      `\n\n…（已截断 ${text.length - LIMIT} 字符）…\n\n` +
      text.slice(-half);
  }

  return (
    `【会话 ${session.title || '未命名'}】\n` +
    `以下是该会话的完整对话记录，请简要小结 AI 做了什么、踩过什么坑、用户如何纠正。\n` +
    `不要展开细节，仅 2-3 句，不含 PITFALLS 块。\n\n` +
    text
  );
}

/**
 * 优化汇总 reduce 阶段提示词：汇总所有会话，识别跨会话反复错误。
 * @param {array} mapMessages - map 阶段生成的回答数组，每项 {role, content}
 * @returns {string} reduce 阶段的提示词字符串
 */
export function buildRetroReducePrompt(mapMessages) {
  // 将 map 阶段的消息逐条列出
  const summaries = (mapMessages || [])
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content)
    .join('\n\n---\n\n');

  return (
    `上述多个会话的开发过程你已逐一回顾。\n\n` +
    `请重点识别 **跨会话反复出现的错误**（出现 2 次以上）。只出现一次的可能是偶然，忽略。\n\n` +
    `汇总内容：\n${summaries}\n\n` +
    `以下格式输出规则清单（必须包含标记块）：\n\n` +
    `<!-- PITFALLS-BEGIN -->\n` +
    `- [前端] 具体规则，含定位（例如文件名/行号）\n` +
    `- [后端] 具体规则，含定位\n` +
    `<!-- PITFALLS-END -->`
  );
}
