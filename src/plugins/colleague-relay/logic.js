/**
 * 同事消息中继的纯逻辑（零 IO）：归属判定 + 选择卡片构造。
 *
 * 抽出来是因为**两条入站链路**都要用同一套判定：文本走 dispatch 的 feature，
 * 附件（图片/文件）走飞书入口的早期分支（它们在 dispatch 之前就 return 了）。
 * 各写一份必然分叉，表现成「文字消息归对了需求、发来的文档归错了」。
 */

/** 卡片按钮的 kind 路由标识（registerCardKindHandler 注册用） */
export const PICK_KIND = 'colleague-pick';

/** 收到同事消息后的统一回执。刻意不多话：真正的处理由主机看过之后决定 */
export const ACK_TEXT = '已收到，信息会同步发送给主机！';

/**
 * open_id → { 该同事, 他参与的开发期需求 }。
 *
 * 只认 `phase === 'dev'`：评审期需求还没开工，归档的已经结束，往里塞消息都没有意义。
 * 调用方据 `reqs.length` 分三路：0 → PASS 回落 feedback；1 → 直接归入；>1 → 发卡让他自选。
 *
 * @param {string} openId 发信人 open_id
 * @param {object[]} colleagues 名册（store/colleagues.js 的形状）
 * @param {object[]} requirements 需求列表（store/requirements.js 的形状）
 */
export function resolveTargets(openId, colleagues, requirements) {
  const list = Array.isArray(colleagues) ? colleagues : [];
  const reqList = Array.isArray(requirements) ? requirements : [];
  // 判 openId 非空：名册里存在未填 open_id 的同事，不判的话空对空会误匹配到第一个没填号的人
  const colleague = openId
    ? list.find((c) => c && c.feishuOpenId && c.feishuOpenId === openId) || null
    : null;
  if (!colleague) return { colleague: null, reqs: [] };
  const reqs = reqList.filter(
    (r) => r && r.phase === 'dev' && Array.isArray(r.assignees) && r.assignees.includes(colleague.id),
  );
  return { colleague, reqs };
}

/**
 * 「这条消息是关于哪个需求？」选择卡。
 *
 * 按钮 value 自带 openId/colleagueId/reqId 全部上下文 → 走 kind 路由、**无内存态**，
 * 机器人重启后同事点旧卡片依然有效。同事可能隔几小时才点，用内存 Map 存回调
 * （registerCardActionHandler）会在重启后静默失效，表现为「点了没反应」。
 * 按钮形态对齐 shared/messages.js:buildWelcomeCard 的 quick-action 按钮。
 */
export function buildPickCard(openId, colleagueId, reqs) {
  return {
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '收到～ 请问这条是关于**哪个需求**的？点一下我就转达给主机。',
        },
      },
      {
        tag: 'action',
        actions: (Array.isArray(reqs) ? reqs : []).map((r) => ({
          tag: 'button',
          type: 'primary',
          text: { tag: 'plain_text', content: r.title },
          value: {
            kind: PICK_KIND,
            openId,
            colleagueId,
            reqId: r.id,
            _timestamp: Date.now(),
          },
        })),
      },
    ],
  };
}
