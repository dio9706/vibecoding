/**
 * `git status --porcelain` 输出解析。
 *
 * 为什么要查工作区：优化会删文件、改写全仓引用。如果工作区本来就有
 * 用户自己的未提交改动，两者混在一起后 git diff 分不清谁改的。
 */
export function parsePorcelain(out) {
  const lines = String(out || '').split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const files = lines.map((l) => {
    const code = l.slice(0, 2);
    let p = l.slice(3); // 前两位状态码 + 一位空格
    // 只有重命名/复制才有 `old -> new` 结构；
    // 其它状态下路径里出现的 -> 是文件名的一部分，不能切
    if (/[RC]/.test(code)) {
      const arrow = p.indexOf(' -> ');
      if (arrow !== -1) p = p.slice(arrow + 4);
    }
    // 含特殊字符的路径 git 会加引号
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    return p;
  });
  return { dirty: files.length > 0, count: files.length, files };
}
