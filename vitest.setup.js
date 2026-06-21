import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

function createMemoryStorage() {
  const store = new Map()
  return {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key) {
      return store.has(String(key)) ? store.get(String(key)) : null
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null
    },
    removeItem(key) {
      store.delete(String(key))
    },
    setItem(key, value) {
      store.set(String(key), String(value))
    },
  }
}

const storage = globalThis.window?.localStorage ?? createMemoryStorage()

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  })
}
if (globalThis.window && typeof globalThis.window.localStorage === 'undefined') {
  Object.defineProperty(globalThis.window, 'localStorage', {
    value: storage,
    configurable: true,
  })
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
