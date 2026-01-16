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
 */
function canEnableAntigravityThinking(messages) {
  // 找最后一条 assistant 消息，检查是否有有效的 thinking block
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) return false
    
    const hasThinking = msg.content.some(part => 
      part?.type === 'thinking' && 
      part.thinking && 
      sanitizeThoughtSignature(part.signature)
    )
    return hasThinking
  }
  return true // 如果没有历史 assistant 消息，允许启用
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
        if (part.type === 'thinking' || part.type === 'redacted_thinking') {
          if (stripThinking) continue
          
          const thinkingText = extractAnthropicText(part.thinking || part.text || '')
          const signature = sanitizeThoughtSignature(part.signature)
          const hasThinkingText = thinkingText && !shouldSkipText(thinkingText)
          const hasSignature = Boolean(signature)

          // 空 thinking block 跳过
          if (!hasThinkingText && !hasSignature) continue
          // 无签名跳过
          if (!hasSignature) continue

          lastThoughtSignature = signature
          const thoughtPart = { thought: true, thoughtSignature: signature }
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
        if (part.type === 'tool_use') {
          if (part.name) {
            const toolCallId = typeof part.id === 'string' && part.id ? part.id : undefined
            const args = normalizeToolUseInput(part.input)
            const functionCall = {
              ...(toolCallId ? { id: toolCallId } : {}),
              name: part.name,
              args
            }
            
            // 如果有 thinking 签名，附加到 functionCall
            if (lastThoughtSignature) {
              functionCall.thoughtSignature = lastThoughtSignature
            }
            
            parts.push({ functionCall })
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
  const allowedKeys = new Set([
    'type', 'properties', 'required', 'description', 'enum', 'items',
    'anyOf', 'oneOf', 'allOf', 'additionalProperties',
    'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength'
  ])

  if (schema === null || schema === undefined) return null
  if (typeof schema !== 'object') return schema
  if (Array.isArray(schema)) {
    return schema.map(item => sanitizeSchemaForFunctionDeclarations(item)).filter(Boolean)
  }

  const sanitized = {}
  for (const [key, value] of Object.entries(schema)) {
    // 跳过元字段和不支持的字段
    if (['$schema', '$id', 'title', 'default', 'examples', 'example', 'format'].includes(key)) continue
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
        const req = value.filter(item => typeof item === 'string')
        if (req.length > 0) sanitized.required = req
      }
      continue
    }

    if (key === 'enum') {
      if (Array.isArray(value)) {
        const en = value.filter(item => ['string', 'number', 'boolean'].includes(typeof item))
        if (en.length > 0) sanitized.enum = en
      }
      continue
    }

    const sanitizedValue = sanitizeSchemaForFunctionDeclarations(value)
    if (sanitizedValue !== null && sanitizedValue !== undefined) {
      sanitized[key] = sanitizedValue
    }
  }

  // 确保 schema 至少是一个 object schema
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

      const description = compactToolDescription(toolDef.description || '')
      const inputSchema = toolDef.input_schema || toolDef.parameters || {}
      const sanitizedSchema = sanitizeSchemaForFunctionDeclarations(inputSchema)
      const compactedSchema = compactSchemaDescriptions(sanitizedSchema)

      return {
        name: toolDef.name,
        description,
        parametersJsonSchema: compactedSchema
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
  const maxTokens = Number.isFinite(body.max_tokens) ? body.max_tokens : 4096

  const generationConfig = {
    temperature,
    maxOutputTokens: maxTokens,
    candidateCount: 1
  }

  if (typeof body.top_p === 'number') {
    generationConfig.topP = body.top_p
  }
  if (typeof body.top_k === 'number') {
    generationConfig.topK = body.top_k
  }

  // 配置 thinking
  if (body?.thinking?.type === 'enabled') {
    const budgetRaw = Number(body.thinking.budget_tokens)
    if (Number.isFinite(budgetRaw) && canEnableThinking) {
      generationConfig.thinkingConfig = {
        thinkingBudget: Math.trunc(budgetRaw),
        include_thoughts: true
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
