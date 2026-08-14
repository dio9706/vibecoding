/**
 * 配置导入导出的纯函数（无 I/O，可单测）。
 * 唯一真源：导出包的类型标记与版本号。导入前用 parseImport 做结构校验。
 */
export const CONFIG_TYPE = 'claude-agent-config';
export const CONFIG_VERSION = 1;

/** 把 settings 包成带类型/版本/时间戳的导出对象 */
export function buildExport(settings, exportedAt) {
  return {
    __type: CONFIG_TYPE,
    version: CONFIG_VERSION,
    exportedAt: exportedAt || null,
    settings: settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {},
  };
}

/** 校验导入对象；通过返回 {ok:true, settings}，否则 {ok:false, error} */
export function parseImport(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '配置文件格式不正确' };
  }
  if (raw.__type !== CONFIG_TYPE) {
    return { ok: false, error: '配置文件类型不匹配' };
  }
  if (raw.version !== CONFIG_VERSION) {
    return { ok: false, error: '配置文件版本不支持' };
  }
  if (!raw.settings || typeof raw.settings !== 'object' || Array.isArray(raw.settings)) {
    return { ok: false, error: '配置内容缺失' };
  }
  return { ok: true, settings: raw.settings };
}
