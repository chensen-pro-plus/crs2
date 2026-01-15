/**
 * Antigravity Enhanced 路由
 *
 * 提供增强版的 Antigravity API 端点，不影响原有 /antigravity/api/ 路由
 *
 * 功能特性：
 * - 🔥 Warmup 请求拦截（节省配额）
 * - 🔄 自动 Stream 转换（更宽松配额限制）
 * - ⬇️ 后台任务智能降级（标题/摘要等任务降级到 Flash 模型）
 * - ⏱️ 多策略退避重试（根据错误类型选择最优策略）
 */

const express = require('express')
const router = express.Router()
const logger = require('../utils/logger')

// 导入增强服务
const { handleMessages, handleModels, healthCheck } = require('../services/antigravityEnhanced')

/**
 * POST /v1/messages
 *
 * 主消息处理端点，完全兼容 Anthropic Claude API 格式
 */
router.post('/v1/messages', async (req, res) => {
  try {
    await handleMessages(req, res)
  } catch (error) {
    logger.error('[AntigravityEnhanced] 路由处理异常:', error)
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: {
          type: 'internal_error',
          message: '服务内部错误'
        }
      })
    }
  }
})

/**
 * POST /v1/messages/count_tokens
 *
 * Token 计数端点
 */
router.post('/v1/messages/count_tokens', async (req, res) => {
  try {
    const { handleCountTokens } = require('../services/antigravityEnhanced')
    await handleCountTokens(req, res)
  } catch (error) {
    logger.error('[AntigravityEnhanced] Token 计数异常:', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /v1/models
 *
 * 获取可用模型列表
 */
router.get('/v1/models', async (req, res) => {
  try {
    await handleModels(req, res)
  } catch (error) {
    logger.error('[AntigravityEnhanced] 获取模型列表失败:', error)
    res.status(500).json({
      error: {
        type: 'api_error',
        message: error.message
      }
    })
  }
})

/**
 * GET /health
 *
 * 健康检查端点
 */
router.get('/health', async (req, res) => {
  try {
    await healthCheck(req, res)
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    })
  }
})

/**
 * POST /api/event_logging/batch
 *
 * Mock 事件日志端点，解决某些客户端拼接重复 /api 路径的问题
 */
router.post(['/api/event_logging/batch', '/event_logging/batch'], (req, res) => {
  res.status(200).json({ status: 'ok' })
})

/**
 * GET /
 *
 * 根路径，返回服务信息
 */
router.get('/', (req, res) => {
  res.json({
    service: 'Antigravity Enhanced API',
    version: '1.0.1',
    description:
      '增强版 Antigravity API 代理，提供 Warmup 拦截、自动 Stream 转换、后台任务降级等功能',
    endpoints: {
      messages: 'POST /v1/messages',
      models: 'GET /v1/models',
      health: 'GET /health',
      event_logging: 'POST /api/event_logging/batch'
    },
    features: ['Warmup 请求拦截', '自动 Stream 转换', '后台任务智能降级', '多策略退避重试']
  })
})

module.exports = router
