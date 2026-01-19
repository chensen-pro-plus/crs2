/**
 * 多策略退避系统
 * 
 * 根据不同错误类型使用不同的重试策略，提升请求成功率
 */

const logger = require('../../utils/logger')

/**
 * 退避策略类型
 */
const Strategy = {
  NO_RETRY: 'NO_RETRY',           // 不重试
  FIXED: 'FIXED',                 // 固定延迟
  LINEAR: 'LINEAR',               // 线性退避
  EXPONENTIAL: 'EXPONENTIAL'      // 指数退避
}

/**
 * 根据错误状态码确定退避策略
 * @param {number} statusCode - HTTP 状态码
 * @param {string} errorText - 错误文本
 * @returns {Object} 策略配置
 */
function determineStrategy(statusCode, errorText = '') {
  const errorLower = (errorText || '').toLowerCase()
  
  switch (statusCode) {
    // 400: 请求错误，某些情况可以重试
    case 400:
      // Thinking 签名错误 - 短暂延迟后重试
      if (errorLower.includes('signature') || 
          errorLower.includes('thinking') ||
          errorLower.includes('invalid_signature')) {
        return { type: Strategy.FIXED, delay: 200, rotateAccount: false }
      }
      // 其他 400 错误不重试
      return { type: Strategy.NO_RETRY }
    
    // 429: 限流 - 线性退避
    case 429:
      // 尝试解析 Retry-After
      const retryAfterMatch = errorText.match(/retry.{0,10}(\d+)/i)
      if (retryAfterMatch) {
        const seconds = parseInt(retryAfterMatch[1], 10)
        if (seconds > 0 && seconds < 60) {
          return { type: Strategy.FIXED, delay: seconds * 1000, rotateAccount: true }
        }
      }
      return { type: Strategy.LINEAR, baseDelay: 1000, rotateAccount: true }
    
    // 503/529: 服务过载 - 指数退避
    case 503:
    case 529:
      return { type: Strategy.EXPONENTIAL, baseDelay: 1000, maxDelay: 8000, rotateAccount: false }
    
    // 500: 服务器内部错误 - 线性退避
    case 500:
      return { type: Strategy.LINEAR, baseDelay: 500, rotateAccount: true }
    
    // 401/403: 认证失败 - 快速轮换账号
    case 401:
    case 403:
      return { type: Strategy.FIXED, delay: 100, rotateAccount: true }
    
    // 408: 请求超时 - 重试
    case 408:
      return { type: Strategy.FIXED, delay: 500, rotateAccount: false }
    
    // 其他错误不重试
    default:
      return { type: Strategy.NO_RETRY }
  }
}

/**
 * 计算实际延迟时间
 * @param {Object} strategy - 策略配置
 * @param {number} attempt - 当前重试次数 (0-based)
 * @returns {number} 延迟毫秒数
 */
function calculateDelay(strategy, attempt) {
  switch (strategy.type) {
    case Strategy.FIXED:
      return strategy.delay || 1000
    
    case Strategy.LINEAR:
      return (strategy.baseDelay || 1000) * (attempt + 1)
    
    case Strategy.EXPONENTIAL:
      const base = strategy.baseDelay || 1000
      const max = strategy.maxDelay || 10000
      return Math.min(base * Math.pow(2, attempt), max)
    
    default:
      return 0
  }
}

/**
 * 检查是否应该重试
 * @param {Object} strategy - 策略配置
 * @returns {boolean} 是否应该重试
 */
function shouldRetry(strategy) {
  return strategy.type !== Strategy.NO_RETRY
}

/**
 * 重试执行器类
 */
class RetryExecutor {
  /**
   * @param {Object} options - 配置选项
   * @param {number} options.maxAttempts - 最大重试次数 (默认 3)
   * @param {string} options.traceId - 追踪 ID
   */
  constructor({ maxAttempts = 3, traceId = '' } = {}) {
    this.maxAttempts = maxAttempts
    this.traceId = traceId
    this.lastStrategy = null
    this.attemptCount = 0
  }
  
  /**
   * 检查是否应该轮换账号
   * @returns {boolean}
   */
  shouldRotateAccount() {
    return this.lastStrategy?.rotateAccount === true
  }
  
  /**
   * 获取当前重试次数
   * @returns {number}
   */
  getAttemptCount() {
    return this.attemptCount
  }
  
  /**
   * 执行带重试的函数
   * @param {Function} fn - 要执行的异步函数，接收 (attempt, shouldRotate) 参数
   * @returns {Promise} 执行结果
   */
  async execute(fn) {
    let lastError = null
    
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      this.attemptCount = attempt
      
      try {
        const shouldRotate = attempt > 0 && this.shouldRotateAccount()
        return await fn(attempt, shouldRotate)
        
      } catch (error) {
        lastError = error
        
        // 提取状态码和错误文本
        const status = error?.response?.status || 
                       error?.status || 
                       (error?.message?.includes('timeout') ? 408 : 0)
        
        let errorText = ''
        try {
          if (error?.response?.data) {
            // 检查 data 类型，避免序列化流对象导致循环引用错误
            const data = error.response.data
            if (typeof data === 'string') {
              errorText = data
            } else if (Buffer.isBuffer(data)) {
              // Buffer 对象直接转字符串
              errorText = data.toString('utf-8')
            } else if (typeof data === 'object' && data !== null) {
              // 检查是否是流对象（有 pipe 方法的对象不能序列化）
              if (typeof data.pipe === 'function') {
                // 这是一个流对象，不能序列化，使用错误消息代替
                errorText = error?.message || 'Stream response error'
              } else {
                // 普通对象，安全序列化
                errorText = JSON.stringify(data)
              }
            } else {
              errorText = String(data)
            }
          } else {
            errorText = error?.message || ''
          }
        } catch (e) {
          // 序列化失败时的回退处理
          errorText = error?.message || `Serialization failed: ${e.message}`
        }
        
        // 确定策略
        const strategy = determineStrategy(status, errorText)
        this.lastStrategy = strategy
        
        // 🛡️ 检查是否被标记为强制停止重试 (QUOTA_EXHAUSTED 保护)
        if (error.shouldStopRetry === true) {
          logger.warn(`[RetryExecutor][${this.traceId}] 🛡️ 检测到 shouldStopRetry 标志，停止重试`)
          throw error
        }
        
        // 检查是否应该重试
        if (!shouldRetry(strategy)) {
          logger.warn(`[RetryExecutor][${this.traceId}] ❌ 不可重试错误: HTTP ${status}`, {
            errorMessage: error.message,
            errorText: errorText.substring(0, 500)  // 只记录前500字符避免日志过长
          })
          throw error
        }
        
        // 检查是否还有重试机会
        if (attempt + 1 >= this.maxAttempts) {
          logger.warn(`[RetryExecutor][${this.traceId}] ❌ 达到最大重试次数 (${this.maxAttempts})`)
          throw error
        }
        
        // 计算延迟
        const delay = calculateDelay(strategy, attempt)
        
        logger.info(
          `[RetryExecutor][${this.traceId}] ⏱️ 重试 ${attempt + 1}/${this.maxAttempts}, ` +
          `策略: ${strategy.type}, 延迟: ${delay}ms, 轮换账号: ${strategy.rotateAccount}`
        )
        
        // 等待
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    
    throw lastError
  }
}

module.exports = {
  Strategy,
  determineStrategy,
  calculateDelay,
  shouldRetry,
  RetryExecutor
}
