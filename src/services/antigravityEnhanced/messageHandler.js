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
const { GeminiToClaudeTransformer } = require('./geminiToClaudeTransformer')
const { RetryExecutor } = require('../../utils/antigravityEnhanced/retryStrategy')
const { 
  processBackgroundTaskDowngrade, 
  sanitizeRequestForFlash 
} = require('../../utils/antigravityEnhanced/backgroundDetector')

// 独立模块 (核心: 完全不依赖原有服务)
const { buildGeminiRequestFromAnthropic } = require('./protocolConverter')
const httpClient = require('./httpClient')
const { rateLimitTracker } = require('./rateLimitTracker')
const { mapClaudeModelToGemini } = require('./modelMapping')

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
 * 确保 projectId（异步版本 - 支持动态获取）
 * 如果账号没有存储的 projectId，则调用 loadCodeAssist API 获取
 */
async function ensureProjectId(account, traceId) {
  // 1. 优先使用已存储的 projectId
  if (account.projectId) {
    return account.projectId
  }
  
  // 2. 使用临时 projectId
  if (account.tempProjectId) {
    return account.tempProjectId
  }
  
  // 3. 动态获取：调用 loadCodeAssist API
  logger.info(`[AntigravityEnhanced][${traceId}] 🔄 账号无 projectId，正在调用 loadCodeAssist 获取...`)
  
  const { loadCodeAssist } = require('./httpClient')
  const result = await loadCodeAssist(account.accessToken, account.proxyConfig)
  
  if (result.projectId) {
    logger.info(`[AntigravityEnhanced][${traceId}] ✅ 获取到 projectId: ${result.projectId}`)
    
    // 持久化保存到数据库（参考 Antigravity-Manager2 的实现）
    try {
      const geminiAccountService = require('../geminiAccountService')
      await geminiAccountService.updateAccount(account.id, { projectId: result.projectId })
      logger.info(`[AntigravityEnhanced][${traceId}] 💾 projectId 已保存到数据库`)
    } catch (saveError) {
      logger.warn(`[AntigravityEnhanced][${traceId}] ⚠️ 保存 projectId 失败:`, saveError.message)
    }
    
    // 同时更新内存中的引用，避免同一请求周期内重复获取
    account.projectId = result.projectId
    return result.projectId
  }
  
  // 4. 最后兜底：生成随机 ID（但这通常会导致 429）
  logger.warn(`[AntigravityEnhanced][${traceId}] ⚠️ 无法获取 projectId，使用随机 ID（可能导致 429）`)
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
    
    const apiKeyResult = await apiKeyService.validateApiKey(apiKey)
    if (!apiKeyResult || !apiKeyResult.valid) {
      return res.status(401).json({
        error: {
          type: 'authentication_error',
          message: apiKeyResult?.error || 'API Key 无效'
        }
      })
    }
    
    // 🔧 修复：正确解构 keyData（validateApiKey 返回 {valid, keyData} 结构）
    const apiKeyData = apiKeyResult.keyData
    
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
    
    // 🔧 修复：在账号选择前进行模型映射
    // 确保账号选择使用正确的映射后模型名进行模型支持检查
    // 例如：claude-haiku-4-5-20251001 -> claude-sonnet-4-5
    const mappedModelForScheduling = mapClaudeModelToGemini(model)
    
    const result = await retryExecutor.execute(async (attempt, shouldRotate) => {
      // 选择账号
      let accountInfo
      try {
        accountInfo = await unifiedGeminiScheduler.selectAccountForApiKey(
          apiKeyData,
          sessionHash,
          mappedModelForScheduling,
          { 
            preferredOAuthProvider: 'antigravity',
            forceRotate: shouldRotate
          }
        )
      } catch (error) {
        // 捕获 "No available Gemini accounts" 错误，尝试乐观重置
        // 🔧 与 Antigravity-Manager2 对齐：不再检查 minWait，直接尝试乐观重置
        if (error.message.includes('No available Gemini accounts')) {
          logger.warn(
            `[AntigravityEnhanced][${traceId}] ⚠️ 所有账号不可用，尝试缓冲延迟...`
          )
          
          // Layer 1: 缓冲延迟 500ms（可能是时序竞争导致的状态不同步）
          await new Promise(resolve => setTimeout(resolve, 500))
          
          try {
            // 重试选择账号
            accountInfo = await unifiedGeminiScheduler.selectAccountForApiKey(
              apiKeyData,
              sessionHash,
              mappedModelForScheduling,
              { preferredOAuthProvider: 'antigravity', forceRotate: shouldRotate }
            )
            logger.info(`[AntigravityEnhanced][${traceId}] ✅ 缓冲延迟后成功获取账号`)
          } catch (retryError) {
            // Layer 2: 缓冲后仍无可用账号，执行乐观重置
            logger.warn(
              `[AntigravityEnhanced][${traceId}] ⚠️ 缓冲延迟失败，执行乐观重置 (Clear All)...`
            )
            
            // 🔧 只清除内存中的限流记录，不再清除数据库状态
            rateLimitTracker.clearAll()
            
            // 再次重试选择账号
            accountInfo = await unifiedGeminiScheduler.selectAccountForApiKey(
              apiKeyData,
              sessionHash,
              mappedModelForScheduling,
              { preferredOAuthProvider: 'antigravity', forceRotate: shouldRotate }
            )
            logger.info(`[AntigravityEnhanced][${traceId}] ✅ 乐观重置后成功获取账号`)
          }
        } else {
          // 其他错误直接抛出
          throw error
        }
      }
      
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
      
      // 确保 projectId（异步获取，如果账号没有则调用 loadCodeAssist）
      const projectId = await ensureProjectId(account, traceId)
      
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
      try {
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
        
        // ✅ 请求成功，重置该账号的失败计数
        logger.debug(
          `[AntigravityEnhanced][${traceId}] ✅ 请求成功，调用 markSuccess 重置账号 ${accountInfo.accountId} 的失败计数`
        )
        rateLimitTracker.markSuccess(accountInfo.accountId)
        
        return { response, account }
      } catch (httpError) {
        // ========== 增强：使用限流追踪器解析限流信息 ==========
        const rateLimitInfo = httpError?.rateLimitInfo || {}
        const errorStatus = rateLimitInfo.status || httpError?.response?.status || httpError?.status
        
        logger.debug(
          `[AntigravityEnhanced][${traceId}] 🔍 捕获到 HTTP 错误:`,
          {
            status: errorStatus,
            hasRateLimitInfo: !!httpError?.rateLimitInfo,
            retryAfter: rateLimitInfo.retryAfter,
            errorBodyLength: rateLimitInfo.errorBody?.length || 0
          }
        )
        
        // 只处理 429/5xx 错误
        if (errorStatus === 429 || errorStatus === 500 || errorStatus === 503 || errorStatus === 529) {
          logger.info(
            `[AntigravityEnhanced][${traceId}] 📊 检测到限流/服务器错误 (${errorStatus})，开始解析...`
          )
          
          // 解析限流原因和持续时间
          const parseResult = rateLimitTracker.parseFromError(
            accountInfo.accountId,
            errorStatus,
            rateLimitInfo.retryAfter,
            rateLimitInfo.errorBody || '',
            effectiveModel
          )
          
          if (parseResult) {
            logger.warn(
              `[AntigravityEnhanced][${traceId}] ⚠️ 账号 ${account.email || account.id} ` +
              `限流类型: ${parseResult.reason}, 锁定 ${parseResult.retryAfterSec}秒`
            )
            
            // 🔧 与 Antigravity-Manager2 对齐：只使用内存限流，不再标记数据库状态
            // rateLimitTracker.parseFromError 已经在内存中记录了限流状态
            // 删除 session 映射，让下次请求选择新账号
            if (sessionHash) {
              unifiedGeminiScheduler._deleteSessionMapping(sessionHash).catch(err => {
                logger.error(`[AntigravityEnhanced][${traceId}] ❌ 删除会话映射失败:`, err.message)
              })
            }
            
            // 🛡️ QUOTA_EXHAUSTED 保护：停止重试，保护账号池
            if (parseResult.shouldStop) {
              logger.error(
                `[AntigravityEnhanced][${traceId}] 🛡️ 检测到 QUOTA_EXHAUSTED，停止重试保护账号池`
              )
              // 标记错误为不可重试
              httpError.shouldStopRetry = true
            }
          }
        }
        
        // 重新抛出错误，让 RetryExecutor 处理
        throw httpError
      }
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
      const inputTokens = jsonResponse.usage?.input_tokens || 0
      const outputTokens = jsonResponse.usage?.output_tokens || 0
      const cacheReadTokens = jsonResponse.usage?.cache_read_input_tokens || 0
      
      logger.info(
        `[AntigravityEnhanced][${traceId}] ✅ 请求完成: ${elapsed}ms, ` +
        `tokens: ${inputTokens}/${outputTokens}`
      )
      
      // 🔧 修复：记录 token 消耗到数据库
      if (apiKeyData?.id && (inputTokens > 0 || outputTokens > 0)) {
        apiKeyService.recordUsage(
          apiKeyData.id,
          inputTokens,
          outputTokens,
          0,  // cache_creation_input_tokens
          cacheReadTokens,
          model,
          selectedAccount?.id || null
        ).catch(err => {
          logger.error(`[AntigravityEnhanced][${traceId}] ❌ 记录 usage 失败:`, err.message)
        })
      }
      
      res.setHeader('Content-Type', 'application/json')
      return res.json(jsonResponse)
    }
    
    // 使用转换器将 Gemini SSE 转换为 Claude SSE 格式
    logger.info(`[AntigravityEnhanced][${traceId}] 📡 转发流响应 (带格式转换)...`)
    
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    
    // 创建 Gemini → Claude 转换器
    const transformer = new GeminiToClaudeTransformer(traceId)
    
    // 通过转换器处理流
    response.data.pipe(transformer).pipe(res)
    
    // 🔧 修复：在流结束时记录 token 消耗
    transformer.on('finish', () => {
      const elapsed = Date.now() - startTime
      const usage = transformer.finalUsage
      
      logger.info(
        `[AntigravityEnhanced][${traceId}] ✅ 流响应完成: ${elapsed}ms, ` +
        `tokens: ${usage.input_tokens}/${usage.output_tokens}`
      )
      
      // 🔍 调试日志
      logger.info(`[AntigravityEnhanced][${traceId}] 📋 apiKeyData.id=${apiKeyData?.id}, tokens=${usage.input_tokens}/${usage.output_tokens}`)
      
      // 记录 token 消耗到数据库
      if (apiKeyData?.id && (usage.input_tokens > 0 || usage.output_tokens > 0)) {
        apiKeyService.recordUsage(
          apiKeyData.id,
          usage.input_tokens,
          usage.output_tokens,
          0,  // cache_creation_input_tokens
          usage.cache_read_input_tokens,
          model,
          selectedAccount?.id || null
        ).catch(err => {
          logger.error(`[AntigravityEnhanced][${traceId}] ❌ 记录 usage 失败:`, err.message)
        })
      }
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
 * 
 * 参考 Antigravity-Manager2 的做法：直接返回占位符值
 * 原因：Gemini/Antigravity API 的 countTokens 端点可能不存在或返回 404
 * 这不影响主要功能，仅用于 CLI 显示估算 token 数量
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

    // [快速修复] 直接返回占位符值，不调用真实 API
    // 参考: Antigravity-Manager2/src-tauri/src/proxy/handlers/claude.rs handle_count_tokens
    logger.debug(`[AntigravityEnhanced][${traceId}] countTokens 返回占位符值（API 不支持）`)
    
    res.json({
      input_tokens: 0,
      output_tokens: 0
    })
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
