import dayjs from 'dayjs'
import {
  IMAGE_RE,
  VIDEO_RE,
  AUDIO_RE,
  DOCUMENT_RE,
  ARCHIVE_RE,
  CODE_RE,
  TEXT_RE,
} from './constants.js'
import { getCurrentLang } from './i18n.js'

/** @type {<T extends HTMLElement = HTMLElement>(sel: string, ctx?: ParentNode) => T} */
const $ = (sel, ctx = document) => /** @type {*} */ (ctx.querySelector(sel))

/** @param {string|number|Date} dateStr @returns {string} */
function formatDate(dateStr) {
  const d = new Date(dateStr)
  const currentLang = getCurrentLang()
  return d.toLocaleDateString(
    currentLang === 'zh' ? 'zh-CN' : currentLang === 'ja' ? 'ja-JP' : 'en-US',
    {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    },
  )
}

/** @param {string} key @returns {string} */
function getFileName(key) {
  const parts = key.replace(/\/$/, '').split('/')
  return parts[parts.length - 1]
}

/** @param {string} key @returns {'image'|'video'|'audio'|'text'|'document'|'archive'|'code'|'file'} */
function getFileType(key) {
  if (IMAGE_RE.test(key)) return 'image'
  if (VIDEO_RE.test(key)) return 'video'
  if (AUDIO_RE.test(key)) return 'audio'
  if (DOCUMENT_RE.test(key)) return 'document'
  if (ARCHIVE_RE.test(key)) return 'archive'
  if (CODE_RE.test(key)) return 'code'
  if (TEXT_RE.test(key)) return 'text'
  return 'file'
}

/** @typedef {'http401Error' | 'http403Error' | 'http404Error' | 'corsError' | 'networkError'} ErrorMessageKey */

/**
 * Get user-friendly error message based on error type
 * @param {Error} err - Error object
 * @returns {ErrorMessageKey} - i18n key for the error message
 */
function getErrorMessage(err) {
  const msg = err.message
  if (msg === 'HTTP_401') return 'http401Error'
  if (msg === 'HTTP_403') return 'http403Error'
  if (msg === 'HTTP_404') return 'http404Error'
  if (err instanceof TypeError && msg.includes('Failed to fetch')) {
    return 'corsError'
  }
  return 'networkError'
}

/** @param {'image'|'video'|'audio'|'text'|'document'|'archive'|'code'|'file'} type @returns {string} */
function getFileIconSvg(type) {
  const svgBase =
    'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
  switch (type) {
    case 'video':
      return `<svg ${svgBase}><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>`
    case 'audio':
      return `<svg ${svgBase}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`
    case 'document':
      return `<svg ${svgBase}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`
    case 'archive':
      return `<svg ${svgBase}><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>`
    case 'code':
      return `<svg ${svgBase}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`
    case 'text':
      return `<svg ${svgBase}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`
    case 'image':
    default:
      return `<svg ${svgBase}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
  }
}

/** @param {string} name @returns {string} */
function getExtension(name) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1) : ''
}

/** @param {string} name @returns {string} */
function getBaseName(name) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

/** @param {string} key @returns {string} */
function getMimeType(key) {
  const ext = getExtension(key).toLowerCase()
  /** @type {Record<string, string>} */
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    avif: 'image/avif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    ogg: 'video/ogg',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    aac: 'audio/aac',
    m4a: 'audio/mp4',
    json: 'application/json',
    xml: 'application/xml',
    pdf: 'application/pdf',
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
  }
  return map[ext] || 'application/octet-stream'
}

/** @param {string} key @returns {string} */
function encodeS3Key(key) {
  return key.split('/').map(encodeURIComponent).join('/')
}

/** @param {File} file @returns {Promise<string>} */
async function computeFileHash(file) {
  const buffer = await file.arrayBuffer()
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/** @param {string} template @param {File} file @returns {Promise<string>} */
async function applyFilenameTemplate(template, file) {
  if (!template?.trim()) return file.name

  const originalName = file.name
  const ext = getExtension(originalName)
  const base = getBaseName(originalName)
  const fileHash = await computeFileHash(file)

  let result = template
  result = result.replace(/\[name\]/g, base)
  result = result.replace(/\[ext\]/g, ext)
  result = result.replace(/\[timestamp\]/g, String(Math.floor(Date.now() / 1000)))
  result = result.replace(/\[uuid\]/g, crypto.randomUUID())
  result = result.replace(/\[hash:(\d+)\]/g, (_, n) =>
    fileHash.slice(0, parseInt(/** @type {string} */ (n), 10)),
  )
  result = result.replace(/\[hash\]/g, fileHash.slice(0, 6))
  result = result.replace(/\[date:([^\]]+)\]/g, (_, format) =>
    dayjs().format(/** @type {string} */ (format)),
  )

  return result
}

export {
  $,
  formatDate,
  getFileName,
  getFileType,
  getErrorMessage,
  getFileIconSvg,
  getExtension,
  getBaseName,
  getMimeType,
  encodeS3Key,
  computeFileHash,
  applyFilenameTemplate,
}
