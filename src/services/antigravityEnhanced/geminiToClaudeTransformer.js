/**
 * Gemini → Anthropic SSE 流转换器
 * 
 * 将 Gemini v1internal SSE 格式转换为 Claude/Anthropic SSE 格式
 * 参考: Antigravity-Manager2/src-tauri/src/proxy/mappers/claude/streaming.rs
 */

const { Transform } = require('stream')
const logger = require('../../utils/logger')
const signatureStore = require('./signatureStore')

/**
 * Gemini to Claude SSE Stream Transformer
 */
class GeminiToClaudeTransformer extends Transform {
  constructor(traceId = '') {
    super()
    this.traceId = traceId
    
    // 状态机
    this.blockType = 'none' // 'none', 'text', 'thinking', 'function'
    this.blockIndex = 0
    this.messageStartSent = false
    this.messageStopSent = false
    this.usedTool = false
    
    // Buffer
    this.buffer = ''
    
    // 响应元数据
    this.responseId = null
    this.modelVersion = null
    
    // 🔧 新增：累积的 token 使用量（供外部读取）
    this.finalUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
  }

  /**
   * 发送 SSE 事件
   */
  emit_sse(eventType, data) {
    const sse = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
    this.push(sse)
  }

  /**
   * 发送 message_start 事件
   */
  emitMessageStart(geminiData) {
    if (this.messageStartSent) return

    this.responseId = geminiData.responseId || `msg_${Date.now()}`
    this.modelVersion = geminiData.modelVersion || 'claude-sonnet-4-5'

    const usage = this.parseUsage(geminiData.usageMetadata)

    this.emit_sse('message_start', {
      type: 'message_start',
      message: {
        id: this.responseId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.modelVersion,
        stop_reason: null,
        stop_sequence: null,
        usage
      }
    })

    this.messageStartSent = true
  }

  /**
   * 解析 usage 信息并更新 finalUsage
   */
  parseUsage(usageMetadata) {
    if (!usageMetadata) {
      return { input_tokens: 0, output_tokens: 0 }
    }
    const usage = {
      input_tokens: usageMetadata.promptTokenCount || 0,
      output_tokens: usageMetadata.candidatesTokenCount || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: usageMetadata.cachedContentTokenCount || 0
    }
    
    // 🔧 更新累积的 usage（取最大值，因为流式响应中后续的 usage 包含之前的）
    this.finalUsage.input_tokens = Math.max(this.finalUsage.input_tokens, usage.input_tokens)
    this.finalUsage.output_tokens = Math.max(this.finalUsage.output_tokens, usage.output_tokens)
    this.finalUsage.cache_read_input_tokens = Math.max(this.finalUsage.cache_read_input_tokens, usage.cache_read_input_tokens)
    
    return usage
  }

  /**
   * 开始新的内容块
   */
  startBlock(blockType, contentBlock) {
    // 先结束之前的块
    if (this.blockType !== 'none') {
      this.endBlock()
    }

    this.emit_sse('content_block_start', {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block: contentBlock
    })

    this.blockType = blockType
  }

  /**
   * 结束当前内容块
   */
  endBlock() {
    if (this.blockType === 'none') return

    this.emit_sse('content_block_stop', {
      type: 'content_block_stop',
      index: this.blockIndex
    })

    this.blockIndex++
    this.blockType = 'none'
  }

  /**
   * 发送 delta 事件
   */
  emitDelta(deltaType, deltaContent) {
    this.emit_sse('content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: {
        type: deltaType,
        ...deltaContent
      }
    })
  }

  /**
   * 处理 Gemini 的 part
   */
  processPart(part) {
    // 1. FunctionCall 处理
    if (part.functionCall) {
      this.processToolUse(part.functionCall)
      return
    }

    // 2. Text 处理
    if (part.text !== undefined) {
      if (part.thought === true) {
        // Thinking block
        this.processThinking(part.text, part.thoughtSignature)
      } else {
        // Normal text
        this.processText(part.text)
      }
    }
  }

  /**
   * 处理 thinking 内容
   */
  processThinking(text, signature) {
    if (this.blockType !== 'thinking') {
      this.startBlock('thinking', { type: 'thinking', thinking: '' })
    }

    if (text) {
      this.emitDelta('thinking_delta', { thinking: text })
    }

    // 处理签名
    if (signature) {
      // [关键修复] 保存原始 Base64 签名到缓存，不进行解码
      // 这样在 protocolConverter.js 恢复时就不需要再次编码
      signatureStore.store(signature)
      logger.debug(`[GeminiToClaudeTransformer][${this.traceId}] 捕获 thought_signature (原始 Base64, length=${signature.length})`)
      
      // 输出给客户端时需要解码
      let decodedSig = signature
      try {
        decodedSig = Buffer.from(signature, 'base64').toString('utf-8')
      } catch (e) {
        // 如果解码失败，保持原样
        logger.warn(`[GeminiToClaudeTransformer][${this.traceId}] 签名 Base64 解码失败，使用原始值`)
      }
      
      this.emitDelta('signature_delta', { signature: decodedSig })
    }
  }

  /**
   * 处理普通文本
   */
  processText(text) {
    if (!text) return

    if (this.blockType !== 'text') {
      this.startBlock('text', { type: 'text', text: '' })
    }

    this.emitDelta('text_delta', { text })
  }

  /**
   * 处理工具调用
   */
  processToolUse(functionCall) {
    this.usedTool = true

    const toolId = functionCall.id || `${functionCall.name}-${Date.now()}`
    const args = functionCall.args || {}

    // 参数重映射 (Gemini → Claude 兼容性)
    const remappedArgs = this.remapFunctionCallArgs(functionCall.name, args)

    // 缓存工具签名（参考 Rust 版 streaming.rs 第 780 行）
    // 当工具调用时，关联当前最新的 thought_signature
    const currentSig = signatureStore.get()
    if (currentSig) {
      signatureStore.cacheToolSignature(toolId, currentSig)
      logger.debug(`[GeminiToClaudeTransformer][${this.traceId}] 缓存工具签名: ${toolId}`)
    }

    this.startBlock('function', {
      type: 'tool_use',
      id: toolId,
      name: functionCall.name,
      input: {}
    })

    // 发送完整参数
    const jsonStr = JSON.stringify(remappedArgs)
    this.emitDelta('input_json_delta', { partial_json: jsonStr })
  }

  /**
   * 重映射函数参数 (参考 Rust 版本)
   */
  remapFunctionCallArgs(toolName, args) {
    const remapped = { ...args }
    const name = toolName.toLowerCase()

    if (name === 'grep' || name === 'glob') {
      // query → pattern
      if (remapped.query && !remapped.pattern) {
        remapped.pattern = remapped.query
        delete remapped.query
      }
      // paths → path
      if (remapped.paths && !remapped.path) {
        if (Array.isArray(remapped.paths)) {
          remapped.path = remapped.paths[0] || '.'
        } else {
          remapped.path = remapped.paths
        }
        delete remapped.paths
      }
      if (!remapped.path) {
        remapped.path = '.'
      }
    } else if (name === 'read') {
      // path → file_path
      if (remapped.path && !remapped.file_path) {
        remapped.file_path = remapped.path
        delete remapped.path
      }
    } else if (name === 'ls') {
      if (!remapped.path) {
        remapped.path = '.'
      }
    }

    return remapped
  }

  /**
   * 发送结束事件
   */
  emitFinish(finishReason, usageMetadata) {
    // 关闭最后一个块
    this.endBlock()

    // 确定 stop_reason
    let stopReason = 'end_turn'
    if (this.usedTool) {
      stopReason = 'tool_use'
    } else if (finishReason === 'MAX_TOKENS') {
      stopReason = 'max_tokens'
    }

    const usage = this.parseUsage(usageMetadata)

    this.emit_sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage
    })

    if (!this.messageStopSent) {
      this.push('event: message_stop\ndata: {"type":"message_stop"}\n\n')
      this.messageStopSent = true
    }
  }

  /**
   * 处理 Gemini SSE 数据块
   */
  processGeminiChunk(line) {
    if (!line.startsWith('data: ')) return

    const dataStr = line.slice(6).trim()
    if (!dataStr || dataStr === '[DONE]') {
      // [DONE] 时确保发送结束事件
      if (!this.messageStopSent && this.messageStartSent) {
        this.endBlock()
        this.emit_sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { input_tokens: 0, output_tokens: 0 }
        })
        this.push('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        this.messageStopSent = true
      }
      return
    }

    let jsonData
    try {
      jsonData = JSON.parse(dataStr)
    } catch (e) {
      logger.warn(`[GeminiToClaudeTransformer][${this.traceId}] 解析 JSON 失败: ${e.message}`)
      return
    }

    // 关键！解包 response 字段 (如果存在)
    // 参考: Antigravity-Manager2/src-tauri/src/proxy/mappers/claude/mod.rs 第99行
    const rawJson = jsonData.response || jsonData
    
    // 调试日志
    const hasResponse = !!jsonData.response
    const hasCandidates = !!(rawJson.candidates && rawJson.candidates.length > 0)
    logger.debug(`[GeminiToClaudeTransformer][${this.traceId}] hasResponse=${hasResponse}, hasCandidates=${hasCandidates}`)

    // 发送 message_start
    if (!this.messageStartSent) {
      this.emitMessageStart(rawJson)
    }

    // 处理 candidates
    const candidates = rawJson.candidates || []
    for (const candidate of candidates) {
      const content = candidate.content
      if (!content || !content.parts) continue

      for (const part of content.parts) {
        this.processPart(part)
      }

      // 检查是否结束
      if (candidate.finishReason) {
        this.emitFinish(candidate.finishReason, rawJson.usageMetadata)
      }
    }
  }

  /**
   * Transform 实现
   */
  _transform(chunk, encoding, callback) {
    try {
      this.buffer += chunk.toString()

      // 按行处理
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        this.processGeminiChunk(trimmed)
      }

      callback()
    } catch (err) {
      logger.error(`[GeminiToClaudeTransformer][${this.traceId}] 转换错误: ${err.message}`)
      callback(err)
    }
  }

  /**
   * Flush 剩余数据
   */
  _flush(callback) {
    try {
      // 处理剩余 buffer
      if (this.buffer.trim()) {
        this.processGeminiChunk(this.buffer.trim())
      }

      // 确保发送结束事件
      if (this.messageStartSent && !this.messageStopSent) {
        this.endBlock()
        this.emit_sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { input_tokens: 0, output_tokens: 0 }
        })
        this.push('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        this.messageStopSent = true
      }

      logger.debug(`[GeminiToClaudeTransformer][${this.traceId}] 流转换完成, ${this.blockIndex} 个内容块`)
      callback()
    } catch (err) {
      callback(err)
    }
  }
}

module.exports = { GeminiToClaudeTransformer }
