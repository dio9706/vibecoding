/**
 * P2 的 2 个 reversible 工具 —— agent 从「能查能聊」到「能办事」的一步。
 *
 * 授权模型是「乐观执行 + 可撤销」（`capabilities/agent-tools.js` 文件头）：不等主机确认直接
 * 执行，但每次都必须留一个撤销锚点。两个工具都是 `danger:'reversible'`，注册期硬要求
 * `buildUndo` 存在且不得返回 null——这里不留任何一条能绕过去的路径。
 *
 * 与 `req-read.js` 共用的三条纪律同样适用（fail-closed 可见性 / 不倒整条记录 / 不给绝对路径），
 * 但 `visible`/`resolveVisible` 没有从那边导出，这里按同样口径本地重实现一份——
 * 两个文件都只服务同一个注册入口，重复五行判断换来的是彼此不必知道对方的内部结构。
 *
 * ## start_dev_task 的 buildUndo 为什么是「骨架」
 *
 * 工具调用这一刻，任务刚入队，真正的分支/提交/mergeSha 要等 `colleague-dev.js` 里的 run
 * 跑完才有——那时 `commitAndMerge` 会写下一条 `tool:'start_dev_task'` 的完整台账
 * （见该文件 `commitAndMerge` 内的 `appendAction` 调用，undo 已带上真实 `mergeSha`）。
 * 这里的 `buildUndo` 只是满足注册期不变式的占位骨架，`mergeSha` 恒为 null；真正能点的
 * 撤销记录由 onSettle 那条写入覆盖式地补全，不由本文件负责。
 *
 * ## 反向依赖怎么解的
 *
 * `registerApiDoc`/`enqueueSystemTask` 活在 `entrypoints/web/requirement-ops.js`，而分层是
 * `entrypoints → app → features/plugins → capabilities → integrations/store → shared`——
 * plugins 反向 import entrypoints/web 是明确违规。这里选**动态 import**（而不是要求调用方
 * 注入）：`index.js` 对 `buildReqReadTools`/`buildReqWriteTools` 一律零参调用、在**模块加载时**
 * 完成注册（与卡片回调同一范式），那个时间点既不知道也不该关心 requirement-ops 这个重模块
 * （内含 git / lark / claude 调用链）的装配细节；调用方注入会强迫这一层多背一份「从哪调进来」
 * 的管线，而动态 import 把加载推迟到工具真正被调用的那一刻——生产环境里 web 进程本就已经
 * 加载过 requirement-ops.js（`routes-requirements.js` 早早 import 了它），这里的动态 import
 * 命中的是模块缓存，零额外开销；唯一的代价是 handler 多一层 await，可忽略。
 */
import { z } from 'zod';
import { getRequirement as realGetRequirement } from '../../../store/requirements.js';
import { pickProjectDir } from './req-read.js';
import { logger } from '../../../shared/logger.js';

/** P2 装配的工具名清单（顺序即注册顺序） */
export const REQ_WRITE_TOOL_NAMES = ['register_api_doc', 'start_dev_task'];

/** 他参不参与这个需求（与 req-read.js#visible 同口径） */
function visible(req, colleagueId) {
  return !!req && !!colleagueId && (req.assignees || []).includes(colleagueId);
}

/** 取一个他可见的需求，取不到返回 { error }（与 req-read.js#resolveVisible 同口径） */
function resolveVisible(getRequirement, reqId, colleagueId) {
  const req = getRequirement(reqId);
  if (!visible(req, colleagueId)) return { error: `找不到需求 ${reqId}，或者你没有参与它` };
  return { req };
}

/** 非开发期的统一拒绝文案：给人话，不给 phase 字面量这种内部状态码 */
function notDevPhase(req) {
  return { error: `需求「${req.title}」当前不在开发期，这件事暂时办不了` };
}

/** requirement-ops.js 的懒加载单例：模块体积不小（git/lark/claude 调用链），只在真正要写时才付这份加载成本 */
let reqOpsPromise = null;
function loadReqOps() {
  if (!reqOpsPromise) reqOpsPromise = import('../../../entrypoints/web/requirement-ops.js');
  return reqOpsPromise;
}

export function buildReqWriteTools(deps = {}) {
  const getRequirement = deps.getRequirement || realGetRequirement;
  const registerApiDoc = deps.registerApiDoc || (async (req, opts) => (await loadReqOps()).registerApiDoc(req, opts));
  const enqueueSystemTask = deps.enqueueSystemTask || (async (reqId, kind, payload) => (await loadReqOps()).enqueueSystemTask(reqId, kind, payload));

  return [
    {
      name: 'register_api_doc',
      description:
        '把一份接口文档登记到需求上，前端联调靠它读取最新接口定义。仅开发期可用，仅登记，不读文档内容。' +
        '收到同事发来的接口文档文件时用它。',
      danger: 'reversible',
      roles: ['backend'],
      schema: {
        reqId: z.string().describe('需求 id，形如 r_xxxx'),
        name: z.string().describe('文档名，如 order.md（须与同事发来的文件名一致）'),
      },
      handler: async ({ reqId, name }, ctx) => {
        const r = resolveVisible(getRequirement, reqId, ctx?.colleagueId);
        if (r.error) return r;
        if (r.req.phase !== 'dev') return notDevPhase(r.req);

        // 路径从 ctx.files 按文件名反查，**不经模型之手**——模型只知道文件名
        // （见 session.js 的 fileLine 注释：不给磁盘绝对路径）。
        // 模型报一个没收到过的文件名时，这里要明确回错，不能拿 undefined 去登记。
        const hit = (ctx?.files || []).find((f) => f.name === name);
        if (!hit?.path) return { error: `没有收到名为「${name}」的文件，请确认文件名` };

        const result = await registerApiDoc(r.req, { name, path: hit.path });
        if (!result?.ok) {
          // 下游错误文案（requirement-ops.js）里可能带磁盘绝对路径或 fs 报错原文，
          // 那是给人看（web UI 操作者）设计的，不能原样转发给模型——
          // 日志留全文供排查，回模型换固定短语（同 agent-tools.js#textResult 的边界脱敏范式）。
          logger.warn('colleague-agent', '接口文档登记失败', { reqId, name, err: result?.error });
          return { error: '接口文档登记失败，请稍后再试或换个方式发送文件' };
        }
        // 只回文档名与需求标题，不回存档后的绝对路径——模型没有工具去读它
        return { ok: true, reply: `已登记接口文档「${result.doc?.name || name}」，同步给需求「${r.req.title}」的开发` };
      },
      buildUndo: (input) => ({ kind: 'delete-apidoc', reqId: input.reqId, name: input.name }),
    },

    {
      name: 'start_dev_task',
      description:
        '把同事在对话里提出的开发诉求转成一个任务，立即安排 agent 接入改码。仅开发期可用。' +
        '执行前务必确认这就是同事想要的那个需求——回复会带上需求标题与分支，供同事当场核对，' +
        '一旦发现文不对题请让同事立刻喊停（spec §6.2：归属判错会把改动落到别的需求的分支上）。',
      danger: 'reversible',
      roles: ['backend', 'product', 'qa'],
      schema: {
        reqId: z.string().describe('需求 id，形如 r_xxxx'),
        task: z.string().describe('同事想要做的开发事项，尽量保留他的原话'),
      },
      handler: async ({ reqId, task }, ctx) => {
        const r = resolveVisible(getRequirement, reqId, ctx?.colleagueId);
        if (r.error) return r;
        if (r.req.phase !== 'dev') return notDevPhase(r.req);

        const branch = (r.req.branches || []).find((b) => b.dir === pickProjectDir(r.req.projects))?.branch;
        const prompt = `需求「${r.req.title}」（${reqId}）的开发期任务，来自同事在对话中提出的诉求：\n${task}`;
        const title = '同事发起：' + task.slice(0, 30);

        const result = await enqueueSystemTask(reqId, 'colleague-dev', {
          msgId: ctx?.msgId || '',
          colleagueId: ctx?.colleagueId || '',
          prompt,
          title,
        });
        // `enqueueSystemTask` 当前实现**恒返回 undefined**（requirement-ops.js:175，全函数无显式返回值），
        // 所以这条分支在生产里不可达。保留它防的是可注入的 `deps.enqueueSystemTask` ——
        // 替换实现若返回 `{ok:false}`，工具要如实转述，而不是谎报派活成功。
        // 前置的 `result &&` 不能删：少了它，undefined 会在这里抛 TypeError。
        if (result && result.ok === false) return { error: result.error || '任务入队失败' };

        // 必须明写需求标题 + 分支：归属判错的兜底不是让 agent 更小心，是让最知道答案的
        // 同事当场看见「咦这不是我要改的需求」
        return {
          ok: true,
          reply: `已受理，将在需求「${r.req.title}」（${reqId}${branch ? '，分支 ' + branch : ''}）上安排开发：${task}`,
        };
      },
      buildUndo: (input, _result, ctx) => ({
        kind: 'revert-merge',
        reqId: input.reqId,
        msgId: ctx?.msgId || null,
        repo: null,
        branch: null,
        baseBranch: null,
        mergeSha: null, // 待 colleague-dev.js#commitAndMerge 收尾时用真实值另写一条覆盖
      }),
    },
  ];
}
