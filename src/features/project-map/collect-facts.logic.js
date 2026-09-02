/**
 * 从源代码中提取所有导出的符号名
 * 支持：export default, export const, export function, export class, export {...} from
 * @param {string} code - 源代码
 * @param {string} filePath - 文件路径（仅用于日志）
 * @returns {string[]} 导出符号列表
 */
export function extractExports(code, filePath) {
  const exports = []

  // export default function/class/const/object
  const defaultMatch = code.match(/export\s+default\s+(?:function|class)?\s*(\w+)/)
  if (defaultMatch) {
    exports.push(defaultMatch[1])
  }

  // export const/function/class name
  const namedMatches = code.matchAll(/export\s+(?:const|function|class)\s+(\w+)/g)
  for (const match of namedMatches) {
    exports.push(match[1])
  }

  // export { a, b, c } from ...
  const reExportMatches = code.matchAll(/export\s*\{\s*([^}]+)\s*\}/g)
  for (const match of reExportMatches) {
    const items = match[1].split(',').map(s => {
      // 处理 "a as b" 情况，取 b（导出时的名字）
      const parts = s.trim().split(/\s+as\s+/)
      return parts[parts.length - 1]
    })
    exports.push(...items.filter(Boolean))
  }

  return [...new Set(exports)]  // 去重
}

/**
 * 从代码中提取导入的模块列表
 * @param {string} code - 源代码
 * @returns {string[]} 导入的模块路径（相对或绝对）
 */
export function extractImports(code) {
  const imports = []

  // import ... from 'path' — 用 from 而不是贪心 import.*from
  const matches = code.matchAll(/from\s+['"](.*?)['"]/g)
  for (const match of matches) {
    imports.push(match[1])
  }

  // require('path')
  const requireMatches = code.matchAll(/require\s*\(\s*['"](.*?)['"]\s*\)/g)
  for (const match of requireMatches) {
    imports.push(match[1])
  }

  return [...new Set(imports)]  // 去重
}
