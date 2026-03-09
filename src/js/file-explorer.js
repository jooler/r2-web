import { filesize } from 'filesize'
import { IMAGE_RE } from './constants.js'
import { t } from './i18n.js'
import { R2Client } from './r2-client.js'
import { UIManager } from './ui-manager.js'
import { $, formatDate, getErrorMessage, getFileIconSvg, extractFileName, getFileType } from './utils.js'

/** @typedef {{ key: string; isFolder: boolean; size?: number; lastModified?: string }} FileItem */
/** @typedef {{ data: { folders: FileItem[], files: FileItem[], isTruncated: boolean, nextToken: string }, ts: number }} CacheEntry */

const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

class FileExplorer {
  /** @type {R2Client} */
  #r2
  /** @type {UIManager} */
  #ui
  #prefix = ''
  #continuationToken = ''
  /** @type {IntersectionObserver} */
  #thumbnailObserver
  #sortBy = 'name'
  #sortOrder = /** @type {'asc' | 'desc'} */ ('asc')
  /** @type {Map<string, CacheEntry>} */
  #cache = new Map()
  /** @type {FileItem[]} */
  #loadedItems = []

  /** @param {R2Client} r2 @param {UIManager} ui */
  constructor(r2, ui) {
    this.#r2 = r2
    this.#ui = ui

    this.#thumbnailObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const card = /** @type {HTMLElement} */ (entry.target)
            const key = card.dataset.key ?? ''
            this.#thumbnailObserver.unobserve(card)
            this.#lazyLoadThumbnail(card, key)
          }
        }
      },
      { rootMargin: '100px' },
    )
  }

  get currentPrefix() {
    return this.#prefix
  }

  get currentSortBy() {
    return this.#sortBy
  }

  get currentSortOrder() {
    return this.#sortOrder
  }

  /** @param {string} sortBy */
  setSortBy(sortBy) {
    this.#sortBy = sortBy
    this.#resortAndRender()
  }

  /** @param {'asc' | 'desc'} order */
  setSortOrder(order) {
    this.#sortOrder = order
    this.#resortAndRender()
  }

  #resortAndRender() {
    if (this.#loadedItems.length === 0) return
    $('#file-grid').innerHTML = ''
    this.#renderItems(this.#sortItems(this.#loadedItems))
  }

  /** @param {string} prefix */
  async navigate(prefix) {
    this.#prefix = prefix
    this.#continuationToken = ''
    this.#loadedItems = []
    $('#file-grid').innerHTML = ''
    $('#load-more').hidden = true
    $('#item-count').hidden = true
    this.#updateBreadcrumb()
    await this.#loadPage(true)
  }

  async loadMore() {
    if (!this.#continuationToken) return
    await this.#loadPage(false)
  }

  /** @param {boolean} isInitial @param {boolean} [bypassCache] */
  async #loadPage(isInitial, bypassCache = false) {
    if (isInitial) this.#ui.showSkeleton()
    try {
      const cacheKey = `${this.#prefix}::${this.#continuationToken}`
      const cached = this.#cache.get(cacheKey)
      let result

      if (!bypassCache && cached && Date.now() - cached.ts < CACHE_TTL) {
        result = cached.data
      } else {
        result = await this.#r2.listObjects(this.#prefix, this.#continuationToken)
        this.#cache.set(cacheKey, { data: result, ts: Date.now() })
      }

      this.#continuationToken = result.isTruncated ? result.nextToken : ''

      if (isInitial) this.#ui.hideSkeleton()

      const items = [...result.folders, ...result.files]
      this.#loadedItems.push(...items)

      if (isInitial) {
        const sortedItems = this.#sortItems(this.#loadedItems)
        if (sortedItems.length === 0) {
          this.#ui.showEmptyState()
        } else {
          this.#ui.hideEmptyState()
          this.#renderItems(sortedItems)
        }
      } else {
        this.#ui.hideEmptyState()
        $('#file-grid').innerHTML = ''
        this.#renderItems(this.#sortItems(this.#loadedItems))
      }

      const countEl = $('#item-count')
      countEl.textContent = result.isTruncated
        ? t('itemsPartial', { count: this.#loadedItems.length })
        : t('itemsTotal', { count: this.#loadedItems.length })
      countEl.hidden = this.#loadedItems.length === 0
      $('#load-more').hidden = !result.isTruncated
    } catch (/** @type {any} */ err) {
      if (isInitial) this.#ui.hideSkeleton()

      const errorKey = getErrorMessage(err)
      if (errorKey === 'networkError') {
        this.#ui.toast(t('networkError', { msg: err.message }), 'error')
      } else {
        this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
      }

      if (err.message === 'HTTP_401' || err.message === 'HTTP_403') {
        throw err
      }
    }
  }

  invalidateCache(prefix = '') {
    if (!prefix) {
      this.#cache.clear()
      return
    }
    for (const key of this.#cache.keys()) {
      if (key.startsWith(prefix + '::') || key.startsWith(prefix)) {
        this.#cache.delete(key)
      }
    }
  }

  updateCountDisplay() {
    if (this.#loadedItems.length === 0) return
    const isTruncated = !!this.#continuationToken
    $('#item-count').textContent = isTruncated
      ? t('itemsPartial', { count: this.#loadedItems.length })
      : t('itemsTotal', { count: this.#loadedItems.length })
  }

  /** @param {FileItem[]} items @returns {FileItem[]} */
  #sortItems(items) {
    const { true: folders = [], false: files = [] } = Object.groupBy(items, (i) => String(i.isFolder))

    /** @type {(a: FileItem, b: FileItem) => number} */
    const byName = (a, b) => extractFileName(a.key).localeCompare(extractFileName(b.key))

    /** @type {Record<string, (a: FileItem, b: FileItem) => number>} */
    const comparators = {
      name: byName,
      date: (a, b) => new Date(a.lastModified ?? 0).getTime() - new Date(b.lastModified ?? 0).getTime(),
      size: (a, b) => (a.size ?? 0) - (b.size ?? 0),
    }

    const cmp = comparators[this.#sortBy] ?? byName
    const directedCmp =
      this.#sortOrder === 'asc' ? cmp : (/** @type {FileItem} */ a, /** @type {FileItem} */ b) => cmp(b, a)
    const directedByName =
      this.#sortOrder === 'asc' ? byName : (/** @type {FileItem} */ a, /** @type {FileItem} */ b) => byName(b, a)
    return [...folders.toSorted(directedByName), ...files.toSorted(directedCmp)]
  }

  /** @param {FileItem[]} items */
  #renderItems(items) {
    const grid = $('#file-grid')
    const frag = document.createDocumentFragment()

    for (const item of items) {
      const card = this.#createFileCard(item)
      frag.appendChild(card)
    }

    grid.appendChild(frag)
  }

  /** @param {FileItem} item @returns {HTMLDivElement} */
  #createFileCard(item) {
    const card = document.createElement('div')
    card.className = 'file-card'
    card.dataset.key = item.key
    card.dataset.isFolder = String(item.isFolder)
    if (!item.isFolder) {
      card.dataset.size = String(item.size ?? 0)
      if (item.lastModified) {
        card.dataset.mod = String(new Date(item.lastModified).getTime())
      }
    }

    const name = extractFileName(item.key)
    const isImage = !item.isFolder && IMAGE_RE.test(item.key)

    let iconHtml
    if (item.isFolder) {
      iconHtml = `<div class="file-card-icon folder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      </div>`
    } else if (isImage) {
      iconHtml = `<img class="file-card-thumb" alt="" loading="lazy">`
    } else {
      const fileType = getFileType(item.key)
      iconHtml = `<div class="file-card-icon ${fileType}">
        ${getFileIconSvg(fileType)}
      </div>`
    }

    card.innerHTML = `
      ${iconHtml}
      <span class="file-card-name"></span>
      ${
        !item.isFolder
          ? `
        <span class="file-card-size">${filesize(item.size ?? 0)}</span>
        <span class="file-card-date">${formatDate(item.lastModified ?? '')}</span>
      `
          : ''
      }
      <div class="file-card-actions">
        <button type="button" class="icon-btn sm file-card-menu" title="More">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
        </button>
      </div>
    `
    const nameEl = /** @type {HTMLElement} */ (card.querySelector('.file-card-name'))
    nameEl.textContent = name
    nameEl.setAttribute('title', name)

    if (isImage) {
      this.#thumbnailObserver.observe(card)
    }

    return card
  }

  /** @param {HTMLElement} card @param {string} key */
  async #lazyLoadThumbnail(card, key) {
    try {
      const url = this.#r2.getPublicUrl(key) ?? (await this.#r2.getPresignedUrl(key))
      const img = /** @type {HTMLImageElement} */ ($('img', card))
      if (!img) return
      img.onload = () => img.classList.add('loaded')
      img.onerror = () => img.classList.add('loaded')
      img.src = url
    } catch {
      /* ignore thumbnail failures */
    }
  }

  #updateBreadcrumb() {
    const ol = $('#breadcrumb')
    ol.innerHTML = ''

    const rootLi = document.createElement('li')
    const rootBtn = document.createElement('button')
    rootBtn.type = 'button'
    rootBtn.className = 'breadcrumb-btn'
    rootBtn.dataset.prefix = ''
    rootBtn.textContent = t('root')
    rootLi.appendChild(rootBtn)
    ol.appendChild(rootLi)

    if (this.#prefix) {
      const parts = this.#prefix.replace(/\/$/, '').split('/')
      let accumulated = ''
      for (const part of parts) {
        accumulated += part + '/'
        const li = document.createElement('li')
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'breadcrumb-btn'
        btn.dataset.prefix = accumulated
        btn.textContent = part
        li.appendChild(btn)
        ol.appendChild(li)
      }
    }
  }

  async refresh() {
    this.invalidateCache(this.#prefix)
    this.#continuationToken = ''
    this.#loadedItems = []
    $('#file-grid').innerHTML = ''
    this.#updateBreadcrumb()
    await this.#loadPage(true, true)
  }
}

export { FileExplorer }
