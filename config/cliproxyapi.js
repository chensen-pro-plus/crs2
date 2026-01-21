/**
 * CLIProxyAPI 配置模块
 *
 * 配置与本地 CLIProxyAPI 服务的连接参数
 * CLIProxyAPI 是一个 Go 语言编写的代理服务，提供 OpenAI/Gemini/Claude/Codex 兼容 API
 */

module.exports = {
  // CLIProxyAPI 服务基础 URL
  // 该服务默认运行在 8317 端口
  baseUrl: process.env.CLIPROXYAPI_BASE_URL || 'http://127.0.0.1:8317',

  // 请求超时时间（毫秒）
  // 由于 AI 模型响应可能较慢，设置较长的超时时间
  timeout: parseInt(process.env.CLIPROXYAPI_TIMEOUT, 10) || 600000, // 10 分钟

  // 流式响应超时时间（毫秒）
  // 流式响应需要更长的超时
  streamTimeout: parseInt(process.env.CLIPROXYAPI_STREAM_TIMEOUT, 10) || 900000, // 15 分钟

  // 是否启用此转发路由
  enabled: process.env.CLIPROXYAPI_ENABLED !== 'false',

  // 上游 CLIProxyAPI 的 API 密钥（写死在这里，转发时自动添加）
  upstreamApiKey: process.env.CLIPROXYAPI_UPSTREAM_KEY || 'your-api-key-1',

  // 健康检查配置
  healthCheck: {
    // 健康检查路径
    path: '/health',
    // 健康检查间隔（毫秒）
    interval: 30000
  }
}

