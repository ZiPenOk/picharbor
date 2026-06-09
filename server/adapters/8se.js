import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { load } from 'cheerio'

const execFileAsync = promisify(execFile)
const acceptHeader = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
const acceptLanguageHeader = 'zh-CN,zh;q=0.9,en;q=0.8'
const defaultUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// —— cookie / proxy / UA helpers ——

function configuredUserAgent() {
  return (
    process.env.PICHARBOR_8SE_USER_AGENT?.trim() ||
    process.env.PICHARBOR_XCHINA_USER_AGENT?.trim() ||
    defaultUserAgent
  )
}

function configuredProxy() {
  const proxy = process.env.PICHARBOR_PROXY?.trim()
  if (proxy) return proxy
  const proxyFile = process.env.PICHARBOR_PROXY_FILE?.trim()
  if (proxyFile && existsSync(proxyFile)) return readFileSync(proxyFile, 'utf8').trim()
  return ''
}

function cookieFileForSite() {
  if (process.env.PICHARBOR_8SE_COOKIE_FILE?.trim()) {
    return process.env.PICHARBOR_8SE_COOKIE_FILE.trim()
  }
  if (process.env.PICHARBOR_SITE_COOKIE_ROOT?.trim()) {
    return join(process.env.PICHARBOR_SITE_COOKIE_ROOT.trim(), '8se.txt')
  }
  // 回退到 xChina 的 cookie（同一账号体系）
  if (process.env.PICHARBOR_XCHINA_COOKIE_FILE?.trim()) {
    return process.env.PICHARBOR_XCHINA_COOKIE_FILE.trim()
  }
  return ''
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
  return process.env.PICHARBOR_8SE_COOKIE ?? process.env.PICHARBOR_XCHINA_COOKIE ?? ''
}

function browserHeaders(pageUrl) {
  const headers = {
    Accept: acceptHeader,
    'Accept-Language': acceptLanguageHeader,
    Referer: 'https://8se.me/',
    'User-Agent': configuredUserAgent(),
  }
  const cookie = cookieHeaderForPage(pageUrl)
  if (cookie) headers.Cookie = cookie
  return headers
}

// —— FlareSolverr (shared with xChina pattern) ——

function netscapeCookiesForUrl(filePath, pageUrl) {
  const hostname = new URL(pageUrl).hostname.toLowerCase()
  const nowSeconds = Math.floor(Date.now() / 1000)
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  const cookies = []

  for (const line of lines) {
    if (!line.trim() || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    const [rawDomain, , rawPath, secure, expires, name, value] = parts
    if (!domainMatches(rawDomain, hostname)) continue
    const expiresAt = Number(expires)
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < nowSeconds) continue
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
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const idx = c.indexOf('=')
      if (idx === -1) return null
      return { domain: hostname, name: c.slice(0, idx).trim(), path: '/', value: c.slice(idx + 1).trim() }
    })
    .filter(Boolean)
}

function flareSolverrCookiesForPage(pageUrl) {
  const cf = cookieFileForSite()
  if (cf && existsSync(cf)) {
    const cookies = netscapeCookiesForUrl(cf, pageUrl)
    if (cookies.length) return cookies
  }
  const raw = process.env.PICHARBOR_8SE_COOKIE ?? process.env.PICHARBOR_XCHINA_COOKIE
  if (raw) return cookieHeaderToFlareSolverrCookies(raw, pageUrl)
  return []
}

function cookieToNetscapeLine(cookie, pageUrl) {
  const hostname = new URL(pageUrl).hostname
  const domain = cookie.domain || hostname
  const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE'
  const path = cookie.path || '/'
  const secure = cookie.secure ? 'TRUE' : 'FALSE'
  const expires = Number(cookie.expiry ?? cookie.expires ?? 0)
  return [domain, includeSub, path, secure, Number.isFinite(expires) ? expires : 0, cookie.name, cookie.value].join('\t')
}

function mergeFlareSolverrCookies(cookies, pageUrl) {
  const cf = cookieFileForSite()
  if (!cf || !Array.isArray(cookies) || !cookies.length) return
  const relevant = cookies.filter((c) => c?.name && typeof c.value === 'string')
  if (!relevant.length) return
  const existingLines = existsSync(cf) ? readFileSync(cf, 'utf8').split(/\r?\n/) : []
  const nextLines = existingLines.filter((l) => l.trim())
  const seen = new Map()

  for (let i = 0; i < nextLines.length; i++) {
    const parts = nextLines[i].split('\t')
    if (parts.length >= 7) seen.set(`${parts[0]}\t${parts[2]}\t${parts[5]}`, i)
  }

  for (const cookie of relevant) {
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

  mkdirSync(dirname(cf), { recursive: true })
  writeFileSync(cf, `${['# Netscape HTTP Cookie File', ...nextLines.filter((l) => !l.startsWith('# Netscape'))].join('\n')}\n`, 'utf8')
}

function configuredFlareSolverr() {
  const url = process.env.PICHARBOR_FLARESOLVERR_URL?.trim()
  if (url) return url.replace(/\/+$/, '')
  const file = process.env.PICHARBOR_FLARESOLVERR_FILE?.trim()
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim().replace(/\/+$/, '')
  return ''
}

async function fetchHtmlWithFlareSolverr(pageUrl) {
  const fsUrl = configuredFlareSolverr()
  if (!fsUrl) return null

  const cookies = flareSolverrCookiesForPage(pageUrl)
  const payload = { cmd: 'request.get', maxTimeout: 90000, url: pageUrl }
  if (cookies.length) payload.cookies = cookies

  const response = await fetch(`${fsUrl}/v1`, {
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) throw new Error(`FlareSolverr 请求失败：${response.status} ${response.statusText}`)
  const result = await response.json()
  if (result.status !== 'ok') throw new Error(`FlareSolverr 未通过 Cloudflare：${result.message ?? '未知错误'}`)

  const solution = result.solution ?? {}
  const status = Number(solution.status ?? 0)
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new Error(`FlareSolverr 页面请求失败：${status || '未知状态'}`)
  }

  if (solution.userAgent && process.env.PICHARBOR_8SE_USER_AGENT_FILE) {
    mkdirSync(dirname(process.env.PICHARBOR_8SE_USER_AGENT_FILE), { recursive: true })
    writeFileSync(process.env.PICHARBOR_8SE_USER_AGENT_FILE, `${solution.userAgent}\n`, 'utf8')
  }
  mergeFlareSolverrCookies(solution.cookies, pageUrl)

  if (!solution.response || typeof solution.response !== 'string') {
    throw new Error('FlareSolverr 没有返回页面内容')
  }
  return solution.response
}

async function fetchHtmlWithCurl(pageUrl) {
  const cf = cookieFileForSite()
  if (!cf || !existsSync(cf)) return null

  const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const marker = '\n__PICHARBOR_HTTP_STATUS__:'
  const proxy = configuredProxy()
  const args = [
    '-L', '-sS', '--compressed',
    '-b', cf,
    '-A', configuredUserAgent(),
    '-H', `Accept: ${acceptHeader}`,
    '-H', `Accept-Language: ${acceptLanguageHeader}`,
    '-e', 'https://8se.me/',
    '-w', `${marker}%{http_code}`,
    pageUrl,
  ]
  if (proxy) args.splice(3, 0, '-x', proxy)

  const { stdout } = await execFileAsync(curlBin, args, {
    maxBuffer: 30 * 1024 * 1024,
    windowsHide: true,
  })

  const markerIndex = stdout.lastIndexOf(marker)
  if (markerIndex === -1) throw new Error('8色 curl 请求没有返回 HTTP 状态')
  const html = stdout.slice(0, markerIndex)
  const status = Number(stdout.slice(markerIndex + marker.length).trim())
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new Error(`8色 curl 请求失败：${status}`)
  }
  return html
}

// —— page fetching ——

async function fetchHtml(pageUrl) {
  try {
    const solved = await fetchHtmlWithFlareSolverr(pageUrl)
    if (solved) return solved
  } catch (_) { /* fall through */ }

  const proxy = configuredProxy()
  if (!proxy) {
    const response = await fetch(pageUrl, { headers: browserHeaders(pageUrl), redirect: 'follow' })
    if (response.ok) return response.text()
  }

  const fallback = await fetchHtmlWithCurl(pageUrl)
  if (fallback) return fallback
  throw new Error('8色页面请求失败。如果浏览器能打开该页，请在站点设置里提供 Cookie。')
}

// —— image extraction (same DOM structure as xChina) ——

function normalizeImageUrl(value, pageUrl) {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '')
  if (!trimmed || trimmed.startsWith('data:')) return null
  return new URL(trimmed, pageUrl).toString()
}

function extractBackgroundUrl(style, pageUrl) {
  const match = style.match(/url\(([^)]+)\)/i)
  return match ? normalizeImageUrl(match[1], pageUrl) : null
}

function collectImageUrlsInDomOrder($, pageUrl) {
  const urls = []
  const seen = new Set()
  const nodes = $('.list.photo-items .item.photo-image .img')

  nodes.each((_, element) => {
    const style = $(element).attr('style')
    if (!style) return
    const url = extractBackgroundUrl(style, pageUrl)
    if (!url || seen.has(url)) return
    if (!/\.(avif|gif|jpe?g|png|webp)(\?|#|$)/i.test(url)) return
    seen.add(url)
    urls.push(url)
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
  return candidates.map((v) => v?.trim()).find(Boolean)?.replace(/\s+/g, ' ') ?? '8色 套图'
}

function slugFromUrl(inputUrl) {
  const url = new URL(inputUrl)
  const filename = url.pathname.split('/').filter(Boolean).at(-1) ?? url.hostname
  return filename.replace(/\.html$/i, '').replace(/^id-/i, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
}

function originalImageUrlFromPreview(previewUrl) {
  const url = new URL(previewUrl)
  // _600x0.webp -> .jpg (original)
  url.pathname = url.pathname.replace(/_\d+x\d+\.(?:avif|jpe?g|png|webp)$/i, '.jpg')
  return url.toString()
}

function getPageUrl(inputUrl, pageNumber) {
  const url = new URL(inputUrl)
  if (pageNumber <= 1) return url.toString()
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
    if (!href || !idSegment) return
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

  return Math.max(1, ...numbers.filter((v) => Number.isSafeInteger(v) && v < 200))
}

function extractTags($) {
  const tags = new Set(['8色'])
  // breadcrumb
  $('.breadcrumb a').each((_, el) => {
    const text = $(el).text().trim()
    if (text && text !== '首頁') tags.add(text)
  })
  return [...tags]
}

// —— adapter ——

export const baSeAdapter = {
  id: '8se',
  name: '8色',
  status: '试解析',
  version: 'rules-0.1',
  color: '#d42a5c',
  domains: ['tw.8se.me', '8se.me', 'www.8se.me'],
  capabilities: ['套图解析', '分页采集', 'DOM 顺序保持', 'xChina 图床'],

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
      throw new Error('8色页面中没有解析到图片')
    }

    const slug = slugFromUrl(inputUrl)
    const tags = extractTags(firstPage)

    const images = orderedUrls.map((url, index) => ({
      downloadUrl: originalImageUrlFromPreview(url),
      id: `8se-${slug}-${String(index + 1).padStart(4, '0')}`,
      title: `${title} ${String(index + 1).padStart(3, '0')}`,
      url,
      resolution: '待识别',
      size: '待统计',
      tags: ['8色'],
    }))

    return {
      id: `8se-${slug}`,
      title,
      source: this.name,
      sourceUrl: inputUrl,
      folder: `8色/${slug}`,
      cover: images[0].url,
      tags: [...new Set([...tags, '待整理'])],
      images,
    }
  },
}
