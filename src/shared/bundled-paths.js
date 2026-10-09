/**
 * 内置资源（assets/builtin/**）的路径解析 —— 所有内置资源的唯一入口。
 *
 * 开发态：<repo>/assets/builtin/**；打包态：$RESOURCE/sidecar/assets/builtin/**。
 * sidecar staging 会把 assets/ 与 src/ 保结构拷到同一层，所以「从本文件上溯两级 + assets/builtin」
 * 在两种形态下解析到同一相对位置——调用方**禁止**自己拼 __dirname/process.cwd()。
 * （教训：历史上打包态图片链路整条失效，就是路径按开发态写死的。）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // src/shared

export function bundledDir(...segments) {
  return path.join(HERE, '..', '..', 'assets', 'builtin', ...segments);
}
