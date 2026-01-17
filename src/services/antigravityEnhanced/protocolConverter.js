/**
 * Antigravity Enhanced 协议转换器
 * 
 * 将 Anthropic Claude 请求格式完整转换为 Gemini/Antigravity 格式
 * 这是独立实现，不依赖原有的 anthropicGeminiBridgeService
 */

const crypto = require('crypto')
const logger = require('../../utils/logger')

// 模型映射模块
const { mapClaudeModelToGemini } = require('./modelMapping')

// 签名存储模块
const signatureStore = require('./signatureStore')

// ============================================================================
// 常量定义
// ============================================================================

// Antigravity 系统提示前缀
const ANTIGRAVITY_SYSTEM_INSTRUCTION_PREFIX = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
**Absolute paths only**
**Proactiveness**`

// 工具报错时注入的 system prompt
const TOOL_ERROR_CONTINUE_PROMPT = 
  'Tool calls may fail (e.g., missing prerequisites). When a tool result indicates an error, do not stop: briefly explain the cause and continue with an alternative approach or the remaining steps.'

// 工具后续提示
const ANTIGRAVITY_TOOL_FOLLOW_THROUGH_PROMPT = `
<communication_style>
- **Formatting**. Format your responses in github-style markdown. Use backticks to format file, directory, function, and class names.
</communication_style>`

// 需要跳过的系统提醒前缀
const SYSTEM_REMINDER_PREFIX = '<system-reminder>'

// Antigravity 工具结果的最大字符数
const MAX_TOOL_RESULT_CHARS = 200000

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从 Anthropic 消息内容中提取纯文本
 */
function extractAnthropicText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(part => part?.type === 'text')
      .map(part => part.text || '')
      .join('\n')
  }
  return ''
}

/**
 * 检查文本是否应该跳过
 */
function shouldSkipText(text) {
  if (!text) return true
  const trimmed = text.trim()
  if (trimmed.startsWith(SYSTEM_REMINDER_PREFIX)) return true
  return false
}

/**
 * 截断文本
 */
function truncateText(text, maxChars) {
  if (!text || text.length <= maxChars) return text
  return text.substring(0, maxChars) + '\n... [truncated]'
}

/**
 * 压缩工具描述 (取前 6 行，合并为单行，截断到 400 字符)
 */
function compactToolDescription(description) {
  if (!description) return ''
  const lines = description.split('\n').slice(0, 6)
  const merged = lines.map(l => l.trim()).filter(Boolean).join(' ')
  return truncateText(merged, 400)
}

/**
 * 压缩 Schema description (截断到 200 字符)
 */
function compactSchemaDescription(description) {
  if (!description) return ''
  const merged = description.replace(/\s+/g, ' ').trim()
  return truncateText(merged, 200)
}

/**
 * 递归压缩 JSON Schema 中的 description 字段
 */
function compactSchemaDescriptions(schema) {
  if (!schema || typeof schema !== 'object') return schema
  
  const result = { ...schema }
  
  if (result.description) {
    result.description = compactSchemaDescription(result.description)
  }
  
  if (result.properties && typeof result.properties === 'object') {
    result.properties = {}
    for (const [key, value] of Object.entries(schema.properties)) {
      result.properties[key] = compactSchemaDescriptions(value)
    }
  }
  
  if (result.items) {
    result.items = compactSchemaDescriptions(result.items)
  }
  
  return result
}

/**
 * 标准化工具调用的输入参数
 */
function normalizeToolUseInput(input) {
  if (!input) return {}
  if (typeof input === 'string') {
    try {
      return JSON.parse(input)
    } catch {
      return { raw: input }
    }
  }
  return input
}

/**
 * 清洗 thinking block 的 signature
 */
function sanitizeThoughtSignature(signature) {
  if (!signature || typeof signature !== 'string') return ''
  // 简单检查: 签名应该是 Base64-like 字符串
  if (!/^[A-Za-z0-9+/=]+$/.test(signature)) return ''
  if (signature.length < 10) return ''
  return signature
}

/**
 * 构建 tool_use ID 到工具名称的映射
 */
function buildToolUseIdToNameMap(messages) {
  const map = new Map()
  for (const msg of messages || []) {
    if (msg.role !== 'assistant') continue
    const content = msg.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type === 'tool_use' && part.id && part.name) {
        map.set(part.id, part.name)
      }
    }
  }
  return map
}

// ============================================================================
// 核心转换函数
// ============================================================================

/**
 * 标准化 Anthropic 消息列表
 */
function normalizeAnthropicMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages
  }

  const pendingToolUseIds = []
  
  const isIgnorableTrailingText = (part) => {
    if (!part || part.type !== 'text') return false
    if (typeof part.text !== 'string') return false
    const trimmed = part.text.trim()
    return trimmed === '' || trimmed === '(no content)'
  }

  const normalizeAssistantThinkingOrder = (parts) => {
    const thinkingBlocks = []
    const otherBlocks = []
    for (const part of parts) {
      if (!part) continue
      if (part.type === 'thinking' || part.type === 'redacted_thinking') {
        // 移除 cache_control 字段
        const { cache_control: _cc, ...cleanedPart } = part
        thinkingBlocks.push(cleanedPart)
        continue
      }
      if (isIgnorableTrailingText(part)) continue
      otherBlocks.push(part)
    }
    return thinkingBlocks.length === 0 ? otherBlocks : [...thinkingBlocks, ...otherBlocks]
  }

  const stripNonToolPartsAfterToolUse = (parts) => {
    let seenToolUse = false
    const cleaned = []
    for (const part of parts) {
      if (!part) continue
      if (part.type === 'tool_use') {
        seenToolUse = true
        cleaned.push(part)
        continue
      }
      if (!seenToolUse) {
        cleaned.push(part)
        continue
      }
      if (isIgnorableTrailingText(part)) continue
    }
    return cleaned
  }

  const normalized = []

  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) {
      normalized.push(message)
      continue
    }

    let parts = message.content.filter(Boolean)
    if (message.role === 'assistant') {
      parts = normalizeAssistantThinkingOrder(parts)
    }

    // 处理 assistant 消息
    if (message.role === 'assistant') {
      // 如果有未完成的 tool_use，插入合成的 tool_result
      if (pendingToolUseIds.length > 0) {
        normalized.push({
          role: 'user',
          content: pendingToolUseIds.map(toolUseId => ({
            type: 'tool_result',
            tool_use_id: toolUseId,
            is_error: true,
            content: [{ type: 'text', text: '[tool_result missing; tool execution interrupted]' }]
          }))
        })
        pendingToolUseIds.length = 0
      }

      const stripped = stripNonToolPartsAfterToolUse(parts)
      const toolUseIds = stripped
        .filter(part => part?.type === 'tool_use' && typeof part.id === 'string')
        .map(part => part.id)
      if (toolUseIds.length > 0) {
        pendingToolUseIds.push(...toolUseIds)
      }

      normalized.push({ ...message, content: stripped })
      continue
    }

    // 处理 user 消息中缺失的 tool_result
    if (message.role === 'user' && pendingToolUseIds.length > 0) {
      const toolResults = parts.filter(p => p.type === 'tool_result')
      const toolResultIds = new Set(
        toolResults.map(p => p.tool_use_id).filter(id => typeof id === 'string')
      )
      const missing = pendingToolUseIds.filter(id => !toolResultIds.has(id))
      if (missing.length > 0) {
        const synthetic = missing.map(toolUseId => ({
          type: 'tool_result',
          tool_use_id: toolUseId,
          is_error: true,
          content: [{ type: 'text', text: '[tool_result missing; tool execution interrupted]' }]
        }))
        parts = [...toolResults, ...synthetic, ...parts.filter(p => p.type !== 'tool_result')]
      }
      // 清除已处理的 pending IDs
      for (const id of toolResultIds) {
        const idx = pendingToolUseIds.indexOf(id)
        if (idx !== -1) pendingToolUseIds.splice(idx, 1)
      }
    }

    normalized.push({ ...message, content: parts })
  }

  return normalized
}

/**
 * 检查是否可以启用 Antigravity Thinking
 * 参考: Antigravity-Manager2/src-tauri/src/proxy/mappers/claude/request.rs 第 260-315 行
 * 
 * 逻辑：
 * 1. 首次请求（无 thinking 历史）→ 允许启用
 * 2. 有 thinking 历史：
 *    - 如果有全局缓存签名 → 允许（会在消息转换时注入）
 *    - 如果无缓存签名 → 禁用（避免 Invalid signature 错误）
 */
function canEnableAntigravityThinking(messages) {
  let hasThinkingHistory = false
  let hasFunctionCalls = false
  
  for (const msg of messages || []) {
    if (!Array.isArray(msg.content)) continue
    
    for (const part of msg.content) {
      if (!part || !part.type) continue
      
      // 检查是否有 tool_use
      if (part.type === 'tool_use') {
        hasFunctionCalls = true
      }
      
      // 检查是否有 thinking 块
      if (part.type === 'thinking' || part.type === 'redacted_thinking') {
        hasThinkingHistory = true
      }
    }
  }
  
  // 首次 thinking 请求（无历史），允许启用
  if (!hasThinkingHistory) {
    logger.debug('[ProtocolConverter] 首次 thinking 请求，允许启用')
    return true
  }
  
  // 有 thinking 历史时，检查是否有全局缓存签名
  // 参考 Rust 版本：只有在有有效签名时才允许继续 thinking
  const globalSig = signatureStore.get()
  if (globalSig && globalSig.length >= 50) {
    logger.info(`[ProtocolConverter] 有 thinking 历史，使用缓存签名 (length=${globalSig.length})`)
    return true
  }
  
  // 无缓存签名，禁用 thinking
  logger.warn('[ProtocolConverter] 有 thinking 历史但无缓存签名，禁用 thinking')
  return false
}

/**
 * 将 Anthropic 消息转换为 Gemini contents 格式
 */
function convertAnthropicMessagesToGeminiContents(messages, toolUseIdToName, { stripThinking = false } = {}) {
  const contents = []
  
  for (const message of messages || []) {
    const role = message?.role === 'assistant' ? 'model' : 'user'
    const content = message?.content
    const parts = []
    let lastThoughtSignature = ''

    if (typeof content === 'string') {
      const text = extractAnthropicText(content)
      if (text && !shouldSkipText(text)) {
        parts.push({ text })
      }
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || !part.type) continue

        // 处理 text
        if (part.type === 'text') {
          const text = extractAnthropicText(part.text || '')
          if (text && !shouldSkipText(text)) {
            parts.push({ text })
          }
          continue
        }

        // 处理 thinking
        // 参考 Rust 版本 request.rs 第 632-706 行
        if (part.type === 'thinking' || part.type === 'redacted_thinking') {
          if (stripThinking) continue
          
          const thinkingText = extractAnthropicText(part.thinking || part.text || '')
          const hasThinkingText = thinkingText && !shouldSkipText(thinkingText)
          
          // [关键修复] 签名解析优先级（参考 Rust 版本 request.rs 第 682-704 行）
          // 优先级：客户端签名 > 缓存签名
          // 原因：thinking block 的 signature 和它的 thinking 内容是配对的，不能随意替换！
          // 如果用错误的签名会导致 "Invalid signature in thinking block" 错误
          let signature = null
          
          // 1. 优先使用客户端提供的原始签名（如果存在）
          const clientSig = sanitizeThoughtSignature(part.signature)
          if (clientSig) {
            signature = clientSig
            logger.debug(`[ProtocolConverter] 使用客户端原始签名 (length=${signature.length})`)
          } else {
            // 2. 只有在客户端没有签名时，才尝试从缓存恢复
            // 这用于处理签名丢失的场景（例如 Claude CLI 某些版本不返回签名）
            const cachedSig = signatureStore.get()
            if (cachedSig && cachedSig.length >= 50) {
              signature = cachedSig
              logger.info(`[ProtocolConverter] 客户端无签名，使用缓存签名恢复 (length=${signature.length})`)
            }
          }
          
          const hasSignature = Boolean(signature)

          // 空 thinking block 跳过
          if (!hasThinkingText && !hasSignature) continue
          // 无签名跳过（避免 Invalid signature 错误）
          if (!hasSignature) {
            logger.warn('[ProtocolConverter] thinking 块无有效签名，跳过')
            continue
          }

          // Base64 编码签名（参考 Rust 版本 request.rs 第 700-703 行）
          const encodedSig = Buffer.from(signature).toString('base64')
          
          lastThoughtSignature = encodedSig
          const thoughtPart = { thought: true, thoughtSignature: encodedSig }
          if (hasThinkingText) {
            thoughtPart.text = thinkingText
          }
          parts.push(thoughtPart)
          continue
        }

        // 处理 image
        if (part.type === 'image') {
          const source = part.source || {}
          if (source.type === 'base64' && source.data) {
            const mediaType = source.media_type || source.mediaType || 'application/octet-stream'
            parts.push({
              inlineData: { mime_type: mediaType, data: source.data }
            })
          }
          continue
        }

        // 处理 tool_use
        // 参考 Rust 版本 request.rs 第 735-787 行
        if (part.type === 'tool_use') {
          if (part.name) {
            const toolCallId = typeof part.id === 'string' && part.id ? part.id : undefined
            const args = normalizeToolUseInput(part.input)
            
            // 构建 functionCall 对象（不含 thoughtSignature）
            const functionCall = {
              ...(toolCallId ? { id: toolCallId } : {}),
              name: part.name,
              args
            }
            
            // 签名恢复逻辑（参考 Rust 版本 request.rs 第 756-780 行）
            // 优先级：1. 消息中的签名 2. 工具缓存签名 3. 全局缓存签名
            let finalSig = lastThoughtSignature
            
            if (!finalSig && toolCallId) {
              // 尝试从工具签名缓存恢复
              const cachedToolSig = signatureStore.getToolSignature(toolCallId)
              if (cachedToolSig) {
                finalSig = cachedToolSig
                logger.info(`[ProtocolConverter] 从工具缓存恢复签名: ${toolCallId}`)
              }
            }
            
            if (!finalSig) {
              // 尝试从全局缓存恢复
              const globalSig = signatureStore.get()
              if (globalSig && globalSig.length >= 50) {
                finalSig = globalSig
                logger.info(`[ProtocolConverter] 为 tool_use 注入全局缓存签名`)
              }
            }
            
            // [关键修复] thoughtSignature 应该放在 part 顶层，与 functionCall 同级
            // 参考 Rust 版本 request.rs 第 784 行: part["thoughtSignature"] = json!(encoded_sig);
            // 而不是 functionCall 内部（会导致 Unknown name thoughtSignature at function_call 错误）
            const partObj = { functionCall }
            
            if (finalSig) {
              // Base64 编码签名
              const encodedSig = Buffer.from(finalSig).toString('base64')
              partObj.thoughtSignature = encodedSig
            }
            
            parts.push(partObj)
          }
          continue
        }

        // 处理 tool_result
        if (part.type === 'tool_result') {
          const toolUseId = part.tool_use_id
          const funcName = toolUseIdToName.get(toolUseId) || toolUseId || 'unknown'
          
          let resultText = ''
          if (typeof part.content === 'string') {
            resultText = part.content
          } else if (Array.isArray(part.content)) {
            resultText = part.content
              .filter(c => c?.type === 'text')
              .map(c => c.text || '')
              .join('\n')
          }
          
          // 截断过长的结果
          if (resultText.length > MAX_TOOL_RESULT_CHARS) {
            resultText = resultText.substring(0, MAX_TOOL_RESULT_CHARS) + '\n... [truncated]'
          }
          
          const response = part.is_error 
            ? { error: resultText || 'Tool execution failed' }
            : { result: resultText || '(no output)' }
          
          parts.push({
            functionResponse: {
              name: funcName,
              response,
              ...(toolUseId ? { id: toolUseId } : {})
            }
          })
          continue
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts })
    }
  }

  return contents
}

/**
 * 构建 Gemini 格式的 system parts
 */
function buildSystemParts(system) {
  const parts = []
  
  if (!system) return parts
  
  if (typeof system === 'string') {
    parts.push({ text: system })
  } else if (Array.isArray(system)) {
    for (const item of system) {
      if (item?.type === 'text' && item.text) {
        parts.push({ text: item.text })
      }
    }
  }
  
  return parts
}

/**
 * 清洗 JSON Schema (移除不支持的字段)
 */
function sanitizeSchemaForFunctionDeclarations(schema) {
  // Gemini 支持的字段白名单
  // 参考: Antigravity-Manager2/src-tauri/src/proxy/common/json_schema.rs
  const allowedKeys = new Set([
    'type', 'properties', 'required', 'description', 'enum', 'items'
  ])

  // 完全移除的黑名单字段 (参考 Rust 版本的 hard_remove_fields)
  const hardRemoveFields = new Set([
    '$schema', '$id', '$ref', '$defs', 'definitions',
    'additionalProperties', 'format', 'default', 'const',
    'uniqueItems', 'examples', 'example',
    'propertyNames', 'cache_control',
    'anyOf', 'oneOf', 'allOf', 'not',
    'if', 'then', 'else',
    'dependencies', 'dependentSchemas', 'dependentRequired',
    'contentEncoding', 'contentMediaType',
    'deprecated', 'readOnly', 'writeOnly', 'title',
    // 数字校验字段
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
    'minLength', 'maxLength', 'minItems', 'maxItems',
    'multipleOf', 'pattern'
  ])

  if (schema === null || schema === undefined) return null
  if (typeof schema !== 'object') return schema
  if (Array.isArray(schema)) {
    return schema.map(item => sanitizeSchemaForFunctionDeclarations(item)).filter(Boolean)
  }

  const sanitized = {}
  
  for (const [key, value] of Object.entries(schema)) {
    // 完全跳过黑名单字段
    if (hardRemoveFields.has(key)) continue
    
    // 只保留白名单字段
    if (!allowedKeys.has(key)) continue

    if (key === 'properties') {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const props = {}
        for (const [propName, propSchema] of Object.entries(value)) {
          const sanitizedProp = sanitizeSchemaForFunctionDeclarations(propSchema)
          if (sanitizedProp && typeof sanitizedProp === 'object') {
            props[propName] = sanitizedProp
          }
        }
        sanitized.properties = props
      }
      continue
    }

    if (key === 'required') {
      if (Array.isArray(value)) {
        // 过滤 required，只保留 properties 中存在的字段
        const propKeys = sanitized.properties ? Object.keys(sanitized.properties) : []
        const req = value.filter(item => 
          typeof item === 'string' && (propKeys.length === 0 || propKeys.includes(item))
        )
        if (req.length > 0) sanitized.required = req
      }
      continue
    }

    if (key === 'enum') {
      if (Array.isArray(value)) {
        // 确保 enum 值全部为字符串 (Gemini 要求)
        const en = value.map(item => {
          if (typeof item === 'string') return item
          if (typeof item === 'number' || typeof item === 'boolean') return String(item)
          if (item === null) return 'null'
          return JSON.stringify(item)
        })
        if (en.length > 0) sanitized.enum = en
      }
      continue
    }

    if (key === 'type') {
      // 处理联合类型 ["string", "null"] -> "string"
      if (Array.isArray(value)) {
        const nonNull = value.find(t => t !== 'null')
        sanitized.type = (nonNull || 'string').toLowerCase()
      } else if (typeof value === 'string') {
        sanitized.type = value.toLowerCase()
      }
      continue
    }

    const sanitizedValue = sanitizeSchemaForFunctionDeclarations(value)
    if (sanitizedValue !== null && sanitizedValue !== undefined) {
      sanitized[key] = sanitizedValue
    }
  }

  // 确保 schema 至少有一个 type
  if (!sanitized.type) {
    if (sanitized.items) sanitized.type = 'array'
    else if (sanitized.properties || sanitized.required) sanitized.type = 'object'
    else if (sanitized.enum) sanitized.type = 'string'
    else {
      sanitized.type = 'object'
      sanitized.properties = {}
    }
  }

  if (sanitized.type === 'object' && !sanitized.properties) {
    sanitized.properties = {}
  }

  return sanitized
}

/**
 * 将 Anthropic 工具定义转换为 Gemini 格式
 */
function convertAnthropicToolsToGeminiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null

  const functionDeclarations = tools
    .map(tool => {
      const toolDef = tool?.custom && typeof tool.custom === 'object' ? tool.custom : tool
      if (!toolDef || !toolDef.name) return null

      // 跳过 web_search 等内置工具
      if (toolDef.name === 'web_search' || toolDef.name === 'google_search') {
        return null
      }
      if (toolDef.type === 'web_search_20250305' || tool.type === 'web_search_20250305') {
        return null
      }

      const description = toolDef.description || ''
      
      // input_schema 是必需的，提供默认值
      // 参考: Antigravity-Manager2/src-tauri/src/proxy/mappers/claude/request.rs
      let inputSchema = toolDef.input_schema || toolDef.parameters || {
        type: 'object',
        properties: {}
      }
      
      // 清理 schema，移除 Gemini 不支持的字段
      const cleanedSchema = sanitizeSchemaForFunctionDeclarations(inputSchema)

      // 使用 Gemini 原生格式 (functionDeclarations)
      // 与 Rust 版本保持一致
      return {
        name: toolDef.name,
        description,
        parameters: cleanedSchema
      }
    })
    .filter(Boolean)

  if (functionDeclarations.length === 0) return null

  return [{ functionDeclarations }]
}

/**
 * 将 Anthropic 的 tool_choice 转换为 Gemini 的 toolConfig
 */
function convertAnthropicToolChoiceToGeminiToolConfig(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return null

  const { type } = toolChoice
  if (!type) return null

  if (type === 'auto') return { functionCallingConfig: { mode: 'AUTO' } }
  if (type === 'any') return { functionCallingConfig: { mode: 'ANY' } }
  if (type === 'tool') {
    const { name } = toolChoice
    if (!name) return { functionCallingConfig: { mode: 'ANY' } }
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } }
  }
  if (type === 'none') return { functionCallingConfig: { mode: 'NONE' } }

  return null
}

// ============================================================================
// 主转换函数
// ============================================================================

/**
 * 构建 Gemini/Antigravity 请求体
 * 
 * @param {Object} body - Anthropic 请求体
 * @param {string} baseModel - 基础模型名
 * @param {Object} options - 选项
 * @returns {Object} { model, request } Gemini 请求对象
 */
function buildGeminiRequestFromAnthropic(body, baseModel, { sessionId = null } = {}) {
  // ========== 核心修复: 模型名称映射 ==========
  // Claude Code 客户端发送的模型名需要映射为 Antigravity API 支持的模型名
  const mappedModel = mapClaudeModelToGemini(baseModel)
  if (mappedModel !== baseModel) {
    logger.info(`[ProtocolConverter] 模型映射: ${baseModel} → ${mappedModel}`)
  }

  const normalizedMessages = normalizeAnthropicMessages(body.messages || [])
  const toolUseIdToName = buildToolUseIdToNameMap(normalizedMessages || [])

  // 判断是否可以启用 thinking
  let canEnableThinking = false
  if (body?.thinking?.type === 'enabled') {
    const budgetRaw = Number(body.thinking.budget_tokens)
    if (Number.isFinite(budgetRaw)) {
      canEnableThinking = canEnableAntigravityThinking(normalizedMessages)
    }
  }

  const contents = convertAnthropicMessagesToGeminiContents(
    normalizedMessages || [],
    toolUseIdToName,
    { stripThinking: !canEnableThinking }
  )
  
  const systemParts = buildSystemParts(body.system)

  // 注入系统提示
  systemParts.unshift({ text: ANTIGRAVITY_SYSTEM_INSTRUCTION_PREFIX })
  systemParts.push({ text: TOOL_ERROR_CONTINUE_PROMPT })
  systemParts.push({ text: ANTIGRAVITY_TOOL_FOLLOW_THROUGH_PROMPT })

  const temperature = typeof body.temperature === 'number' ? body.temperature : 1

  // 参考 Rust 版本: maxOutputTokens 硬编码为 64000
  // 这是因为 thinking budget_tokens 必须小于 maxOutputTokens
  const generationConfig = {
    temperature,
    maxOutputTokens: 64000,
    candidateCount: 1
  }

  if (typeof body.top_p === 'number') {
    generationConfig.topP = body.top_p
  }
  if (typeof body.top_k === 'number') {
    generationConfig.topK = body.top_k
  }

  // 配置 thinking
  // 参考: Antigravity-Manager2/src-tauri/src/proxy/mappers/claude/request.rs
  if (body?.thinking?.type === 'enabled') {
    const budgetRaw = Number(body.thinking.budget_tokens)
    if (Number.isFinite(budgetRaw) && canEnableThinking) {
      // budget_tokens 必须 >= 1024
      const budget = Math.max(1024, Math.trunc(budgetRaw))
      generationConfig.thinkingConfig = {
        thinkingBudget: budget,
        includeThoughts: true  // 使用 includeThoughts 而非 include_thoughts
      }
    }
  }

  const geminiRequestBody = {
    contents,
    generationConfig,
    systemInstruction: { role: 'user', parts: systemParts },
    // 安全设置 - 参考 Antigravity-Manager2/src-tauri/src/proxy/mappers/claude/request.rs
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' }
    ]
  }

  const geminiTools = convertAnthropicToolsToGeminiTools(body.tools)
  if (geminiTools) {
    geminiRequestBody.tools = geminiTools
  }

  const toolConfig = convertAnthropicToolChoiceToGeminiToolConfig(body.tool_choice)
  if (toolConfig) {
    geminiRequestBody.toolConfig = toolConfig
  } else if (geminiTools) {
    geminiRequestBody.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
  }

  // 返回映射后的模型名
  return { model: mappedModel, request: geminiRequestBody }
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
  buildGeminiRequestFromAnthropic,
  normalizeAnthropicMessages,
  convertAnthropicMessagesToGeminiContents,
  convertAnthropicToolsToGeminiTools,
  convertAnthropicToolChoiceToGeminiToolConfig,
  buildSystemParts,
  buildToolUseIdToNameMap,
  sanitizeThoughtSignature,
  extractAnthropicText
}
