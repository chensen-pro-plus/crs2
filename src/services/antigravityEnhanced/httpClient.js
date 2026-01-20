/**
 * Antigravity Enhanced 独立 HTTP 客户端
 * 
 * 完全独立实现，不依赖原有的 antigravityClient
 * 直接发送 HTTP 请求到 Antigravity 上游 API
 */

const axios = require('axios')
const https = require('https')
const { v4: uuidv4 } = require('uuid')

const ProxyHelper = require('../../utils/proxyHelper')
const logger = require('../../utils/logger')

// ============================================================================
// 常量和配置
// ============================================================================

// Keep-Alive Agent 配置
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  timeout: 120000,
  maxSockets: 100,
  maxFreeSockets: 10
})

// API 端点
const DAILY_ENDPOINT = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
const PROD_ENDPOINT = 'https://cloudcode-pa.googleapis.com'

// 默认 User-Agent (与 Rust 版本对齐)
const DEFAULT_USER_AGENT = 'antigravity/1.11.9 windows/amd64'

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 获取 API 端点列表 (支持 Fallback)
 */
function getEndpoints() {
  const customUrl = process.env.ANTIGRAVITY_API_URL
  if (customUrl) {
    return [customUrl.replace(/\/$/, '')]
  }
  // 默认: daily 优先，prod 备用
  return [DAILY_ENDPOINT, PROD_ENDPOINT]
}

/**
 * 构建请求头
 */
function buildHeaders(accessToken, baseUrl) {
  let host = 'daily-cloudcode-pa.sandbox.googleapis.com'
  try {
    host = new URL(baseUrl).host || host
  } catch (e) {
    // ignore
  }

  return {
    'Host': host,
    'User-Agent': process.env.ANTIGRAVITY_USER_AGENT || DEFAULT_USER_AGENT,
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip',
    'requestType': 'agent'
  }
}

/**
 * 调用 loadCodeAssist API 获取真实的 projectId
 * 参考: Antigravity-Manager2/src-tauri/src/modules/quota.rs
 * 
 * @param {string} accessToken - Google OAuth access token
 * @param {Object} proxyConfig - 可选的代理配置
 * @returns {Promise<{projectId: string|null, subscriptionType: string|null}>}
 */
async function loadCodeAssist(accessToken, proxyConfig = null) {
  const baseUrl = PROD_ENDPOINT // 优先使用生产端点
  const url = `${baseUrl}/v1internal:loadCodeAssist`
  
  const proxyAgent = ProxyHelper.createProxyAgent(proxyConfig)
  
  try {
    const response = await axios({
      method: 'POST',
      url,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': process.env.ANTIGRAVITY_USER_AGENT || DEFAULT_USER_AGENT
      },
      data: {
        metadata: { ideType: 'ANTIGRAVITY' }
      },
      httpsAgent: proxyAgent || keepAliveAgent,
      proxy: proxyAgent ? false : undefined,
      timeout: 30000
    })
    
    const data = response.data
    // 提取 cloudaicompanionProject 和订阅类型
    const projectId = data?.cloudaicompanionProject || null
    const subscriptionType = data?.subscriptionType || null
    
    if (projectId) {
      logger.debug(`[loadCodeAssist] 获取到项目ID: ${projectId}, 订阅类型: ${subscriptionType}`)
    } else {
      logger.warn('[loadCodeAssist] 未获取到项目ID，响应:', JSON.stringify(data))
    }
    
    return { projectId, subscriptionType }
  } catch (error) {
    logger.error('[loadCodeAssist] 请求失败:', error.message)
    return { projectId: null, subscriptionType: null }
  }
}

/**
 * 生成请求 ID
 */
function generateRequestId() {
  return `req-${uuidv4()}`
}

/**
 * 生成会话 ID
 */
function generateSessionId() {
  return `sess-${uuidv4()}`
}

/**
 * 判断错误是否可重试
 */
function isRetryableError(error) {
  // 网络层错误
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
    return true
  }
  
  const status = error?.response?.status
  
  // 429 限流
  if (status === 429) {
    return true
  }
  
  // 400/404 特定错误可重试
  if (status === 400 || status === 404) {
    const data = error?.response?.data
    let text = ''
    
    // 安全处理 data，避免序列化流对象导致循环引用
    if (typeof data === 'string') {
      text = data
    } else if (data && typeof data === 'object' && typeof data.pipe !== 'function') {
      // 只序列化普通对象，不序列化流对象
      try {
        text = JSON.stringify(data)
      } catch (e) {
        text = error?.message || ''
      }
    } else {
      text = error?.message || ''
    }
    
    const msg = text.toLowerCase()
    return (
      msg.includes('requested model is currently unavailable') ||
      msg.includes('requested entity was not found') ||
      msg.includes('not found')
    )
  }
  
  return false
}

// ============================================================================
// 主请求函数
// ============================================================================

/**
 * 发送请求到 Antigravity 上游 API
 * 
 * @param {Object} options - 请求选项
 * @param {string} options.accessToken - OAuth Access Token
 * @param {Object} options.proxyConfig - 代理配置 (可选)
 * @param {Object} options.requestBody - 已转换的 Gemini 格式请求体
 * @param {string} options.projectId - 项目 ID
 * @param {string} options.sessionId - 会话 ID (可选)
 * @param {string} options.model - 模型名称
 * @param {boolean} options.stream - 是否流式
 * @param {number} options.timeoutMs - 超时时间 (毫秒)
 * @param {AbortSignal} options.signal - 中止信号 (可选)
 * @returns {Promise<Object>} Axios 响应对象
 */
async function sendRequest({
  accessToken,
  proxyConfig = null,
  requestBody,
  projectId,
  sessionId = null,
  model,
  stream = false,
  timeoutMs = 600000,
  signal = null
}) {
  // 构建 Antigravity 信封格式
  // 参考: Antigravity-Manager2/src-tauri/src/proxy/mappers/claude/request.rs
  const envelope = {
    project: projectId,
    requestId: generateRequestId(),
    model: model,
    userAgent: 'antigravity',
    requestType: 'agent',  // 关键字段！Rust 版本默认为 'agent'
    request: requestBody
  }
  
  // 调试：输出完整请求体（临时总是开启）
  logger.info('[AntigravityEnhanced][DEBUG] 完整请求体:', JSON.stringify(envelope, null, 2))
  
  // 创建代理 Agent
  const proxyAgent = ProxyHelper.createProxyAgent(proxyConfig)
  
  // 获取端点列表
  const endpoints = getEndpoints()
  
  let lastError = null
  // 🔧 保留第一个包含详细配额信息的错误（如 quotaResetDelay）
  // 避免被备用端点的简化错误覆盖
  let firstQuotaError = null
  
  for (let i = 0; i < endpoints.length; i++) {
    const baseUrl = endpoints[i]
    const url = `${baseUrl}/v1internal:${stream ? 'streamGenerateContent' : 'generateContent'}`
    
    const axiosConfig = {
      url,
      method: 'POST',
      params: stream ? { alt: 'sse' } : undefined,
      headers: buildHeaders(accessToken, baseUrl),
      data: envelope,
      timeout: stream ? 0 : timeoutMs,
      responseType: stream ? 'stream' : 'json'
    }
    
    // 配置代理或 Keep-Alive
    if (proxyAgent) {
      axiosConfig.httpsAgent = proxyAgent
      axiosConfig.proxy = false
      if (i === 0) {
        logger.debug(`[AntigravityEnhanced] 🌐 使用代理: ${ProxyHelper.getProxyDescription(proxyConfig)}`)
      }
    } else {
      axiosConfig.httpsAgent = keepAliveAgent
    }
    
    // 中止信号
    if (signal) {
      axiosConfig.signal = signal
    }
    
    try {
      // 记录详细的请求信息用于调试
      logger.info(`[AntigravityEnhanced] 📤 发送请求:`, {
        url,
        model,
        stream,
        projectId,
        requestId: envelope.requestId,
        sessionId: envelope.sessionId
      })
      
      // 调试模式下记录完整请求体
      if (process.env.ANTIGRAVITY_DEBUG === 'true') {
        logger.debug(`[AntigravityEnhanced] 📄 完整请求体:`, JSON.stringify(envelope, null, 2))
      }
      
      const response = await axios(axiosConfig)
      return response
      
    } catch (error) {
      lastError = error
      const status = error?.response?.status || null
      
      // 详细记录错误响应
      let errorData = null
      try {
        const data = error?.response?.data
        if (typeof data === 'string') {
          errorData = data
        } else if (data && typeof data === 'object' && typeof data.pipe !== 'function') {
          errorData = JSON.stringify(data, null, 2)
        } else if (data && typeof data.pipe === 'function') {
          // 这是一个流对象，尝试读取其内容
          try {
            const chunks = []
            // 同步读取已经缓冲的数据
            data.on('data', chunk => chunks.push(chunk))
            // 等待流结束或超时
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                data.destroy()
                resolve()
              }, 1000) // 最多等待1秒
              data.on('end', () => {
                clearTimeout(timeout)
                resolve()
              })
              data.on('error', (err) => {
                clearTimeout(timeout)
                reject(err)
              })
            })
            const buffer = Buffer.concat(chunks)
            errorData = buffer.toString('utf-8')
          } catch (streamErr) {
            errorData = `[读取错误流失败: ${streamErr.message}]`
          }
        }
      } catch (e) {
        errorData = `[解析错误响应失败: ${e.message}]`
      }
      
      // 提取 Retry-After header（用于限流追踪）
      const retryAfter = error?.response?.headers?.['retry-after'] || null
      
      logger.error(`[AntigravityEnhanced] ❌ HTTP ${status} 错误详情:`, {
        url,
        model,
        projectId,
        errorMessage: error.message,
        errorData: errorData,
        retryAfter,
        headers: error?.response?.headers ? JSON.stringify(error.response.headers) : null
      })
      
      // 🔧 关键修复：检测并保存第一个包含详细配额信息的错误
      // 避免被备用端点的简化错误覆盖（备用端点通常只返回 "Resource has been exhausted"）
      if (status === 429 && !firstQuotaError) {
        const hasDetailedInfo = errorData && (
          errorData.includes('quotaResetDelay') ||
          errorData.includes('QUOTA_EXHAUSTED') ||
          errorData.includes('quotaResetTimeStamp')
        )
        if (hasDetailedInfo) {
          logger.info(`[AntigravityEnhanced] 💾 保存第一个端点的详细配额错误信息`)
          firstQuotaError = {
            status,
            retryAfter,
            errorBody: errorData
          }
        }
      }
      
      // 如果还有备用端点且错误可重试，继续尝试
      const hasNext = i + 1 < endpoints.length
      if (hasNext && isRetryableError(error)) {
        logger.warn(`[AntigravityEnhanced] ⚠️ 请求失败 (${status})，切换到备用端点: ${endpoints[i + 1]}`)
        continue
      }
      
      // 增强错误对象：附加限流追踪所需的信息
      // 🔧 优先使用第一个端点的详细配额错误信息（如果有）
      error.rateLimitInfo = firstQuotaError || {
        status,
        retryAfter,
        errorBody: errorData
      }
      
      throw error
    }
  }
  
  // 🔧 如果 lastError 存在但没有 rateLimitInfo，补充第一个端点的详细信息
  if (lastError && firstQuotaError) {
    lastError.rateLimitInfo = firstQuotaError
  }
  
  throw lastError || new Error('所有端点请求失败')
}

/**
 * 获取可用模型列表
 * 
 * @param {Object} options - 选项
 * @param {string} options.accessToken - OAuth Access Token
 * @param {Object} options.proxyConfig - 代理配置 (可选)
 * @returns {Promise<Array>} 模型列表
 */
async function fetchModels({ accessToken, proxyConfig = null }) {
  const proxyAgent = ProxyHelper.createProxyAgent(proxyConfig)
  const endpoints = getEndpoints()
  
  for (const baseUrl of endpoints) {
    const url = `${baseUrl}/v1beta/models`
    
    try {
      const response = await axios({
        url,
        method: 'GET',
        headers: buildHeaders(accessToken, baseUrl),
        httpsAgent: proxyAgent || keepAliveAgent,
        proxy: proxyAgent ? false : undefined,
        timeout: 30000
      })
      
      const models = response.data?.models || []
      return models.map(m => ({
        id: m.name || m.id,
        object: 'model',
        created: Date.now(),
        owned_by: 'google'
      }))
      
    } catch (error) {
      logger.warn(`[AntigravityEnhanced] 获取模型列表失败 (${baseUrl}): ${error.message}`)
      continue
    }
  }
  
  return []
}

/**
 * Token 计数
 * 
 * @param {Object} options - 选项
 * @param {string} options.accessToken - OAuth Access Token
 * @param {Object} options.proxyConfig - 代理配置 (可选)
 * @param {Array} options.contents - Gemini 格式的 contents
 * @param {string} options.model - 模型名称
 * @returns {Promise<Object>} Token 计数结果
 */
async function countTokens({ accessToken, proxyConfig = null, contents, model }) {
  const proxyAgent = ProxyHelper.createProxyAgent(proxyConfig)
  const endpoints = getEndpoints()
  
  for (const baseUrl of endpoints) {
    const url = `${baseUrl}/v1beta/models/${model}:countTokens`
    
    try {
      const response = await axios({
        url,
        method: 'POST',
        headers: buildHeaders(accessToken, baseUrl),
        data: { contents },
        httpsAgent: proxyAgent || keepAliveAgent,
        proxy: proxyAgent ? false : undefined,
        timeout: 30000
      })
      
      return {
        input_tokens: response.data?.totalTokens || 0
      }
      
    } catch (error) {
      logger.warn(`[AntigravityEnhanced] Token 计数失败 (${baseUrl}): ${error.message}`)
      continue
    }
  }
  
  throw new Error('Token 计数失败: 所有端点不可用')
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
  sendRequest,
  fetchModels,
  countTokens,
  getEndpoints,
  buildHeaders,
  generateRequestId,
  generateSessionId,
  isRetryableError,
  loadCodeAssist  // 新增：用于获取真实的 projectId
}
