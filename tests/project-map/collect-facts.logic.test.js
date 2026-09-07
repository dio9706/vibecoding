import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 项目地图的扫描与持久化回归。
 *
 * 原先这里还有一批 extractExports / extractImports 的单测，测的是 project-map 自己那份
 * 抽取器。该实现已删除、改为复用 project-checkup/evidence 下的版本（旧版实测漏抽全部
 * export async function、不认动态 import、且会把注释里的 export 当真代码），
 * 对应的单测也随宿主一起迁走 —— 抽取器的行为由 symbols.logic.test.js /
 * selectors-project.logic.test.js 钉住，不该在这里再维护第二份口径。
 */

test('collectProjectFacts: 识别 src/features/* 作为模块', async () => {
  const { collectProjectFacts } = await import('../../src/features/project-map/collect-facts.js')
  const projectPath = new URL('../../tests/fixtures/sample-project', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')

  const result = await collectProjectFacts(projectPath)

  // 应该有 2 个模块：auth 和 user
  assert.equal(result.modules.length, 2, `Expected 2 modules, got ${result.modules.length}`)

  const moduleNames = result.modules.map(m => m.name).sort()
  assert.deepEqual(moduleNames, ['auth', 'user'])

  // 验证模块路径格式
  const authModule = result.modules.find(m => m.name === 'auth')
  assert(authModule.path.includes('src/features/auth') || authModule.path.includes('src\\features\\auth'), `Expected path to contain 'src/features/auth', got ${authModule.path}`)
})

test('collectProjectFacts: 检测模块间依赖关系', async () => {
  const { collectProjectFacts } = await import('../../src/features/project-map/collect-facts.js')
  const projectPath = new URL('../../tests/fixtures/sample-project', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')

  const result = await collectProjectFacts(projectPath)

  // dependsOn / usedBy / edges 的端点一律是模块 id，而 id 是相对路径不是目录名：
  // 模块可以嵌套（src/features 与 src/features/auth 并存），拿目录名当键会撞车。
  const AUTH = 'src/features/auth'
  const USER = 'src/features/user'

  // auth 导入 user
  const authModule = result.modules.find(m => m.id === AUTH)
  assert(authModule.dependsOn.includes(USER), `Expected auth.dependsOn to include '${USER}', got ${JSON.stringify(authModule.dependsOn)}`)

  // user 不导入 auth
  const userModule = result.modules.find(m => m.id === USER)
  assert(!userModule.dependsOn.includes(AUTH), `Expected user.dependsOn NOT to include '${AUTH}', got ${JSON.stringify(userModule.dependsOn)}`)

  // 验证 edges：应该有一条 auth -> user 的边
  const authToUserEdge = result.edges.find(e => e.from === AUTH && e.to === USER)
  assert(authToUserEdge, `Expected edge from '${AUTH}' to '${USER}', got edges: ${JSON.stringify(result.edges)}`)
})

test('persist: 保存和加载地图 - round-trip 测试', async () => {
  const { saveProjectMap, loadProjectMap } = await import('../../src/features/project-map/persist.js')

  const projectId = 'test-project-' + Date.now()
  const mapData = {
    projectId,
    scanAt: '2026-09-02T10:00:00Z',
    modules: [
      { id: 'auth', name: 'auth', path: 'src/features/auth', exports: ['login', 'logout'] },
      { id: 'user', name: 'user', path: 'src/features/user', exports: ['User'] }
    ],
    edges: [
      { from: 'auth', to: 'user', type: 'import' }
    ]
  }

  // 保存地图
  await saveProjectMap(projectId, mapData)

  // 加载地图
  const loaded = await loadProjectMap(projectId)

  // 验证内容完全相同
  assert.deepEqual(loaded, mapData)
})

test('persist: 验证文件存于正确路径', async () => {
  const { saveProjectMap } = await import('../../src/features/project-map/persist.js')
  const { appDataPath } = await import('../../src/shared/app-paths.js')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')

  const projectId = 'test-project-' + Date.now()
  const mapData = {
    projectId,
    scanAt: '2026-09-02T10:00:00Z',
    modules: [],
    edges: []
  }

  // 保存地图
  await saveProjectMap(projectId, mapData)

  // 验证文件存在于正确的路径
  const expectedPath = appDataPath('project-maps', `${projectId}.json`)
  const exists = await fs.access(expectedPath).then(() => true).catch(() => false)
  assert(exists, `Expected file at ${expectedPath}`)

  // 验证文件内容
  const content = await fs.readFile(expectedPath, 'utf-8')
  const fileData = JSON.parse(content)
  assert.deepEqual(fileData, mapData)
})
