import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react'
import {
  Archive,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CirclePause,
  Clock3,
  Cookie,
  Database,
  Download,
  Eye,
  Film,
  FolderOpen,
  Globe2,
  HardDrive,
  Image,
  Images,
  LayoutDashboard,
  ListFilter,
  LockKeyhole,
  Maximize2,
  Moon,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
  Tags,
  Trash2,
  Volume2,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react'
import { mockAppData } from './data/mockData'
import {
  createTask,
  inspectTaskUrls,
  loadAppData,
  loadAuthStatus,
  loadSettings,
  loginAuth,
  logoutAuth,
  pauseTask,
  resumeTask,
  retryTask,
  saveSettings,
  setupAuth,
  updateAuth,
} from './lib/api'
import type { AppData, AppSettings, AuthStatus, DownloadTask, Photo, Source, TaskStatus, TaskUrlInspection } from './types'
import './App.css'

type ViewId = 'overview' | 'tasks' | 'library' | 'tags' | 'sources' | 'settings'

const navItems: Array<{ id: ViewId; label: string; icon: LucideIcon }> = [
  { id: 'overview', label: '总览', icon: LayoutDashboard },
  { id: 'tasks', label: '下载任务', icon: Download },
  { id: 'library', label: '图片库', icon: Images },
  { id: 'tags', label: '标签管理', icon: Tags },
  { id: 'sources', label: '站点适配器', icon: Globe2 },
  { id: 'settings', label: '设置', icon: Settings },
]

const viewTitles: Record<ViewId, { eyebrow: string; title: string }> = {
  overview: { eyebrow: '任务工作台', title: '下载、整理、查看套图' },
  tasks: { eyebrow: '下载队列', title: '下载任务管理' },
  library: { eyebrow: '图片管理器', title: '套图与图片库' },
  tags: { eyebrow: '标签索引', title: '标签管理' },
  sources: { eyebrow: '规则中心', title: '站点适配器' },
  settings: { eyebrow: '系统配置', title: '设置' },
}

const statusMeta: Record<TaskStatus, { label: string; icon: LucideIcon; className: string }> = {
  downloading: { label: '下载中', icon: Download, className: 'running' },
  queued: { label: '排队中', icon: Clock3, className: 'queued' },
  paused: { label: '已暂停', icon: CirclePause, className: 'paused' },
  done: { label: '已完成', icon: CheckCircle2, className: 'done' },
  partial: { label: '部分完成', icon: CirclePause, className: 'partial' },
  error: { label: '出错', icon: CirclePause, className: 'error' },
}

function taskIsPendingMetadata(task?: Pick<DownloadTask, 'folder' | 'images'> | null) {
  return Boolean(task && task.images === 0 && !task.folder)
}

function taskPhaseMeta(task?: DownloadTask | null) {
  if (!task) {
    return null
  }

  const pendingMetadata = taskIsPendingMetadata(task)
  if (pendingMetadata) {
    if (task.status === 'queued') {
      return {
        busy: false,
        detail: '任务已经入队，轮到它时会自动访问站点并开始建立下载上下文。',
        isParsing: true,
        label: '等待解析',
        tone: 'queued',
      }
    }

    if (task.status === 'downloading') {
      return {
        busy: true,
        detail: '正在访问站点、携带 Cookie / FlareSolverr 建立下载上下文。',
        isParsing: true,
        label: '站点解析中',
        tone: 'running',
      }
    }

    if (task.status === 'paused') {
      return {
        busy: false,
        detail: '当前任务停在解析阶段，继续后会从站点识别步骤接着走。',
        isParsing: true,
        label: '解析已暂停',
        tone: 'paused',
      }
    }

    if (task.status === 'error') {
      return {
        busy: false,
        detail: '站点没有成功返回相册数据，补 Cookie 或网络设置后可直接重试。',
        isParsing: true,
        label: '解析失败',
        tone: 'error',
      }
    }
  }

  if (task.status === 'queued') {
    return {
      busy: false,
      detail: '已完成站点识别，等待前面的任务下载结束。',
      isParsing: false,
      label: '等待下载',
      tone: 'queued',
    }
  }

  if (task.status === 'downloading') {
    return {
      busy: true,
      detail: '媒体文件正在顺序写入本地目录。',
      isParsing: false,
      label: '下载进行中',
      tone: 'running',
    }
  }

  return null
}

function sourceSettingsId(source: Source) {
  return source.id
}

function formatDateTime(value?: string) {
  if (!value) {
    return '未记录'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString('zh-CN', { hour12: false })
}

const photoBatchSize = 36
const taskPageSize = 7
const overviewAlbumPageSize = 24
const overviewTaskLimit = 6
const minViewerZoom = 0.05
const maxViewerZoom = 5

type Point = {
  x: number
  y: number
}

type Size = {
  height: number
  width: number
}

function extractTaskUrls(input: string) {
  const tokens = input
    .split(/[\s,，;；]+/)
    .map((token) => token.trim().replace(/^[<"'“”‘’]+|[>"'“”‘’]+$/g, ''))
    .filter(Boolean)
  const urls: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()

  for (const token of tokens) {
    try {
      const url = new URL(token)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        invalid.push(token)
        continue
      }

      const normalized = url.toString()
      if (!seen.has(normalized)) {
        seen.add(normalized)
        urls.push(normalized)
      }
    } catch {
      invalid.push(token)
    }
  }

  return { invalid, urls }
}

function paginateItems<T>(items: T[], page: number, pageSize: number) {
  const safePage = Math.max(1, page)
  return items.slice((safePage - 1) * pageSize, safePage * pageSize)
}

function clampViewerZoom(value: number, minimum = minViewerZoom) {
  return Math.min(maxViewerZoom, Math.max(minimum, Number(value.toFixed(2))))
}

function parseResolutionSize(resolution?: string): Size {
  const match = resolution?.match(/(\d+)\s*x\s*(\d+)/i)
  if (!match) {
    return { height: 0, width: 0 }
  }

  return { height: Number(match[2]), width: Number(match[1]) }
}

function isVideoPhoto(photo?: Photo | null) {
  return photo?.mediaType === 'video'
}

function photoThumbSource(photo: Photo) {
  if (isVideoPhoto(photo)) {
    return photo.posterUrl ?? photo.thumbUrl ?? photo.url
  }

  return photo.thumbUrl ?? photo.posterUrl ?? photo.url
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '00:00'
  }

  const wholeSeconds = Math.floor(seconds)
  const minutes = Math.floor(wholeSeconds / 60)
  const remainingSeconds = wholeSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
}

function mediaSummaryForItem(item?: { count: number; imageCount?: number; mediaSummary?: string; videoCount?: number }) {
  if (!item) {
    return '0P'
  }

  if (item.mediaSummary) {
    return item.mediaSummary
  }

  const imageCount = item.imageCount ?? Math.max(0, item.count - (item.videoCount ?? 0))
  const videoCount = item.videoCount ?? 0
  return videoCount ? `${imageCount}P + ${videoCount}V` : `${imageCount}P`
}

function albumMatchesStatusFilter(album: { status: string }, filter: string) {
  if (filter === 'all') {
    return true
  }

  if (filter === 'done') {
    return album.status.includes('完成')
  }

  if (filter === 'active') {
    return /下载|等待|队列|暂停|重试/.test(album.status)
  }

  if (filter === 'issue') {
    return /失败|出错|部分/.test(album.status)
  }

  return true
}

function sourceStatusTone(status: string) {
  if (/可用|在线|正常|ready/i.test(status)) {
    return 'ready'
  }

  if (/等待|规划|开发|规则/i.test(status)) {
    return 'queued'
  }

  return 'issue'
}

function inspectionTone(item: TaskUrlInspection) {
  if (!item.valid || !item.matched) {
    return 'issue'
  }

  if (item.cookieConfigured) {
    return 'ready'
  }

  return 'queued'
}

const searchPlaceholderByView: Record<ViewId, string> = {
  overview: '搜索当前相册的文件名或标签',
  tasks: '搜索已载入图片或标签',
  library: '搜索当前相册的文件名或标签',
  tags: '搜索标签关联的文件名或标签',
  sources: '搜索已载入图片或标签',
  settings: '搜索已载入图片或标签',
}

function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  const [authUsername, setAuthUsername] = useState('admin')
  const [authPassword, setAuthPassword] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [isAuthBusy, setIsAuthBusy] = useState(false)
  const [accountUsernameInput, setAccountUsernameInput] = useState('admin')
  const [accountCurrentPassword, setAccountCurrentPassword] = useState('')
  const [accountNewPassword, setAccountNewPassword] = useState('')
  const [accountConfirmPassword, setAccountConfirmPassword] = useState('')
  const [isAccountSaving, setIsAccountSaving] = useState(false)
  const [activeView, setActiveView] = useState<ViewId>('overview')
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>(() => {
    if (typeof window === 'undefined') {
      return 'light'
    }

    return window.localStorage.getItem('picharbor-theme') === 'dark' ? 'dark' : 'light'
  })
  const [appData, setAppData] = useState<AppData>(mockAppData)
  const [settingsData, setSettingsData] = useState<AppSettings | null>(null)
  const [dataMode, setDataMode] = useState<'api' | 'mock'>('mock')
  const [selectedAlbumId, setSelectedAlbumId] = useState(mockAppData.albums[0]?.id ?? '')
  const [selectedPhotoId, setSelectedPhotoId] = useState(mockAppData.photos[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [albumQuery, setAlbumQuery] = useState('')
  const [albumSourceFilter, setAlbumSourceFilter] = useState('all')
  const [albumStatusFilter, setAlbumStatusFilter] = useState('all')
  const [taskUrl, setTaskUrl] = useState('')
  const [taskMessage, setTaskMessage] = useState('')
  const [isCreatingTask, setIsCreatingTask] = useState(false)
  const [taskUrlInspections, setTaskUrlInspections] = useState<TaskUrlInspection[]>([])
  const [isInspectingTaskUrls, setIsInspectingTaskUrls] = useState(false)
  const [proxyInput, setProxyInput] = useState('')
  const [flareSolverrInput, setFlareSolverrInput] = useState('')
  const [cookieInputs, setCookieInputs] = useState<Record<string, string>>({})
  const [activeCookieSiteId, setActiveCookieSiteId] = useState('xchina')
  const [sourceDiagnosticUrl, setSourceDiagnosticUrl] = useState('')
  const [sourceDiagnosticResult, setSourceDiagnosticResult] = useState<TaskUrlInspection | null>(null)
  const [isInspectingSourceDiagnostic, setIsInspectingSourceDiagnostic] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState('')
  const [isSavingSettings, setIsSavingSettings] = useState(false)
  const [isSlideshowOpen, setIsSlideshowOpen] = useState(false)
  const [isViewerOpen, setIsViewerOpen] = useState(false)
  const [isPlaying, setIsPlaying] = useState(true)
  const [slideSeconds, setSlideSeconds] = useState(4)
  const [photoLimit, setPhotoLimit] = useState(photoBatchSize)
  const [selectedTaskId, setSelectedTaskId] = useState(mockAppData.tasks[0]?.id ?? 0)
  const [isTaskDetailOpen, setIsTaskDetailOpen] = useState(false)
  const [taskActionMessage, setTaskActionMessage] = useState('')
  const [isTaskActionBusy, setIsTaskActionBusy] = useState(false)
  const [taskPage, setTaskPage] = useState(1)
  const [overviewAlbumPage, setOverviewAlbumPage] = useState(1)
  const [viewerZoom, setViewerZoom] = useState(1)
  const [isViewerFitMode, setIsViewerFitMode] = useState(true)
  const [viewerImageSize, setViewerImageSize] = useState<Size>({ height: 0, width: 0 })
  const [viewerStageSize, setViewerStageSize] = useState<Size>({ height: 0, width: 0 })
  const [viewerPan, setViewerPan] = useState<Point>({ x: 0, y: 0 })
  const [viewerDragStart, setViewerDragStart] = useState<Point | null>(null)
  const [isViewerDragging, setIsViewerDragging] = useState(false)
  const [videoCurrentTime, setVideoCurrentTime] = useState(0)
  const [videoDuration, setVideoDuration] = useState(0)
  const [videoVolume, setVideoVolume] = useState(0.8)
  const [isVideoPlaying, setIsVideoPlaying] = useState(false)
  const [isVideoFullscreen, setIsVideoFullscreen] = useState(false)
  const didSelectInitialApiAlbum = useRef(false)
  const selectedAlbumIdRef = useRef(selectedAlbumId)
  const selectedPhotoIdRef = useRef(selectedPhotoId)
  const selectedTaskIdRef = useRef(selectedTaskId)
  const lastWheelNavAtRef = useRef(0)
  const viewerPointerStartRef = useRef<Point | null>(null)
  const viewerPointerMovedRef = useRef(false)
  const viewerStageRef = useRef<HTMLDivElement | null>(null)
  const viewerVideoRef = useRef<HTMLVideoElement | null>(null)
  const slideshowVideoRef = useRef<HTMLVideoElement | null>(null)

  const { albums, photos, sources, stats, tasks } = appData
  const normalizedQuery = query.trim().toLowerCase()

  const updateSelectedAlbumId = (albumId: string) => {
    selectedAlbumIdRef.current = albumId
    setSelectedAlbumId(albumId)
  }

  const updateSelectedPhotoId = (photoId: string) => {
    selectedPhotoIdRef.current = photoId
    setSelectedPhotoId(photoId)
  }

  const updateSelectedTaskId = (taskId: number) => {
    selectedTaskIdRef.current = taskId
    setSelectedTaskId(taskId)
  }

  const refreshSettings = async () => {
    try {
      const nextSettings = await loadSettings()
      setSettingsData(nextSettings)
      setProxyInput(nextSettings.proxy)
      setFlareSolverrInput(nextSettings.flareSolverrUrl)
    } catch (error) {
      console.warn('Settings API is unavailable.', error)
    }
  }

  const refreshData = async () => {
    const result = await loadAppData()
    setAppData(result.data)
    setDataMode(result.mode)

    if (result.mode === 'api' && !didSelectInitialApiAlbum.current) {
      didSelectInitialApiAlbum.current = true
      const firstAlbumId = result.data.albums[0]?.id ?? ''
      const firstPhoto = result.data.photos.find((photo) => photo.albumId === firstAlbumId)
      updateSelectedAlbumId(firstAlbumId)
      updateSelectedPhotoId(firstPhoto?.id ?? result.data.photos[0]?.id ?? '')
      updateSelectedTaskId(result.data.tasks[0]?.id ?? 0)
      return
    }

    const currentAlbumId = selectedAlbumIdRef.current
    const nextAlbumId = result.data.albums.some((album) => album.id === currentAlbumId)
      ? currentAlbumId
      : result.data.albums[0]?.id ?? ''

    if (nextAlbumId !== currentAlbumId) {
      updateSelectedAlbumId(nextAlbumId)
    }

    const currentPhotoId = selectedPhotoIdRef.current
    const currentPhotoStillVisible = result.data.photos.some(
      (photo) => photo.id === currentPhotoId && photo.albumId === nextAlbumId,
    )
    if (!currentPhotoStillVisible) {
      updateSelectedPhotoId(
        result.data.photos.find((photo) => photo.albumId === nextAlbumId)?.id ?? result.data.photos[0]?.id ?? '',
      )
    }

    const currentTaskId = selectedTaskIdRef.current
    const nextTaskId = result.data.tasks.some((task) => task.id === currentTaskId)
      ? currentTaskId
      : result.data.tasks[0]?.id ?? 0
    if (nextTaskId !== currentTaskId) {
      updateSelectedTaskId(nextTaskId)
    }
  }

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsAuthBusy(true)
    setAuthMessage('')

    try {
      const action = authStatus?.initialized ? loginAuth : setupAuth
      const status = await action({ password: authPassword, username: authUsername })
      setAuthStatus(status)
      setAccountUsernameInput(status.user?.username ?? authUsername)
      setAuthPassword('')
      setAuthMessage(authStatus?.initialized ? '登录成功' : '管理员已创建')
      void refreshData()
      void refreshSettings()
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : '认证失败')
    } finally {
      setIsAuthBusy(false)
    }
  }

  const handleLogout = async () => {
    try {
      await logoutAuth()
    } finally {
      setAuthStatus((current) => ({ initialized: current?.initialized ?? true, user: null }))
      setAppData(mockAppData)
      setDataMode('mock')
      setAuthPassword('')
    }
  }

  useEffect(() => {
    const refreshAuth = async () => {
      try {
        const status = await loadAuthStatus()
        setAuthStatus(status)
        if (status.user?.username) {
          setAuthUsername(status.user.username)
          setAccountUsernameInput(status.user.username)
        }
      } catch (error) {
        console.warn('Auth API is unavailable.', error)
        setAuthStatus({ initialized: false, user: null })
      }
    }

    void refreshAuth()
  }, [])

  useEffect(() => {
    if (!authStatus?.user) {
      return undefined
    }

    const firstRefresh = window.setTimeout(() => {
      void refreshData()
      void refreshSettings()
    }, 0)
    const timer = window.setInterval(() => {
      void refreshData()
    }, 3000)

    return () => {
      window.clearTimeout(firstRefresh)
      window.clearInterval(timer)
    }
    // The polling callback intentionally reads the latest server snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus?.user?.username])

  useEffect(() => {
    window.localStorage.setItem('picharbor-theme', themeMode)
  }, [themeMode])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(async () => {
      const trimmed = taskUrl.trim()
      if (!trimmed) {
        if (!cancelled) {
          setTaskUrlInspections([])
          setIsInspectingTaskUrls(false)
        }
        return
      }

      const parsed = extractTaskUrls(taskUrl)
      const invalidItems: TaskUrlInspection[] = parsed.invalid.slice(0, 4).map((url) => ({
        matched: false,
        message: 'URL 格式不正确',
        url,
        valid: false,
      }))

      if (!parsed.urls.length) {
        if (!cancelled) {
          setTaskUrlInspections(invalidItems)
          setIsInspectingTaskUrls(false)
        }
        return
      }

      setIsInspectingTaskUrls(true)

      try {
        const items = await inspectTaskUrls(parsed.urls.slice(0, 6))
        if (!cancelled) {
          setTaskUrlInspections([...invalidItems, ...items])
        }
      } catch {
        if (!cancelled) {
          setTaskUrlInspections(invalidItems)
        }
      } finally {
        if (!cancelled) {
          setIsInspectingTaskUrls(false)
        }
      }
    }, taskUrl.trim() ? 360 : 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [taskUrl])

  const selectedAlbum = albums.find((album) => album.id === selectedAlbumId) ?? albums[0]

  const visiblePhotos = useMemo(
    () =>
      photos
        .map((photo, index) => ({ index, photo }))
        .filter(({ photo }) => {
          if (photo.albumId !== selectedAlbum?.id) {
            return false
          }
          if (!normalizedQuery) {
            return true
          }
          const haystack = `${photo.title} ${photo.tags.join(' ')}`.toLowerCase()
          return haystack.includes(normalizedQuery)
        })
        .sort((a, b) => Number(isVideoPhoto(b.photo)) - Number(isVideoPhoto(a.photo)) || a.index - b.index)
        .map(({ photo }) => photo),
    [normalizedQuery, photos, selectedAlbum?.id],
  )
  const renderedPhotos = activeView === 'library' ? visiblePhotos.slice(0, photoLimit) : []
  const hasMorePhotos = renderedPhotos.length < visiblePhotos.length

  const selectedPhoto =
    photos.find((photo) => photo.id === selectedPhotoId && photo.albumId === selectedAlbum?.id) ??
    visiblePhotos[0] ??
    photos[0]

  const selectedIndex = Math.max(
    visiblePhotos.findIndex((photo) => photo.id === selectedPhoto?.id),
    0,
  )
  const selectedPhotoIsVideo = isVideoPhoto(selectedPhoto)

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0]
  const taskPageCount = Math.max(1, Math.ceil(tasks.length / taskPageSize))
  const overviewAlbumPageCount = Math.max(1, Math.ceil(albums.length / overviewAlbumPageSize))
  const safeTaskPage = Math.min(Math.max(1, taskPage), taskPageCount)
  const safeOverviewAlbumPage = Math.min(Math.max(1, overviewAlbumPage), overviewAlbumPageCount)
  const pagedTasks = paginateItems(tasks, safeTaskPage, taskPageSize)
  const overviewAlbums = paginateItems(albums, safeOverviewAlbumPage, overviewAlbumPageSize)
  const taskQueueSummary = useMemo(() => {
    const byStatus: Record<TaskStatus, number> = {
      done: 0,
      downloading: 0,
      error: 0,
      partial: 0,
      paused: 0,
      queued: 0,
    }

    for (const task of tasks) {
      byStatus[task.status] += 1
    }

    const issueTasks = byStatus.error + byStatus.partial
    const failedItems = tasks.reduce((total, task) => total + (task.failedCount ?? task.failedImages?.length ?? 0), 0)

    return {
      activeTasks: byStatus.downloading + byStatus.queued + byStatus.paused,
      byStatus,
      failedItems,
      issueTasks,
      nextWaitingTask: tasks.find((task) => task.status === 'queued'),
      runningTask: tasks.find((task) => task.status === 'downloading'),
      total: tasks.length,
    }
  }, [tasks])
  const taskUrlInspectionSummary = useMemo(() => {
    const matchedCount = taskUrlInspections.filter((item) => item.valid && item.matched).length
    const issueCount = taskUrlInspections.filter((item) => !item.valid || !item.matched).length
    const cookieReadyCount = taskUrlInspections.filter((item) => item.matched && item.cookieConfigured).length

    return {
      cookieReadyCount,
      issueCount,
      matchedCount,
      total: taskUrlInspections.length,
    }
  }, [taskUrlInspections])
  const configuredCookieCount = useMemo(
    () => Object.values(settingsData?.sites ?? {}).filter((site) => site.cookieConfigured).length,
    [settingsData],
  )
  const readySourceCount = useMemo(() => sources.filter((source) => sourceStatusTone(source.status) === 'ready').length, [sources])
  const queuedSourceCount = useMemo(() => sources.filter((source) => sourceStatusTone(source.status) === 'queued').length, [sources])
  const issueSourceCount = Math.max(0, sources.length - readySourceCount - queuedSourceCount)
  const activeAlbumCount = useMemo(() => albums.filter((album) => albumMatchesStatusFilter(album, 'active')).length, [albums])
  const issueAlbumCount = useMemo(() => albums.filter((album) => albumMatchesStatusFilter(album, 'issue')).length, [albums])
  const doneAlbumCount = useMemo(() => albums.filter((album) => albumMatchesStatusFilter(album, 'done')).length, [albums])
  const taggedPhotoCount = useMemo(() => photos.filter((photo) => photo.tags.length).length, [photos])
  const albumSourceOptions = useMemo(
    () => Array.from(new Set(albums.map((album) => album.source))).filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [albums],
  )
  const filteredLibraryAlbums = useMemo(() => {
    const normalizedAlbumQuery = albumQuery.trim().toLowerCase()

    return albums.filter((album) => {
      if (albumSourceFilter !== 'all' && album.source !== albumSourceFilter) {
        return false
      }

      if (!albumMatchesStatusFilter(album, albumStatusFilter)) {
        return false
      }

      if (!normalizedAlbumQuery) {
        return true
      }

      const haystack = `${album.title} ${album.source} ${album.status} ${album.tags.join(' ')}`.toLowerCase()
      return haystack.includes(normalizedAlbumQuery)
    })
  }, [albumQuery, albumSourceFilter, albumStatusFilter, albums])
  const selectedAlbumTask = selectedAlbum
    ? tasks.find((task) => task.albumId === selectedAlbum.id) ??
      tasks.find((task) => task.title === selectedAlbum.title && task.site === selectedAlbum.source)
    : undefined
  const visibleVideoCount = useMemo(() => visiblePhotos.filter((photo) => isVideoPhoto(photo)).length, [visiblePhotos])
  const visibleImageCount = Math.max(0, visiblePhotos.length - visibleVideoCount)
  const selectedAlbumTagCount = selectedAlbum?.tags.length ?? 0
  const selectedPhotoResolutionSize = useMemo(() => parseResolutionSize(selectedPhoto?.resolution), [selectedPhoto?.resolution])
  const activeVideoRef = isSlideshowOpen ? slideshowVideoRef : viewerVideoRef
  const fallbackViewerStageSize =
    typeof window === 'undefined'
      ? { height: 0, width: 0 }
      : {
          height: Math.max(240, window.innerHeight - 150),
          width: Math.max(320, window.innerWidth - 240),
        }
  const effectiveViewerImageSize =
    viewerImageSize.width && viewerImageSize.height ? viewerImageSize : selectedPhotoResolutionSize
  const effectiveViewerStageSize =
    viewerStageSize.width && viewerStageSize.height ? viewerStageSize : fallbackViewerStageSize
  const fitViewerZoom =
    effectiveViewerImageSize.width &&
    effectiveViewerImageSize.height &&
    effectiveViewerStageSize.width &&
    effectiveViewerStageSize.height
      ? Math.min(
          1,
          effectiveViewerStageSize.width / effectiveViewerImageSize.width,
          effectiveViewerStageSize.height / effectiveViewerImageSize.height,
        )
      : 1
  const isViewerZoomed = viewerZoom > fitViewerZoom + 0.01
  const viewerDisplaySize = {
    height: effectiveViewerImageSize.height ? effectiveViewerImageSize.height * viewerZoom : 0,
    width: effectiveViewerImageSize.width ? effectiveViewerImageSize.width * viewerZoom : 0,
  }

  const resetViewerTransform = () => {
    setViewerZoom(fitViewerZoom)
    setIsViewerFitMode(true)
    setViewerPan({ x: 0, y: 0 })
    setViewerDragStart(null)
    setIsViewerDragging(false)
  }

  const syncVideoState = useCallback((video?: HTMLVideoElement | null) => {
    if (!video) {
      return
    }

    setVideoCurrentTime(video.currentTime || 0)
    setVideoDuration(video.duration || 0)
    setVideoVolume(video.volume)
    setIsVideoPlaying(!video.paused)
  }, [])

  const seekVideo = useCallback(
    (seconds: number) => {
      const video = activeVideoRef.current
      if (!video) {
        return
      }

      const duration = Number.isFinite(video.duration) ? video.duration : 0
      const nextTime = duration ? Math.min(duration, Math.max(0, video.currentTime + seconds)) : Math.max(0, video.currentTime + seconds)
      video.currentTime = nextTime
      setVideoCurrentTime(nextTime)
    },
    [activeVideoRef],
  )

  const toggleVideoPlayback = useCallback(() => {
    const video = activeVideoRef.current
    if (!video) {
      return
    }

    if (video.paused) {
      void video.play()
    } else {
      video.pause()
    }
    syncVideoState(video)
  }, [activeVideoRef, syncVideoState])

  const setActiveVideoVolume = useCallback(
    (volume: number) => {
      const nextVolume = Math.min(1, Math.max(0, volume))
      setVideoVolume(nextVolume)
      for (const video of [viewerVideoRef.current, slideshowVideoRef.current]) {
        if (video) {
          video.volume = nextVolume
        }
      }
    },
    [],
  )

  const toggleVideoFullscreen = useCallback(() => {
    const video = activeVideoRef.current
    const container = video?.closest('.video-player-shell') as HTMLElement | null
    if (!container) {
      return
    }

    if (document.fullscreenElement) {
      void document.exitFullscreen()
      return
    }

    void container.requestFullscreen()
  }, [activeVideoRef])

  const handleVideoKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      seekVideo(-5)
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      seekVideo(5)
    }
    if (event.key === ' ') {
      event.preventDefault()
      toggleVideoPlayback()
    }
    if (event.key.toLowerCase() === 'f') {
      event.preventDefault()
      toggleVideoFullscreen()
    }
  }

  const renderVideoPlayer = (photo: Photo) => (
    <div className="video-player-shell" tabIndex={0} onKeyDown={handleVideoKeyDown}>
      <video
        ref={activeVideoRef}
        autoPlay
        playsInline
        poster={photo.posterUrl ?? photo.thumbUrl}
        src={photo.url}
        onLoadedMetadata={(event) => {
          event.currentTarget.volume = videoVolume
          syncVideoState(event.currentTarget)
        }}
        onPlay={(event) => syncVideoState(event.currentTarget)}
        onPause={(event) => syncVideoState(event.currentTarget)}
        onTimeUpdate={(event) => syncVideoState(event.currentTarget)}
        onVolumeChange={(event) => syncVideoState(event.currentTarget)}
      />
      <div className="video-control-bar">
        <button type="button" onClick={toggleVideoPlayback} aria-label={isVideoPlaying ? '暂停视频' : '播放视频'}>
          {isVideoPlaying ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
        </button>
        <button type="button" onClick={() => seekVideo(-5)} aria-label="快退 5 秒">
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <input
          aria-label="视频进度"
          className="video-progress"
          min="0"
          max={videoDuration || 0}
          onChange={(event) => {
            const nextTime = Number(event.target.value)
            const video = activeVideoRef.current
            if (video) {
              video.currentTime = nextTime
            }
            setVideoCurrentTime(nextTime)
          }}
          step="0.1"
          type="range"
          value={Math.min(videoCurrentTime, videoDuration || videoCurrentTime)}
        />
        <button type="button" onClick={() => seekVideo(5)} aria-label="快进 5 秒">
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        <span className="video-time">
          {formatDuration(videoCurrentTime)} / {formatDuration(videoDuration)}
        </span>
        <Volume2 size={17} aria-hidden="true" />
        <input
          aria-label="视频音量"
          className="video-volume"
          min="0"
          max="1"
          onChange={(event) => setActiveVideoVolume(Number(event.target.value))}
          step="0.05"
          type="range"
          value={videoVolume}
        />
        <button type="button" onClick={toggleVideoFullscreen} aria-label={isVideoFullscreen ? '退出全屏' : '全屏播放'}>
          <Maximize2 size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  )

  const openPhotoViewer = (photoId: string) => {
    updateSelectedPhotoId(photoId)
    setViewerImageSize({ height: 0, width: 0 })
    resetViewerTransform()
    setIsViewerOpen(true)
  }

  const openSlideshow = () => {
    resetViewerTransform()
    setIsViewerOpen(false)
    setIsPlaying(true)
    setIsSlideshowOpen(true)
  }

  const changeViewerZoom = (delta: number) => {
    const minimum = fitViewerZoom || minViewerZoom
    setViewerZoom((current) => {
      const next = clampViewerZoom(current + delta, minimum)
      if (next <= minimum) {
        setViewerPan({ x: 0, y: 0 })
      }
      setIsViewerFitMode(next <= minimum)
      return next
    })
  }

  const toggleViewerZoom = () => {
    setViewerZoom((current) => {
      const next = current >= 1 || !isViewerFitMode ? fitViewerZoom : 1
      setIsViewerFitMode(next === fitViewerZoom)
      setViewerPan({ x: 0, y: 0 })
      return next
    })
  }

  const tagStats = useMemo(() => {
    const counts = new Map<string, { count: number; photos: Photo[] }>()
    for (const photo of photos) {
      for (const tag of photo.tags) {
        const entry = counts.get(tag) ?? { count: 0, photos: [] }
        entry.count += 1
        entry.photos.push(photo)
        counts.set(tag, entry)
      }
    }

    return [...counts.entries()]
      .map(([tag, value]) => ({ tag, ...value }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }, [photos])

  const movePhoto = (direction: -1 | 1) => {
    if (!visiblePhotos.length) {
      return
    }

    const nextIndex = (selectedIndex + direction + visiblePhotos.length) % visiblePhotos.length
    updateSelectedPhotoId(visiblePhotos[nextIndex].id)
    setViewerImageSize({ height: 0, width: 0 })
    resetViewerTransform()
  }

  const handleViewerWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey) {
      return
    }

    event.preventDefault()

    if (event.shiftKey || event.altKey) {
      changeViewerZoom(event.deltaY > 0 ? -0.2 : 0.2)
      return
    }

    const now = Date.now()
    if (now - lastWheelNavAtRef.current < 260) {
      return
    }
    lastWheelNavAtRef.current = now
    movePhoto(event.deltaY > 0 ? 1 : -1)
  }

  const handleViewerPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (selectedPhotoIsVideo) {
      return
    }

    if (event.button !== 0) {
      return
    }

    viewerPointerStartRef.current = { x: event.clientX, y: event.clientY }
    viewerPointerMovedRef.current = false

    if (!isViewerZoomed) {
      return
    }

    event.currentTarget.setPointerCapture(event.pointerId)
    setIsViewerDragging(true)
    setViewerDragStart({
      x: event.clientX - viewerPan.x,
      y: event.clientY - viewerPan.y,
    })
  }

  const handleViewerPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const pointerStart = viewerPointerStartRef.current
    if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 6) {
      viewerPointerMovedRef.current = true
    }

    if (!isViewerDragging || !viewerDragStart) {
      return
    }

    setViewerPan({
      x: event.clientX - viewerDragStart.x,
      y: event.clientY - viewerDragStart.y,
    })
  }

  const stopViewerDrag = (event: ReactPointerEvent<HTMLElement>, shouldToggle = true) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (!selectedPhotoIsVideo && shouldToggle && viewerPointerStartRef.current && !viewerPointerMovedRef.current) {
      toggleViewerZoom()
    }

    setIsViewerDragging(false)
    setViewerDragStart(null)
    viewerPointerStartRef.current = null
    viewerPointerMovedRef.current = false
  }

  useEffect(() => {
    if (!isSlideshowOpen || !isPlaying || visiblePhotos.length < 2 || selectedPhotoIsVideo) {
      return undefined
    }

    const timer = window.setInterval(() => {
      movePhoto(1)
    }, Math.max(1, slideSeconds) * 1000)

    return () => window.clearInterval(timer)
    // movePhoto intentionally reads the current selected index from render state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, isSlideshowOpen, selectedPhotoId, selectedPhotoIsVideo, slideSeconds, visiblePhotos.length])

  useEffect(() => {
    if (!isSlideshowOpen && !isViewerOpen) {
      return undefined
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.video-player-shell')) {
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        movePhoto(-1)
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        movePhoto(1)
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setIsSlideshowOpen(false)
        setIsViewerOpen(false)
      }
      if (event.key === ' ' && isSlideshowOpen) {
        event.preventDefault()
        setIsPlaying((current) => !current)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // movePhoto intentionally reads the current selected index from render state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSlideshowOpen, isViewerOpen, selectedPhotoId, visiblePhotos.length])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsVideoFullscreen(Boolean(document.fullscreenElement))
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  useEffect(() => {
    if (!selectedPhotoIsVideo) {
      const timer = window.setTimeout(() => {
        setIsVideoPlaying(false)
        setVideoCurrentTime(0)
        setVideoDuration(0)
      }, 0)
      return () => window.clearTimeout(timer)
    }

    return undefined
  }, [selectedPhoto?.id, selectedPhotoIsVideo])

  useEffect(() => {
    if (!isViewerOpen) {
      return undefined
    }

    const stage = viewerStageRef.current
    if (!stage) {
      return undefined
    }

    const syncStageSize = () => {
      const rect = stage.getBoundingClientRect()
      setViewerStageSize({ height: rect.height, width: rect.width })
    }

    syncStageSize()
    const resizeObserver = new ResizeObserver(syncStageSize)
    resizeObserver.observe(stage)
    window.addEventListener('resize', syncStageSize)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', syncStageSize)
    }
  }, [isViewerOpen])

  useEffect(() => {
    if (!isViewerOpen || !isViewerFitMode) {
      return undefined
    }

    const frameId = window.requestAnimationFrame(() => {
      setViewerZoom(fitViewerZoom)
      setViewerPan({ x: 0, y: 0 })
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [fitViewerZoom, isViewerFitMode, isViewerOpen, selectedPhoto?.id])

  const selectAlbum = (albumId: string) => {
    const firstPhoto = photos.find((photo) => photo.albumId === albumId)
    updateSelectedAlbumId(albumId)
    setPhotoLimit(photoBatchSize)
    if (firstPhoto) {
      updateSelectedPhotoId(firstPhoto.id)
    }
  }

  const handleCreateTask = async () => {
    const parsedTasks = extractTaskUrls(taskUrl)

    if (!taskUrl.trim() || (!parsedTasks.urls.length && !parsedTasks.invalid.length)) {
      setTaskMessage('请输入套图地址')
      return
    }

    if (parsedTasks.invalid.length) {
      setTaskMessage(`有 ${parsedTasks.invalid.length} 个地址格式不对：${parsedTasks.invalid[0]}`)
      return
    }

    setIsCreatingTask(true)
    setTaskMessage('')

    try {
      const createdTasks: DownloadTask[] = []
      const failures: string[] = []

      for (const url of parsedTasks.urls) {
        try {
          const task = await createTask({ url })
          createdTasks.push(task)
        } catch (error) {
          failures.push(error instanceof Error ? error.message : `${url} 创建失败`)
        }
      }

      if (!createdTasks.length) {
        setTaskMessage(failures[0] ?? '创建任务失败')
        return
      }

      updateSelectedTaskId(createdTasks[0].id)
      setIsTaskDetailOpen(createdTasks.length === 1)
      setTaskUrl('')
      setTaskPage(1)
      setTaskMessage(
        failures.length
          ? `已加入 ${createdTasks.length} 个任务，后台会依次解析下载；${failures.length} 个失败：${failures[0]}`
          : createdTasks.length === 1
            ? '任务已加入队列，后台正在解析站点'
            : `已按顺序加入 ${createdTasks.length} 个任务，后台会依次解析下载`,
      )
      setAppData((current) => {
        const currentTasks = current.tasks.filter((task) => !createdTasks.some((created) => created.id === task.id))
        const nextTasks = [...createdTasks, ...currentTasks]
        return {
          ...current,
          stats: {
            ...current.stats,
            activeTasks: nextTasks.filter((task) => ['downloading', 'queued', 'paused'].includes(task.status)).length,
          },
          tasks: nextTasks,
        }
      })
      setActiveView('tasks')
      void refreshData()
    } catch (error) {
      const message = error instanceof Error ? error.message : '创建任务失败'
      setTaskMessage(message)
    } finally {
      setIsCreatingTask(false)
    }
  }

  const handleTaskAction = async (task: DownloadTask, action: 'pause' | 'resume' | 'retry') => {
    setIsTaskActionBusy(true)
    setTaskActionMessage('')

    try {
      const nextTask =
        action === 'pause' ? await pauseTask(task.id) : action === 'resume' ? await resumeTask(task.id) : await retryTask(task.id)
      updateSelectedTaskId(nextTask.id)
      setTaskActionMessage(action === 'pause' ? '已发送暂停请求' : action === 'resume' ? '任务已继续' : '已加入重试队列')
      await refreshData()
    } catch (error) {
      const fallback = action === 'pause' ? '暂停失败' : action === 'resume' ? '继续失败' : '重试失败'
      setTaskActionMessage(error instanceof Error ? error.message : fallback)
    } finally {
      setIsTaskActionBusy(false)
    }
  }

  const handleInspectSourceUrl = async () => {
    const input = sourceDiagnosticUrl.trim()
    if (!input) {
      setSourceDiagnosticResult(null)
      return
    }

    setIsInspectingSourceDiagnostic(true)

    try {
      const [result] = await inspectTaskUrls([input])
      setSourceDiagnosticResult(
        result ?? {
          matched: false,
          message: '没有返回诊断结果',
          url: input,
          valid: false,
        },
      )
    } catch (error) {
      setSourceDiagnosticResult({
        matched: false,
        message: error instanceof Error ? error.message : '诊断失败',
        url: input,
        valid: false,
      })
    } finally {
      setIsInspectingSourceDiagnostic(false)
    }
  }

  const updateCookieInput = (siteId: string, value: string) => {
    setCookieInputs((current) => ({ ...current, [siteId]: value }))
  }

  const handleSaveSettings = async () => {
    setIsSavingSettings(true)
    setSettingsMessage('')

    try {
      const nextSettings = await saveSettings({
        flareSolverrUrl: flareSolverrInput.trim(),
        proxy: proxyInput.trim(),
      })
      setSettingsData(nextSettings)
      setFlareSolverrInput(nextSettings.flareSolverrUrl)
      setProxyInput(nextSettings.proxy)
      setSettingsMessage('设置已保存')
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : '保存设置失败')
    } finally {
      setIsSavingSettings(false)
    }
  }

  const handleSaveAccount = async () => {
    setIsAccountSaving(true)
    setSettingsMessage('')

    try {
      if (accountNewPassword && accountNewPassword !== accountConfirmPassword) {
        throw new Error('两次输入的新密码不一致')
      }

      const status = await updateAuth({
        currentPassword: accountCurrentPassword,
        password: accountNewPassword || undefined,
        username: accountUsernameInput.trim(),
      })
      setAuthStatus(status)
      setAuthUsername(status.user?.username ?? accountUsernameInput.trim())
      setAccountUsernameInput(status.user?.username ?? accountUsernameInput.trim())
      setAccountCurrentPassword('')
      setAccountNewPassword('')
      setAccountConfirmPassword('')
      setSettingsMessage('登录账号已更新')
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : '更新登录账号失败')
    } finally {
      setIsAccountSaving(false)
    }
  }

  const handleSaveSiteCookie = async (siteId: string) => {
    setIsSavingSettings(true)
    setSettingsMessage('')

    try {
      const cookie = cookieInputs[siteId]?.trim() ?? ''
      const nextSettings = await saveSettings({ sites: { [siteId]: { cookie } } })
      setSettingsData(nextSettings)
      setCookieInputs((current) => ({ ...current, [siteId]: '' }))
      setSettingsMessage(`${nextSettings.sites[siteId]?.name ?? siteId} Cookie 已保存`)
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : '保存 Cookie 失败')
    } finally {
      setIsSavingSettings(false)
    }
  }

  const handleClearCookie = async (siteId: string) => {
    setIsSavingSettings(true)
    setSettingsMessage('')

    try {
      const nextSettings = await saveSettings({ sites: { [siteId]: { cookie: '' } } })
      setSettingsData(nextSettings)
      setCookieInputs((current) => ({ ...current, [siteId]: '' }))
      setSettingsMessage(`${nextSettings.sites[siteId]?.name ?? siteId} Cookie 已清空`)
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : '清空 Cookie 失败')
    } finally {
      setIsSavingSettings(false)
    }
  }

  const renderTaskForm = () => (
    <section className="task-create" aria-label="新建下载任务">
      <Globe2 size={18} aria-hidden="true" />
      <textarea
        aria-label="套图地址"
        onChange={(event) => setTaskUrl(event.target.value)}
        placeholder="输入一个或多个套图 URL，换行、空格或逗号分隔，按顺序排队下载"
        rows={1}
        value={taskUrl}
      />
      <button type="button" onClick={handleCreateTask} disabled={isCreatingTask}>
        {isCreatingTask ? <RefreshCw className="spin" size={17} aria-hidden="true" /> : <Download size={17} aria-hidden="true" />}
        {isCreatingTask ? '加入中...' : '加入队列'}
      </button>
      {taskMessage && <span>{taskMessage}</span>}
      {(isInspectingTaskUrls || taskUrlInspectionSummary.total) && (
        <div className="task-inspection-panel" aria-label="下载前校验">
          <div className="task-inspection-summary">
            <span>{isInspectingTaskUrls ? '正在识别适配器...' : `已检查 ${taskUrlInspectionSummary.total} 个地址`}</span>
            <strong>
              识别 {taskUrlInspectionSummary.matchedCount} · 问题 {taskUrlInspectionSummary.issueCount} · Cookie 已就绪{' '}
              {taskUrlInspectionSummary.cookieReadyCount}
            </strong>
          </div>
          <div className="task-inspection-list">
            {taskUrlInspections.slice(0, 4).map((item) => (
              <article className="task-inspection-item" key={`${item.url}-${item.adapterId ?? 'none'}`}>
                <span className={`source-state-chip ${inspectionTone(item)}`}>
                  {item.valid ? (item.matched ? item.adapterName : '未匹配') : '格式错误'}
                </span>
                <div>
                  <strong>{item.url}</strong>
                  <small>
                    {item.matched
                      ? `${item.adapterVersion ?? ''} · ${item.cookieConfigured ? 'Cookie 已配' : 'Cookie 未配'} · ${
                          item.flareSolverrConfigured ? 'FlareSolverr 已配' : 'FlareSolverr 未配'
                        }`
                      : item.message}
                  </small>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  )

  const renderStats = () => (
    <section className="stat-strip" aria-label="图库统计">
      <article>
        <Database size={20} aria-hidden="true" />
        <div>
          <span>总图片</span>
          <strong>{stats.totalImages}</strong>
        </div>
      </article>
      <article>
        <Download size={20} aria-hidden="true" />
        <div>
          <span>活动任务</span>
          <strong>{stats.activeTasks}</strong>
        </div>
      </article>
      <article>
        <Archive size={20} aria-hidden="true" />
        <div>
          <span>已归档套图</span>
          <strong>{stats.archivedAlbums}</strong>
        </div>
      </article>
      <article>
        <CheckCircle2 size={20} aria-hidden="true" />
        <div>
          <span>完整性</span>
          <strong>{stats.integrityScore}</strong>
        </div>
      </article>
    </section>
  )

  const renderTaskList = (compact = false) => {
    const listTasks = compact ? tasks.slice(0, overviewTaskLimit) : pagedTasks

    return (
      <>
        <div className={compact ? 'task-list compact-list' : 'task-list task-list-full'}>
          {tasks.length ? (
            listTasks.map((task) => {
              const meta = statusMeta[task.status]
              const StatusIcon = meta.icon
              const completedItems = task.completedImages ?? Math.round((task.progress / 100) * task.images)
              const failedCount = task.failedCount ?? task.failedImages?.length ?? 0
              const remainingItems = task.remainingImages ?? Math.max(0, task.images - completedItems)
              const isPendingMetadata = taskIsPendingMetadata(task)
              const phase = taskPhaseMeta(task)
              const mediaSummary = mediaSummaryForItem({
                count: task.images,
                imageCount: task.imageCount,
                mediaSummary: task.mediaSummary,
                videoCount: task.videoCount,
              })
              const canPause = task.status === 'downloading' || task.status === 'queued'
              const canResume = task.status === 'paused'
              const canRetry = task.status === 'partial' || task.status === 'error' || failedCount > 0
              const openTaskDetail = () => {
                updateSelectedTaskId(task.id)
                setTaskActionMessage('')
                setIsTaskDetailOpen(true)
                if (compact) {
                  setActiveView('tasks')
                }
              }

              if (!compact) {
                return (
                  <article
                    className={`${task.id === selectedTask?.id ? 'task-item task-row active' : 'task-item task-row'}${phase?.isParsing ? ' is-parsing' : ''}`}
                    key={task.id}
                  >
                    <button className="task-row-main" onClick={openTaskDetail} type="button">
                      <div className="task-row-head">
                        <span className={`status-pill ${meta.className}`}>
                          <StatusIcon size={14} aria-hidden="true" />
                          {meta.label}
                        </span>
                        <strong>{task.title}</strong>
                        <em>{task.site}</em>
                      </div>

                      <div className="task-row-stats" aria-label="任务概况">
                        <span>{mediaSummary}</span>
                        <span>{task.speed}</span>
                        <span>{task.eta}</span>
                        <span className={failedCount ? 'task-failed-count' : ''}>
                          {failedCount ? `失败 ${failedCount}` : isPendingMetadata ? '等待解析' : `剩余 ${remainingItems}`}
                        </span>
                      </div>

                        <div className="progress-row task-row-progress">
                        <div className={phase?.busy ? 'progress-bar progress-bar-indeterminate' : 'progress-bar'}>
                          <span style={{ width: `${task.progress}%` }} />
                        </div>
                        <em>{task.progress}%</em>
                      </div>

                      {phase?.isParsing && (
                        <div className={`task-phase-strip ${phase.tone}`}>
                          <span className={phase.busy ? 'task-phase-dot pulse' : 'task-phase-dot'} aria-hidden="true" />
                          <strong>{phase.label}</strong>
                          <span>{phase.detail}</span>
                        </div>
                      )}

                      <div className="task-row-foot">
                        <span>{task.currentImage || task.folder}</span>
                        <span>{isPendingMetadata ? '待识别媒体数量' : `${completedItems}/${task.images} 项`}</span>
                      </div>
                    </button>

                    <div className="task-inline-actions" aria-label={`${task.title} 操作`}>
                      {canRetry && (
                        <button
                          className="ghost-button compact-action"
                          type="button"
                          onClick={() => {
                            updateSelectedTaskId(task.id)
                            void handleTaskAction(task, 'retry')
                          }}
                          disabled={isTaskActionBusy}
                        >
                          <RotateCcw size={16} aria-hidden="true" />
                          重试
                        </button>
                      )}
                      {canPause && (
                        <button
                          className="ghost-button compact-action"
                          type="button"
                          onClick={() => {
                            updateSelectedTaskId(task.id)
                            void handleTaskAction(task, 'pause')
                          }}
                          disabled={isTaskActionBusy}
                        >
                          <Pause size={16} aria-hidden="true" />
                          暂停
                        </button>
                      )}
                      {canResume && (
                        <button
                          className="primary-button compact-action"
                          type="button"
                          onClick={() => {
                            updateSelectedTaskId(task.id)
                            void handleTaskAction(task, 'resume')
                          }}
                          disabled={isTaskActionBusy}
                        >
                          <Play size={16} aria-hidden="true" />
                          继续
                        </button>
                      )}
                      <button className="ghost-button compact-action icon-only" type="button" onClick={openTaskDetail} aria-label="查看任务详情">
                        <ChevronRight size={17} aria-hidden="true" />
                      </button>
                    </div>
                  </article>
                )
              }

              return (
                <button
                  className={`${task.id === selectedTask?.id ? 'task-item active' : 'task-item'}${phase?.isParsing ? ' is-parsing' : ''}`}
                  key={task.id}
                  onClick={openTaskDetail}
                  type="button"
                >
                  <div className="task-title">
                    <span className={`status-pill ${meta.className}`}>
                      <StatusIcon size={14} aria-hidden="true" />
                      {meta.label}
                    </span>
                    <strong>{task.title}</strong>
                  </div>
                  <div className="task-meta">
                    <span>{task.site}</span>
                    <span>{task.speed}</span>
                    <span>{mediaSummary}</span>
                    <span>{task.eta}</span>
                  </div>
                  <div className="progress-row">
                    <div className="progress-bar">
                      <span style={{ width: `${task.progress}%` }} />
                    </div>
                    <em>{task.progress}%</em>
                  </div>
                  <small>{task.folder}</small>
                </button>
              )
            })
          ) : (
            <div className="empty-state">
              <Download size={24} aria-hidden="true" />
              <strong>还没有下载任务</strong>
              <span>粘贴套图链接后，任务会出现在这里。</span>
            </div>
          )}
        </div>

        {compact && tasks.length > overviewTaskLimit && (
          <button
            className="view-all-button"
            type="button"
            onClick={() => {
              setTaskPage(1)
              setActiveView('tasks')
            }}
          >
            查看全部任务（{tasks.length}）
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        )}

        {!compact && tasks.length > taskPageSize && (
          <div className="pager-row" aria-label="任务分页">
            <button type="button" onClick={() => setTaskPage((current) => Math.max(1, current - 1))} disabled={safeTaskPage <= 1}>
              <ChevronLeft size={16} aria-hidden="true" />
              上一页
            </button>
            <span>
              {safeTaskPage} / {taskPageCount}
            </span>
            <button
              type="button"
              onClick={() => setTaskPage((current) => Math.min(taskPageCount, current + 1))}
              disabled={safeTaskPage >= taskPageCount}
            >
              下一页
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        )}
      </>
    )
  }

  const renderTaskDetail = () => {
    if (!selectedTask) {
      return (
        <aside className="task-detail empty-detail">
          <Download size={24} aria-hidden="true" />
          <strong>选择一个任务</strong>
          <span>任务详情和暂停、继续操作会显示在这里。</span>
        </aside>
      )
    }

    const meta = statusMeta[selectedTask.status]
    const StatusIcon = meta.icon
    const completedImages = selectedTask.completedImages ?? Math.round((selectedTask.progress / 100) * selectedTask.images)
    const successImages = selectedTask.successImages ?? Math.max(0, completedImages - (selectedTask.failedCount ?? 0))
    const failedCount = selectedTask.failedCount ?? selectedTask.failedImages?.length ?? 0
    const remainingImages = selectedTask.remainingImages ?? Math.max(0, selectedTask.images - completedImages)
    const isPendingMetadata = taskIsPendingMetadata(selectedTask)
    const selectedTaskPhase = taskPhaseMeta(selectedTask)
    const canPause = selectedTask.status === 'downloading' || selectedTask.status === 'queued'
    const canResume = selectedTask.status === 'paused'
    const canRetry = selectedTask.status === 'partial' || selectedTask.status === 'error' || failedCount > 0

    return (
      <aside className="task-detail" aria-label="任务详情">
        <header className="task-detail-header">
          <div>
            <span className={`status-pill ${meta.className}`}>
              <StatusIcon size={14} aria-hidden="true" />
              {meta.label}
            </span>
            <h3>{selectedTask.title}</h3>
            <p>{selectedTask.site}</p>
          </div>
          <div className="task-actions">
            {canRetry && (
              <button
                className="ghost-button"
                type="button"
                onClick={() => void handleTaskAction(selectedTask, 'retry')}
                disabled={isTaskActionBusy}
              >
                <RotateCcw size={17} aria-hidden="true" />
                重试失败项
              </button>
            )}
            {canPause && (
              <button
                className="ghost-button"
                type="button"
                onClick={() => void handleTaskAction(selectedTask, 'pause')}
                disabled={isTaskActionBusy}
              >
                <Pause size={17} aria-hidden="true" />
                暂停
              </button>
            )}
            {canResume && (
              <button
                className="primary-button"
                type="button"
                onClick={() => void handleTaskAction(selectedTask, 'resume')}
                disabled={isTaskActionBusy}
              >
                <Play size={17} aria-hidden="true" />
                继续
              </button>
            )}
            <button className="ghost-button icon-only" type="button" onClick={() => setIsTaskDetailOpen(false)} aria-label="关闭任务详情">
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="task-detail-progress">
          <div className="progress-row">
            <div className={selectedTaskPhase?.busy ? 'progress-bar progress-bar-indeterminate' : 'progress-bar'}>
              <span style={{ width: `${selectedTask.progress}%` }} />
            </div>
            <em>{selectedTask.progress}%</em>
          </div>
          <span>{selectedTask.speed}</span>
        </div>

        {selectedTaskPhase && (
          <div className={`task-phase-card ${selectedTaskPhase.tone}`}>
            <div>
              <strong>{selectedTaskPhase.label}</strong>
              <p>{selectedTaskPhase.detail}</p>
            </div>
            <span className={selectedTaskPhase.busy ? 'task-phase-dot pulse' : 'task-phase-dot'} aria-hidden="true" />
          </div>
        )}

        <div className="task-metric-grid" aria-label="任务统计">
          <article>
            <span>完成</span>
            <strong>{isPendingMetadata ? '待解析' : `${completedImages}/${selectedTask.images}`}</strong>
          </article>
          <article>
            <span>构成</span>
            <strong>{mediaSummaryForItem({ count: selectedTask.images, imageCount: selectedTask.imageCount, mediaSummary: selectedTask.mediaSummary, videoCount: selectedTask.videoCount })}</strong>
          </article>
          <article>
            <span>成功</span>
            <strong>{isPendingMetadata ? '待解析' : successImages}</strong>
          </article>
          <article>
            <span>失败</span>
            <strong>{failedCount}</strong>
          </article>
          <article>
            <span>剩余</span>
            <strong>{isPendingMetadata ? '待解析' : remainingImages}</strong>
          </article>
        </div>

        <dl className="task-detail-list">
          <div>
            <dt>当前图片</dt>
            <dd>{selectedTask.currentImage || '未在下载图片'}</dd>
          </div>
          <div>
            <dt>预计/状态</dt>
            <dd>{selectedTask.eta}</dd>
          </div>
          <div>
            <dt>保存目录</dt>
            <dd>{selectedTask.folder}</dd>
          </div>
          <div>
            <dt>来源 URL</dt>
            <dd>{selectedTask.sourceUrl ?? '未记录'}</dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{formatDateTime(selectedTask.createdAt)}</dd>
          </div>
        </dl>

        {selectedTask.albumId && (
          <button
            className="ghost-button task-detail-link"
            type="button"
            onClick={() => {
              selectAlbum(selectedTask.albumId ?? '')
              setActiveView('library')
            }}
          >
            <FolderOpen size={17} aria-hidden="true" />
            查看套图
          </button>
        )}

        {selectedTask.failedImages?.length ? (
          <section className="failed-image-list" aria-label="失败项">
            <div className="task-subtitle">
              <strong>失败项</strong>
              <span>{selectedTask.failedImages.length} 项</span>
            </div>
            {selectedTask.failedImages.map((image) => (
              <article key={`${image.id}-${image.sequence}`}>
                <strong>{image.sequence}</strong>
                <span>{image.title}</span>
                <small>{image.error}</small>
              </article>
            ))}
          </section>
        ) : null}

        {taskActionMessage && <div className="settings-message task-action-message">{taskActionMessage}</div>}
      </aside>
    )
  }

  const renderAlbumRail = (mode: 'overview' | 'library' = 'library') => {
    const listAlbums = mode === 'overview' ? overviewAlbums : albums

    return (
      <>
        <div className={mode === 'overview' ? 'album-rail overview-album-rail' : 'album-rail'} aria-label="套图列表">
          {albums.length ? (
            listAlbums.map((album) => (
              <button
                className={album.id === selectedAlbum?.id ? 'album-card active' : 'album-card'}
                key={album.id}
                onClick={() => selectAlbum(album.id)}
                onDoubleClick={() => {
                  selectAlbum(album.id)
                  if (activeView === 'overview') {
                    setActiveView('library')
                  }
                }}
                type="button"
              >
                <img src={album.thumbUrl ?? album.cover} alt="" loading="lazy" decoding="async" />
                <div>
                  <strong>{album.title}</strong>
                  <span>
                    {mediaSummaryForItem(album)} · {album.count} 项 · {album.size}
                  </span>
                </div>
                <em>{album.status}</em>
              </button>
            ))
          ) : (
            <div className="empty-state span-all">
              <FolderOpen size={24} aria-hidden="true" />
              <strong>图片库为空</strong>
              <span>完成一个下载任务后，套图会按站点和标题归档到这里。</span>
            </div>
          )}
        </div>

        {mode === 'overview' && albums.length > overviewAlbumPageSize && (
          <div className="pager-row album-pager" aria-label="套图分页">
            <button
              type="button"
              onClick={() => setOverviewAlbumPage((current) => Math.max(1, current - 1))}
              disabled={safeOverviewAlbumPage <= 1}
            >
              <ChevronLeft size={16} aria-hidden="true" />
              上一页
            </button>
            <span>
              {safeOverviewAlbumPage} / {overviewAlbumPageCount}
            </span>
            <button
              type="button"
              onClick={() => setOverviewAlbumPage((current) => Math.min(overviewAlbumPageCount, current + 1))}
              disabled={safeOverviewAlbumPage >= overviewAlbumPageCount}
            >
              下一页
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        )}
      </>
    )
  }

  const renderLibraryAlbumList = () => (
    <aside className="album-browser" aria-label="相册导航">
      <div className="library-side-header">
        <div>
          <span className="eyebrow">相册</span>
          <h2>套图导航</h2>
        </div>
        <span>{filteredLibraryAlbums.length}/{albums.length}</span>
      </div>

      <div className="library-side-stats" aria-label="相册筛选概况">
        <article>
          <span>筛选后</span>
          <strong>{filteredLibraryAlbums.length}</strong>
        </article>
        <article>
          <span>站点</span>
          <strong>{albumSourceFilter === 'all' ? albumSourceOptions.length || '全部' : albumSourceFilter}</strong>
        </article>
        <article>
          <span>状态</span>
          <strong>{albumStatusFilter === 'all' ? '全部' : albumStatusFilter === 'done' ? '已完成' : albumStatusFilter === 'active' ? '进行中' : '有问题'}</strong>
        </article>
      </div>

      <label className="library-search">
        <Search size={16} aria-hidden="true" />
        <input
          aria-label="搜索相册"
          onChange={(event) => setAlbumQuery(event.target.value)}
          placeholder="搜索标题、标签、站点"
          type="search"
          value={albumQuery}
        />
      </label>

      <div className="library-filter-grid">
        <label>
          <span>站点</span>
          <select aria-label="按站点筛选相册" onChange={(event) => setAlbumSourceFilter(event.target.value)} value={albumSourceFilter}>
            <option value="all">全部站点</option>
            {albumSourceOptions.map((sourceName) => (
              <option key={sourceName} value={sourceName}>
                {sourceName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>状态</span>
          <select aria-label="按状态筛选相册" onChange={(event) => setAlbumStatusFilter(event.target.value)} value={albumStatusFilter}>
            <option value="all">全部状态</option>
            <option value="done">已完成</option>
            <option value="active">进行中</option>
            <option value="issue">有问题</option>
          </select>
        </label>
      </div>

      <div className="library-album-list">
        {filteredLibraryAlbums.length ? (
          filteredLibraryAlbums.map((album) => (
            <button
              className={album.id === selectedAlbum?.id ? 'library-album-item active' : 'library-album-item'}
              key={album.id}
              onClick={() => selectAlbum(album.id)}
              type="button"
            >
              <img src={album.thumbUrl ?? album.cover} alt="" loading="lazy" decoding="async" />
              <span>
                <strong>{album.title}</strong>
                <small>{album.source} · {mediaSummaryForItem(album)} · {album.size}</small>
                <em>{album.status}</em>
              </span>
            </button>
          ))
        ) : (
          <div className="empty-state library-empty">
            <FolderOpen size={22} aria-hidden="true" />
            <strong>没有匹配相册</strong>
            <span>调整搜索或筛选条件后再看。</span>
          </div>
        )}
      </div>
    </aside>
  )

  const renderAlbumInfoPanel = () => {
    if (!selectedAlbum) {
      return (
        <aside className="album-info-panel">
          <div className="empty-state">
            <FolderOpen size={24} aria-hidden="true" />
            <strong>选择一个相册</strong>
            <span>相册信息、保存路径和标签会显示在这里。</span>
          </div>
        </aside>
      )
    }

    return (
      <aside className="album-info-panel" aria-label="相册信息">
        <section className="album-inspector-section">
          <div className="task-subtitle">
            <strong>当前媒体</strong>
            <span>{selectedPhoto ? (isVideoPhoto(selectedPhoto) ? '视频' : '图片') : '未选择'}</span>
          </div>

          {selectedPhoto ? (
            <>
              <button className="selected-media-preview" type="button" onClick={() => openPhotoViewer(selectedPhoto.id)}>
                <img src={photoThumbSource(selectedPhoto)} alt={selectedPhoto.title} loading="lazy" decoding="async" />
                {isVideoPhoto(selectedPhoto) && (
                  <span className="video-badge inspector-video-badge" aria-label="视频">
                    <Film size={14} aria-hidden="true" />
                    视频
                  </span>
                )}
              </button>
              <div className="selected-media-copy">
                <strong>{selectedPhoto.title}</strong>
                <span>
                  {selectedPhoto.resolution} · {selectedPhoto.size}
                </span>
              </div>
              <div className="album-info-actions compact">
                <button className="primary-button" type="button" onClick={() => openPhotoViewer(selectedPhoto.id)}>
                  <Eye size={17} aria-hidden="true" />
                  查看当前
                </button>
                <button className="ghost-button" type="button" onClick={openSlideshow}>
                  <Film size={17} aria-hidden="true" />
                  幻灯片
                </button>
              </div>
            </>
          ) : (
            <div className="empty-state inspector-empty">
              <Image size={22} aria-hidden="true" />
              <strong>当前没有媒体</strong>
              <span>下载完成后会按网页顺序显示在这里。</span>
            </div>
          )}
        </section>

        <section className="album-inspector-section">
          <div className="album-info-cover">
            <img src={selectedAlbum.thumbUrl ?? selectedAlbum.cover} alt="" loading="lazy" decoding="async" />
          </div>
          <div className="album-info-title">
            <span className="eyebrow">{selectedAlbum.source}</span>
            <h2>{selectedAlbum.title}</h2>
            <p>{mediaSummaryForItem(selectedAlbum)} · {selectedAlbum.size}</p>
          </div>

          <div className="album-info-stats">
            <article>
              <span>状态</span>
              <strong>{selectedAlbum.status}</strong>
            </article>
            <article>
              <span>当前筛选</span>
              <strong>{visiblePhotos.length}</strong>
            </article>
          </div>

          <dl className="album-info-list">
            <div>
              <dt>保存目录</dt>
              <dd>{selectedAlbumTask?.folder ?? '未记录'}</dd>
            </div>
            <div>
              <dt>来源 URL</dt>
              <dd>{selectedAlbumTask?.sourceUrl ?? '未记录'}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{selectedAlbum.updated}</dd>
            </div>
          </dl>

          <div className="album-info-tags">
            {selectedAlbum.tags.length ? (
              selectedAlbum.tags.map((tag) => (
                <button key={tag} type="button" onClick={() => setActiveView('tags')}>
                  #{tag}
                </button>
              ))
            ) : (
              <span>暂无标签</span>
            )}
          </div>

          {selectedAlbumTask && (
            <div className="album-info-actions compact">
              <button
                className="ghost-button"
                type="button"
                onClick={() => {
                  updateSelectedTaskId(selectedAlbumTask.id)
                  setIsTaskDetailOpen(true)
                }}
              >
                <Download size={17} aria-hidden="true" />
                查看任务
              </button>
            </div>
          )}
        </section>
      </aside>
    )
  }

  const renderPhotoGrid = () => (
    <div className="photo-grid" aria-label={`${selectedAlbum?.title ?? '图库'} 图片`}>
      {visiblePhotos.length ? (
        renderedPhotos.map((photo, index) => (
          <button
            className={[
              photo.id === selectedPhoto?.id ? 'photo-tile active' : 'photo-tile',
              isVideoPhoto(photo) ? 'video-tile' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            key={photo.id}
            onClick={() => {
              updateSelectedPhotoId(photo.id)
              openPhotoViewer(photo.id)
            }}
            type="button"
          >
            <span className="photo-thumb-frame">
              <img src={photoThumbSource(photo)} alt={photo.title} loading="lazy" decoding="async" />
              <span className="photo-sequence">{String(index + 1).padStart(3, '0')}</span>
              {isVideoPhoto(photo) && (
                <span className="video-badge" aria-label="视频">
                  <Film size={15} aria-hidden="true" />
                  视频
                </span>
              )}
            </span>
            <span className="photo-copy">
              <span className="photo-title">{photo.title}</span>
              <small>
                {photo.resolution} · {photo.size}
              </small>
            </span>
          </button>
        ))
      ) : (
        <div className="empty-state span-all">
          <Image size={24} aria-hidden="true" />
          <strong>当前套图没有图片</strong>
          <span>下载完成后会按网页加载顺序显示。</span>
        </div>
      )}
      {hasMorePhotos && (
        <button className="load-more-button" type="button" onClick={() => setPhotoLimit((current) => current + photoBatchSize)}>
          显示更多图片（{renderedPhotos.length}/{visiblePhotos.length}）
        </button>
      )}
    </div>
  )

  const renderOverview = () => (
    <section className="overview-page">
      {renderTaskForm()}
      {renderStats()}
      <div className="overview-layout">
        <section className="library-panel overview-library-panel" aria-labelledby="overview-library-title">
          <div className="panel-toolbar">
            <div>
              <span className="eyebrow">最近套图</span>
              <h2 id="overview-library-title">图片库概览</h2>
            </div>
            <button className="ghost-button" type="button" onClick={() => setActiveView('library')}>
              <Eye size={17} aria-hidden="true" />
              查看全部
            </button>
          </div>

          <div className="overview-library-stats" aria-label="相册概况">
            <article>
              <span>总相册</span>
              <strong>{albums.length}</strong>
            </article>
            <article>
              <span>进行中</span>
              <strong>{activeAlbumCount}</strong>
            </article>
            <article>
              <span>有问题</span>
              <strong>{issueAlbumCount}</strong>
            </article>
            <article>
              <span>已完成</span>
              <strong>{doneAlbumCount}</strong>
            </article>
          </div>

          {renderAlbumRail('overview')}

          {selectedAlbum && (
            <div className="overview-album-focus">
              <div className="overview-album-copy">
                <span className="eyebrow">{selectedAlbum.source}</span>
                <strong>{selectedAlbum.title}</strong>
                <p>
                  {mediaSummaryForItem(selectedAlbum)} · {selectedAlbum.size} · {selectedAlbum.status}
                </p>
              </div>
              <div className="overview-album-actions">
                <button className="primary-button" type="button" onClick={() => setActiveView('library')}>
                  <Images size={17} aria-hidden="true" />
                  打开图片库
                </button>
                <button className="ghost-button" type="button" onClick={() => setActiveView('tags')}>
                  <Tags size={17} aria-hidden="true" />
                  查看标签
                </button>
              </div>
            </div>
          )}
        </section>

        <aside className="overview-side-stack">
          <section className="tasks-panel overview-tasks-panel" aria-labelledby="overview-tasks-title">
            <div className="panel-toolbar compact">
              <div>
                <span className="eyebrow">下载队列</span>
                <h2 id="overview-tasks-title">任务管理</h2>
              </div>
              <button className="ghost-button icon-only" type="button" onClick={() => setActiveView('tasks')} aria-label="打开下载任务">
                <ListFilter size={17} aria-hidden="true" />
              </button>
            </div>
            {renderTaskList(true)}
          </section>

          <section className="page-panel overview-health-panel" aria-labelledby="overview-health-title">
            <div className="panel-toolbar compact">
              <div>
                <span className="eyebrow">系统就绪</span>
                <h2 id="overview-health-title">站点与配置</h2>
              </div>
              <button className="ghost-button icon-only" type="button" onClick={() => setActiveView('settings')} aria-label="打开设置">
                <Settings size={17} aria-hidden="true" />
              </button>
            </div>

            <div className="overview-health-grid" aria-label="系统概况">
              <article>
                <span>适配器</span>
                <strong>{sources.length}</strong>
              </article>
              <article>
                <span>Cookie 已配</span>
                <strong>{configuredCookieCount}</strong>
              </article>
              <article>
                <span>代理</span>
                <strong>{settingsData?.proxy ? '已启用' : '直连'}</strong>
              </article>
              <article>
                <span>FlareSolverr</span>
                <strong>{settingsData?.flareSolverrUrl ? '已配置' : '未配置'}</strong>
              </article>
            </div>

            <div className="overview-source-list">
              {sources.map((source) => {
                const hasCookie = Boolean(settingsData?.sites[source.id]?.cookieConfigured)
                return (
                  <button
                    className="overview-source-row"
                    key={source.id}
                    type="button"
                    onClick={() => {
                      setActiveCookieSiteId(source.id)
                      setActiveView('settings')
                    }}
                  >
                    <span className="source-dot" style={{ backgroundColor: source.color }} />
                    <div>
                      <strong>{source.name}</strong>
                      <small>{source.version}</small>
                    </div>
                    <span className={`source-state-chip ${sourceStatusTone(source.status)}`}>{source.status}</span>
                    <span className={hasCookie ? 'source-meta-chip ready' : 'source-meta-chip'}>
                      {hasCookie ? 'Cookie 已配' : 'Cookie 未配'}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        </aside>
      </div>
    </section>
  )

  const renderTasksView = () => (
    <section className="page-panel tasks-page">
      <div className="panel-toolbar task-page-toolbar">
        <div>
          <span className="eyebrow">队列</span>
          <h2>任务列表</h2>
          <p className="task-page-subtitle">单任务执行，批量地址会按加入顺序排队。</p>
        </div>
        <button className="ghost-button" type="button" onClick={() => void refreshData()}>
          <RefreshCw size={17} aria-hidden="true" />
          刷新
        </button>
      </div>

      {renderTaskForm()}

      <section className="queue-summary-strip" aria-label="下载队列概况">
        <article className="queue-summary-card accent">
          <Download size={18} aria-hidden="true" />
          <span>下载中</span>
          <strong>{taskQueueSummary.byStatus.downloading}</strong>
        </article>
        <article className="queue-summary-card">
          <Clock3 size={18} aria-hidden="true" />
          <span>排队</span>
          <strong>{taskQueueSummary.byStatus.queued}</strong>
        </article>
        <article className="queue-summary-card">
          <CirclePause size={18} aria-hidden="true" />
          <span>暂停</span>
          <strong>{taskQueueSummary.byStatus.paused}</strong>
        </article>
        <article className={taskQueueSummary.issueTasks ? 'queue-summary-card warning' : 'queue-summary-card'}>
          <RotateCcw size={18} aria-hidden="true" />
          <span>需处理</span>
          <strong>{taskQueueSummary.issueTasks}</strong>
        </article>
        <article className="queue-summary-card">
          <CheckCircle2 size={18} aria-hidden="true" />
          <span>已完成</span>
          <strong>{taskQueueSummary.byStatus.done}</strong>
        </article>
      </section>

      <div className="task-board">
        <section className="task-board-main" aria-labelledby="task-board-title">
          <div className="task-board-head">
            <div>
              <span className="eyebrow">QUEUE</span>
              <h3 id="task-board-title">队列明细</h3>
            </div>
            <span>
              第 {safeTaskPage} / {taskPageCount} 页 · 共 {taskQueueSummary.total} 个任务
            </span>
          </div>
          <div className="task-workspace">{renderTaskList()}</div>
        </section>

        <aside className="task-board-side" aria-label="队列状态">
          <section className="queue-status-card">
            <div className="task-subtitle">
              <strong>当前执行</strong>
              <span>{taskQueueSummary.activeTasks} 个活动任务</span>
            </div>
            {taskQueueSummary.runningTask ? (
              <div className="queue-now">
                <strong>{taskQueueSummary.runningTask.title}</strong>
                <span>{taskQueueSummary.runningTask.speed}</span>
                <div className="progress-row">
                  <div className="progress-bar">
                    <span style={{ width: `${taskQueueSummary.runningTask.progress}%` }} />
                  </div>
                  <em>{taskQueueSummary.runningTask.progress}%</em>
                </div>
              </div>
            ) : (
              <div className="queue-now muted-box">
                <strong>当前没有下载中的任务</strong>
                <span>{taskQueueSummary.nextWaitingTask ? '已有任务在等待调度' : '加入地址后会自动开始队列'}</span>
              </div>
            )}
          </section>

          <section className="queue-status-card">
            <div className="task-subtitle">
              <strong>排队策略</strong>
              <span>单线程</span>
            </div>
            <dl className="queue-facts">
              <div>
                <dt>下一项</dt>
                <dd>{taskQueueSummary.nextWaitingTask?.title ?? '暂无等待任务'}</dd>
              </div>
              <div>
                <dt>失败项</dt>
                <dd>{taskQueueSummary.failedItems ? `${taskQueueSummary.failedItems} 项可重试` : '没有失败项'}</dd>
              </div>
              <div>
                <dt>操作</dt>
                <dd>点击任务打开详情，行内按钮可直接暂停、继续、重试。</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </section>
  )

  const renderLibraryView = () => (
    <div className="library-view library-workspace">
      {renderLibraryAlbumList()}
      <section className="library-media-panel" aria-labelledby="library-title">
        <div className="library-stage-header">
          <div>
            <span className="eyebrow">当前相册</span>
            <h2 id="library-title">{selectedAlbum?.title ?? '套图与图片'}</h2>
            <p className="library-media-subtitle">
              {selectedAlbum
                ? `${selectedAlbum.source} · ${mediaSummaryForItem(selectedAlbum)} · 当前显示 ${visiblePhotos.length} 项`
                : '选择左侧相册后查看图片和视频'}
            </p>
          </div>
          <div className="library-toolbar-actions">
            <button className="ghost-button" type="button" onClick={() => void refreshData()}>
              <RefreshCw size={17} aria-hidden="true" />
              刷新
            </button>
            <button className="primary-button" type="button" onClick={openSlideshow} disabled={!selectedPhoto}>
              <Film size={17} aria-hidden="true" />
              播放幻灯片
            </button>
          </div>
        </div>
        {selectedAlbum && (
          <>
            <div className="library-stage-metrics" aria-label="媒体统计">
              <article>
                <span>构成</span>
                <strong>{mediaSummaryForItem(selectedAlbum)}</strong>
              </article>
              <article>
                <span>当前筛选</span>
                <strong>{visiblePhotos.length}</strong>
              </article>
              <article>
                <span>图片 / 视频</span>
                <strong>
                  {visibleImageCount} / {visibleVideoCount}
                </strong>
              </article>
              <article>
                <span>标签</span>
                <strong>{selectedAlbumTagCount}</strong>
              </article>
            </div>
            <div className="library-stage-tools">
              <label className="library-inline-search">
                <Search size={16} aria-hidden="true" />
                <input
                  aria-label="筛选当前相册媒体"
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setPhotoLimit(photoBatchSize)
                  }}
                  placeholder="筛选当前相册的文件名或标签"
                  type="search"
                  value={query}
                />
              </label>
              {selectedAlbum.tags.length ? (
                <div className="library-stage-tags">
                  {selectedAlbum.tags.map((tag) => (
                    <button key={tag} type="button" onClick={() => setActiveView('tags')}>
                      #{tag}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="library-stage-empty-tag">暂无标签</span>
              )}
            </div>
          </>
        )}
        {renderPhotoGrid()}
      </section>
      {renderAlbumInfoPanel()}
    </div>
  )

  const renderTagsView = () => (
    <section className="page-panel tags-page">
      <div className="panel-toolbar">
        <div>
          <span className="eyebrow">标签</span>
          <h2>按标签整理图片</h2>
        </div>
        <span className="panel-count">{tagStats.length} 个标签</span>
      </div>

      <div className="tag-summary-strip" aria-label="标签概况">
        <article>
          <span>标签数</span>
          <strong>{tagStats.length}</strong>
        </article>
        <article>
          <span>已标记媒体</span>
          <strong>{taggedPhotoCount}</strong>
        </article>
        <article>
          <span>最高频标签</span>
          <strong>{tagStats[0] ? `#${tagStats[0].tag}` : '暂无'}</strong>
        </article>
      </div>

      <div className="tag-manager-grid">
        {tagStats.length ? (
          tagStats.map(({ tag, count, photos: taggedPhotos }) => (
            <article className="tag-card" key={tag}>
              <div>
                <strong>#{tag}</strong>
                <span>{count} 张图片</span>
              </div>
              <div className="tag-preview-row">
                {taggedPhotos.slice(0, 4).map((photo) => (
                  <img key={photo.id} src={photoThumbSource(photo)} alt="" loading="lazy" decoding="async" />
                ))}
              </div>
              <button
                className="ghost-button"
                type="button"
                onClick={() => {
                  setQuery(tag)
                  setPhotoLimit(photoBatchSize)
                  setActiveView('library')
                }}
              >
                <Search size={16} aria-hidden="true" />
                在图片库中查看
              </button>
            </article>
          ))
        ) : (
          <div className="empty-state span-all">
            <Tags size={24} aria-hidden="true" />
            <strong>暂无标签</strong>
            <span>下载完成后的图片标签会在这里汇总。</span>
          </div>
        )}
      </div>
    </section>
  )

  const renderSourcesView = () => (
    <section className="page-panel sources-page">
      <div className="panel-toolbar">
        <div>
          <span className="eyebrow">站点</span>
          <h2>适配器与站点能力</h2>
        </div>
        <button className="ghost-button" type="button" onClick={() => void refreshData()}>
          <RefreshCw size={17} aria-hidden="true" />
          刷新状态
        </button>
      </div>

      <div className="source-summary-strip" aria-label="适配器概况">
        <article>
          <span>总适配器</span>
          <strong>{sources.length}</strong>
        </article>
        <article>
          <span>可用</span>
          <strong>{readySourceCount}</strong>
        </article>
        <article>
          <span>等待中</span>
          <strong>{queuedSourceCount}</strong>
        </article>
        <article>
          <span>需关注</span>
          <strong>{issueSourceCount}</strong>
        </article>
        <article>
          <span>Cookie 已配</span>
          <strong>{configuredCookieCount}</strong>
        </article>
      </div>

      <section className="source-diagnostic-panel" aria-labelledby="source-diagnostic-title">
        <div className="panel-toolbar compact">
          <div>
            <span className="eyebrow">URL 诊断</span>
            <h2 id="source-diagnostic-title">下载前识别</h2>
          </div>
          <button className="ghost-button" type="button" onClick={() => void handleInspectSourceUrl()} disabled={isInspectingSourceDiagnostic}>
            <Search size={16} aria-hidden="true" />
            {isInspectingSourceDiagnostic ? '识别中' : '识别 URL'}
          </button>
        </div>

        <div className="source-diagnostic-layout">
          <label className="field-stack">
            <span>套图地址</span>
            <input
              onChange={(event) => setSourceDiagnosticUrl(event.target.value)}
              placeholder="粘贴一个站点地址，检查会命中哪个适配器"
              type="url"
              value={sourceDiagnosticUrl}
            />
          </label>

          {sourceDiagnosticResult ? (
            <div className="source-diagnostic-result">
              <span className={`source-state-chip ${inspectionTone(sourceDiagnosticResult)}`}>
                {sourceDiagnosticResult.valid
                  ? sourceDiagnosticResult.matched
                    ? sourceDiagnosticResult.adapterName
                    : '未匹配'
                  : '格式错误'}
              </span>
              <div className="source-diagnostic-copy">
                <strong>{sourceDiagnosticResult.message}</strong>
                <small>{sourceDiagnosticResult.hostname ?? sourceDiagnosticResult.url}</small>
              </div>
              {sourceDiagnosticResult.matched ? (
                <div className="source-chip-row">
                  <span className={sourceDiagnosticResult.cookieConfigured ? 'source-meta-chip ready' : 'source-meta-chip'}>
                    {sourceDiagnosticResult.cookieConfigured ? 'Cookie 已配' : 'Cookie 未配'}
                  </span>
                  <span className={sourceDiagnosticResult.flareSolverrConfigured ? 'source-meta-chip ready' : 'source-meta-chip'}>
                    {sourceDiagnosticResult.flareSolverrConfigured ? 'FlareSolverr 已配' : 'FlareSolverr 未配'}
                  </span>
                </div>
              ) : null}
              <div className="source-card-actions">
                {sourceDiagnosticResult.matched && (
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => {
                      setTaskUrl(sourceDiagnosticResult.url)
                      setActiveView('tasks')
                    }}
                  >
                    <Download size={17} aria-hidden="true" />
                    带入下载框
                  </button>
                )}
                {sourceDiagnosticResult.matched && !sourceDiagnosticResult.cookieConfigured && sourceDiagnosticResult.adapterId && (
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => {
                      setActiveCookieSiteId(sourceDiagnosticResult.adapterId ?? '')
                      setActiveView('settings')
                    }}
                  >
                    <Cookie size={17} aria-hidden="true" />
                    去配 Cookie
                  </button>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <div className="source-grid">
        {sources.map((source) => {
          const settingsId = sourceSettingsId(source)
          const cookieConfigured = Boolean(settingsData?.sites[settingsId]?.cookieConfigured)
          return (
            <article className="source-card source-card-advanced" key={source.id}>
              <div className="source-card-head">
                <span className="source-dot" style={{ backgroundColor: source.color }} />
                <div>
                  <strong>{source.name}</strong>
                  <span>{source.version}</span>
                </div>
                <span className={`source-state-chip ${sourceStatusTone(source.status)}`}>{source.status}</span>
              </div>

              <div className="source-chip-row">
                <span className={cookieConfigured ? 'source-meta-chip ready' : 'source-meta-chip'}>
                  {cookieConfigured ? 'Cookie 已配' : 'Cookie 未配'}
                </span>
                {source.domains.map((domain) => (
                  <span className="source-domain-chip" key={domain}>
                    {domain}
                  </span>
                ))}
              </div>

              <dl>
                <div>
                  <dt>域名</dt>
                  <dd>{source.domains.join(', ')}</dd>
                </div>
                <div>
                  <dt>能力</dt>
                  <dd>{source.capabilities.join(' / ')}</dd>
                </div>
              </dl>

              <div className="source-capability-row">
                {source.capabilities.map((capability) => (
                  <span className="source-capability-chip" key={capability}>
                    {capability}
                  </span>
                ))}
              </div>

              {settingsId && (
                <div className="source-card-actions">
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => {
                      setActiveCookieSiteId(settingsId)
                      setActiveView('settings')
                    }}
                  >
                    <Cookie size={17} aria-hidden="true" />
                    配置 Cookie
                  </button>
                  <button className="ghost-button" type="button" onClick={() => setActiveView('tasks')}>
                    <Download size={17} aria-hidden="true" />
                    去下载任务
                  </button>
                </div>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )

  const renderSettingsView = () => (
    <section className="page-panel settings-page">
      <div className="panel-toolbar">
        <div>
          <span className="eyebrow">持久化设置</span>
          <h2>站点 Cookie 与网络代理</h2>
        </div>
        <button className="ghost-button" type="button" onClick={() => void refreshSettings()}>
          <RefreshCw size={17} aria-hidden="true" />
          重新读取
        </button>
      </div>

      <div className="settings-summary-strip" aria-label="设置概况">
        <article>
          <span>当前用户</span>
          <strong>{authStatus?.user?.username ?? '未登录'}</strong>
        </article>
        <article>
          <span>Cookie 已配</span>
          <strong>{configuredCookieCount}</strong>
        </article>
        <article>
          <span>代理</span>
          <strong>{settingsData?.proxy ? '已启用' : '直连'}</strong>
        </article>
        <article>
          <span>FlareSolverr</span>
          <strong>{settingsData?.flareSolverrUrl ? '已配置' : '未配置'}</strong>
        </article>
      </div>

      <div className="settings-grid settings-grid-advanced">
        <article className="settings-card span-all">
          <div className="settings-card-title">
            <LockKeyhole size={20} aria-hidden="true" />
            <div>
              <strong>登录账号</strong>
              <span>当前用户：{authStatus?.user?.username ?? '未登录'}</span>
            </div>
          </div>
          <div className="account-settings-grid">
            <label className="field-stack">
              <span>用户名</span>
              <input
                autoComplete="username"
                onChange={(event) => setAccountUsernameInput(event.target.value)}
                type="text"
                value={accountUsernameInput}
              />
            </label>
            <label className="field-stack">
              <span>当前密码</span>
              <input
                autoComplete="current-password"
                onChange={(event) => setAccountCurrentPassword(event.target.value)}
                type="password"
                value={accountCurrentPassword}
              />
            </label>
            <label className="field-stack">
              <span>新密码</span>
              <input
                autoComplete="new-password"
                onChange={(event) => setAccountNewPassword(event.target.value)}
                placeholder="不修改密码可留空"
                type="password"
                value={accountNewPassword}
              />
            </label>
            <label className="field-stack">
              <span>确认新密码</span>
              <input
                autoComplete="new-password"
                onChange={(event) => setAccountConfirmPassword(event.target.value)}
                placeholder="不修改密码可留空"
                type="password"
                value={accountConfirmPassword}
              />
            </label>
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={() => void handleSaveAccount()}
            disabled={isAccountSaving}
          >
            <Save size={17} aria-hidden="true" />
            保存账号
          </button>
        </article>
        <article className="settings-card span-all">
          <div className="settings-card-title">
            <Cookie size={20} aria-hidden="true" />
            <div>
              <strong>Cookie 管理</strong>
              <span>
                {settingsData?.sites[activeCookieSiteId]?.cookieConfigured
                  ? `已保存：${settingsData.sites[activeCookieSiteId].cookiePreview}`
                  : '当前站点未配置'}
              </span>
            </div>
          </div>
          <div className="cookie-site-tabs" aria-label="站点 Cookie 切换">
            {sources.map((source) => (
              <button
                className={activeCookieSiteId === source.id ? 'cookie-site-tab active' : 'cookie-site-tab'}
                key={source.id}
                type="button"
                onClick={() => setActiveCookieSiteId(source.id)}
              >
                <span className="source-dot" style={{ backgroundColor: source.color }} />
                {source.name}
              </button>
            ))}
          </div>
          <div className="cookie-manager-layout">
            <div className="cookie-manager-row">
              <label className="field-stack">
                <span>站点</span>
                <select value={activeCookieSiteId} onChange={(event) => setActiveCookieSiteId(event.target.value)}>
                  {sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                    </option>
                  ))}
                </select>
              </label>
              <dl className="mini-path-list compact cookie-site-meta">
                <div>
                  <dt>域名</dt>
                  <dd>{settingsData?.sites[activeCookieSiteId]?.domains.join(', ') ?? '读取中'}</dd>
                </div>
                <div>
                  <dt>Cookie 文件</dt>
                  <dd>{settingsData?.sites[activeCookieSiteId]?.cookieFile ?? '读取中'}</dd>
                </div>
              </dl>
            </div>

            <div className="cookie-editor-stack">
              <label className="field-stack">
                <span>Cookie 内容</span>
                <textarea
                  onChange={(event) => updateCookieInput(activeCookieSiteId, event.target.value)}
                  placeholder="可粘贴 Netscape cookie txt，也可粘贴浏览器请求头里的 Cookie: a=b; c=d"
                  value={cookieInputs[activeCookieSiteId] ?? ''}
                />
              </label>
              <div className="button-row">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void handleSaveSiteCookie(activeCookieSiteId)}
                  disabled={isSavingSettings}
                >
                  <Save size={17} aria-hidden="true" />
                  保存 Cookie
                </button>
                <button
                  className="ghost-button danger"
                  type="button"
                  onClick={() => void handleClearCookie(activeCookieSiteId)}
                  disabled={isSavingSettings}
                >
                  <Trash2 size={17} aria-hidden="true" />
                  清空 Cookie
                </button>
              </div>
            </div>
          </div>
        </article>
        <article className="settings-card">
          <div className="settings-card-title">
            <Globe2 size={20} aria-hidden="true" />
            <div>
              <strong>网络代理</strong>
              <span>{settingsData?.proxy ? settingsData.proxy : '未配置，容器直连'}</span>
            </div>
          </div>
          <label className="field-stack">
            <span>代理地址</span>
            <input
              onChange={(event) => setProxyInput(event.target.value)}
              placeholder="例如 http://10.10.10.1:7890 或 socks5://10.10.10.1:7890"
              type="text"
              value={proxyInput}
            />
          </label>
          <button className="primary-button" type="button" onClick={handleSaveSettings} disabled={isSavingSettings}>
            <Save size={17} aria-hidden="true" />
            保存代理
          </button>
        </article>
        <article className="settings-card">
          <div className="settings-card-title">
            <SlidersHorizontal size={20} aria-hidden="true" />
            <div>
              <strong>FlareSolverr</strong>
              <span>{settingsData?.flareSolverrUrl ? settingsData.flareSolverrUrl : '未配置，xChina 按直连尝试'}</span>
            </div>
          </div>
          <label className="field-stack">
            <span>Cloudflare 突破服务</span>
            <input
              onChange={(event) => setFlareSolverrInput(event.target.value)}
              placeholder="例如 http://flaresolverr-host:8191"
              type="url"
              value={flareSolverrInput}
            />
          </label>
          <button className="primary-button" type="button" onClick={handleSaveSettings} disabled={isSavingSettings}>
            <Save size={17} aria-hidden="true" />
            保存 FlareSolverr
          </button>
        </article>
        <article className="settings-card span-all">
          <div className="settings-card-title">
            <HardDrive size={20} aria-hidden="true" />
            <div>
              <strong>持久化路径</strong>
              <span>这些路径来自容器运行环境</span>
            </div>
          </div>
          <dl className="path-list">
            <div>
              <dt>图片目录</dt>
              <dd>{settingsData?.paths.mediaRoot ?? '读取中'}</dd>
            </div>
            <div>
              <dt>配置目录</dt>
              <dd>{settingsData?.paths.configRoot ?? '读取中'}</dd>
            </div>
            <div>
              <dt>缩略图缓存</dt>
              <dd>{settingsData?.paths.thumbRoot ?? '读取中'}</dd>
            </div>
            <div>
              <dt>站点 Cookie 目录</dt>
              <dd>{settingsData?.paths.siteCookieRoot ?? '读取中'}</dd>
            </div>
            <div>
              <dt>代理文件</dt>
              <dd>{settingsData?.paths.proxyConfigFile ?? '读取中'}</dd>
            </div>
            <div>
              <dt>FlareSolverr 文件</dt>
              <dd>{settingsData?.paths.flareSolverrConfigFile ?? '读取中'}</dd>
            </div>
            <div>
              <dt>xChina User-Agent 文件</dt>
              <dd>{settingsData?.paths.xchinaUserAgentFile ?? '读取中'}</dd>
            </div>
          </dl>
        </article>
      </div>
      {settingsMessage && <div className="settings-message">{settingsMessage}</div>}
    </section>
  )

  const renderActiveView = () => {
    switch (activeView) {
      case 'tasks':
        return renderTasksView()
      case 'library':
        return renderLibraryView()
      case 'tags':
        return renderTagsView()
      case 'sources':
        return renderSourcesView()
      case 'settings':
        return renderSettingsView()
      default:
        return renderOverview()
    }
  }

  const renderAuthView = () => {
    const isInitializing = authStatus ? !authStatus.initialized : false
    const title = isInitializing ? '初始化管理员' : '登录 PicHarbor'
    const buttonText = isInitializing ? '创建管理员' : '登录'

    return (
      <main className="auth-screen" data-theme={themeMode}>
        <form className="auth-card auth-card-advanced" onSubmit={handleAuthSubmit}>
          <div className="auth-head">
            <div className="brand auth-brand">
              <div className="brand-mark">
                <Image size={22} aria-hidden="true" />
              </div>
              <div>
                <strong>PicHarbor</strong>
                <span>套图下载与图片库</span>
              </div>
            </div>
            <button
              className="ghost-button icon-only"
              type="button"
              aria-label={themeMode === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
              onClick={() => setThemeMode((current) => (current === 'dark' ? 'light' : 'dark'))}
            >
              {themeMode === 'dark' ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
            </button>
          </div>

          <div>
            <span className="eyebrow">访问控制</span>
            <h1>{authStatus ? title : '正在检查登录状态'}</h1>
          </div>
          <div className="auth-status-row" aria-label="登录环境">
            <span className="auth-status-chip">{authStatus?.initialized ? '管理员已创建' : '首次初始化'}</span>
            <span className="auth-status-chip">{themeMode === 'dark' ? '深色模式' : '浅色模式'}</span>
            <span className="auth-status-chip">{dataMode === 'api' ? 'API 已连接' : '演示数据'}</span>
          </div>
          <label className="field-stack">
            <span>用户名</span>
            <input
              autoComplete="username"
              disabled={!authStatus || isAuthBusy}
              onChange={(event) => setAuthUsername(event.target.value)}
              type="text"
              value={authUsername}
            />
          </label>
          <label className="field-stack">
            <span>密码</span>
            <input
              autoComplete={isInitializing ? 'new-password' : 'current-password'}
              disabled={!authStatus || isAuthBusy}
              onChange={(event) => setAuthPassword(event.target.value)}
              type="password"
              value={authPassword}
            />
          </label>
          <button className="primary-button" type="submit" disabled={!authStatus || isAuthBusy}>
            <LockKeyhole size={17} aria-hidden="true" />
            {isAuthBusy ? '处理中' : buttonText}
          </button>
          {authMessage && <span className="auth-message">{authMessage}</span>}
        </form>
      </main>
    )
  }

  if (!authStatus?.user) {
    return renderAuthView()
  }

  return (
    <div className="app-shell" data-theme={themeMode}>
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">
          <div className="brand-mark">
            <Image size={22} aria-hidden="true" />
          </div>
          <div>
            <strong>PicHarbor</strong>
            <span>套图下载与图片库</span>
          </div>
        </div>

        <nav className="main-nav">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                className={activeView === item.id ? 'active' : ''}
                key={item.id}
                onClick={() => setActiveView(item.id)}
                type="button"
              >
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>

        <section className="source-list" aria-labelledby="source-title">
          <div className="section-heading">
            <span id="source-title">支持源</span>
            <button type="button" aria-label="刷新站点状态" onClick={() => void refreshData()}>
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          </div>
          {sources.map((source) => (
            <button className="source-item source-item-button" key={source.id} type="button" onClick={() => setActiveView('sources')}>
              <span className="source-dot" style={{ backgroundColor: source.color }} />
              <div>
                <strong>{source.name}</strong>
                <small>{source.version}</small>
              </div>
              <em>{source.status}</em>
            </button>
          ))}
        </section>

        <section className="storage-panel" aria-label="存储状态">
          <div>
            <HardDrive size={18} aria-hidden="true" />
            <span>图库存储</span>
          </div>
          <strong>
            {stats.storageUsed} / {stats.storageTotal}
          </strong>
          <div className="meter">
            <span style={{ width: `${stats.storagePercent}%` }} />
          </div>
        </section>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="topbar-main">
            <div className="topbar-title-block">
              <span className="eyebrow">
                {viewTitles[activeView].eyebrow} · {dataMode === 'api' ? 'API 已连接' : '演示数据'}
              </span>
              <h1>{viewTitles[activeView].title}</h1>
            </div>
            <div className="topbar-summary" aria-label="当前工作区摘要">
              <article>
                <span>活动任务</span>
                <strong>{taskQueueSummary.activeTasks}</strong>
              </article>
              <article>
                <span>相册</span>
                <strong>{albums.length}</strong>
              </article>
              <article>
                <span>已配 Cookie</span>
                <strong>{configuredCookieCount}</strong>
              </article>
            </div>
          </div>
          <label className="search-box">
            <Search size={18} aria-hidden="true" />
            <input
              aria-label="搜索图片"
              onChange={(event) => {
                setQuery(event.target.value)
                setPhotoLimit(photoBatchSize)
              }}
              placeholder={searchPlaceholderByView[activeView]}
              type="search"
              value={query}
            />
          </label>
          <div className="top-actions">
            <span className="user-pill">{authStatus.user.username}</span>
            <button
              className="ghost-button icon-only"
              type="button"
              aria-label={themeMode === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
              onClick={() => setThemeMode((current) => (current === 'dark' ? 'light' : 'dark'))}
            >
              {themeMode === 'dark' ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
            </button>
            <button className="ghost-button icon-only" type="button" aria-label="刷新" onClick={() => void refreshData()}>
              <RefreshCw size={18} aria-hidden="true" />
            </button>
            <button className="ghost-button" type="button" onClick={() => void handleLogout()}>
              <LockKeyhole size={17} aria-hidden="true" />
              退出
            </button>
            <button className="primary-button" type="button" onClick={() => setActiveView('tasks')}>
              <Plus size={18} aria-hidden="true" />
              新建下载
            </button>
          </div>
        </header>

        {renderActiveView()}
      </main>

      {isTaskDetailOpen && selectedTask && (
        <div className="task-detail-overlay" role="presentation" onMouseDown={() => setIsTaskDetailOpen(false)}>
          <div role="presentation" onMouseDown={(event) => event.stopPropagation()}>
            {renderTaskDetail()}
          </div>
        </div>
      )}

      {isViewerOpen && selectedPhoto && (
        <div className="image-viewer" role="dialog" aria-modal="true" aria-label="图片查看" onWheel={handleViewerWheel}>
          <button className="close-button" type="button" onClick={() => setIsViewerOpen(false)}>
            <X size={22} aria-hidden="true" />
            <span>关闭</span>
          </button>
          <button className="slide-nav left" type="button" onClick={() => movePhoto(-1)} aria-label="上一张">
            <ChevronLeft size={28} aria-hidden="true" />
          </button>
          <figure
            className={[
              selectedPhotoIsVideo ? 'video-figure' : 'zoomable',
              !selectedPhotoIsVideo && isViewerZoomed ? 'is-zoomed' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onPointerDown={handleViewerPointerDown}
            onPointerMove={handleViewerPointerMove}
            onPointerUp={stopViewerDrag}
            onPointerCancel={(event) => stopViewerDrag(event, false)}
          >
            <div className="viewer-image-stage" ref={viewerStageRef}>
              {selectedPhotoIsVideo ? (
                renderVideoPlayer(selectedPhoto)
              ) : (
                <img
                  src={selectedPhoto.url}
                  alt={selectedPhoto.title}
                  draggable={false}
                  onLoad={(event) => {
                    setViewerImageSize({
                      height: event.currentTarget.naturalHeight,
                      width: event.currentTarget.naturalWidth,
                    })
                  }}
                  style={{
                    height: viewerDisplaySize.height || undefined,
                    transform: `translate(${viewerPan.x}px, ${viewerPan.y}px)`,
                    width: viewerDisplaySize.width || undefined,
                  }}
                />
              )}
            </div>
            <figcaption>
              <strong>{selectedPhoto.title}</strong>
              <span>
                {selectedIndex + 1} / {visiblePhotos.length} · {selectedPhoto.size} ·{' '}
                {selectedPhotoIsVideo ? '视频' : selectedPhoto.resolution}
              </span>
            </figcaption>
          </figure>
          <button className="slide-nav right" type="button" onClick={() => movePhoto(1)} aria-label="下一张">
            <ChevronRight size={28} aria-hidden="true" />
          </button>
          <button
            className="viewer-side-action"
            type="button"
            onClick={openSlideshow}
          >
            <Play size={18} aria-hidden="true" />
            幻灯片播放
          </button>
          {!selectedPhotoIsVideo && (
          <div className="viewer-zoom-tools" aria-label="图片缩放">
            <button type="button" onClick={() => changeViewerZoom(0.25)} aria-label="放大">
              <ZoomIn size={18} aria-hidden="true" />
            </button>
            <span>{Math.round(viewerZoom * 100)}%</span>
            <button type="button" onClick={() => changeViewerZoom(-0.25)} aria-label="缩小">
              <ZoomOut size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={resetViewerTransform}
              aria-label="重置缩放"
              disabled={!isViewerZoomed && viewerPan.x === 0 && viewerPan.y === 0}
            >
              <RotateCcw size={18} aria-hidden="true" />
            </button>
          </div>
          )}
        </div>
      )}

      {isSlideshowOpen && selectedPhoto && (
        <div className="slideshow" role="dialog" aria-modal="true" aria-label="幻灯片播放">
          <button className="close-button" type="button" onClick={() => setIsSlideshowOpen(false)}>
            <X size={22} aria-hidden="true" />
            <span>关闭</span>
          </button>
          <button className="slide-nav left" type="button" onClick={() => movePhoto(-1)} aria-label="上一张">
            <ChevronLeft size={28} aria-hidden="true" />
          </button>
          <figure className={selectedPhotoIsVideo ? 'video-figure' : undefined}>
            {selectedPhotoIsVideo ? (
              renderVideoPlayer(selectedPhoto)
            ) : (
              <img src={selectedPhoto.url} alt={selectedPhoto.title} />
            )}
            <figcaption>
              <strong>{selectedPhoto.title}</strong>
              <span>
                {selectedIndex + 1} / {visiblePhotos.length} · {selectedPhotoIsVideo ? '视频' : selectedPhoto.resolution}
              </span>
            </figcaption>
          </figure>
          <button className="slide-nav right" type="button" onClick={() => movePhoto(1)} aria-label="下一张">
            <ChevronRight size={28} aria-hidden="true" />
          </button>
          <button className="slide-play" type="button" onClick={() => setIsPlaying((value) => !value)}>
            {isPlaying ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
            {isPlaying ? '播放中' : '已暂停'}
            <label className="slide-interval" onClick={(event) => event.stopPropagation()}>
              <span>间隔</span>
              <input
                aria-label="轮播秒数"
                min="1"
                max="30"
                onChange={(event) => setSlideSeconds(Number(event.target.value) || 1)}
                type="number"
                value={slideSeconds}
              />
              <span>秒</span>
            </label>
          </button>
        </div>
      )}
    </div>
  )
}

export default App
