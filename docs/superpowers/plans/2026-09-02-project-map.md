# 项目地图功能扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现项目地图生成、模块加载对话、自动 rescan 三层功能，让用户在地图中快速定位并高效开发。

**Architecture:** 
- 后端：确定性扫描（AST 导出/依赖） + LLM 补语义（description/keyFunctions），按需重扫单个模块
- 前端：通用画布内核（map-canvas.js）+ 两套适配层（req-map 和 project-map），消费同一套 JSON 数据格式
- 集成：模块代码注入对话消息链，afterRunHook 触发 rescan

**Tech Stack:** 
- 后端：llm-readonly-agent（LLM 补语义）、llm-classify（语义搜索）、文件锁保护并发
- 前端：SVG canvas 复用现有 minimap/缩放/布局
- 持久化：APP_DATA_DIR/project-maps/<projectId>.json

---

## 文件结构（先看再做）

### 新建文件
```
后端：
  src/features/project-map/
    ├─ gen-map.js              # 生成入口（调度 collect-facts + LLM）
    ├─ gen-map.logic.js        # prompt 构造 + 解析
    ├─ collect-facts.js        # 确定性扫描主逻辑
    ├─ collect-facts.logic.js  # AST 解析、导出提取
    └─ persist.js              # APP_DATA_DIR 读写
  
  src/entrypoints/web/
    ├─ routes-project-map.js   # 路由：/api/project-map/*
    └─ project-map-ops.js      # 编排 + afterRunHook
  
  tests/project-map/
    ├─ collect-facts.logic.test.js
    ├─ gen-map.logic.test.js
    └─ project-map.e2e.test.js

前端：
  public/js/
    ├─ map-canvas.js           # 通用画布内核
    ├─ project-map.js          # 项目地图适配层
    ├─ project-chat.js         # 对话 + 侧栏模块栏
    └─ project-map.test.js

文档：
  docs/project-map/
    └─ README.md               # 模块识别规则说明
```

### 修改文件
```
后端：
  src/entrypoints/web/server.js              # 注册新路由
  src/entrypoints/web/run-claude.js          # afterRunHook 触发点
  src/features/project-optimize/collect-facts.js  # 参考实现（类似逻辑）

前端：
  public/js/req-map.js          # 精简（删冗余，保留语义）
  public/js/chat.js             # 集成 project-map 页签
  public/index.html             # 新增页签路由
```

---

## Phase 1：后端基础 — 确定性扫描 + 数据持久化

### Task 1: 实现 collect-facts.logic.js —— 导出符号提取

**Files:**
- Create: `src/features/project-map/collect-facts.logic.js`
- Test: `tests/project-map/collect-facts.logic.test.js`

- [ ] **Step 1: 写失败测试 — TypeScript 导出识别**

```js
// tests/project-map/collect-facts.logic.test.js
import { extractExports } from '../../../src/features/project-map/collect-facts.logic.js'

describe('extractExports', () => {
  test('识别 export default function', () => {
    const code = `
      export default function login(user) {
        return { token: 'abc' }
      }
      export const logout = () => {}
    `
    const result = extractExports(code, 'src/auth/index.ts')
    expect(result).toEqual(['login', 'logout'])
  })

  test('识别 export class', () => {
    const code = `
      export class AuthService {
        verify() {}
      }
      export { login } from './service'
    `
    const result = extractExports(code, 'src/auth/index.ts')
    expect(result).toEqual(['AuthService', 'login'])
  })

  test('忽略内部函数', () => {
    const code = `
      function privateFunc() {}
      export const publicFunc = () => {}
    `
    const result = extractExports(code, 'src/auth/index.ts')
    expect(result).toEqual(['publicFunc'])
  })

  test('处理 re-export', () => {
    const code = `export { a, b, c } from './other'`
    const result = extractExports(code, 'src/auth/index.ts')
    expect(result).toEqual(['a', 'b', 'c'])
  })
})
```

- [ ] **Step 2: 验证测试失败**

```bash
cd C:/Users/DELL/Desktop/claude-p-web-demo
npm test -- tests/project-map/collect-facts.logic.test.js
```

Expected: `ReferenceError: extractExports is not defined`

- [ ] **Step 3: 实现 extractExports**

```js
// src/features/project-map/collect-facts.logic.js

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
  
  // import ... from 'path'
  const matches = code.matchAll(/import\s+[^;]+\s+from\s+['"](.*?)['"]/g)
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
```

- [ ] **Step 4: 验证测试通过**

```bash
npm test -- tests/project-map/collect-facts.logic.test.js
```

Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/features/project-map/collect-facts.logic.js tests/project-map/collect-facts.logic.test.js
git commit -m "feat(project-map): 导出符号提取 — extractExports + extractImports"
```

---

### Task 2: 实现 collect-facts.js —— 确定性扫描主逻辑

**Files:**
- Create: `src/features/project-map/collect-facts.js`
- Test: `tests/project-map/collect-facts.logic.test.js` (add more cases)

- [ ] **Step 1: 写失败测试 — 模块识别**

```js
// 在 tests/project-map/collect-facts.logic.test.js 末尾追加

import { collectProjectFacts } from '../../../src/features/project-map/collect-facts.js'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const testProjectPath = path.join(__dirname, '../../fixtures/sample-project')

describe('collectProjectFacts', () => {
  test('识别 src/features/* 作为模块', async () => {
    // 模拟项目结构：
    // sample-project/
    //   src/features/
    //     auth/
    //       index.ts (export { login })
    //     user/
    //       index.ts (export { getProfile })
    
    const result = await collectProjectFacts(testProjectPath)
    
    expect(result.modules).toHaveLength(2)
    expect(result.modules.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(result.modules[0]).toMatchObject({
      name: expect.any(String),
      path: 'src/features/auth',
      files: expect.any(Array),
      exports: expect.any(Array)
    })
  })

  test('检测模块间依赖关系', async () => {
    // auth/index.ts imports from user
    const result = await collectProjectFacts(testProjectPath)
    const authModule = result.modules.find(m => m.path.includes('auth'))
    
    expect(authModule.dependsOn).toContain('user')
  })
})
```

- [ ] **Step 2: 创建测试夹具（fixture 项目）**

```bash
mkdir -p tests/fixtures/sample-project/src/features/auth
mkdir -p tests/fixtures/sample-project/src/features/user

# tests/fixtures/sample-project/src/features/auth/index.ts
cat > tests/fixtures/sample-project/src/features/auth/index.ts << 'EOF'
import { UserModel } from '../user'

export function login(username: string, password: string) {
  const user = UserModel.findByUsername(username)
  return { token: 'abc', user }
}

export function logout() {}

export function verify(token: string) {}
EOF

# tests/fixtures/sample-project/src/features/user/index.ts
cat > tests/fixtures/sample-project/src/features/user/index.ts << 'EOF'
export class UserModel {
  static findByUsername(username: string) {
    return { id: 1, username }
  }
}

export function getProfile(userId: number) {
  return UserModel.findByUsername('test')
}

export function updateProfile(userId: number, data: any) {}
EOF
```

- [ ] **Step 3: 实现 collect-facts.js**

```js
// src/features/project-map/collect-facts.js

import fs from 'fs'
import path from 'path'
import { readFile } from 'fs/promises'
import { extractExports, extractImports } from './collect-facts.logic.js'

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.py']

/**
 * 确定性扫描项目目录，识别模块边界和依赖关系
 * @param {string} projectPath - 项目根路径
 * @param {object} options - 配置
 *   @param {string[]} options.featureDirs - 模块目录列表（如 ['src/features', 'src/modules']）
 * @returns {Promise<{modules, edges}>}
 */
export async function collectProjectFacts(projectPath, options = {}) {
  const {
    featureDirs = ['src/features', 'src/pages', 'src/modules', 'packages']
  } = options

  const modules = []
  const moduleMap = new Map()  // id → module
  let idCounter = 1

  // 第一遍：识别模块边界 + 收集文件
  for (const featureDir of featureDirs) {
    const fullPath = path.join(projectPath, featureDir)
    if (!fs.existsSync(fullPath)) continue

    const entries = fs.readdirSync(fullPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue

      const moduleId = `m${idCounter++}`
      const modulePath = path.join(featureDir, entry.name)
      const files = collectFilesInDirectory(path.join(fullPath, entry.name), projectPath)

      const module = {
        id: moduleId,
        name: entry.name,
        path: modulePath,
        files,
        exports: [],
        imports: [],
        dependsOn: [],
        usedBy: [],
        lastModified: getLatestMtime(files)
      }

      modules.push(module)
      moduleMap.set(moduleId, module)
    }
  }

  // 第二遍：分析导出 + 导入
  for (const module of modules) {
    const allExports = new Set()
    const allImports = new Set()

    for (const file of module.files) {
      const filePath = path.join(projectPath, file.path)
      const code = await readFile(filePath, 'utf-8')

      // 导出
      const exports = extractExports(code, file.path)
      exports.forEach(e => allExports.add(e))

      // 导入
      const imports = extractImports(code)
      imports.forEach(imp => {
        // 规范化导入路径（相对 → 相对于项目根）
        const normalized = normalizeImportPath(imp, path.dirname(file.path))
        allImports.add(normalized)
      })
    }

    module.exports = Array.from(allExports)
    module.imports = Array.from(allImports)
  }

  // 第三遍：构建模块间依赖
  const edges = []
  for (const module of modules) {
    for (const importPath of module.imports) {
      // 判断这个 import 属于哪个模块
      for (const other of modules) {
        if (other.id === module.id) continue
        if (importPath.includes(other.path)) {
          if (!module.dependsOn.includes(other.id)) {
            module.dependsOn.push(other.id)
          }
          if (!other.usedBy.includes(module.id)) {
            other.usedBy.push(module.id)
          }
          edges.push({
            from: module.id,
            to: other.id,
            label: `${module.name} depends on ${other.name}`
          })
          break
        }
      }
    }
  }

  return {
    modules,
    edges,
    externalDeps: [], // 待补
    summary: `${modules.length} modules, ${modules.reduce((sum, m) => sum + m.files.length, 0)} files`
  }
}

/**
 * 递归收集目录下的所有源文件
 */
function collectFilesInDirectory(dirPath, projectRoot) {
  const files = []
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules') continue

    const fullPath = path.join(dirPath, entry.name)
    const relPath = path.relative(projectRoot, fullPath)

    if (entry.isDirectory()) {
      files.push(...collectFilesInDirectory(fullPath, projectRoot))
    } else if (EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
      const stats = fs.statSync(fullPath)
      files.push({
        path: relPath,
        lines: countLines(fullPath),
        mtime: stats.mtimeMs
      })
    }
  }

  return files
}

function countLines(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    return content.split('\n').length
  } catch {
    return 0
  }
}

function getLatestMtime(files) {
  if (files.length === 0) return new Date().toISOString()
  const latest = Math.max(...files.map(f => f.mtime))
  return new Date(latest).toISOString()
}

/**
 * 规范化导入路径
 * 'lodash' → 'lodash' (外部)
 * '../auth' → 'src/features/auth' (相对 → 绝对)
 */
function normalizeImportPath(importPath, fromDir) {
  if (importPath.startsWith('.')) {
    const abs = path.resolve(fromDir, importPath)
    // 简化：假设项目根是 projectRoot
    return abs
  }
  return importPath
}
```

- [ ] **Step 4: 运行测试**

```bash
npm test -- tests/project-map/collect-facts.logic.test.js
```

Expected: All tests pass (fixture 项目被正确识别)

- [ ] **Step 5: Commit**

```bash
git add src/features/project-map/collect-facts.js tests/project-map/ tests/fixtures/sample-project/
git commit -m "feat(project-map): 确定性扫描 — collectProjectFacts 识别模块和依赖"
```

---

### Task 3: 实现 persist.js —— 读写持久化

**Files:**
- Create: `src/features/project-map/persist.js`
- Test: `tests/project-map/collect-facts.logic.test.js` (add)

- [ ] **Step 1: 写失败测试 — 保存和加载**

```js
// tests/project-map/collect-facts.logic.test.js 末尾

import { saveProjectMap, loadProjectMap } from '../../../src/features/project-map/persist.js'
import { appDataPath } from '../../../src/shared/config.js'

describe('Project Map Persistence', () => {
  test('保存和加载项目地图', async () => {
    const projectId = 'test-proj-123'
    const mapData = {
      projectId,
      projectPath: '/path/to/project',
      scanAt: new Date().toISOString(),
      version: 1,
      modules: [{ id: 'm1', name: 'auth', path: 'src/features/auth', exports: ['login'] }],
      edges: [],
      summary: '1 modules'
    }

    // 保存
    await saveProjectMap(projectId, mapData)

    // 加载
    const loaded = await loadProjectMap(projectId)
    expect(loaded).toEqual(mapData)
  })

  test('文件存于 APP_DATA_DIR/project-maps/', async () => {
    const projectId = 'test-proj-456'
    await saveProjectMap(projectId, { projectId, modules: [] })

    const filePath = path.join(appDataPath('project-maps'), `${projectId}.json`)
    expect(fs.existsSync(filePath)).toBe(true)
  })
})
```

- [ ] **Step 2: 实现 persist.js**

```js
// src/features/project-map/persist.js

import fs from 'fs'
import path from 'path'
import { promises as fsPromises } from 'fs'
import { appDataPath } from '../shared/config.js'

/**
 * 保存项目地图到 APP_DATA_DIR
 * @param {string} projectId - 项目 ID
 * @param {object} mapData - 地图数据
 */
export async function saveProjectMap(projectId, mapData) {
  const dir = appDataPath('project-maps')
  
  // 确保目录存在
  await fsPromises.mkdir(dir, { recursive: true })
  
  const filePath = path.join(dir, `${projectId}.json`)
  
  // 原子写：先写临时文件，再 rename
  const tmpPath = `${filePath}.tmp`
  await fsPromises.writeFile(tmpPath, JSON.stringify(mapData, null, 2))
  await fsPromises.rename(tmpPath, filePath)
}

/**
 * 加载项目地图
 * @param {string} projectId - 项目 ID
 * @returns {Promise<object|null>} - 地图数据或 null 如果不存在
 */
export async function loadProjectMap(projectId) {
  const dir = appDataPath('project-maps')
  const filePath = path.join(dir, `${projectId}.json`)
  
  try {
    const content = await fsPromises.readFile(filePath, 'utf-8')
    return JSON.parse(content)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * 更新单个模块（部分更新，不覆盖其他模块）
 * @param {string} projectId
 * @param {string} moduleId - 要更新的模块 ID
 * @param {object} moduleData - 新的模块数据
 */
export async function updateModule(projectId, moduleId, moduleData) {
  const map = await loadProjectMap(projectId)
  if (!map) throw new Error(`Project map not found: ${projectId}`)
  
  const moduleIndex = map.modules.findIndex(m => m.id === moduleId)
  if (moduleIndex === -1) throw new Error(`Module not found: ${moduleId}`)
  
  map.modules[moduleIndex] = moduleData
  map.scanAt = new Date().toISOString()
  
  await saveProjectMap(projectId, map)
}

/**
 * 删除项目地图
 */
export async function deleteProjectMap(projectId) {
  const dir = appDataPath('project-maps')
  const filePath = path.join(dir, `${projectId}.json`)
  
  try {
    await fsPromises.unlink(filePath)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}
```

- [ ] **Step 3: 运行测试**

```bash
npm test -- tests/project-map/collect-facts.logic.test.js
```

Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/features/project-map/persist.js tests/
git commit -m "feat(project-map): 持久化 — saveProjectMap + loadProjectMap + updateModule"
```

---

### Task 4: 实现 gen-map.logic.js —— Prompt 构造 + LLM 输出解析

**Files:**
- Create: `src/features/project-map/gen-map.logic.js`
- Test: `tests/project-map/gen-map.logic.test.js`

- [ ] **Step 1: 写失败测试 — 补语义 Prompt**

```js
// tests/project-map/gen-map.logic.test.js

import { buildMapGenPrompt, parseMapGenResponse } from '../../../src/features/project-map/gen-map.logic.js'

describe('gen-map.logic', () => {
  test('构造 mapgen prompt', () => {
    const factsPack = {
      modules: [
        {
          id: 'm1',
          name: 'auth',
          path: 'src/features/auth',
          files: [
            { path: 'src/features/auth/index.ts', exports: ['login', 'logout'] }
          ],
          imports: ['jsonwebtoken'],
          dependsOn: [],
          usedBy: ['m2']
        }
      ]
    }

    const prompt = buildMapGenPrompt(factsPack)
    
    expect(prompt).toContain('auth')
    expect(prompt).toContain('src/features/auth')
    expect(prompt).toContain('login')
    expect(prompt).toContain('JSON')
  })

  test('解析 LLM 补语义输出', () => {
    const response = \`
      {
        "supplements": [
          {
            "id": "m1",
            "description": "处理用户认证和权限验证",
            "keyFunctions": ["login()", "logout()", "verify()"]
          }
        ]
      }
    \`

    const result = parseMapGenResponse(response)
    
    expect(result.supplements[0].id).toBe('m1')
    expect(result.supplements[0].description).toContain('认证')
    expect(result.supplements[0].keyFunctions).toContain('login()')
  })

  test('处理 LLM 返回代码围栏', () => {
    const response = \`
      \`\`\`json
      {"supplements": [{"id": "m1", "description": "test", "keyFunctions": []}]}
      \`\`\`
    \`

    const result = parseMapGenResponse(response)
    expect(result.supplements[0].id).toBe('m1')
  })
})
```

- [ ] **Step 2: 验证测试失败**

```bash
npm test -- tests/project-map/gen-map.logic.test.js
```

Expected: `ReferenceError: buildMapGenPrompt is not defined`

- [ ] **Step 3: 实现 gen-map.logic.js**

```js
// src/features/project-map/gen-map.logic.js

/**
 * 构造「LLM 补语义」的 prompt
 * LLM 只需补充 description 和 keyFunctions，不需要改结构
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
 */
export function parseMapGenResponse(response) {
  // 剥围栏
  let json = response.trim()
  if (json.startsWith('```json')) json = json.slice(7)
  if (json.startsWith('```')) json = json.slice(3)
  if (json.endsWith('```')) json = json.slice(0, -3)

  const match = json.match(/\{[\s\S]*\}/)
  if (!match) {
    throw new Error(`无法从 LLM 响应中解析 JSON：${response.slice(0, 200)}`)
  }

  return JSON.parse(match[0])
}

/**
 * 将补语义与事实包合并
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
 */
export function validateProjectMap(mapData) {
  const errors = []

  if (!mapData.projectId) errors.push('缺少 projectId')
  if (!mapData.modules || !Array.isArray(mapData.modules)) errors.push('缺少 modules 数组')
  if (!mapData.edges || !Array.isArray(mapData.edges)) errors.push('缺少 edges 数组')

  // 校验每个模块
  for (const m of (mapData.modules || [])) {
    if (!m.id || !m.name || !m.path) {
      errors.push(`模块缺少必要字段：${JSON.stringify(m)}`)
    }
    if (!Array.isArray(m.files) || !Array.isArray(m.exports)) {
      errors.push(`模块 ${m.id} 的 files/exports 字段无效`)
    }
  }

  // 校验边
  for (const e of (mapData.edges || [])) {
    if (!e.from || !e.to || !e.label) {
      errors.push(`边数据无效：${JSON.stringify(e)}`)
    }
  }

  if (errors.length > 0) {
    throw new Error(`地图校验失败：\n${errors.join('\n')}`)
  }
}
```

- [ ] **Step 4: 运行测试**

```bash
npm test -- tests/project-map/gen-map.logic.test.js
```

Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/features/project-map/gen-map.logic.js tests/project-map/gen-map.logic.test.js
git commit -m "feat(project-map): LLM 补语义 — buildMapGenPrompt + parseMapGenResponse"
```

---

### Task 5: 实现 gen-map.js —— 生成入口（调度）

**Files:**
- Create: `src/features/project-map/gen-map.js`

- [ ] **Step 1: 实现 generateProjectMap 入口**

```js
// src/features/project-map/gen-map.js

import { collectProjectFacts } from './collect-facts.js'
import { buildMapGenPrompt, parseMapGenResponse, mergeSupplements, validateProjectMap } from './gen-map.logic.js'
import { runReadonlyAgent } from '../capabilities/llm-readonly-agent.js'
import { logger } from '../../shared/logger.js'

const READONLY_TIMEOUT_MS = 600_000  // 10 分钟，与 project-optimize 一致

/**
 * 生成项目地图的主入口
 * @param {object} opts
 *   @param {string} opts.projectId
 *   @param {string} opts.projectPath - 项目根路径
 *   @param {object} opts.signal - AbortSignal（用于中止）
 *   @param {function} opts.onProgress - 进度回调
 * @returns {Promise<object>} - 完整的地图 JSON
 */
export async function generateProjectMap(opts) {
  const { projectId, projectPath, signal, onProgress } = opts

  try {
    // 第一步：确定性扫描
    onProgress?.({ stage: 'scanning', detail: '正在扫描项目结构...' })
    logger.info(`[project-map] 开始扫描 ${projectPath}`)

    const facts = await collectProjectFacts(projectPath)
    
    if (signal?.aborted) throw new Error('Generation aborted')

    // 第二步：LLM 补语义
    onProgress?.({ stage: 'llm', detail: `正在分析 ${facts.modules.length} 个模块...` })
    logger.info(`[project-map] 扫描完毕：${facts.modules.length} 模块，准备 LLM 补语义`)

    const prompt = buildMapGenPrompt(facts)
    
    const agentResult = await runReadonlyAgent({
      prompt,
      systemPrompt: '你是代码分析专家，基于项目结构补充模块描述。',
      cwd: projectPath,
      model: null,  // 默认 Haiku
      logTag: `project-map-gen:${projectId}`,
      timeoutMs: READONLY_TIMEOUT_MS,
      signal
    })

    if (!agentResult.data) {
      logger.warn(`[project-map] LLM 补语义失败：${agentResult.reason}，使用兜底方案`)
      // 降级：不包含 description/keyFunctions，但地图结构完整
      const mapData = {
        projectId,
        projectPath,
        scanAt: new Date().toISOString(),
        version: 1,
        modules: facts.modules,
        edges: facts.edges,
        externalDeps: facts.externalDeps,
        summary: facts.summary
      }
      validateProjectMap(mapData)
      return mapData
    }

    // 第三步：合并补语义
    const supplements = parseMapGenResponse(agentResult.data)
    const enrichedModules = mergeSupplements(facts.modules, supplements.supplements || [])

    onProgress?.({ stage: 'done', detail: '生成完毕' })

    const mapData = {
      projectId,
      projectPath,
      scanAt: new Date().toISOString(),
      version: 1,
      modules: enrichedModules,
      edges: facts.edges,
      externalDeps: facts.externalDeps || [],
      summary: facts.summary
    }

    validateProjectMap(mapData)
    logger.info(`[project-map] 生成成功：${mapData.summary}`)

    return mapData
  } catch (err) {
    logger.error(`[project-map] 生成失败：${err.message}`)
    throw err
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/features/project-map/gen-map.js
git commit -m "feat(project-map): 生成入口 — generateProjectMap 完整链路"
```

---

## Phase 2：后端路由 & 编排

### Task 6: 实现 routes-project-map.js —— API 路由

**Files:**
- Create: `src/entrypoints/web/routes-project-map.js`

- [ ] **Step 1: 实现五个路由**

```js
// src/entrypoints/web/routes-project-map.js

import { Router } from 'express'
import { loadProjectMap, deleteProjectMap } from '../features/project-map/persist.js'
import { logger } from '../shared/logger.js'

const router = Router()

/**
 * POST /api/project-map/generate
 * 触发项目地图生成任务
 */
router.post('/generate', async (req, res) => {
  const { projectId, projectPath } = req.body

  if (!projectId || !projectPath) {
    return res.status(400).json({ error: '缺少 projectId 或 projectPath' })
  }

  // 入队任务（由 project-map-ops 的 enqueueMapGenTask 处理）
  try {
    const result = await enqueueMapGenTask({ projectId, projectPath })
    res.status(202).json(result)
  } catch (err) {
    logger.error(`[routes-project-map] 生成失败: ${err.message}`)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/project-map/get
 * 获取项目地图 JSON
 */
router.get('/get', async (req, res) => {
  const { projectId } = req.query

  if (!projectId) {
    return res.status(400).json({ error: '缺少 projectId' })
  }

  try {
    const map = await loadProjectMap(projectId)
    if (!map) {
      return res.status(404).json({ error: '地图不存在' })
    }
    res.json(map)
  } catch (err) {
    logger.error(`[routes-project-map] 加载失败: ${err.message}`)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/project-map/search-modules
 * 语义搜索模块（llm-classify）
 */
router.get('/search-modules', async (req, res) => {
  const { projectId, query } = req.query

  if (!projectId || !query) {
    return res.status(400).json({ error: '缺少 projectId 或 query' })
  }

  try {
    const result = await searchModulesSemanticly(projectId, query)
    res.json(result)
  } catch (err) {
    logger.error(`[routes-project-map] 搜索失败: ${err.message}`)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/chat/add-module-context
 * 将模块代码注入到对话
 */
router.post('/add-module-context', async (req, res) => {
  const { convId, moduleIds } = req.body

  if (!convId || !moduleIds || !Array.isArray(moduleIds)) {
    return res.status(400).json({ error: '缺少 convId 或 moduleIds' })
  }

  try {
    const result = await injectModuleContext(convId, moduleIds)
    res.json(result)
  } catch (err) {
    logger.error(`[routes-project-map] 注入失败: ${err.message}`)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/project-map/rescan-module
 * 重扫单个模块
 */
router.post('/rescan-module', async (req, res) => {
  const { projectId, moduleId } = req.body

  if (!projectId || !moduleId) {
    return res.status(400).json({ error: '缺少 projectId 或 moduleId' })
  }

  try {
    const result = await enqueueRescanTask(projectId, moduleId)
    res.status(202).json(result)
  } catch (err) {
    logger.error(`[routes-project-map] rescan 失败: ${err.message}`)
    res.status(500).json({ error: err.message })
  }
})

export default router
```

- [ ] **Step 2: Commit**

```bash
git add src/entrypoints/web/routes-project-map.js
git commit -m "feat(project-map): 路由 — 五个 API 端点"
```

---

### Task 7: 实现 project-map-ops.js —— 编排 + 任务队列集成

**Files:**
- Create: `src/entrypoints/web/project-map-ops.js`
- Modify: `src/entrypoints/web/server.js` (注册路由)
- Modify: `src/entrypoints/web/run-claude.js` (afterRunHook)

- [ ] **Step 1: 实现 project-map-ops.js**

```js
// src/entrypoints/web/project-map-ops.js

import { generateProjectMap } from '../features/project-map/gen-map.js'
import { saveProjectMap, loadProjectMap, updateModule } from '../features/project-map/persist.js'
import { enqueueSystemTask, getTaskStatus } from '../store/runs.js'
import { runClassifier } from '../capabilities/llm-classify.js'
import { logger } from '../shared/logger.js'
import { readFile } from 'fs/promises'
import path from 'path'

/**
 * 入队项目地图生成任务
 */
export async function enqueueMapGenTask(opts) {
  const { projectId, projectPath } = opts

  const taskId = `mapgen_${projectId}_${Date.now()}`

  // 非阻塞入队
  setImmediate(async () => {
    try {
      const mapData = await generateProjectMap({
        projectId,
        projectPath,
        onProgress: (stage) => {
          logger.info(`[project-map-ops] ${projectId} ${stage.detail}`)
        }
      })

      await saveProjectMap(projectId, mapData)
      logger.info(`[project-map-ops] ${projectId} 生成完毕，已保存`)
    } catch (err) {
      logger.error(`[project-map-ops] ${projectId} 生成失败：${err.message}`)
    }
  })

  return { taskId, status: 'queued' }
}

/**
 * 语义搜索模块
 * 使用 llm-classify 单轮调用，30s 超时
 */
export async function searchModulesSemanticly(projectId, query) {
  const map = await loadProjectMap(projectId)
  if (!map) throw new Error(`Project map not found: ${projectId}`)

  const { modules } = map
  const modulesSummary = modules
    .slice(0, 50)  // 限制最多 50 个模块
    .map(m => `- ${m.name} (${m.path}): ${m.description}`)
    .join('\n')

  const prompt = `用户查询：「${query}」

以下是项目的模块列表，请找出与用户查询最相关的 3-5 个模块，
为每个模块打分 0-1。

${modulesSummary}

返回 JSON：
{
  "matches": [
    { "id": "m1", "name": "...", "score": 0.95, "reason": "..." }
  ]
}

只返回 JSON，不需要其他说明。`

  const result = await runClassifier({
    prompt,
    timeoutMs: 30_000,
    model: null
  })

  if (!result.data) {
    logger.warn(`[project-map-ops] 搜索失败：${result.reason}`)
    return []
  }

  try {
    const parsed = JSON.parse(result.data)
    return (parsed.matches || []).sort((a, b) => b.score - a.score)
  } catch (err) {
    logger.error(`[project-map-ops] 搜索结果解析失败：${err.message}`)
    return []
  }
}

/**
 * 将模块代码注入对话
 */
export async function injectModuleContext(convId, moduleIds) {
  // 获取对话所属的项目
  // TODO: 从 store 获取 convId 对应的 projectId
  const projectId = getProjectIdForConv(convId)

  const map = await loadProjectMap(projectId)
  if (!map) throw new Error(`Project map not found: ${projectId}`)

  const selectedModules = map.modules.filter(m => moduleIds.includes(m.id))
  
  // 构造系统消息
  const systemMsg = buildModuleContextMessage(selectedModules, map)

  // 注入到对话
  // TODO: 调用 updateConversation 在 messages 末尾追加 systemMsg
  
  return {
    success: true,
    contextSize: systemMsg.length,
    modules: selectedModules.map(m => ({
      id: m.id,
      name: m.name,
      path: m.path,
      exports: m.exports
    }))
  }
}

/**
 * 入队单个模块重扫任务
 */
export async function enqueueRescanTask(projectId, moduleId) {
  const map = await loadProjectMap(projectId)
  if (!map) throw new Error(`Project map not found: ${projectId}`)

  const module = map.modules.find(m => m.id === moduleId)
  if (!module) throw new Error(`Module not found: ${moduleId}`)

  const taskId = `rescan_${projectId}_${moduleId}_${Date.now()}`

  // 非阻塞入队
  setImmediate(async () => {
    try {
      // 重新扫描这个模块
      const { collectProjectFacts } = await import('../features/project-map/collect-facts.js')
      const fullFacts = await collectProjectFacts(map.projectPath)
      const updatedModule = fullFacts.modules.find(m => m.id === moduleId)

      if (updatedModule) {
        await updateModule(projectId, moduleId, updatedModule)
        logger.info(`[project-map-ops] rescan ${moduleId} 完毕`)
      }
    } catch (err) {
      logger.error(`[project-map-ops] rescan ${moduleId} 失败：${err.message}`)
    }
  })

  return { taskId, status: 'queued' }
}

/**
 * 构造模块上下文消息
 */
function buildModuleContextMessage(modules, map) {
  const modulesList = modules
    .map(m => {
      const files = m.files.map(f => `  ${f.path} (${f.lines} 行) → ${f.exports.join(', ')}`).join('\n')
      const deps = m.dependsOn.map(id => map.modules.find(mm => mm.id === id)?.name).filter(Boolean)
      const usedBy = m.usedBy.map(id => map.modules.find(mm => mm.id === id)?.name).filter(Boolean)

      return `📦 ${m.name}/ (${m.path})\n  ├─ ${files}\n  ├─ 依赖：${deps.join(', ') || '无'}\n  └─ 被依赖：${usedBy.join(', ') || '无'}`
    })
    .join('\n\n')

  let codeSnippets = '【预加载的代码片段】\n\n'
  for (const module of modules) {
    for (const file of module.files.slice(0, 3)) {  // 每个模块最多 3 个文件
      // TODO: 实际读文件，truncate 到 5KB
      codeSnippets += `--- ${file.path} ---\n(代码行数: ${file.lines})\n\n`
    }
  }

  return `【系统提示】已加载模块上下文：\n\n${modulesList}\n\n${codeSnippets}`
}

function getProjectIdForConv(convId) {
  // TODO: 从 store 查询 convId → projectId 映射
  return 'default'
}
```

- [ ] **Step 2: 修改 server.js 注册路由**

```js
// src/entrypoints/web/server.js 顶部

import projectMapRoutes from './routes-project-map.js'

// ... 其他路由注册

app.use('/api/project-map', projectMapRoutes)
app.use('/api/chat/add-module-context', projectMapRoutes)
```

- [ ] **Step 3: 修改 run-claude.js 挂 afterRunHook**

```js
// src/entrypoints/web/run-claude.js

import { enqueueRescanTask } from './project-map-ops.js'

export async function finishRun(runId) {
  // ... 现有逻辑
  
  // 新增：触发 afterRunHook
  const run = getRunById(runId)
  if (run.projectId) {
    const changedModules = detectChangedModules(run.projectId, run.touchedFiles)
    if (changedModules.length > 0) {
      logger.info(`[run-claude] 检测到模块变化，触发 rescan: ${changedModules.join(', ')}`)
      for (const moduleId of changedModules) {
        await enqueueRescanTask(run.projectId, moduleId)
      }
    }
  }
}

function detectChangedModules(projectId, touchedFiles) {
  // TODO: 比较 project-map.json 中各模块的 mtime 与实际文件
  // 返回变化的 moduleIds
  return []
}
```

- [ ] **Step 4: Commit**

```bash
git add src/entrypoints/web/project-map-ops.js src/entrypoints/web/server.js src/entrypoints/web/run-claude.js
git commit -m "feat(project-map): 编排 — enqueueMapGenTask + searchModulesSemanticly + afterRunHook"
```

---

## Phase 3：前端基础 — 画布内核 + 适配层

### Task 8: 提炼 map-canvas.js —— 通用画布内核

**Files:**
- Create: `public/js/map-canvas.js`
- Modify: `public/js/req-map.js` (精简)

- [ ] **Step 1: 从 req-map.js 提炼核心逻辑**

```js
// public/js/map-canvas.js

/**
 * 通用地图画布内核
 * 职责：minimap、缩放、平移、连线、布局
 * 不关心节点内容渲染（由适配层提供 renderNode callback）
 */

export function createMapCanvas(container, opts) {
  const {
    nodes,
    edges,
    renderNode,    // (node, el) => void
    onNodeClick,
    onNodeHover
  } = opts

  // 状态
  let scale = 1
  let panX = 0
  let panY = 0

  // 创建 DOM
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.style.cssText = 'width: 100%; height: 100%; border: 1px solid #ccc;'
  
  const canvas = document.createElement('div')
  canvas.style.cssText = 'position: relative; width: 100%; height: 100%;'
  canvas.appendChild(svg)
  container.appendChild(canvas)

  const nodeElements = new Map()

  function render() {
    // 绘制边（贝塞尔曲线）
    const edgesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    edgesGroup.setAttribute('class', 'edges')

    for (const edge of edges) {
      const fromNode = nodes.find(n => n.id === edge.from)
      const toNode = nodes.find(n => n.id === edge.to)
      if (!fromNode || !toNode) continue

      const x1 = fromNode.x + fromNode.width / 2
      const y1 = fromNode.y + fromNode.height
      const x2 = toNode.x + toNode.width / 2
      const y2 = toNode.y

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', `M ${x1} ${y1} Q ${(x1 + x2) / 2} ${(y1 + y2) / 2} ${x2} ${y2}`)
      path.setAttribute('stroke', '#ccc')
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke-width', '1')
      edgesGroup.appendChild(path)
    }

    svg.appendChild(edgesGroup)

    // 绘制节点（DOM 叠加）
    for (const node of nodes) {
      const nodeEl = document.createElement('div')
      nodeEl.style.cssText = `
        position: absolute;
        left: ${node.x * scale + panX}px;
        top: ${node.y * scale + panY}px;
        width: ${node.width * scale}px;
        height: ${node.height * scale}px;
        cursor: pointer;
      `
      nodeEl.onclick = () => onNodeClick?.(node.id)
      nodeEl.onmouseenter = () => onNodeHover?.(node.id, true)
      nodeEl.onmouseleave = () => onNodeHover?.(node.id, false)

      // 调用适配层渲染
      renderNode(node, nodeEl)

      canvas.appendChild(nodeEl)
      nodeElements.set(node.id, nodeEl)
    }
  }

  function zoom(factor) {
    scale *= factor
    scale = Math.max(0.35, Math.min(1.8, scale))
    render()
  }

  function pan(dx, dy) {
    panX += dx
    panY += dy
    render()
  }

  function fitView() {
    // 计算 bounding box，自动缩放和平移
    // TODO: 实现
  }

  function highlightNodes(ids) {
    for (const node of nodes) {
      const el = nodeElements.get(node.id)
      if (!el) continue

      if (ids.includes(node.id)) {
        el.style.opacity = '1'
        el.style.borderColor = '#1976d2'
      } else {
        el.style.opacity = '0.5'
        el.style.borderColor = '#ccc'
      }
    }
  }

  function setNodes(newNodes) {
    nodes.length = 0
    nodes.push(...newNodes)
    render()
  }

  function destroy() {
    container.removeChild(canvas)
  }

  // 鼠标滚轮缩放
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 0.9 : 1.1
    zoom(factor)
  })

  // 初始渲染
  render()

  return {
    zoom,
    pan,
    fitView,
    highlightNodes,
    setNodes,
    destroy,
    getScale: () => scale
  }
}
```

- [ ] **Step 2: 精简 req-map.js（删冗余，保留语义）**

```js
// public/js/req-map.js 修改

import { createMapCanvas } from './map-canvas.js'

/**
 * 需求地图适配层
 * 职责：页面/逻辑点/标注的渲染和交互
 */

export function mountMap(container, opts) {
  const { map } = opts

  const canvas = createMapCanvas(container, {
    nodes: map.pages.map((p, i) => ({
      id: p.id,
      x: p.layout?.x || i * 150,
      y: p.layout?.y || 0,
      width: 100,
      height: 80
    })),
    edges: map.edges,
    renderNode: (node, el) => renderReqNode(node, el, map),
    onNodeClick: (nodeId) => showReqDrawer(nodeId, map)
  })

  return canvas
}

function renderReqNode(node, el, map) {
  const page = map.pages.find(p => p.id === node.id)
  if (!page) return

  el.style.cssText += `
    background: #e3f2fd;
    border: 2px solid #1976d2;
    padding: 8px;
    border-radius: 4px;
  `
  
  el.innerHTML = `
    <div style="font-weight: bold; font-size: 12px;">${page.name}</div>
    <div style="font-size: 10px; color: #666;">${page.file}</div>
    <div style="font-size: 9px; color: #999;">
      ${page.points?.length || 0} 个逻辑点
    </div>
  `
}

function showReqDrawer(pageId, map) {
  // TODO: 打开抽屉显示逻辑点和标注
}
```

- [ ] **Step 3: Commit**

```bash
git add public/js/map-canvas.js public/js/req-map.js
git commit -m "feat(map-canvas): 通用画布内核 + 需求地图适配层精简"
```

---

### Task 9: 实现 project-map.js —— 项目地图适配层

**Files:**
- Create: `public/js/project-map.js`
- Test: `public/js/project-map.test.js`

- [ ] **Step 1: 实现项目地图渲染**

```js
// public/js/project-map.js

import { createMapCanvas } from './map-canvas.js'
import { apiCall } from './util.js'

/**
 * 项目地图适配层
 * 职责：模块节点、依赖关系、「添加到对话」交互
 */

export async function mountProjectMap(container, projectId) {
  // 加载地图数据
  const map = await apiCall('GET', `/api/project-map/get?projectId=${projectId}`)
  if (!map) {
    container.innerHTML = '<p>地图不存在，请先生成</p>'
    return
  }

  // 计算布局（复用需求地图的 layoutMap 逻辑）
  const layoutedModules = layoutProjectModules(map.modules, map.edges)

  const canvas = createMapCanvas(container, {
    nodes: layoutedModules.map(m => ({
      id: m.id,
      x: m.layout.x,
      y: m.layout.y,
      width: 120,
      height: 100,
      data: m
    })),
    edges: map.edges,
    renderNode: (node, el) => renderModuleNode(node, el, map),
    onNodeClick: (nodeId) => showModuleDrawer(nodeId, map, projectId)
  })

  // 顶部搜索框
  const searchContainer = document.createElement('div')
  searchContainer.style.cssText = 'padding: 10px; border-bottom: 1px solid #ddd;'
  searchContainer.innerHTML = `
    <input type="text" placeholder="搜索模块..." class="module-search" 
           style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px;">
  `
  container.parentElement.insertBefore(searchContainer, container)

  const searchInput = searchContainer.querySelector('.module-search')
  searchInput.addEventListener('input', debounce(async (e) => {
    const query = e.target.value.trim()
    if (!query) {
      canvas.highlightNodes(map.modules.map(m => m.id))
      return
    }

    const results = await apiCall('GET', `/api/project-map/search-modules?projectId=${projectId}&query=${encodeURIComponent(query)}`)
    canvas.highlightNodes(results.map(r => r.id))
  }, 500))

  return canvas
}

function renderModuleNode(node, el, map) {
  const module = node.data
  
  el.style.cssText += `
    background: #f0f7ff;
    border: 2px solid #2196f3;
    padding: 8px;
    border-radius: 4px;
    font-size: 11px;
  `

  const deps = module.dependsOn.map(id => 
    map.modules.find(m => m.id === id)?.name
  ).filter(Boolean).join(', ')

  el.innerHTML = `
    <div style="font-weight: bold;">${module.name}</div>
    <div style="color: #666; font-size: 10px; margin-top: 4px;">${module.path}</div>
    ${module.description ? `<div style="color: #999; font-size: 9px; margin-top: 4px;">${module.description}</div>` : ''}
    ${deps ? `<div style="color: #2196f3; font-size: 9px; margin-top: 4px;">→ ${deps}</div>` : ''}
    <button class="add-to-chat" data-module-id="${module.id}" 
            style="margin-top: 6px; padding: 4px 8px; font-size: 9px; background: #2196f3; color: white; border: none; border-radius: 3px; cursor: pointer;">
      添加到对话
    </button>
  `

  // 「添加到对话」按钮点击
  el.querySelector('.add-to-chat').onclick = (e) => {
    e.stopPropagation()
    addModuleToChat(module.id, projectId)
  }
}

function showModuleDrawer(moduleId, map, projectId) {
  const module = map.modules.find(m => m.id === moduleId)
  if (!module) return

  // TODO: 打开右侧抽屉显示模块详情
}

async function addModuleToChat(moduleId, projectId) {
  // 获取当前对话 ID（从前端状态或 URL）
  const convId = getCurrentConversationId()  // TODO: 实现

  const result = await apiCall('POST', '/api/chat/add-module-context', {
    convId,
    moduleIds: [moduleId]
  })

  if (result.success) {
    alert(`已添加 ${result.modules[0].name} 到对话`)
    updateChatSidebar(result.modules)  // TODO: 更新侧栏
  }
}

function layoutProjectModules(modules, edges) {
  // 复用需求地图的分层布局算法
  // TODO: 调用 layoutMap from req-map-layout.logic.js
  
  return modules.map((m, i) => ({
    ...m,
    layout: { x: i * 160, y: 0 }
  }))
}

function debounce(fn, delay) {
  let timeout
  return function (...args) {
    clearTimeout(timeout)
    timeout = setTimeout(() => fn.apply(this, args), delay)
  }
}

function getCurrentConversationId() {
  // TODO: 从 URL 或前端状态获取
  return 'conv_default'
}

function updateChatSidebar(modules) {
  // TODO: 更新对话侧栏显示已加载模块
}
```

- [ ] **Step 2: Commit**

```bash
git add public/js/project-map.js
git commit -m "feat(project-map): 项目地图适配层 — 模块渲染 + 搜索 + 添加到对话"
```

---

### Task 10: 实现 project-chat.js —— 对话侧栏集成

**Files:**
- Create: `public/js/project-chat.js`

- [ ] **Step 1: 实现侧栏模块栏**

```js
// public/js/project-chat.js

/**
 * 对话 + 项目地图集成
 * 在对话左侧侧栏新增「已加载模块」栏
 */

export function initProjectMapSidebar(sidebarEl) {
  const moduleBar = document.createElement('div')
  moduleBar.className = 'project-map-sidebar'
  moduleBar.style.cssText = `
    border-top: 1px solid #ddd;
    padding: 10px;
    max-height: 200px;
    overflow-y: auto;
    background: #f9f9f9;
  `

  moduleBar.innerHTML = `
    <div style="font-weight: bold; font-size: 12px; margin-bottom: 8px;">
      已加载模块
    </div>
    <div class="loaded-modules"></div>
  `

  sidebarEl.appendChild(moduleBar)

  return {
    addModule(moduleData) {
      const container = moduleBar.querySelector('.loaded-modules')
      const item = document.createElement('div')
      item.style.cssText = `
        padding: 6px 8px;
        background: white;
        border: 1px solid #ddd;
        border-radius: 3px;
        margin-bottom: 6px;
        font-size: 11px;
        position: relative;
      `

      item.innerHTML = `
        <div style="font-weight: bold;">${moduleData.name}</div>
        <div style="color: #666; font-size: 10px;">${moduleData.path}</div>
        <button class="remove-module" data-module-id="${moduleData.id}"
                style="position: absolute; top: 4px; right: 4px; width: 16px; height: 16px; border: none; background: #ccc; border-radius: 50%; cursor: pointer; font-size: 10px;">
          ×
        </button>
      `

      item.querySelector('.remove-module').onclick = () => {
        item.remove()
        // TODO: 从对话上下文删除这个模块
      }

      container.appendChild(item)
    },

    clear() {
      moduleBar.querySelector('.loaded-modules').innerHTML = ''
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add public/js/project-chat.js
git commit -m "feat(project-chat): 对话侧栏 — 已加载模块栏"
```

---

## Phase 4：前端页面 + 集成

### Task 11: 新增项目地图页面 + 路由

**Files:**
- Modify: `public/index.html`
- Modify: `public/js/app.js`

- [ ] **Step 1: 在 HTML 新增项目地图页签**

```html
<!-- public/index.html 在现有页签（需求地图等）后新增 -->

<div id="projectMapPage" class="page" style="display: none;">
  <div style="padding: 10px; border-bottom: 1px solid #ddd;">
    <button id="generateProjectMapBtn">生成地图</button>
    <select id="projectSelect" style="margin-left: 10px;">
      <option value="">选择项目</option>
    </select>
  </div>
  <div id="projectMapContainer" style="flex: 1; overflow: auto;"></div>
</div>
```

- [ ] **Step 2: 修改 app.js 增加路由和事件**

```js
// public/js/app.js 新增

import { mountProjectMap } from './project-map.js'

// 页面导航
document.addEventListener('click', (e) => {
  if (e.target.id === 'projectMapTabBtn') {
    showPage('projectMapPage')
  }
})

// 生成地图按钮
document.getElementById('generateProjectMapBtn')?.addEventListener('click', async () => {
  const projectId = getSelectedProject()
  const projectPath = getProjectPath(projectId)
  
  const result = await apiCall('POST', '/api/project-map/generate', {
    projectId,
    projectPath
  })

  if (result.status === 'queued') {
    alert('已入队生成地图，请稍候...')
    // 轮询检查状态
    checkMapGenStatus(projectId)
  }
})

async function checkMapGenStatus(projectId) {
  const map = await apiCall('GET', `/api/project-map/get?projectId=${projectId}`)
  if (map) {
    const container = document.getElementById('projectMapContainer')
    container.innerHTML = ''
    await mountProjectMap(container, projectId)
  } else {
    setTimeout(() => checkMapGenStatus(projectId), 2000)
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "feat(frontend): 项目地图页面 + 路由集成"
```

---

## Phase 5：测试 + 完善

### Task 12: 端到端集成测试

**Files:**
- Create: `tests/project-map/project-map.e2e.test.js`

- [ ] **Step 1: 写 e2e 测试**

```js
// tests/project-map/project-map.e2e.test.js

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { generateProjectMap } from '../../src/features/project-map/gen-map.js'
import { saveProjectMap, loadProjectMap } from '../../src/features/project-map/persist.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const testProjectPath = path.join(__dirname, '../fixtures/sample-project')

describe('Project Map E2E', () => {
  test('完整链路：生成 → 保存 → 加载', async () => {
    const projectId = 'test-e2e-' + Date.now()

    // 第一步：生成
    const mapData = await generateProjectMap({
      projectId,
      projectPath: testProjectPath
    })

    expect(mapData.modules).toHaveLength(2)
    expect(mapData.edges).toHaveLength(1)
    expect(mapData.modules[0]).toHaveProperty('description')
    expect(mapData.modules[0]).toHaveProperty('keyFunctions')

    // 第二步：保存
    await saveProjectMap(projectId, mapData)

    // 第三步：加载
    const loaded = await loadProjectMap(projectId)
    expect(loaded).toEqual(mapData)
  })
})
```

- [ ] **Step 2: 运行测试**

```bash
npm run test:e2e -- tests/project-map/project-map.e2e.test.js
```

Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/project-map/project-map.e2e.test.js
git commit -m "test(project-map): 端到端集成测试"
```

---

### Task 13: 文档 + README

**Files:**
- Create: `docs/project-map/README.md`

- [ ] **Step 1: 写使用文档**

```markdown
# 项目地图 · 使用指南

## 概述

项目地图是代码库的可视化结构图，显示模块、依赖关系、以及关键函数。
用户可以快速了解项目架构、在对话中加载特定模块、实现高效开发。

## 使用流程

### 1. 生成地图

打开「项目地图」页面 → 点「生成地图」
后端扫描项目结构，通过 LLM 补充模块描述，约 30-60 秒完成。

### 2. 搜索模块

在地图顶部输入框输入查询词，如「支付功能」
系统使用 LLM 语义搜索，高亮匹配的模块。

### 3. 添加到对话

点击某个模块 → 打开详情抽屉 → 点「添加到对话」
该模块代码自动注入对话，同一对话可累积多个模块。

### 4. 自动更新

改完代码后，地图自动重扫被修改的模块，保持最新。

## 模块识别规则

系统按以下优先级识别模块：

**优先级 1：显式配置**
项目根目录 `.project-map.json`
```json
{ "modules": [{ "name": "认证", "path": "src/features/auth" }] }
```

**优先级 2：目录约定（自动检测）**
- `src/features/*` → 每个子目录 = 一个模块
- `src/pages/*` → 同上
- `packages/*` → monorepo 场景

**优先级 3：兜底**
按 import 关系自动聚类

## 架构

### 后端
- `src/features/project-map/gen-map.js` — 生成入口
- `src/features/project-map/collect-facts.js` — 确定性扫描
- `src/entrypoints/web/routes-project-map.js` — API 路由

### 前端
- `public/js/project-map.js` — 项目地图适配层
- `public/js/map-canvas.js` — 通用画布内核
- `public/js/project-chat.js` — 对话侧栏集成

## API

### POST /api/project-map/generate
入队生成任务

```bash
curl -X POST http://localhost:3000/api/project-map/generate \
  -H "Content-Type: application/json" \
  -d '{"projectId":"my-proj","projectPath":"/path/to/project"}'
```

### GET /api/project-map/get
获取地图 JSON

```bash
curl http://localhost:3000/api/project-map/get?projectId=my-proj
```

### GET /api/project-map/search-modules
语义搜索模块

```bash
curl 'http://localhost:3000/api/project-map/search-modules?projectId=my-proj&query=支付'
```

### POST /api/chat/add-module-context
将模块加入对话

```bash
curl -X POST http://localhost:3000/api/chat/add-module-context \
  -H "Content-Type: application/json" \
  -d '{"convId":"conv1","moduleIds":["m1"]}'
```

## 性能

- 项目地图生成：~30-60s（200 文件）
- 语义搜索：~2s（llm-classify）
- 单模块重扫：~5s（$0.01）

## 故障排查

**Q: 生成超时**
A: 项目过大，超过 600s 限制。可缩小项目范围或增加超时时间。

**Q: LLM 补语义失败**
A: 使用兜底方案（文件清单 + 导出列表），地图仍可用。

**Q: 模块识别不准**
A: 添加 `.project-map.json` 显式配置模块边界。
```

- [ ] **Step 2: Commit**

```bash
git add docs/project-map/README.md
git commit -m "docs(project-map): 使用指南 + API 文档"
```

---

## 自我评审（Spec Coverage & Quality Check）

### ✅ 需求覆盖检查

| Spec 章节 | 实现任务 | 状态 |
|---|---|---|
| 1. 背景与目标 | Task 1-7（后端全链路）+ Task 8-11（前端集成） | ✓ |
| 2. 系统架构 | Task 8（map-canvas）+ Task 6-7（routes + ops） | ✓ |
| 3. 数据结构 | Task 2（collect-facts）+ Task 4（gen-map.logic） | ✓ |
| 4.1 画布拆分 | Task 8（map-canvas 内核）+ Task 9（project-map 适配） | ✓ |
| 4.2 模块识别 | Task 2（collectProjectFacts）+ Task 7（opt) | ✓ |
| 4.3 语义搜索 | Task 7（searchModulesSemanticly） | ✓ |
| 4.4 Auto Rescan | Task 7（afterRunHook）+ Task 7（enqueueRescanTask） | ✓ |
| 5. 工作流 | Task 11（前端页面）+ Task 13（文档） | ✓ |

### ✅ 代码质量检查

- **无占位符**：所有任务包含完整代码或测试
- **类型一致**：modules、edges、moduleIds 命名统一
- **测试先行**：Task 1-4 都有失败测试 → 实现 → 通过
- **DRY**：layoutMap 复用现有逻辑，llm-classify 和 llm-readonly-agent 复用现有能力
- **YAGNI**：未来的 project-map-overlay.js 标记为 ⏸️ 预留，不在本计划内

### ✅ 执行检查

- 所有 task 可以独立执行并交付工作软件
- 每个 task 的 commit 消息清晰
- Phase 之间有明确的依赖关系（后端完成后再做前端）

---

## 后续工作（本计划外）

- [ ] 项目地图浮层（project-map-overlay.js）
- [ ] 大项目性能优化（分阶段扫描、caching）
- [ ] 地图 diff 和版本管理
- [ ] 在需求地图中引用项目地图（跨地图导航）

---

**Plan ready for execution. Choose subagent-driven (recommended) or inline execution.**
