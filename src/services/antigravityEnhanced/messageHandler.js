/**
 * Antigravity Enhanced 消息处理主逻辑
 * 
 * 集成所有增强功能：
 * - Warmup 请求拦截
 * - 自动 Stream 转换
 * - 后台任务智能降级
 * - 多策略退避重试
 * - 独立的协议转换和 HTTP 客户端 (完全不依赖原有服务)
 */

const crypto = require('crypto')
const logger = require('../../utils/logger')

// 增强功能模块
const { isWarmupRequest, sendWarmupResponse } = require('./warmupInterceptor')
const { StreamConverter } = require('./streamConverter')
const { RetryExecutor } = require('../../utils/antigravityEnhanced/retryStrategy')
const { 
  processBackgroundTaskDowngrade, 
  sanitizeRequestForFlash 
} = require('../../utils/antigravityEnhanced/backgroundDetector')

// 独立模块 (核心: 完全不依赖原有服务)
const { buildGeminiRequestFromAnthropic } = require('./protocolConverter')
const httpClient = require('./httpClient')

// 复用原有服务（只读）用于账号调度
const unifiedGeminiScheduler = require('../unifiedGeminiScheduler')
const apiKeyService = require('../apiKeyService')
const sessionHelper = require('../../utils/sessionHelper')

/**
 * 助手函数：获取并准备账号详情
 * 包含 Token 刷新逻辑，确保返回有效的 accessToken
 */
async function prepareAccountDetails(accountInfo, traceId) {
  if (!accountInfo || !accountInfo.accountId) return null

  const geminiAccountService = require('../geminiAccountService')
  const geminiApiAccountService = require('../geminiApiAccountService')

  let account = null
  try {
    if (accountInfo.accountType === 'gemini-api') {
      account = await geminiApiAccountService.getAccount(accountInfo.accountId)
      if (account && !account.accessToken) {
        account.accessToken = account.apiKey
      }
    } else {
      account = await geminiAccountService.getAccount(accountInfo.accountId)
    }
  } catch (err) {
    logger.error(`[AntigravityEnhanced][${traceId}] ❌ 获取账号详情失败:`, err)
    return null
  }

  if (!account) return null

  // ========== 核心修复: Token 刷新逻辑 ==========
  // 对于 OAuth 账号，检查 Token 是否过期，过期则刷新
  if (accountInfo.accountType !== 'gemini-api' && account.refreshToken) {
    const isExpired = geminiAccountService.isTokenExpired(account)
    
    if (isExpired) {
      logger.info(`[AntigravityEnhanced][${traceId}] 🔄 Token 已过期，正在刷新...`)
      try {
        const newTokens = await geminiAccountService.refreshAccountToken(account.id)
        // 更新 accessToken 为刷新后的新 Token
        account.accessToken = newTokens.access_token
        logger.info(`[AntigravityEnhanced][${traceId}] ✅ Token 刷新成功`)
      } catch (refreshError) {
        logger.error(`[AntigravityEnhanced][${traceId}] ❌ Token 刷新失败:`, refreshError.message)
        // 仍然尝试使用旧 Token，让上游决定是否有效
      }
    }
  }

  // 安全解析代理配置
  let proxyConfig = null
  if (account.proxy) {
    if (typeof account.proxy === 'string' && account.proxy.trim()) {
      try {
        proxyConfig = JSON.parse(account.proxy)
      } catch (e) {
        logger.warn(`[AntigravityEnhanced][${traceId}] ⚠️ 代理配置解析失败:`, e.message)
      }
    } else if (typeof account.proxy === 'object') {
      proxyConfig = account.proxy
    }
  }

  return { ...account, proxyConfig }
}


/**
 * 确保 projectId
 */
function ensureProjectId(account) {
  if (account.projectId) return account.projectId
  if (account.tempProjectId) return account.tempProjectId
  return `ag-${crypto.randomBytes(8).toString('hex')}`
}

/**
 * 生成追踪 ID
 */
function generateTraceId() {
  return crypto.randomBytes(4).toString('hex')
}

/**
 * 从请求头提取 API Key
 */
function extractApiKey(req) {
  const authHeader = req.headers.authorization || req.headers['x-api-key'] || ''
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }
  return authHeader
}

/**
 * 主消息处理函数
 */
async function handleMessages(req, res) {
  const traceId = generateTraceId()
  const startTime = Date.now()
  
  try {
    const body = req.body
    
    // ========== 基础验证 ==========
    if (!body || !body.messages || !Array.isArray(body.messages)) {
      return res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'messages 字段必须是数组'
        }
      })
    }
    
    logger.info(
      `[AntigravityEnhanced][${traceId}] 📥 收到请求: ` +
      `model=${body.model}, stream=${body.stream}, messages=${body.messages.length}`
    )
    
    // ========== 增强功能 1: Warmup 拦截 ==========
    if (isWarmupRequest(body)) {
      return sendWarmupResponse(res, body.stream === true, traceId)
    }
    
    // ========== API Key 验证 ==========
    const apiKey = extractApiKey(req)
    if (!apiKey) {
      return res.status(401).json({
        error: {
          type: 'authentication_error',
          message: '缺少 API Key'
        }
      })
    }
    
    const apiKeyData = await apiKeyService.validateApiKey(apiKey)
    if (!apiKeyData) {
      return res.status(401).json({
        error: {
          type: 'authentication_error',
          message: 'API Key 无效'
        }
      })
    }
    
    // ========== 增强功能 2: 后台任务降级 ==========
    let model = body.model || 'claude-sonnet-4'
    let requestBody = body
    
    const downgradeResult = processBackgroundTaskDowngrade(body, traceId)
    if (downgradeResult.shouldDowngrade) {
      model = downgradeResult.downgradeModel
      requestBody = sanitizeRequestForFlash(body)
      res.setHeader('X-Background-Task', downgradeResult.taskType)
      res.setHeader('X-Model-Downgraded', 'true')
    }
    
    // ========== 增强功能 3: 自动 Stream 转换 ==========
    const clientWantsStream = body.stream === true
    const actualStream = true // 始终使用流式发送
    
    if (!clientWantsStream) {
      logger.info(`[AntigravityEnhanced][${traceId}] 🔄 自动转换: 非流式 → 流式`)
    }
    
    // ========== 会话哈希（用于粘性调度） ==========
    const sessionHash = sessionHelper.generateSessionHash(body)
    
    // ========== 增强功能 4: 多策略重试 ==========
    const retryExecutor = new RetryExecutor({ 
      maxAttempts: 3, 
      traceId 
    })
    
    let selectedAccount = null
    
    const result = await retryExecutor.execute(async (attempt, shouldRotate) => {
      // 选择账号
      const accountInfo = await unifiedGeminiScheduler.selectAccountForApiKey(
        apiKeyData,
        sessionHash,
        model,
        { 
          preferredOAuthProvider: 'antigravity',
          forceRotate: shouldRotate
        }
      )
      
      if (!accountInfo) {
        throw new Error('没有可用的 Antigravity 账号')
      }
      
      // 获取并准备完整账号详情
      const account = await prepareAccountDetails(accountInfo, traceId)
      if (!account) {
        throw new Error(`找不到账号详情: ${accountInfo.accountId}`)
      }
      
      selectedAccount = account
      
      logger.info(
        `[AntigravityEnhanced][${traceId}] 👤 使用账号: ${account.email || account.name || account.id} ` +
        `(attempt ${attempt + 1})`
      )
      
      // 确保 projectId
      const projectId = ensureProjectId(account)
      
      // ========== 核心: 使用协议转换器构建 Gemini 请求体 ==========
      const { model: effectiveModel, request: geminiRequest } = buildGeminiRequestFromAnthropic(
        requestBody,
        model,
        { sessionId: sessionHash }
      )
      
      logger.debug(`[AntigravityEnhanced][${traceId}] 📤 转换后的请求:`, {
        model: effectiveModel,
        contentsCount: geminiRequest.contents?.length,
        hasTools: !!geminiRequest.tools
      })
      
      // ========== 核心: 使用独立 httpClient 发送请求 ==========
      const response = await httpClient.sendRequest({
        accessToken: account.accessToken,
        proxyConfig: account.proxyConfig,
        requestBody: geminiRequest,
        projectId,
        sessionId: sessionHash,
        model: effectiveModel,
        stream: actualStream,
        timeoutMs: 600000
      })
      
      return { response, account }
    })
    
    // ========== 响应处理 ==========
    const { response, account } = result
    
    // 设置通用响应头
    res.setHeader('X-Antigravity-Enhanced', 'true')
    res.setHeader('X-Trace-Id', traceId)
    if (selectedAccount) {
      res.setHeader('X-Account-Email', selectedAccount.email || 'unknown')
    }
    
    if (!clientWantsStream) {
      // 收集流并转换为 JSON
      logger.info(`[AntigravityEnhanced][${traceId}] 📦 收集流响应...`)
      
      const converter = new StreamConverter(traceId)
      const jsonResponse = await converter.collectFromAxiosResponse(response)
      
      const elapsed = Date.now() - startTime
      logger.info(
        `[AntigravityEnhanced][${traceId}] ✅ 请求完成: ${elapsed}ms, ` +
        `tokens: ${jsonResponse.usage?.input_tokens || 0}/${jsonResponse.usage?.output_tokens || 0}`
      )
      
      res.setHeader('Content-Type', 'application/json')
      return res.json(jsonResponse)
    }
    
    // 直接转发流
    logger.info(`[AntigravityEnhanced][${traceId}] 📡 转发流响应...`)
    
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    
    response.data.pipe(res)
    
    response.data.on('end', () => {
      const elapsed = Date.now() - startTime
      logger.info(`[AntigravityEnhanced][${traceId}] ✅ 流响应完成: ${elapsed}ms`)
    })
    
    response.data.on('error', (error) => {
      logger.error(`[AntigravityEnhanced][${traceId}] ❌ 流错误: ${error.message}`)
    })
    
  } catch (error) {
    const elapsed = Date.now() - startTime
    
    // 提取详细的错误响应信息
    let errorDetails = ''
    try {
      const data = error?.response?.data
      if (typeof data === 'string') {
        errorDetails = data
      } else if (data && typeof data === 'object' && typeof data.pipe !== 'function') {
        errorDetails = JSON.stringify(data)
      }
    } catch (e) {
      errorDetails = `[解析失败: ${e.message}]`
    }
    
    logger.error(
      `[AntigravityEnhanced][${traceId}] ❌ 请求失败: ${error.message} (${elapsed}ms)`,
      {
        status: error?.response?.status,
        errorDetails: errorDetails.substring(0, 1000)  // 限制日志长度
      }
    )
    
    // 提取错误状态码
    const status = error?.response?.status || error?.status || 500
    
    // 构建错误响应
    const errorResponse = {
      type: 'error',
      error: {
        type: mapErrorType(status),
        message: error.message || '请求处理失败'
      }
    }
    
    if (!res.headersSent) {
      res.status(status).json(errorResponse)
    }
  }
}

/**
 * 映射错误类型
 */
function mapErrorType(status) {
  switch (status) {
    case 400: return 'invalid_request_error'
    case 401: return 'authentication_error'
    case 403: return 'permission_error'
    case 404: return 'not_found_error'
    case 429: return 'rate_limit_error'
    case 500: return 'api_error'
    case 503: return 'overloaded_error'
    default: return 'api_error'
  }
}

/**
 * 获取模型列表
 */
async function handleModels(req, res) {
  const traceId = generateTraceId()
  
  try {
    const apiKey = extractApiKey(req)
    const apiKeyData = await apiKeyService.validateApiKey(apiKey)
    if (!apiKeyData) {
      return res.status(401).json({ error: 'Invalid API Key' })
    }

    const accountInfo = await unifiedGeminiScheduler.selectAccountForApiKey(
      apiKeyData,
      null,
      null,
      { preferredOAuthProvider: 'antigravity' }
    )

    if (!accountInfo) {
      return res.status(503).json({ error: 'No accounts available' })
    }

    const account = await prepareAccountDetails(accountInfo, traceId)
    if (!account) {
      return res.status(503).json({ error: 'Account details missing' })
    }

    const models = await httpClient.fetchModels({
      accessToken: account.accessToken,
      proxyConfig: account.proxyConfig
    })

    res.json({
      object: 'list',
      data: models
    })
    
  } catch (error) {
    logger.error(`[AntigravityEnhanced][${traceId}] ❌ 获取模型列表失败: ${error.message}`)
    res.status(500).json({
      error: {
        type: 'api_error',
        message: error.message
      }
    })
  }
}

/**
 * 健康检查
 */
async function healthCheck(req, res) {
  res.json({
    status: 'healthy',
    service: 'antigravity-enhanced',
    version: '1.2.0',
    features: [
      'warmup-interceptor',
      'auto-stream-conversion',
      'background-task-downgrade',
      'multi-strategy-retry',
      'independent-protocol-converter',
      'independent-http-client'
    ],
    timestamp: new Date().toISOString()
  })
}

/**
 * Token 计数处理
 */
async function handleCountTokens(req, res) {
  const traceId = generateTraceId()
  
  try {
    const body = req.body
    if (!body || !body.messages) {
      return res.status(400).json({ error: 'Missing messages' })
    }

    const apiKey = extractApiKey(req)
    const apiKeyData = await apiKeyService.validateApiKey(apiKey)
    
    if (!apiKeyData) {
      return res.status(401).json({ error: 'Invalid API Key' })
    }

    const model = body.model || 'claude-3-5-sonnet-20241022'
    
    const accountInfo = await unifiedGeminiScheduler.selectAccountForApiKey(
      apiKeyData,
      'token-count',
      model,
      { preferredOAuthProvider: 'antigravity' }
    )

    if (!accountInfo) {
      return res.status(503).json({ error: 'No accounts available' })
    }

    const account = await prepareAccountDetails(accountInfo, traceId)
    if (!account) {
      return res.status(503).json({ error: 'Account details missing' })
    }

    // 使用独立的协议转换器
    const { request: geminiRequest } = buildGeminiRequestFromAnthropic(body, model)
    
    const result = await httpClient.countTokens({
      accessToken: account.accessToken,
      proxyConfig: account.proxyConfig,
      contents: geminiRequest.contents,
      model
    })

    res.json(result)
  } catch (error) {
    logger.error(`[AntigravityEnhanced][${traceId}] countTokens 失败:`, error)
    res.status(500).json({ error: error.message })
  }
}

module.exports = {
  handleMessages,
  handleModels,
  handleCountTokens,
  healthCheck
}
