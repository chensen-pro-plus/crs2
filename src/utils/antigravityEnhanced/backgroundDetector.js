/**
 * 后台任务检测器
 * 
 * 自动识别后台任务（标题生成、摘要等），降级到 Flash 模型以节省高级配额
 */

const logger = require('../../utils/logger')

/**
 * 后台任务类型
 */
const TaskType = {
  TITLE_GENERATION: 'TITLE_GENERATION',       // 标题生成
  SUMMARY: 'SUMMARY',                         // 摘要生成
  SUGGESTION: 'SUGGESTION',                   // 建议生成
  TODO_UPDATE: 'TODO_UPDATE',                 // TODO 更新
  PROBE: 'PROBE'                              // 探测/测试
}

/**
 * 各任务类型的检测模式
 */
const TASK_PATTERNS = {
  [TaskType.TITLE_GENERATION]: [
    /generate.{0,30}(short\s+)?title/i,
    /create.{0,30}title/i,
    /suggest.{0,30}title/i,
    /summarize.{0,30}in.{0,10}title/i,
    /title.{0,20}for.{0,20}conversation/i,
    /concise.{0,20}title/i
  ],
  
  [TaskType.SUMMARY]: [
    /concise.{0,30}summary/i,
    /compress.{0,30}context/i,
    /shorten.{0,30}conversation/i,
    /extract.{0,30}key.{0,10}points/i,
    /summarize.{0,30}(conversation|chat|discussion)/i,
    /brief.{0,20}overview/i
  ],
  
  [TaskType.SUGGESTION]: [
    /suggest.{0,30}next.{0,20}(step|action)/i,
    /recommend.{0,30}(action|approach)/i,
    /what.{0,20}should.{0,20}(i|we).{0,20}do.{0,10}next/i,
    /give.{0,20}me.{0,20}suggestions/i
  ],
  
  [TaskType.TODO_UPDATE]: [
    /update.{0,30}todo/i,
    /mark.{0,30}(as\s+)?(complete|done)/i,
    /check.{0,20}(off|task)/i,
    /todowrite/i
  ],
  
  [TaskType.PROBE]: [
    /^warmup$/i,
    /^ping$/i,
    /^test$/i,
    /^hello$/i,
    /^hi$/i,
    /connection.{0,10}test/i
  ]
}

/**
 * 任务类型到降级模型的映射
 */
const MODEL_DOWNGRADE_MAP = {
  [TaskType.TITLE_GENERATION]: 'gemini-2.5-flash-lite',
  [TaskType.SUMMARY]: 'gemini-2.5-flash',
  [TaskType.SUGGESTION]: 'gemini-2.5-flash-lite',
  [TaskType.TODO_UPDATE]: 'gemini-2.5-flash-lite',
  [TaskType.PROBE]: 'gemini-2.5-flash-lite'
}

/**
 * 从消息内容中提取文本
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
 * 获取最后一条用户消息
 * @param {Array} messages - 消息列表
 * @returns {Object|null} 最后一条用户消息
 */
function getLastUserMessage(messages) {
  if (!Array.isArray(messages)) return null
  
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      return messages[i]
    }
  }
  
  return null
}

/**
 * 检测后台任务类型
 * @param {Object} body - 请求体
 * @returns {string|null} 任务类型或 null
 */
function detectBackgroundTask(body) {
  const lastUserMsg = getLastUserMessage(body.messages)
  if (!lastUserMsg) return null
  
  const text = extractText(lastUserMsg.content)
  if (!text) return null
  
  // 检查各任务类型
  for (const [taskType, patterns] of Object.entries(TASK_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return taskType
      }
    }
  }
  
  return null
}

/**
 * 选择降级模型
 * @param {string} taskType - 任务类型
 * @returns {string|null} 降级后的模型名称
 */
function selectDowngradeModel(taskType) {
  return MODEL_DOWNGRADE_MAP[taskType] || null
}

/**
 * 处理后台任务降级
 * @param {Object} body - 请求体
 * @param {string} traceId - 追踪 ID
 * @returns {Object} { taskType, originalModel, downgradeModel, shouldDowngrade }
 */
function processBackgroundTaskDowngrade(body, traceId = '') {
  const taskType = detectBackgroundTask(body)
  
  if (!taskType) {
    return {
      taskType: null,
      originalModel: body.model,
      downgradeModel: null,
      shouldDowngrade: false
    }
  }
  
  const downgradeModel = selectDowngradeModel(taskType)
  
  logger.info(
    `[BackgroundDetector][${traceId}] ⬇️ 检测到后台任务: ${taskType}, ` +
    `模型降级: ${body.model} → ${downgradeModel}`
  )
  
  return {
    taskType,
    originalModel: body.model,
    downgradeModel,
    shouldDowngrade: true
  }
}

/**
 * 清理请求以适配 Flash 模型
 * Flash 模型不支持某些功能，需要移除
 * @param {Object} body - 请求体
 * @returns {Object} 清理后的请求体
 */
function sanitizeRequestForFlash(body) {
  const sanitized = { ...body }
  
  // Flash 模型不支持 thinking
  if (sanitized.thinking) {
    delete sanitized.thinking
  }
  
  // 清理消息中的 thinking 块
  if (Array.isArray(sanitized.messages)) {
    sanitized.messages = sanitized.messages.map(msg => {
      if (msg.role !== 'assistant') return msg
      
      const content = msg.content
      if (!Array.isArray(content)) return msg
      
      const filteredContent = content.filter(block => 
        block.type !== 'thinking' && block.type !== 'redacted_thinking'
      )
      
      return { ...msg, content: filteredContent }
    })
  }
  
  return sanitized
}

module.exports = {
  TaskType,
  TASK_PATTERNS,
  MODEL_DOWNGRADE_MAP,
  detectBackgroundTask,
  selectDowngradeModel,
  processBackgroundTaskDowngrade,
  sanitizeRequestForFlash,
  getLastUserMessage,
  extractText
}
