import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractExports, extractImports } from '../../src/features/project-map/collect-facts.logic.js'

test('extractExports: 识别 export default function', () => {
  const code = `
    export default function login(user) {
      return { token: 'abc' }
    }
    export const logout = () => {}
  `
  const result = extractExports(code, 'src/auth/index.ts')
  assert.deepEqual(result, ['login', 'logout'])
})

test('extractExports: 识别 export class', () => {
  const code = `
    export class AuthService {
      verify() {}
    }
    export { login } from './service'
  `
  const result = extractExports(code, 'src/auth/index.ts')
  assert.deepEqual(result, ['AuthService', 'login'])
})

test('extractExports: 忽略内部函数', () => {
  const code = `
    function privateFunc() {}
    export const publicFunc = () => {}
  `
  const result = extractExports(code, 'src/auth/index.ts')
  assert.deepEqual(result, ['publicFunc'])
})

test('extractExports: 处理 re-export', () => {
  const code = `export { a, b, c } from './other'`
  const result = extractExports(code, 'src/auth/index.ts')
  assert.deepEqual(result, ['a', 'b', 'c'])
})

test('extractImports: 识别 ES6 import', () => {
  const code = `
    import { login } from '../auth'
    import UserModel from '../user'
    import * as utils from 'lodash'
  `
  const result = extractImports(code)
  assert(result.includes('../auth'))
  assert(result.includes('../user'))
  assert(result.includes('lodash'))
})

test('extractImports: 识别 CommonJS require', () => {
  const code = `
    const { login } = require('../auth')
    const UserModel = require('../user')
  `
  const result = extractImports(code)
  assert(result.includes('../auth'))
  assert(result.includes('../user'))
})

test('extractImports: 去重导入', () => {
  const code = `
    import { login } from '../auth'
    import { logout } from '../auth'
  `
  const result = extractImports(code)
  assert.deepEqual(result, ['../auth'])
})

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

  // auth 导入 user，所以 auth.dependsOn 包含 'user'
  const authModule = result.modules.find(m => m.name === 'auth')
  assert(authModule.dependsOn.includes('user'), `Expected auth.dependsOn to include 'user', got ${JSON.stringify(authModule.dependsOn)}`)

  // user 不导入 auth
  const userModule = result.modules.find(m => m.name === 'user')
  assert(!userModule.dependsOn.includes('auth'), `Expected user.dependsOn NOT to include 'auth', got ${JSON.stringify(userModule.dependsOn)}`)

  // 验证 edges：应该有一条 auth -> user 的边
  const authToUserEdge = result.edges.find(e => e.from === 'auth' && e.to === 'user')
  assert(authToUserEdge, `Expected edge from 'auth' to 'user', got edges: ${JSON.stringify(result.edges)}`)
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
