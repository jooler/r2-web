import { IMAGE_RE, VIDEO_RE, AUDIO_RE } from './constants.js'
import { t } from './i18n.js'
import { FileExplorer } from './file-explorer.js'
import { R2Client } from './r2-client.js'
import { TransferManager } from './transfer-manager.js'
import { UIManager } from './ui-manager.js'
import { getErrorMessage, extractFileName } from './utils.js'

class FileOperations {
  /** @type {R2Client} */
  #r2
  /** @type {UIManager} */
  #ui
  /** @type {FileExplorer} */
  #explorer
  /** @type {TransferManager} */
  #transfer

  /** @param {R2Client} r2 @param {UIManager} ui @param {FileExplorer} explorer @param {TransferManager} transfer */
  constructor(r2, ui, explorer, transfer) {
    this.#r2 = r2
    this.#ui = ui
    this.#explorer = explorer
    this.#transfer = transfer
  }

  /** @param {string} key @param {boolean} isFolder */
  async rename(key, isFolder) {
    const oldName = extractFileName(key)
    const newName = await this.#ui.prompt(t('renameTitle'), t('renameLabel'), oldName, {
      validate: (v) => {
        const illegal = v.match(/[/\\:*?"<>|\x00-\x1F]/g)
        if (illegal) return t('renameInvalidChars', { chars: [...new Set(illegal)].join('  ') })
        return null
      },
    })
    if (!newName || newName === oldName) return

    try {
      this.#ui.toast(t('renaming', { name: oldName, destName: newName }), 'info')

      const prefix = key.substring(0, key.lastIndexOf(oldName))
      if (isFolder) {
        const dest = prefix + newName + '/'
        await this.#recursiveOperation(
          key,
          async (/** @type {string} */ srcKey) => {
            const relative = srcKey.substring(key.length)
            await this.#r2.copyObject(srcKey, dest + relative)
          },
          true,
        )
      } else {
        const dest = prefix + newName
        await this.#r2.copyObject(key, dest)
        await this.#r2.deleteObject(key)
      }
      this.#ui.toast(t('renameSuccess', { name: newName }), 'success')
      if (isFolder) this.#explorer.invalidateCache(key)
      await this.#explorer.refresh()
    } catch (/** @type {any} */ err) {
      const errorKey = getErrorMessage(err)
      if (errorKey === 'networkError') {
        this.#ui.toast(t('networkError', { msg: err.message }), 'error')
      } else {
        this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
      }
    }
  }

  /** @param {string} key @param {boolean} isFolder */
  async copy(key, isFolder) {
    const name = extractFileName(key)
    const currentPrefix = this.#explorer.currentPrefix

    const dest = await this.#ui.prompt(t('copyTitle'), t('copyLabel'), currentPrefix + name + (isFolder ? '/' : ''), {
      hint: isFolder ? t('copyFolderHint') : undefined,
      validate: (v) => {
        const illegal = v.match(/[\\:*?"<>|\x00-\x1F]/g)
        if (illegal) return t('pathInvalidChars', { chars: [...new Set(illegal)].join('  ') })
        if (v === key) return t('copySamePath')
        return null
      },
    })
    if (!dest) return

    try {
      this.#ui.toast(t('copying', { name, destName: dest }), 'info')

      if (isFolder) {
        await this.#recursiveOperation(
          key,
          async (/** @type {string} */ srcKey) => {
            const relative = srcKey.substring(key.length)
            const destKey = (dest.endsWith('/') ? dest : dest + '/') + relative
            await this.#r2.copyObject(srcKey, destKey)
          },
          false,
        )
      } else {
        await this.#r2.copyObject(key, dest)
      }
      this.#ui.toast(t('copySuccess', { name: dest }), 'success')
      const destPrefix = dest.substring(0, dest.lastIndexOf('/') + 1)
      if (isFolder) this.#explorer.invalidateCache()
      else this.#explorer.invalidateCache(destPrefix)
      if (destPrefix.startsWith(this.#explorer.currentPrefix)) await this.#explorer.refresh()
    } catch (/** @type {any} */ err) {
      const errorKey = getErrorMessage(err)
      if (errorKey === 'networkError') {
        this.#ui.toast(t('networkError', { msg: err.message }), 'error')
      } else {
        this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
      }
    }
  }

  /** @param {string} key @param {boolean} isFolder */
  async move(key, isFolder) {
    const name = extractFileName(key)
    const currentPrefix = this.#explorer.currentPrefix

    /** @param {string} v */
    const resolveDest = (v) => {
      const folder = v === '' ? '' : v.endsWith('/') ? v : v + '/'
      return folder + name + (isFolder ? '/' : '')
    }

    const destFolder = await this.#ui.prompt(t('moveTitle'), t('moveLabel'), currentPrefix, {
      preview: (v) => '→ ' + resolveDest(v),
      validate: (v) => (resolveDest(v) === key ? t('moveSamePath') : null),
    })

    if (destFolder === null) return

    const dest = resolveDest(destFolder)

    if (dest === key) return

    try {
      this.#ui.toast(t('moving', { name, destName: dest }), 'info')

      if (isFolder) {
        await this.#recursiveOperation(
          key,
          async (/** @type {string} */ srcKey) => {
            const relative = srcKey.substring(key.length)
            await this.#r2.copyObject(srcKey, dest + relative)
          },
          true,
        )
      } else {
        await this.#r2.copyObject(key, dest)
        await this.#r2.deleteObject(key)
      }
      this.#ui.toast(t('moveSuccess', { name: dest }), 'success')
      if (isFolder) this.#explorer.invalidateCache()
      else this.#explorer.invalidateCache(dest.substring(0, dest.lastIndexOf('/') + 1))
      await this.#explorer.refresh()
    } catch (/** @type {any} */ err) {
      const errorKey = getErrorMessage(err)
      if (errorKey === 'networkError') {
        this.#ui.toast(t('networkError', { msg: err.message }), 'error')
      } else {
        this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
      }
    }
  }

  /** @param {string} key @param {boolean} isFolder */
  async delete(key, isFolder) {
    const name = extractFileName(key)
    const msg = isFolder ? t('deleteFolderConfirmMsg', { name }) : t('deleteConfirmMsg', { name })

    const ok = await this.#ui.confirm(t('deleteConfirmTitle'), msg)
    if (!ok) return

    try {
      this.#ui.toast(t('deleting', { name }), 'info')

      if (isFolder) {
        await this.#recursiveOperation(
          key,
          async (srcKey) => {
            await this.#r2.deleteObject(srcKey)
          },
          false,
        )
        try {
          await this.#r2.deleteObject(key)
        } catch {}
      } else {
        await this.#r2.deleteObject(key)
      }
      this.#ui.toast(t('deleteSuccess', { name }), 'success')
      if (isFolder) this.#explorer.invalidateCache(key)
      await this.#explorer.refresh()
    } catch (/** @type {any} */ err) {
      const errorKey = getErrorMessage(err)
      if (errorKey === 'networkError') {
        this.#ui.toast(t('networkError', { msg: err.message }), 'error')
      } else {
        this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
      }
    }
  }

  /**
   * @param {import('./file-explorer.js').SelectionItem[]} items
   *
   * @returns {Promise<boolean>} 用户取消返回 false，实际执行返回 true
   */
  async deleteMany(items) {
    const count = items.length
    const ok = await this.#ui.confirm(t('batchDeleteTitle'), t('batchDeleteConfirmMsg', { count }))
    if (!ok) return false

    this.#ui.toast(t('batchDeleting', { count }), 'info')
    let success = 0
    let fail = 0

    for (const item of items) {
      try {
        if (item.isFolder) {
          await this.#recursiveOperation(item.key, async (k) => this.#r2.deleteObject(k), false)
          try {
            await this.#r2.deleteObject(item.key)
          } catch {}
        } else {
          await this.#r2.deleteObject(item.key)
        }
        success++
      } catch {
        fail++
      }
    }

    this.#ui.toast(
      fail === 0 ? t('batchDeleteSuccess', { count: success }) : t('batchDeletePartial', { success, fail }),
      fail === 0 ? 'success' : 'error',
    )
    this.#explorer.invalidateCache(this.#explorer.currentPrefix)
    await this.#explorer.refresh()
    return true
  }

  /**
   * @param {import('./file-explorer.js').SelectionItem[]} items
   * @returns {Promise<boolean>} 用户取消返回 false，实际执行返回 true
   */
  async moveMany(items) {
    const count = items.length
    const currentPrefix = this.#explorer.currentPrefix

    const destFolder = await this.#ui.prompt(t('batchMoveTitle'), t('batchMoveLabel'), currentPrefix, {
      validate: (v) => {
        const folder = v === '' ? '' : v.endsWith('/') ? v : v + '/'
        const allSame = items.every((item) => {
          const name = extractFileName(item.key)
          return folder + name + (item.isFolder ? '/' : '') === item.key
        })
        return allSame ? t('batchMoveSamePath') : null
      },
    })
    if (destFolder === null) return false

    const folder = destFolder === '' ? '' : destFolder.endsWith('/') ? destFolder : destFolder + '/'
    this.#ui.toast(t('batchMoving', { count }), 'info')
    let success = 0
    let fail = 0

    for (const item of items) {
      const name = extractFileName(item.key)
      const dest = folder + name + (item.isFolder ? '/' : '')
      if (dest === item.key) continue

      try {
        if (item.isFolder) {
          await this.#recursiveOperation(
            item.key,
            async (/** @type {string} */ srcKey) => {
              await this.#r2.copyObject(srcKey, dest + srcKey.substring(item.key.length))
            },
            true,
          )
        } else {
          await this.#r2.copyObject(item.key, dest)
          await this.#r2.deleteObject(item.key)
        }
        success++
      } catch {
        fail++
      }
    }

    this.#ui.toast(
      fail === 0
        ? t('batchMoveSuccess', { count: success, dest: folder || '/' })
        : t('batchMovePartial', { success, fail }),
      fail === 0 ? 'success' : 'error',
    )
    this.#explorer.invalidateCache()
    await this.#explorer.refresh()
    return true
  }

  /**
   * @param {import('./file-explorer.js').SelectionItem[]} items
   * @returns {Promise<boolean>} 用户取消返回 false，实际执行返回 true
   */
  async copyMany(items) {
    const count = items.length
    const currentPrefix = this.#explorer.currentPrefix

    const destFolder = await this.#ui.prompt(t('batchCopyTitle'), t('batchCopyLabel'), currentPrefix, {
      validate: (v) => {
        const folder = v === '' ? '' : v.endsWith('/') ? v : v + '/'
        const allSame = items.every((item) => {
          const name = extractFileName(item.key)
          return folder + name + (item.isFolder ? '/' : '') === item.key
        })
        return allSame ? t('batchCopySamePath') : null
      },
    })
    if (destFolder === null) return false

    const folder = destFolder === '' ? '' : destFolder.endsWith('/') ? destFolder : destFolder + '/'
    this.#ui.toast(t('batchCopying', { count }), 'info')
    let success = 0
    let fail = 0

    for (const item of items) {
      const name = extractFileName(item.key)
      const dest = folder + name + (item.isFolder ? '/' : '')
      if (dest === item.key) continue

      try {
        if (item.isFolder) {
          await this.#recursiveOperation(
            item.key,
            async (/** @type {string} */ srcKey) => {
              await this.#r2.copyObject(srcKey, dest + srcKey.substring(item.key.length))
            },
            false,
          )
        } else {
          await this.#r2.copyObject(item.key, dest)
        }
        success++
      } catch {
        fail++
      }
    }

    this.#ui.toast(
      fail === 0
        ? t('batchCopySuccess', { count: success, dest: folder || '/' })
        : t('batchCopyPartial', { success, fail }),
      fail === 0 ? 'success' : 'error',
    )
    this.#explorer.invalidateCache()
    await this.#explorer.refresh()
    return true
  }

  /** @param {string} key @param {number} [size] */
  async download(key, size) {
    try {
      const filename = extractFileName(key)

      /** @type {FileSystemFileHandle | undefined} */
      let fileHandle
      const showSavePicker = /** @type {any} */ (window).showSaveFilePicker
      if (typeof showSavePicker === 'function') {
        try {
          fileHandle = await showSavePicker({ suggestedName: filename })
        } catch (/** @type {any} */ e) {
          if (e.name === 'AbortError') return
          throw e
        }
      }

      await this.#transfer.addDownload(key, filename, size, fileHandle)
      if (!this.#transfer.isOpen) {
        this.#transfer.open()
      }
    } catch (/** @type {any} */ err) {
      const errorKey = getErrorMessage(err)
      if (errorKey === 'networkError') {
        this.#ui.toast(t('networkError', { msg: err.message }), 'error')
      } else {
        this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
      }
    }
  }

  /** @param {string} key @param {'path'|'url'|'markdown'|'html'|'presigned'} format */
  async copyAs(key, format) {
    const name = extractFileName(key)
    const isImage = IMAGE_RE.test(key)
    const isVideo = VIDEO_RE.test(key)
    const isAudio = AUDIO_RE.test(key)

    if (format === 'path') {
      try {
        await navigator.clipboard.writeText(key)
        this.#ui.toast(t('linkCopied'), 'success')
      } catch {
        await this.#ui.prompt(t('copyLink'), '', key)
      }
      return
    }

    let url
    if (format === 'presigned') {
      url = await this.#r2.getPresignedUrl(key)
    } else {
      url = this.#r2.getPublicUrl(key) ?? (await this.#r2.getPresignedUrl(key))
    }

    let text
    switch (format) {
      case 'markdown':
        text = isImage ? `![${name}](${url})` : `[${name}](${url})`
        break
      case 'html':
        if (isImage) text = `<img src="${url}" alt="${name}">`
        else if (isVideo) text = `<video src="${url}" controls></video>`
        else if (isAudio) text = `<audio src="${url}" controls></audio>`
        else text = `<a href="${url}">${name}</a>`
        break
      default:
        text = url
        break
    }

    try {
      await navigator.clipboard.writeText(text)
      this.#ui.toast(t('linkCopied'), 'success')
    } catch {
      await this.#ui.prompt(t('copyLink'), '', text)
    }
  }

  /** @param {string} key */
  async copyImage(key) {
    if (!IMAGE_RE.test(key)) {
      this.#ui.toast(t('copyImageNotSupportedType'), 'error')
      return
    }
    if (!navigator.clipboard || !window.ClipboardItem) {
      this.#ui.toast(t('copyImageNotSupported'), 'error')
      return
    }
    try {
      const url = this.#r2.getPublicUrl(key) ?? (await this.#r2.getPresignedUrl(key))
      const res = await fetch(url)
      const blob = await res.blob()
      const item = new ClipboardItem({ [blob.type || 'image/png']: blob })
      await navigator.clipboard.write([item])
      this.#ui.toast(t('copyImageSuccess'), 'success')
    } catch {
      this.#ui.toast(t('copyImageFailed'), 'error')
    }
  }

  /** @param {string} key */
  async shareQr(key) {
    const url = this.#r2.getPublicUrl(key)
    if (!url) {
      this.#ui.toast(t('shareQrNeedDomain'), 'error')
      return
    }
    await this.#ui.showFileQrDialog(url, extractFileName(key))
  }

  /** @param {string} prefix @param {(key: string) => Promise<void>} operation @param {boolean} deleteSource */
  async #recursiveOperation(prefix, operation, deleteSource) {
    const allKeys = await this.#collectAllKeys(prefix)

    for (let i = 0; i < allKeys.length; i += 5) {
      const batch = allKeys.slice(i, i + 5)
      await Promise.all(batch.map((k) => operation(k)))
    }

    if (deleteSource) {
      for (let i = 0; i < allKeys.length; i += 5) {
        const batch = allKeys.slice(i, i + 5)
        await Promise.all(batch.map((k) => this.#r2.deleteObject(k)))
      }
      try {
        await this.#r2.deleteObject(prefix)
      } catch {}
    }
  }

  /** @param {string} prefix @returns {Promise<string[]>} */
  async #collectAllKeys(prefix) {
    /** @type {string[]} */
    let allKeys = []
    let token = ''
    do {
      const result = await this.#r2.listObjects(prefix, token)
      for (const file of result.files) {
        allKeys.push(file.key)
      }
      for (const folder of result.folders) {
        allKeys.push(folder.key)
        const subKeys = await this.#collectAllKeys(folder.key)
        allKeys.push(...subKeys)
      }
      token = result.isTruncated ? result.nextToken : ''
    } while (token)
    return allKeys
  }
}

export { FileOperations }
