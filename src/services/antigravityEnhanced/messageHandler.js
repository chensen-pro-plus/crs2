/**
 * Antigravity Enhanced 消息处理主逻辑
 * 
 * 集成所有增强功能：
 * - Warmup 请求拦截
 * - 自动 Stream 转换
 * - 后台任务智能降级
 * - 多策略退避重试
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

// 复用原有服务（只读）
const unifiedGeminiScheduler = require('../unifiedGeminiScheduler')
const antigravityClient = require('../antigravityClient')
const apiKeyService = require('../apiKeyService')
const sessionHelper = require('../../utils/sessionHelper')

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
 * 构建请求数据（复用原有逻辑）
 */
function buildRequestData(body, model) {
  return {
    model,
    request: {
      contents: [], // 由 antigravityClient 填充
      ...body
    },
    ...body
  }
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
    const forceStreamInternally = !clientWantsStream
    const actualStream = true // 始终使用流式发送
    
    if (forceStreamInternally) {
      logger.info(`[AntigravityEnhanced][${traceId}] 🔄 自动转换: 非流式 → 流式`)
    }
    
    // ========== 会话哈希（用于粘性调度） ==========
    const sessionHash = sessionHelper.generateSessionHash(body.messages)
    
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
      
      // 获取账号详情（关键：scheduler 只返回 ID）
      const geminiAccountService = require('../geminiAccountService')
      const account = await geminiAccountService.getAccount(accountInfo.accountId)
      
      if (!account) {
        throw new Error(`找不到账号详情: ${accountInfo.accountId}`)
      }
      
      selectedAccount = account
      
      logger.info(
        `[AntigravityEnhanced][${traceId}] 👤 使用账号: ${account.email || account.name || account.id} ` +
        `(attempt ${attempt + 1})`
      )
      
      // 确保 projectId
      const projectId = account.projectId || account.tempProjectId || `ag-${crypto.randomBytes(8).toString('hex')}`
      
      // 发送请求
      const response = await antigravityClient.request({
        accessToken: account.accessToken,
        proxyConfig: typeof account.proxy === 'string' ? JSON.parse(account.proxy) : account.proxy,
        requestData: {
          model,
          request: requestBody
        },
        projectId,
        stream: actualStream,
        params: { alt: 'sse' }, // 对齐 Rust 版参数
        timeoutMs: 600000
      })
      
      return response
    })
    
    // ========== 响应处理 ==========
    const { response } = result
    
    // 设置通用响应头
    res.setHeader('X-Antigravity-Enhanced', 'true')
    res.setHeader('X-Trace-Id', traceId)
    if (selectedAccount) {
      res.setHeader('X-Account-Email', selectedAccount.email || 'unknown')
    }
    
    if (forceStreamInternally) {
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
    
    logger.error(
      `[AntigravityEnhanced][${traceId}] ❌ 请求失败: ${error.message} (${elapsed}ms)`
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
    // 返回支持的模型列表
    const models = [
      { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', description: '最强大的模型' },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', description: '平衡性能和速度' },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '增强版 Sonnet' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Google 旗舰模型' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: '快速响应' },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', description: '轻量级快速' }
    ]
    
    res.json({
      object: 'list',
      data: models.map(m => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'antigravity-enhanced',
        ...m
      }))
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
    version: '1.0.0',
    features: [
      'warmup-interceptor',
      'auto-stream-conversion',
      'background-task-downgrade',
      'multi-strategy-retry'
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

    // 获取 API Key
    const apiKey = extractApiKey(req)
    const apiKeyData = await apiKeyService.validateApiKey(apiKey)
    
    if (!apiKeyData) {
      return res.status(401).json({ error: 'Invalid API Key' })
    }

    const model = body.model || 'claude-sonnet-4'
    
    // 选择账号
    const account = await unifiedGeminiScheduler.selectAccountForApiKey(
      apiKeyData,
      'token-count',
      model,
      { preferredOAuthProvider: 'antigravity' }
    )

    if (!account) {
      return res.status(503).json({ error: 'No accounts available' })
    }

    // 转换消息格式为 Gemini contents
    const anthropicGeminiBridgeService = require('../anthropicGeminiBridgeService')
    const { contents } = anthropicGeminiBridgeService.standardizeMessages(body.messages)

    const result = await antigravityClient.countTokens({
      accessToken: account.accessToken,
      proxyConfig: account.proxyConfig,
      contents,
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
