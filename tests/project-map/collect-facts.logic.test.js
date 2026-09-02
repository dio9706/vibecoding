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
