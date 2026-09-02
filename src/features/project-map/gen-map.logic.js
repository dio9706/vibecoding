/**
 * 构造「LLM 补语义」的 prompt
 * LLM 只需补充 description 和 keyFunctions，不需要改结构
 * @param {object} factsPack - {modules: [{id, name, path, files, imports, dependsOn, usedBy}]}
 * @returns {string} 中文 Prompt
 */
export function buildMapGenPrompt(factsPack) {
  const { modules } = factsPack

  const modulesSummary = modules.map(m => {
    const filesList = m.files
      .map(f => `  - ${f.path}: ${f.exports.join(', ')}`)
      .join('\n')

    return `【${m.name}】(${m.path})
${filesList}
导入：${m.imports.join(', ') || '无'}
被依赖：${m.usedBy.map(id => modules.find(mm => mm.id === id)?.name).join(', ') || '无'}`
  }).join('\n\n')

  return `你是一个代码分析专家。基于以下项目的模块结构和文件导出，
为每个模块补充中文描述和关键函数列表。

项目模块列表：
${modulesSummary}

请返回 JSON 格式的补充信息。每个模块的 description 应该简明扼要（1-2 句），
keyFunctions 应该列出 3-5 个最关键的函数/方法。

返回格式（务必是有效的 JSON）：
{
  "supplements": [
    {
      "id": "m1",
      "description": "...",
      "keyFunctions": ["func1()", "func2()", ...]
    }
  ]
}

只返回 JSON，不需要其他说明。`
}

/**
 * 解析 LLM 返回的补语义响应
 * @param {string} response - LLM 返回的原始文本（可能含代码围栏）
 * @returns {object} JSON 对象 {supplements: [{id, description, keyFunctions}]}
 * @throws {Error} 解析失败时抛错，附加诊断信息
 */
export function parseMapGenResponse(response) {
  let json = response.trim()

  // 剥除 markdown 代码围栏
  if (json.startsWith('```json')) {
    json = json.slice(7)
  }
  if (json.startsWith('```')) {
    json = json.slice(3)
  }
  if (json.endsWith('```')) {
    json = json.slice(0, -3)
  }

  // 找首个 { 到末个 }
  const match = json.match(/\{[\s\S]*\}/)
  if (!match) {
    throw new Error(`无法从 LLM 响应中解析 JSON：${response.slice(0, 200)}`)
  }

  try {
    return JSON.parse(match[0])
  } catch (err) {
    throw new Error(`JSON 解析失败：${err.message}，原文：${response.slice(0, 200)}`)
  }
}

/**
 * 将补语义与事实包合并
 * @param {array} modules - 来自 Task 2 的模块数组
 * @param {array} supplements - 来自 LLM 的补语义数组
 * @returns {array} 合并后的模块数组，每个新增 description 和 keyFunctions
 */
export function mergeSupplements(modules, supplements) {
  const supplementMap = new Map(supplements.map(s => [s.id, s]))

  return modules.map(m => ({
    ...m,
    description: supplementMap.get(m.id)?.description || '(待补充)',
    keyFunctions: supplementMap.get(m.id)?.keyFunctions || []
  }))
}

/**
 * 校验生成的地图数据
 * @param {object} mapData - 完整的地图数据
 * @throws {Error} 校验失败时抛错，包含所有错误清单
 */
export function validateProjectMap(mapData) {
  const errors = []

  if (!mapData.projectId) errors.push('缺少 projectId')
  if (!mapData.modules || !Array.isArray(mapData.modules)) errors.push('缺少 modules 数组')
  if (!mapData.edges || !Array.isArray(mapData.edges)) errors.push('缺少 edges 数组')

  // 校验每个模块
  for (const m of (mapData.modules || [])) {
    if (!m.id || !m.name || !m.path) {
      errors.push(`模块缺少必要字段（id/name/path）：${JSON.stringify(m)}`)
    }
    if (!Array.isArray(m.files) || !Array.isArray(m.exports)) {
      errors.push(`模块 ${m.id} 的 files/exports 字段无效`)
    }
  }

  // 校验边
  for (const e of (mapData.edges || [])) {
    if (!e.from || !e.to) {
      errors.push(`边数据无效（缺少 from/to）：${JSON.stringify(e)}`)
    }
  }

  if (errors.length > 0) {
    throw new Error(`地图校验失败：\n${errors.join('\n')}`)
  }
}
