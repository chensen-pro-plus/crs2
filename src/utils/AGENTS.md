# UTILS - 工具函数

## OVERVIEW

36个工具模块，提供OAuth、代理、缓存、日志、成本计算等通用功能。

## STRUCTURE

```
utils/
├── oauthHelper.js          # OAuth PKCE流程（27k行，核心）
├── contents.js             # 内容处理（57k行）
├── logger.js               # Winston日志
├── proxyHelper.js          # HTTP/SOCKS5代理
├── costCalculator.js       # 成本计算
├── cacheMonitor.js         # 缓存监控
├── sessionHelper.js        # 会话管理
├── inputValidator.js       # 输入验证
├── tokenMask.js            # Token脱敏
└── ...
```

## WHERE TO LOOK

| Task      | File                | Notes              |
| --------- | ------------------- | ------------------ |
| OAuth授权 | `oauthHelper.js`    | PKCE、token交换    |
| 代理配置  | `proxyHelper.js`    | 创建代理agent      |
| 日志记录  | `logger.js`         | Winston配置        |
| 成本统计  | `costCalculator.js` | token费用计算      |
| 缓存统计  | `cacheMonitor.js`   | 命中率分析         |
| 数据脱敏  | `tokenMask.js`      | 日志中隐藏敏感信息 |

## CONVENTIONS

### 工具函数导出

```javascript
// 优先导出单个函数
module.exports = { functionA, functionB }

// 或导出对象
module.exports = {
  create: () => {},
  validate: () => {}
}
```

### 错误处理

```javascript
// 工具函数应抛出错误，让调用方处理
function validateInput(input) {
  if (!input) {
    throw new Error('Input required')
  }
}
```

## ANTI-PATTERNS

- ❌ 工具函数中硬编码配置
- ❌ 工具函数中直接操作数据库
- ❌ 不抛出错误而是返回null
