import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { load } from 'cheerio'

const execFileAsync = promisify(execFile)
const acceptHeader = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
const acceptLanguageHeader = 'zh-CN,zh;q=0.9,en;q=0.8'
const defaultUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function configuredUserAgent() {
  return process.env.PICHARBOR_LIUSE_USER_AGENT?.trim() || process.env.PICHARBOR_XCHINA_USER_AGENT?.trim() || defaultUserAgent
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

function domainMatches(cookieDomain, hostname) {
  const normalizedDomain = cookieDomain.replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase()
  return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)
}

function cookieFileForSite() {
  if (process.env.PICHARBOR_LIUSE_COOKIE_FILE?.trim()) {
    return process.env.PICHARBOR_LIUSE_COOKIE_FILE.trim()
  }

  if (process.env.PICHARBOR_SITE_COOKIE_ROOT?.trim()) {
    return join(process.env.PICHARBOR_SITE_COOKIE_ROOT.trim(), 'liuse.txt')
  }

  return ''
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

function cookieHeaderForPage(pageUrl) {
  const cookieFile = cookieFileForSite()
  if (cookieFile && existsSync(cookieFile)) {
    const cookie = cookieHeaderFromNetscapeFile(cookieFile, pageUrl)
    if (cookie) {
      return cookie
    }
  }

  return process.env.PICHARBOR_LIUSE_COOKIE ?? ''
}

function browserHeaders(pageUrl) {
  const headers = {
    Accept: acceptHeader,
    'Accept-Language': acceptLanguageHeader,
    Referer: new URL('/', pageUrl).toString(),
    'User-Agent': configuredUserAgent(),
  }
  const cookie = cookieHeaderForPage(pageUrl)
  if (cookie) {
    headers.Cookie = cookie
  }
  return headers
}

async function fetchHtmlWithCurl(pageUrl) {
  const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const marker = '\n__PICHARBOR_HTTP_STATUS__:'
  const headers = browserHeaders(pageUrl)
  const proxy = configuredProxy()
  const args = [
    '-L',
    '-sS',
    '--compressed',
    ...Object.entries(headers).flatMap(([name, value]) => ['-H', `${name}: ${value}`]),
    '-w',
    `${marker}%{http_code}`,
    pageUrl,
  ]
  if (proxy) {
    args.splice(3, 0, '-x', proxy)
  }

  const { stdout } = await execFileAsync(curlBin, args, {
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
  })
  const markerIndex = stdout.lastIndexOf(marker)
  if (markerIndex === -1) {
    throw new Error('六色网 curl 请求没有返回 HTTP 状态')
  }

  const html = stdout.slice(0, markerIndex)
  const status = Number(stdout.slice(markerIndex + marker.length).trim())
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new Error(`六色网页面请求失败：${status}`)
  }

  return html
}

async function fetchHtml(pageUrl) {
  const proxy = configuredProxy()
  if (!proxy) {
    const response = await fetch(pageUrl, {
      headers: browserHeaders(pageUrl),
      redirect: 'follow',
    })
    if (response.ok) {
      return response.text()
    }
  }

  return fetchHtmlWithCurl(pageUrl)
}

function normalizeImageUrl(value, pageUrl) {
  const trimmed = value?.trim().replace(/^['"]|['"]$/g, '')
  if (!trimmed || trimmed.startsWith('data:')) {
    return null
  }

  return new URL(trimmed, pageUrl).toString()
}

function isImageUrl(value) {
  return /\.(avif|gif|jpe?g|png|webp)(\?|#|$)/i.test(value)
}

function collectArticleImages($, pageUrl) {
  const urls = []
  const seen = new Set()
  const content = $('.article-content').first().length ? $('.article-content').first() : $('article').first()

  content.find('img').each((_, element) => {
    const node = $(element)
    const candidates = [
      node.attr('data-src'),
      node.attr('data-original'),
      node.attr('data-lazy-src'),
      node.attr('data-url'),
      node.attr('src'),
    ]

    for (const candidate of candidates) {
      const normalized = normalizeImageUrl(candidate, pageUrl)
      if (!normalized || seen.has(normalized) || !isImageUrl(normalized)) {
        continue
      }
      if (/\/wp-content\/themes\/zibll\/img\/thumbnail/i.test(normalized)) {
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
  const title =
    $('.article-title').first().text().trim() ||
    $('article h1').first().text().trim() ||
    $('h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('title').first().text().trim()

  return (title || '六色网套图').replace(/-六色网$/i, '').replace(/\s+/g, ' ')
}

function extractTags($) {
  const tags = new Set(['六色网'])
  $('article a[href*="/tag/"], article .tag a, article .tags a').each((_, element) => {
    const text = $(element).text().replace(/^#/, '').trim()
    if (text) {
      tags.add(text)
    }
  })
  return [...tags]
}

function slugFromUrl(inputUrl) {
  const url = new URL(inputUrl)
  const filename = url.pathname.split('/').filter(Boolean).at(-1) ?? url.hostname
  return filename.replace(/\.html$/i, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
}

export const liuseAdapter = {
  id: 'liuse',
  name: '六色网',
  status: '试解析',
  version: 'rules-0.1',
  color: '#d45763',
  domains: ['www.06se.com', '06se.com'],
  capabilities: ['套图解析', 'DOM 顺序保持', '无 Referer 图床下载'],
  match(inputUrl) {
    const url = new URL(inputUrl)
    return this.domains.includes(url.hostname) && /^\/\d+\.html$/i.test(url.pathname)
  },
  async parse(inputUrl) {
    const html = await fetchHtml(inputUrl)
    const $ = load(html)
    const title = extractTitle($)
    const tags = extractTags($)
    const orderedUrls = collectArticleImages($, inputUrl)

    if (!orderedUrls.length) {
      throw new Error('六色网页面中没有解析到图片')
    }

    const slug = slugFromUrl(inputUrl)
    const images = orderedUrls.map((url, index) => ({
      downloadUrl: url,
      id: `liuse-${slug}-${String(index + 1).padStart(4, '0')}`,
      referer: null,
      title: `${title} ${String(index + 1).padStart(3, '0')}`,
      url,
      resolution: '待识别',
      size: '待统计',
      tags: ['六色网'],
    }))

    return {
      id: `liuse-${slug}`,
      title,
      source: this.name,
      sourceUrl: inputUrl,
      folder: `套图/六色网/${slug}`,
      cover: images[0].url,
      tags: [...new Set([...tags, '待整理'])],
      images,
    }
  },
}
