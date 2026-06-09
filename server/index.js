import { execFile } from 'node:child_process'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { listSources, resolveAdapter } from './adapters/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const legacyDownloadRoot = join(__dirname, 'downloads')
const mediaRoot = resolve(process.env.PICHARBOR_MEDIA_ROOT ?? legacyDownloadRoot)
const configRoot = resolve(process.env.PICHARBOR_CONFIG_ROOT ?? join(__dirname, 'config'))
const albumConfigRoot = join(configRoot, 'albums')
const thumbRoot = join(configRoot, 'thumbs')
const siteCookieRoot = join(configRoot, 'cookies')
const xchinaCookieFile = resolve(process.env.PICHARBOR_XCHINA_COOKIE_FILE ?? join(siteCookieRoot, 'xchina.txt'))
const liuseCookieFile = resolve(process.env.PICHARBOR_LIUSE_COOKIE_FILE ?? join(siteCookieRoot, 'liuse.txt'))
const proxyConfigFile = resolve(process.env.PICHARBOR_PROXY_FILE ?? join(configRoot, 'proxy.txt'))
const flareSolverrConfigFile = resolve(process.env.PICHARBOR_FLARESOLVERR_FILE ?? join(configRoot, 'flaresolverr.txt'))
const xchinaUserAgentFile = resolve(process.env.PICHARBOR_XCHINA_USER_AGENT_FILE ?? join(configRoot, 'xchina-user-agent.txt'))
const authConfigFile = resolve(process.env.PICHARBOR_AUTH_FILE ?? join(configRoot, 'auth.json'))
const sessionConfigFile = resolve(process.env.PICHARBOR_SESSION_FILE ?? join(configRoot, 'sessions.json'))
const staticRoot = resolve(process.env.PICHARBOR_WEB_ROOT ?? join(projectRoot, 'dist'))
const port = Number(process.env.PICHARBOR_API_PORT ?? 4177)
const host = process.env.PICHARBOR_HOST ?? '127.0.0.1'
process.env.PICHARBOR_XCHINA_COOKIE_FILE = xchinaCookieFile
process.env.PICHARBOR_LIUSE_COOKIE_FILE = liuseCookieFile
process.env.PICHARBOR_SITE_COOKIE_ROOT = siteCookieRoot
process.env.PICHARBOR_PROXY_FILE = proxyConfigFile
process.env.PICHARBOR_FLARESOLVERR_FILE = flareSolverrConfigFile
process.env.PICHARBOR_XCHINA_USER_AGENT_FILE = xchinaUserAgentFile
const execFileAsync = promisify(execFile)
const defaultUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const imageAcceptHeader = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
const videoAcceptHeader = 'video/mp4,video/webm,video/*,*/*;q=0.8'
const acceptLanguageHeader = 'zh-CN,zh;q=0.9,en;q=0.8'
const demoDataEnabled = process.env.PICHARBOR_DEMO_DATA !== 'false'
const sessionCookieName = 'picharbor_session'
const sessionMaxAgeMs = 30 * 24 * 60 * 60 * 1000
const scryptAsync = promisify(scrypt)
const imageExtensions = new Set(['.avif', '.gif', '.jpg', '.jpeg', '.png', '.webp'])
const videoExtensions = new Set(['.m4v', '.mov', '.mp4', '.webm'])
const failedImagePlaceholder = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><rect width="320" height="240" fill="#eef1ee"/><path d="M96 152l36-42 28 32 18-20 46 54H88z" fill="#c8d1cb"/><text x="160" y="106" text-anchor="middle" fill="#617168" font-family="Arial, sans-serif" font-size="18">Download failed</text></svg>',
)}`
const videoThumbPlaceholder = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><rect width="320" height="240" fill="#16201c"/><circle cx="160" cy="120" r="42" fill="#ecf4ef" opacity=".9"/><path d="M148 96v48l40-24z" fill="#28483d"/><text x="160" y="188" text-anchor="middle" fill="#d9e7df" font-family="Arial, sans-serif" font-size="18">Video</text></svg>',
)}`
const pendingDownloadJobs = []
const pausedDownloadJobs = new Map()
let activeDownloadJob = null

const albums = [
  {
    id: 'summer',
    title: '夏日旅拍合集 Vol.12',
    source: '站点适配器 A',
    count: 186,
    size: '2.8 GB',
    updated: '刚刚更新',
    status: '下载中',
    cover:
      'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=80',
    tags: ['旅拍', '户外', '待整理'],
  },
  {
    id: 'studio',
    title: '棚拍精选 - 黑白光影',
    source: '站点适配器 B',
    count: 74,
    size: '890 MB',
    updated: '队列中',
    status: '等待',
    cover:
      'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=900&q=80',
    tags: ['棚拍', '黑白', '高优先'],
  },
  {
    id: 'film',
    title: '复古胶片色调样张',
    source: '本地导入',
    count: 132,
    size: '1.4 GB',
    updated: '12 分钟前',
    status: '已完成',
    cover:
      'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?auto=format&fit=crop&w=900&q=80',
    tags: ['胶片', '样张', '已归档'],
  },
]

const photos = [
  {
    id: 'p-01',
    albumId: 'summer',
    title: '滨海步道 001',
    url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80',
    resolution: '3840 x 5760',
    size: '18.6 MB',
    tags: ['海边', '暖色', '精选'],
  },
  {
    id: 'p-02',
    albumId: 'summer',
    title: '午后街角 024',
    url: 'https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=1200&q=80',
    resolution: '4000 x 6000',
    size: '21.4 MB',
    tags: ['街景', '自然光'],
  },
  {
    id: 'p-03',
    albumId: 'summer',
    title: '黄昏草坡 057',
    url: 'https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=1200&q=80',
    resolution: '3648 x 5472',
    size: '16.9 MB',
    tags: ['黄昏', '户外'],
  },
  {
    id: 'p-04',
    albumId: 'summer',
    title: '窗边侧影 083',
    url: 'https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?auto=format&fit=crop&w=1200&q=80',
    resolution: '4016 x 6016',
    size: '22.1 MB',
    tags: ['人像', '侧光'],
  },
  {
    id: 'p-05',
    albumId: 'studio',
    title: '黑白布光 009',
    url: 'https://images.unsplash.com/photo-1509967419530-da38b4704bc6?auto=format&fit=crop&w=1200&q=80',
    resolution: '4480 x 6720',
    size: '25.2 MB',
    tags: ['棚拍', '黑白'],
  },
  {
    id: 'p-06',
    albumId: 'studio',
    title: '柔光背景 031',
    url: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=1200&q=80',
    resolution: '3712 x 5568',
    size: '19.7 MB',
    tags: ['柔光', '肖像'],
  },
  {
    id: 'p-07',
    albumId: 'film',
    title: '林间色彩 014',
    url: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=1200&q=80',
    resolution: '3000 x 4500',
    size: '13.8 MB',
    tags: ['胶片', '绿色'],
  },
  {
    id: 'p-08',
    albumId: 'film',
    title: '旧城窗口 046',
    url: 'https://images.unsplash.com/photo-1518005020951-eccb494ad742?auto=format&fit=crop&w=1200&q=80',
    resolution: '3264 x 4896',
    size: '15.3 MB',
    tags: ['建筑', '胶片'],
  },
]

const tasks = [
  {
    id: 1408,
    title: '夏日旅拍合集 Vol.12',
    site: '站点适配器 A',
    status: 'downloading',
    progress: 68,
    speed: '9.8 MB/s',
    eta: '04:12',
    images: 186,
    folder: '套图/旅拍/2026-06',
    sourceUrl: 'https://demo-a.local/albums/summer-vol-12',
    createdAt: new Date().toISOString(),
  },
  {
    id: 1409,
    title: '棚拍精选 - 黑白光影',
    site: '站点适配器 B',
    status: 'queued',
    progress: 0,
    speed: '等待中',
    eta: '队列第 2',
    images: 74,
    folder: '套图/棚拍/黑白',
    sourceUrl: 'https://demo-b.local/sets/studio-mono',
    createdAt: new Date().toISOString(),
  },
  {
    id: 1397,
    title: '复古胶片色调样张',
    site: '本地导入',
    status: 'done',
    progress: 100,
    speed: '已完成',
    eta: '12 分钟前',
    images: 132,
    folder: '套图/胶片/样张',
    createdAt: new Date().toISOString(),
  },
  {
    id: 1392,
    title: '海边长焦抓拍',
    site: '站点适配器 A',
    status: 'paused',
    progress: 41,
    speed: '已暂停',
    eta: '手动继续',
    images: 96,
    folder: '套图/旅拍/海边',
    sourceUrl: 'https://demo-a.local/albums/coast-tele',
    createdAt: new Date().toISOString(),
  },
]

if (!demoDataEnabled) {
  albums.length = 0
  photos.length = 0
  tasks.length = 0
}

let nextTaskId = 1500
let activeTaskId = tasks.find((task) => task.status === 'downloading')?.id ?? null

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Origin': 'same-origin',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(body)
}

function parseCookies(cookieHeader = '') {
  const cookies = new Map()
  for (const part of cookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=')
    if (separatorIndex === -1) {
      continue
    }

    const key = part.slice(0, separatorIndex).trim()
    const value = part.slice(separatorIndex + 1).trim()
    if (key) {
      cookies.set(key, decodeURIComponent(value))
    }
  }

  return cookies
}

function setSessionCookie(res, token) {
  const maxAgeSeconds = Math.floor(sessionMaxAgeMs / 1000)
  res.setHeader(
    'Set-Cookie',
    `${sessionCookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`,
  )
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
}

function sanitizeUsername(value) {
  return String(value ?? '').trim().slice(0, 64)
}

function isStrongEnoughPassword(value) {
  return typeof value === 'string' && value.length >= 5 && value.length <= 256
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return fallback
    }

    return fallback
  }
}

async function writePrivateJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await chmod(filePath, 0o600)
  } catch {
    // chmod is best-effort on Windows and some mounted filesystems.
  }
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const key = await scryptAsync(password, salt, 64)
  return {
    hash: Buffer.from(key).toString('hex'),
    salt,
  }
}

async function verifyPassword(password, authConfig) {
  if (!authConfig?.password?.hash || !authConfig?.password?.salt) {
    return false
  }

  const candidate = await hashPassword(password, authConfig.password.salt)
  const expected = Buffer.from(authConfig.password.hash, 'hex')
  const actual = Buffer.from(candidate.hash, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

async function loadAuthConfig() {
  const authConfig = await readJsonIfExists(authConfigFile, null)
  if (authConfig?.username && authConfig?.password?.hash) {
    return authConfig
  }

  return createDefaultAuthConfig()
}

async function saveAuthConfig(authConfig) {
  await writePrivateJson(authConfigFile, authConfig)
}

async function createDefaultAuthConfig() {
  const password = await hashPassword('admin')
  const authConfig = {
    createdAt: new Date().toISOString(),
    password,
    username: 'admin',
  }
  await saveAuthConfig(authConfig)
  return authConfig
}

async function loadSessionStore() {
  const store = await readJsonIfExists(sessionConfigFile, { sessions: [] })
  const now = Date.now()
  const sessions = Array.isArray(store.sessions)
    ? store.sessions.filter((session) => Number(session.expiresAt) > now)
    : []
  return { sessions }
}

async function saveSessionStore(store) {
  await writePrivateJson(sessionConfigFile, store)
}

async function getAuthStatus(req) {
  const authConfig = await loadAuthConfig()
  const initialized = Boolean(authConfig?.username && authConfig?.password?.hash)
  if (!initialized) {
    return { initialized, user: null }
  }

  const session = await getValidSession(req)
  return {
    initialized,
    user: session ? { username: session.username } : null,
  }
}

async function getValidSession(req) {
  const token = parseCookies(req.headers.cookie).get(sessionCookieName)
  if (!token) {
    return null
  }

  const store = await loadSessionStore()
  const session = store.sessions.find((item) => item.token === token)
  if (!session) {
    return null
  }

  return session
}

async function createSession(res, username) {
  const token = randomBytes(32).toString('hex')
  const now = Date.now()
  const store = await loadSessionStore()
  store.sessions.push({
    createdAt: now,
    expiresAt: now + sessionMaxAgeMs,
    token,
    username,
  })
  await saveSessionStore(store)
  setSessionCookie(res, token)
}

async function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie).get(sessionCookieName)
  if (token) {
    const store = await loadSessionStore()
    store.sessions = store.sessions.filter((session) => session.token !== token)
    await saveSessionStore(store)
  }
  clearSessionCookie(res)
}

async function setupAuth(payload, res) {
  const existing = await loadAuthConfig()
  if (existing?.username && existing?.password?.hash) {
    return { error: '管理员已初始化', statusCode: 409 }
  }

  const username = sanitizeUsername(payload?.username || 'admin')
  const password = String(payload?.password ?? '')
  if (!username) {
    return { error: '用户名不能为空', statusCode: 400 }
  }
  if (!isStrongEnoughPassword(password)) {
    return { error: '密码至少 5 位', statusCode: 400 }
  }

  const passwordHash = await hashPassword(password)
  const authConfig = {
    createdAt: new Date().toISOString(),
    password: passwordHash,
    username,
  }
  await saveAuthConfig(authConfig)
  await saveSessionStore({ sessions: [] })
  await createSession(res, username)
  return { statusCode: 201, user: { username } }
}

async function loginAuth(payload, res) {
  const authConfig = await loadAuthConfig()
  if (!authConfig?.username || !authConfig?.password?.hash) {
    return { error: '管理员未初始化', statusCode: 409 }
  }

  const username = sanitizeUsername(payload?.username)
  const password = String(payload?.password ?? '')
  const usernameMatches = username === authConfig.username
  const passwordMatches = await verifyPassword(password, authConfig)
  if (!usernameMatches || !passwordMatches) {
    return { error: '用户名或密码错误', statusCode: 401 }
  }

  await createSession(res, authConfig.username)
  return { statusCode: 200, user: { username: authConfig.username } }
}

async function updateAuth(payload, res) {
  const authConfig = await loadAuthConfig()
  const currentPassword = String(payload?.currentPassword ?? '')
  const nextUsername = sanitizeUsername(payload?.username || authConfig.username)
  const nextPassword = String(payload?.password ?? '')

  if (!nextUsername) {
    return { error: '用户名不能为空', statusCode: 400 }
  }
  if (nextPassword && !isStrongEnoughPassword(nextPassword)) {
    return { error: '新密码至少 5 位', statusCode: 400 }
  }
  if (!(await verifyPassword(currentPassword, authConfig))) {
    return { error: '当前密码错误', statusCode: 401 }
  }

  const nextAuthConfig = {
    ...authConfig,
    password: nextPassword ? await hashPassword(nextPassword) : authConfig.password,
    updatedAt: new Date().toISOString(),
    username: nextUsername,
  }
  await saveAuthConfig(nextAuthConfig)
  await saveSessionStore({ sessions: [] })
  await createSession(res, nextUsername)
  return { statusCode: 200, user: { username: nextUsername } }
}

async function requireAuth(req, res) {
  const status = await getAuthStatus(req)
  if (status.user) {
    return true
  }

  json(res, 401, { error: '未登录', initialized: status.initialized })
  return false
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      if (!body) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function getStats() {
  const activeTasks = tasks.filter((task) => ['downloading', 'queued', 'paused'].includes(task.status)).length

  return {
    totalImages: albums.reduce((total, album) => total + album.count, 0),
    activeTasks,
    archivedAlbums: albums.filter((album) => album.status === '已完成').length,
    integrityScore: '98.7%',
    storageUsed: '18.4 GB',
    storageTotal: '128 GB',
    storagePercent: 14,
  }
}

function findTaskById(taskId) {
  return tasks.find((task) => task.id === taskId)
}

function findJobByTaskId(taskId) {
  if (activeDownloadJob?.task?.id === taskId) {
    return activeDownloadJob
  }

  return pendingDownloadJobs.find((job) => job.task?.id === taskId) ?? pausedDownloadJobs.get(taskId)
}

function findOpenTaskBySourceUrl(sourceUrl) {
  return tasks.find((task) => task.sourceUrl === sourceUrl && !['done', 'partial', 'error'].includes(task.status))
}

function findAlbumForTask(task, job = findJobByTaskId(task.id)) {
  if (job?.album) {
    return albums.find((album) => album.id === job.remoteAlbum?.id) ?? job.album
  }

  return albums.find((album) => album.title === task.title && album.source === task.site)
}

function failedImageInfo(image) {
  return {
    error: image.error || '下载失败',
    id: image.id,
    sequence: image.sequence,
    title: image.title,
    url: image.remoteUrl ?? image.url,
  }
}

function failedImagesForTask(task, job = findJobByTaskId(task.id)) {
  if (Array.isArray(task.failedImages) && task.failedImages.length) {
    return task.failedImages
  }

  return job?.remoteAlbum?.images?.filter((image) => image.failed).map(failedImageInfo) ?? []
}

function mediaStatsForImages(images = []) {
  const videoCount = images.filter((image) => normalizeMediaType(image.mediaType ?? mediaTypeForUrl(image.remoteUrl ?? image.downloadUrl ?? image.url)) === 'video').length
  const imageCount = Math.max(0, images.length - videoCount)
  return {
    imageCount,
    mediaSummary: videoCount ? `${imageCount}P + ${videoCount}V` : `${imageCount}P`,
    videoCount,
  }
}

function applyMediaStats(target, images = []) {
  const stats = mediaStatsForImages(images)
  target.imageCount = stats.imageCount
  target.videoCount = stats.videoCount
  target.mediaSummary = stats.mediaSummary
  return target
}

function applyAlbumVideoPosters(images = []) {
  const firstImage = images.find((image) => image.mediaType !== 'video' && !image.failed)
  const posterUrl = firstImage?.thumbUrl ?? firstImage?.url
  if (!posterUrl) {
    return false
  }

  let changed = false
  for (const image of images) {
    if (image.mediaType !== 'video' || image.failed) {
      continue
    }

    if (image.posterUrl !== posterUrl || image.thumbUrl !== posterUrl) {
      image.posterUrl = posterUrl
      image.thumbUrl = posterUrl
      changed = true
    }
  }

  return changed
}

async function loadManifestForTask(task, album = findAlbumForTask(task)) {
  const candidatePaths = []
  if (album?.id) {
    candidatePaths.push(join(albumConfigRoot, sanitizePathSegment(album.id, 'album'), 'manifest.json'))
  }

  const manifestPaths = [
    ...candidatePaths,
    ...(await listManifestPaths(albumConfigRoot)),
    ...(process.env.PICHARBOR_CONFIG_ROOT ? [] : await listManifestPaths(legacyDownloadRoot)),
  ]
  const seenPaths = new Set()

  for (const manifestPath of manifestPaths) {
    if (seenPaths.has(manifestPath)) {
      continue
    }
    seenPaths.add(manifestPath)

    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const manifestTask = manifest.task ?? {}
      const remoteAlbum = manifest.remoteAlbum
      if (!remoteAlbum?.id || !Array.isArray(remoteAlbum.images)) {
        continue
      }

      const matches =
        Number(manifestTask.id) === Number(task.id) ||
        (task.sourceUrl && manifestTask.sourceUrl === task.sourceUrl) ||
        (album?.id && remoteAlbum.id === album.id) ||
        (task.folder && manifestTask.folder === task.folder)
      if (matches) {
        return manifest
      }
    } catch {
      // Missing or stale manifests are ignored; another candidate may match.
    }
  }

  return null
}

function enrichTask(task) {
  const job = findJobByTaskId(task.id)
  const album = findAlbumForTask(task, job)
  const failedImages = failedImagesForTask(task, job)
  const totalImages = Number(task.images) || job?.remoteAlbum?.images?.length || album?.count || 0
  const progressImages = Math.round((Math.max(0, Math.min(100, Number(task.progress) || 0)) / 100) * totalImages)
  const completedImages = Number.isFinite(task.completedImages)
    ? Math.max(0, Math.min(totalImages, task.completedImages))
    : ['done', 'partial'].includes(task.status)
      ? totalImages
      : progressImages
  const failedCount = Number.isFinite(task.failedCount) ? task.failedCount : failedImages.length
  const successImages = Number.isFinite(task.successImages)
    ? Math.max(0, Math.min(totalImages, task.successImages))
    : Math.max(0, completedImages - failedCount)
  const remainingImages = Number.isFinite(task.remainingImages)
    ? Math.max(0, task.remainingImages)
    : Math.max(0, totalImages - completedImages)
  const currentImage =
    task.currentImage ??
    job?.remoteAlbum?.images?.[Math.min(completedImages, Math.max(0, totalImages - 1))]?.title ??
    ''
  const hasDownloadContext = Boolean(task.folder || album?.id || job?.remoteAlbum?.id)
  const isRetryJob = Boolean(job?.downloadImages?.length)
  let stage = 'download_queued'

  if (task.status === 'done') {
    stage = 'done'
  } else if (task.status === 'partial') {
    stage = 'partial'
  } else if (task.status === 'error') {
    stage = hasDownloadContext ? 'error_download' : 'error_parse'
  } else if (task.status === 'paused') {
    if (task.pauseRequested) {
      stage = hasDownloadContext ? 'pausing_download' : 'pausing_parse'
    } else {
      stage = hasDownloadContext ? 'paused_download' : 'paused_parse'
    }
  } else if (task.status === 'queued') {
    if (!hasDownloadContext) {
      stage = 'parse_queued'
    } else {
      stage = isRetryJob ? 'retry_queued' : 'download_queued'
    }
  } else if (task.status === 'downloading') {
    if (!hasDownloadContext) {
      stage = 'parsing'
    } else {
      stage = isRetryJob ? 'retrying' : 'downloading'
    }
  }

  let stageMessage = '已完成站点识别，等待前面的任务结束后开始下载。'
  if (stage === 'parse_queued') {
    stageMessage = '任务已经入队，轮到它时会自动访问站点并建立下载上下文。'
  } else if (stage === 'parsing') {
    stageMessage = '正在访问站点、携带 Cookie 或 FlareSolverr，并解析相册元数据。'
  } else if (stage === 'pausing_parse') {
    stageMessage = '正在等待当前解析步骤结束，随后会停在站点解析阶段。'
  } else if (stage === 'paused_parse') {
    stageMessage = '任务停在站点解析阶段，继续后会从相册识别步骤接着走。'
  } else if (stage === 'error_parse') {
    stageMessage = '站点没有成功返回相册数据，补 Cookie 或网络设置后可直接重试。'
  } else if (stage === 'download_queued') {
    stageMessage = '站点解析已完成，等待前面的任务下载结束。'
  } else if (stage === 'downloading') {
    stageMessage = '媒体文件正在按页面顺序写入本地目录。'
  } else if (stage === 'pausing_download') {
    stageMessage = '正在等待当前媒体完成，随后会停在现有下载进度上。'
  } else if (stage === 'paused_download') {
    stageMessage = '任务停在下载阶段，继续后会从当前进度接着下载。'
  } else if (stage === 'error_download') {
    stageMessage = '下载过程中断，可直接重试失败项。'
  } else if (stage === 'retry_queued') {
    stageMessage = `已收集 ${failedCount} 项失败项，等待进入重试下载队列。`
  } else if (stage === 'retrying') {
    stageMessage = `正在重试失败项，当前剩余 ${remainingImages} 项。`
  } else if (stage === 'partial') {
    stageMessage = `任务已完成，但仍有 ${failedCount} 项失败，可直接重试。`
  } else if (stage === 'done') {
    stageMessage = '任务已经完成，所有媒体都已写入本地目录。'
  }

  return {
    ...task,
    albumId: album?.id ?? job?.remoteAlbum?.id ?? '',
    completedImages,
    currentImage,
    failedCount,
    failedImages,
    imageCount: task.imageCount ?? album?.imageCount,
    mediaSummary: task.mediaSummary ?? album?.mediaSummary,
    remainingImages,
    successImages,
    stage,
    stageMessage,
    videoCount: task.videoCount ?? album?.videoCount,
  }
}

function getAppData() {
  return {
    sources: listSources(),
    tasks: tasks.map(enrichTask),
    albums,
    photos,
    stats: getStats(),
  }
}

function getSources() {
  return getAppData().sources
}

function pendingTitleForUrl(inputUrl, adapter) {
  try {
    const parsedUrl = new URL(inputUrl)
    const lastPathPart = parsedUrl.pathname.split('/').filter(Boolean).at(-1)
    return `等待解析 · ${lastPathPart ?? parsedUrl.hostname}`
  } catch {
    return `等待解析 · ${adapter.name}`
  }
}

function siteCookieFileFor(siteId) {
  const safeSiteId = sanitizePathSegment(siteId, 'site').toLowerCase()
  if (safeSiteId === 'xchina') {
    return xchinaCookieFile
  }

  return join(siteCookieRoot, `${safeSiteId}.txt`)
}

async function createManifest(remoteAlbum, task) {
  const targetDir = join(albumConfigRoot, sanitizePathSegment(remoteAlbum.id, 'album'))
  await mkdir(targetDir, { recursive: true })
  await writeFile(
    join(targetDir, 'manifest.json'),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        remoteAlbum,
        task,
      },
      null,
      2,
    ),
    'utf8',
  )
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return ''
    }

    throw error
  }
}

function summarizeSecret(value) {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  const compact = trimmed.replace(/\s+/g, ' ')
  return compact.length > 24 ? `${compact.slice(0, 10)}...${compact.slice(-8)}` : compact
}

async function getSettings() {
  const proxy = await readTextIfExists(proxyConfigFile)
  const flareSolverrUrl = await readTextIfExists(flareSolverrConfigFile)
  const siteSettings = {}

  for (const source of getSources()) {
    const cookieFile = siteCookieFileFor(source.id)
    const cookie = await readTextIfExists(cookieFile)
    const trimmedCookie = cookie.trim()
    siteSettings[source.id] = {
      cookieConfigured: Boolean(trimmedCookie),
      cookieFile,
      cookiePreview: summarizeSecret(cookie),
      cookieSource: trimmedCookie.startsWith('# Netscape') ? 'netscape' : trimmedCookie ? 'header' : 'none',
      domains: source.domains,
      name: source.name,
    }
  }

  return {
    paths: {
      configRoot,
      mediaRoot,
      thumbRoot,
      siteCookieRoot,
      xchinaCookieFile,
      proxyConfigFile,
      flareSolverrConfigFile,
      xchinaUserAgentFile,
    },
    flareSolverrUrl: flareSolverrUrl.trim(),
    proxy: proxy.trim(),
    sites: siteSettings,
  }
}

async function saveSettings(payload) {
  const settings = payload && typeof payload === 'object' ? payload : {}
  const sites = settings.sites && typeof settings.sites === 'object' ? settings.sites : {}

  if ('proxy' in settings) {
    const proxy = String(settings.proxy ?? '').trim()
    await mkdir(dirname(proxyConfigFile), { recursive: true })
    await writeFile(proxyConfigFile, proxy, 'utf8')
  }

  if ('flareSolverrUrl' in settings) {
    const flareSolverrUrl = String(settings.flareSolverrUrl ?? '').trim()
    await mkdir(dirname(flareSolverrConfigFile), { recursive: true })
    await writeFile(flareSolverrConfigFile, flareSolverrUrl, 'utf8')
  }

  for (const [siteId, siteSettings] of Object.entries(sites)) {
    if (!siteSettings || typeof siteSettings !== 'object' || !('cookie' in siteSettings)) {
      continue
    }

    const cookie = String(siteSettings.cookie ?? '').trim()
    const cookieFile = siteCookieFileFor(siteId)
    await mkdir(dirname(cookieFile), { recursive: true })
    await writeFile(cookieFile, cookie ? `${cookie}\n` : '', 'utf8')
    try {
      await chmod(cookieFile, 0o600)
    } catch {
      // chmod is best-effort on Windows and some mounted filesystems.
    }
  }

  return getSettings()
}

function sanitizePathSegment(value, fallback) {
  const normalized = String(value ?? fallback)
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()

  return (normalized || fallback).slice(0, 120)
}

function isPathInside(filePath, rootPath) {
  const rootRelativePath = relative(rootPath, filePath)
  return rootRelativePath === '' || (!rootRelativePath.startsWith('..') && !isAbsolute(rootRelativePath))
}

function mediaPathFor(siteFolder, titleFolder, fileName) {
  return `${siteFolder}/${titleFolder}/${fileName}`
}

function localMediaPathFor(mediaPath) {
  return join(mediaRoot, ...mediaPath.split('/'))
}

function mediaFolderForAlbum(remoteAlbum) {
  return {
    siteFolder: sanitizePathSegment(remoteAlbum.source, 'Unknown Site'),
    titleFolder: sanitizePathSegment(remoteAlbum.title ?? remoteAlbum.id, remoteAlbum.id ?? 'Untitled'),
  }
}

function mediaUrlFor(mediaPath) {
  return `/media/${mediaPath.split('/').map(encodeURIComponent).join('/')}`
}

function mediaThumbUrl(image) {
  if (image.mediaType === 'video') {
    return image.posterUrl ?? videoThumbPlaceholder
  }

  return thumbUrlFor(image.mediaPath)
}

function thumbPathFor(mediaPath) {
  const parsed = mediaPath.split('/')
  const fileName = parsed.pop() ?? 'image'
  const thumbFileName = `${fileName.replace(/\.[^.]+$/, '')}.webp`
  return join(thumbRoot, ...parsed, thumbFileName)
}

function thumbUrlFor(mediaPath) {
  return `/thumb/${mediaPath
    .replace(/\.[^.]+$/, '.webp')
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
}

async function serveFile(res, filePath, contentType, cacheControl = 'public, max-age=3600') {
  const fileInfo = await stat(filePath)
  if (!fileInfo.isFile()) {
    json(res, 404, { error: 'Not found' })
    return
  }

  res.writeHead(200, {
    'Cache-Control': cacheControl,
    'Content-Length': fileInfo.size,
    'Content-Type': contentType,
  })
  createReadStream(filePath).pipe(res)
}

async function findThumbSource(mediaPathParts) {
  const requestedPath = mediaPathParts.join('/')
  const requestedExtension = extname(requestedPath).toLowerCase()
  const requestedBase = requestedPath.slice(0, requestedPath.length - requestedExtension.length)
  const sourceExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.avif']

  for (const extension of sourceExtensions) {
    const sourcePath = resolve(mediaRoot, ...`${requestedBase}${extension}`.split('/'))
    if (!isPathInside(sourcePath, resolve(mediaRoot))) {
      continue
    }

    try {
      const fileInfo = await stat(sourcePath)
      if (fileInfo.isFile()) {
        return sourcePath
      }
    } catch {
      // Try the next source extension.
    }
  }

  return null
}

async function listManifestPaths(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, 'manifest.json'))
  } catch {
    return []
  }
}

function normalizePersistedImage(image, remoteAlbum, index) {
  const sequence = image.sequence ?? String(index + 1).padStart(3, '0')
  const remoteUrl = image.remoteUrl ?? image.downloadUrl ?? image.url
  const mediaType = normalizeMediaType(image.mediaType ?? mediaTypeForUrl(remoteUrl))
  const fileName = image.fileName ?? `${sequence}${extensionFromUrl(remoteUrl, mediaType)}`
  const { siteFolder, titleFolder } = mediaFolderForAlbum(remoteAlbum)
  const savedLocalPath = image.localPath ? resolve(image.localPath) : null
  const savedMediaPath =
    savedLocalPath && isPathInside(savedLocalPath, mediaRoot)
      ? relative(mediaRoot, savedLocalPath).split(sep).join('/')
      : null
  const mediaPath = image.mediaPath ?? savedMediaPath ?? mediaPathFor(siteFolder, titleFolder, fileName)
  const failed = image.failed === true
  const mediaUrl = failed ? failedImagePlaceholder : mediaUrlFor(mediaPath)
  const posterUrl = image.posterUrl ?? (mediaType === 'video' ? image.previewUrl ?? image.fallbackUrl ?? null : undefined)

  return {
    ...image,
    albumId: remoteAlbum.id,
    fileName,
    localPath: localMediaPathFor(mediaPath),
    mediaPath,
    mediaType,
    posterUrl,
    remoteUrl,
    sequence,
    siteFolder,
    thumbUrl: failed ? failedImagePlaceholder : mediaThumbUrl({ mediaPath, mediaType, posterUrl, url: mediaUrl }),
    titleFolder,
    url: mediaUrl,
  }
}

async function refreshImageFileMetadata(image, fileSize = 0) {
  if (fileSize > 0) {
    image.size = formatBytes(fileSize)
  }

  if (image.mediaType === 'video') {
    if (!image.resolution || image.resolution === '下载失败' || image.resolution === '待识别') {
      image.resolution = '视频'
    }
    return false
  }

  try {
    const metadata = await sharp(image.localPath).metadata()
    if (metadata.width && metadata.height) {
      image.resolution = `${metadata.width} x ${metadata.height}`
      return true
    }
  } catch {
    // Keep the adapter-provided value if Sharp cannot read dimensions.
  }

  if (!image.resolution || image.resolution === '下载失败' || image.resolution === '待识别') {
    image.resolution = '待识别'
  }

  return false
}

async function restoreCompletedDownloads() {
  const manifestPaths = [
    ...(await listManifestPaths(albumConfigRoot)),
    ...(process.env.PICHARBOR_CONFIG_ROOT ? [] : await listManifestPaths(legacyDownloadRoot)),
  ]

  for (const manifestPath of manifestPaths) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const remoteAlbum = manifest.remoteAlbum
      const task = manifest.task
      if (!remoteAlbum?.id || !Array.isArray(remoteAlbum.images) || !['done', 'partial', 'error'].includes(task?.status)) {
        continue
      }

      if (albums.some((album) => album.id === remoteAlbum.id)) {
        continue
      }

      const restoredImages = remoteAlbum.images.map((image, index) =>
        normalizePersistedImage(image, remoteAlbum, index),
      )
      let restoredBytes = 0
      let metadataChanged = false
      if (applyAlbumVideoPosters(restoredImages)) {
        metadataChanged = true
      }
      const coverImage = restoredImages.find((image) => image.mediaType !== 'video' && !image.failed) ?? restoredImages.find((image) => !image.failed) ?? restoredImages[0]
      const cover = coverImage?.thumbUrl ?? coverImage?.url ?? remoteAlbum.cover

      for (const image of restoredImages) {
        if (image.failed) {
          continue
        }

        try {
          const fileInfo = await stat(image.localPath)
          restoredBytes += fileInfo.size
          const previousResolution = image.resolution
          const previousSize = image.size
          await refreshImageFileMetadata(image, fileInfo.size)
          if (image.resolution !== previousResolution || image.size !== previousSize) {
            metadataChanged = true
          }
        } catch {
          metadataChanged = true
          image.failed = true
          image.error = image.error || '本地文件缺失'
          image.resolution = '下载失败'
          image.size = '下载失败'
          image.thumbUrl = failedImagePlaceholder
          image.url = failedImagePlaceholder
        }
      }

      const failedImages = restoredImages.filter((image) => image.failed).map(failedImageInfo)
      const failedCount = failedImages.length
      const restoredStatus = task.status === 'error' ? 'error' : failedCount ? 'partial' : 'done'
      const mediaStats = mediaStatsForImages(restoredImages)

      albums.unshift({
        id: remoteAlbum.id,
        title: remoteAlbum.title,
        source: remoteAlbum.source,
        count: restoredImages.length,
        ...mediaStats,
        size: formatBytes(restoredBytes),
        updated: '已恢复',
        status: failedCount ? `部分完成，失败 ${failedCount} 项` : '已完成',
        cover,
        tags: remoteAlbum.tags ?? [],
      })

      photos.unshift(
        ...restoredImages.map((image) => ({
          id: image.id,
          albumId: remoteAlbum.id,
          title: image.title,
          mediaType: image.mediaType,
          posterUrl: image.posterUrl,
          thumbUrl: image.thumbUrl,
          url: image.url,
          resolution: image.resolution,
          size: image.size,
          tags: image.tags,
        })),
      )

      tasks.unshift({
        ...task,
        ...mediaStats,
        status: restoredStatus,
        progress: 100,
        speed:
          restoredStatus === 'error'
            ? '下载失败，可重试'
            : failedCount
              ? `部分完成，失败 ${failedCount} 项`
              : '已完成',
        eta: '已恢复',
        completedImages: restoredImages.length,
        failedCount,
        failedImages,
        remainingImages: 0,
        successImages: restoredImages.length - failedCount,
      })

      if (metadataChanged) {
        await createManifest({ ...remoteAlbum, images: restoredImages }, tasks[0])
      }
      nextTaskId = Math.max(nextTaskId, Number(task.id ?? 0) + 1)
    } catch (error) {
      console.warn(`Skip restore for ${manifestPath}:`, error instanceof Error ? error.message : error)
    }
  }
}

function normalizeMediaType(mediaType) {
  return mediaType === 'video' ? 'video' : 'image'
}

function mediaTypeForUrl(inputUrl) {
  const extension = extname(new URL(inputUrl, 'http://127.0.0.1').pathname).toLowerCase()
  return videoExtensions.has(extension) ? 'video' : 'image'
}

function isVideoMedia(image) {
  return normalizeMediaType(image.mediaType ?? mediaTypeForUrl(image.remoteUrl ?? image.downloadUrl ?? image.url)) === 'video'
}

function extensionFromUrl(inputUrl, mediaType = mediaTypeForUrl(inputUrl)) {
  const extension = extname(new URL(inputUrl, 'http://127.0.0.1').pathname).toLowerCase()
  if (imageExtensions.has(extension) || videoExtensions.has(extension)) {
    return extension
  }

  return normalizeMediaType(mediaType) === 'video' ? '.mp4' : '.jpg'
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '待统计'
  }

  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function mimeTypeFor(filePath) {
  const extension = extname(filePath).toLowerCase()
  return (
    {
      '.avif': 'image/avif',
      '.css': 'text/css; charset=utf-8',
      '.gif': 'image/gif',
      '.html': 'text/html; charset=utf-8',
      '.ico': 'image/x-icon',
      '.js': 'text/javascript; charset=utf-8',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.json': 'application/json; charset=utf-8',
      '.m4v': 'video/mp4',
      '.mov': 'video/quicktime',
      '.mp4': 'video/mp4',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.txt': 'text/plain; charset=utf-8',
      '.webp': 'image/webp',
      '.webm': 'video/webm',
    }[extension] ?? 'application/octet-stream'
  )
}

function domainMatches(cookieDomain, hostname) {
  const normalizedDomain = cookieDomain.replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase()
  return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)
}

function cookieHeaderFromNetscapeFile(filePath, targetUrl) {
  const hostname = new URL(targetUrl).hostname.toLowerCase()
  const nowSeconds = Math.floor(Date.now() / 1000)
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  const cookies = []

  for (const line of lines) {
    if (!line.trim() || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) {
      continue
    }

    const parts = line.split('\t')
    if (parts.length < 7) {
      continue
    }

    const [rawDomain, , , , expires, name, value] = parts
    if (!domainMatches(rawDomain, hostname)) {
      continue
    }

    const expiresAt = Number(expires)
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < nowSeconds) {
      continue
    }

    cookies.push(`${name}=${value}`)
  }

  return cookies.join('; ')
}

function cookieToNetscapeLine(cookie, targetUrl) {
  const hostname = new URL(targetUrl).hostname
  const domain = cookie.domain || hostname
  const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE'
  const path = cookie.path || '/'
  const secure = cookie.secure ? 'TRUE' : 'FALSE'
  const expires = Number(cookie.expiry ?? cookie.expires ?? 0)
  return [domain, includeSubdomains, path, secure, Number.isFinite(expires) ? expires : 0, cookie.name, cookie.value].join('\t')
}

function mergeSiteCookies(cookies, targetUrl) {
  if (!xchinaCookieFile || !Array.isArray(cookies) || !cookies.length) {
    return
  }

  const relevantCookies = cookies.filter((cookie) => cookie?.name && typeof cookie.value === 'string')
  if (!relevantCookies.length) {
    return
  }

  const existingLines = existsSync(xchinaCookieFile) ? readFileSync(xchinaCookieFile, 'utf8').split(/\r?\n/) : []
  const nextLines = existingLines.filter((line) => line.trim())
  const seen = new Map()

  for (let index = 0; index < nextLines.length; index += 1) {
    const parts = nextLines[index].split('\t')
    if (parts.length >= 7) {
      const [domain, , path, , , name] = parts
      seen.set(`${domain}\t${path}\t${name}`, index)
    }
  }

  for (const cookie of relevantCookies) {
    const line = cookieToNetscapeLine(cookie, targetUrl)
    const parts = line.split('\t')
    const key = `${parts[0]}\t${parts[2]}\t${parts[5]}`
    const existingIndex = seen.get(key)
    if (existingIndex === undefined) {
      seen.set(key, nextLines.length)
      nextLines.push(line)
    } else {
      nextLines[existingIndex] = line
    }
  }

  mkdirSync(dirname(xchinaCookieFile), { recursive: true })
  writeFileSync(xchinaCookieFile, `${['# Netscape HTTP Cookie File', ...nextLines.filter((line) => !line.startsWith('# Netscape'))].join('\n')}\n`, 'utf8')
}

function cookieHeaderForUrl(targetUrl) {
  if (xchinaCookieFile) {
    try {
      const cookie = cookieHeaderFromNetscapeFile(xchinaCookieFile, targetUrl)
      if (cookie) {
        return cookie
      }
    } catch {
      return process.env.PICHARBOR_XCHINA_COOKIE ?? ''
    }
  }

  return process.env.PICHARBOR_XCHINA_COOKIE ?? ''
}

function configuredUserAgent() {
  const userAgent = process.env.PICHARBOR_XCHINA_USER_AGENT?.trim()
  if (userAgent) {
    return userAgent
  }

  try {
    const savedUserAgent = readFileSync(xchinaUserAgentFile, 'utf8').trim()
    if (savedUserAgent) {
      return savedUserAgent
    }
  } catch {
    // Use the default browser fingerprint until FlareSolverr provides one.
  }

  return defaultUserAgent
}

function imageRequestHeaders(imageUrl, referer, mediaType = mediaTypeForUrl(imageUrl)) {
  const headers = {
    Accept: normalizeMediaType(mediaType) === 'video' ? videoAcceptHeader : imageAcceptHeader,
    'Accept-Language': acceptLanguageHeader,
    'User-Agent': configuredUserAgent(),
  }
  if (referer) {
    headers.Referer = referer
  }
  const cookie = cookieHeaderForUrl(imageUrl)
  if (cookie) {
    headers.Cookie = cookie
  }

  return headers
}

function configuredProxy() {
  const proxy = process.env.PICHARBOR_PROXY?.trim()
  if (proxy) {
    return proxy
  }

  try {
    return readFileSync(proxyConfigFile, 'utf8').trim()
  } catch {
    return ''
  }
}

function configuredFlareSolverr() {
  const flareSolverrUrl = process.env.PICHARBOR_FLARESOLVERR_URL?.trim()
  if (flareSolverrUrl) {
    return flareSolverrUrl.replace(/\/+$/, '')
  }

  try {
    const savedUrl = readFileSync(flareSolverrConfigFile, 'utf8').trim()
    if (savedUrl) {
      return savedUrl.replace(/\/+$/, '')
    }
  } catch {
    // FlareSolverr is optional.
  }

  return ''
}

async function refreshImageCloudflareSession(imageUrl) {
  const flareSolverrUrl = configuredFlareSolverr()
  if (!flareSolverrUrl) {
    return false
  }

  const response = await fetch(`${flareSolverrUrl}/v1`, {
    body: JSON.stringify({
      cmd: 'request.get',
      maxTimeout: 90000,
      url: imageUrl,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(`FlareSolverr 图片请求失败：${response.status} ${response.statusText}`)
  }

  const result = await response.json()
  if (result.status !== 'ok') {
    throw new Error(`FlareSolverr 图片解锁失败：${result.message ?? '未知错误'}`)
  }

  const solution = result.solution ?? {}
  const status = Number(solution.status ?? 0)
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new Error(`FlareSolverr 图片状态异常：${status || '未知状态'}`)
  }

  if (solution.userAgent) {
    mkdirSync(dirname(xchinaUserAgentFile), { recursive: true })
    writeFileSync(xchinaUserAgentFile, `${solution.userAgent}\n`, 'utf8')
  }

  mergeSiteCookies(solution.cookies, imageUrl)
  return Array.isArray(solution.cookies) && solution.cookies.length > 0
}

function hasImageSignature(signature) {
  const asciiHead = signature.toString('ascii', 0, Math.min(signature.length, 12))
  return (
    (signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) ||
    signature.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    asciiHead.startsWith('GIF87a') ||
    asciiHead.startsWith('GIF89a') ||
    (asciiHead.startsWith('RIFF') && signature.toString('ascii', 8, 12) === 'WEBP')
  )
}

function hasVideoSignature(signature) {
  return (
    signature.toString('ascii', 4, 8) === 'ftyp' ||
    (signature[0] === 0x1a && signature[1] === 0x45 && signature[2] === 0xdf && signature[3] === 0xa3)
  )
}

async function assertDownloadedMedia(localPath, mediaType = 'image') {
  const fileHandle = await open(localPath, 'r')
  try {
    const signature = Buffer.alloc(16)
    const { bytesRead } = await fileHandle.read(signature, 0, signature.length, 0)
    const head = signature.subarray(0, bytesRead)
    const isExpectedMedia = normalizeMediaType(mediaType) === 'video' ? hasVideoSignature(head) : hasImageSignature(head)
    if (!isExpectedMedia) {
      throw new Error(normalizeMediaType(mediaType) === 'video' ? '下载结果不是视频文件' : '下载结果不是图片文件')
    }
  } finally {
    await fileHandle.close()
  }

  const fileInfo = await stat(localPath)
  return fileInfo.size
}

async function removeFileIfExists(filePath) {
  try {
    await unlink(filePath)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error
    }
  }
}

function compactErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  const compact = message.replace(/\s+/g, ' ').trim()
  if (/ObjectBanned|sensitive information/i.test(compact)) {
    return '图床返回 403：源图片对象已被限制(ObjectBanned)'
  }
  if (/RefererWhite/i.test(compact)) {
    return '图床返回 403：Referer 不在白名单'
  }
  if (/\b403\b/.test(compact)) {
    return '图片请求返回 403'
  }
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact
}

function isPermanentImageError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /ObjectBanned|sensitive information/i.test(message)
}

async function responseErrorMessage(response) {
  let body = ''
  try {
    body = await response.text()
  } catch {
    // The status code and headers are still useful if the body cannot be read.
  }

  const errorInfo = response.headers.get('x-error-info')?.trim()
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType.includes('application/json') && body) {
    try {
      const payload = JSON.parse(body)
      const code = payload.code ? ` ${payload.code}` : ''
      const message = payload.message ? ` ${payload.message}` : ''
      return `fetch ${response.status}${code}${message}`.trim()
    } catch {
      // Fall back to the compact body text below.
    }
  }

  const bodyHint = body.trim().replace(/\s+/g, ' ')
  return [`fetch ${response.status}`, errorInfo, bodyHint].filter(Boolean).join(' ')
}

function contentTypeMatchesMedia(contentType, mediaType) {
  if (!contentType) {
    return true
  }

  if (contentType.startsWith('application/octet-stream')) {
    return true
  }

  return contentType.startsWith(normalizeMediaType(mediaType) === 'video' ? 'video/' : 'image/')
}

async function commitDownloadedFile(tempPath, localPath) {
  try {
    await rename(tempPath, localPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      await removeFileIfExists(localPath)
      await rename(tempPath, localPath)
      return
    }

    throw error
  }
}

async function existingMediaBytes(localPath, mediaType = 'image') {
  try {
    return await assertDownloadedMedia(localPath, mediaType)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 0
    }

    await removeFileIfExists(localPath)
    return 0
  }
}

function createLocalAlbum(remoteAlbum) {
  const { siteFolder, titleFolder } = mediaFolderForAlbum(remoteAlbum)
  const firstImageIndex = remoteAlbum.images.findIndex((image) => {
    const remoteUrl = image.downloadUrl ?? image.url
    return normalizeMediaType(image.mediaType ?? mediaTypeForUrl(remoteUrl)) === 'image'
  })
  const firstImagePreviewUrl = firstImageIndex >= 0 ? remoteAlbum.images[firstImageIndex].url : remoteAlbum.cover
  let firstImageLocalThumbUrl = null
  const localImages = remoteAlbum.images.map((image, index) => {
    const sequence = String(index + 1).padStart(3, '0')
    const remoteUrl = image.downloadUrl ?? image.url
    const mediaType = normalizeMediaType(image.mediaType ?? mediaTypeForUrl(remoteUrl))
    const fileName = `${sequence}${extensionFromUrl(remoteUrl, mediaType)}`
    const fallbackUrl = mediaType === 'video' ? null : image.url
    const fallbackFileName = fallbackUrl ? `${sequence}${extensionFromUrl(fallbackUrl, mediaType)}` : null
    const mediaPath = mediaPathFor(siteFolder, titleFolder, fileName)
    const mediaUrl = mediaUrlFor(mediaPath)
    if (index === firstImageIndex) {
      firstImageLocalThumbUrl = thumbUrlFor(mediaPath)
    }
    const posterUrl = image.posterUrl ?? (mediaType === 'video' ? firstImageLocalThumbUrl ?? firstImagePreviewUrl : undefined)
    return {
      ...image,
      albumId: remoteAlbum.id,
      fallbackUrl,
      fallbackFileName,
      fileName,
      localPath: localMediaPathFor(mediaPath),
      mediaPath,
      mediaType,
      posterUrl,
      previewUrl: image.url,
      remoteUrl,
      sequence,
      siteFolder,
      thumbUrl: mediaThumbUrl({ mediaPath, mediaType, posterUrl, url: mediaUrl }),
      titleFolder,
      url: mediaUrl,
    }
  })

  applyAlbumVideoPosters(localImages)

  const coverImage = localImages.find((image) => image.mediaType !== 'video') ?? localImages[0]
  return {
    ...remoteAlbum,
    cover: coverImage?.thumbUrl ?? coverImage?.url ?? remoteAlbum.cover,
    folder: `${siteFolder}/${titleFolder}`,
    images: localImages,
    ...mediaStatsForImages(localImages),
  }
}

function createAlbumRecord(localAlbum, sourceName, status = '等待下载') {
  return {
    id: localAlbum.id,
    title: localAlbum.title,
    source: sourceName,
    count: localAlbum.images.length,
    imageCount: localAlbum.imageCount,
    mediaSummary: localAlbum.mediaSummary,
    videoCount: localAlbum.videoCount,
    size: '待统计',
    updated: '刚刚创建',
    status,
    cover: localAlbum.cover,
    tags: localAlbum.tags,
  }
}

function photoRecordFromImage(image, albumId) {
  return {
    id: image.id,
    albumId,
    title: image.title,
    mediaType: image.mediaType,
    posterUrl: image.posterUrl,
    thumbUrl: image.thumbUrl,
    url: image.url,
    resolution: image.resolution,
    size: image.size,
    tags: image.tags,
  }
}

function addPhotosForLocalAlbum(localAlbum) {
  photos.unshift(...localAlbum.images.map((image) => photoRecordFromImage(image, localAlbum.id)))
}

async function downloadWithFetch(imageUrl, localPath, referer, mediaType = mediaTypeForUrl(imageUrl)) {
  const response = await fetch(imageUrl, {
    headers: imageRequestHeaders(imageUrl, referer, mediaType),
    redirect: 'follow',
  })

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response))
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentTypeMatchesMedia(contentType, mediaType)) {
    throw new Error(`fetch content-type ${contentType}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(localPath, buffer)
  return assertDownloadedMedia(localPath, mediaType)
}

async function downloadWithCurl(imageUrl, localPath, referer, mediaType = mediaTypeForUrl(imageUrl)) {
  const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const headers = imageRequestHeaders(imageUrl, referer, mediaType)
  const proxy = configuredProxy()
  const args = [
    '-L',
    '-sS',
    '--fail',
    '--compressed',
    ...Object.entries(headers).flatMap(([name, value]) => ['-H', `${name}: ${value}`]),
    '-o',
    localPath,
    imageUrl,
  ]
  if (proxy) {
    args.splice(4, 0, '-x', proxy)
  }

  await execFileAsync(curlBin, args, {
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  })
  return assertDownloadedMedia(localPath, mediaType)
}

async function downloadUrlToFile(imageUrl, localPath, referer, mediaType = mediaTypeForUrl(imageUrl)) {
  const tempPath = `${localPath}.part`
  await removeFileIfExists(tempPath)
  const proxy = configuredProxy()
  let lastError = null

  if (!proxy) {
    try {
      const bytes = await downloadWithFetch(imageUrl, tempPath, referer, mediaType)
      await commitDownloadedFile(tempPath, localPath)
      return bytes
    } catch (error) {
      lastError = error
      await removeFileIfExists(tempPath)
      if (isPermanentImageError(error)) {
        throw error
      }
    }
  }

  try {
    const bytes = await downloadWithCurl(imageUrl, tempPath, referer, mediaType)
    await commitDownloadedFile(tempPath, localPath)
    return bytes
  } catch (error) {
    lastError = error
    await removeFileIfExists(tempPath)
  }

  try {
    const refreshed = await refreshImageCloudflareSession(imageUrl)
    if (refreshed) {
      const bytes = await downloadWithCurl(imageUrl, tempPath, referer, mediaType)
      await commitDownloadedFile(tempPath, localPath)
      return bytes
    }
  } catch (error) {
    lastError = error
    await removeFileIfExists(tempPath)
  }

  throw lastError ?? new Error('媒体下载失败')
}

async function downloadImage(image, referer) {
  await mkdir(dirname(image.localPath), { recursive: true })
  const mediaType = normalizeMediaType(image.mediaType ?? mediaTypeForUrl(image.remoteUrl))
  const existingBytes = await existingMediaBytes(image.localPath, mediaType)
  if (existingBytes > 0) {
    return existingBytes
  }

  const effectiveReferer = Object.hasOwn(image, 'referer') ? image.referer : referer

  try {
    return await downloadUrlToFile(image.remoteUrl, image.localPath, effectiveReferer, mediaType)
  } catch (error) {
    if (!image.fallbackUrl || image.fallbackUrl === image.remoteUrl) {
      throw error
    }

    const fallbackFileName =
      image.fallbackFileName ?? `${image.sequence ?? image.fileName.replace(/\.[^.]+$/, '')}${extensionFromUrl(image.fallbackUrl, mediaType)}`
    const fallbackMediaPath = mediaPathFor(image.siteFolder, image.titleFolder, fallbackFileName)
    const fallbackPath = localMediaPathFor(fallbackMediaPath)
    const bytes = await downloadUrlToFile(image.fallbackUrl, fallbackPath, effectiveReferer, mediaType)
    image.fileName = fallbackFileName
    image.localPath = fallbackPath
    image.mediaPath = fallbackMediaPath
    image.remoteUrl = image.fallbackUrl
    image.thumbUrl = mediaThumbUrl({ ...image, mediaPath: fallbackMediaPath, mediaType })
    image.url = mediaUrlFor(fallbackMediaPath)
    return bytes
  }
}

function updatePhotoFromImage(image) {
  const photo = photos.find((item) => item.id === image.id)
  if (!photo) {
    return
  }

  photo.url = image.url
  photo.thumbUrl = image.thumbUrl
  photo.mediaType = image.mediaType
  photo.posterUrl = image.posterUrl
  photo.resolution = image.resolution
  photo.size = image.size
  photo.tags = image.tags
}

async function updateDownloadedImageMetadata(image) {
  image.failed = false
  image.error = ''
  image.mediaType = normalizeMediaType(image.mediaType ?? mediaTypeForUrl(image.remoteUrl))
  image.thumbUrl = mediaThumbUrl(image)
  image.url = mediaUrlFor(image.mediaPath)

  await refreshImageFileMetadata(image)
}

function updateDownloadProgress(task, remoteAlbum, failedImages, completed, currentImage = '') {
  const total = Number(task.images) || remoteAlbum.images.length
  task.completedImages = Math.max(0, Math.min(total, completed))
  task.failedImages = failedImages
  task.failedCount = failedImages.length
  task.successImages = Math.max(0, task.completedImages - failedImages.length)
  task.remainingImages = Math.max(0, total - task.completedImages)
  task.currentImage = currentImage
  task.progress = total ? Math.round((task.completedImages / total) * 100) : 100
}

async function pauseDownloadJob(job, failedImages, downloadedBytes) {
  const { album, remoteAlbum, task } = job
  const total = Number(task.images) || remoteAlbum.images.length
  const completed = Number(task.completedImages) || 0

  task.status = 'paused'
  task.pauseRequested = false
  task.speed = completed ? `已暂停在 ${completed}/${total} 项` : '已暂停'
  task.eta = '手动继续'
  task.currentImage = ''
  album.status = '已暂停'
  album.updated = '等待继续'
  if (downloadedBytes > 0) {
    album.size = formatBytes(downloadedBytes)
  }
  remoteAlbum.failedImages = failedImages
  pausedDownloadJobs.set(task.id, job)
  await createManifest(remoteAlbum, task)
}

async function processDownloadJob(job) {
  const { album, remoteAlbum, task } = job
  let downloadedBytes = 0
  const failedImages = []
  const downloadImages = job.downloadImages ?? remoteAlbum.images
  const downloadTotal = downloadImages.length
  const totalImages = Number(task.images) || remoteAlbum.images.length
  const baseCompletedImages = Math.max(0, Math.min(totalImages, Number(job.baseCompletedImages) || 0))

  pausedDownloadJobs.delete(task.id)
  job.paused = false
  task.status = 'downloading'
  task.pauseRequested = false
  task.failedImages = []
  updateDownloadProgress(task, remoteAlbum, failedImages, baseCompletedImages)
  task.speed = job.downloadImages ? `准备重试 ${downloadTotal} 项失败项` : '准备下载'
  task.eta = job.downloadImages ? `${downloadTotal} 项失败项` : `${remoteAlbum.images.length} 项`
  album.status = '下载中'

  for (let index = 0; index < downloadImages.length; index += 1) {
    if (task.pauseRequested) {
      job.paused = true
      await pauseDownloadJob(job, failedImages, downloadedBytes)
      return
    }

    const image = downloadImages[index]
    task.currentImage = image.title
    try {
      const bytes = await downloadImage(image, remoteAlbum.sourceUrl)
      downloadedBytes += bytes
      image.size = formatBytes(bytes)
      await updateDownloadedImageMetadata(image)
    } catch (error) {
      const message = compactErrorMessage(error)
      failedImages.push({ id: image.id, sequence: image.sequence, title: image.title, url: image.remoteUrl, error: message })
      image.failed = true
      image.error = message
      image.resolution = '下载失败'
      image.size = '下载失败'
      image.thumbUrl = failedImagePlaceholder
      image.url = failedImagePlaceholder
      console.warn(`Skip failed image ${image.id}: ${message}`)
    }
    updatePhotoFromImage(image)

    if (index === 0 && !image.failed) {
      album.cover = image.thumbUrl ?? image.url
    }

    const completed = baseCompletedImages + index + 1
    updateDownloadProgress(task, remoteAlbum, failedImages, completed, image.title)
    if (job.downloadImages) {
      task.speed = failedImages.length
        ? `重试 ${index + 1}/${downloadTotal} 项，仍失败 ${failedImages.length} 项`
        : `重试 ${index + 1}/${downloadTotal} 项`
      task.eta = index + 1 === downloadTotal ? '收尾中' : `剩余 ${downloadTotal - index - 1} 项失败项`
    } else {
      task.speed = failedImages.length
        ? `${completed}/${totalImages} 项，失败 ${failedImages.length} 项`
        : `${completed}/${totalImages} 项`
      task.eta = completed === totalImages ? '收尾中' : `剩余 ${totalImages - completed} 项`
    }

    if (task.pauseRequested) {
      job.paused = true
      await pauseDownloadJob(job, failedImages, downloadedBytes)
      return
    }
  }

  const allFailedImages = remoteAlbum.images.filter((image) => image.failed).map(failedImageInfo)
  const failedResultImages = job.downloadImages ? allFailedImages : failedImages

  task.status = failedResultImages.length ? 'partial' : 'done'
  task.progress = 100
  task.speed = failedResultImages.length ? `部分完成，失败 ${failedResultImages.length} 项` : '已完成'
  task.eta = failedResultImages.length ? failedResultImages.map((item) => `${item.sequence}: ${item.error}`).join('；') : '刚刚完成'
  task.failedImages = failedResultImages
  task.failedCount = failedResultImages.length
  task.completedImages = totalImages
  task.successImages = totalImages - failedResultImages.length
  task.remainingImages = 0
  task.currentImage = ''
  task.pauseRequested = false
  album.status = failedResultImages.length ? `部分完成，失败 ${failedResultImages.length} 项` : '已完成'
  album.updated = failedResultImages.length ? '刚刚完成，有失败项' : '刚刚完成'
  if (!job.downloadImages || downloadedBytes > 0) {
    album.size = formatBytes(downloadedBytes)
  }
  remoteAlbum.failedImages = failedResultImages
  pausedDownloadJobs.delete(task.id)
  await createManifest(remoteAlbum, task)
}

async function hydrateDownloadJob(job) {
  if (job.remoteAlbum && job.album) {
    return job
  }

  const { adapter, task } = job
  task.status = 'downloading'
  task.speed = '正在解析站点...'
  task.eta = '等待站点响应'
  task.currentImage = '站点解析中'
  task.progress = 1
  task.completedImages = 0
  task.successImages = 0
  task.failedImages = []
  task.failedCount = 0
  task.remainingImages = 0

  const remoteAlbum = await adapter.parse(task.sourceUrl)
  const localAlbum = createLocalAlbum(remoteAlbum)
  const existingJob = findActiveOrQueuedAlbumJob(localAlbum.id, task.sourceUrl)
  if (existingJob && existingJob.task.id !== task.id) {
    throw new Error('相同相册已经在队列中')
  }

  removeRuntimeAlbum(localAlbum.id, localAlbum.folder, task.sourceUrl)
  tasks.unshift(task)

  task.title = localAlbum.title
  task.site = adapter.name
  task.folder = localAlbum.folder
  task.images = localAlbum.images.length
  task.imageCount = localAlbum.imageCount
  task.mediaSummary = localAlbum.mediaSummary
  task.videoCount = localAlbum.videoCount
  task.speed = '等待下载'
  task.eta = `${localAlbum.images.length} 项`
  task.currentImage = '等待下载'
  task.remainingImages = localAlbum.images.length

  const album = createAlbumRecord(localAlbum, adapter.name)
  albums.unshift(album)
  addPhotosForLocalAlbum(localAlbum)
  await createManifest(localAlbum, task)

  job.remoteAlbum = localAlbum
  job.album = album
  return job
}

function runNextDownloadJob() {
  if (activeDownloadJob) {
    return
  }

  let job = pendingDownloadJobs.shift()
  while (job?.task?.status === 'paused') {
    pausedDownloadJobs.set(job.task.id, job)
    job = pendingDownloadJobs.shift()
  }
  if (!job) {
    return
  }

  activeDownloadJob = job
  Promise.resolve()
    .then(() => hydrateDownloadJob(job))
    .then((readyJob) => processDownloadJob(readyJob))
    .catch(async (error) => {
      console.error(error)
      job.task.status = 'error'
      job.task.speed = job.remoteAlbum ? '下载失败' : '解析失败'
      job.task.eta = error instanceof Error ? error.message : '下载失败'
      job.task.currentImage = job.remoteAlbum ? '' : '站点解析失败'
      if (job.album) {
        job.album.status = job.remoteAlbum ? '下载失败' : '解析失败'
        job.album.updated = '刚刚失败'
      }
      if (job.remoteAlbum) {
        try {
          await createManifest(job.remoteAlbum, job.task)
        } catch (manifestError) {
          console.warn('Failed to persist errored task:', manifestError instanceof Error ? manifestError.message : manifestError)
        }
      }
    })
    .finally(() => {
      activeDownloadJob = null
      runNextDownloadJob()
    })
}

function enqueueDownload(remoteAlbum, task, album) {
  pausedDownloadJobs.delete(task.id)
  pendingDownloadJobs.push({ album, remoteAlbum, task })
  runNextDownloadJob()
}

function jobMatchesAlbum(job, albumId, sourceUrl) {
  return job?.remoteAlbum?.id === albumId || job?.task?.sourceUrl === sourceUrl
}

function findActiveOrQueuedAlbumJob(albumId, sourceUrl) {
  if (jobMatchesAlbum(activeDownloadJob, albumId, sourceUrl)) {
    return activeDownloadJob
  }

  return (
    pendingDownloadJobs.find((job) => jobMatchesAlbum(job, albumId, sourceUrl)) ??
    [...pausedDownloadJobs.values()].find((job) => jobMatchesAlbum(job, albumId, sourceUrl))
  )
}

function removeRuntimeAlbum(albumId, folder, sourceUrl) {
  for (let index = pendingDownloadJobs.length - 1; index >= 0; index -= 1) {
    if (jobMatchesAlbum(pendingDownloadJobs[index], albumId, sourceUrl)) {
      pendingDownloadJobs.splice(index, 1)
    }
  }

  for (const [taskId, job] of pausedDownloadJobs.entries()) {
    if (jobMatchesAlbum(job, albumId, sourceUrl)) {
      pausedDownloadJobs.delete(taskId)
    }
  }

  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    if (tasks[index].sourceUrl === sourceUrl || tasks[index].folder === folder) {
      tasks.splice(index, 1)
    }
  }

  for (let index = albums.length - 1; index >= 0; index -= 1) {
    if (albums[index].id === albumId) {
      albums.splice(index, 1)
    }
  }

  for (let index = photos.length - 1; index >= 0; index -= 1) {
    if (photos[index].albumId === albumId) {
      photos.splice(index, 1)
    }
  }
}

function removePendingTaskJob(taskId) {
  const index = pendingDownloadJobs.findIndex((job) => job.task?.id === taskId)
  if (index === -1) {
    return null
  }

  const [job] = pendingDownloadJobs.splice(index, 1)
  return job
}

async function pauseTask(taskId) {
  const task = findTaskById(taskId)
  if (!task) {
    return { error: '任务不存在', statusCode: 404 }
  }

  if (['done', 'partial', 'error'].includes(task.status)) {
    return { error: '任务已结束，不能暂停', statusCode: 409 }
  }

  if (task.status === 'paused') {
    return { task: enrichTask(task), statusCode: 200 }
  }

  const queuedJob = removePendingTaskJob(taskId)
  if (queuedJob) {
    task.status = 'paused'
    task.pauseRequested = false
    task.speed = '已暂停'
    task.eta = '手动继续'
    if (queuedJob.album) {
      queuedJob.album.status = '已暂停'
      queuedJob.album.updated = '等待继续'
    }
    pausedDownloadJobs.set(task.id, queuedJob)
    if (queuedJob.remoteAlbum) {
      await createManifest(queuedJob.remoteAlbum, task)
    }
    return { task: enrichTask(task), statusCode: 200 }
  }

  if (activeDownloadJob?.task?.id === taskId) {
    task.pauseRequested = true
    task.status = 'paused'
    task.speed = activeDownloadJob.remoteAlbum ? '暂停中，当前媒体完成后停止' : '暂停中，等待当前解析结束'
    task.eta = '手动继续'
    if (activeDownloadJob.album) {
      activeDownloadJob.album.status = '暂停中'
    }
    return { task: enrichTask(task), statusCode: 202 }
  }

  task.status = 'paused'
  task.speed = '已暂停'
  task.eta = '手动继续'
  return { task: enrichTask(task), statusCode: 200 }
}

async function resumeTask(taskId) {
  const task = findTaskById(taskId)
  if (!task) {
    return { error: '任务不存在', statusCode: 404 }
  }

  if (task.status !== 'paused') {
    return { error: '只有已暂停的任务可以继续', statusCode: 409 }
  }

  if (activeDownloadJob?.task?.id === taskId) {
    task.status = 'downloading'
    task.pauseRequested = false
    task.speed = '继续下载'
    task.eta = task.remainingImages ? `剩余 ${task.remainingImages} 张` : '计算中'
    activeDownloadJob.album.status = '下载中'
    return { task: enrichTask(task), statusCode: 200 }
  }

  let job = pausedDownloadJobs.get(taskId)
  if (!job) {
    job = findJobByTaskId(taskId)
  }

  if (!job) {
    return { error: '任务运行上下文不存在，请重新创建任务', statusCode: 409 }
  }

  pausedDownloadJobs.delete(taskId)
  task.status = 'queued'
  task.pauseRequested = false
  task.speed = job.remoteAlbum ? '等待继续' : '等待开始'
  task.eta = job.remoteAlbum ? `${task.completedImages || 0}/${task.images} 项` : '准备解析'
  if (job.album) {
    job.album.status = '等待继续'
  }
  pendingDownloadJobs.push(job)
  runNextDownloadJob()

  return { task: enrichTask(task), statusCode: 200 }
}

async function imageNeedsRetry(image) {
  if (image.failed) {
    return true
  }

  return (await existingMediaBytes(image.localPath, normalizeMediaType(image.mediaType ?? mediaTypeForUrl(image.remoteUrl)))) === 0
}

function upsertPhotosForRemoteAlbum(remoteAlbum) {
  for (const image of remoteAlbum.images) {
    const existingPhoto = photos.find((photo) => photo.id === image.id)
    if (existingPhoto) {
      updatePhotoFromImage(image)
      continue
    }

    photos.push({
      id: image.id,
      albumId: remoteAlbum.id,
      title: image.title,
      mediaType: image.mediaType,
      posterUrl: image.posterUrl,
      thumbUrl: image.thumbUrl,
      url: image.url,
      resolution: image.resolution,
      size: image.size,
      tags: image.tags,
    })
  }
}

async function retryTask(taskId) {
  const task = findTaskById(taskId)
  if (!task) {
    return { error: '任务不存在', statusCode: 404 }
  }

  if (activeDownloadJob?.task?.id === taskId || task.status === 'downloading') {
    return { error: '任务正在下载中', statusCode: 409 }
  }

  const pendingJob = pendingDownloadJobs.find((job) => job.task?.id === taskId)
  if (pendingJob || task.status === 'queued') {
    return { task: enrichTask(task), statusCode: 200 }
  }

  if (!task.folder && task.sourceUrl) {
    const adapter = resolveAdapter(task.sourceUrl)
    if (!adapter) {
      return { error: '没有匹配的站点适配器', statusCode: 422 }
    }

    task.status = 'queued'
    task.progress = 0
    task.pauseRequested = false
    task.currentImage = '等待站点解析'
    task.completedImages = 0
    task.successImages = 0
    task.failedImages = []
    task.failedCount = 0
    task.remainingImages = 0
    task.speed = '等待开始'
    task.eta = '准备解析'
    task.title = pendingTitleForUrl(task.sourceUrl, adapter)
    pendingDownloadJobs.push({ adapter, task })
    runNextDownloadJob()
    return { task: enrichTask(task), statusCode: 202 }
  }

  let job = pausedDownloadJobs.get(taskId)
  let album = job?.album ?? findAlbumForTask(task)
  let remoteAlbum = job?.remoteAlbum

  if (!remoteAlbum) {
    const manifest = await loadManifestForTask(task, album)
    if (manifest?.remoteAlbum?.images) {
      remoteAlbum = {
        ...manifest.remoteAlbum,
        images: manifest.remoteAlbum.images.map((image, index) => normalizePersistedImage(image, manifest.remoteAlbum, index)),
      }
      applyAlbumVideoPosters(remoteAlbum.images)
    }
  }

  if (!remoteAlbum?.images?.length) {
    return { error: '任务运行上下文不存在，无法重试', statusCode: 409 }
  }

  const retryImages = []
  for (const image of remoteAlbum.images) {
    if (await imageNeedsRetry(image)) {
      retryImages.push(image)
    }
  }

  if (!retryImages.length) {
    task.status = 'done'
    task.progress = 100
    task.speed = '已完成'
    task.eta = '没有失败项'
    task.failedImages = []
    task.failedCount = 0
    task.completedImages = remoteAlbum.images.length
    task.successImages = remoteAlbum.images.length
    task.remainingImages = 0
    await createManifest(remoteAlbum, task)
    return { task: enrichTask(task), statusCode: 200 }
  }

  if (!album) {
    const coverImage = remoteAlbum.images.find((image) => !image.failed) ?? remoteAlbum.images[0]
    album = {
      id: remoteAlbum.id,
      title: remoteAlbum.title,
      source: remoteAlbum.source,
      count: remoteAlbum.images.length,
      ...mediaStatsForImages(remoteAlbum.images),
      size: '待统计',
      updated: '等待重试',
      status: '等待重试',
      cover: coverImage?.thumbUrl ?? coverImage?.url ?? remoteAlbum.cover,
      tags: remoteAlbum.tags ?? [],
    }
    albums.unshift(album)
  }

  upsertPhotosForRemoteAlbum(remoteAlbum)
  pausedDownloadJobs.delete(taskId)
  removePendingTaskJob(taskId)

  const existingFailedCount = retryImages.length
  const baseCompletedImages = Math.max(0, remoteAlbum.images.length - existingFailedCount)

  task.status = 'queued'
  task.progress = remoteAlbum.images.length ? Math.round((baseCompletedImages / remoteAlbum.images.length) * 100) : 100
  task.pauseRequested = false
  task.currentImage = ''
  task.completedImages = baseCompletedImages
  task.failedImages = retryImages.map(failedImageInfo)
  task.failedCount = existingFailedCount
  task.remainingImages = existingFailedCount
  task.successImages = baseCompletedImages
  task.speed = `等待重试 ${retryImages.length} 项失败项`
  task.eta = `${retryImages.length} 项失败项`
  album.status = '等待重试'
  album.updated = '刚刚加入重试'

  job = { album, baseCompletedImages, downloadImages: retryImages, remoteAlbum, task }
  pendingDownloadJobs.push(job)
  await createManifest(remoteAlbum, task)
  runNextDownloadJob()

  return { task: enrichTask(task), statusCode: 202 }
}

async function serveMedia(req, res, requestUrl) {
  const mediaPathParts = requestUrl.pathname
    .replace(/^\/media\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
  const rootPath = resolve(mediaRoot)
  const filePath = resolve(mediaRoot, ...mediaPathParts)

  if (!isPathInside(filePath, rootPath)) {
    json(res, 403, { error: 'Forbidden' })
    return
  }

  try {
    const fileInfo = await stat(filePath)
    if (!fileInfo.isFile()) {
      json(res, 404, { error: 'Not found' })
      return
    }

    const contentType = mimeTypeFor(filePath)
    const rangeHeader = req.headers.range
    if (rangeHeader) {
      const rangeMatch = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/)
      if (!rangeMatch) {
        res.writeHead(416, {
          'Content-Range': `bytes */${fileInfo.size}`,
        })
        res.end()
        return
      }

      const requestedStart = rangeMatch[1] ? Number(rangeMatch[1]) : 0
      const requestedEnd = rangeMatch[2] ? Number(rangeMatch[2]) : fileInfo.size - 1
      const start = Math.max(0, Math.min(fileInfo.size - 1, requestedStart))
      const end = Math.max(start, Math.min(fileInfo.size - 1, requestedEnd))

      res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${fileInfo.size}`,
        'Content-Type': contentType,
      })
      createReadStream(filePath, { end, start }).pipe(res)
      return
    }

    res.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
      'Content-Length': fileInfo.size,
      'Content-Type': contentType,
    })
    createReadStream(filePath).pipe(res)
  } catch {
    json(res, 404, { error: 'Not found' })
  }
}

async function serveThumb(req, res, requestUrl) {
  const mediaPathParts = requestUrl.pathname
    .replace(/^\/thumb\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
  const mediaPath = mediaPathParts.join('/')
  const rootPath = resolve(thumbRoot)
  const thumbPath = resolve(thumbPathFor(mediaPath))

  if (!isPathInside(thumbPath, rootPath)) {
    json(res, 403, { error: 'Forbidden' })
    return
  }

  try {
    await serveFile(res, thumbPath, 'image/webp', 'public, max-age=31536000, immutable')
    return
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      json(res, 404, { error: 'Not found' })
      return
    }
  }

  const sourcePath = await findThumbSource(mediaPathParts)
  if (!sourcePath) {
    json(res, 404, { error: 'Not found' })
    return
  }

  try {
    await mkdir(dirname(thumbPath), { recursive: true })
    await sharp(sourcePath)
      .rotate()
      .resize({ width: 320, height: 240, fit: 'inside', withoutEnlargement: true })
      .webp({ effort: 4, quality: 72 })
      .toFile(thumbPath)
    await serveFile(res, thumbPath, 'image/webp', 'public, max-age=31536000, immutable')
  } catch (error) {
    console.warn('Thumbnail generation failed:', error instanceof Error ? error.message : error)
    json(res, 404, { error: 'Thumbnail generation failed' })
  }
}

async function serveStatic(req, res, requestUrl) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { error: 'Method not allowed' })
    return
  }

  const pathname = decodeURIComponent(requestUrl.pathname)
  const requestedPath = pathname === '/' ? '/index.html' : pathname
  const rootPath = resolve(staticRoot)
  const filePath = resolve(staticRoot, `.${requestedPath}`)

  if (!isPathInside(filePath, rootPath)) {
    json(res, 403, { error: 'Forbidden' })
    return
  }

  try {
    const fileInfo = await stat(filePath)
    if (fileInfo.isFile()) {
      res.writeHead(200, {
        'Cache-Control': requestedPath === '/index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
        'Content-Length': fileInfo.size,
        'Content-Type': mimeTypeFor(filePath),
      })
      if (req.method === 'HEAD') {
        res.end()
      } else {
        createReadStream(filePath).pipe(res)
      }
      return
    }
  } catch {
    // Fall through to the SPA entry below.
  }

  const indexPath = join(staticRoot, 'index.html')
  try {
    const indexInfo = await stat(indexPath)
    res.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Length': indexInfo.size,
      'Content-Type': mimeTypeFor(indexPath),
    })
    if (req.method === 'HEAD') {
      res.end()
    } else {
      createReadStream(indexPath).pipe(res)
    }
  } catch {
    json(res, 404, { error: 'Not found' })
  }
}

function ensureQueueRunning() {
  if (activeTaskId && tasks.some((task) => task.id === activeTaskId && task.status === 'downloading')) {
    return
  }

  const nextTask = tasks.find((task) => task.status === 'queued')
  if (!nextTask) {
    activeTaskId = null
    return
  }

  nextTask.status = 'downloading'
  nextTask.speed = '2.4 MB/s'
  nextTask.eta = '计算中'
  activeTaskId = nextTask.id
}

function tickQueue() {
  const activeTask = tasks.find((task) => task.id === activeTaskId)
  if (!activeTask || activeTask.status !== 'downloading') {
    ensureQueueRunning()
    return
  }

  activeTask.progress = Math.min(100, activeTask.progress + 6)
  activeTask.speed = activeTask.progress >= 100 ? '已完成' : `${(2.2 + activeTask.progress / 25).toFixed(1)} MB/s`
  activeTask.eta = activeTask.progress >= 100 ? '刚刚完成' : `${Math.max(1, Math.ceil((100 - activeTask.progress) / 12))} 分钟`

  if (activeTask.progress >= 100) {
    activeTask.status = 'done'
    activeTask.progress = 100
    activeTask.speed = '已完成'
    activeTask.eta = '刚刚完成'
    activeTaskId = null
    ensureQueueRunning()
  }
}

if (demoDataEnabled) {
  setInterval(tickQueue, 1200)
}

async function createTask(payload) {
  const inputUrl = String(payload.url ?? '').trim()
  if (!inputUrl) {
    return { error: '请输入套图地址', statusCode: 400 }
  }

  try {
    new URL(inputUrl)
  } catch {
    return { error: 'URL 格式不正确', statusCode: 400 }
  }

  const adapter = resolveAdapter(inputUrl, payload.adapterId)
  if (!adapter) {
    return { error: '没有匹配的站点适配器', statusCode: 422 }
  }

  const existingTask = findOpenTaskBySourceUrl(inputUrl)
  if (existingTask) {
    return { task: enrichTask(existingTask), statusCode: 200 }
  }

  const task = {
    id: nextTaskId++,
    title: pendingTitleForUrl(inputUrl, adapter),
    site: adapter.name,
    status: 'queued',
    progress: 0,
    speed: '等待开始',
    eta: '准备解析',
    images: 0,
    imageCount: 0,
    mediaSummary: '待解析',
    videoCount: 0,
    folder: '',
    sourceUrl: inputUrl,
    createdAt: new Date().toISOString(),
    completedImages: 0,
    currentImage: '等待站点解析',
    successImages: 0,
    failedImages: [],
    failedCount: 0,
    remainingImages: 0,
  }

  tasks.unshift(task)
  pendingDownloadJobs.push({ adapter, task })
  runNextDownloadJob()

  return { task: enrichTask(task), statusCode: 201 }
}

async function createTaskBatch(payload) {
  const inputUrls = Array.isArray(payload?.urls) ? payload.urls : payload?.url ? [payload.url] : []
  const urls = []
  const seen = new Set()

  for (const value of inputUrls) {
    const trimmed = String(value ?? '').trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    urls.push(trimmed)
  }

  if (!urls.length) {
    return { failures: [{ error: '请输入至少一个套图地址', url: '' }], items: [], statusCode: 200 }
  }

  const items = []
  const failures = []

  for (const url of urls) {
    const result = await createTask({ ...payload, url })
    if (result.error) {
      failures.push({ error: result.error, url })
      continue
    }
    items.push(enrichTask(result.task))
  }

  return { failures, items, statusCode: 200 }
}

async function inspectTaskUrls(payload) {
  const inputUrls = Array.isArray(payload?.urls) ? payload.urls : payload?.url ? [payload.url] : []
  const urls = inputUrls
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .slice(0, 12)

  if (!urls.length) {
    return { items: [] }
  }

  const settings = await getSettings()
  const flareSolverrConfigured = Boolean(settings.flareSolverrUrl?.trim())
  const items = urls.map((value) => {
    let parsedUrl

    try {
      parsedUrl = new URL(value)
    } catch {
      return {
        matched: false,
        message: 'URL 格式不正确',
        url: value,
        valid: false,
      }
    }

    const normalizedUrl = parsedUrl.toString()
    const adapter = resolveAdapter(normalizedUrl)
    if (!adapter) {
      return {
        hostname: parsedUrl.hostname,
        matched: false,
        message: '没有匹配的站点适配器',
        normalizedUrl,
        url: value,
        valid: true,
      }
    }

    const siteSettings = settings.sites?.[adapter.id]

    return {
      adapterId: adapter.id,
      adapterName: adapter.name,
      adapterVersion: adapter.version,
      capabilities: adapter.capabilities,
      cookieConfigured: Boolean(siteSettings?.cookieConfigured),
      cookieSource: siteSettings?.cookieSource ?? 'none',
      domains: adapter.domains,
      flareSolverrConfigured,
      hostname: parsedUrl.hostname,
      matched: true,
      message: siteSettings?.cookieConfigured
        ? `${adapter.name} 已识别，可先入队后后台解析`
        : `${adapter.name} 已识别，建议检查 Cookie；可先入队后后台解析`,
      normalizedUrl,
      url: value,
      valid: true,
    }
  })

  return { items }
}

async function route(req, res) {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

  if (req.method === 'OPTIONS') {
    json(res, 204, {})
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/health') {
    json(res, 200, { ok: true })
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/auth/status') {
    json(res, 200, await getAuthStatus(req))
    return
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/auth/setup') {
    const payload = await readBody(req)
    const result = await setupAuth(payload, res)
    if (result.error) {
      json(res, result.statusCode, { error: result.error })
      return
    }

    json(res, result.statusCode, { user: result.user })
    return
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/auth/login') {
    const payload = await readBody(req)
    const result = await loginAuth(payload, res)
    if (result.error) {
      json(res, result.statusCode, { error: result.error })
      return
    }

    json(res, result.statusCode, { user: result.user })
    return
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/auth/logout') {
    await destroySession(req, res)
    json(res, 200, { ok: true })
    return
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/auth/update') {
    if (!(await requireAuth(req, res))) {
      return
    }

    const payload = await readBody(req)
    const result = await updateAuth(payload, res)
    if (result.error) {
      json(res, result.statusCode, { error: result.error })
      return
    }

    json(res, result.statusCode, { user: result.user })
    return
  }

  if ((requestUrl.pathname.startsWith('/api/') || requestUrl.pathname.startsWith('/media/') || requestUrl.pathname.startsWith('/thumb/'))
    && !(await requireAuth(req, res))) {
    return
  }

  if (req.method === 'GET' && requestUrl.pathname.startsWith('/media/')) {
    await serveMedia(req, res, requestUrl)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname.startsWith('/thumb/')) {
    await serveThumb(req, res, requestUrl)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/app-data') {
    json(res, 200, getAppData())
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/sources') {
    json(res, 200, getAppData().sources)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/settings') {
    json(res, 200, await getSettings())
    return
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/settings') {
    const payload = await readBody(req)
    json(res, 200, await saveSettings(payload))
    return
  }

  const taskRouteMatch = requestUrl.pathname.match(/^\/api\/tasks\/(\d+)(?:\/(pause|resume|retry))?$/)
  if (taskRouteMatch) {
    const taskId = Number(taskRouteMatch[1])
    const action = taskRouteMatch[2]

    if (req.method === 'GET' && !action) {
      const task = findTaskById(taskId)
      if (!task) {
        json(res, 404, { error: '任务不存在' })
        return
      }

      json(res, 200, enrichTask(task))
      return
    }

    if (req.method === 'POST' && action === 'pause') {
      const result = await pauseTask(taskId)
      if (result.error) {
        json(res, result.statusCode, { error: result.error })
        return
      }

      json(res, result.statusCode, result.task)
      return
    }

    if (req.method === 'POST' && action === 'resume') {
      const result = await resumeTask(taskId)
      if (result.error) {
        json(res, result.statusCode, { error: result.error })
        return
      }

      json(res, result.statusCode, result.task)
      return
    }

    if (req.method === 'POST' && action === 'retry') {
      const result = await retryTask(taskId)
      if (result.error) {
        json(res, result.statusCode, { error: result.error })
        return
      }

      json(res, result.statusCode, result.task)
      return
    }

    json(res, 405, { error: 'Method not allowed' })
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/tasks') {
    json(res, 200, tasks.map(enrichTask))
    return
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/tasks/inspect') {
    const payload = await readBody(req)
    json(res, 200, await inspectTaskUrls(payload))
    return
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/tasks/batch') {
    const payload = await readBody(req)
    const result = await createTaskBatch(payload)
    json(res, result.statusCode, { failures: result.failures, items: result.items })
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/albums') {
    json(res, 200, albums)
    return
  }

  if (req.method === 'GET' && requestUrl.pathname === '/api/photos') {
    json(res, 200, photos)
    return
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/tasks') {
    const payload = await readBody(req)
    const result = await createTask(payload)
    if (result.error) {
      json(res, result.statusCode, { error: result.error })
      return
    }

    json(res, result.statusCode, enrichTask(result.task))
    return
  }

  await serveStatic(req, res, requestUrl)
}

await mkdir(mediaRoot, { recursive: true })
await mkdir(albumConfigRoot, { recursive: true })
await mkdir(thumbRoot, { recursive: true })
await mkdir(siteCookieRoot, { recursive: true })
await restoreCompletedDownloads()

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error(error)
    json(res, 500, { error: 'Internal server error' })
  })
})

server.listen(port, host, () => {
  console.log(`PicHarbor listening on http://${host}:${port}`)
  console.log(`PicHarbor media root: ${mediaRoot}`)
  console.log(`PicHarbor config root: ${configRoot}`)
})
