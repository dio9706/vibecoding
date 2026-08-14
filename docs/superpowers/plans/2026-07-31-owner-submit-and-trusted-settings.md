# owner 强前缀提交放行 + 可信名单入设置页 实施计划

**Goal:** owner 发「提交需求：/提交故障：」走收集流程（自动直通开发、材料池 drain 生效），其余 owner 消息仍走完整 Claude；可信提交人名单可在机器人设置页按机器人配置，空值回退 env。

**Architecture:** claude-exec 自己让路强提交前缀（复用 `matchStrongIntent`，不在 dispatch 硬编码 feature 名）；feedback permission 放宽为 any 并把 owner 视为可信；名单读取收敛为纯函数 `resolveTrustedOpenIds(bot, envList)`（bot 非空优先，不做并集）。

**规格：** `docs/superpowers/specs/2026-07-31-owner-submit-and-trusted-settings-design.md`

**⚠️ 铁律：不做 git 提交。注释中文。**

---

### Task A：claude-exec 让路强提交前缀

**Files:** Create `src/features/claude-exec/logic.js` + `logic.test.js`；Modify `src/features/claude-exec/index.js`

- [ ] A1 写失败测试 `logic.test.js`：
  - owner + `'提交需求：加个导出'` → false；owner + `'提交故障：白屏'` → false
  - owner + `'/new'` / `'帮我看下日志'` / `'问个问题：这块怎么跑的'` → true
  - guest + 任意 → false；空文本 + owner → true
- [ ] A2 跑测试确认失败
- [ ] A3 实现 `logic.js`：
```js
/**
 * claude-exec 路由判定（纯函数，可单测）。
 * owner 全接是本 feature 的立身之本，但「提交需求：/提交故障：」必须让路给 feedback ——
 * 否则 owner 永远无法立案，且单发图片/文件入材料池后没有 drain 出口（材料静默过期）。
 * question 前缀不让路：owner 问问题走完整 Claude 能力更强。
 */
import { matchStrongIntent } from '../../app/intent-keywords.js';

export function shouldOwnerExec(text, role) {
  if (role !== 'owner') return false;
  const strong = matchStrongIntent(text);
  return !(strong && (strong.type === 'bug' || strong.type === 'feature'));
}
```
- [ ] A4 `index.js` 的 `match: (ctx) => ctx.user.role === 'owner'` 改为 `match: (ctx) => shouldOwnerExec(ctx.text, ctx.user.role)` + import；更新文件头注释说明让路
- [ ] A5 测试通过 + 冒烟 import

### Task B：feedback 接受 owner + 名单读取收敛

**Files:** Modify `src/plugins/team-tools/feedback/logic.js` + `logic.test.js` + `index.js`

- [ ] B1 `logic.test.js` 追加 `resolveTrustedOpenIds` 测试：bot 有值取 bot；bot 空数组/undefined/null bot → 取 env；两者皆空 → `[]`；bot 非数组 → 取 env
- [ ] B2 `logic.js` 追加：
```js
/**
 * 可信提交人名单出口：per-bot 设置优先，未配置（空/缺失）才回退 env。
 * 不做并集——否则设置页「清空」无法覆盖 env，语义不可预期。
 */
export function resolveTrustedOpenIds(bot, envList = []) {
  const fromBot = Array.isArray(bot?.trustedOpenIds) ? bot.trustedOpenIds.filter(Boolean) : [];
  return fromBot.length ? fromBot : (envList || []).filter(Boolean);
}
```
- [ ] B3 `index.js`：`permission: 'guest'` → `'any'`（注释说明谁提交都该被收集）
- [ ] B4 `index.js` 直通判定改为：
```js
    // owner 与可信提交人（per-bot 设置优先，回退 TRUSTED_OPEN_IDS）直通：不判断合理性，
    // 跳过评审门与方案生成，直接进自动开发队列（合并仍需管理员确认）。不分托管等级。
    const trusted = resolveTrustedOpenIds(getActiveBot(), config.lark.trustedOpenIds);
    if (ctx.user.role === 'owner' || trusted.includes(ctx.user.id)) {
```
- [ ] B5 `index.js` 卡片鉴权处 `trustedOpenIds: config.lark.trustedOpenIds` 改为 `trustedOpenIds: resolveTrustedOpenIds(getActiveBot(), config.lark.trustedOpenIds)`
- [ ] B6 全量测试 + 冒烟

### Task C：可信名单 per-bot 设置字段（前后端链路）

**Files:** Modify `src/store/settings.js`、`src/store/settings.test.js`、`src/entrypoints/web/routes-settings.js`、`public/index.html`、`public/js/bots-panel.js`、`docs/CONFIGURATION.md`

- [ ] C1 `settings.test.js` 追加 `makeBotEntry`：`trustedOpenIds` 数组透传（trim+去空）、非数组归 `[]`
- [ ] C2 `settings.js` `makeBotEntry` 增 `trustedOpenIds`（复用 mcp 的 strList 写法：`Array.isArray(v)?v.map(s=>String(s).trim()).filter(Boolean):[]`）；**`addBot` 的解构与转发两处同步补齐**（漏一处即新建丢字段）
- [ ] C3 `routes-settings.js` `cleanBotInput` 收该字段：数组或换行字符串都归一为数组，逐项 trim 去空、条目长度按既有 MAX_LEN 惯例校验；`botView` 回读
- [ ] C4 `public/index.html` bot 表单加 textarea `#botTrustedOpenIds`（label「可信提交人 open_id（每行一个）」，placeholder 用 `&#10;` 示范两行，说明「他们提交的需求/故障跳过 AI 评审直接自动开发；留空则用 .env 的 TRUSTED_OPEN_IDS」）
- [ ] C5 `public/js/bots-panel.js`：`openBotForm` 回填 `(bot?.trustedOpenIds||[]).join('\n')`；`saveBot` 提交 `split('\n').map(trim).filter(Boolean)`（抄 `#mcpAutoAllow` 模式）
- [ ] C6 `docs/CONFIGURATION.md` 的 `TRUSTED_OPEN_IDS` 行补一句「机器人设置页可按机器人覆盖；设置页非空时优先，留空回退本项」
- [ ] C7 全量测试

### Task D：回归与走查

- [ ] D1 `npm test` 全绿（当前基线 291/291）
- [ ] D2 人工走查：owner 发「提交需求：xxx」→ 立案 + 直通自动开发（不再是 Claude 当场改码）；owner 发普通消息 → 仍走完整 Claude；owner 先发图再发「提交需求：…」→ 回复带「已带上材料 1 份」；设置页填名单 → guest 提交直通；设置页清空 → 回退 env
