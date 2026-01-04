/**
 * Minimal JSON-backed SimpleStore (synchronous)
 *
 * This is a small replacement for `electron-store` for simple get/set needs
 * (used for window state, plugin cache, etc.). It is intentionally minimal:
 * - synchronous filesystem operations
 * - dot-notation support for keys (e.g. 'a.b.c')
 * - accepts `defaults` via constructor
 * - defaults to storing file at `<userData>/config.json`
 *
 * NOTE: Not a full-featured drop-in replacement; it implements the subset of
 * the API needed by this project (`get`, `set`, `delete`, `clear`).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

type StoreData = Record<string, any>

export interface SimpleStoreOptions {
  defaults?: StoreData
  name?: string // filename base (defaults to 'config')
  filePath?: string // explicit path to store file
}

/** Helper to safely obtain userData path even if `electron` isn't available in the runtime */
function getDefaultUserPath(): string {
  try {
    // require here to avoid import-time issues in non-electron environments
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electronApp = require('electron')?.app
    if (electronApp && typeof electronApp.getPath === 'function') {
      return electronApp.getPath('userData')
    }
  } catch (err) {
    // ignore - fallthrough to process cwd
  }
  return process.cwd()
}

export default class SimpleStore {
  private file: string
  private data: StoreData

  constructor(opts?: SimpleStoreOptions) {
    const defaults = opts?.defaults ?? {}
    const name = opts?.name ?? 'config'
    const filePath = opts?.filePath ?? join(getDefaultUserPath(), `${name}.json`)

    this.file = filePath
    this.data = {}

    try {
      mkdirSync(dirname(this.file), { recursive: true })
    } catch (err) {
      // ignore
    }

    if (existsSync(this.file)) {
      try {
        const raw = readFileSync(this.file, { encoding: 'utf8' })
        this.data = raw ? JSON.parse(raw) : {}
      } catch (err) {
        // If parsing fails, start from empty object
        this.data = {}
      }
    } else {
      this.data = {}
    }

    // Merge defaults into data (shallow) so defaults exist when missing
    this.data = Object.assign({}, defaults, this.data)

    // Persist initial state (ensures defaults are written)
    this._write()
  }

  private _write() {
    try {
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), { encoding: 'utf8' })
    } catch (err) {
      // best-effort - ignore write errors
    }
  }

  private _resolveKeyPath(key?: string) {
    if (!key || typeof key !== 'string') return []
    return key.split('.').filter(Boolean)
  }

  private _getNested(parts: string[]) {
    if (!parts.length) return this.data
    let cur: any = this.data
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object' || !(p in cur)) return undefined
      cur = cur[p]
    }
    return cur
  }

  private _setNested(parts: string[], value: any) {
    if (!parts.length) {
      // Replace entire store
      this.data = value
      return
    }
    let cur: any = this.data
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]
      if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {}
      cur = cur[p]
    }
    cur[parts[parts.length - 1]] = value
  }

  /**
   * Get value at `key` (supports dot notation). If key is omitted, returns the whole store.
   * If the result is undefined, returns `fallback` (if provided).
   */
  get<T = unknown>(key?: string, fallback?: T): T | undefined {
    if (key === undefined) return (this.data as unknown as T)
    const parts = this._resolveKeyPath(key)
    const val = this._getNested(parts)
    return val === undefined ? fallback : (val as T)
  }

  /**
   * Set a key to a value. Accepts:
   * - `set('a.b', value)`
   * - `set({ a: 1, b: 2 })` to shallow-merge an object into the store
   */
  set(key: string | Record<string, any>, value?: any) {
    if (typeof key === 'object' && value === undefined) {
      Object.assign(this.data, key)
    } else if (typeof key === 'string') {
      const parts = this._resolveKeyPath(key)
      this._setNested(parts, value)
    }
    this._write()
  }

  /** Delete a key (supports dot notation) */
  delete(key: string) {
    if (typeof key !== 'string') return
    const parts = this._resolveKeyPath(key)
    if (!parts.length) {
      this.data = {}
      this._write()
      return
    }
    let cur: any = this.data
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]
      if (!(p in cur) || cur[p] == null) return
      cur = cur[p]
    }
    delete cur[parts[parts.length - 1]]
    this._write()
  }

  /** Clears the entire store */
  clear() {
    this.data = {}
    this._write()
  }

  /** Expose file path (useful for tests/debugging) */
  path() {
    return this.file
  }

  /** Expose raw store (useful for tests/debugging) */
  store() {
    return this.data
  }
}
