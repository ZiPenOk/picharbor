import { mockAppData } from '../data/mockData'
import type {
  AppData,
  AppSettings,
  AuthInput,
  AuthStatus,
  CreateTasksResult,
  CreateTaskInput,
  DownloadTask,
  SaveSettingsInput,
  TaskUrlInspection,
  UpdateAuthInput,
} from '../types'

const headers = {
  'Content-Type': 'application/json',
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
  })

  if (!response.ok) {
    let detail = `API ${path} failed with ${response.status}`

    try {
      const payload = (await response.json()) as { error?: string }
      if (payload.error) {
        detail = payload.error
      }
    } catch {
      // Keep the generic HTTP error if the response body is not JSON.
    }

    throw new Error(detail)
  }

  return response.json() as Promise<T>
}

export async function loadAuthStatus(): Promise<AuthStatus> {
  return requestJson<AuthStatus>('/api/auth/status')
}

export async function setupAuth(input: AuthInput): Promise<AuthStatus> {
  const result = await requestJson<{ user: AuthStatus['user'] }>('/api/auth/setup', {
    body: JSON.stringify(input),
    headers,
    method: 'POST',
  })
  return { initialized: true, user: result.user }
}

export async function loginAuth(input: AuthInput): Promise<AuthStatus> {
  const result = await requestJson<{ user: AuthStatus['user'] }>('/api/auth/login', {
    body: JSON.stringify(input),
    headers,
    method: 'POST',
  })
  return { initialized: true, user: result.user }
}

export async function logoutAuth(): Promise<void> {
  await requestJson<{ ok: boolean }>('/api/auth/logout', {
    headers,
    method: 'POST',
  })
}

export async function updateAuth(input: UpdateAuthInput): Promise<AuthStatus> {
  const result = await requestJson<{ user: AuthStatus['user'] }>('/api/auth/update', {
    body: JSON.stringify(input),
    headers,
    method: 'POST',
  })
  return { initialized: true, user: result.user }
}

export async function loadAppData(): Promise<{ data: AppData; mode: 'api' | 'mock' }> {
  try {
    const data = await requestJson<AppData>('/api/app-data')
    return { data, mode: 'api' }
  } catch (error) {
    console.warn('Using mock app data because the API is unavailable.', error)
    return { data: mockAppData, mode: 'mock' }
  }
}

export async function createTask(input: CreateTaskInput): Promise<DownloadTask> {
  return requestJson<DownloadTask>('/api/tasks', {
    body: JSON.stringify(input),
    headers,
    method: 'POST',
  })
}

export async function createTasks(urls: string[]): Promise<CreateTasksResult> {
  return requestJson<CreateTasksResult>('/api/tasks/batch', {
    body: JSON.stringify({ urls }),
    headers,
    method: 'POST',
  })
}

export async function inspectTaskUrls(urls: string[]): Promise<TaskUrlInspection[]> {
  const result = await requestJson<{ items: TaskUrlInspection[] }>('/api/tasks/inspect', {
    body: JSON.stringify({ urls }),
    headers,
    method: 'POST',
  })

  return result.items
}

export async function loadTask(taskId: number): Promise<DownloadTask> {
  return requestJson<DownloadTask>(`/api/tasks/${taskId}`)
}

export async function pauseTask(taskId: number): Promise<DownloadTask> {
  return requestJson<DownloadTask>(`/api/tasks/${taskId}/pause`, {
    headers,
    method: 'POST',
  })
}

export async function resumeTask(taskId: number): Promise<DownloadTask> {
  return requestJson<DownloadTask>(`/api/tasks/${taskId}/resume`, {
    headers,
    method: 'POST',
  })
}

export async function retryTask(taskId: number): Promise<DownloadTask> {
  return requestJson<DownloadTask>(`/api/tasks/${taskId}/retry`, {
    headers,
    method: 'POST',
  })
}

export async function loadSettings(): Promise<AppSettings> {
  return requestJson<AppSettings>('/api/settings')
}

export async function saveSettings(input: SaveSettingsInput): Promise<AppSettings> {
  return requestJson<AppSettings>('/api/settings', {
    body: JSON.stringify(input),
    headers,
    method: 'POST',
  })
}
