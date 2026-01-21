/**
 * CLIProxyAPI 转发路由
 *
 * 将请求透明转发到本地 CLIProxyAPI 服务
 * 支持 OpenAI/Gemini/Claude/Codex 等多种 API 格式
 *
 * 路由前缀：/cliproxy/api
 * 目标服务：http://127.0.0.1:8317（可通过环境变量配置）
 */

const express = require('express')
const router = express.Router()
const logger = require('../utils/logger')
const cliproxyapiService = require('../services/cliproxyapiService')
const cliproxyapiConfig = require('../../config/cliproxyapi')

/**
 * 中间件：检查服务是否启用
 */
router.use((req, res, next) => {
  if (!cliproxyapiConfig.enabled) {
    logger.warn(`[CLIProxyAPI] 服务已禁用，拒绝请求: ${req.originalUrl}`)
    return res.status(503).json({
      error: {
        type: 'service_disabled',
        message: 'CLIProxyAPI 转发服务已禁用'
      }
    })
  }
  next()
})

/**
 * GET /
 *
 * 根路径，返回服务信息
 */
router.get('/', (req, res) => {
  res.json({
    service: 'CLIProxyAPI Proxy',
    version: '1.0.0',
    description: '透明转发到本地 CLIProxyAPI 服务',
    upstream: cliproxyapiConfig.baseUrl,
    enabled: cliproxyapiConfig.enabled,
    endpoints: {
      messages: 'POST /v1/messages',
      chat: 'POST /v1/chat/completions',
      models: 'GET /v1/models',
      health: 'GET /health'
    },
    note: '所有请求将透明转发到 CLIProxyAPI，支持 OpenAI/Gemini/Claude/Codex 格式'
  })
})

/**
 * GET /health
 *
 * 健康检查端点
 * 检查 CLIProxyAPI 上游服务是否可用
 */
router.get('/health', async (req, res) => {
  try {
    const health = await cliproxyapiService.healthCheck()

    if (health.status === 'healthy') {
      res.json({
        status: 'healthy',
        proxy: 'CLIProxyAPI Proxy',
        upstream: {
          url: cliproxyapiConfig.baseUrl,
          ...health
        }
      })
    } else {
      res.status(503).json({
        status: 'unhealthy',
        proxy: 'CLIProxyAPI Proxy',
        upstream: {
          url: cliproxyapiConfig.baseUrl,
          ...health
        }
      })
    }
  } catch (error) {
    logger.error('[CLIProxyAPI] 健康检查异常:', error)
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    })
  }
})

/**
 * POST /api/event_logging/batch 和 /event_logging/batch
 *
 * Mock 事件日志端点，直接返回成功，不转发到 CLIProxyAPI
 * Claude CLI 会发送这类请求用于遥测
 */
router.post(['/api/event_logging/batch', '/event_logging/batch'], (req, res) => {
  res.status(200).json({ status: 'ok' })
})

/**
 * POST /v1/messages
 *
 * Claude 格式消息 API
 * 转发到 CLIProxyAPI 处理
 */
router.post('/v1/messages', async (req, res) => {
  try {
    logger.info('[CLIProxyAPI] 接收 Claude 消息请求', {
      model: req.body?.model,
      stream: req.body?.stream
    })
    await cliproxyapiService.proxyRequest(req, res)
  } catch (error) {
    logger.error('[CLIProxyAPI] Claude 消息请求失败:', error)
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: {
          type: 'internal_error',
          message: error.message
        }
      })
    }
  }
})

/**
 * POST /v1/chat/completions
 *
 * OpenAI 格式 Chat API
 * 转发到 CLIProxyAPI 处理
 */
router.post('/v1/chat/completions', async (req, res) => {
  try {
    logger.info('[CLIProxyAPI] 接收 OpenAI Chat 请求', {
      model: req.body?.model,
      stream: req.body?.stream
    })
    await cliproxyapiService.proxyRequest(req, res)
  } catch (error) {
    logger.error('[CLIProxyAPI] OpenAI Chat 请求失败:', error)
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          type: 'internal_error',
          message: error.message
        }
      })
    }
  }
})

/**
 * GET /v1/models
 *
 * 获取可用模型列表
 */
router.get('/v1/models', async (req, res) => {
  try {
    await cliproxyapiService.proxyRequest(req, res)
  } catch (error) {
    logger.error('[CLIProxyAPI] 获取模型列表失败:', error)
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          type: 'internal_error',
          message: error.message
        }
      })
    }
  }
})

/**
 * 通配路由
 *
 * 所有未匹配的请求都透明转发到 CLIProxyAPI
 * 支持 CLIProxyAPI 的其他端点（如 Gemini、Codex 等格式）
 */
router.all('*', async (req, res) => {
  try {
    logger.info(`[CLIProxyAPI] 通配转发: ${req.method} ${req.originalUrl}`)
    await cliproxyapiService.proxyRequest(req, res)
  } catch (error) {
    logger.error('[CLIProxyAPI] 通配转发失败:', error)
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          type: 'proxy_error',
          message: error.message
        }
      })
    }
  }
})

module.exports = router
