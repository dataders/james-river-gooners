import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

if (!globalThis.localStorage) {
  const store = new Map()
  const storage = {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key) {
      const value = store.get(String(key))
      return value === undefined ? null : value
    },
    key(index) {
      return [...store.keys()][index] ?? null
    },
    removeItem(key) {
      store.delete(String(key))
    },
    setItem(key, value) {
      store.set(String(key), String(value))
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true })
}

afterEach(() => {
  cleanup()
  globalThis.localStorage?.clear()
})

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
