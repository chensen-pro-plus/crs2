# ANTIGRAVITY ENHANCED - Antigravity增强模块

## OVERVIEW

Antigravity渠道的增强功能模块，用于通过Antigravity访问Claude模型。

## STRUCTURE

```
antigravityEnhanced/
├── index.js                # 模块入口
├── accountService.js       # Antigravity账户管理
├── relayService.js         # 请求转发
├── scheduler.js            # 调度逻辑
└── ...
```

## WHERE TO LOOK

| Task     | File                                     | Notes           |
| -------- | ---------------------------------------- | --------------- |
| 账户管理 | `accountService.js`                      | Antigravity凭据 |
| 请求转发 | `relayService.js`                        | API转发逻辑     |
| 路由入口 | `../routes/antigravityEnhancedRoutes.js` | 外部路由        |

## CONVENTIONS

- 遵循父目录 `services/` 的服务命名规范
- 账户凭据需加密存储
- 使用统一的日志格式

## NOTES

- Antigravity账户池通过 `/antigravity/api/` 路由访问
- 权限需包含 'all' 或 'gemini'
