import { encode as encodeJpeg } from '@jsquash/jpeg'
import { optimise as optimisePng } from '@jsquash/oxipng'
import { encode as encodeWebp } from '@jsquash/webp'
import { encode as encodeAvif } from '@jsquash/avif'
import { filesize } from 'filesize'
import { COMPRESSIBLE_IMAGE_RE, MAX_UPLOAD_SIZE } from './constants.js'
import { t } from './i18n.js'
import { ConfigManager } from './config-manager.js'
import { FileExplorer } from './file-explorer.js'
import { R2Client } from './r2-client.js'
import { UIManager } from './ui-manager.js'
import { $, applyFilenameTemplate, getMimeType } from './utils.js'

/** @typedef {{ accountId?: string; accessKeyId?: string; secretAccessKey?: string; bucket?: string; filenameTpl?: string; customDomain?: string; compressMode?: string; compressLevel?: string; tinifyKey?: string }} AppConfig */

/**
 * Compress image file based on configuration
 * @param {File} file - Original file
 * @param {AppConfig} config - AppConfig object
 * @param {function(string):void} onStatus - Callback to update status text
 * @returns {Promise<File>}
 */
async function compressFile(file, config, onStatus) {
  const allowCompress = COMPRESSIBLE_IMAGE_RE.test(file.name)

  if (!allowCompress || !config.compressMode || config.compressMode === 'none') {
    if (config.compressMode && config.compressMode !== 'none' && !allowCompress) {
      onStatus && onStatus(t('compressNotSupported'))
    }
    return file
  }

  try {
    const originalSize = file.size

    if (config.compressMode === 'local') {
      onStatus && onStatus('压缩中...')

      const level = config.compressLevel || 'balanced'

      const jpegQuality = level === 'extreme' ? 75 : 90
      const avifQuality = level === 'extreme' ? 50 : 60

      const ext = file.name.toLowerCase().match(/\.(jpe?g|png|webp|avif)$/i)?.[1]
      let compressedBuffer
      let outputType = file.type

      if (ext === 'png') {
        const oxipngLevel = level === 'extreme' ? 4 : 2
        compressedBuffer = await optimisePng(await file.arrayBuffer(), {
          level: oxipngLevel,
          interlace: false,
          optimiseAlpha: true,
        })
        outputType = 'image/png'
      } else {
        const img = new Image()
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')

        await new Promise((resolve, reject) => {
          img.onload = resolve
          img.onerror = reject
          img.src = URL.createObjectURL(file)
        })

        canvas.width = img.width
        canvas.height = img.height
        ctx.drawImage(img, 0, 0)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        URL.revokeObjectURL(img.src)

        if (ext === 'jpg' || ext === 'jpeg') {
          compressedBuffer = await encodeJpeg(imageData, { quality: jpegQuality })
          outputType = 'image/jpeg'
        } else if (ext === 'webp') {
          compressedBuffer = await encodeWebp(imageData, { quality: jpegQuality })
          outputType = 'image/webp'
        } else if (ext === 'avif') {
          const avifSpeed = level === 'extreme' ? 4 : 6
          compressedBuffer = await encodeAvif(imageData, {
            quality: avifQuality,
            speed: avifSpeed,
          })
          outputType = 'image/avif'
        } else {
          return file
        }
      }

      const compressedBlob = new Blob([compressedBuffer], { type: outputType })

      const savings = Math.round((1 - compressedBlob.size / originalSize) * 100)

      if (savings > 0) {
        const msg = `本地压缩: ${filesize(originalSize)} → ${filesize(compressedBlob.size)} (省 ${savings}%)`
        onStatus && onStatus(msg)
        return new File([compressedBlob], file.name, { type: outputType })
      } else {
        const msg = `本地压缩: 原图更优 (${filesize(originalSize)})`
        onStatus && onStatus(msg)
        return file
      }
    }

    if (config.compressMode === 'tinify') {
      if (!config.tinifyKey) return file

      onStatus && onStatus('Cloud 压缩中...')

      const apiUrl = new URL('https://api.tinify.com/shrink')
      apiUrl.searchParams.set('proxy-host', 'api.tinify.com')
      apiUrl.host = 'proxy.viki.moe'

      const response = await fetch(apiUrl.toString(), {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + btoa('api:' + config.tinifyKey),
        },
        body: file,
      })

      if (!response.ok) throw new Error('Tinify API Error')

      const data = await response.json()
      const url = new URL(data.output.url)
      url.searchParams.set('proxy-host', 'api.tinify.com')
      url.host = 'proxy.viki.moe'

      const compressedRes = await fetch(url.toString())
      const compressedBlob = await compressedRes.blob()

      const savings = Math.round((1 - compressedBlob.size / originalSize) * 100)
      if (savings > 0) {
        onStatus &&
          onStatus(
            `Tinify: ${filesize(originalSize)} → ${filesize(compressedBlob.size)} (省 ${savings}%)`,
          )
      } else {
        onStatus && onStatus(`Tinify: 已优化 (${filesize(compressedBlob.size)})`)
      }

      return new File([compressedBlob], file.name, { type: file.type })
    }
  } catch {
    onStatus && onStatus('压缩失败，使用原图')
  }

  return file
}

class UploadManager {
  /** @type {R2Client} */
  #r2
  /** @type {UIManager} */
  #ui
  /** @type {FileExplorer} */
  #explorer
  /** @type {ConfigManager} */
  #config
  #dragCounter = 0

  /** @param {R2Client} r2 @param {UIManager} ui @param {FileExplorer} explorer @param {ConfigManager} config */
  constructor(r2, ui, explorer, config) {
    this.#r2 = r2
    this.#ui = ui
    this.#explorer = explorer
    this.#config = config
  }

  initDragDrop() {
    const app = $('#app')
    const dropzone = $('#dropzone')

    app.addEventListener('dragenter', e => {
      e.preventDefault()
      this.#dragCounter++
      dropzone.hidden = false
    })

    app.addEventListener('dragleave', e => {
      e.preventDefault()
      this.#dragCounter--
      if (this.#dragCounter <= 0) {
        this.#dragCounter = 0
        dropzone.hidden = true
      }
    })

    app.addEventListener('dragover', (/** @type {DragEvent} */ e) => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    })

    app.addEventListener('drop', (/** @type {DragEvent} */ e) => {
      e.preventDefault()
      this.#dragCounter = 0
      dropzone.hidden = true
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length > 0) this.uploadFiles(files)
    })

    document.addEventListener('paste', e => {
      const target = /** @type {HTMLElement} */ (e.target)
      const tag = target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return

      const items = [...(e.clipboardData?.items || [])]
      /** @type {File[]} */
      const files = items
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile())
        .filter(/** @returns {f is File} */ f => f !== null)

      if (files.length > 0) {
        e.preventDefault()
        this.#ui.toast(t('pasteToUpload', { count: files.length }), 'info')
        this.uploadFiles(files)
      }
    })
  }

  /** @param {File[]} files */
  async uploadFiles(files) {
    const panel = $('#upload-panel')
    const body = $('#upload-panel-body')
    const title = $('#upload-panel-title')

    panel.hidden = false
    body.innerHTML = ''

    const cfg = this.#config.get()
    const filenameTpl = cfg.filenameTpl || ''

    const uploads = []
    title.textContent = `${t('uploadProgress')} 0/${files.length}`

    for (let i = 0; i < files.length; i++) {
      let file = files[i]

      if (file.size > MAX_UPLOAD_SIZE) {
        this.#ui.toast(t('fileTooLarge', { name: file.name }), 'error')
        continue
      }

      const id = `upload-${i}-${Date.now()}`
      const displayName = file.name

      const item = document.createElement('div')
      item.className = 'upload-item'
      item.id = id
      item.innerHTML = `
        <div class="upload-item-header">
          <div class="upload-item-name" title="${displayName}">${displayName}</div>
          <div class="upload-item-status" id="${id}-status"></div>
        </div>
        <div class="upload-progress">
          <div class="upload-progress-bar" id="${id}-bar"></div>
        </div>
      `
      body.appendChild(item)

      const updateStatus = /** @param {string} msg */ msg => {
        const statusEl = $(`#${id}-status`)
        if (statusEl) statusEl.textContent = msg
      }
      file = await compressFile(file, cfg, updateStatus)

      const processedName = await applyFilenameTemplate(filenameTpl, file)
      const key = this.#explorer.currentPrefix + processedName
      const contentType = file.type || getMimeType(file.name)

      uploads.push({ id, key, file, contentType })
    }

    let completed = 0
    const results = await Promise.allSettled(
      uploads.map(u =>
        this.#uploadSingleFile(u.id, u.key, u.file, u.contentType).then(
          result => {
            completed++
            title.textContent = `${t('uploadProgress')} ${completed}/${uploads.length}`
            return result
          },
          error => {
            completed++
            title.textContent = `${t('uploadProgress')} ${completed}/${uploads.length}`
            throw error
          },
        ),
      ),
    )

    const success = results.filter(r => r.status === 'fulfilled').length
    const fail = results.filter(r => r.status === 'rejected').length

    if (fail === 0) {
      this.#ui.toast(t('uploadSuccess', { count: success }), 'success')
    } else {
      this.#ui.toast(t('uploadPartialFail', { success, fail }), 'error')
    }

    await this.#explorer.refresh()
  }

  /** @param {string} id @param {string} key @param {File} file @param {string} contentType */
  async #uploadSingleFile(id, key, file, contentType) {
    const signed = await this.#r2.putObjectSigned(key, contentType)
    const bar = $(`#${id}-bar`)

    if (bar) bar.classList.add('indeterminate')

    const headers = new Headers()
    for (const [k, v] of Object.entries(signed.headers)) {
      if (k.toLowerCase() !== 'host') headers.set(k, v)
    }

    const res = await fetch(signed.url, {
      method: 'PUT',
      headers,
      body: file,
    })

    if (bar) bar.classList.remove('indeterminate')

    if (!res.ok) {
      if (bar) bar.classList.add('error')
      throw new Error(`HTTP ${res.status}`)
    }

    if (bar) {
      bar.classList.add('done')
      bar.style.width = '100%'
    }
  }
}

export { UploadManager }
