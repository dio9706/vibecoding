import { readdir, readFile } from 'fs/promises'
import path from 'path'
import { extractExports, extractImports } from './collect-facts.logic.js'

// 支持的特征目录，按优先级排列
const FEATURE_DIRS = ['src/features', 'src/pages', 'src/modules', 'packages']

// 支持的源文件扩展名
const SOURCE_EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx', '.vue', '.py']

/**
 * 判断是否应该跳过目录
 */
function shouldSkipDir(name) {
  return name.startsWith('.') || name === 'node_modules'
}

/**
 * 判断是否是源文件
 */
function isSourceFile(name) {
  return SOURCE_EXTENSIONS.some(ext => name.endsWith(ext))
}

/**
 * 获取文件行数（快速估算）
 */
async function getLineCount(filePath) {
  try {
    const content = await readFile(filePath, 'utf-8')
    return content.split('\n').length
  } catch {
    return 0
  }
}

/**
 * 递归扫描目录，收集所有源文件
 */
async function scanSourceFiles(dirPath, baseDir) {
  const files = []
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (shouldSkipDir(entry.name)) continue

      const fullPath = path.join(dirPath, entry.name)
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/')

      if (entry.isDirectory()) {
        files.push(...await scanSourceFiles(fullPath, baseDir))
      } else if (isSourceFile(entry.name)) {
        files.push(relativePath)
      }
    }
  } catch {
    // 目录不存在或无权限，忽略
  }
  return files
}

/**
 * 确定性扫描项目目录，识别模块边界和模块间依赖关系
 * @param {string} projectPath - 项目根路径
 * @param {object} options - 配置选项
 * @returns {Promise<{modules, edges, externalDeps, summary}>}
 */
export async function collectProjectFacts(projectPath, options = {}) {
  const modules = []
  const moduleMap = new Map()  // name -> module object
  let featuresDir = null

  // 第一遍：识别模块边界
  for (const dirName of FEATURE_DIRS) {
    const checkDir = path.join(projectPath, dirName)
    try {
      const entries = await readdir(checkDir, { withFileTypes: true })
      if (entries.some(e => e.isDirectory() && !shouldSkipDir(e.name))) {
        featuresDir = dirName
        break
      }
    } catch {
      // 目录不存在，继续下一个
    }
  }

  if (!featuresDir) {
    // 没有找到特征目录
    return {
      modules: [],
      edges: [],
      externalDeps: [],
      summary: { totalModules: 0, totalFiles: 0, totalLines: 0 }
    }
  }

  const featuresDirPath = path.join(projectPath, featuresDir)
  const entries = await readdir(featuresDirPath, { withFileTypes: true })

  // 按模块名排序以保证确定性
  const moduleNames = entries
    .filter(e => e.isDirectory() && !shouldSkipDir(e.name))
    .map(e => e.name)
    .sort()

  // 第二遍：分析每个模块的导出和源文件
  for (const moduleName of moduleNames) {
    const modulePath = path.join(featuresDirPath, moduleName)
    const relativeModulePath = path.relative(projectPath, modulePath).replace(/\\/g, '/')

    // 扫描该模块的所有源文件
    const sourceFiles = await scanSourceFiles(modulePath, projectPath)

    // 收集导出符号
    const exports = []
    for (const filePath of sourceFiles) {
      try {
        const fullPath = path.join(projectPath, filePath)
        const content = await readFile(fullPath, 'utf-8')
        const fileExports = extractExports(content, filePath)
        exports.push(...fileExports)
      } catch {
        // 读文件失败，跳过
      }
    }

    // 统计行数
    let totalLines = 0
    for (const filePath of sourceFiles) {
      totalLines += await getLineCount(path.join(projectPath, filePath))
    }

    const module = {
      name: moduleName,
      path: relativeModulePath,
      files: sourceFiles,
      exports: [...new Set(exports)],  // 去重导出
      lines: totalLines,
      dependsOn: [],
      usedBy: []
    }

    modules.push(module)
    moduleMap.set(moduleName, module)
  }

  // 第三遍：构建依赖关系
  const edges = []
  const externalDeps = new Set()

  for (const module of modules) {
    const imports = new Set()

    // 分析该模块所有源文件的导入
    for (const filePath of module.files) {
      try {
        const fullPath = path.join(projectPath, filePath)
        const content = await readFile(fullPath, 'utf-8')
        const fileImports = extractImports(content)

        for (const importPath of fileImports) {
          imports.add(importPath)
        }
      } catch {
        // 读文件失败，跳过
      }
    }

    // 分析导入的模块
    for (const importPath of imports) {
      // 检查是否是相对路径（指向同项目的模块）
      if (!importPath.startsWith('.')) {
        // 外部依赖（如 lodash）
        externalDeps.add(importPath)
        continue
      }

      // 相对路径：解析指向哪个模块
      // 从当前模块的位置解析相对路径
      const moduleDirPath = path.join(projectPath, module.path)
      const resolvedPath = path.resolve(moduleDirPath, importPath)
      const resolvedRelative = path.relative(projectPath, resolvedPath).replace(/\\/g, '/')

      // 判断解析后的路径是否指向某个模块
      for (const targetModule of modules) {
        const targetModulePath = targetModule.path

        // 如果 resolvedRelative 路径包含或等于 targetModulePath，则是对该模块的依赖
        if (resolvedRelative.startsWith(targetModulePath + '/') || resolvedRelative.startsWith(targetModulePath)) {
          if (!module.dependsOn.includes(targetModule.name)) {
            module.dependsOn.push(targetModule.name)
          }
          if (!targetModule.usedBy.includes(module.name)) {
            targetModule.usedBy.push(module.name)
          }

          // 添加边
          if (!edges.find(e => e.from === module.name && e.to === targetModule.name)) {
            edges.push({
              from: module.name,
              to: targetModule.name,
              type: 'depends'
            })
          }

          break
        }
      }
    }
  }

  // 计算摘要
  let totalLines = 0
  let totalFiles = 0
  for (const module of modules) {
    totalLines += module.lines
    totalFiles += module.files.length
  }

  return {
    modules,
    edges,
    externalDeps: Array.from(externalDeps).sort(),
    summary: {
      totalModules: modules.length,
      totalFiles,
      totalLines
    }
  }
}
