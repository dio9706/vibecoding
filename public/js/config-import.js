/** 配置文件导入流程：解析 → 类型前置校验 →（可选）覆盖确认 → POST → 结果。
 *  设置页与新用户引导共用。引导场景不传 confirm——新用户本来是空配置，
 *  「将覆盖当前全部配置」那句危险确认在那里纯属误导。 */

// 与后端 src/store/config-transfer.js 的 CONFIG_TYPE 保持一致。
// 前端无法 import src/（那是 Node 侧模块，浏览器取不到），只能硬编码一份；
// 这里只做「早失败」的前置校验，权威校验在后端 parseImport。
const CONFIG_TYPE = 'claude-agent-config';

/**
 * 读取并导入配置文件。
 * @param {File} file 用户选中的 .json 配置文件
 * @param {{confirm?: () => Promise<boolean>}} opts 省略 confirm 则跳过覆盖确认
 * @returns {Promise<{ok: boolean, error?: string, cancelled?: boolean, actionConfigsImported?: boolean}>}
 *   cancelled 与 error 分开：用户主动取消不该弹错误提示
 */
export async function importConfigFile(file, { confirm } = {}) {
  if (!file) return { ok: false, error: '未选择文件' };
  let raw;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    return { ok: false, error: '配置文件格式不正确' };
  }
  if (!raw || raw.__type !== CONFIG_TYPE) {
    return { ok: false, error: '配置文件类型不匹配' };
  }
  if (confirm && !(await confirm())) return { ok: false, cancelled: true };
  try {
    const r = await fetch('/api/settings/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(raw),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) return { ok: false, error: d.error || 'HTTP ' + r.status };
    return { ok: true, actionConfigsImported: !!d.actionConfigsImported };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}
