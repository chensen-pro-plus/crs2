/**
 * SSE Stream 收集器和转换器
 * 
 * 将 Gemini 流式响应收集为完整的 Anthropic JSON 响应
 * 用于自动 Stream 转换功能（非流式客户端）
 * 
 * 参考: Antigravity-Manager2/src-tauri/src/proxy/mappers/claude/response.rs
 */

const logger = require('../../utils/logger')

/**
 * Stream 收集器类 - 处理 Gemini SSE 格式
 */
class StreamConverter {
  constructor(traceId = '') {
    this.traceId = traceId
    this.contentBlocks = []
    this.currentText = ''
    this.currentThinking = ''
    this.usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
    this.messageId = null
    this.model = null
    this.stopReason = null
    this.usedTool = false
  }
  
  /**
   * 解析 SSE 行
   */
  parseSSELine(line) {
    if (!line || !line.startsWith('data: ')) return null
    
    const dataStr = line.slice(6).trim()
    if (!dataStr || dataStr === '[DONE]') return null
    
    try {
      return JSON.parse(dataStr)
    } catch (e) {
      logger.warn(`[StreamConverter][${this.traceId}] 解析 SSE 失败: ${e.message}`)
      return null
    }
  }
  
  /**
   * 处理 Gemini 数据块
   */
  processGeminiData(data) {
    if (!data) return

    // 关键！解包 response 字段 (如果存在)
    // 参考: Antigravity-Manager2/src-tauri/src/proxy/mappers/claude/mod.rs
    const rawData = data.response || data

    // 获取元数据
    if (!this.messageId && rawData.responseId) {
      this.messageId = rawData.responseId
    }
    if (!this.model && rawData.modelVersion) {
      this.model = rawData.modelVersion
    }

    // 处理 usage
    if (rawData.usageMetadata) {
      this.usage = {
        input_tokens: rawData.usageMetadata.promptTokenCount || 0,
        output_tokens: rawData.usageMetadata.candidatesTokenCount || 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: rawData.usageMetadata.cachedContentTokenCount || 0
      }
    }

    // 处理 candidates
    const candidates = rawData.candidates || []
    for (const candidate of candidates) {
      this.processCandidate(candidate)
    }
  }

  /**
   * 处理单个候选
   */
  processCandidate(candidate) {
    if (!candidate || !candidate.content || !candidate.content.parts) return

    for (const part of candidate.content.parts) {
      this.processPart(part)
    }

    // 检查结束原因
    if (candidate.finishReason) {
      if (this.usedTool) {
        this.stopReason = 'tool_use'
      } else if (candidate.finishReason === 'MAX_TOKENS') {
        this.stopReason = 'max_tokens'
      } else {
        this.stopReason = 'end_turn'
      }
    }
  }

  /**
   * 处理单个 part
   */
  processPart(part) {
    // 处理工具调用
    if (part.functionCall) {
      this.flushText()
      this.flushThinking()
      this.usedTool = true

      const fc = part.functionCall
      const toolId = fc.id || `${fc.name}-${Date.now()}`
      const args = this.remapFunctionCallArgs(fc.name, fc.args || {})

      this.contentBlocks.push({
        type: 'tool_use',
        id: toolId,
        name: fc.name,
        input: args
      })
      return
    }

    // 处理文本
    if (part.text !== undefined) {
      if (part.thought === true) {
        // Thinking
        this.flushText()
        this.currentThinking += part.text || ''
      } else {
        // 普通文本
        this.flushThinking()
        this.currentText += part.text || ''
      }
    }
  }

  /**
   * 重映射函数参数 (Gemini → Claude 兼容性)
   */
  remapFunctionCallArgs(toolName, args) {
    const remapped = { ...args }
    const name = (toolName || '').toLowerCase()

    if (name === 'grep' || name === 'glob') {
      if (remapped.query && !remapped.pattern) {
        remapped.pattern = remapped.query
        delete remapped.query
      }
      if (remapped.paths && !remapped.path) {
        remapped.path = Array.isArray(remapped.paths) ? remapped.paths[0] : remapped.paths
        delete remapped.paths
      }
      if (!remapped.path) remapped.path = '.'
    } else if (name === 'read') {
      if (remapped.path && !remapped.file_path) {
        remapped.file_path = remapped.path
        delete remapped.path
      }
    } else if (name === 'ls') {
      if (!remapped.path) remapped.path = '.'
    }

    return remapped
  }

  /**
   * 刷新累积的文本
   */
  flushText() {
    if (this.currentText) {
      this.contentBlocks.push({ type: 'text', text: this.currentText })
      this.currentText = ''
    }
  }

  /**
   * 刷新累积的 thinking
   */
  flushThinking() {
    if (this.currentThinking) {
      this.contentBlocks.push({ type: 'thinking', thinking: this.currentThinking })
      this.currentThinking = ''
    }
  }
  
  /**
   * 从 SSE 流收集数据并转换为 JSON
   */
  async collectToJson(sseStream) {
    return new Promise((resolve, reject) => {
      let buffer = ''
      
      sseStream.on('data', (chunk) => {
        buffer += chunk.toString()
        
        // 按行处理
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        
        for (const line of lines) {
          const trimmedLine = line.trim()
          if (!trimmedLine) continue
          
          const data = this.parseSSELine(trimmedLine)
          if (data) {
            this.processGeminiData(data)
          }
        }
      })
      
      sseStream.on('end', () => {
        // 处理剩余的 buffer
        if (buffer.trim()) {
          const data = this.parseSSELine(buffer.trim())
          if (data) {
            this.processGeminiData(data)
          }
        }
        
        // 刷新剩余内容
        this.flushThinking()
        this.flushText()
        
        // 构建最终响应
        const response = {
          id: this.messageId || `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: this.contentBlocks.length > 0 
            ? this.contentBlocks 
            : [{ type: 'text', text: '' }],
          model: this.model || 'claude-sonnet-4-5',
          stop_reason: this.stopReason || 'end_turn',
          stop_sequence: null,
          usage: this.usage
        }
        
        logger.info(`[StreamConverter][${this.traceId}] ✓ 流收集完成, ${this.contentBlocks.length} 个内容块`)
        resolve(response)
      })
      
      sseStream.on('error', (error) => {
        logger.error(`[StreamConverter][${this.traceId}] 流错误: ${error.message}`)
        reject(error)
      })
    })
  }
  
  /**
   * 从 Axios 响应收集数据
   */
  async collectFromAxiosResponse(axiosResponse) {
    if (axiosResponse.data && typeof axiosResponse.data.pipe === 'function') {
      return this.collectToJson(axiosResponse.data)
    }
    
    // 如果不是流，直接处理
    if (axiosResponse.data) {
      this.processGeminiData(axiosResponse.data)
      this.flushThinking()
      this.flushText()
      
      return {
        id: this.messageId || `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: this.contentBlocks.length > 0 
          ? this.contentBlocks 
          : [{ type: 'text', text: '' }],
        model: this.model || 'claude-sonnet-4-5',
        stop_reason: this.stopReason || 'end_turn',
        stop_sequence: null,
        usage: this.usage
      }
    }
    
    return axiosResponse.data
  }
}

module.exports = { StreamConverter }
