# ROUTES - API路由层

## OVERVIEW

Express路由定义，15个路由文件，处理多平台API转发和管理接口。

## STRUCTURE

```
routes/
├── api.js                  # 主Claude API路由（63k行）
├── openaiRoutes.js         # OpenAI兼容路由（44k行）
├── geminiRoutes.js         # Gemini API路由
├── droidRoutes.js          # Droid (Factory.ai) 路由
├── azureOpenaiRoutes.js    # Azure OpenAI路由
├── userRoutes.js           # 用户管理路由
├── webhook.js              # Webhook配置路由
├── admin/                  # 管理后台路由（22个文件）
└── ...
```

## WHERE TO LOOK

| Task           | File              | Notes                             |
| -------------- | ----------------- | --------------------------------- |
| Claude API端点 | `api.js`          | `/api/v1/messages`                |
| OpenAI兼容     | `openaiRoutes.js` | `/openai/v1/chat/completions`     |
| Gemini转发     | `geminiRoutes.js` | `/gemini/v1/models`               |
| 用户认证       | `userRoutes.js`   | `/users/login`, `/users/register` |
| 管理后台       | `admin/*.js`      | 各平台账户CRUD                    |

## CONVENTIONS

### 路由命名

```
/api/v1/*           # Claude官方API
/claude/v1/*        # Claude别名路由
/gemini/v1/*        # Gemini API
/openai/v1/*        # OpenAI兼容
/droid/*            # Droid API
/azure/*            # Azure OpenAI
/admin/*            # 管理后台
/users/*            # 用户管理
```

### 中间件使用顺序

```javascript
router.post(
  '/endpoint',
  authenticateApiKey, // 1. API Key验证
  validateModel, // 2. 模型权限检查
  rateLimitMiddleware, // 3. 速率限制
  handler // 4. 业务处理
)
```

## ANTI-PATTERNS

- ❌ 路由中包含业务逻辑（应放入service）
- ❌ 直接操作Redis（应通过service）
- ❌ 未使用 authenticateApiKey 中间件
