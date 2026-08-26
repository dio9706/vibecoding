/**
 * 配置导入导出的纯函数（无 I/O，可单测）。
 * 唯一真源：导出包的类型标记与版本号。导入前用 parseImport 做结构校验。
 */
export const CONFIG_TYPE = 'claude-agent-config';
export const CONFIG_VERSION = 2;

// 导入侧接受的版本。v1 只有 settings；v2 起多一个顶层 actionConfigs。
// 保留 v1 是因为用户手里已经有导出过的旧包，拒掉等于让那些文件作废。
const SUPPORTED_VERSIONS = [1, 2];

/** 把 settings 与托管配置包成带类型/版本/时间戳的导出对象。
 *  actionConfigs 单独占一个顶层字段而不塞进 settings：它落盘在另一个文件
 *  （action-configs.json），混进 settings 会让导入侧分不清该往哪个文件写。 */
export function buildExport(settings, actionConfigs, exportedAt) {
  return {
    __type: CONFIG_TYPE,
    version: CONFIG_VERSION,
    exportedAt: exportedAt || null,
    settings: settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {},
    actionConfigs: Array.isArray(actionConfigs) ? actionConfigs : [],
  };
}

/** 校验导入对象；通过返回 {ok:true, settings, actionConfigs}，否则 {ok:false, error}。
 *
 *  actionConfigs 为 null 的语义是「本次导入不涉及托管配置」——v1 旧包没这个字段，
 *  或 v2 包里该字段是脏数据。调用方必须据此**跳过**写 action-configs.json，
 *  而不是拿一个空数组去覆盖，那会把用户现有的动作全部清空。 */
export function parseImport(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '配置文件格式不正确' };
  }
  if (raw.__type !== CONFIG_TYPE) {
    return { ok: false, error: '配置文件类型不匹配' };
  }
  if (!SUPPORTED_VERSIONS.includes(raw.version)) {
    return { ok: false, error: '配置文件版本不支持' };
  }
  if (!raw.settings || typeof raw.settings !== 'object' || Array.isArray(raw.settings)) {
    return { ok: false, error: '配置内容缺失' };
  }
  return {
    ok: true,
    settings: raw.settings,
    actionConfigs: Array.isArray(raw.actionConfigs) ? raw.actionConfigs : null,
  };
}
