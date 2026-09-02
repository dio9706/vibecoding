/**
 * 项目地图持久化层 — 四个原子操作：保存/加载/部分更新/删除
 * 存储路径：APP_DATA_DIR/project-maps/<projectId>.json
 *
 * 原子性：saveProjectMap 先写 .tmp 再 rename，避免部分写入。
 * 错误策略：读不存在的文件返回 null（不抛错），其他错误才抛错。
 */

import { mkdir, readFile, writeFile, unlink, rename as fsRename } from 'node:fs/promises'
import path from 'node:path'
import { appDataPath } from '../../shared/app-paths.js'

/**
 * 获取地图文件的存储路径
 */
function getMapFilePath(projectId) {
  return appDataPath('project-maps', `${projectId}.json`)
}

/**
 * 保存项目地图 — 原子写入：先写 .tmp 再 rename
 * @param {string} projectId
 * @param {object} mapData - 地图数据对象
 * @returns {Promise<void>}
 */
export async function saveProjectMap(projectId, mapData) {
  const filePath = getMapFilePath(projectId)
  const tmpPath = `${filePath}.tmp`

  // 确保目录存在
  const dirPath = path.dirname(filePath)
  await mkdir(dirPath, { recursive: true })

  // 序列化为 JSON
  const content = JSON.stringify(mapData, null, 2)

  // 先写临时文件，再原子 rename
  await writeFile(tmpPath, content, 'utf-8')
  await renameAtomic(tmpPath, filePath)
}

/**
 * rename 兼容层：Windows 上若目标文件已存在会报 EEXIST，需先删再 rename
 */
async function renameAtomic(oldPath, newPath) {
  try {
    await fsRename(oldPath, newPath)
  } catch (err) {
    // Windows 环境下文件已存在会报 EEXIST 或 EPERM，先删目标再 rename
    if (err.code === 'EEXIST' || err.code === 'EPERM') {
      try {
        await unlink(newPath)
      } catch {
        // 目标文件不存在或无法删除，继续
      }
      await fsRename(oldPath, newPath)
    } else {
      throw err
    }
  }
}

/**
 * 加载项目地图 — 读文件，不存在返回 null（不抛错）
 * @param {string} projectId
 * @returns {Promise<object|null>}
 */
export async function loadProjectMap(projectId) {
  const filePath = getMapFilePath(projectId)

  try {
    const content = await readFile(filePath, 'utf-8')
    return JSON.parse(content)
  } catch (err) {
    // 文件不存在返回 null
    if (err.code === 'ENOENT') {
      return null
    }
    // 其他错误抛出
    throw err
  }
}

/**
 * 部分更新单个模块 — 先读全部模块，修改一个，再整体写回
 * 同时更新 scanAt 时间戳
 * @param {string} projectId
 * @param {string} moduleId - 模块 ID
 * @param {object} moduleData - 模块数据（会覆盖同 ID 的模块）
 * @returns {Promise<void>}
 */
export async function updateModule(projectId, moduleId, moduleData) {
  // 读取完整的地图
  const mapData = await loadProjectMap(projectId)
  if (!mapData) {
    throw new Error(`Project map not found for project: ${projectId}`)
  }

  // 确保 modules 是数组
  if (!Array.isArray(mapData.modules)) {
    mapData.modules = []
  }

  // 查找或创建模块
  const moduleIndex = mapData.modules.findIndex(m => m.id === moduleId)
  if (moduleIndex >= 0) {
    // 替换现有模块
    mapData.modules[moduleIndex] = moduleData
  } else {
    // 追加新模块
    mapData.modules.push(moduleData)
  }

  // 更新 scanAt 时间戳
  mapData.scanAt = new Date().toISOString()

  // 写回整个地图
  await saveProjectMap(projectId, mapData)
}

/**
 * 删除项目地图文件
 * @param {string} projectId
 * @returns {Promise<void>}
 */
export async function deleteProjectMap(projectId) {
  const filePath = getMapFilePath(projectId)

  try {
    await unlink(filePath)
  } catch (err) {
    // 文件不存在也不算错误
    if (err.code !== 'ENOENT') {
      throw err
    }
  }
}
