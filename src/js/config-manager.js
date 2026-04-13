import { STORAGE_KEY, BUCKETS_KEY, ACTIVE_BUCKET_KEY, THEME_KEY, LANG_KEY, VIEW_KEY, DENSITY_KEY, SORT_BY_KEY, SORT_ORDER_KEY } from './constants.js'

/** @typedef {{ accountId?: string; accessKeyId?: string; secretAccessKey?: string; bucket?: string; filenameTpl?: string; filenameTplScope?: string; customDomain?: string; bucketAccess?: 'public' | 'private'; compressMode?: string; compressLevel?: string; tinifyKey?: string }} AppConfig */
/** @typedef {AppConfig & { id: string; name?: string }} BucketConfig */
/** @typedef {AppConfig & { theme?: string; lang?: string; view?: string; density?: string; sortBy?: string; sortOrder?: string }} SharePayload */

class ConfigManager {
  /** Migrate legacy single-config to multi-bucket format */
  #migrate() {
    const buckets = this.#loadBuckets()
    if (buckets.length > 0) return
    try {
      const legacy = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') || {}
      if (legacy.accountId && legacy.bucket) {
        const id = this.#genId()
        /** @type {BucketConfig} */
        const entry = { ...legacy, id, name: legacy.bucket }
        localStorage.setItem(BUCKETS_KEY, JSON.stringify([entry]))
        localStorage.setItem(ACTIVE_BUCKET_KEY, id)
        localStorage.removeItem(STORAGE_KEY)
      }
    } catch { /* ignore */ }
  }

  constructor() {
    this.#migrate()
  }

  /** @returns {string} */
  #genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  }

  /** @returns {BucketConfig[]} */
  #loadBuckets() {
    try {
      return JSON.parse(localStorage.getItem(BUCKETS_KEY) ?? '[]') || []
    } catch {
      return []
    }
  }

  /** @param {BucketConfig[]} buckets */
  #saveBuckets(buckets) {
    localStorage.setItem(BUCKETS_KEY, JSON.stringify(buckets))
  }

  /** @returns {BucketConfig[]} */
  getAllBuckets() {
    return this.#loadBuckets()
  }

  /** @returns {string | null} */
  getActiveBucketId() {
    return localStorage.getItem(ACTIVE_BUCKET_KEY)
  }

  /** @param {string} id */
  setActiveBucket(id) {
    localStorage.setItem(ACTIVE_BUCKET_KEY, id)
  }

  /** @param {AppConfig} cfg @returns {BucketConfig} */
  addBucket(cfg) {
    const buckets = this.#loadBuckets()
    const id = this.#genId()
    /** @type {BucketConfig} */
    const entry = { ...cfg, id, name: cfg.bucket || 'Unnamed' }
    buckets.push(entry)
    this.#saveBuckets(buckets)
    localStorage.setItem(ACTIVE_BUCKET_KEY, id)
    return entry
  }

  /** @param {string} id @param {AppConfig} cfg */
  updateBucket(id, cfg) {
    const buckets = this.#loadBuckets()
    const idx = buckets.findIndex((b) => b.id === id)
    if (idx === -1) return
    buckets[idx] = { ...buckets[idx], ...cfg, name: cfg.bucket || buckets[idx].name }
    this.#saveBuckets(buckets)
  }

  /** @param {string} id */
  deleteBucket(id) {
    let buckets = this.#loadBuckets()
    buckets = buckets.filter((b) => b.id !== id)
    this.#saveBuckets(buckets)
    if (this.getActiveBucketId() === id) {
      if (buckets.length > 0) {
        localStorage.setItem(ACTIVE_BUCKET_KEY, buckets[0].id)
      } else {
        localStorage.removeItem(ACTIVE_BUCKET_KEY)
      }
    }
  }

  // ─── Legacy-compatible API (operates on active bucket) ───

  /** @returns {AppConfig} */
  load() {
    const id = this.getActiveBucketId()
    if (!id) return /** @type {AppConfig} */ ({})
    const buckets = this.#loadBuckets()
    const found = buckets.find((b) => b.id === id)
    if (!found) return /** @type {AppConfig} */ ({})
    const { id: _id, name: _name, ...cfg } = found
    return cfg
  }

  /** @param {AppConfig} cfg */
  save(cfg) {
    const id = this.getActiveBucketId()
    if (id) {
      this.updateBucket(id, cfg)
    } else {
      this.addBucket(cfg)
    }
  }

  /** @returns {AppConfig} */
  get() {
    return this.load()
  }

  clear() {
    this.#saveBuckets([])
    localStorage.removeItem(ACTIVE_BUCKET_KEY)
    localStorage.removeItem(STORAGE_KEY)
  }

  isValid() {
    const c = this.load()
    return !!(c.accountId && c.accessKeyId && c.secretAccessKey && c.bucket)
  }

  getEndpoint() {
    const c = this.load()
    return `https://${c.accountId}.r2.cloudflarestorage.com`
  }

  getBucketUrl() {
    const c = this.load()
    return `${this.getEndpoint()}/${c.bucket}`
  }

  toBase64() {
    /** @type {SharePayload} */
    const payload = {
      ...this.load(),
      theme: localStorage.getItem(THEME_KEY) || undefined,
      lang: localStorage.getItem(LANG_KEY) || undefined,
      view: localStorage.getItem(VIEW_KEY) || undefined,
      density: localStorage.getItem(DENSITY_KEY) || undefined,
      sortBy: localStorage.getItem(SORT_BY_KEY) || undefined,
      sortOrder: localStorage.getItem(SORT_ORDER_KEY) || undefined,
    }
    return btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
  }

  /** @param {string} b64 @returns {boolean} */
  loadFromBase64(b64) {
    try {
      const json = decodeURIComponent(escape(atob(b64)))
      /** @type {SharePayload} */
      const payload = JSON.parse(json)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false

      const { theme, lang, view, density, sortBy, sortOrder, ...r2Config } = payload
      if (theme) localStorage.setItem(THEME_KEY, theme)
      if (lang) localStorage.setItem(LANG_KEY, lang)
      if (view) localStorage.setItem(VIEW_KEY, view)
      if (density) localStorage.setItem(DENSITY_KEY, density)
      if (sortBy) localStorage.setItem(SORT_BY_KEY, sortBy)
      if (sortOrder) localStorage.setItem(SORT_ORDER_KEY, sortOrder)

      if (Object.values(r2Config).some(Boolean)) {
        this.addBucket(r2Config)
      }
      return true
    } catch {
      /* invalid base64 or JSON */
    }
    return false
  }

  getShareUrl() {
    const b64 = this.toBase64()
    const url = new URL(window.location.href)
    url.searchParams.set('config', b64)
    url.hash = ''
    return url.toString()
  }
}

export { ConfigManager }
