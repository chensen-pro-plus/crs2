# ADMIN-SPA - Vue3管理界面

## OVERVIEW

Vue3 + Vite + Pinia + TailwindCSS 构建的SPA管理界面，提供账户管理、API Key管理、监控仪表板。

## STRUCTURE

```
admin-spa/src/
├── views/              # 页面组件（13个）
├── components/         # 可复用组件
│   ├── accounts/       # 账户管理组件
│   ├── apikeys/        # API Key组件（14个）
│   ├── common/         # 通用组件
│   └── ...
├── stores/             # Pinia状态管理（9个store）
├── composables/        # 组合式函数
├── config/             # 前端配置
└── utils/              # 前端工具函数
```

## WHERE TO LOOK

| Task     | Location          | Notes                  |
| -------- | ----------------- | ---------------------- |
| 新增页面 | `views/`          | 配合 `router/index.js` |
| 新增组件 | `components/`     | 按功能域分目录         |
| 状态管理 | `stores/`         | Pinia store            |
| 主题切换 | `stores/theme.js` | 暗黑模式               |
| API调用  | `config/api.js`   | axios封装              |

## CONVENTIONS

### 响应式设计（强制）

```html
<!-- 必须兼容移动端 -->
<div class="sm:flex md:grid lg:flex-row"></div>
```

### 暗黑模式（强制）

```html
<!-- 所有颜色必须有dark:变体 -->
<div class="bg-white text-gray-700 dark:bg-gray-800 dark:text-gray-200"></div>
```

### 组件命名

```
PascalCase.vue              # 组件文件名
components/{domain}/        # 按功能域分目录
```

## ANTI-PATTERNS

- ❌ 只适配桌面端
- ❌ 缺少暗黑模式样式
- ❌ 组件中直接调用API（应通过store）
- ❌ 硬编码颜色值

## NOTES

### 构建命令

```bash
npm run install:web   # 安装依赖
npm run build:web     # 构建生产版本
```

### 玻璃态风格

项目使用玻璃态(Glassmorphism)设计，注意保持透明度和模糊效果一致。
