/**
 * CLIProxyAPI 代理服务
 *
 * 将请求透明转发到本地 CLIProxyAPI 服务
 * 支持流式和非流式响应，保持请求头透传
 */

const http = require('http')
const https = require('https')
const { URL } = require('url')
const logger = require('../utils/logger')
const cliproxyapiConfig = require('../../config/cliproxyapi')

/**
 * HTTP Agent 配置，支持连接复用
 */
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: cliproxyapiConfig.timeout
})

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: cliproxyapiConfig.timeout
})

/**
 * 解析目标 URL
 * @param {string} path - 请求路径
 * @returns {URL} 完整的目标 URL
 */
function getTargetUrl(path) {
  const baseUrl = cliproxyapiConfig.baseUrl.replace(/\/$/, '')
  return new URL(path, baseUrl)
}

/**
 * 判断是否为流式请求
 * @param {object} req - Express 请求对象
 * @returns {boolean} 是否为流式请求
 */
function isStreamRequest(req) {
  // 检查请求体中的 stream 字段
  if (req.body && req.body.stream === true) {
    return true
  }
  // 检查 Accept 头
  const accept = req.headers['accept'] || ''
  if (accept.includes('text/event-stream')) {
    return true
  }
  return false
}

/**
 * 构建转发请求的头部
 * @param {object} req - Express 请求对象
 * @returns {object} 请求头
 */
function buildProxyHeaders(req) {
  const headers = {}

  // 透传大部分请求头，排除 hop-by-hop 头和认证头（会用上游密钥替换）
  const hopByHopHeaders = [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
    'authorization', // 不透传客户端的认证头，使用配置的上游密钥
    'x-api-key',
    'api-key'
  ]

  for (const [key, value] of Object.entries(req.headers)) {
    if (!hopByHopHeaders.includes(key.toLowerCase())) {
      headers[key] = value
    }
  }

  // 设置正确的 Host
  const targetUrl = getTargetUrl('/')
  headers['host'] = targetUrl.host

  // 🔑 添加上游 CLIProxyAPI 的 API 密钥
  if (cliproxyapiConfig.upstreamApiKey) {
    headers['authorization'] = `Bearer ${cliproxyapiConfig.upstreamApiKey}`
  }

  // 添加代理标识
  headers['x-forwarded-for'] = req.ip || req.connection.remoteAddress
  headers['x-forwarded-proto'] = req.protocol
  headers['x-forwarded-host'] = req.get('host')

  return headers
}

/**
 * 通用请求代理
 * 将请求透明转发到 CLIProxyAPI，支持流式和非流式响应
 *
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 */
async function proxyRequest(req, res) {
  const startTime = Date.now()
  const isStream = isStreamRequest(req)

  // 构建目标 URL，保留原始路径
  const targetUrl = getTargetUrl(req.originalUrl.replace(/^\/cliproxy\/api/, ''))

  logger.info(`[CLIProxyAPI] 转发请求: ${req.method} ${req.originalUrl} -> ${targetUrl.href}`, {
    stream: isStream,
    contentType: req.headers['content-type']
  })

  // 选择协议模块
  const protocol = targetUrl.protocol === 'https:' ? https : http
  const agent = targetUrl.protocol === 'https:' ? httpsAgent : httpAgent

  // 准备请求体
  let body = null
  if (req.body && Object.keys(req.body).length > 0) {
    body = JSON.stringify(req.body)
  }

  // 构建请求选项
  const options = {
    method: req.method,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    headers: buildProxyHeaders(req),
    agent,
    timeout: isStream ? cliproxyapiConfig.streamTimeout : cliproxyapiConfig.timeout
  }

  // 如果有请求体，设置 Content-Length
  if (body) {
    options.headers['content-length'] = Buffer.byteLength(body)
  }

  return new Promise((resolve, reject) => {
    const proxyReq = protocol.request(options, (proxyRes) => {
      const { statusCode } = proxyRes

      logger.info(`[CLIProxyAPI] 响应状态: ${statusCode}`, {
        elapsed: `${Date.now() - startTime}ms`,
        contentType: proxyRes.headers['content-type']
      })

      // 透传响应头
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        // 跳过 transfer-encoding，让 Express 处理
        if (key.toLowerCase() !== 'transfer-encoding') {
          res.setHeader(key, value)
        }
      }

      // 设置响应状态码
      res.status(statusCode)

      // 流式转发响应体
      proxyRes.pipe(res)

      proxyRes.on('end', () => {
        logger.info(`[CLIProxyAPI] 请求完成`, {
          elapsed: `${Date.now() - startTime}ms`,
          path: req.originalUrl
        })
        resolve()
      })

      proxyRes.on('error', (error) => {
        logger.error(`[CLIProxyAPI] 响应流错误:`, error)
        reject(error)
      })
    })

    // 请求超时处理
    proxyReq.on('timeout', () => {
      logger.error(`[CLIProxyAPI] 请求超时: ${req.originalUrl}`)
      proxyReq.destroy()
      if (!res.headersSent) {
        res.status(504).json({
          error: {
            type: 'gateway_timeout',
            message: 'CLIProxyAPI 请求超时'
          }
        })
      }
      reject(new Error('Request timeout'))
    })

    // 请求错误处理
    proxyReq.on('error', (error) => {
      logger.error(`[CLIProxyAPI] 请求错误:`, {
        error: error.message,
        code: error.code,
        path: req.originalUrl
      })

      if (!res.headersSent) {
        // 根据错误类型返回不同的状态码
        if (error.code === 'ECONNREFUSED') {
          res.status(503).json({
            error: {
              type: 'service_unavailable',
              message: 'CLIProxyAPI 服务不可用，请确认服务是否已启动'
            }
          })
        } else if (error.code === 'ECONNRESET') {
          res.status(502).json({
            error: {
              type: 'bad_gateway',
              message: 'CLIProxyAPI 连接被重置'
            }
          })
        } else {
          res.status(500).json({
            error: {
              type: 'proxy_error',
              message: `代理请求失败: ${error.message}`
            }
          })
        }
      }
      reject(error)
    })

    // 发送请求体
    if (body) {
      proxyReq.write(body)
    }

    proxyReq.end()
  })
}

/**
 * 健康检查
 * 检查 CLIProxyAPI 服务是否可用
 *
 * @returns {Promise<object>} 健康状态
 */
async function healthCheck() {
  const targetUrl = getTargetUrl('/health')
  const protocol = targetUrl.protocol === 'https:' ? https : http

  return new Promise((resolve) => {
    const startTime = Date.now()

    const req = protocol.get(targetUrl.href, { timeout: 5000 }, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        const elapsed = Date.now() - startTime

        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data)
            resolve({
              status: 'healthy',
              latency: `${elapsed}ms`,
              upstream: parsed
            })
          } catch {
            resolve({
              status: 'healthy',
              latency: `${elapsed}ms`,
              upstream: data
            })
          }
        } else {
          resolve({
            status: 'unhealthy',
            latency: `${elapsed}ms`,
            statusCode: res.statusCode,
            error: data
          })
        }
      })
    })

    req.on('error', (error) => {
      resolve({
        status: 'unhealthy',
        error: error.message,
        code: error.code
      })
    })

    req.on('timeout', () => {
      req.destroy()
      resolve({
        status: 'unhealthy',
        error: 'Health check timeout'
      })
    })
  })
}

module.exports = {
  proxyRequest,
  healthCheck,
  getTargetUrl,
  isStreamRequest
}
