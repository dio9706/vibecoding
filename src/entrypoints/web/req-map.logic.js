/**
 * 需求地图纯逻辑 —— LLM 输出解析 / 地图规范化 / 修订 prompt 构造（单测目标，零 IO）。
 *
 * 地图是「页面=节点、逻辑点挂节点内、连线=页面跳转」的流程图。坐标不在这里算，
 * 也不让 LLM 出——见 spec §3.1，坐标由前端 req-map-layout.logic.js 分层布局算出来。
 */

import { jsonrepair } from 'jsonrepair';

/** 逻辑点类型别名归一：模型中英夹杂是常态，非法值一律落到 mod（宁可标成「修改」也不丢点）。 */
const TYPE_ALIAS = {
  add: 'add', new: 'add', create: 'add', 新增: 'add', 增加: 'add',
  mod: 'mod', update: 'mod', change: 'mod', modify: 'mod', 修改: 'mod', 更新: 'mod',
  del: 'del', delete: 'del', remove: 'del', 删除: 'del', 移除: 'del',
};

const TYPE_CN = { add: '新增', mod: '修改', del: '删除' };

const PAGE_STATES = ['new', 'changed', 'untouched'];

// 重新生成 prompt 的各段上限：改动文件清单在大需求上能到几百条，不设限会把 prompt 撑爆
const REGEN_MAX_FILES = 200;
const REGEN_MAX_CHANGES = 20;
const REGEN_CHANGE_CHARS = 300;
const REGEN_MAX_PAGES = 100;

/**
 * 宽松 JSON 解析：模型极爱把 JSON 裹进 ```json 围栏，或在前后加「好的，结果如下」这类客套话。
 * 依次尝试：直接 parse → 剥围栏 → 截取首个 {/[ 到末个 }/]。全失败时抛错并带原文前 200 字，
 * 好让 history 里留下能判断的线索（而不是一句「解析失败」）。
 */
export function parseJsonLoose(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('模型输出为空，无法解析 JSON');

  try {
    return JSON.parse(raw);
  } catch {
    /* 继续兜底 */
  }

  const stripped = raw
    .replace(/^```(?:json|JSON)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    /* 继续兜底 */
  }

  const oi = stripped.indexOf('{');
  const ai = stripped.indexOf('[');
  let start = -1;
  let closer = '';
  if (oi >= 0 && (ai < 0 || oi < ai)) {
    start = oi;
    closer = '}';
  } else if (ai >= 0) {
    start = ai;
    closer = ']';
  }
  const end = start >= 0 ? stripped.lastIndexOf(closer) : -1;
  if (start < 0 || end <= start) {
    throw new Error(`未能从模型输出中解析出 JSON：${raw.slice(0, 200)}`);
  }
  const candidate = stripped.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    /* 继续 jsonrepair 兜底 */
  }

  // 第四层：jsonrepair 专门处理 LLM 常见 JSON 破损（未转义引号、尾逗号、截断等）
  try {
    return JSON.parse(jsonrepair(candidate));
  } catch (e) {
    throw new Error(`JSON 解析失败（${e.message}）：${raw.slice(0, 200)}`);
  }
}

/** id 去重：已占用时追加 -2/-3…，保证同一张地图内唯一。 */
function uniqueId(want, used) {
  let id = want;
  let n = 2;
  while (used.has(id)) id = `${want}-${n++}`;
  used.add(id);
  return id;
}

/** 任意值 → 字符串数组：字符串包成单元素数组，数组逐项转字符串并丢空，其余归空数组。 */
function toStrList(v) {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? '').trim()).filter(Boolean);
}

function normalizePoints(raw, pageId, usedPointIds) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach((p, i) => {
    const title = String(p?.title ?? '').trim();
    if (!title) return; // 无标题的点在图上没法显示，也没法标注，直接丢
    const type = TYPE_ALIAS[String(p?.type ?? '').trim().toLowerCase()] || TYPE_ALIAS[String(p?.type ?? '').trim()] || 'mod';
    const id = uniqueId(String(p?.id ?? '').trim() || `${pageId}_${i + 1}`, usedPointIds);
    out.push({
      id,
      type,
      title,
      before: String(p?.before ?? '').trim() || '—',
      after: String(p?.after ?? '').trim() || '—',
      src: toStrList(p?.src),
      files: toStrList(p?.files),
    });
  });
  return out;
}

/**
 * LLM 原始输出 → 规范地图。永不抛错（非法输入退化为空地图），保证解析失败不会连带打挂调用方。
 *
 * @param {object} raw - 模型产出的 { pages, edges }
 * @param {object} [opts]
 * @param {object|null} [opts.prev] - 上一版地图。修订会全量重出 pages，用户挂过的设计稿
 *   （figma/restoredAt）必须**按页面名**回迁，否则每修订一次就把设计稿丢一次。
 */
export function normalizeMap(raw, { prev = null } = {}) {
  const pagesIn = Array.isArray(raw?.pages) ? raw.pages : [];
  const usedPageIds = new Set();
  const usedPointIds = new Set();
  const prevByName = new Map((prev?.pages || []).map((p) => [p.name, p]));

  const pages = [];
  pagesIn.forEach((p) => {
    const name = String(p?.name ?? '').trim();
    if (!name) return; // 无名页面在图上是个空盒子，没有意义
    const id = uniqueId(String(p?.id ?? '').trim() || `p${pages.length + 1}`, usedPageIds);
    const points = normalizePoints(p?.points, id, usedPointIds);
    const declared = String(p?.state ?? '').trim();
    const state = PAGE_STATES.includes(declared) ? declared : points.length ? 'changed' : 'untouched';
    const old = prevByName.get(name);
    pages.push({
      id,
      name,
      file: String(p?.file ?? '').trim(),
      state,
      figma: old?.figma ?? null,
      restoredAt: old?.restoredAt ?? null,
      points,
    });
  });

  // 边端点解析：契约要求 LLM 用页面 name（见 mapOutputContract），而 id 是本地自动编号。
  // 此处曾只按 id 校验，导致所有边被静默丢弃、画布上一条线都没有。历史数据和偶尔跑偏的
  // 模型会给 id，所以 name 优先、id 兜底；落盘统一存 id，布局层/渲染层口径才不用分叉。
  const pageIds = new Set(pages.map((p) => p.id));
  const idByName = new Map();
  for (const p of pages) if (!idByName.has(p.name)) idByName.set(p.name, p.id); // 同名取首个
  const resolveEnd = (v) => {
    const s = String(v ?? '').trim();
    if (!s) return '';
    return idByName.get(s) || (pageIds.has(s) ? s : '');
  };

  const seenEdges = new Set();
  const edges = [];
  for (const e of Array.isArray(raw?.edges) ? raw.edges : []) {
    const from = resolveEnd(e?.from);
    const to = resolveEnd(e?.to);
    if (!from || !to || from === to) continue;
    // 去重键用解析后的 id：同一对页面一次用 name 一次用 id，不能在画布上画出重影
    const k = `${from}>${to}`;
    if (seenEdges.has(k)) continue;
    seenEdges.add(k);
    edges.push({ from, to, label: String(e?.label ?? '').trim() });
  }

  const annots = raw?.annots && typeof raw.annots === 'object' && !Array.isArray(raw.annots) ? raw.annots : {};
  return { pages, edges, annots };
}

/** 地图下一版本号：versions 空 → 1，否则 max(v)+1（与 nextDocVersion 同范式）。 */
export function nextMapVersion(reqMap) {
  const versions = (reqMap && reqMap.versions) || [];
  return versions.length ? Math.max(...versions.map((v) => v.v)) + 1 : 1;
}

/** 地图 JSON 输出契约：两处独立生成/修订共用，改格式只改这一处。 */
function mapOutputContract() {
  return (
    `输出契约（严格遵守）：只输出一个 JSON 对象，不要代码围栏，不要任何解释性文字。结构必须是——\n` +
    `{\n` +
    `  "pages": [{\n` +
    `    "name": "页面中文名（用户能认出来的那个名字，不是文件名）",\n` +
    `    "file": "相对工程根的文件路径",\n` +
    `    "state": "new | changed | untouched",\n` +
    `    "points": [{\n` +
    `      "type": "add | mod | del",\n` +
    `      "title": "逻辑点名称，8-15 字",\n` +
    `      "before": "变更前是什么样（新增点填「—」）",\n` +
    `      "after": "变更后是什么样（删除点写清删掉什么、有什么连带影响）",\n` +
    `      "src": ["依据来源，如 需求文档 3.2 / 问卷 Q1 / 代码扫描"],\n` +
    `      "files": ["精确到 文件:行号 的影响位置"]\n` +
    `    }]\n` +
    `  }],\n` +
    `  "edges": [{ "from": "页面 name", "to": "页面 name", "label": "跳转动作，如 点击 批量导出" }]\n` +
    `}\n\n` +
    `硬性要求：\n` +
    `- **不要输出任何坐标字段**（x/y/position），布局由前端计算。\n` +
    `- edges 的 from/to 必须精确等于某个 page 的 name。\n` +
    `- **必须标出入口页**：用户从哪个页面进入本次需求涉及的功能。其余页面都应能顺着 edges 从它走到。\n` +
    `- 除入口页外，每个页面至少要有一条入边；确实无法到达的，在该页 points 里说清原因。\n` +
    `- hub 型页面（点进去能到多个子页面的那种）必须列出**全部下钻链路**，不能只列改动最大的几条。\n` +
    `- edges 的 label 写用户动作（如「点击 今晚吃什么」），不写 router.push 这类技术描述。\n` +
    `- 本次需求不改动、但与改动页面有跳转关系的页面也要列出，state 填 untouched、points 留空数组——\n` +
    `  用户需要据此判断「你是认为不用改，还是压根没看到」。\n` +
    `- 逻辑点要写用户视角的行为变化，不要写「重构了某个函数」这类纯技术描述。`
  );
}

/**
 * 地图首次生成 prompt：正常路径跟在 docgen 之后 resume 同一 session，故不重复注入需求文档全文。
 * @param {object} [opts]
 * @param {string} [opts.docPath] - docSession 丢失时的降级路径：没上下文可续，只能让它现读开发文档。
 */
export function buildMapgenPrompt({ docPath = '' } = {}) {
  const base = docPath
    ? `请先完整 Read 开发文档 ${docPath}，并实际查证工程代码，然后输出一份「需求地图」。\n\n`
    : `基于你刚才产出的开发文档与实际查证过的代码，再输出一份「需求地图」。\n\n`;
  return (
    base +
    `需求地图回答的问题是：**哪个页面的哪个逻辑点被新增 / 修改 / 删除了**。\n` +
    `它给非技术人员看，用来核对「你理解的需求」和「我要的需求」是否一致。\n\n` +
    mapOutputContract()
  );
}

/**
 * 有效标注 → 人类可读行。只收 verdict='wrong' 且写了理由的：
 * 「确认无误」不需要 AI 做任何事，带进 prompt 只是浪费 token。
 */
export function collectAnnotLines(map, annots) {
  if (!annots || typeof annots !== 'object') return [];
  const index = new Map();
  for (const page of map?.pages || []) {
    for (const pt of page.points || []) index.set(pt.id, { page, pt });
  }
  const lines = [];
  for (const [pointId, a] of Object.entries(annots)) {
    if (a?.verdict !== 'wrong') continue;
    const text = String(a?.text ?? '').trim();
    if (!text) continue;
    const hit = index.get(pointId);
    if (!hit) continue; // 上一版存在、这一版已被删掉的点：标注失去指向，忽略
    lines.push(`- 【${hit.page.name}】${hit.pt.title}（${TYPE_CN[hit.pt.type]}）：${text}`);
  }
  return lines;
}

/**
 * 标注 → 修订 prompt。无有效标注时直接抛错：白跑一次 LLM 既费钱又会凭空多出一个版本。
 */
export function buildMapFixPrompt({ map, annots }) {
  const lines = collectAnnotLines(map, annots);
  if (!lines.length) throw new Error('没有需要修订的标注（只有写了理由的「标记有误」才会触发修订）');
  return (
    `用户逐条核对了需求地图，指出下列理解有误之处：\n\n${lines.join('\n')}\n\n` +
    `请据此修订需求地图：改正理解错误的逻辑点、补上遗漏的逻辑点、删掉多余的逻辑点。\n` +
    `未被指出的部分保持原样，不要顺手改。输出**完整的新版地图**（不是差异）。\n\n` +
    mapOutputContract()
  );
}

/** 开发期「需求变动」→ 地图更新 prompt。与 mapfix 的区别是驱动源是新需求而非纠错。 */
export function buildMapChangePrompt({ map, text }) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('需求变动内容为空');
  return (
    `需求发生了变动，用户描述如下：\n\n「${body}」\n\n` +
    `请据此更新需求地图：受影响的逻辑点改描述、新诉求补成新逻辑点、被砍掉的标为删除。\n` +
    `与本次变动无关的部分保持原样。输出**完整的新版地图**（不是差异）。\n\n` +
    mapOutputContract()
  );
}

/**
 * 列表截断成「前 N 项 + 剩余提示」。三处上限共用。
 * 超出时必须明确告诉模型「还有多少没列」——否则它会把截断后的清单当成全集，
 * 得出「这个需求只动了 200 个文件」这类错误结论。
 */
function clipList(items, max, unit) {
  const all = items.map((x) => String(x ?? '').trim()).filter(Boolean);
  const list = all.slice(0, max);
  const rest = all.length - list.length;
  return rest > 0 ? [...list, `…另有 ${rest} ${unit}未列出`] : list;
}

/** 列表段落：每项前加「- 」，空列表返回空串（调用方据此决定要不要出这一段）。 */
function bulletBlock(items) {
  return items.map((x) => `- ${x}`).join('\n');
}

/**
 * 「重新生成」prompt：以**当前代码实现**为准全量重扫。
 *
 * 与 mapgen/mapfix/mapchange 的根本区别是它不做增量改写，也不 resume docSession——
 * 那个 session 装的是评审期的代码理解，正是本次要推翻的对象。带着它续跑，模型只会
 * 确认自己的旧结论，看不见代码已经变了。
 *
 * @param {string} opts.docPath - 最新开发文档路径（必填，让模型现读）
 * @param {string[]} [opts.prevPageNames] - 上一版页面名清单。**只给名字不给 points**：
 *   设计稿回迁（normalizeMap）与变更高亮（markFreshPoints）都以页面名为键，名字漂了两者皆失效；
 *   而一旦给了 points，模型就会照抄旧结论，退化成 mapfix。
 * @param {string[]} [opts.changes] - 开发期「需求变动」正文（说明意图）
 * @param {string[]} [opts.changedFiles] - git 实际改动文件清单（说明结果）
 */
export function buildMapRegenPrompt({ docPath = '', prevPageNames = [], changes = [], changedFiles = [] } = {}) {
  const parts = [
    `开发已经进行了一段时间，代码可能与最初生成的需求地图不一致——开发途中的逻辑调整通常不会回写文档。\n` +
      `请**以当前代码的实际实现为准**，重新查证一遍，输出一份新的「需求地图」。`,
  ];

  if (docPath) {
    parts.push(
      `请先完整 Read 开发文档 ${docPath}。\n` +
        `注意：它代表的是**当初的需求意图**，不是事实来源。与代码冲突时一律以代码为准，` +
        `并在对应逻辑点的 after 里写清「实际实现与当初计划有何不同」。`,
    );
  }

  const changeLines = bulletBlock(
    clipList(changes.map((t) => String(t ?? '').trim().slice(0, REGEN_CHANGE_CHARS)), REGEN_MAX_CHANGES, '条'),
  );
  if (changeLines) {
    parts.push(
      `开发期间用户提过下列需求变动：\n${changeLines}\n\n` +
        `这些只说明**意图**——可能已完整实现、可能只实现了一部分、也可能被后续讨论推翻。请逐条到代码里查证实际状态。`,
    );
  }

  const fileLines = bulletBlock(clipList(changedFiles, REGEN_MAX_FILES, '个文件'));
  if (fileLines) {
    parts.push(
      `这是本需求分支相对基线**实际改动过的文件**：\n${fileLines}\n\n` +
        `请逐个查证它们带来的用户可见行为变化——这是判断「代码到底改了什么」最可靠的线索。`,
    );
  }

  const pageLines = bulletBlock(clipList(prevPageNames, REGEN_MAX_PAGES, '个页面'));
  if (pageLines) {
    parts.push(
      `上一版地图包含这些页面：\n${pageLines}\n\n` +
        `同一个页面请**沿用上面的原名**：用户已经按这些名字挂了 UI 设计稿，改名会让设计稿失联。\n` +
        `页面确已被删除或改名的，照实输出新情况，并在逻辑点里说明原因。`,
    );
  }

  parts.push(
    `需求地图回答的问题是：**哪个页面的哪个逻辑点被新增 / 修改 / 删除了**。\n` +
      `它给非技术人员看，用来核对「你理解的需求」和「我要的需求」是否一致。`,
  );

  return parts.join('\n\n') + '\n\n' + mapOutputContract();
}

/**
 * 需求变动 → 影响预估 prompt。只把地图**摘要**（页面名 + 逻辑点 id/标题/类型）喂进去，
 * 不发全量 before/after：这是个要让用户在弹框里等结果的同步调用，越轻越好。
 */
export function buildImpactPrompt({ map, text }) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('需求变动内容为空');
  const digest = (map?.pages || [])
    .filter((p) => (p.points || []).length)
    .map((p) => `${p.name}：\n${p.points.map((pt) => `  - ${pt.id} [${TYPE_CN[pt.type]}] ${pt.title}`).join('\n')}`)
    .join('\n');
  if (!digest) throw new Error('当前地图没有任何逻辑点，无法预估影响');
  return (
    `这是当前需求地图上的全部逻辑点：\n\n${digest}\n\n` +
    `现在需求发生了变动：\n「${body}」\n\n` +
    `判断这次变动会命中上面哪些逻辑点（通常 1-5 个，没有就返回空数组）。\n\n` +
    `输出契约（严格遵守）：只输出一个 JSON 数组，不要代码围栏，不要任何解释性文字。\n` +
    `[{ "pointId": "上面列出的 id", "action": "改 | 删 | 补", "why": "一句话说清这个点要怎么变" }]\n` +
    `pointId 必须精确等于上面列出的某个 id；"补" 用于「这个点旁边要新增东西」的情形。`
  );
}

/** 影响预估输出 → 只保留指向现存逻辑点的条目（模型偶尔会编 id）。 */
export function parseImpact(text, map) {
  const raw = parseJsonLoose(text);
  if (!Array.isArray(raw)) return [];
  const known = new Map();
  for (const page of map?.pages || []) {
    for (const pt of page.points || []) known.set(pt.id, { page, pt });
  }
  const out = [];
  for (const it of raw) {
    const hit = known.get(String(it?.pointId ?? '').trim());
    if (!hit) continue;
    out.push({
      pointId: hit.pt.id,
      pageName: hit.page.name,
      title: hit.pt.title,
      type: hit.pt.type,
      action: String(it?.action ?? '').trim() || '改',
      why: String(it?.why ?? '').trim(),
    });
  }
  return out;
}

/**
 * 标记「本轮变化」的逻辑点，供界面高亮。
 *
 * 按 `页面名 + 逻辑点标题` 比对而非 id：模型每次重出地图 id 都会变，用 id 比对的结果是
 * 「所有点都是新的」，高亮就失去意义了。首版（prev 为空）一律不标——没有「上一轮」可比。
 */
export function markFreshPoints(prev, next) {
  const prevIndex = new Map();
  for (const page of prev?.pages || []) {
    for (const pt of page.points || []) prevIndex.set(`${page.name} ${pt.title}`, pt);
  }
  for (const page of next?.pages || []) {
    for (const pt of page.points || []) {
      if (!prev) {
        pt.fresh = false;
        continue;
      }
      const old = prevIndex.get(`${page.name} ${pt.title}`);
      pt.fresh = !old || old.after !== pt.after || old.type !== pt.type;
    }
  }
  return next;
}
