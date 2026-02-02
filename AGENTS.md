# PROJECT KNOWLEDGE BASE

**Generated:** 2026-02-02
**Commit:** c1217880
**Branch:** main

## OVERVIEW

多平台 AI API 中转服务（Claude/Gemini/OpenAI/Bedrock/Azure等），Node.js + Express + Redis 架构，Vue3 SPA 管理界面。提供多账户调度、OAuth token管理、API Key认证、成本统计、粘性会话等功能。

## STRUCTURE

```
./
├── src/                    # 后端核心代码
│   ├── app.js              # Express 应用入口（33k行，核心启动逻辑）
│   ├── services/           # 业务服务层（48个服务，核心逻辑）
│   ├── routes/             # API 路由定义（15个路由文件）
│   ├── utils/              # 工具函数（36个文件）
│   ├── middleware/         # Express 中间件
│   ├── models/             # Redis 数据模型
│   └── validators/         # 输入验证器
├── web/admin-spa/          # Vue3 管理界面 SPA
├── cli/                    # 命令行工具
├── scripts/                # 运维脚本（28个）
├── config/                 # 配置文件
├── tests/                  # 测试文件
├── logs/                   # 日志目录
└── data/                   # 运行时数据（init.json 存管理员凭据）
```

## WHERE TO LOOK

| Task               | Location                                                            | Notes                     |
| ------------------ | ------------------------------------------------------------------- | ------------------------- |
| 添加新的AI平台支持 | `src/services/*AccountService.js` + `src/services/*RelayService.js` | 账户管理+转发服务成对出现 |
| 添加新API路由      | `src/routes/`                                                       | 按平台分文件              |
| 统一调度逻辑       | `src/services/unified*Scheduler.js`                                 | 跨账户类型调度            |
| API Key验证/限流   | `src/services/apiKeyService.js`                                     | 67k行，核心认证逻辑       |
| OAuth token管理    | `src/utils/oauthHelper.js`                                          | PKCE流程+代理支持         |
| 成本计算           | `src/services/pricingService.js` + `src/utils/costCalculator.js`    | 模型定价+成本统计         |
| 前端页面           | `web/admin-spa/src/views/`                                          | Vue3 SFC                  |
| 前端状态           | `web/admin-spa/src/stores/`                                         | Pinia stores              |
| 配置项             | `config/config.js` + `.env`                                         | 运行时配置                |
| Redis数据结构      | 见 CLAUDE.md "Redis 数据结构" 章节                                  | 完整Key前缀说明           |

## CODE MAP

### 核心服务（按功能域）

| 服务                              | 行数 | 角色                            |
| --------------------------------- | ---- | ------------------------------- |
| `claudeAccountService.js`         | 119k | Claude OAuth账户管理、token刷新 |
| `claudeRelayService.js`           | 114k | Claude API转发、SSE流式处理     |
| `apiKeyService.js`                | 67k  | API Key CRUD、验证、限流、统计  |
| `unifiedClaudeScheduler.js`       | 69k  | 多账户智能调度、粘性会话        |
| `anthropicGeminiBridgeService.js` | 100k | Anthropic格式转Gemini桥接       |
| `geminiAccountService.js`         | 68k  | Gemini OAuth + API Key 管理     |

### 账户类型映射

| 类型             | AccountService                | RelayService                | Scheduler              |
| ---------------- | ----------------------------- | --------------------------- | ---------------------- |
| claude-official  | claudeAccountService          | claudeRelayService          | unifiedClaudeScheduler |
| claude-console   | claudeConsoleAccountService   | claudeConsoleRelayService   | unifiedClaudeScheduler |
| bedrock          | bedrockAccountService         | bedrockRelayService         | unifiedClaudeScheduler |
| ccr              | ccrAccountService             | ccrRelayService             | unifiedClaudeScheduler |
| gemini           | geminiAccountService          | geminiRelayService          | unifiedGeminiScheduler |
| openai-responses | openaiResponsesAccountService | openaiResponsesRelayService | unifiedOpenAIScheduler |
| azure-openai     | azureOpenaiAccountService     | azureOpenaiRelayService     | unifiedOpenAIScheduler |
| droid            | droidAccountService           | droidRelayService           | droidScheduler         |

## CONVENTIONS

### 代码风格（强制）

- **Prettier**: 无分号、单引号、trailing comma none、100字符行宽
- **ESLint**: `no-var`、`prefer-const`、`eqeqeq always`
- 未使用变量以 `_` 前缀命名
- 禁止 `as any`、`@ts-ignore`

### 命名约定

- 服务文件: `*Service.js`（如 `claudeAccountService.js`）
- 路由文件: `*Routes.js`（如 `geminiRoutes.js`）
- 调度器: `*Scheduler.js`
- 账户服务: `{platform}AccountService.js`
- 转发服务: `{platform}RelayService.js`

### 敏感数据处理

- 所有OAuth token、refreshToken、credentials 必须 AES 加密存储
- 参考 `claudeAccountService.js` 中的 `encrypt()`/`decrypt()` 实现
- API Key 使用 SHA-256 哈希存储

### 日志规范

- 使用 Winston logger (`src/utils/logger.js`)
- 日志文件按类型分离: `claude-relay-*.log`、`token-refresh-error.log`、`webhook-*.log`

## ANTI-PATTERNS (THIS PROJECT)

- ❌ **禁止类型抑制**: 不使用 `as any`、`@ts-ignore`、`@ts-expect-error`
- ❌ **禁止空catch**: `catch(e) {}` 不允许
- ❌ **禁止硬编码密钥**: 敏感信息必须从 `.env` 读取
- ❌ **禁止未加密存储敏感数据**: OAuth token必须加密
- ❌ **禁止直接操作git**: 除非用户明确许可

## UNIQUE STYLES

### 请求流程（理解核心）

```
客户端 → authenticateApiKey中间件(验证/限流/权限)
       → 统一调度器(选择最优账户)
       → Token刷新(如需)
       → RelayService转发(代理配置)
       → SSE流式响应
       → Usage捕获 → 成本计算
```

### 粘性会话机制

- 基于请求内容hash绑定账户
- Redis key: `sticky_session:{sessionHash}`
- 同一会话保持上下文连续

### 并发请求排队

- 当API Key并发超限时进入队列而非返回429
- 指数退避: 初始200ms，最大2s，±20%抖动
- Redis key: `concurrency:queue:{apiKeyId}`

## COMMANDS

```bash
# 开发
npm run dev                    # 热重载开发模式
npm run lint                   # ESLint检查
npm run format                 # Prettier格式化

# 服务管理
npm run service:start:daemon   # 后台启动
npm run service:status         # 查看状态
npm run service:logs           # 查看日志
npm run service:restart:daemon # 重启

# 构建
npm run install:web            # 安装前端依赖
npm run build:web              # 构建前端

# CLI工具
npm run cli status             # 系统状态
npm run cli keys list          # API Key列表
npm run cli accounts list      # 账户列表

# 数据管理
npm run data:export            # 导出Redis数据
npm run init:costs             # 初始化成本数据
npm run update:pricing         # 更新模型价格
```

## NOTES

### 环境变量（必须）

- `JWT_SECRET`: 32字符+
- `ENCRYPTION_KEY`: 固定32字符
- `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`

### 已知限制

- 测试覆盖率低，缺少单元测试
- 部分大文件(100k+行)需要拆分重构

### 重要文件

- `data/init.json`: 管理员凭据（自动生成）
- `config/config.js`: 完整配置（从 config.example.js 复制）
- `.env`: 环境变量（从 .env.example 复制）

### 详细文档

- 完整架构说明见 `CLAUDE.md`
- 用户部署指南见 `README.md`
