# 🚀 Antigravity 模块详解

> 本文档详细介绍 Claude Relay Service 项目中 **Antigravity** 模块的代码结构、工作原理和使用方法。

---

## 📋 目录

- [什么是 Antigravity？](#什么是-antigravity)
- [核心代码文件](#核心代码文件)
- [工作原理](#工作原理)
- [配置说明](#配置说明)
- [API 端点](#api-端点)
- [使用方法](#使用方法)
- [数据流程图](#数据流程图)
- [关键函数详解](#关键函数详解)
- [调试与日志](#调试与日志)
- [常见问题](#常见问题)

---

## 什么是 Antigravity？

**Antigravity** 是 Claude Relay Service 项目中的一个核心功能模块，它本质上是一个 **Claude 代理层 (CLI Proxy API)**。

### 核心功能

| 功能 | 描述 |
|------|------|
| 协议转换 | 将 Anthropic Claude API 格式转换为 Gemini 格式 |
| OAuth 认证 | 使用 Google Cloud Code 的 OAuth 认证机制 |
| 模型代理 | 允许通过 Gemini 账户池访问 Claude 模型 |
| 统一调度 | 支持账户池调度、负载均衡、故障转移 |

### 与其他模块的区别

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Claude Relay Service 账户类型                      │
├─────────────────────────────────────────────────────────────────────┤
│  类型              │  路由前缀         │  认证方式      │  上游服务    │
├─────────────────────────────────────────────────────────────────────┤
│  claude-official  │  /api/           │  Claude OAuth  │  Anthropic  │
│  gemini-cli       │  /gemini/        │  Google OAuth  │  Google AI  │
│  antigravity      │  /antigravity/   │  Google OAuth  │  Cloud Code │
│  openai-responses │  /openai/        │  API Key       │  OpenAI     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 核心代码文件

### 主要服务文件

| 文件路径 | 作用 | 代码行数 |
|---------|------|---------|
| `src/services/antigravityClient.js` | Antigravity 上游客户端，负责与 Google Cloud Code API 通信 | ~596 行 |
| `src/services/anthropicGeminiBridgeService.js` | Anthropic → Gemini 格式转换桥接服务 | ~3084 行 |
| `src/services/geminiAccountService.js` | Gemini/Antigravity 账户管理服务 | - |
| `src/services/unifiedGeminiScheduler.js` | Gemini 账户统一调度器 | - |

### 工具类文件

| 文件路径 | 作用 |
|---------|------|
| `src/utils/antigravityModel.js` | 模型名称映射和元数据管理 |
| `src/utils/antigravityUpstreamDump.js` | 上游请求 dump 调试工具 |
| `src/utils/antigravityUpstreamResponseDump.js` | 上游响应 dump 调试工具 |
| `src/utils/geminiSchemaCleaner.js` | JSON Schema 清洗工具 |

### 路由文件

| 文件路径 | 作用 |
|---------|------|
| `src/routes/api.js` | 主 API 路由，包含 Antigravity 分流逻辑 |
| `src/routes/openaiGeminiRoutes.js` | OpenAI 格式 → Gemini/Antigravity 路由 |
| `src/services/balanceProviders/geminiBalanceProvider.js` | 余额查询（支持 Antigravity 配额） |

---

## 工作原理

### 1. 请求入口和路由分流

当请求到达 `/antigravity/api/` 路径时，`api.js` 会识别并标记为 Antigravity 请求：

```javascript
// src/routes/api.js 中的分流逻辑
const forcedVendor = req._anthropicVendor  // 'antigravity'

// 判断权限
const requiredService =
  forcedVendor === 'gemini-cli' || forcedVendor === 'antigravity' 
    ? 'gemini' 
    : 'claude'

// 分流到 Gemini 桥接服务
if (forcedVendor === 'gemini-cli' || forcedVendor === 'antigravity') {
  return await handleAnthropicMessagesToGemini(req, res, { 
    vendor: forcedVendor, 
    baseModel 
  })
}
```

### 2. 账户调度 (unifiedGeminiScheduler.js)

调度器会区分 `gemini-cli` 和 `antigravity` 两种 OAuth Provider：

```javascript
// src/services/unifiedGeminiScheduler.js
const OAUTH_PROVIDER_GEMINI_CLI = 'gemini-cli'
const OAUTH_PROVIDER_ANTIGRAVITY = 'antigravity'
const KNOWN_OAUTH_PROVIDERS = [OAUTH_PROVIDER_GEMINI_CLI, OAUTH_PROVIDER_ANTIGRAVITY]

// 根据 oauthProvider 字段区分账户类型
function normalizeOAuthProvider(oauthProvider) {
  return oauthProvider === OAUTH_PROVIDER_ANTIGRAVITY
    ? OAUTH_PROVIDER_ANTIGRAVITY
    : OAUTH_PROVIDER_GEMINI_CLI
}
```

### 3. 格式转换 (anthropicGeminiBridgeService.js)

这是最核心的模块，负责将 Anthropic 格式转换为 Gemini 格式：

#### 消息格式转换

| Anthropic 格式 | Gemini 格式 |
|---------------|-------------|
| `messages[]` | `contents[]` |
| `system` | `systemInstruction.parts[]` |
| `tools[]` | `tools[].functionDeclarations[]` |
| `tool_use` | `functionCall` |
| `tool_result` | `functionResponse` |

#### 关键转换逻辑

```javascript
// 消息角色映射
// Anthropic: user, assistant
// Gemini: user, model

// 内容块转换
// text → { text: "..." }
// image → { inlineData: { mimeType, data } }
// tool_use → { functionCall: { name, args } }
// tool_result → { functionResponse: { name, response } }
```

### 4. 构建上游请求 (antigravityClient.js)

#### 请求包装 (Envelope)

```javascript
function buildAntigravityEnvelope({ requestData, projectId, sessionId, userPromptId }) {
  const model = mapAntigravityUpstreamModel(requestData?.model)
  
  const envelope = {
    project: resolvedProjectId,       // 项目 ID
    requestId: `req-${uuidv4()}`,     // 唯一请求 ID
    model,                             // 上游模型名称
    userAgent: 'antigravity',          // 固定标识
    request: {
      sessionId: resolvedSessionId,    // 会话 ID
      contents: [...],                 // Gemini 格式的消息
      tools: [...],                    // 工具定义
      generationConfig: {...}          // 生成配置
    }
  }
  
  return { model, envelope }
}
```

#### 请求头构建

```javascript
function getAntigravityHeaders(accessToken, baseUrl) {
  return {
    Host: host,                                           // 动态计算
    'User-Agent': 'antigravity/1.11.3 windows/amd64',    // 可配置
    Authorization: `Bearer ${accessToken}`,               // Google OAuth Token
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip',
    requestType: 'agent'
  }
}
```

### 5. 上游 API 端点

Antigravity 使用 Google Cloud Code 的内部 API：

| 端点类型 | URL |
|---------|-----|
| 生产环境 | `https://cloudcode-pa.googleapis.com` |
| 沙箱环境 | `https://daily-cloudcode-pa.sandbox.googleapis.com` |

#### API 路径

| 功能 | 路径 |
|------|------|
| 非流式生成 | `POST /v1internal:generateContent` |
| 流式生成 | `POST /v1internal:streamGenerateContent` |
| 获取可用模型 | `POST /v1internal:fetchAvailableModels` |
| Token 计数 | `POST /v1internal:countTokens` |

### 6. 错误重试和 Fallback

```javascript
// 支持多端点 fallback
function getAntigravityApiUrlCandidates() {
  // 默认优先使用 daily（沙箱），失败时尝试 prod
  // Claude 模型优先使用 prod（稳定性更好）
}

// 可重试的错误类型
const isRetryable = (error) => {
  // 429: 限流
  // 400/404: 模型不可用
  // ECONNRESET/ETIMEDOUT: 网络错误
}
```

---

## 配置说明

### 环境变量 (.env)

```bash
# ==================== Antigravity OAuth 配置 ====================

# Google OAuth 客户端 ID（用于 Antigravity 账户授权）
ANTIGRAVITY_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com

# Google OAuth 客户端密钥
ANTIGRAVITY_OAUTH_CLIENT_SECRET=your-client-secret

# OAuth 回调地址（默认 http://localhost:45462）
ANTIGRAVITY_OAUTH_REDIRECT_URI=http://localhost:45462


# ==================== Antigravity 上游配置 ====================

# 上游 API 地址
# 可选值：
#   - https://daily-cloudcode-pa.sandbox.googleapis.com (沙箱/测试环境)
#   - https://cloudcode-pa.googleapis.com (生产环境)
ANTIGRAVITY_API_URL=https://daily-cloudcode-pa.sandbox.googleapis.com

# 请求 User-Agent（模拟 Antigravity CLI 客户端）
ANTIGRAVITY_USER_AGENT=antigravity/1.11.3 windows/amd64


# ==================== 调试配置 ====================

# 是否 dump 上游请求（调试用）
ANTIGRAVITY_DEBUG_UPSTREAM_REQUEST_DUMP=false

# 是否 dump 上游响应（调试用）
ANTIGRAVITY_DEBUG_UPSTREAM_RESPONSE_DUMP=false

# dump 文件最大字节数（默认 2MB）
ANTIGRAVITY_DEBUG_UPSTREAM_REQUEST_DUMP_MAX_BYTES=2097152
```

### dump 文件位置

启用调试后，dump 文件会保存在项目根目录：

```
├── antigravity-upstream-requests-dump.jsonl   # 发往上游的请求
└── antigravity-upstream-responses-dump.jsonl  # 上游 SSE 响应
```

---

## API 端点

### 对外暴露的路由

| 路由 | 方法 | 描述 |
|------|------|------|
| `/antigravity/api/v1/messages` | POST | Anthropic 格式消息接口（主要入口） |
| `/antigravity/api/v1/models` | GET | 获取可用模型列表 |

### 请求格式

请求格式与 Anthropic Claude API 完全兼容：

```json
{
  "model": "claude-opus-4-5",
  "max_tokens": 4096,
  "messages": [
    {
      "role": "user",
      "content": "Hello, how are you?"
    }
  ],
  "stream": true
}
```

### 响应格式

响应格式也与 Anthropic Claude API 兼容（由桥接服务转换回来）。

---

## 使用方法

### Claude Code 配置

```bash
# 1. 设置 Base URL 为 Antigravity 专用路径
export ANTHROPIC_BASE_URL="http://127.0.0.1:3000/antigravity/api/"

# 2. 设置 API Key（在后台创建，权限需包含 'all' 或 'gemini'）
export ANTHROPIC_AUTH_TOKEN="cr_your_api_key_here"

# 3. 指定模型名称（直接使用短名，无需前缀）
export ANTHROPIC_MODEL="claude-opus-4-5"

# 4. 启动 Claude Code
claude
```

### 支持的模型

Antigravity 支持通过 Google Cloud Code 访问的 Claude 模型：

| 模型短名 | 完整模型名 |
|---------|-----------|
| `claude-opus-4-5` | `claude-opus-4-5-20251101` |
| `claude-sonnet-4` | `claude-sonnet-4-20250514` |
| `claude-sonnet-4-5` | `claude-sonnet-4-5-20250929` |

---

## 数据流程图

### 整体架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              用户端                                          │
│  ┌──────────────────┐                                                       │
│  │   Claude Code    │  发送 Anthropic 格式请求                               │
│  │   (客户端)        │  POST /antigravity/api/v1/messages                   │
│  └────────┬─────────┘                                                       │
└───────────┼─────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Claude Relay Service                                  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  1. 路由层 (api.js)                                                   │  │
│  │     - 识别 /antigravity/ 前缀                                         │  │
│  │     - 标记 req._anthropicVendor = 'antigravity'                      │  │
│  │     - API Key 认证和权限检查                                          │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  2. 调度器 (unifiedGeminiScheduler.js)                                │  │
│  │     - 筛选 oauthProvider = 'antigravity' 的账户                       │  │
│  │     - 检查账户状态、粘性会话、并发限制                                  │  │
│  │     - 选择最优账户                                                    │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  3. 桥接服务 (anthropicGeminiBridgeService.js)                        │  │
│  │     - Anthropic messages → Gemini contents                           │  │
│  │     - tools → functionDeclarations                                   │  │
│  │     - tool_use/tool_result → functionCall/functionResponse           │  │
│  │     - 压缩工具描述（≤400字符）                                         │  │
│  │     - 校验 thinking signature                                        │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                                    ▼                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  4. 上游客户端 (antigravityClient.js)                                 │  │
│  │     - 构建请求 Envelope (project, requestId, model, request)          │  │
│  │     - 设置认证头 (Authorization: Bearer <access_token>)               │  │
│  │     - 多端点 fallback (daily → prod)                                  │  │
│  │     - 429 限流自动重试                                                │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Google Cloud Code API                                │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  端点:                                                                │  │
│  │  - https://cloudcode-pa.googleapis.com (生产)                         │  │
│  │  - https://daily-cloudcode-pa.sandbox.googleapis.com (沙箱)           │  │
│  │                                                                       │  │
│  │  API:                                                                 │  │
│  │  - POST /v1internal:streamGenerateContent                            │  │
│  │  - POST /v1internal:generateContent                                  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
                            (SSE 流式响应)
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Claude Relay Service                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  5. 响应转换 (anthropicGeminiBridgeService.js)                        │  │
│  │     - Gemini SSE events → Anthropic SSE events                       │  │
│  │     - 提取 usage 数据 (input_tokens, output_tokens)                   │  │
│  │     - 记录使用统计                                                    │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
                              返回客户端
```

### 请求响应时序

```
Client                CRS                    Scheduler              Bridge                  Upstream
  │                    │                        │                      │                       │
  │ POST /antigravity/ │                        │                      │                       │
  │ (Anthropic格式)    │                        │                      │                       │
  │───────────────────>│                        │                      │                       │
  │                    │                        │                      │                       │
  │                    │ selectAccount()        │                      │                       │
  │                    │───────────────────────>│                      │                       │
  │                    │                        │                      │                       │
  │                    │<───────────────────────│                      │                       │
  │                    │ (accountId, token)     │                      │                       │
  │                    │                        │                      │                       │
  │                    │ convert(Anthropic→Gemini)                     │                       │
  │                    │──────────────────────────────────────────────>│                       │
  │                    │                        │                      │                       │
  │                    │                        │                      │ POST /v1internal:     │
  │                    │                        │                      │ streamGenerateContent │
  │                    │                        │                      │──────────────────────>│
  │                    │                        │                      │                       │
  │                    │                        │                      │<──────────────────────│
  │                    │                        │                      │ (Gemini SSE)          │
  │                    │                        │                      │                       │
  │                    │<──────────────────────────────────────────────│                       │
  │                    │ convert(Gemini→Anthropic)                     │                       │
  │                    │                        │                      │                       │
  │<───────────────────│                        │                      │                       │
  │ (Anthropic SSE)    │                        │                      │                       │
  │                    │                        │                      │                       │
```

---

## 关键函数详解

### 1. `buildAntigravityEnvelope()`

**文件**: `src/services/antigravityClient.js`

**作用**: 构建发送到上游的请求包装

```javascript
function buildAntigravityEnvelope({ requestData, projectId, sessionId, userPromptId }) {
  // 1. 模型名称映射
  const model = mapAntigravityUpstreamModel(requestData?.model)
  
  // 2. 解析或生成 Project ID
  const resolvedProjectId = resolveAntigravityProjectId(projectId, requestData)
  
  // 3. 解析或生成 Session ID
  const resolvedSessionId = resolveAntigravitySessionId(sessionId, requestData)
  
  // 4. 构建 envelope
  const envelope = {
    project: resolvedProjectId,
    requestId: `req-${uuidv4()}`,
    model,
    userAgent: 'antigravity',
    request: { ...requestPayload, sessionId: resolvedSessionId }
  }
  
  // 5. 标准化处理
  normalizeAntigravityEnvelope(envelope)
  
  return { model, envelope }
}
```

### 2. `normalizeAntigravityEnvelope()`

**文件**: `src/services/antigravityClient.js`

**作用**: 标准化请求，确保兼容性

```javascript
function normalizeAntigravityEnvelope(envelope) {
  // 1. 移除 safetySettings（Antigravity 不支持）
  delete requestPayload.safetySettings
  
  // 2. 有 tools 时默认启用 VALIDATED 模式
  if (tools.length > 0 && mode !== 'NONE') {
    requestPayload.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } }
  }
  
  // 3. 规范化 thinking 配置
  normalizeAntigravityThinking(model, requestPayload)
  
  // 4. 非 Claude 模型移除 maxOutputTokens
  if (!model.includes('claude')) {
    delete generationConfig.maxOutputTokens
  }
  
  // 5. Claude 模型清洗 JSON Schema
  // 避免 $schema / additionalProperties 等触发 400 错误
}
```

### 3. `handleAnthropicMessagesToGemini()`

**文件**: `src/services/anthropicGeminiBridgeService.js`

**作用**: Anthropic 消息格式转 Gemini 格式的主入口

```javascript
async function handleAnthropicMessagesToGemini(req, res, { vendor, baseModel }) {
  // 1. 调度账户
  const account = await unifiedGeminiScheduler.selectAccount(...)
  
  // 2. 转换消息格式
  const geminiRequest = convertAnthropicToGemini(req.body)
  
  // 3. 处理工具定义
  const tools = convertToolsToFunctionDeclarations(req.body.tools)
  
  // 4. 压缩工具描述（Antigravity 限制）
  compactToolDescriptionForAntigravity(description)
  
  // 5. 调用上游 API
  if (vendor === 'antigravity') {
    response = await antigravityClient.request({...})
  }
  
  // 6. 转换响应并返回
  pipeAntigravityStreamToAnthropic(response, res)
}
```

### 4. `request()` - 核心请求函数

**文件**: `src/services/antigravityClient.js`

**作用**: 发送请求到上游并处理重试

```javascript
async function request({
  accessToken,
  proxyConfig,
  requestData,
  projectId,
  sessionId,
  userPromptId,
  stream,
  signal,
  params,
  timeoutMs
}) {
  // 1. 构建 envelope
  const { model, envelope } = buildAntigravityEnvelope(...)
  
  // 2. 获取代理配置
  const proxyAgent = ProxyHelper.createProxyAgent(proxyConfig)
  
  // 3. 获取端点候选列表（支持 fallback）
  let endpoints = getAntigravityApiUrlCandidates()
  
  // 4. Claude 模型优先使用 prod 环境
  if (model.includes('claude')) {
    // 调整端点顺序：prod 优先
  }
  
  // 5. 尝试请求（带重试）
  const attemptRequest = async () => {
    for (const baseUrl of endpoints) {
      try {
        const response = await axios(axiosConfig)
        return { model, response }
      } catch (error) {
        if (isRetryable(error) && hasNext) {
          continue  // 尝试下一个端点
        }
        throw error
      }
    }
  }
  
  // 6. 429 限流特殊处理
  try {
    return await attemptRequest()
  } catch (error) {
    if (error.status === 429 && !retriedAfterDelay) {
      await sleep(2000)  // 等待 2 秒
      return await attemptRequest()  // 重试
    }
    throw error
  }
}
```

---

## 调试与日志

### 日志级别

Antigravity 相关日志使用 Winston 记录：

```javascript
// 正常请求
logger.api('📥 /v1/messages request received', { model, forcedVendor, stream })

// 代理使用
logger.info('🌐 Using proxy for Antigravity streamGenerateContent: socks5://...')

// 重试警告
logger.warn('⚠️ Antigravity upstream error, retrying with fallback baseUrl', {
  status, from, to, model
})

// 限流等待
logger.warn('⏳ Antigravity 429 RESOURCE_EXHAUSTED, waiting 2s before retry', { model })
```

### 启用详细调试

在 `.env` 中启用：

```bash
# 启用上游请求 dump
ANTIGRAVITY_DEBUG_UPSTREAM_REQUEST_DUMP=true

# 启用上游响应 dump
ANTIGRAVITY_DEBUG_UPSTREAM_RESPONSE_DUMP=true
```

### 查看 dump 文件

```bash
# 查看请求
tail -f antigravity-upstream-requests-dump.jsonl | jq .

# 查看响应
tail -f antigravity-upstream-responses-dump.jsonl | jq .
```

---

## 常见问题

### 1. 请求返回 400 错误

**可能原因**:
- 工具 Schema 包含 `$schema` 或 `additionalProperties`
- thinking signature 格式错误
- 模型名称不正确

**解决方案**:
- 检查 `geminiSchemaCleaner.js` 是否正确清洗 Schema
- 确保 thinking signature 为有效的 Base64-like token
- 使用正确的模型短名（如 `claude-opus-4-5`）

### 2. 请求返回 429 限流

**可能原因**:
- 上游 API 资源耗尽
- 账户配额已用完

**解决方案**:
- 系统会自动等待 2 秒后重试
- 检查账户余额/配额
- 增加 Antigravity 账户数量

### 3. 连接超时

**可能原因**:
- 代理配置错误
- 网络不稳定
- 上游服务不可用

**解决方案**:
- 检查账户的代理配置
- 尝试切换上游端点（daily ↔ prod）
- 查看日志中的具体错误信息

### 4. 模型不可用

**可能原因**:
- 模型在当前环境（沙箱/生产）不支持
- 账户没有该模型的访问权限

**解决方案**:
- 系统会自动尝试 fallback 到另一个环境
- 使用 `fetchAvailableModels` API 查询可用模型
- 检查账户权限

---

## 参考资料

- [项目 README.md](../README.md)
- [CLAUDE.md 开发指南](../CLAUDE.md)
- [教程.md 本地运行指南](./教程.md)

---

> 📅 文档更新时间: 2026-01-15
> 
> 📝 作者: Claude Relay Service 团队
