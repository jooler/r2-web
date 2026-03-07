import { IMAGE_RE } from './constants.js'
import { t } from './i18n.js'
import { ConfigManager } from './config-manager.js'
import { FileExplorer } from './file-explorer.js'
import { R2Client } from './r2-client.js'
import { UIManager } from './ui-manager.js'
import { getErrorMessage, getFileName } from './utils.js'

class FileOperations {
  /** @type {R2Client} */
  #r2
  /** @type {UIManager} */
  #ui
  /** @type {FileExplorer} */
  #explorer
  /** @type {ConfigManager} */
  #config

  /** @param {R2Client} r2 @param {UIManager} ui @param {FileExplorer} explorer @param {ConfigManager} config */
  constructor(r2, ui, explorer, config) {
    this.#r2 = r2
    this.#ui = ui
    this.#explorer = explorer
    this.#config = config
  }

  /** @param {string} key @param {boolean} isFolder */
  async rename(key, isFolder) {
    const oldName = getFileName(key)
    const newName = await this.#ui.prompt(t('renameTitle'), t('renameLabel'), oldName, {
      validate: v => {
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
    const name = getFileName(key)
    const currentPrefix = this.#explorer.currentPrefix
    const dest = await this.#ui.prompt(
      t('copyTitle'),
      t('copyLabel'),
      currentPrefix + name + (isFolder ? '/' : ''),
    )
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
  async move(key, isFolder) {
    const name = getFileName(key)
    const currentPrefix = this.#explorer.currentPrefix
    const dest = await this.#ui.prompt(
      t('moveTitle'),
      t('moveLabel'),
      currentPrefix + name + (isFolder ? '/' : ''),
    )
    if (!dest) return

    try {
      this.#ui.toast(t('moving', { name, destName: dest }), 'info')

      if (isFolder) {
        await this.#recursiveOperation(
          key,
          async (/** @type {string} */ srcKey) => {
            const relative = srcKey.substring(key.length)
            const destKey = (dest.endsWith('/') ? dest : dest + '/') + relative
            await this.#r2.copyObject(srcKey, destKey)
          },
          true,
        )
      } else {
        await this.#r2.copyObject(key, dest)
        await this.#r2.deleteObject(key)
      }
      this.#ui.toast(t('moveSuccess', { name: dest }), 'success')
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
    const name = getFileName(key)
    const msg = isFolder ? t('deleteFolderConfirmMsg', { name }) : t('deleteConfirmMsg', { name })

    const ok = await this.#ui.confirm(t('deleteConfirmTitle'), msg)
    if (!ok) return

    try {
      this.#ui.toast(t('deleting', { name }), 'info')

      if (isFolder) {
        await this.#recursiveOperation(
          key,
          async srcKey => {
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

  /** @param {string} key */
  async download(key) {
    try {
      const url = await this.#r2.getDownloadUrl(key, getFileName(key))
      const a = document.createElement('a')
      a.href = url
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (/** @type {any} */ err) {
      const errorKey = getErrorMessage(err)
      if (errorKey === 'networkError') {
        this.#ui.toast(t('networkError', { msg: err.message }), 'error')
      } else {
        this.#ui.toast(t(/** @type {any} */ (errorKey)), 'error')
      }
    }
  }

  /** @param {string} key @param {'url'|'markdown'|'html'|'presigned'} format */
  async copyAs(key, format) {
    const name = getFileName(key)
    const isImage = IMAGE_RE.test(key)

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
        text = isImage ? `<img src="${url}" alt="${name}">` : `<a href="${url}">${name}</a>`
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
    await this.#ui.showFileQrDialog(url, getFileName(key))
  }

  /** @param {string} prefix @param {(key: string) => Promise<void>} operation @param {boolean} deleteSource */
  async #recursiveOperation(prefix, operation, deleteSource) {
    const allKeys = await this.#collectAllKeys(prefix)

    for (let i = 0; i < allKeys.length; i += 5) {
      const batch = allKeys.slice(i, i + 5)
      await Promise.all(batch.map(k => operation(k)))
    }

    if (deleteSource) {
      for (let i = 0; i < allKeys.length; i += 5) {
        const batch = allKeys.slice(i, i + 5)
        await Promise.all(batch.map(k => this.#r2.deleteObject(k)))
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
