/**
 * Warmup 请求拦截器
 * 
 * 拦截 Claude Code 的心跳请求，直接返回模拟响应，节省上游配额
 */

const logger = require('../../utils/logger')

// Warmup 检测模式
const WARMUP_PATTERNS = [
  /^Warmup/i,
  /^keep-?alive/i,
  /^ping$/i,
  /^test connection/i
]

// 检测 tool_result 中的 Warmup 内容
const WARMUP_TOOL_RESULT_PATTERNS = [
  /Warmup/i,
  /connection test/i
]

/**
 * 从消息内容中提取文本
 * @param {string|Array} content - 消息内容
 * @returns {string} 提取的文本
 */
function extractText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  
  if (Array.isArray(content)) {
    return content
      .filter(block => block && block.type === 'text')
      .map(block => block.text || '')
      .join(' ')
  }
  
  return ''
}

/**
 * 检测是否为 Warmup 请求
 * @param {Object} body - 请求体
 * @returns {boolean} 是否为 Warmup 请求
 */
function isWarmupRequest(body) {
  const messages = body.messages || []
  if (messages.length === 0) return false
  
  const lastMessage = messages[messages.length - 1]
  if (!lastMessage) return false
  
  // 检测用户消息
  if (lastMessage.role === 'user') {
    const text = extractText(lastMessage.content)
    
    // 检查文本模式
    if (WARMUP_PATTERNS.some(pattern => pattern.test(text.trim()))) {
      return true
    }
    
    // 检查 tool_result 内容
    if (Array.isArray(lastMessage.content)) {
      for (const block of lastMessage.content) {
        if (block.type === 'tool_result') {
          const resultContent = typeof block.content === 'string' 
            ? block.content 
            : extractText(block.content)
          
          if (WARMUP_TOOL_RESULT_PATTERNS.some(pattern => pattern.test(resultContent))) {
            return true
          }
        }
      }
    }
  }
  
  return false
}

/**
 * 创建 Warmup 模拟响应（非流式）
 * @returns {Object} Anthropic 格式响应
 */
function createWarmupJsonResponse() {
  return {
    id: `msg_warmup_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Ready.' }],
    model: 'antigravity-enhanced-warmup',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
  }
}

/**
 * 创建 Warmup 模拟响应（流式 SSE）
 * @returns {string} SSE 格式响应
 */
function createWarmupStreamResponse() {
  const messageId = `msg_warmup_${Date.now()}`
  
  const events = [
    // message_start
    {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'antigravity-enhanced-warmup',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    },
    // content_block_start
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    },
    // content_block_delta
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Ready.' }
    },
    // content_block_stop
    {
      type: 'content_block_stop',
      index: 0
    },
    // message_delta
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 }
    },
    // message_stop
    {
      type: 'message_stop'
    }
  ]
  
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

/**
 * 发送 Warmup 响应
 * @param {Object} res - Express 响应对象
 * @param {boolean} isStream - 是否为流式请求
 * @param {string} traceId - 追踪 ID
 */
function sendWarmupResponse(res, isStream, traceId) {
  logger.info(`[AntigravityEnhanced][${traceId}] 🔥 Warmup 请求拦截成功`)
  
  res.setHeader('X-Antigravity-Enhanced', 'warmup-intercepted')
  res.setHeader('X-Warmup-Intercepted', 'true')
  
  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.write(createWarmupStreamResponse())
    res.end()
  } else {
    res.setHeader('Content-Type', 'application/json')
    res.json(createWarmupJsonResponse())
  }
}

module.exports = {
  isWarmupRequest,
  createWarmupJsonResponse,
  createWarmupStreamResponse,
  sendWarmupResponse,
  extractText
}
