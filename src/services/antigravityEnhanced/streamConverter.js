/**
 * SSE Stream 收集器和转换器
 * 
 * 将流式响应收集为完整的 JSON 响应，支持自动 Stream 转换功能
 */

const logger = require('../../utils/logger')

/**
 * Stream 收集器类
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
  }
  
  /**
   * 解析 SSE 行
   * @param {string} line - SSE 行
   * @returns {Object|null} 解析后的事件数据
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
   * 处理单个 SSE 事件
   * @param {Object} event - SSE 事件数据
   */
  processEvent(event) {
    if (!event || !event.type) return
    
    switch (event.type) {
      case 'message_start':
        if (event.message) {
          this.messageId = event.message.id
          this.model = event.message.model
          if (event.message.usage) {
            this.usage = { ...this.usage, ...event.message.usage }
          }
        }
        break
        
      case 'content_block_start':
        if (event.content_block) {
          if (event.content_block.type === 'thinking') {
            this.currentThinking = ''
          } else if (event.content_block.type === 'text') {
            this.currentText = ''
          }
        }
        break
        
      case 'content_block_delta':
        if (event.delta) {
          if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
            this.currentThinking += event.delta.thinking
          } else if (event.delta.type === 'text_delta' && event.delta.text) {
            this.currentText += event.delta.text
          }
        }
        break
        
      case 'content_block_stop':
        // 保存当前块
        if (this.currentThinking) {
          this.contentBlocks.push({
            type: 'thinking',
            thinking: this.currentThinking
          })
          this.currentThinking = ''
        }
        if (this.currentText) {
          this.contentBlocks.push({
            type: 'text',
            text: this.currentText
          })
          this.currentText = ''
        }
        break
        
      case 'message_delta':
        if (event.delta) {
          this.stopReason = event.delta.stop_reason
        }
        if (event.usage) {
          this.usage = { ...this.usage, ...event.usage }
        }
        break
    }
  }
  
  /**
   * 从 SSE 流收集数据并转换为 JSON
   * @param {Stream} sseStream - SSE 响应流
   * @returns {Promise<Object>} 完整的 Anthropic 格式响应
   */
  async collectToJson(sseStream) {
    return new Promise((resolve, reject) => {
      let buffer = ''
      
      sseStream.on('data', (chunk) => {
        buffer += chunk.toString()
        
        // 按行处理
        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // 保留不完整的行
        
        for (const line of lines) {
          const trimmedLine = line.trim()
          if (!trimmedLine) continue
          
          const event = this.parseSSELine(trimmedLine)
          if (event) {
            this.processEvent(event)
          }
        }
      })
      
      sseStream.on('end', () => {
        // 处理剩余的 buffer
        if (buffer.trim()) {
          const event = this.parseSSELine(buffer.trim())
          if (event) {
            this.processEvent(event)
          }
        }
        
        // 如果还有未保存的内容
        if (this.currentText) {
          this.contentBlocks.push({ type: 'text', text: this.currentText })
        }
        if (this.currentThinking) {
          this.contentBlocks.push({ type: 'thinking', thinking: this.currentThinking })
        }
        
        // 构建最终响应
        const response = {
          id: this.messageId || `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: this.contentBlocks.length > 0 
            ? this.contentBlocks 
            : [{ type: 'text', text: '' }],
          model: this.model || 'unknown',
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
   * @param {Object} axiosResponse - Axios 响应对象
   * @returns {Promise<Object>} 完整的 Anthropic 格式响应
   */
  async collectFromAxiosResponse(axiosResponse) {
    if (axiosResponse.data && typeof axiosResponse.data.pipe === 'function') {
      return this.collectToJson(axiosResponse.data)
    }
    
    // 如果不是流，直接返回
    return axiosResponse.data
  }
}

module.exports = { StreamConverter }
