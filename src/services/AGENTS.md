# SERVICES - 业务服务层

## OVERVIEW

核心业务逻辑层，48个服务文件，包含账户管理、API转发、调度、定价等功能。

## STRUCTURE

```
services/
├── *AccountService.js      # 账户管理（8种平台类型）
├── *RelayService.js        # API转发服务
├── *Scheduler.js           # 多账户调度器
├── apiKeyService.js        # API Key核心（67k行）
├── pricingService.js       # 定价服务
├── antigravityEnhanced/    # Antigravity增强模块
└── balanceProviders/       # 余额查询提供者
```

## WHERE TO LOOK

| Task         | File                                                             | Notes              |
| ------------ | ---------------------------------------------------------------- | ------------------ |
| 新增AI平台   | 创建 `{platform}AccountService.js` + `{platform}RelayService.js` | 成对创建           |
| 修改调度策略 | `unified*Scheduler.js`                                           | 账户选择、粘性会话 |
| API Key功能  | `apiKeyService.js`                                               | 验证、限流、统计   |
| 成本计算     | `pricingService.js`                                              | 模型价格、费用统计 |
| Webhook通知  | `webhookService.js` + `webhookConfigService.js`                  | 事件发布           |
| 用户管理     | `userService.js`                                                 | 注册、登录、权限   |

## CONVENTIONS

### 服务命名模式

```
{platform}AccountService.js   # 账户CRUD、token刷新
{platform}RelayService.js     # 请求转发、SSE处理
unified{Type}Scheduler.js     # 跨账户调度
```

### 账户服务必需方法

```javascript
// 账户CRUD
createAccount(data)
getAccount(id)
updateAccount(id, data)
deleteAccount(id)
listAccounts(filter)

// Token管理
refreshToken(account)
validateToken(account)
encrypt(data) // 敏感数据加密
decrypt(data) // 敏感数据解密
```

### 转发服务必需方法

```javascript
// 转发逻辑
relayRequest(req, res, account)
handleStreamResponse(response, res)
captureUsage(response) // 提取usage数据
```

## ANTI-PATTERNS

- ❌ 不加密存储token/credentials
- ❌ 同步阻塞的token刷新
- ❌ 未处理SSE流中断
- ❌ 硬编码API端点

## NOTES

### 大文件警告

- `claudeAccountService.js` (119k) - 考虑拆分token刷新逻辑
- `claudeRelayService.js` (114k) - 考虑拆分SSE处理
- `apiKeyService.js` (67k) - 考虑拆分验证/统计/限流

### 服务依赖

- 所有服务依赖 `src/models/redis.js` 的 Redis 客户端
- 使用 `src/utils/logger.js` 记录日志
- 敏感数据使用 AES 加密（ENCRYPTION_KEY）
