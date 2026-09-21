/**
 * 前后端归属判定的纯函数 —— prompt 构造 / 输出解析 / 后端人选解析 / 人员字段补丁。
 *
 * 判定本身是独立于 reviewTask 的第二次只读调用（review/index.js 已两轮过审保持稳定，
 * 且它的判决矩阵是 feedback / task-triage 共用的资源，为巡检一条支线改它不划算）。
 *
 * 这里的铁律：**判不准一律 unknown**。unknown 会按前端自动修（改在任务分支上，
 * 人工 review 前进不了主干），而误判成 backend 会去打扰真实同事——后者代价高得多。
 */

/** 合法 side 白名单：模型输出任何其它值都当 unknown */
const SIDES = new Set(['frontend', 'backend', 'unknown']);

/**
 * 合法 blocked 白名单。空串 = 不拦截，照常自动修。
 * 非法值一律归空——与 side 的「判不准落 unknown」同向：这里的保守方向是**不拦截**，
 * 误拦会让一条本可自动修的 BUG 白白躺回人工队列。
 */
const BLOCKED = new Set(['', 'need-assets']);

/** 缺图判据（两个 prompt 共用，改口径只改这一处） */
const ASSET_RULE =
  `另外判断一件事：这条 BUG 是否要求**新增或替换 UI 图片资源**（图标 / 插画 / banner / 背景图等），\n` +
  `而该资源**既不在记录附件里、也不存在于代码库中**——这种情况 AI 修不了（只会编造一个占位路径），\n` +
  `必须交人工。是则 blocked 填 "need-assets"，并在 blockReason 里用一句话说清缺的是什么图。\n` +
  `⚠️ 能用现有资源完成的、纯样式/布局调整的、纯逻辑修复的，一律不算，blocked 留空字符串。\n`;

/** 构造归属判定 prompt。advice 是给人看的，所以明确禁止贴代码/堆栈/空话 */
export function buildSidePrompt(record, { frontendDir, backendDir } = {}) {
  return (
    `你要判断一个 BUG 属于前端还是后端。请在代码中实际查证（只读，不修改任何文件）后作答。\n\n` +
    `前端工程：${frontendDir || '（未配置）'}\n` +
    `后端工程：${backendDir || '（未配置）'}\n\n` +
    `BUG 标题：${record?.title || ''}\n` +
    `BUG 详情：${record?.detail || ''}\n\n` +
    `判定要求：\n` +
    `1. 必须在代码里找到依据才能下结论，写进 evidence（文件/函数/逻辑链）。\n` +
    `2. 只要有一点拿不准，就填 unknown —— 误判成 backend 会去打扰真实同事，代价很高。\n` +
    `3. side=backend 时必须写 advice：给后端同事看的处理建议。要求简短、口语、**一两句话说清**，\n` +
    `   讲现象和怀疑方向即可，不要贴代码、不要贴堆栈、不要写「建议排查」这类空话。\n` +
    `   例：「接口返回的 total 和实际条数对不上，前端只是照着渲染。建议查一下分页 SQL 的 count 语句。」\n\n` +
    ASSET_RULE +
    `\n最终回复只输出一行 JSON，不要任何其他文字：\n` +
    `{"side":"frontend|backend|unknown","evidence":"代码依据","advice":"给后端的人话建议（side=backend 时必填）","blocked":"need-assets 或空字符串","blockReason":"缺什么图（blocked 非空时必填）"}`
  );
}

/**
 * 精简 prompt：**只判缺不缺图，不判前后端**。
 *
 * 用在「没关联测试期需求 / 前后端目录没配全」的巡检上——那些场景下前后端归属本就判不了
 * （只有一个工程目录可查），但缺图这件事照样要拦，否则 AI 会拿占位图硬做一版 UI。
 */
export function buildAssetOnlyPrompt(record, { frontendDir } = {}) {
  return (
    `你要判断一个 BUG 能否由 AI 自动修复。请在代码中实际查证（只读，不修改任何文件）后作答。\n\n` +
    `前端工程：${frontendDir || '（未配置）'}\n\n` +
    `BUG 标题：${record?.title || ''}\n` +
    `BUG 详情：${record?.detail || ''}\n\n` +
    ASSET_RULE +
    `\n最终回复只输出一行 JSON，不要任何其他文字：\n` +
    `{"blocked":"need-assets 或空字符串","blockReason":"缺什么图（blocked 非空时必填）"}`
  );
}

/**
 * 解析模型输出（括号配平从后往前找最后一个合法 JSON，同 review/logic.js#parseReviewJson 思路：
 * 模型常在思考里先写一版再给最终答案，取最后一个才是结论）。
 *
 * 任何解析失败或非法 side 都落 unknown，**绝不抛错**——这是无人值守链路，抛错会中断整轮。
 */
export function parseSideJson(text) {
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
            if (j && typeof j === 'object') {
              return {
                side: SIDES.has(j.side) ? j.side : 'unknown',
                evidence: typeof j.evidence === 'string' ? j.evidence : '',
                advice: typeof j.advice === 'string' ? j.advice : '',
                blocked: BLOCKED.has(j.blocked) ? j.blocked : '',
                blockReason: typeof j.blockReason === 'string' ? j.blockReason : '',
              };
            }
          } catch {
            /* 该候选不合法，试更前面的起点 */
          }
          break;
        }
      }
    }
  }
  return { side: 'unknown', evidence: '', advice: '', blocked: '', blockReason: '' };
}

/**
 * 解析要转派给谁：**需求指派的全部后端**（用户拍板：需求里配了几位就同时 @ 几位，
 * 不挑一个代表——漏 @ 的那位可能正是真正负责这块的人）。
 *
 * 「有 feishuOpenId」是可用的前提：没 open_id 既 @ 不到人也写不进表格人员字段，
 * 所以指派名单里没配号的那位直接跳过，而不是让整次转派失败。
 *
 * 回退策略（刻意保守）：需求的 assignees 里一个可用后端都没有时，
 * **只有全局名册恰好只有一位后端**才回退用它（无歧义）；名册里有多位后端却无从
 * 判断该找谁时**宁可不 @**，降级为「仅移除我」并在汇报里说明。
 * 理由：名册里随便挑一个 @，是在打扰一个可能跟这条 BUG 毫无关系的人。
 *
 * @param {{ assignees?: string[], colleagues?: Array }} p colleagues 传 getColleagues() 全量
 * @returns {Array<{ openId: string, name: string }>} 空数组 = 拿不到，调用方降级为仅移除我
 */
export function resolveBackendAssignees({ assignees = [], colleagues = [] } = {}) {
  const list = Array.isArray(colleagues) ? colleagues : [];
  const ids = new Set(Array.isArray(assignees) ? assignees : []);
  const usable = (c) => c?.role === 'backend' && typeof c.feishuOpenId === 'string' && c.feishuOpenId;
  const pick = (c) => ({ openId: c.feishuOpenId, name: c.name || '后端' });

  const fromReq = list.filter((c) => ids.has(c?.id) && usable(c));
  if (fromReq.length) return fromReq.map(pick);

  const allBackend = list.filter(usable);
  return allBackend.length === 1 ? allBackend.map(pick) : [];
}

/**
 * 构造人员字段的新值：移除我 + 追加后端们（去重），**保留其他原有成员**。
 *
 * 只把自己摘出去，不替别人做指派决定——表里可能本来就挂着测试、产品等人，
 * 把他们一起清掉是在改别人的数据。
 *
 * 输出只保留 id 字段：bitable 人员字段写入接受 [{id}]，多余键（name/en_name）没必要带。
 *
 * @param {Array} current 人员字段当前值
 * @param {string} myOpenId 要移除的人（我）
 * @param {string[]} backendOpenIds 要追加的后端 open_id 列表（空数组 = 只移除我）
 * @returns {Array<{id:string}>} 直接作为 updateBitableRecord 的人员字段值
 */
export function buildAssigneePatch(current, myOpenId, backendOpenIds = []) {
  const kept = (Array.isArray(current) ? current : [])
    .filter((u) => u?.id && u.id !== myOpenId)
    .map((u) => ({ id: u.id }));
  for (const id of Array.isArray(backendOpenIds) ? backendOpenIds : []) {
    if (id && !kept.some((u) => u.id === id)) kept.push({ id });
  }
  return kept;
}
