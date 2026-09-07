/**
 * LLM 没能给出描述时的占位符。
 * 增量复用要靠它区分「真描述」与「降级占位」，写死字面量会两处漂移，故收成常量。
 */
export const PLACEHOLDER_DESC = '(待补充)'

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

    // 必须把 id 明写给模型：mergeSupplements 是按 id 匹配回填的，
    // 模型不知道 id 就只能瞎编，回来的 supplements 一条也对不上，描述全成「(待补充)」。
    return `【${m.name}】id=${m.id} (${m.path})
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

**id 必须原样照抄上面每个模块的 id=，不要自己编号**，否则补充信息无法回填。
上面列出的每个模块都要有一条对应的补充。

返回格式（务必是有效的 JSON）：
{
  "supplements": [
    {
      "id": "上面给出的 id，原样照抄",
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
 * 增量选材：按指纹把模块分成「可复用上一版描述」和「需要重新描述」两堆。
 *
 * 为什么值得做：整条生成链里扫描是零成本的（几百毫秒、不花 token），贵的只有补语义。
 * 全量重描 21 个模块和只描 2 个改动模块，token 差一个数量级。
 *
 * 判据是三个条件同时成立才复用：指纹一致、上一版存在、且上一版描述是真货。
 * 最后一条不能省——上一版可能因为 LLM 调用失败而降级成 '(待补充)'，
 * 那种占位符要是被当成"已有描述"复用，模块就再也等不到真正的描述了。
 *
 * @param {array} modules 本次扫描出的模块（带 fingerprint）
 * @param {object|null} previous 上一版地图
 * @returns {{reused: array, stale: array}} reused 是可直接并入的 supplement 条目，stale 是待送 LLM 的模块
 */
export function splitByFingerprint(modules, previous) {
  const prevById = new Map((previous?.modules || []).map(m => [m.id, m]))
  const reused = []
  const stale = []

  for (const m of modules) {
    const old = prevById.get(m.id)
    const hasRealDesc = !!old?.description && old.description !== PLACEHOLDER_DESC
    if (old && m.fingerprint && old.fingerprint === m.fingerprint && hasRealDesc) {
      reused.push({ id: m.id, description: old.description, keyFunctions: old.keyFunctions || [] })
    } else {
      stale.push(m)
    }
  }
  return { reused, stale }
}

/**
 * 将补语义与事实包合并
 * @param {array} modules - 扫描出的模块数组
 * @param {array} supplements - 补语义数组（LLM 新产出的 + 增量复用的）
 * @returns {array} 合并后的模块数组，每个新增 description 和 keyFunctions
 */
export function mergeSupplements(modules, supplements) {
  const supplementMap = new Map(supplements.map(s => [s.id, s]))

  return modules.map(m => ({
    ...m,
    description: supplementMap.get(m.id)?.description || PLACEHOLDER_DESC,
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
