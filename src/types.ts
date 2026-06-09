export type TaskStatus = 'downloading' | 'queued' | 'paused' | 'done' | 'partial' | 'error'

export type DownloadTask = {
  id: number
  albumId?: string
  title: string
  site: string
  status: TaskStatus
  progress: number
  speed: string
  eta: string
  images: number
  imageCount?: number
  mediaSummary?: string
  videoCount?: number
  completedImages?: number
  successImages?: number
  failedCount?: number
  remainingImages?: number
  currentImage?: string
  pauseRequested?: boolean
  folder: string
  sourceUrl?: string
  createdAt?: string
  failedImages?: Array<{
    error: string
    id: string
    sequence: string
    title: string
    url: string
  }>
}

export type Album = {
  id: string
  title: string
  source: string
  count: number
  imageCount?: number
  mediaSummary?: string
  videoCount?: number
  size: string
  updated: string
  status: string
  cover: string
  thumbUrl?: string
  tags: string[]
}

export type Photo = {
  id: string
  albumId: string
  title: string
  mediaType?: 'image' | 'video'
  posterUrl?: string
  thumbUrl?: string
  url: string
  resolution: string
  size: string
  tags: string[]
}

export type Source = {
  id: string
  name: string
  status: string
  version: string
  color: string
  domains: string[]
  capabilities: string[]
}

export type DashboardStats = {
  totalImages: number
  activeTasks: number
  archivedAlbums: number
  integrityScore: string
  storageUsed: string
  storageTotal: string
  storagePercent: number
}

export type AppData = {
  sources: Source[]
  tasks: DownloadTask[]
  albums: Album[]
  photos: Photo[]
  stats: DashboardStats
}

export type CreateTaskInput = {
  url: string
  adapterId?: string
}

export type TaskCreateFailure = {
  error: string
  url: string
}

export type CreateTasksResult = {
  items: DownloadTask[]
  failures: TaskCreateFailure[]
}

export type TaskUrlInspection = {
  url: string
  normalizedUrl?: string
  valid: boolean
  matched: boolean
  hostname?: string
  adapterId?: string
  adapterName?: string
  adapterVersion?: string
  cookieConfigured?: boolean
  cookieSource?: 'header' | 'netscape' | 'none'
  flareSolverrConfigured?: boolean
  capabilities?: string[]
  domains?: string[]
  message: string
}

export type AppSettings = {
  paths: {
    configRoot: string
    flareSolverrConfigFile: string
    mediaRoot: string
    proxyConfigFile: string
    siteCookieRoot: string
    thumbRoot: string
    xchinaCookieFile: string
    xchinaUserAgentFile: string
  }
  flareSolverrUrl: string
  proxy: string
  sites: Record<
    string,
    {
      cookieConfigured: boolean
      cookieFile: string
      cookiePreview: string
      cookieSource: 'header' | 'netscape' | 'none'
      domains: string[]
      name: string
    }
  >
}

export type SiteSettingsInput = {
  cookie?: string
}

export type SaveSettingsInput = {
  flareSolverrUrl?: string
  proxy?: string
  sites?: {
    [siteId: string]: SiteSettingsInput | undefined
  }
}

export type AuthUser = {
  username: string
}

export type AuthStatus = {
  initialized: boolean
  user: AuthUser | null
}

export type AuthInput = {
  password: string
  username: string
}

export type UpdateAuthInput = {
  currentPassword: string
  password?: string
  username: string
}
