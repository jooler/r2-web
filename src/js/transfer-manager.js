import { filesize } from 'filesize'
import { R2Client } from './r2-client.js'
import { UIManager } from './ui-manager.js'
import { FileExplorer } from './file-explorer.js'
import { $, extractFileName } from './utils.js'

const DB_NAME = 'r2-transfers'
const DB_VERSION = 1
const STORE_NAME = 'transfers'
const PART_SIZE = 8 * 1024 * 1024 // 8 MB — S3/R2 minimum is 5 MB

/**
 * @typedef {{
 *   id: string,
 *   type: 'upload' | 'download',
 *   name: string,
 *   key: string,
 *   size: number,
 *   loaded: number,
 *   status: 'pending' | 'transferring' | 'paused' | 'completed' | 'failed' | 'cancelled',
 *   speed: number,
 *   contentType: string,
 *   error: string,
 *   createdAt: number,
 *   completedAt: number,
 *   uploadId: string,
 *   completedParts: {partNumber: number, etag: string}[],
 *   partSize: number,
 * }} TransferRecord
 */

// ---- IndexedDB Helper ----

class TransferDB {
  /** @type {IDBDatabase | null} */
  #db = null

  /** @returns {Promise<void>} */
  async open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
          store.createIndex('type', 'type', { unique: false })
          store.createIndex('status', 'status', { unique: false })
          store.createIndex('createdAt', 'createdAt', { unique: false })
        }
      }
      req.onsuccess = () => {
        this.#db = req.result
        resolve()
      }
      req.onerror = () => reject(req.error)
    })
  }

  /** @param {TransferRecord} record */
  async add(record) {
    return this.#tx('readwrite', (store) => store.add(record))
  }

  /** @param {string} id @param {Partial<TransferRecord>} changes */
  async update(id, changes) {
    const existing = await this.get(id)
    if (!existing) return
    Object.assign(existing, changes)
    return this.#tx('readwrite', (store) => store.put(existing))
  }

  /** @param {string} id @returns {Promise<TransferRecord|undefined>} */
  async get(id) {
    return this.#tx('readonly', (store) => store.get(id))
  }

  /** @param {string} id */
  async delete(id) {
    return this.#tx('readwrite', (store) => store.delete(id))
  }

  /** @returns {Promise<TransferRecord[]>} */
  async getAll() {
    return this.#tx('readonly', (store) => store.index('createdAt').getAll())
  }

  async clear() {
    return this.#tx('readwrite', (store) => store.clear())
  }

  /**
   * @template T
   * @param {IDBTransactionMode} mode
   * @param {(store: IDBObjectStore) => IDBRequest<T>} fn
   * @returns {Promise<T>}
   */
  #tx(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = /** @type {IDBDatabase} */ (this.#db).transaction(STORE_NAME, mode)
      const store = tx.objectStore(STORE_NAME)
      const req = fn(store)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
}

// ---- Transfer Manager ----

class TransferManager {
  /** @type {TransferDB} */
  #db = new TransferDB()
  /** @type {R2Client} */
  #r2
  /** @type {UIManager} */
  #ui
  /** @type {FileExplorer} */
  #explorer
  /** @type {Map<string, { abort: () => void }>} */
  #activeTransfers = new Map()
  /** @type {Map<string, File>} */
  #uploadFiles = new Map()
  /** @type {Map<string, FileSystemFileHandle>} */
  #fileHandles = new Map()
  /** @type {Map<string, Uint8Array[]>} */
  #downloadChunks = new Map()
  /** @type {TransferRecord[]} */
  #transfers = []
  /** @type {'upload' | 'download'} */
  #activeTab = 'upload'
  #isOpen = false
  /** @type {Map<string, { lastLoaded: number, lastTime: number, lastSpeed: number }>} */
  #speedTrackers = new Map()
  /** @type {number | null} */
  #renderTimer = null
  /** @type {number | null} */
  #progressTimer = null
  #needsFullRender = true
  /** @type {Map<string, string>} */
  #renderedStatuses = new Map()
  /** @type {Function | null} */
  #onUploadComplete = null

  /** @param {R2Client} r2 @param {UIManager} ui @param {FileExplorer} explorer */
  constructor(r2, ui, explorer) {
    this.#r2 = r2
    this.#ui = ui
    this.#explorer = explorer
  }

  async init() {
    await this.#db.open()
    this.#transfers = await this.#db.getAll()
    for (const r of this.#transfers) {
      if (r.status === 'transferring' || r.status === 'pending') {
        r.status = 'paused'
        r.speed = 0
        await this.#db.update(r.id, { status: 'paused', speed: 0 })
      }
    }
    this.#updateBadge()
    this.#bindEvents()
  }

  /** @param {Function} fn */
  onUploadComplete(fn) {
    this.#onUploadComplete = fn
  }

  // ---- Public API ----

  /** @param {File} file @param {string} key @param {string} contentType */
  async addUpload(file, key, contentType) {
    /** @type {TransferRecord} */
    const record = {
      id: crypto.randomUUID(),
      type: 'upload',
      name: extractFileName(key),
      key,
      size: file.size,
      loaded: 0,
      status: 'pending',
      speed: 0,
      contentType,
      error: '',
      createdAt: Date.now(),
      completedAt: 0,
      uploadId: '',
      completedParts: [],
      partSize: 0,
    }
    await this.#db.add(record)
    this.#transfers.push(record)
    this.#uploadFiles.set(record.id, file)
    this.#startUpload(record, file)
    this.#requestFullRender()
    this.#updateBadge()
    return record.id
  }

  /** @param {string} key @param {string} filename @param {number} [size] @param {FileSystemFileHandle} [fileHandle] */
  async addDownload(key, filename, size = 0, fileHandle) {
    /** @type {TransferRecord} */
    const record = {
      id: crypto.randomUUID(),
      type: 'download',
      name: filename,
      key,
      size,
      loaded: 0,
      status: 'pending',
      speed: 0,
      contentType: '',
      error: '',
      createdAt: Date.now(),
      completedAt: 0,
      uploadId: '',
      completedParts: [],
      partSize: 0,
    }
    if (fileHandle) this.#fileHandles.set(record.id, fileHandle)
    await this.#db.add(record)
    this.#transfers.push(record)
    this.#startDownload(record)
    this.#requestFullRender()
    this.#updateBadge()
    return record.id
  }

  /** @param {string} id */
  async pause(id) {
    const active = this.#activeTransfers.get(id)
    if (active) active.abort()
    this.#activeTransfers.delete(id)
    this.#speedTrackers.delete(id)
    const record = this.#transfers.find((r) => r.id === id)
    if (record && (record.status === 'transferring' || record.status === 'pending')) {
      record.status = 'paused'
      record.speed = 0
      await this.#db.update(id, { status: 'paused', speed: 0 })
      this.#requestFullRender()
    }
  }

  /** @param {string} id */
  async resume(id) {
    const record = this.#transfers.find((r) => r.id === id)
    if (!record || record.status !== 'paused') return

    if (record.type === 'upload') {
      const file = this.#uploadFiles.get(id)
      if (file) {
        record.status = 'pending'
        record.speed = 0
        if (!record.uploadId) {
          record.loaded = 0
          await this.#db.update(id, { status: 'pending', loaded: 0, speed: 0 })
        } else {
          await this.#db.update(id, { status: 'pending', speed: 0 })
        }
        this.#startUpload(record, file)
      } else {
        this.#ui.toast('文件引用已丢失，无法继续上传，请重新上传', 'error')
      }
    } else {
      record.status = 'pending'
      record.speed = 0
      await this.#db.update(id, { status: 'pending', speed: 0 })
      this.#startDownload(record)
    }
    this.#requestFullRender()
  }

  /** @param {string} id */
  async cancel(id) {
    const active = this.#activeTransfers.get(id)
    if (active) {
      active.abort()
      this.#activeTransfers.delete(id)
    }
    this.#speedTrackers.delete(id)
    this.#uploadFiles.delete(id)
    this.#downloadChunks.delete(id)
    this.#fileHandles.delete(id)
    const record = this.#transfers.find((r) => r.id === id)
    if (record) {
      if (record.uploadId) {
        try { await this.#r2.abortMultipartUpload(record.key, record.uploadId) } catch { /* ignore */ }
      }
      record.status = 'cancelled'
      record.speed = 0
      await this.#db.update(id, { status: 'cancelled', speed: 0 })
      this.#requestFullRender()
      this.#updateBadge()
    }
  }

  /** @param {string} id */
  async remove(id) {
    const active = this.#activeTransfers.get(id)
    if (active) {
      active.abort()
      this.#activeTransfers.delete(id)
    }
    this.#speedTrackers.delete(id)
    const record = this.#transfers.find((r) => r.id === id)
    if (record?.uploadId) {
      try { await this.#r2.abortMultipartUpload(record.key, record.uploadId) } catch { /* ignore */ }
    }
    this.#transfers = this.#transfers.filter((r) => r.id !== id)
    this.#renderedStatuses.delete(id)
    this.#uploadFiles.delete(id)
    this.#fileHandles.delete(id)
    this.#downloadChunks.delete(id)
    await this.#db.delete(id)
    this.#requestFullRender()
    this.#updateBadge()
  }

  async clearCompleted() {
    const toRemove = this.#transfers.filter(
      (r) => r.type === this.#activeTab && (r.status === 'completed' || r.status === 'cancelled' || r.status === 'failed'),
    )
    for (const r of toRemove) {
      await this.#db.delete(r.id)
    }
    for (const r of toRemove) {
      this.#renderedStatuses.delete(r.id)
      this.#uploadFiles.delete(r.id)
      this.#fileHandles.delete(r.id)
      this.#downloadChunks.delete(r.id)
    }
    this.#transfers = this.#transfers.filter((r) => !toRemove.includes(r))
    this.#requestFullRender()
    this.#updateBadge()
  }

  /** @param {string} id */
  openLocation(id) {
    const record = this.#transfers.find((r) => r.id === id)
    if (!record || record.status !== 'completed') return

    if (record.type === 'upload') {
      const dir = record.key.substring(0, record.key.lastIndexOf('/') + 1)
      this.#explorer.navigate(dir)
      this.close()
    } else {
      this.#ui.toast('下载文件已保存至浏览器默认下载目录', 'info')
    }
  }

  toggle() {
    if (this.#isOpen) this.close()
    else this.open()
  }

  open() {
    this.#isOpen = true
    const panel = $('#transfer-panel')
    if (panel) {
      panel.hidden = false
      this.render()
    }
  }

  close() {
    this.#isOpen = false
    const panel = $('#transfer-panel')
    if (panel) panel.hidden = true
  }

  /** @param {'upload' | 'download'} tab */
  switchTab(tab) {
    this.#activeTab = tab
    this.#needsFullRender = true
    this.render()
  }

  get isOpen() {
    return this.#isOpen
  }

  // ---- Event Binding ----

  #bindEvents() {
    const closeBtn = $('#transfer-panel-close')
    if (closeBtn) closeBtn.addEventListener('click', () => this.close())

    const uploadTab = $('#transfer-tab-upload')
    const downloadTab = $('#transfer-tab-download')
    if (uploadTab) uploadTab.addEventListener('click', () => this.switchTab('upload'))
    if (downloadTab) downloadTab.addEventListener('click', () => this.switchTab('download'))

    const clearBtn = $('#transfer-clear-btn')
    if (clearBtn) clearBtn.addEventListener('click', () => this.clearCompleted())
  }

  // ---- Transfer Execution ----

  /** @param {TransferRecord} record @param {File} file */
  async #startUpload(record, file) {
    // Use multipart for files that already have an uploadId (resume) or are large enough
    if (record.uploadId || file.size > PART_SIZE) {
      return this.#startMultipartUpload(record, file)
    }
    return this.#startSimpleUpload(record, file)
  }

  /** @param {TransferRecord} record @param {File} file */
  async #startSimpleUpload(record, file) {
    try {
      const signed = await this.#r2.putObjectSigned(record.key, record.contentType)
      record.status = 'transferring'
      await this.#db.update(record.id, { status: 'transferring' })

      const xhr = new XMLHttpRequest()

      this.#activeTransfers.set(record.id, { abort: () => xhr.abort() })
      this.#speedTrackers.set(record.id, { lastLoaded: 0, lastTime: Date.now(), lastSpeed: 0 })

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          record.loaded = e.loaded
          record.size = e.total
          record.speed = this.#calcSpeed(record.id, e.loaded)
          this.#scheduleProgressUpdate()
        }
      })

      xhr.addEventListener('load', async () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          record.status = 'completed'
          record.loaded = record.size
          record.speed = 0
          record.completedAt = Date.now()
          await this.#db.update(record.id, {
            status: 'completed',
            loaded: record.size,
            speed: 0,
            completedAt: record.completedAt,
          })
          if (this.#onUploadComplete) this.#onUploadComplete()
          this.#uploadFiles.delete(record.id)
        } else {
          record.status = 'failed'
          record.error = `HTTP ${xhr.status}`
          record.speed = 0
          await this.#db.update(record.id, { status: 'failed', error: record.error, speed: 0 })
        }
        this.#activeTransfers.delete(record.id)
        this.#speedTrackers.delete(record.id)
        this.#requestFullRender()
        this.#updateBadge()
      })

      xhr.addEventListener('error', async () => {
        record.status = 'failed'
        record.error = '网络错误'
        record.speed = 0
        await this.#db.update(record.id, { status: 'failed', error: record.error, speed: 0 })
        this.#activeTransfers.delete(record.id)
        this.#speedTrackers.delete(record.id)
        this.#requestFullRender()
        this.#updateBadge()
      })

      xhr.open('PUT', signed.url)
      for (const [k, v] of Object.entries(signed.headers)) {
        if (k.toLowerCase() !== 'host') xhr.setRequestHeader(k, v)
      }
      xhr.send(file)

      this.#requestFullRender()
    } catch (/** @type {any} */ err) {
      record.status = 'failed'
      record.error = err.message || '签名失败'
      record.speed = 0
      await this.#db.update(record.id, { status: 'failed', error: record.error, speed: 0 })
      this.#activeTransfers.delete(record.id)
      this.#requestFullRender()
      this.#updateBadge()
    }
  }

  /** @param {TransferRecord} record @param {File} file */
  async #startMultipartUpload(record, file) {
    try {
      // 1. Create multipart upload if not yet started
      if (!record.uploadId) {
        const partSize = Math.max(PART_SIZE, Math.ceil(file.size / 10000))
        const uploadId = await this.#r2.createMultipartUpload(record.key, record.contentType)
        record.uploadId = uploadId
        record.completedParts = []
        record.partSize = partSize
        await this.#db.update(record.id, { uploadId, completedParts: [], partSize })
      }

      record.status = 'transferring'
      await this.#db.update(record.id, { status: 'transferring' })

      const ps = record.partSize || PART_SIZE
      const totalParts = Math.ceil(file.size / ps)
      const completedSet = new Set((record.completedParts || []).map((p) => p.partNumber))

      // Recalculate loaded from completed parts
      let baseLoaded = 0
      for (const pn of completedSet) {
        baseLoaded += pn < totalParts ? ps : file.size - (totalParts - 1) * ps
      }
      record.loaded = baseLoaded

      this.#speedTrackers.set(record.id, { lastLoaded: record.loaded, lastTime: Date.now(), lastSpeed: 0 })
      this.#requestFullRender()

      // 2. Upload remaining parts sequentially
      for (let partNum = 1; partNum <= totalParts; partNum++) {
        if (completedSet.has(partNum)) continue

        const start = (partNum - 1) * ps
        const end = Math.min(start + ps, file.size)
        const partBlob = file.slice(start, end)

        let etag
        try {
          etag = await this.#uploadSinglePart(record, partNum, partBlob)
        } catch (/** @type {any} */ err) {
          if (err.message === 'Aborted') return // paused — exit silently
          throw err
        }

        if (!record.completedParts) record.completedParts = []
        record.completedParts.push({ partNumber: partNum, etag })
        record.loaded = start + partBlob.size
        await this.#db.update(record.id, { completedParts: record.completedParts, loaded: record.loaded })
      }

      // 3. All parts done — complete the multipart upload
      await this.#r2.completeMultipartUpload(record.key, record.uploadId, record.completedParts || [])

      record.status = 'completed'
      record.loaded = record.size
      record.speed = 0
      record.completedAt = Date.now()
      record.uploadId = ''
      record.completedParts = []
      await this.#db.update(record.id, {
        status: 'completed',
        loaded: record.size,
        speed: 0,
        completedAt: record.completedAt,
        uploadId: '',
        completedParts: [],
      })
      this.#activeTransfers.delete(record.id)
      this.#speedTrackers.delete(record.id)
      this.#uploadFiles.delete(record.id)
      if (this.#onUploadComplete) this.#onUploadComplete()
      this.#requestFullRender()
      this.#updateBadge()
    } catch (/** @type {any} */ err) {
      record.status = 'failed'
      record.error = err.message || '上传失败'
      record.speed = 0
      await this.#db.update(record.id, { status: 'failed', error: record.error, speed: 0 })
      this.#activeTransfers.delete(record.id)
      this.#speedTrackers.delete(record.id)
      this.#requestFullRender()
      this.#updateBadge()
    }
  }

  /**
   * Upload a single part via XHR with progress tracking.
   * Resolves with the ETag. Rejects with Error('Aborted') on abort.
   * @param {TransferRecord} record
   * @param {number} partNumber
   * @param {Blob} partBlob
   * @returns {Promise<string>}
   */
  async #uploadSinglePart(record, partNumber, partBlob) {
    const ps = record.partSize || PART_SIZE
    const partStart = (partNumber - 1) * ps
    const signed = await this.#r2.uploadPartSigned(record.key, record.uploadId, partNumber)

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()

      this.#activeTransfers.set(record.id, { abort: () => xhr.abort() })

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          record.loaded = partStart + e.loaded
          record.speed = this.#calcSpeed(record.id, record.loaded)
          this.#scheduleProgressUpdate()
        }
      })

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const etag = xhr.getResponseHeader('ETag') || ''
          resolve(etag)
        } else {
          reject(new Error(`HTTP ${xhr.status}`))
        }
      })

      xhr.addEventListener('error', () => reject(new Error('网络错误')))
      xhr.addEventListener('abort', () => reject(new Error('Aborted')))

      xhr.open('PUT', signed.url)
      for (const [k, v] of Object.entries(signed.headers)) {
        if (k.toLowerCase() !== 'host') xhr.setRequestHeader(k, v)
      }
      xhr.send(partBlob)
    })
  }

  /** @param {TransferRecord} record */
  async #startDownload(record) {
    /** @type {FileSystemWritableFileStream | null} */
    let writable = null
    try {
      const url = await this.#r2.getDownloadUrl(record.key, record.name)
      record.status = 'transferring'
      await this.#db.update(record.id, { status: 'transferring' })

      const controller = new AbortController()
      this.#activeTransfers.set(record.id, { abort: () => controller.abort() })
      this.#speedTrackers.set(record.id, { lastLoaded: record.loaded, lastTime: Date.now(), lastSpeed: 0 })
      this.#requestFullRender()

      // Use Range header for resumable download
      /** @type {HeadersInit} */
      const fetchHeaders = record.loaded > 0 ? { Range: `bytes=${record.loaded}-` } : {}
      const res = await fetch(url, { signal: controller.signal, headers: fetchHeaders })

      let loaded = record.loaded

      if (record.loaded > 0 && res.status === 206) {
        // Range accepted — parse total size from Content-Range header
        const range = res.headers.get('content-range')
        if (range) {
          const match = range.match(/\/(\d+)$/)
          if (match) record.size = parseInt(match[1], 10)
        }
      } else if (res.ok) {
        // Full response: server doesn't support Range, or fresh download
        if (record.loaded > 0) {
          // Range not supported — must restart
          loaded = 0
          record.loaded = 0
          this.#downloadChunks.delete(record.id)
        }
        const contentLength = parseInt(res.headers.get('content-length') || '0', 10)
        if (contentLength > 0) record.size = contentLength
      } else {
        throw new Error(`HTTP ${res.status}`)
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No readable stream')

      const fileHandle = this.#fileHandles.get(record.id)

      if (fileHandle) {
        writable = await fileHandle.createWritable({ keepExistingData: loaded > 0 })
        if (loaded > 0) await writable.seek(loaded)
      } else {
        // Get or create chunks array — survives across pause/resume
        if (!this.#downloadChunks.has(record.id)) {
          this.#downloadChunks.set(record.id, [])
        }
      }
      const chunks = this.#downloadChunks.get(record.id)

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (writable) {
          await writable.write(value)
        } else if (chunks) {
          chunks.push(value)
        }
        loaded += value.length
        record.loaded = loaded
        record.speed = this.#calcSpeed(record.id, loaded)
        this.#scheduleProgressUpdate()
      }

      if (writable) {
        await writable.close()
        writable = null
      } else if (chunks) {
        // Fallback: trigger browser save via blob URL
        const blob = new Blob(/** @type {BlobPart[]} */ (chunks))
        const blobUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = blobUrl
        a.download = record.name
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
      }

      record.status = 'completed'
      record.loaded = loaded
      record.size = loaded > record.size ? loaded : record.size
      record.speed = 0
      record.completedAt = Date.now()
      await this.#db.update(record.id, {
        status: 'completed',
        loaded,
        size: record.size,
        speed: 0,
        completedAt: record.completedAt,
      })
      this.#activeTransfers.delete(record.id)
      this.#speedTrackers.delete(record.id)
      this.#fileHandles.delete(record.id)
      this.#downloadChunks.delete(record.id)
      this.#requestFullRender()
      this.#updateBadge()
    } catch (/** @type {any} */ err) {
      if (err.name === 'AbortError') {
        // Gracefully close writable stream so partial data is persisted
        if (writable) {
          try { await writable.close() } catch { /* ignore */ }
        }
        return
      }
      record.status = 'failed'
      record.error = err.message || '下载失败'
      record.speed = 0
      await this.#db.update(record.id, { status: 'failed', error: record.error, speed: 0 })
      this.#activeTransfers.delete(record.id)
      this.#speedTrackers.delete(record.id)
      this.#fileHandles.delete(record.id)
      this.#downloadChunks.delete(record.id)
      this.#requestFullRender()
      this.#updateBadge()
    }
  }

  // ---- Speed Calculation ----

  /** @param {string} id @param {number} loaded @returns {number} */
  #calcSpeed(id, loaded) {
    const tracker = this.#speedTrackers.get(id)
    if (!tracker) return 0
    const now = Date.now()
    const timeDelta = (now - tracker.lastTime) / 1000
    if (timeDelta < 0.5) return tracker.lastSpeed
    const speed = (loaded - tracker.lastLoaded) / timeDelta
    tracker.lastLoaded = loaded
    tracker.lastTime = now
    tracker.lastSpeed = speed
    return speed
  }

  // ---- UI Rendering ----

  /** Request a full DOM rebuild on next frame */
  #requestFullRender() {
    this.#needsFullRender = true
    this.#scheduleFrame()
  }

  /** Request a lightweight progress-only update (throttled to 1s) */
  #scheduleProgressUpdate() {
    if (this.#progressTimer) return
    this.#progressTimer = window.setTimeout(() => {
      this.#progressTimer = null
      if (this.#isOpen && !this.#needsFullRender) {
        this.#updateProgress()
      }
      this.#updateBadge()
    }, 1000)
  }

  #scheduleFrame() {
    if (this.#renderTimer) return
    this.#renderTimer = requestAnimationFrame(() => {
      this.#renderTimer = null
      if (this.#isOpen) {
        if (this.#needsFullRender) {
          this.render()
        }
      }
      this.#updateBadge()
    })
  }

  #updateBadge() {
    const badge = $('#transfer-badge')
    if (!badge) return
    const active = this.#transfers.filter((r) => r.status === 'transferring' || r.status === 'pending').length
    if (active > 0) {
      badge.textContent = String(active)
      badge.hidden = false
    } else {
      badge.hidden = true
    }
  }

  /** Lightweight update: only touch progress bars and detail text */
  #updateProgress() {
    for (const r of this.#transfers) {
      if (r.type !== this.#activeTab) continue
      if (r.status !== 'transferring') continue
      const progress = r.size > 0 ? Math.round((r.loaded / r.size) * 100) : 0
      const bar = document.getElementById(`tp-bar-${r.id}`)
      if (bar) bar.style.width = `${progress}%`
      const detail = document.getElementById(`tp-detail-${r.id}`)
      if (detail) detail.textContent = this.#formatDetail(r)
    }
  }

  render() {
    this.#needsFullRender = false
    const body = $('#transfer-panel-body')
    if (!body) return

    const filtered = this.#transfers.filter((r) => r.type === this.#activeTab).sort((a, b) => b.createdAt - a.createdAt)

    // Update tab active states
    this.#updateTabs()

    if (filtered.length === 0) {
      body.innerHTML = `<div class="transfer-empty">暂无${this.#activeTab === 'upload' ? '上传' : '下载'}记录</div>`
      this.#renderedStatuses.clear()
      return
    }

    body.innerHTML = filtered.map((r) => this.#renderItem(r)).join('')
    for (const r of filtered) this.#renderedStatuses.set(r.id, r.status)

    // Use event delegation once — unbind old, bind new
    if (!body.dataset.delegated) {
      body.dataset.delegated = 'true'
      body.addEventListener('click', (e) => {
        const btn = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (e.target).closest('[data-action]'))
        if (!btn) return
        const action = btn.getAttribute('data-action')
        const id = btn.getAttribute('data-id')
        if (!action || !id) return
        e.stopPropagation()
        switch (action) {
          case 'pause': this.pause(id); break
          case 'resume': this.resume(id); break
          case 'cancel': this.cancel(id); break
          case 'delete': this.remove(id); break
          case 'open-location': this.openLocation(id); break
        }
      })
    }
  }

  #updateTabs() {
    const uploadTab = $('#transfer-tab-upload')
    const downloadTab = $('#transfer-tab-download')
    if (uploadTab) {
      uploadTab.classList.toggle('active', this.#activeTab === 'upload')
      const c = this.#transfers.filter((r) => r.type === 'upload').length
      uploadTab.textContent = `上传${c > 0 ? ` (${c})` : ''}`
    }
    if (downloadTab) {
      downloadTab.classList.toggle('active', this.#activeTab === 'download')
      const c = this.#transfers.filter((r) => r.type === 'download').length
      downloadTab.textContent = `下载${c > 0 ? ` (${c})` : ''}`
    }
  }

  /** @param {TransferRecord} r @returns {string} */
  #renderItem(r) {
    const progress = r.size > 0 ? Math.round((r.loaded / r.size) * 100) : 0
    const speedText = r.speed > 0 ? `${filesize(r.speed)}/s` : ''
    const sizeText = r.size > 0 ? filesize(r.size) : ''
    const loadedText = r.loaded > 0 ? filesize(r.loaded) : ''

    /** @type {Record<string, string>} */
    const statusMap = {
      pending: '等待中',
      transferring: '传输中',
      paused: '已暂停',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
    }
    const statusText = statusMap[r.status] || r.status

    const isActive = r.status === 'transferring' || r.status === 'pending'
    const isPaused = r.status === 'paused'

    // Action buttons
    let actions = ''

    if (isActive) {
      actions = `
        <button class="transfer-action-btn" data-action="pause" data-id="${r.id}" title="暂停">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </button>
        <button class="transfer-action-btn" data-action="cancel" data-id="${r.id}" title="取消">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>`
    } else if (isPaused) {
      actions = `
        <button class="transfer-action-btn" data-action="resume" data-id="${r.id}" title="继续">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="transfer-action-btn" data-action="cancel" data-id="${r.id}" title="取消">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>`
    }

    // Folder icon for completed transfers
    let folderBtn = ''
    if (r.status === 'completed') {
      const tip = r.type === 'upload' ? '打开远端目录' : '打开本地位置'
      folderBtn = `
        <button class="transfer-action-btn accent" data-action="open-location" data-id="${r.id}" title="${tip}">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </button>`
    }

    // Delete button always shown
    const deleteBtn = `
      <button class="transfer-action-btn danger" data-action="delete" data-id="${r.id}" title="删除记录">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>`

    // Target location
    const targetDir = r.key.substring(0, r.key.lastIndexOf('/') + 1) || '/'

    // Progress info
    let infoText = ''
    if (isActive || isPaused) {
      const parts = []
      if (loadedText && sizeText) parts.push(`${loadedText} / ${sizeText}`)
      else if (sizeText) parts.push(sizeText)
      if (speedText && isActive) parts.push(speedText)
      if (parts.length > 0) infoText = parts.join(' · ')
    } else if (r.status === 'completed') {
      infoText = sizeText
    } else if (r.status === 'failed') {
      infoText = r.error || '传输失败'
    }

    return `
      <div class="transfer-item transfer-status-${r.status}" id="tp-item-${r.id}">
        <div class="transfer-item-info">
          <div class="transfer-item-name" title="${this.#esc(r.name)}">${this.#esc(r.name)}</div>
          <div class="transfer-item-meta">
            <span class="transfer-item-path" title="${this.#esc(r.key)}">${this.#esc(targetDir || '/')}</span>
            <span class="transfer-item-sep">·</span>
            <span class="transfer-item-status-label transfer-status-${r.status}">${statusText}</span>
            <span class="transfer-item-sep">·</span>
            <span class="transfer-item-detail" id="tp-detail-${r.id}">${infoText}</span>
          </div>
          ${
            isActive || isPaused
              ? `<div class="transfer-progress">
              <div class="transfer-progress-bar${r.status === 'transferring' ? ' active' : ''}" id="tp-bar-${r.id}" style="width: ${progress}%"></div>
            </div>`
              : ''
          }
        </div>
        <div class="transfer-item-actions">
          ${actions}${folderBtn}${deleteBtn}
        </div>
      </div>`
  }

  /** @param {TransferRecord} r @returns {string} */
  #formatDetail(r) {
    const speedText = r.speed > 0 ? `${filesize(r.speed)}/s` : ''
    const sizeText = r.size > 0 ? filesize(r.size) : ''
    const loadedText = r.loaded > 0 ? filesize(r.loaded) : ''
    const isActive = r.status === 'transferring' || r.status === 'pending'
    const isPaused = r.status === 'paused'
    if (isActive || isPaused) {
      const parts = []
      if (loadedText && sizeText) parts.push(`${loadedText} / ${sizeText}`)
      else if (sizeText) parts.push(sizeText)
      if (speedText && isActive) parts.push(speedText)
      return parts.join(' · ')
    }
    if (r.status === 'completed') return sizeText
    if (r.status === 'failed') return r.error || '传输失败'
    return ''
  }

  /** @param {string} str @returns {string} */
  #esc(str) {
    const div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }
}

export { TransferManager }
