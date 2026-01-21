/**
 * CLIProxyAPI 代理服务
 *
 * 将请求透明转发到本地 CLIProxyAPI 服务
 * 支持流式和非流式响应，保持请求头透传
 * 支持 API Key 验证和 Token 消费记录
 */

const http = require('http')
const https = require('https')
const { URL } = require('url')
const logger = require('../utils/logger')
const cliproxyapiConfig = require('../../config/cliproxyapi')
const apiKeyService = require('./apiKeyService')

/**
 * 从响应中解析 usage 信息
 * 支持 OpenAI 和 Claude 格式
 * @param {object} data - 响应数据
 * @returns {object|null} 标准化的 usage 对象
 */
function parseUsageFromResponse(data) {
  if (!data || typeof data !== 'object') {
    return null
  }

  // OpenAI 格式
  if (data.usage) {
    const { usage } = data
    return {
      inputTokens: usage.prompt_tokens || usage.input_tokens || 0,
      outputTokens: usage.completion_tokens || usage.output_tokens || 0,
      cacheCreateTokens: usage.cache_creation_input_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      model: data.model || 'unknown'
    }
  }

  return null
}

/**
 * 从流式响应中解析 usage 信息
 * 解析 SSE 事件流中的 usage 数据
 * @param {string} sseData - SSE 数据字符串
 * @returns {object|null} 标准化的 usage 对象
 */
function parseUsageFromStream(sseData) {
  if (!sseData || typeof sseData !== 'string') {
    return null
  }

  let lastUsage = null
  let lastModel = 'unknown'

  // 按行解析 SSE 事件
  const lines = sseData.split('\n')
  for (const line of lines) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) {
      continue
    }

    try {
      const jsonStr = line.substring(6).trim()
      if (!jsonStr) {
        continue
      }

      const data = JSON.parse(jsonStr)

      // 记录模型名称
      if (data.model) {
        lastModel = data.model
      }

      // OpenAI 格式的流式 usage
      if (data.usage) {
        const { usage } = data
        lastUsage = {
          inputTokens: usage.prompt_tokens || usage.input_tokens || 0,
          outputTokens: usage.completion_tokens || usage.output_tokens || 0,
          cacheCreateTokens: usage.cache_creation_input_tokens || 0,
          cacheReadTokens: usage.cache_read_input_tokens || 0,
          model: lastModel
        }
      }

      // Claude 流式格式 - message_delta 事件中的 usage
      if (data.type === 'message_delta' && data.usage) {
        const { usage } = data
        lastUsage = {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheCreateTokens: usage.cache_creation_input_tokens || 0,
          cacheReadTokens: usage.cache_read_input_tokens || 0,
          model: lastModel
        }
      }

      // Claude 流式格式 - message_start 事件中可能包含 input_tokens
      if (data.type === 'message_start' && data.message?.usage) {
        const { usage } = data.message
        // 只记录 input_tokens，output_tokens 会在 message_delta 中
        if (!lastUsage) {
          lastUsage = {
            inputTokens: usage.input_tokens || 0,
            outputTokens: 0,
            cacheCreateTokens: usage.cache_creation_input_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens || 0,
            model: data.message.model || lastModel
          }
        } else {
          lastUsage.inputTokens = usage.input_tokens || lastUsage.inputTokens
        }
        if (data.message.model) {
          lastModel = data.message.model
          lastUsage.model = lastModel
        }
      }
    } catch (e) {
      // 忽略 JSON 解析错误
    }
  }

  return lastUsage
}

/**
 * 记录 Token 使用情况
 * @param {object} apiKeyData - API Key 数据
 * @param {object} usage - 使用统计
 */
async function recordTokenUsage(apiKeyData, usage) {
  if (!apiKeyData || !usage) {
    return
  }

  try {
    await apiKeyService.recordUsage(
      apiKeyData.id,
      usage.inputTokens || 0,
      usage.outputTokens || 0,
      usage.cacheCreateTokens || 0,
      usage.cacheReadTokens || 0,
      usage.model || 'unknown',
      null // accountId - CLIProxyAPI 不提供账户信息
    )
    logger.info(
      `[CLIProxyAPI] 📊 记录 Token 消费: keyId=${apiKeyData.id}, ` +
        `input=${usage.inputTokens}, output=${usage.outputTokens}, model=${usage.model}`
    )
  } catch (error) {
    logger.error('[CLIProxyAPI] 记录 Token 消费失败:', error)
  }
}

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
 * 支持收集响应数据以记录 Token 消费
 *
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 * @param {object} apiKeyData - API Key 数据（可选，用于记录消费）
 */
async function proxyRequest(req, res, apiKeyData = null) {
  const startTime = Date.now()
  const isStream = isStreamRequest(req)

  // 构建目标 URL，保留原始路径
  const targetUrl = getTargetUrl(req.originalUrl.replace(/^\/cliproxy\/api/, ''))

  logger.info(`[CLIProxyAPI] 转发请求: ${req.method} ${req.originalUrl} -> ${targetUrl.href}`, {
    stream: isStream,
    contentType: req.headers['content-type'],
    apiKeyId: apiKeyData?.id
  })

  // 选择协议模块
  const protocol = targetUrl.protocol === 'https:' ? https : http
  const agent = targetUrl.protocol === 'https:' ? httpsAgent : httpAgent

  // 准备请求体，并进行模型名称映射
  let body = null
  let originalModel = null
  let mappedModel = null

  if (req.body && Object.keys(req.body).length > 0) {
    // 🔄 模型名称映射：将用户请求的模型名替换为配置的目标模型名
    if (req.body.model) {
      originalModel = req.body.model
      mappedModel = cliproxyapiConfig.getTargetModel(originalModel)

      // 如果发生了映射，替换请求体中的模型名
      if (mappedModel !== originalModel) {
        logger.info(`[CLIProxyAPI] 🔄 模型映射: "${originalModel}" -> "${mappedModel}"`)
        req.body.model = mappedModel
      }
    }

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

      // 🔑 收集响应数据以解析 usage（仅在需要记录消费时）
      if (apiKeyData && statusCode >= 200 && statusCode < 300) {
        const chunks = []

        proxyRes.on('data', (chunk) => {
          chunks.push(chunk)
          // 同时写入响应
          res.write(chunk)
        })

        proxyRes.on('end', () => {
          const responseData = Buffer.concat(chunks).toString('utf-8')

          // 解析并记录 usage
          let usage = null
          if (isStream) {
            // 流式响应：从 SSE 事件中解析
            usage = parseUsageFromStream(responseData)
          } else {
            // 非流式响应：从 JSON 中解析
            try {
              const jsonData = JSON.parse(responseData)
              usage = parseUsageFromResponse(jsonData)
            } catch (e) {
              logger.debug('[CLIProxyAPI] 无法解析响应 JSON，跳过 usage 记录')
            }
          }

          // 📊 记录 Token 消费（异步，不阻塞响应）
          if (usage) {
            recordTokenUsage(apiKeyData, usage).catch((error) => {
              logger.error('[CLIProxyAPI] 记录 Token 消费异常:', error)
            })
          }

          res.end()
          logger.info(`[CLIProxyAPI] 请求完成`, {
            elapsed: `${Date.now() - startTime}ms`,
            path: req.originalUrl,
            usageRecorded: !!usage
          })
          resolve()
        })

        proxyRes.on('error', (error) => {
          logger.error(`[CLIProxyAPI] 响应流错误:`, error)
          reject(error)
        })
      } else {
        // 不需要记录消费或响应错误时，直接透传
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
      }
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
