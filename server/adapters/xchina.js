import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { load } from 'cheerio'

const execFileAsync = promisify(execFile)
const acceptHeader = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
const acceptLanguageHeader = 'zh-CN,zh;q=0.9,en;q=0.8'
const defaultUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function configuredUserAgent() {
  const userAgent = process.env.PICHARBOR_XCHINA_USER_AGENT?.trim()
  if (userAgent) {
    return userAgent
  }

  const userAgentFile = process.env.PICHARBOR_XCHINA_USER_AGENT_FILE?.trim()
  if (userAgentFile && existsSync(userAgentFile)) {
    const savedUserAgent = readFileSync(userAgentFile, 'utf8').trim()
    if (savedUserAgent) {
      return savedUserAgent
    }
  }

  return defaultUserAgent
}

function domainMatches(cookieDomain, hostname) {
  const normalizedDomain = cookieDomain.replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase()
  return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)
}

function cookieHeaderFromNetscapeFile(filePath, pageUrl) {
  const hostname = new URL(pageUrl).hostname.toLowerCase()
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

function netscapeCookiesForUrl(filePath, pageUrl) {
  const hostname = new URL(pageUrl).hostname.toLowerCase()
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

    const [rawDomain, , rawPath, secure, expires, name, value] = parts
    if (!domainMatches(rawDomain, hostname)) {
      continue
    }

    const expiresAt = Number(expires)
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < nowSeconds) {
      continue
    }

    cookies.push({
      domain: rawDomain.replace(/^#HttpOnly_/, ''),
      expiry: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined,
      httpOnly: rawDomain.startsWith('#HttpOnly_'),
      name,
      path: rawPath || '/',
      secure: secure.toUpperCase() === 'TRUE',
      value,
    })
  }

  return cookies
}

function cookieHeaderToFlareSolverrCookies(cookieHeader, pageUrl) {
  const hostname = new URL(pageUrl).hostname
  return cookieHeader
    .split(';')
    .map((cookie) => cookie.trim())
    .filter(Boolean)
    .map((cookie) => {
      const separatorIndex = cookie.indexOf('=')
      if (separatorIndex === -1) {
        return null
      }

      return {
        domain: hostname,
        name: cookie.slice(0, separatorIndex).trim(),
        path: '/',
        value: cookie.slice(separatorIndex + 1).trim(),
      }
    })
    .filter(Boolean)
}

function cookieHeaderForPage(pageUrl) {
  if (
    process.env.PICHARBOR_XCHINA_COOKIE_FILE &&
    existsSync(process.env.PICHARBOR_XCHINA_COOKIE_FILE)
  ) {
    const cookie = cookieHeaderFromNetscapeFile(process.env.PICHARBOR_XCHINA_COOKIE_FILE, pageUrl)
    if (cookie) {
      return cookie
    }
  }

  return process.env.PICHARBOR_XCHINA_COOKIE ?? ''
}

function flareSolverrCookiesForPage(pageUrl) {
  if (
    process.env.PICHARBOR_XCHINA_COOKIE_FILE &&
    existsSync(process.env.PICHARBOR_XCHINA_COOKIE_FILE)
  ) {
    const cookies = netscapeCookiesForUrl(process.env.PICHARBOR_XCHINA_COOKIE_FILE, pageUrl)
    if (cookies.length) {
      return cookies
    }
  }

  if (process.env.PICHARBOR_XCHINA_COOKIE) {
    return cookieHeaderToFlareSolverrCookies(process.env.PICHARBOR_XCHINA_COOKIE, pageUrl)
  }

  return []
}

function cookieToNetscapeLine(cookie, pageUrl) {
  const hostname = new URL(pageUrl).hostname
  const domain = cookie.domain || hostname
  const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE'
  const path = cookie.path || '/'
  const secure = cookie.secure ? 'TRUE' : 'FALSE'
  const expires = Number(cookie.expiry ?? cookie.expires ?? 0)
  return [domain, includeSubdomains, path, secure, Number.isFinite(expires) ? expires : 0, cookie.name, cookie.value].join('\t')
}

function mergeFlareSolverrCookies(cookies, pageUrl) {
  const cookieFile = process.env.PICHARBOR_XCHINA_COOKIE_FILE
  if (!cookieFile || !Array.isArray(cookies) || !cookies.length) {
    return
  }

  const relevantCookies = cookies.filter((cookie) => cookie?.name && typeof cookie.value === 'string')
  if (!relevantCookies.length) {
    return
  }

  const existingLines = existsSync(cookieFile) ? readFileSync(cookieFile, 'utf8').split(/\r?\n/) : []
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
    const line = cookieToNetscapeLine(cookie, pageUrl)
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

  mkdirSync(dirname(cookieFile), { recursive: true })
  writeFileSync(cookieFile, `${['# Netscape HTTP Cookie File', ...nextLines.filter((line) => !line.startsWith('# Netscape'))].join('\n')}\n`, 'utf8')
}

function getBrowserHeaders() {
  const headers = {
    Accept: acceptHeader,
    'Accept-Language': acceptLanguageHeader,
    Referer: 'https://xchina.co/',
    'User-Agent': configuredUserAgent(),
  }

  if (process.env.PICHARBOR_XCHINA_COOKIE) {
    headers.Cookie = process.env.PICHARBOR_XCHINA_COOKIE
  }

  return headers
}

function configuredProxy() {
  const proxy = process.env.PICHARBOR_PROXY?.trim()
  if (proxy) {
    return proxy
  }

  const proxyFile = process.env.PICHARBOR_PROXY_FILE?.trim()
  if (proxyFile && existsSync(proxyFile)) {
    return readFileSync(proxyFile, 'utf8').trim()
  }

  return ''
}

function configuredFlareSolverr() {
  const flareSolverrUrl = process.env.PICHARBOR_FLARESOLVERR_URL?.trim()
  if (flareSolverrUrl) {
    return flareSolverrUrl.replace(/\/+$/, '')
  }

  const flareSolverrFile = process.env.PICHARBOR_FLARESOLVERR_FILE?.trim()
  if (flareSolverrFile && existsSync(flareSolverrFile)) {
    const savedUrl = readFileSync(flareSolverrFile, 'utf8').trim()
    if (savedUrl) {
      return savedUrl.replace(/\/+$/, '')
    }
  }

  return ''
}

async function fetchHtmlWithFlareSolverr(pageUrl) {
  const flareSolverrUrl = configuredFlareSolverr()
  if (!flareSolverrUrl) {
    return null
  }

  const cookies = flareSolverrCookiesForPage(pageUrl)
  const payload = {
    cmd: 'request.get',
    maxTimeout: 90000,
    url: pageUrl,
    ...(cookies.length ? { cookies } : {}),
  }

  const response = await fetch(`${flareSolverrUrl}/v1`, {
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(`FlareSolverr 请求失败：${response.status} ${response.statusText}`)
  }

  const result = await response.json()
  if (result.status !== 'ok') {
    throw new Error(`FlareSolverr 未通过 Cloudflare：${result.message ?? '未知错误'}`)
  }

  const solution = result.solution ?? {}
  const status = Number(solution.status ?? 0)
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new Error(`FlareSolverr 页面请求失败：${status || '未知状态'}`)
  }

  if (solution.userAgent && process.env.PICHARBOR_XCHINA_USER_AGENT_FILE) {
    mkdirSync(dirname(process.env.PICHARBOR_XCHINA_USER_AGENT_FILE), { recursive: true })
    writeFileSync(process.env.PICHARBOR_XCHINA_USER_AGENT_FILE, `${solution.userAgent}\n`, 'utf8')
  }

  mergeFlareSolverrCookies(solution.cookies, pageUrl)

  if (!solution.response || typeof solution.response !== 'string') {
    throw new Error('FlareSolverr 没有返回页面内容')
  }

  return solution.response
}

async function fetchHtmlWithCurl(pageUrl) {
  const cookieFile = process.env.PICHARBOR_XCHINA_COOKIE_FILE
  if (!cookieFile || !existsSync(cookieFile)) {
    return null
  }

  const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const marker = '\n__PICHARBOR_HTTP_STATUS__:'
  const proxy = configuredProxy()
  const args = [
    '-L',
    '-sS',
    '--compressed',
    '-b',
    cookieFile,
    '-A',
    configuredUserAgent(),
    '-H',
    `Accept: ${acceptHeader}`,
    '-H',
    `Accept-Language: ${acceptLanguageHeader}`,
    '-e',
    'https://xchina.co/',
    '-w',
    `${marker}%{http_code}`,
    pageUrl,
  ]
  if (proxy) {
    args.splice(3, 0, '-x', proxy)
  }

  const { stdout } = await execFileAsync(curlBin, args, {
    maxBuffer: 30 * 1024 * 1024,
    windowsHide: true,
  })
  const markerIndex = stdout.lastIndexOf(marker)
  if (markerIndex === -1) {
    throw new Error('xChina curl 请求没有返回 HTTP 状态')
  }

  const html = stdout.slice(0, markerIndex)
  const status = Number(stdout.slice(markerIndex + marker.length).trim())
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new Error(`xChina curl 请求失败：${status}`)
  }

  return html
}

function slugFromUrl(inputUrl) {
  const url = new URL(inputUrl)
  const filename = url.pathname.split('/').filter(Boolean).at(-1) ?? url.hostname
  return filename.replace(/\.html$/i, '').replace(/^id-/i, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
}

function originalImageUrlFromPreview(previewUrl) {
  const url = new URL(previewUrl)
  url.pathname = url.pathname.replace(/_(?:\d+)x(?:\d+)\.(?:avif|jpe?g|png|webp)$/i, '.jpg')
  return url.toString()
}

function extractScriptStringVariable(html, name) {
  const match = html.match(new RegExp(`(?:var|let|const)\\s+${name}\\s*=\\s*(['"])(.*?)\\1\\s*;`, 's'))
  return match?.[2] ?? ''
}

function extractScriptJsonArray(html, name) {
  const match = html.match(new RegExp(`(?:var|let|const)\\s+${name}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;`))
  if (!match) {
    return []
  }

  try {
    const parsed = JSON.parse(match[1])
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function collectVideosFromScripts(html, pageUrl) {
  const domain = extractScriptStringVariable(html, 'domain') || new URL(pageUrl).origin
  const videos = extractScriptJsonArray(html, 'videos')
  const seen = new Set()
  const collected = []

  for (const video of videos) {
    const rawUrl = typeof video === 'string' ? video : video?.url
    if (!rawUrl) {
      continue
    }

    const url = new URL(rawUrl, domain).toString()
    if (seen.has(url)) {
      continue
    }

    seen.add(url)
    collected.push({
      filename: typeof video?.filename === 'string' ? video.filename : url.split('/').pop() ?? 'video.mp4',
      filesize: typeof video?.filesize === 'string' ? video.filesize : '待统计',
      url,
    })
  }

  return collected
}

function normalizeImageUrl(value, pageUrl) {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '')
  if (!trimmed || trimmed.startsWith('data:')) {
    return null
  }

  return new URL(trimmed, pageUrl).toString()
}

function extractBackgroundUrl(style, pageUrl) {
  const match = style.match(/url\(([^)]+)\)/i)
  return match ? normalizeImageUrl(match[1], pageUrl) : null
}

function collectImageUrlsInDomOrder($, pageUrl) {
  const urls = []
  const seen = new Set()
  const contentSelectors = [
    '.photo-items .img',
    '.photo-items img',
    '.item.photo-image .img',
    '.item.photo-image img',
    '.photo-image .img',
    '.photo-image img',
    '.photo-content .img',
    '.photo-content img',
    '.photos .img',
    '.photos img',
  ]

  const contentNodes = $(contentSelectors.join(', '))
  const nodes = contentNodes.length
    ? contentNodes
    : $('body').find('img, [data-src], [data-original], [style*="url("]')

  nodes.each((_, element) => {
      const node = $(element)
      const candidates = [
        node.attr('data-original'),
        node.attr('data-src'),
        node.attr('data-lazy-src'),
        node.attr('src'),
        node.attr('href'),
      ]

      const style = node.attr('style')
      if (style) {
        candidates.push(extractBackgroundUrl(style, pageUrl))
      }

      for (const candidate of candidates) {
        if (!candidate) {
          continue
        }

        const normalized = normalizeImageUrl(candidate, pageUrl)
        if (!normalized || seen.has(normalized)) {
          continue
        }

        if (!/\.(avif|gif|jpe?g|png|webp)(\?|#|$)/i.test(normalized)) {
          continue
        }

        seen.add(normalized)
        urls.push(normalized)
        break
      }
    })

  return urls
}

function extractTitle($) {
  const candidates = [
    $('meta[property="og:title"]').attr('content'),
    $('h1').first().text(),
    $('.title').first().text(),
    $('title').first().text(),
  ]

  return candidates.map((value) => value?.trim()).find(Boolean)?.replace(/\s+/g, ' ') ?? 'xChina 套图'
}

function getPageUrl(inputUrl, pageNumber) {
  const url = new URL(inputUrl)
  if (pageNumber <= 1) {
    return url.toString()
  }

  url.pathname = url.pathname.replace(/\.html$/i, `/${pageNumber}.html`)
  return url.toString()
}

function discoverPageCount($, inputUrl) {
  const numbers = []
  const baseUrl = new URL(inputUrl)
  const idMatch = baseUrl.pathname.match(/\/photo\/(id-[^/.]+)/i)
  const idSegment = idMatch?.[1]

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href')
    const text = $(element).text().trim()
    if (!href || !idSegment) {
      return
    }

    const link = new URL(href, inputUrl)
    const pageMatch = link.pathname.match(new RegExp(`/photo/${idSegment}/(\\d+)\\.html$`, 'i'))
    if (pageMatch) {
      numbers.push(Number(pageMatch[1]))
      return
    }

    if (link.pathname === baseUrl.pathname && /^\d+$/.test(text)) {
      numbers.push(Number(text))
    }
  })

  return Math.max(1, ...numbers.filter((value) => Number.isSafeInteger(value) && value < 200))
}

async function fetchHtml(pageUrl) {
  const headers = getBrowserHeaders()
  const proxy = configuredProxy()
  let fetchStatus = ''

  if (!headers.Cookie) {
    const cookie = cookieHeaderForPage(pageUrl)
    if (cookie) {
      headers.Cookie = cookie
    }
  }

  try {
    const solvedHtml = await fetchHtmlWithFlareSolverr(pageUrl)
    if (solvedHtml) {
      return solvedHtml
    }

    if (!proxy) {
      const response = await fetch(pageUrl, { headers, redirect: 'follow' })
      if (response.ok) {
        return response.text()
      }
      fetchStatus = `${response.status} ${response.statusText}`
    }

    const fallbackHtml = await fetchHtmlWithCurl(pageUrl)
    if (fallbackHtml) {
      return fallbackHtml
    }

    throw new Error(`xChina 页面请求失败：${fetchStatus || 'curl/proxy 未通过'}。如果浏览器能打开该页，请后续在站点设置里提供 Cookie/Headers。`)
  } catch (error) {
    const fallbackHtml = await fetchHtmlWithCurl(pageUrl)
    if (fallbackHtml) {
      return fallbackHtml
    }

    if (error instanceof Error) {
      throw error
    }

    throw new Error('xChina 页面请求失败')
  }
}

export const xchinaAdapter = {
  id: 'xchina',
  name: 'xChina',
  status: '试解析',
  version: 'rules-0.2',
  color: '#7b4ab8',
  domains: ['xchina.co', 'www.xchina.co'],
  capabilities: ['套图解析', '分页采集', '视频采集', 'DOM 顺序保持'],
  match(inputUrl) {
    const url = new URL(inputUrl)
    return this.domains.includes(url.hostname) && /^\/photo\/id-[^/]+\.html$/i.test(url.pathname)
  },
  async parse(inputUrl) {
    const firstHtml = await fetchHtml(inputUrl)
    const firstPage = load(firstHtml)
    const title = extractTitle(firstPage)
    const pageCount = discoverPageCount(firstPage, inputUrl)
    const orderedUrls = []
    const seen = new Set()

    const appendPageImages = (html, pageUrl) => {
      const $ = load(html)
      const pageUrls = collectImageUrlsInDomOrder($, pageUrl)
      for (const imageUrl of pageUrls) {
        if (!seen.has(imageUrl)) {
          seen.add(imageUrl)
          orderedUrls.push(imageUrl)
        }
      }
    }

    appendPageImages(firstHtml, inputUrl)

    for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
      const pageUrl = getPageUrl(inputUrl, pageNumber)
      const html = await fetchHtml(pageUrl)
      appendPageImages(html, pageUrl)
    }

    if (!orderedUrls.length) {
      throw new Error('xChina 页面中没有解析到图片')
    }

    const slug = slugFromUrl(inputUrl)
    const coverUrl = orderedUrls[0] ?? ''
    const images = orderedUrls.map((url, index) => ({
      downloadUrl: originalImageUrlFromPreview(url),
      id: `xchina-${slug}-${String(index + 1).padStart(4, '0')}`,
      title: `${title} ${String(index + 1).padStart(3, '0')}`,
      mediaType: 'image',
      url,
      resolution: '待识别',
      size: '待统计',
      tags: ['xChina'],
    }))
    const videos = collectVideosFromScripts(firstHtml, inputUrl).map((video, index) => ({
      downloadUrl: video.url,
      id: `xchina-${slug}-video-${String(index + 1).padStart(3, '0')}`,
      mediaType: 'video',
      posterUrl: coverUrl || undefined,
      resolution: '视频',
      size: video.filesize,
      tags: ['xChina', '视频'],
      title: `${title} 视频 ${String(index + 1).padStart(2, '0')}`,
      url: coverUrl || video.url,
    }))
    const mediaItems = [...videos, ...images]

    return {
      id: `xchina-${slug}`,
      title,
      source: this.name,
      sourceUrl: inputUrl,
      folder: `套图/xChina/${slug}`,
      cover: coverUrl || videos[0]?.url,
      tags: ['xChina', '待整理'],
      images: mediaItems,
    }
  },
}
