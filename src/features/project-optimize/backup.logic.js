/**
 * 快照备份的纯逻辑：manifest 结构与还原动作计算。
 */

/**
 * 时间戳转目录名。
 * 冒号在 Windows 路径里非法必须换掉；换成短横线后字典序仍等于时间序，
 * 保留策略靠排序删旧的，这一点不能破坏。
 */
export function backupDirName(iso) {
  return String(iso).replace(/\.\d+Z$/, '').replace(/:/g, '-');
}

export function buildManifest({ at, dir, dimensions, entries }) {
  return {
    at,
    dir,
    dimensions: dimensions || [],
    entries: (entries || []).map((e) => ({
      path: e.path,
      action: e.action,
      // created 是新建的文件，原本不存在，没有内容可备份；
      // 还原时靠删除它来回到原状。
      backed: e.action !== 'created',
    })),
  };
}

export function restoreActionsOf(manifest) {
  return (manifest?.entries || []).map((e) =>
    e.action === 'created'
      ? { op: 'remove', path: e.path }
      : { op: 'copy', path: e.path },
  );
}
