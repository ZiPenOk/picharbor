import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const acceptHeader = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
const acceptLanguageHeader = 'zh-CN,zh;q=0.9,en;q=0.8'
const defaultUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const siteName = '栖光集'
const siteId = 'qiguangji'
const domains = ['xrw-album.christin3.com']

// —— helpers ——

function configuredUserAgent() {
  return (
    process.env.PICHARBOR_QIGUANGJI_USER_AGENT?.trim() ||
    process.env.PICHARBOR_XCHINA_USER_AGENT?.trim() ||
    defaultUserAgent
  )
}

function cookieFileForSite() {
  if (process.env.PICHARBOR_QIGUANGJI_COOKIE_FILE?.trim()) {
    return process.env.PICHARBOR_QIGUANGJI_COOKIE_FILE.trim()
  }
  if (process.env.PICHARBOR_SITE_COOKIE_ROOT?.trim()) {
    const fromRoot = join(process.env.PICHARBOR_SITE_COOKIE_ROOT.trim(), 'qiguangji.txt')
    if (existsSync(fromRoot)) return fromRoot
  }
  return ''
}

function domainMatches(cookieDomain, hostname) {
  const nd = cookieDomain.replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase()
  return hostname === nd || hostname.endsWith(`.${nd}`)
}

function cookieHeaderFromNetscapeFile(filePath, pageUrl) {
  const hostname = new URL(pageUrl).hostname.toLowerCase()
  const nowSeconds = Math.floor(Date.now() / 1000)
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  const cookies = []

  for (const line of lines) {
    if (!line.trim() || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    const [rawDomain, , , , expires, name, value] = parts
    if (!domainMatches(rawDomain, hostname)) continue
    const expiresAt = Number(expires)
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < nowSeconds) continue
    cookies.push(`${name}=${value}`)
  }

  return cookies.join('; ')
}

function cookieHeaderForPage(pageUrl) {
  const cf = cookieFileForSite()
  if (cf && existsSync(cf)) {
    const cookie = cookieHeaderFromNetscapeFile(cf, pageUrl)
    if (cookie) return cookie
  }
  return process.env.PICHARBOR_QIGUANGJI_COOKIE ?? ''
}

function browserHeaders(pageUrl) {
  const headers = {
    Accept: acceptHeader,
    'Accept-Language': acceptLanguageHeader,
    'User-Agent': configuredUserAgent(),
  }
  const cookie = cookieHeaderForPage(pageUrl)
  if (cookie) headers.Cookie = cookie
  return headers
}

// —— fetch ——

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      ...browserHeaders(url),
      Accept: 'application/json',
    },
    redirect: 'follow',
  })

  const remixRedirect = response.headers.get('x-remix-redirect')
  if (response.status === 204 || remixRedirect) {
    throw new Error(`${siteName} 没有返回相册数据，已被重定向到验证页。请先在浏览器完成 Turnstile 验证，并在设置里保存该站点的有效 cookie。`)
  }

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(`${siteName} 请求失败：403。该站需要先通过 Turnstile 验证并配置有效 cookie。`)
    }
    throw new Error(`${siteName} 请求失败：${response.status} ${response.statusText}`)
  }

  const text = await response.text()
  if (!text.trim()) {
    throw new Error(`${siteName} 返回了空数据。请确认该站点 cookie 已通过验证且未过期。`)
  }

  const data = JSON.parse(text)

  // Check for gate page redirect (SSR can still return gate even with 200)
  if (data && typeof data === 'object' && data.isVerified === false) {
    throw new Error(`${siteName} 未通过验证。请在浏览器中完成 Turnstile 验证后导出 cookie 文件，并在站点设置中配置。`)
  }

  return data
}

// —— Remix loader data ——

function remixRouteIdForPage(pageUrl) {
  const pathname = new URL(pageUrl).pathname
  if (pathname.startsWith('/telegraph-album/')) return 'routes/telegraph-album.$id'
  if (pathname.startsWith('/album/')) return 'routes/album.$id'
  return ''
}

function remixDataUrl(pageUrl) {
  const routeId = remixRouteIdForPage(pageUrl)
  if (!routeId) throw new Error(`${siteName} 不支持该链接格式`)
  const separator = pageUrl.includes('?') ? '&' : '?'
  return `${pageUrl}${separator}_data=${encodeURIComponent(routeId)}`
}

function extractAlbumAndPhotos(loaderData) {
  if (loaderData?.album && Array.isArray(loaderData.photos)) {
    return { album: loaderData.album, photos: loaderData.photos }
  }

  if (loaderData?.data?.album && Array.isArray(loaderData.data.photos)) {
    return { album: loaderData.data.album, photos: loaderData.data.photos }
  }

  if (loaderData?.isVerified === false) {
    throw new Error(`${siteName} 未通过验证。请在浏览器中完成 Turnstile 验证后导出 cookie 文件，并在站点设置中配置。`)
  }

  throw new Error(`${siteName} 相册数据结构不符合预期`)
}

function collectImagesFromPhotos(album, photos) {
  if (!Array.isArray(photos) || !photos.length) {
    throw new Error(`${siteName} 相册数据中没有找到图片`)
  }

  return photos.map((photo, index) => {
    const url = photo.url || photo.src || photo.original || photo.imageUrl || ''
    if (!url) {
      throw new Error(`${siteName} 第 ${index + 1} 张图片缺少 url 字段`)
    }

    return {
      downloadUrl: url,
      id: `${siteId}-${album.slug || album.id || 'unknown'}-${String(index + 1).padStart(4, '0')}`,
      referer: null,
      title: `${album.title || siteName} ${String(index + 1).padStart(3, '0')}`,
      url,
      resolution: photo.resolution || photo.dimensions || '待识别',
      size: photo.size || photo.fileSize || '待统计',
      tags: [siteName],
    }
  })
}

function slugFromUrl(inputUrl) {
  const url = new URL(inputUrl)
  const parts = url.pathname.split('/').filter(Boolean)
  return (parts.at(-1) || url.hostname).replace(/\.html$/i, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
}

// —— adapter ——

export const qiguangjiAdapter = {
  id: siteId,
  name: siteName,
  status: '试解析',
  version: 'rules-0.1',
  color: '#c7a55b',
  domains,
  capabilities: ['套图解析', 'Remix SPA 支持', 'Turnstile cookie 访问'],

  match(inputUrl) {
    const url = new URL(inputUrl)
    return this.domains.includes(url.hostname) && /^\/(?:telegraph-album|album)\/[^/]+$/i.test(url.pathname)
  },

  async parse(inputUrl) {
    // Try fetching the Remix loader data endpoint
    const dataUrl = remixDataUrl(inputUrl)
    let albumData

    try {
      albumData = await fetchJson(dataUrl)
    } catch (firstError) {
      // Fallback: try fetching the HTML page and extract __remixContext
      const response = await fetch(inputUrl, {
        headers: browserHeaders(inputUrl),
        redirect: 'follow',
      })
      if (!response.ok) {
        throw new Error(`${siteName} 页面请求失败：${response.status}`)
      }

      const html = await response.text()

      if (html.includes('isVerified') && html.includes('false')) {
        throw new Error(`${siteName} 需要完成 Turnstile 验证。请在浏览器中验证后导出 cookie 文件，或在设置里粘贴该站点 cookie。`)
      }

      // Try to extract Remix context from the HTML
      const remixMatch = html.match(/window\.__remixContext\s*=\s*({.+?});/)
      if (!remixMatch) {
        throw new Error(`${siteName} 无法解析页面数据`)
      }

      try {
        const ctx = JSON.parse(remixMatch[1])
        const routeId = remixRouteIdForPage(inputUrl)
        const loaderData = ctx.state?.loaderData || {}
        albumData = loaderData[routeId] || Object.entries(loaderData).find(([key]) => key.includes('album'))?.[1]
        if (!albumData) throw new Error('找不到相册 loader 数据')
      } catch {
        throw firstError
      }
    }

    if (!albumData) {
      throw new Error(`${siteName} 无法获取相册数据`)
    }

    const { album, photos } = extractAlbumAndPhotos(albumData)
    const slug = slugFromUrl(inputUrl)
    const title = album.title || album.name || `${siteName} 套图`
    const images = collectImagesFromPhotos(album, photos)

    if (!images.length) {
      throw new Error(`${siteName} 页面中没有解析到图片`)
    }

    return {
      id: `${siteId}-${slug}`,
      title,
      source: this.name,
      sourceUrl: inputUrl,
      folder: `${siteName}/${slug}`,
      cover: images[0].url,
      tags: [siteName, '待整理'],
      images,
    }
  },
}
