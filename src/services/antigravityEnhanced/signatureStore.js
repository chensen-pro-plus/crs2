/**
 * Signature Store - 全局签名存储和缓存
 * 
 * 参考: Antigravity-Manager2/src-tauri/src/proxy/mappers/signature_store.rs
 * 参考: Antigravity-Manager2/src-tauri/src/proxy/signature_cache.rs
 * 
 * 功能：
 * 1. 全局存储最新的 thought_signature（更长的覆盖更短的）
 * 2. 缓存 tool_use_id → signature 映射（用于签名恢复）
 * 3. TTL = 2 小时
 */

const logger = require('../../utils/logger')

// 常量
const SIGNATURE_TTL = 2 * 60 * 60 * 1000  // 2 hours in ms
const MIN_SIGNATURE_LENGTH = 50  // 如 Rust 版本

/**
 * 缓存条目
 */
class CacheEntry {
  constructor(data) {
    this.data = data
    this.timestamp = Date.now()
  }

  isExpired() {
    return Date.now() - this.timestamp > SIGNATURE_TTL
  }
}

/**
 * Signature Store 单例
 * 
 * 实现双层缓存：
 * - Layer 1: 全局 thought_signature
 * - Layer 2: tool_use_id → signature 映射
 */
class SignatureStore {
  constructor() {
    // 全局签名（最新的、最长的）
    this.globalSignature = null
    this.globalSignatureTime = null

    // 工具签名缓存: tool_use_id → CacheEntry<signature>
    this.toolSignatures = new Map()

    // 定期清理过期条目
    this._startCleanupTask()
  }

  /**
   * 存储全局签名
   * 只有更长的签名才会覆盖现有签名（参考 Rust 版本）
   */
  store(signature) {
    if (!signature || typeof signature !== 'string') return
    if (signature.length < MIN_SIGNATURE_LENGTH) {
      logger.debug(`[SignatureStore] 跳过太短的签名 (length=${signature.length})`)
      return
    }

    const shouldStore = !this.globalSignature || signature.length > this.globalSignature.length

    if (shouldStore) {
      const oldLength = this.globalSignature?.length || 0
      logger.debug(`[SignatureStore] 存储全局签名 (new=${signature.length}, old=${oldLength})`)
      this.globalSignature = signature
      this.globalSignatureTime = Date.now()
    } else {
      logger.debug(`[SignatureStore] 跳过更短的签名 (new=${signature.length}, existing=${this.globalSignature.length})`)
    }
  }

  /**
   * 获取全局签名
   */
  get() {
    if (!this.globalSignature) return null
    
    // 检查 TTL
    if (this.globalSignatureTime && Date.now() - this.globalSignatureTime > SIGNATURE_TTL) {
      logger.debug('[SignatureStore] 全局签名已过期，清除')
      this.globalSignature = null
      this.globalSignatureTime = null
      return null
    }

    return this.globalSignature
  }

  /**
   * 缓存工具签名
   * Layer 2: tool_use_id → signature
   */
  cacheToolSignature(toolId, signature) {
    if (!toolId || !signature) return
    if (signature.length < MIN_SIGNATURE_LENGTH) return

    logger.debug(`[SignatureStore] 缓存工具签名: ${toolId} (sig length=${signature.length})`)
    this.toolSignatures.set(toolId, new CacheEntry(signature))

    // 超过 1000 条时清理
    if (this.toolSignatures.size > 1000) {
      this._cleanup()
    }
  }

  /**
   * 获取工具签名
   */
  getToolSignature(toolId) {
    if (!toolId) return null

    const entry = this.toolSignatures.get(toolId)
    if (!entry) return null

    if (entry.isExpired()) {
      this.toolSignatures.delete(toolId)
      return null
    }

    logger.debug(`[SignatureStore] 命中工具签名: ${toolId}`)
    return entry.data
  }

  /**
   * 清除所有缓存
   */
  clear() {
    this.globalSignature = null
    this.globalSignatureTime = null
    this.toolSignatures.clear()
    logger.debug('[SignatureStore] 清除所有缓存')
  }

  /**
   * 清理过期条目
   */
  _cleanup() {
    let removed = 0
    for (const [id, entry] of this.toolSignatures) {
      if (entry.isExpired()) {
        this.toolSignatures.delete(id)
        removed++
      }
    }
    if (removed > 0) {
      logger.debug(`[SignatureStore] 清理了 ${removed} 个过期条目`)
    }
  }

  /**
   * 启动定期清理任务
   */
  _startCleanupTask() {
    // 每 30 分钟清理一次
    setInterval(() => {
      this._cleanup()
    }, 30 * 60 * 1000)
  }
}

// 导出单例
module.exports = new SignatureStore()
