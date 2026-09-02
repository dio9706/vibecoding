import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMapGenPrompt, parseMapGenResponse, mergeSupplements, validateProjectMap } from '../../src/features/project-map/gen-map.logic.js'

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

    assert(prompt.includes('auth'))
    assert(prompt.includes('src/features/auth'))
    assert(prompt.includes('login'))
    assert(prompt.includes('JSON'))
  })

  test('解析 LLM 补语义输出', () => {
    const response = `
      {
        "supplements": [
          {
            "id": "m1",
            "description": "处理用户认证和权限验证",
            "keyFunctions": ["login()", "logout()", "verify()"]
          }
        ]
      }
    `

    const result = parseMapGenResponse(response)

    assert.strictEqual(result.supplements[0].id, 'm1')
    assert(result.supplements[0].description.includes('认证'))
    assert(result.supplements[0].keyFunctions.includes('login()'))
  })

  test('处理 LLM 返回代码围栏', () => {
    const response = `
      \`\`\`json
      {"supplements": [{"id": "m1", "description": "test", "keyFunctions": []}]}
      \`\`\`
    `

    const result = parseMapGenResponse(response)
    assert.strictEqual(result.supplements[0].id, 'm1')
  })

  test('合并补语义数据', () => {
    const modules = [
      {
        id: 'm1',
        name: 'auth',
        path: 'src/features/auth',
        files: [],
        exports: [],
        imports: [],
        dependsOn: [],
        usedBy: []
      },
      {
        id: 'm2',
        name: 'user',
        path: 'src/features/user',
        files: [],
        exports: [],
        imports: [],
        dependsOn: [],
        usedBy: []
      }
    ]

    const supplements = [
      {
        id: 'm1',
        description: '用户认证模块',
        keyFunctions: ['login()', 'logout()']
      }
    ]

    const result = mergeSupplements(modules, supplements)

    assert.strictEqual(result[0].id, 'm1')
    assert.strictEqual(result[0].description, '用户认证模块')
    assert.deepStrictEqual(result[0].keyFunctions, ['login()', 'logout()'])

    // m2 没有补语义，使用兜底值
    assert.strictEqual(result[1].id, 'm2')
    assert.strictEqual(result[1].description, '(待补充)')
    assert.deepStrictEqual(result[1].keyFunctions, [])
  })

  test('校验项目地图数据 - 完整', () => {
    const mapData = {
      projectId: 'test-proj',
      projectPath: '/path/to/project',
      modules: [
        {
          id: 'm1',
          name: 'auth',
          path: 'src/features/auth',
          files: [{ path: 'src/features/auth/index.ts', exports: ['login'] }],
          exports: ['login'],
          description: 'Auth module',
          keyFunctions: ['login()']
        }
      ],
      edges: [
        { from: 'm1', to: 'm2', label: 'depends' }
      ]
    }

    // 不抛错
    assert.doesNotThrow(() => validateProjectMap(mapData))
  })

  test('校验项目地图数据 - 缺少必要字段', () => {
    const mapData = {
      projectId: 'test-proj',
      // modules 和 edges 缺少
    }

    assert.throws(() => validateProjectMap(mapData))
  })
})
