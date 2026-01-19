/**
 * 编辑器上下文解析器
 *
 * 用于从 Claude CLI/VS Code 等客户端注入的消息内容中提取编辑器上下文信息
 * 这些信息包括：
 * - Active Document: 当前打开的文件路径
 * - Cursor Position: 光标所在行号
 * - Other Open Documents: 其他打开的文档列表
 * - Running Terminal Commands: 正在运行的终端命令
 *
 * 客户端会将这些信息作为 user message 的一部分注入到请求中
 */

const logger = require('./logger')

/**
 * 编辑器上下文数据结构
 * @typedef {Object} EditorContext
 * @property {string|null} activeDocument - 当前活跃文档路径
 * @property {string|null} language - 当前文档的语言类型
 * @property {number|null} cursorLine - 光标所在行号
 * @property {string[]} otherDocuments - 其他打开的文档列表
 * @property {string[]} terminalCommands - 正在运行的终端命令列表
 * @property {boolean} hasContext - 是否包含有效的编辑器上下文
 */

/**
 * 解析器配置
 *
 * Claude CLI 使用以下格式注入编辑器上下文：
 * - "The user opened the file /path/to/file in the IDE" (在 <system-reminder> 标签内)
 * - "The user's cursor is on line 17"
 * - "The user has the following files open: ..."
 *
 * 也兼容原有格式：
 * - "Active Document: /path/to/file.js (LANGUAGE_JAVASCRIPT)"
 * - "Cursor is on line: 123"
 */
const PATTERNS = {
  // 匹配 Claude CLI 格式: "The user opened the file /path/to/file in the IDE"
  // 或原有格式: "Active Document: /path/to/file.js (LANGUAGE_JAVASCRIPT)"
  activeDocument:
    /(?:The user opened the file\s+([^\s]+)\s+in the IDE|Active Document:\s*([^\s(]+)(?:\s*\(([^)]+)\))?)/i,

  // 匹配 Claude CLI 格式: "The user's cursor is on line 17"
  // 或原有格式: "Cursor is on line: 123" / "Cursor Position: 123"
  cursorPosition:
    /(?:The user(?:'s)? cursor is on line\s+(\d+)|Cursor (?:is on line|Position):\s*(\d+))/i,

  // 匹配 "Other open documents:" 后的列表项
  // 每行格式: "- /path/to/file.js (LANGUAGE_JAVASCRIPT)"
  otherDocumentsHeader: /Other open documents:/i,
  otherDocumentItem: /^-\s*([^\s(]+)(?:\s*\(([^)]+)\))?/,

  // 匹配 "Running terminal commands:" 或 "Running Terminal Commands:" 后的列表
  terminalCommandsHeader: /Running (?:terminal )?commands?:/i,
  terminalCommandItem: /^-\s*(.+)$/
}

/**
 * 从请求消息数组中解析编辑器上下文
 *
 * @param {Array} messages - Claude 请求的 messages 数组
 * @returns {EditorContext} 解析出的编辑器上下文
 */
function parseEditorContext(messages) {
  // 初始化空上下文
  const context = {
    activeDocument: null,
    language: null,
    cursorLine: null,
    otherDocuments: [],
    terminalCommands: [],
    hasContext: false
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return context
  }

  // 遍历所有消息，寻找包含编辑器上下文的 user 消息
  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }

    // 提取消息文本内容
    const textContent = extractTextFromMessage(message)
    if (!textContent) {
      continue
    }

    // 尝试从文本中解析编辑器上下文
    const parsed = parseContextFromText(textContent)

    // 如果解析到了有效上下文，合并到结果中
    if (parsed.hasContext) {
      mergeContext(context, parsed)
    }
  }

  return context
}

/**
 * 从消息对象中提取文本内容
 * 支持字符串内容和数组内容（多模态消息）
 *
 * @param {Object} message - 消息对象
 * @returns {string} 提取的文本内容
 */
function extractTextFromMessage(message) {
  if (!message || !message.content) {
    return ''
  }

  // 如果 content 是字符串，直接返回
  if (typeof message.content === 'string') {
    return message.content
  }

  // 如果 content 是数组（多模态消息），提取所有 text 类型的内容
  if (Array.isArray(message.content)) {
    return message.content
      .filter((item) => item.type === 'text' && item.text)
      .map((item) => item.text)
      .join('\n')
  }

  return ''
}

/**
 * 从文本内容中解析编辑器上下文
 *
 * @param {string} text - 消息文本内容
 * @returns {EditorContext} 解析出的编辑器上下文
 */
function parseContextFromText(text) {
  const context = {
    activeDocument: null,
    language: null,
    cursorLine: null,
    otherDocuments: [],
    terminalCommands: [],
    hasContext: false
  }

  if (!text || typeof text !== 'string') {
    return context
  }

  // 1. 提取 Active Document
  const activeDocResult = extractActiveDocument(text)
  if (activeDocResult) {
    context.activeDocument = activeDocResult.path
    context.language = activeDocResult.language
    context.hasContext = true
  }

  // 2. 提取 Cursor Position
  const cursorLine = extractCursorPosition(text)
  if (cursorLine !== null) {
    context.cursorLine = cursorLine
    context.hasContext = true
  }

  // 3. 提取 Other Open Documents
  const otherDocs = extractOtherDocuments(text)
  if (otherDocs.length > 0) {
    context.otherDocuments = otherDocs
    context.hasContext = true
  }

  // 4. 提取 Running Terminal Commands
  const terminalCmds = extractTerminalCommands(text)
  if (terminalCmds.length > 0) {
    context.terminalCommands = terminalCmds
    context.hasContext = true
  }

  return context
}

/**
 * 提取当前活跃文档路径和语言类型
 * 支持两种格式：
 * - Claude CLI: "The user opened the file /path/to/file in the IDE"
 * - 原有格式: "Active Document: /path/to/file.js (LANGUAGE_JAVASCRIPT)"
 *
 * @param {string} text - 文本内容
 * @returns {{path: string, language: string|null}|null} 文档信息或 null
 */
function extractActiveDocument(text) {
  const match = text.match(PATTERNS.activeDocument)
  if (match) {
    // match[1] = Claude CLI 格式的文件路径
    // match[2] = 原有格式的文件路径
    // match[3] = 原有格式的语言类型
    const path = match[1] || match[2]
    const language = match[3] || null
    if (path) {
      return {
        path: path.trim(),
        language: language ? language.trim() : null
      }
    }
  }
  return null
}

/**
 * 提取光标位置（行号）
 * 支持两种格式：
 * - Claude CLI: "The user's cursor is on line 17"
 * - 原有格式: "Cursor is on line: 123"
 *
 * @param {string} text - 文本内容
 * @returns {number|null} 行号或 null
 */
function extractCursorPosition(text) {
  const match = text.match(PATTERNS.cursorPosition)
  if (match) {
    // match[1] = Claude CLI 格式的行号
    // match[2] = 原有格式的行号
    const lineStr = match[1] || match[2]
    if (lineStr) {
      const lineNumber = parseInt(lineStr, 10)
      // 验证行号是否为有效的正整数
      if (!isNaN(lineNumber) && lineNumber > 0) {
        return lineNumber
      }
    }
  }
  return null
}

/**
 * 提取其他打开的文档列表
 *
 * @param {string} text - 文本内容
 * @returns {Array<{path: string, language: string|null}>} 文档列表
 */
function extractOtherDocuments(text) {
  const documents = []
  const lines = text.split('\n')

  let inOtherDocsSection = false

  for (const line of lines) {
    // 检查是否进入 "Other open documents:" 部分
    if (PATTERNS.otherDocumentsHeader.test(line)) {
      inOtherDocsSection = true
      continue
    }

    // 如果在该部分内，解析列表项
    if (inOtherDocsSection) {
      const trimmedLine = line.trim()

      // 空行或新的标题会结束该部分
      if (!trimmedLine || (trimmedLine && !trimmedLine.startsWith('-'))) {
        // 如果遇到不是以 - 开头的非空行，退出该部分
        if (trimmedLine && !trimmedLine.startsWith('-')) {
          inOtherDocsSection = false
        }
        continue
      }

      const match = trimmedLine.match(PATTERNS.otherDocumentItem)
      if (match) {
        documents.push({
          path: match[1].trim(),
          language: match[2] ? match[2].trim() : null
        })
      }
    }
  }

  return documents
}

/**
 * 提取正在运行的终端命令列表
 *
 * @param {string} text - 文本内容
 * @returns {string[]} 终端命令列表
 */
function extractTerminalCommands(text) {
  const commands = []
  const lines = text.split('\n')

  let inTerminalSection = false

  for (const line of lines) {
    // 检查是否进入 "Running terminal commands:" 部分
    if (PATTERNS.terminalCommandsHeader.test(line)) {
      inTerminalSection = true
      continue
    }

    // 如果在该部分内，解析列表项
    if (inTerminalSection) {
      const trimmedLine = line.trim()

      // 空行或新的标题会结束该部分
      if (!trimmedLine || (trimmedLine && !trimmedLine.startsWith('-'))) {
        if (trimmedLine && !trimmedLine.startsWith('-')) {
          inTerminalSection = false
        }
        continue
      }

      const match = trimmedLine.match(PATTERNS.terminalCommandItem)
      if (match) {
        commands.push(match[1].trim())
      }
    }
  }

  return commands
}

/**
 * 合并两个上下文对象
 * 新解析的上下文会覆盖旧的（后面的消息优先）
 *
 * @param {EditorContext} target - 目标上下文
 * @param {EditorContext} source - 源上下文
 */
function mergeContext(target, source) {
  if (source.activeDocument) {
    target.activeDocument = source.activeDocument
    target.language = source.language
  }

  if (source.cursorLine !== null) {
    target.cursorLine = source.cursorLine
  }

  if (source.otherDocuments.length > 0) {
    // 合并文档列表，去重
    const existingPaths = new Set(target.otherDocuments.map((d) => d.path))
    for (const doc of source.otherDocuments) {
      if (!existingPaths.has(doc.path)) {
        target.otherDocuments.push(doc)
        existingPaths.add(doc.path)
      }
    }
  }

  if (source.terminalCommands.length > 0) {
    // 合并命令列表，去重
    const existingCmds = new Set(target.terminalCommands)
    for (const cmd of source.terminalCommands) {
      if (!existingCmds.has(cmd)) {
        target.terminalCommands.push(cmd)
        existingCmds.add(cmd)
      }
    }
  }

  target.hasContext = target.hasContext || source.hasContext
}

/**
 * 格式化上下文信息用于日志输出
 *
 * @param {EditorContext} context - 编辑器上下文
 * @returns {string} 格式化的日志字符串
 */
function formatContextForLogging(context) {
  if (!context || !context.hasContext) {
    return '[EditorContext] None'
  }

  const parts = []

  // Active Document (提取文件名便于阅读)
  if (context.activeDocument) {
    const fileName = context.activeDocument.split('/').pop()
    parts.push(`Active: ${fileName}`)
  }

  // Cursor Line
  if (context.cursorLine !== null) {
    parts.push(`Line: ${context.cursorLine}`)
  }

  // Other Documents Count
  if (context.otherDocuments.length > 0) {
    parts.push(`Open: ${context.otherDocuments.length} files`)
  }

  // Terminal Commands Count
  if (context.terminalCommands.length > 0) {
    parts.push(`Terminal: ${context.terminalCommands.length} commands`)
  }

  return `[EditorContext] ${parts.join(' | ')}`
}

/**
 * 记录编辑器上下文到日志
 *
 * @param {EditorContext} context - 编辑器上下文
 * @param {string} traceId - 追踪 ID
 */
function logEditorContext(context, traceId) {
  if (!context || !context.hasContext) {
    logger.debug(`[AntigravityEnhanced][${traceId}] ${formatContextForLogging(context)}`)
    return
  }

  // 有上下文时，输出更详细的信息
  logger.info(`[AntigravityEnhanced][${traceId}] ${formatContextForLogging(context)}`)

  // 详细日志（debug 级别）
  if (context.activeDocument) {
    logger.debug(`[AntigravityEnhanced][${traceId}]   📄 Active: ${context.activeDocument}`)
  }
  if (context.cursorLine !== null) {
    logger.debug(`[AntigravityEnhanced][${traceId}]   📍 Cursor: Line ${context.cursorLine}`)
  }
  if (context.otherDocuments.length > 0) {
    logger.debug(
      `[AntigravityEnhanced][${traceId}]   📂 Other docs: ${context.otherDocuments.map((d) => d.path.split('/').pop()).join(', ')}`
    )
  }
  if (context.terminalCommands.length > 0) {
    logger.debug(
      `[AntigravityEnhanced][${traceId}]   💻 Terminal: ${context.terminalCommands.join(', ')}`
    )
  }
}

module.exports = {
  parseEditorContext,
  extractTextFromMessage,
  parseContextFromText,
  extractActiveDocument,
  extractCursorPosition,
  extractOtherDocuments,
  extractTerminalCommands,
  formatContextForLogging,
  logEditorContext,
  PATTERNS
}
