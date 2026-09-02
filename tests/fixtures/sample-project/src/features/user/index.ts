export interface User {
  id: number
  name: string
}

export const getUserById = (id: number): User => {
  return { id, name: 'John' }
}

export const createUser = (name: string) => {
  return { id: 1, name }
}
