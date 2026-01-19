/**
 * Antigravity Enhanced 模型名称映射
 * 
 * 将 Claude Code 客户端发送的模型名映射为 Antigravity API 支持的模型名
 * 参考: Antigravity-Manager2/src-tauri/src/proxy/common/model_mapping.rs
 */

const logger = require('../../utils/logger')

// ============================================================================
// Claude 模型到 Gemini/Antigravity 模型的映射表
// ============================================================================

const CLAUDE_TO_GEMINI_MAP = {
  // ========== 直接支持的模型 (无需转换) ==========
  'claude-opus-4-5-thinking': 'claude-opus-4-5-thinking',
  'claude-sonnet-4-5': 'claude-sonnet-4-5',
  'claude-sonnet-4-5-thinking': 'claude-sonnet-4-5-thinking',

  // ========== Claude 别名映射 ==========
  // Sonnet 系列
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5-thinking',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-5',
  'claude-3-5-sonnet-20240620': 'claude-sonnet-4-5',
  
  // Opus 系列
  'claude-opus-4': 'claude-opus-4-5-thinking',
  'claude-opus-4-5-20251101': 'claude-opus-4-5-thinking',
  
  // Haiku 系列 (映射到 Sonnet)
  'claude-haiku-4': 'claude-sonnet-4-5',
  'claude-3-haiku-20240307': 'claude-sonnet-4-5',
  'claude-haiku-4-5-20251001': 'claude-sonnet-4-5',

  // ========== OpenAI 协议映射 (兼容 OpenAI 客户端) ==========
  'gpt-4': 'gemini-2.5-pro',
  'gpt-4-turbo': 'gemini-2.5-pro',
  'gpt-4-turbo-preview': 'gemini-2.5-pro',
  'gpt-4-0125-preview': 'gemini-2.5-pro',
  'gpt-4-1106-preview': 'gemini-2.5-pro',
  'gpt-4-0613': 'gemini-2.5-pro',
  'gpt-4o': 'gemini-2.5-pro',
  'gpt-4o-2024-05-13': 'gemini-2.5-pro',
  'gpt-4o-2024-08-06': 'gemini-2.5-pro',
  'gpt-4o-mini': 'gemini-2.5-flash',
  'gpt-4o-mini-2024-07-18': 'gemini-2.5-flash',
  'gpt-3.5-turbo': 'gemini-2.5-flash',
  'gpt-3.5-turbo-16k': 'gemini-2.5-flash',
  'gpt-3.5-turbo-0125': 'gemini-2.5-flash',
  'gpt-3.5-turbo-1106': 'gemini-2.5-flash',
  'gpt-3.5-turbo-0613': 'gemini-2.5-flash',

  // ========== Gemini 直接支持 ==========
  'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
  'gemini-2.5-flash-thinking': 'gemini-2.5-flash-thinking',
  'gemini-3-pro-low': 'gemini-3-pro-low',
  'gemini-3-pro-high': 'gemini-3-pro-high',
  'gemini-3-pro-preview': 'gemini-3-pro-preview',
  'gemini-3-pro': 'gemini-3-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-3-flash': 'gemini-3-flash',
  'gemini-3-pro-image': 'gemini-3-pro-image'
}

// 默认兜底模型
const DEFAULT_MODEL = 'claude-sonnet-4-5'

// 联网搜索专用模型 (只有 gemini-2.5-flash 支持 googleSearch)
const WEB_SEARCH_MODEL = 'gemini-2.5-flash'

/**
 * 获取支持联网搜索的模型名
 * 注：Gemini v1internal API 只有 gemini-2.5-flash 支持 googleSearch 工具
 * 其他模型（包括 Gemini 3 Pro、thinking 模型、Claude 别名）必须降级
 * 
 * @returns {string} 联网搜索专用模型名
 */
function getWebSearchModel() {
  return WEB_SEARCH_MODEL
}

/**
 * 将 Claude/OpenAI 模型名映射为 Antigravity API 支持的模型名
 * 
 * @param {string} inputModel - 原始模型名
 * @returns {string} 映射后的模型名
 */
function mapClaudeModelToGemini(inputModel) {
  if (!inputModel) {
    logger.warn('[ModelMapping] 输入模型名为空，使用默认模型')
    return DEFAULT_MODEL
  }

  // 1. 精确匹配映射表
  if (CLAUDE_TO_GEMINI_MAP[inputModel]) {
    const mapped = CLAUDE_TO_GEMINI_MAP[inputModel]
    if (mapped !== inputModel) {
      logger.debug(`[ModelMapping] 精确映射: ${inputModel} → ${mapped}`)
    }
    return mapped
  }

  // 2. gemini- 前缀直接透传 (支持动态版本号)
  if (inputModel.startsWith('gemini-')) {
    logger.debug(`[ModelMapping] Gemini 模型直接透传: ${inputModel}`)
    return inputModel
  }

  // 3. 包含 thinking 后缀的模型直接透传
  if (inputModel.includes('thinking')) {
    logger.debug(`[ModelMapping] Thinking 模型直接透传: ${inputModel}`)
    return inputModel
  }

  // 4. 兜底: 使用默认模型
  logger.info(`[ModelMapping] 未知模型 "${inputModel}"，使用默认模型: ${DEFAULT_MODEL}`)
  return DEFAULT_MODEL
}

/**
 * 获取所有支持的模型列表
 * @returns {string[]} 模型名称数组
 */
function getSupportedModels() {
  return Object.keys(CLAUDE_TO_GEMINI_MAP)
}

module.exports = {
  mapClaudeModelToGemini,
  getSupportedModels,
  getWebSearchModel,
  CLAUDE_TO_GEMINI_MAP,
  DEFAULT_MODEL,
  WEB_SEARCH_MODEL
}
