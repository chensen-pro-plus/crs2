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
 * 作用域缓存
 */
class ScopeCache {
  constructor() {
    // 全局签名（最新的、最长的）
    this.globalSignature = null
    this.globalSignatureTime = null

    // 工具签名缓存: tool_use_id → CacheEntry<signature>
    this.toolSignatures = new Map()

    // 签名对应的模型家族: signature → CacheEntry<family>
    this.signatureFamilies = new Map()
  }
}

/**
 * Signature Store 单例
 * 
 * 实现双层缓存：
 * - Layer 1: 全局 thought_signature
 * - Layer 2: tool_use_id → signature 映射
 * - Layer 3: signature → model family 映射
 */
class SignatureStore {
  constructor() {
    // 作用域缓存: scopeKey → ScopeCache
    this.scopes = new Map()

    // 定期清理过期条目
    this._startCleanupTask()
  }

  _getScopeKey(scopeKey) {
    return scopeKey || 'global'
  }

  _getScope(scopeKey) {
    const key = this._getScopeKey(scopeKey)
    let scope = this.scopes.get(key)
    if (!scope) {
      scope = new ScopeCache()
      this.scopes.set(key, scope)
    }
    return scope
  }

  _getScopeIfExists(scopeKey) {
    const key = this._getScopeKey(scopeKey)
    return this.scopes.get(key) || null
  }

  /**
   * 存储全局签名
   * 只有更长的签名才会覆盖现有签名（参考 Rust 版本）
   */
  store(signature, scopeKey = null) {
    if (!signature || typeof signature !== 'string') return
    if (signature.length < MIN_SIGNATURE_LENGTH) {
      logger.debug(`[SignatureStore] 跳过太短的签名 (length=${signature.length})`)
      return
    }

    const scope = this._getScope(scopeKey)
    const shouldStore = !scope.globalSignature || signature.length > scope.globalSignature.length

    if (shouldStore) {
      const oldLength = scope.globalSignature?.length || 0
      logger.debug(`[SignatureStore] 存储全局签名 (new=${signature.length}, old=${oldLength})`)
      scope.globalSignature = signature
      scope.globalSignatureTime = Date.now()
    } else {
      logger.debug(`[SignatureStore] 跳过更短的签名 (new=${signature.length}, existing=${scope.globalSignature.length})`)
    }
  }

  /**
   * 获取全局签名
   */
  get(scopeKey = null) {
    const scope = this._getScopeIfExists(scopeKey)
    if (!scope || !scope.globalSignature) return null
    
    // 检查 TTL
    if (scope.globalSignatureTime && Date.now() - scope.globalSignatureTime > SIGNATURE_TTL) {
      logger.debug('[SignatureStore] 全局签名已过期，清除')
      scope.globalSignature = null
      scope.globalSignatureTime = null
      return null
    }

    return scope.globalSignature
  }

  /**
   * 缓存工具签名
   * Layer 2: tool_use_id → signature
   */
  cacheToolSignature(toolId, signature, scopeKey = null) {
    if (!toolId || !signature) return
    if (signature.length < MIN_SIGNATURE_LENGTH) return

    const scope = this._getScope(scopeKey)
    logger.debug(`[SignatureStore] 缓存工具签名: ${toolId} (sig length=${signature.length})`)
    scope.toolSignatures.set(toolId, new CacheEntry(signature))

    // 超过 1000 条时清理
    if (scope.toolSignatures.size > 1000) {
      this._cleanup()
    }
  }

  /**
   * 获取工具签名
   */
  getToolSignature(toolId, scopeKey = null) {
    if (!toolId) return null

    const scope = this._getScopeIfExists(scopeKey)
    if (!scope) return null

    const entry = scope.toolSignatures.get(toolId)
    if (!entry) return null

    if (entry.isExpired()) {
      scope.toolSignatures.delete(toolId)
      return null
    }

    logger.debug(`[SignatureStore] 命中工具签名: ${toolId}`)
    return entry.data
  }

  /**
   * 缓存签名对应的模型家族
   */
  cacheSignatureFamily(signature, family, scopeKey = null) {
    if (!signature || !family) return
    if (signature.length < MIN_SIGNATURE_LENGTH) return

    const scope = this._getScope(scopeKey)
    scope.signatureFamilies.set(signature, new CacheEntry(family))
  }

  /**
   * 获取签名对应的模型家族
   */
  getSignatureFamily(signature, scopeKey = null) {
    if (!signature) return null

    const scope = this._getScopeIfExists(scopeKey)
    if (!scope) return null

    const entry = scope.signatureFamilies.get(signature)
    if (!entry) return null

    if (entry.isExpired()) {
      scope.signatureFamilies.delete(signature)
      return null
    }

    return entry.data
  }

  /**
   * 清除所有缓存
   */
  clear(scopeKey = null) {
    if (scopeKey) {
      const scope = this._getScopeIfExists(scopeKey)
      if (scope) {
        scope.globalSignature = null
        scope.globalSignatureTime = null
        scope.toolSignatures.clear()
        scope.signatureFamilies.clear()
      }
      return
    }

    this.scopes.clear()
    logger.debug('[SignatureStore] 清除所有缓存')
  }

  /**
   * 清理过期条目
   */
  _cleanup() {
    let removed = 0
    for (const [scopeKey, scope] of this.scopes.entries()) {
      for (const [id, entry] of scope.toolSignatures.entries()) {
        if (entry.isExpired()) {
          scope.toolSignatures.delete(id)
          removed++
        }
      }

      for (const [sig, entry] of scope.signatureFamilies.entries()) {
        if (entry.isExpired()) {
          scope.signatureFamilies.delete(sig)
          removed++
        }
      }

      if (
        scope.globalSignatureTime &&
        Date.now() - scope.globalSignatureTime > SIGNATURE_TTL
      ) {
        scope.globalSignature = null
        scope.globalSignatureTime = null
      }

      const hasData =
        scope.globalSignature ||
        scope.toolSignatures.size > 0 ||
        scope.signatureFamilies.size > 0
      if (!hasData) {
        this.scopes.delete(scopeKey)
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
