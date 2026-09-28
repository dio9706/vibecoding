/**
 * P1 的 5 个 safe 工具 —— agent 的「眼睛」。
 *
 * 三条贯穿全文件的纪律：
 *
 * 1. **fail-closed 的可见性**：每个工具都用 ctx.colleagueId 校验「这个需求他参不参与」。
 *    缺 colleagueId 一律当作看不见，绝不外推成「全部可见」。agent 面对的是公司同事，
 *    不是主机，需求内容不该跨人泄露。
 * 2. **不把整条记录倒给模型**：`requirements.json` 的一条记录含 busy / devSession /
 *    docSession / bitable 等一堆内部字段，倒给模型既浪费 token 又泄露实现细节。
 *    每个工具只挑它该给的字段。
 * 3. **不给落盘绝对路径**：文档的 `path` 是主机磁盘上的真实路径，模型没有用它的工具
 *    （内置工具全禁了），给了只会诱导它编造「我去读一下」这种做不到的动作。
 *
 * 依赖注入（`buildReqReadTools(deps)`）是为了单测不碰真实盘。
 */
import { z } from 'zod';
import { getRequirements as realGetRequirements, getRequirement as realGetRequirement } from '../../../store/requirements.js';
import { runReadonlyAgent as realRunReadonlyAgent } from '../../../capabilities/llm-readonly-agent.js';

/** P1 装配的工具名清单（顺序即注册顺序，测试钉住它防漏装） */
export const REQ_READ_TOOL_NAMES = [
  'list_my_requirements', 'get_requirement', 'get_api_doc', 'get_dev_progress', 'read_project_code',
];

/** 归档与废弃的需求不进 agent 视野 —— 它们已经不是「进行中的事」 */
const DEAD_PHASES = new Set(['archived', 'discarded']);

/** 取工程目录：前端优先，缺则后端（与 addNewSession 同一取法） */
export function pickProjectDir(projects) {
  return projects?.frontend?.dir || projects?.backend?.dir || '';
}

/** 他参不参与这个需求 */
function visible(req, colleagueId) {
  return !!req && !!colleagueId && (req.assignees || []).includes(colleagueId);
}

/**
 * 取一个他可见的需求，取不到返回 { error }。
 * 「不存在」与「无权」刻意用同一条文案 —— 分开说等于告诉他有这么个需求存在。
 */
function resolveVisible(getRequirement, reqId, colleagueId) {
  const req = getRequirement(reqId);
  if (!visible(req, colleagueId)) return { error: `找不到需求 ${reqId}，或者你没有参与它` };
  return { req };
}

export function buildReqReadTools(deps = {}) {
  const getRequirements = deps.getRequirements || realGetRequirements;
  const getRequirement = deps.getRequirement || realGetRequirement;
  const runReadonlyAgent = deps.runReadonlyAgent || realRunReadonlyAgent;

  return [
    {
      name: 'list_my_requirements',
      description: '列出这位同事当前参与的全部进行中需求（含 id、标题、阶段）。判断他说的是哪个需求时先用它。',
      danger: 'safe',
      roles: ['*'],
      schema: {},
      handler: async (_input, ctx) => {
        const id = ctx?.colleagueId;
        if (!id) return { requirements: [] };
        return {
          requirements: getRequirements()
            .filter((r) => !DEAD_PHASES.has(r.phase) && (r.assignees || []).includes(id))
            .map((r) => ({ id: r.id, title: r.title, phase: r.phase })),
        };
      },
    },

    {
      name: 'get_requirement',
      description: '查一个需求的概况：标题、阶段、有几份接口文档、配了哪些工程。需要知道需求现状时用它，不要凭记忆回答。',
      danger: 'safe',
      roles: ['*'],
      schema: { reqId: z.string().describe('需求 id，形如 r_xxxx') },
      handler: async ({ reqId }, ctx) => {
        const r = resolveVisible(getRequirement, reqId, ctx?.colleagueId);
        if (r.error) return r;
        const req = r.req;
        return {
          id: req.id,
          title: req.title,
          phase: req.phase,
          apiDocCount: (req.apiDocs || []).length,
          hasFrontend: !!req.projects?.frontend?.dir,
          hasBackend: !!req.projects?.backend?.dir,
          changeCount: (req.changes || []).length,
          updatedAt: req.updatedAt,
        };
      },
    },

    {
      name: 'get_api_doc',
      description: '列出某个需求已登记的接口文档（名字与更新时间）。确认「这份文档是不是已经给过了」时用它。',
      danger: 'safe',
      roles: ['*'],
      schema: { reqId: z.string().describe('需求 id') },
      handler: async ({ reqId }, ctx) => {
        const r = resolveVisible(getRequirement, reqId, ctx?.colleagueId);
        if (r.error) return r;
        // 刻意不给 path：那是主机磁盘的绝对路径，模型没有读它的工具
        return { docs: (r.req.apiDocs || []).map((d) => ({ name: d.name, updatedAt: d.updatedAt })) };
      },
    },

    {
      name: 'get_dev_progress',
      description: '查一个需求的开发进展：当前阶段、开了几个会话、最近发生了什么。对方问「做到哪了」时用它。',
      danger: 'safe',
      roles: ['*'],
      schema: { reqId: z.string().describe('需求 id') },
      handler: async ({ reqId }, ctx) => {
        const r = resolveVisible(getRequirement, reqId, ctx?.colleagueId);
        if (r.error) return r;
        const req = r.req;
        return {
          phase: req.phase,
          sessionCount: (req.sessions || []).length,
          // 只给最近 10 条：history 会长到几百条，全倒进去挤掉真正有用的上下文
          history: (req.history || []).slice(-10).map((h) => ({ at: h.at, event: h.event })),
        };
      },
    },

    {
      name: 'read_project_code',
      description:
        '让一个只读助手去项目代码里查一件事，返回结论。' +
        '**要质疑对方给的信息之前必须先用它拿到依据**（比如接口文档写的字段和前端实际调用对不对得上）。' +
        '一次问一个具体问题，不要问「看看代码」这种没有答案的问题。',
      danger: 'safe',
      roles: ['*'],
      schema: {
        reqId: z.string().describe('需求 id，用来定位要查哪个工程'),
        question: z.string().describe('一个具体问题，例如「前端调用 /api/order/list 时传了哪些参数」'),
      },
      handler: async ({ reqId, question }, ctx) => {
        const r = resolveVisible(getRequirement, reqId, ctx?.colleagueId);
        if (r.error) return r;
        const cwd = pickProjectDir(r.req.projects);
        if (!cwd) return { error: `需求 ${reqId} 还没有配置工程目录，查不了代码` };

        const out = await runReadonlyAgent({
          prompt:
            `在当前项目里查清这个问题，然后只输出 JSON：{"answer": "结论（≤300字，说清依据在哪个文件）"}\n\n` +
            `问题：${question}`,
          cwd,
          logTag: 'colleague-agent/read-code',
          requireKeys: ['answer'],
        });
        if (!out.data?.answer) return { error: `查代码没得到结论（${out.reason || 'unknown'}）` };
        return { answer: out.data.answer };
      },
    },
  ];
}
