import { getUserById } from '../user'

export class AuthService {
  verify() {
    return getUserById(1)
  }
}

export const login = (username: string, password: string) => {
  return { token: 'abc123' }
}

export const logout = () => {
  return { success: true }
}
