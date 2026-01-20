/**
 * 限流追踪模块
 * 
 * 参考 Antigravity-Manager2/src-tauri/src/proxy/rate_limit.rs 实现
 * 提供智能限流检测、指数退避、错误解析等功能
 */

const logger = require('../../utils/logger')

// ============================================================================
// 限流原因枚举
// ============================================================================

/**
 * 限流原因类型
 * @enum {string}
 */
const RateLimitReason = {
  /** 配额耗尽 (QUOTA_EXHAUSTED) - 通常需要等待数小时 */
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  /** 速率限制 (RATE_LIMIT_EXCEEDED) - 短暂的每分钟限制 */
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  /** 模型容量耗尽 (MODEL_CAPACITY_EXHAUSTED) - 服务端暂无GPU实例 */
  MODEL_CAPACITY_EXHAUSTED: 'MODEL_CAPACITY_EXHAUSTED',
  /** 服务器错误 (5xx) - 后端故障软避让 */
  SERVER_ERROR: 'SERVER_ERROR',
  /** 未知原因 */
  UNKNOWN: 'UNKNOWN'
}

// ============================================================================
// 限流追踪器
// ============================================================================

/**
 * 限流追踪器类
 * 管理账号的限流状态、失败计数和智能退避
 */
class RateLimitTracker {
  constructor() {
    /** @type {Map<string, {resetTime: number, reason: string, retryAfterSec: number}>} */
    this.limits = new Map()
    /** @type {Map<string, number>} 连续失败计数 */
    this.failureCounts = new Map()
    /** @type {Set<string>} 记录已尝试清理数据库限流状态的账号 */
    this.dbClearAttempted = new Set()
  }

  /**
   * 标记账号请求成功，重置连续失败计数
   * 
   * 当账号成功完成请求后调用此方法，将其失败计数归零，
   * 这样下次失败时会从最短的锁定时间开始。
   * 参考 Rust 版 rate_limit.rs 的 mark_success 方法
   * 
   * @param {string} accountId - 账号 ID
   */
  markSuccess(accountId) {
    const hadFailures = this.failureCounts.has(accountId)
    const hadLimits = this.limits.has(accountId)
    
    // 清除失败计数
    this.failureCounts.delete(accountId)
    // 同时清除限流记录（如果有）
    this.limits.delete(accountId)
    
    if (hadFailures || hadLimits) {
      logger.debug(`[RateLimitTracker] ✅ 账号 ${accountId} 请求成功，已重置失败计数和限流记录`)
    }
    
    const shouldClearDb = hadFailures || hadLimits || !this.dbClearAttempted.has(accountId)
    if (shouldClearDb) {
      this.dbClearAttempted.add(accountId)
      // 🔧 清除数据库限流状态（最佳努力，避免每次成功都写库）
      this._clearFromDatabase(accountId)
    }
  }

  /**
   * 从错误响应解析限流信息
   * 
   * @param {string} accountId - 账号 ID
   * @param {number} status - HTTP 状态码
   * @param {string|null} retryAfterHeader - Retry-After header 值
   * @param {string} body - 错误响应 body
   * @param {string|null} model - 模型名称 (可选)
   * @returns {{reason: string, retryAfterSec: number, shouldStop: boolean}|null}
   */
  parseFromError(accountId, status, retryAfterHeader, body, model = null) {
    logger.debug(
      `[RateLimitTracker] 🔍 parseFromError 调用:`,
      {
        accountId,
        status,
        retryAfterHeader,
        bodyLength: body?.length || 0,
        model
      }
    )
    
    // 只处理 429 (限流) 以及 500/503/529 (后端故障软避让)
    if (status !== 429 && status !== 500 && status !== 503 && status !== 529) {
      logger.debug(`[RateLimitTracker] 状态码 ${status} 不在处理范围，返回 null`)
      return null
    }

    // 1. 解析限流原因类型
    let reason
    if (status === 429) {
      logger.warn(`[RateLimitTracker] Google 429 Error Body: ${body?.substring(0, 500)}`)
      reason = this._parseRateLimitReason(body)
      logger.info(`[RateLimitTracker] 解析得到的限流原因: ${reason}`)
    } else {
      reason = RateLimitReason.SERVER_ERROR
      logger.info(`[RateLimitTracker] 5xx 错误，设置原因为: ${reason}`)
    }

    // 2. 解析重试时间
    let retryAfterSec = null

    // 优先从 Retry-After header 提取
    if (retryAfterHeader) {
      const parsed = parseInt(retryAfterHeader, 10)
      if (!isNaN(parsed)) {
        retryAfterSec = parsed
        logger.debug(`[RateLimitTracker] 从 Retry-After header 解析到: ${retryAfterSec}秒`)
      }
    }

    // 从错误消息 body 提取
    if (retryAfterSec === null && body) {
      retryAfterSec = this._parseRetryTimeFromBody(body)
      if (retryAfterSec !== null) {
        logger.debug(`[RateLimitTracker] 从错误 Body 解析到重试时间: ${retryAfterSec}秒`)
      }
    }

    // 3. 应用默认值与指数退避逻辑
    if (retryAfterSec === null) {
      // 获取连续失败次数
      const failureCount = (this.failureCounts.get(accountId) || 0) + 1
      this.failureCounts.set(accountId, failureCount)
      
      logger.info(`[RateLimitTracker] 无明确重试时间，账号 ${accountId} 连续失败次数: ${failureCount}，应用指数退避`)

      retryAfterSec = this._getDefaultRetryTime(reason, failureCount)
    } else {
      // 有明确的重试时间，引入最小 2 秒安全缓冲区
      if (retryAfterSec < 2) {
        logger.debug(`[RateLimitTracker] 重试时间 ${retryAfterSec}秒 太短，调整为 2秒`)
        retryAfterSec = 2
      }
    }

    // 4. 存储限流信息
    const resetTime = Date.now() + retryAfterSec * 1000
    this.limits.set(accountId, {
      resetTime,
      reason,
      retryAfterSec,
      model
    })

    logger.warn(
      `[RateLimitTracker] 账号 ${accountId} [${status}] 限流类型: ${reason}, 重置延时: ${retryAfterSec}秒`
    )

    // 5. 判断是否应该停止重试
    // QUOTA_EXHAUSTED 时停止重试，保护账号池
    const shouldStop = reason === RateLimitReason.QUOTA_EXHAUSTED

    // 6. 🔧 持久化到数据库（异步，不阻塞返回）
    this._persistToDatabase(accountId, reason, retryAfterSec)

    return { reason, retryAfterSec, shouldStop }
  }

  /**
   * 解析限流原因类型
   * @private
   */
  _parseRateLimitReason(body) {
    if (!body) return RateLimitReason.UNKNOWN

    // 尝试从 JSON 中提取 reason 字段
    try {
      const trimmed = body.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const json = JSON.parse(trimmed)
        
        // 路径: error.details[0].reason
        const reasonStr = json?.error?.details?.[0]?.reason
        if (reasonStr) {
          switch (reasonStr) {
            case 'QUOTA_EXHAUSTED': return RateLimitReason.QUOTA_EXHAUSTED
            case 'RATE_LIMIT_EXCEEDED': return RateLimitReason.RATE_LIMIT_EXCEEDED
            case 'MODEL_CAPACITY_EXHAUSTED': return RateLimitReason.MODEL_CAPACITY_EXHAUSTED
            default: break
          }
        }

        // 尝试从 message 字段进行文本匹配
        const msg = json?.error?.message?.toLowerCase() || ''
        if (msg.includes('per minute') || msg.includes('rate limit')) {
          return RateLimitReason.RATE_LIMIT_EXCEEDED
        }
      }
    } catch (e) {
      // JSON 解析失败，继续使用文本匹配
    }

    // 从消息文本判断
    const bodyLower = body.toLowerCase()
    // 优先判断分钟级限制，避免将 TPM 误判为 Quota
    if (bodyLower.includes('per minute') || bodyLower.includes('rate limit') || bodyLower.includes('too many requests')) {
      return RateLimitReason.RATE_LIMIT_EXCEEDED
    } 
    // 注意：capacity 要优先于 exhausted 判断！
    // 因为 "No capacity available" 的通用错误消息可能包含 "exhausted"
    else if (bodyLower.includes('capacity') || bodyLower.includes('no capacity')) {
      return RateLimitReason.MODEL_CAPACITY_EXHAUSTED
    } 
    // 🛡️ 特殊处理：Google 通用错误 "Resource has been exhausted (e.g. check quota)."
    // 这不是真正的配额耗尽，"e.g. check quota" 只是示例文本
    // 这种通用错误通常出现在备用端点，应该当作临时问题处理
    else if (bodyLower.includes('e.g. check quota') || bodyLower.includes('(e.g.')) {
      logger.info(`[RateLimitTracker] 检测到 Google 通用错误消息，当作临时容量问题处理`)
      return RateLimitReason.MODEL_CAPACITY_EXHAUSTED
    }
    // 只有明确提到 quota（且不是示例文本）才认为是配额问题
    else if (bodyLower.includes('quota')) {
      return RateLimitReason.QUOTA_EXHAUSTED
    } else if (bodyLower.includes('exhausted')) {
      // exhausted 放最后，作为兜底，但默认当作临时容量问题
      // 因为无法确定是配额还是容量问题时，容量问题更常见且恢复更快
      return RateLimitReason.MODEL_CAPACITY_EXHAUSTED
    }

    return RateLimitReason.UNKNOWN
  }

  /**
   * 通用时间解析函数：支持 "2h1m1s" 等格式
   * @private
   */
  _parseDurationString(s) {
    if (!s) return null

    // 使用正则表达式提取小时、分钟、秒、毫秒
    // 支持格式："2h1m1s", "1h30m", "5m", "30s", "500ms" 等
    const match = s.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?/)
    if (!match) return null

    const hours = parseInt(match[1] || '0', 10)
    const minutes = parseInt(match[2] || '0', 10)
    const seconds = parseFloat(match[3] || '0')
    const milliseconds = parseInt(match[4] || '0', 10)

    const totalSeconds = hours * 3600 + minutes * 60 + Math.ceil(seconds) + Math.ceil(milliseconds / 1000)

    if (totalSeconds === 0) return null

    logger.info(`[RateLimitTracker] 时间解析: '${s}' => ${totalSeconds}秒 (${hours}h ${minutes}m ${seconds}s)`)
    return totalSeconds
  }

  /**
   * 从错误消息 body 中解析重置时间
   * @private
   */
  _parseRetryTimeFromBody(body) {
    if (!body) return null

    // A. 优先尝试 JSON 精准解析
    try {
      const trimmed = body.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const json = JSON.parse(trimmed)

        // 1. Google 常见的 quotaResetDelay 格式
        // 路径: error.details[0].metadata.quotaResetDelay
        const delayStr = json?.error?.details?.[0]?.metadata?.quotaResetDelay
        if (delayStr) {
          logger.debug(`[RateLimitTracker] 找到 quotaResetDelay: '${delayStr}'`)
          const seconds = this._parseDurationString(delayStr)
          if (seconds) return seconds
        }

        // 2. OpenAI 常见的 retry_after 字段
        const retryAfter = json?.error?.retry_after
        if (typeof retryAfter === 'number') {
          return retryAfter
        }
      }
    } catch (e) {
      // JSON 解析失败，继续使用正则匹配
    }

    // B. 正则匹配模式 (兜底)
    const patterns = [
      // "Try again in 2m 30s"
      { regex: /try again in (\d+)m\s*(\d+)s/i, calc: (m) => parseInt(m[1]) * 60 + parseInt(m[2]) },
      // "Try again in 30s" 或 "backoff for 42s"
      { regex: /(?:try again in|backoff for|wait)\s*(\d+)s/i, calc: (m) => parseInt(m[1]) },
      // "quota will reset in X seconds"
      { regex: /quota will reset in (\d+) second/i, calc: (m) => parseInt(m[1]) },
      // "Retry after 99 seconds"
      { regex: /retry after (\d+) second/i, calc: (m) => parseInt(m[1]) },
      // "(wait 42s)"
      { regex: /\(wait (\d+)s\)/i, calc: (m) => parseInt(m[1]) }
    ]

    for (const { regex, calc } of patterns) {
      const match = body.match(regex)
      if (match) {
        return calc(match)
      }
    }

    return null
  }

  /**
   * 根据限流类型和失败次数获取默认重试时间
   * @private
   */
  _getDefaultRetryTime(reason, failureCount) {
    switch (reason) {
      case RateLimitReason.QUOTA_EXHAUSTED:
        // 智能指数退避：第1次 60s, 第2次 5min, 第3次 30min, 第4次+ 2h
        if (failureCount === 1) {
          logger.warn(`[RateLimitTracker] 检测到配额耗尽，第1次失败，锁定 60秒`)
          return 60
        } else if (failureCount === 2) {
          logger.warn(`[RateLimitTracker] 检测到配额耗尽，第2次连续失败，锁定 5分钟`)
          return 300
        } else if (failureCount === 3) {
          logger.warn(`[RateLimitTracker] 检测到配额耗尽，第3次连续失败，锁定 30分钟`)
          return 1800
        } else {
          logger.warn(`[RateLimitTracker] 检测到配额耗尽，第${failureCount}次连续失败，锁定 2小时`)
          return 7200
        }

      case RateLimitReason.RATE_LIMIT_EXCEEDED:
        // 速率限制：通常是短暂的，使用 30秒 (与 Rust 版对齐)
        logger.debug(`[RateLimitTracker] 检测到速率限制，30秒后重试`)
        return 30

      case RateLimitReason.MODEL_CAPACITY_EXHAUSTED:
        // 模型容量耗尽：服务端暂时无可用 GPU 实例
        // 这是临时性问题，使用 15秒 (与 Rust 版对齐)
        logger.warn(`[RateLimitTracker] 检测到模型容量不足，15秒后重试`)
        return 15

      case RateLimitReason.SERVER_ERROR:
        // 服务器错误：软避让 20秒
        logger.warn(`[RateLimitTracker] 检测到 5xx 错误，执行 20s 软避让`)
        return 20

      default:
        // 未知原因：60秒
        logger.debug(`[RateLimitTracker] 无法解析限流原因，使用默认值 60秒`)
        return 60
    }
  }

  /**
   * 检查账号是否仍在限流中
   * @param {string} accountId
   * @returns {boolean}
   */
  isRateLimited(accountId) {
    const info = this.limits.get(accountId)
    if (!info) return false
    return info.resetTime > Date.now()
  }

  /**
   * 获取账号剩余等待时间 (秒)
   * @param {string} accountId
   * @returns {number}
   */
  getRemainingWait(accountId) {
    const info = this.limits.get(accountId)
    if (!info) return 0
    const remaining = Math.ceil((info.resetTime - Date.now()) / 1000)
    return remaining > 0 ? remaining : 0
  }

  /**
   * 获取账号的限流信息
   * @param {string} accountId
   * @returns {{resetTime: number, reason: string, retryAfterSec: number}|null}
   */
  getInfo(accountId) {
    return this.limits.get(accountId) || null
  }

  /**
   * 清除指定账号的限流记录
   * @param {string} accountId
   * @returns {boolean}
   */
  clear(accountId) {
    return this.limits.delete(accountId)
  }

  /**
   * 获取所有被限流账号中的最短等待时间（秒）
   * 用于乐观重置决策
   * @returns {number|null} 最短等待时间（秒），如果没有限流账号返回 null
   */
  getMinResetSeconds() {
    const now = Date.now()
    let minWait = null
    
    for (const [, info] of this.limits.entries()) {
      const remainingMs = info.resetTime - now
      if (remainingMs > 0) {
        const remainingSec = Math.ceil(remainingMs / 1000)
        if (minWait === null || remainingSec < minWait) {
          minWait = remainingSec
        }
      }
    }
    
    return minWait
  }

  /**
   * 清除过期的限流记录
   * @returns {number} 清除的记录数
   */
  cleanupExpired() {
    const now = Date.now()
    let count = 0
    for (const [id, info] of this.limits.entries()) {
      if (info.resetTime <= now) {
        this.limits.delete(id)
        count++
      }
    }
    if (count > 0) {
      logger.debug(`[RateLimitTracker] 清除了 ${count} 个过期的限流记录`)
    }
    return count
  }

  /**
   * 清除所有限流记录 (乐观重置策略)
   * 🔧 同时清除数据库中的限流状态
   */
  clearAll() {
    const count = this.limits.size
    const accountIds = Array.from(this.limits.keys())
    
    this.limits.clear()
    this.failureCounts.clear()
    logger.warn(`[RateLimitTracker] 🔄 乐观重置: 清除了 ${count} 个限流记录`)
    
    // 🔧 同步清除数据库中的限流状态
    if (accountIds.length > 0) {
      for (const accountId of accountIds) {
        this._clearFromDatabase(accountId)
      }
    }
  }

  // ============================================================================
  // 数据库持久化方法
  // ============================================================================

  /**
   * 持久化限流状态到数据库
   * 异步执行，不影响主流程
   * @private
   */
  _persistToDatabase(accountId, reason, retryAfterSec) {
    // 延迟加载避免循环依赖
    const geminiAccountService = require('../geminiAccountService')
    
    // 异步执行，不阻塞返回
    geminiAccountService.setAccountRateLimitedWithDetails(accountId, {
      reason,
      retryAfterSec,
      rateLimitEndAt: new Date(Date.now() + retryAfterSec * 1000).toISOString()
    }).then(() => {
      logger.debug(`[RateLimitTracker] 📊 限流状态已持久化到数据库: ${accountId}`)
    }).catch(err => {
      logger.warn(`[RateLimitTracker] 持久化限流状态失败: ${err.message}`)
    })
  }

  /**
   * 清除数据库中的限流状态
   * 异步执行，不影响主流程
   * @private
   */
  _clearFromDatabase(accountId) {
    // 延迟加载避免循环依赖
    const geminiAccountService = require('../geminiAccountService')
    
    // 异步执行，不阻塞返回
    geminiAccountService.clearAccountRateLimit(accountId).then(() => {
      logger.debug(`[RateLimitTracker] ✅ 数据库限流状态已清除: ${accountId}`)
    }).catch(err => {
      logger.warn(`[RateLimitTracker] 清除数据库限流状态失败: ${err.message}`)
    })
  }
}

// 单例实例
const rateLimitTracker = new RateLimitTracker()

module.exports = {
  RateLimitReason,
  RateLimitTracker,
  rateLimitTracker
}
