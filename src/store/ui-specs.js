/**
 * UI 规范存储 —— 按**工程目录**归属的项目级规范文本（字体/圆角/组件约定/禁止项）。
 *
 * 刻意不写进用户工程目录（那是别人的仓库，见 spec §3.2），落
 * `APP_DATA_DIR/ui-specs/<dirSlug>.md`。一个工程一份，覆盖写，不留版本历史（YAGNI）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { appDataPath } from '../shared/app-paths.js';
import { dirSlug } from '../shared/dir-slug.js';

function specPath(dir) {
  const root = appDataPath('ui-specs');
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, `${dirSlug(dir)}.md`);
}

/** 读某工程的 UI 规范全文；未配置过返回空串（调用方据此走「未配置」口径）。 */
export function readUiSpec(dir) {
  if (!String(dir || '').trim()) return '';
  try {
    return fs.readFileSync(specPath(dir), 'utf8');
  } catch {
    return ''; // 文件不存在是常态，不是错误
  }
}

/** 写某工程的 UI 规范；返回落盘路径供调用方留痕。 */
export function writeUiSpec(dir, text) {
  if (!String(dir || '').trim()) throw new Error('缺少工程目录');
  const p = specPath(dir);
  fs.writeFileSync(p, String(text ?? ''), 'utf8');
  return p;
}

/** 某工程是否已配置过 UI 规范（前端用来决定是否提示「先去建一份」）。 */
export function hasUiSpec(dir) {
  return readUiSpec(dir).trim().length > 0;
}
