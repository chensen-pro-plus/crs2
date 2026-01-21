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

  // 🔄 模型名称映射配置
  // 将用户请求中的模型名映射到 CLIProxyAPI 实际使用的模型名
  // 格式: { "用户模型名": "目标模型名" }
  // 支持通配符: 使用 "*" 作为后缀匹配，例如 "claude-3-5-*" 可匹配 "claude-3-5-sonnet", "claude-3-5-haiku" 等
  // 设置为 null 或空对象表示不进行映射
  modelMapping: {
    // 示例：将 "my-custom-model" 映射为 "claude-3-5-sonnet-20241022"
    // "my-custom-model": "claude-3-5-sonnet-20241022",
    // 示例：将所有 "gpt-4o" 开头的模型映射为 "claude-3-5-sonnet-20241022"
    // "gpt-4o*": "claude-3-5-sonnet-20241022",

    "gemini-3-pro-high":"gemini-3-pro-preview", 
    "gemini-3-flash": "gemini-3-flash-preview",
    "claude-haiku-4-5": "gemini-claude-sonnet-4-5",
    "claude-sonnet-4-5": "gemini-claude-sonnet-4-5",
    "claude-sonnet-4-5-thinking": "gemini-claude-sonnet-4-5-thinking",
    "claude-opus-4-5-thinking": "gemini-claude-opus-4-5-thinking",
    


    "gemini-claude-opus-4-5-thinking": "gemini-claude-opus-4-5-thinking",
    "gemini-claude-sonnet-4-5": "gemini-claude-sonnet-4-5",
    "gemini-claude-sonnet-4-5-thinking":"gemini-claude-sonnet-4-5-thinking",
    "gemini-3-pro-image-preview":"gemini-3-pro-image-preview",
    "gemini-3-pro-preview":"gemini-3-pro-preview", 
    "gemini-3-flash-preview": "gemini-3-flash-preview",
  },

  /**
   * 获取映射后的目标模型名
   * @param {string} requestModel - 用户请求中的模型名
   * @returns {string} 映射后的模型名，如果没有匹配的映射则返回原模型名
   */
  getTargetModel(requestModel) {
    if (!requestModel || !this.modelMapping || Object.keys(this.modelMapping).length === 0) {
      return requestModel
    }

    // 1. 精确匹配
    if (this.modelMapping[requestModel]) {
      return this.modelMapping[requestModel]
    }

    // 2. 通配符匹配（支持 "pattern*" 形式的后缀匹配）
    for (const [pattern, targetModel] of Object.entries(this.modelMapping)) {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1) // 去掉末尾的 *
        if (requestModel.startsWith(prefix)) {
          return targetModel
        }
      }
    }

    // 3. 没有匹配，返回原模型名
    return requestModel
  },

  // 健康检查配置
  healthCheck: {
    // 健康检查路径
    path: '/health',
    // 健康检查间隔（毫秒）
    interval: 30000
  }
}

