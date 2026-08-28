# vizcb-codeblock-visualizer

DeepSeek Harness 可视化插件：把模型回答中的 ````svg` / ````html` / ````mermaid` 代码块渲染为消息底部的内嵌图表卡片。运行时依赖（mermaid/svgdom 等）已内置，**插件本体零网络外联**（mermaid 为宿主端渲染）。

## 功能

- **SVG 卡片**：消毒注入 + 宽松校验（与渲染路径一致），轻微 XML 瑕疵也能正常渲染
- **HTML 卡片**：空 sandbox iframe（默认禁脚本；`htmlAllowScripts` 可开 iframe 内脚本）
- **Mermaid 卡片**：宿主端渲染（mermaid + svgdom → SVG），24 种方言别名（flowchart/graph/sequenceDiagram…），箭头可见性已增强
- **图注标题**：自动提取代码块上方的标题行
- **交互**：复制源码 / 全屏灯箱放大（Esc、点背景、按钮关闭）/ **保存导出**（原生对话框自选位置与格式：PNG / SVG；HTML 导出源文件）
- **失败可见化**：未渲染时显示原因通知条
- **工程化**：配置化（8 块/条、64KB/块、重试间隔等）、per-seq 缓存、2s 自动重试、请求体限制 + 每会话限流、`/vizcb/debug` 自检、启动日志 `[vizcb] mounted vX`

## 安装

**前提**：目标 profile 为标准 DSH web 应用栈（含 `dsh-web-app` 的 turnTail 槽位，以及 `systemPrompt` / `webServer` / `sessionQuery` 服务）。桌面版 2.0.3 已验证。

### 方式 A —— 一键安装脚本（推荐）

```sh
# 1. 获取源码（git clone 本仓库 / 下载 zip）
# 2. 在仓库根目录运行（会自动复制插件 + 写入 bundles + 缺依赖时 npm install）：
powershell -ExecutionPolicy Bypass -File install-vizcb.ps1
# 其他 profile：
powershell -ExecutionPolicy Bypass -File install-vizcb.ps1 -ProfileName web
# 3. 重启 DeepSeek Harness
```

### 方式 B —— 手动复制

1. 把 `vizcb-codeblock-visualizer` 目录复制到目标 profile 的 `node_modules/`
2. 在 profile 的 `package.json` 的 `dsh.profile.bundles` 追加 `"vizcb-codeblock-visualizer"`
3. （若未带 node_modules）在插件目录执行 `npm install`
4. 重启

### 方式 C —— GitHub tarball 依赖（等 dsh CLI 修复后）

```jsonc
// profile package.json dependencies:
"vizcb-codeblock-visualizer": "https://codeload.github.com/Reseezhang/vizcb-codeblock-visualizer/tar.gz/<commit>"
```

## 配置

默认值见 `lib/index.js` 的 `DEFAULTS`。在 profile 级 `cordis.patch.yml` 按 id 覆盖：

```yaml
- id: vizcb-codeblock-visualizer
  config:
    maxBlocks: 8              # 每条消息最多渲染块数
    maxBlockChars: 65536      # 单块最大字符数
    retryDelayMs: 2000        # 空结果重试间隔
    minSvgHeight: 120         # SVG 无 viewBox 时的兜底高度
    mermaidEnabled: true      # 是否渲染 mermaid
    htmlAllowScripts: false   # HTML iframe 是否允许脚本（安全权衡，默认关）
```

## 卸载 / 回滚

删掉 bundles 条目 + 删除插件目录 + 重启。

## 文件结构

```
vizcb-codeblock-visualizer/
├── package.json        # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml    # 挂载行 + 配置说明
├── README.md
├── DEVELOPMENT.md      # 完整开发历程与踩坑记录
├── LICENSE             # MIT
├── install-vizcb.ps1   # 一键安装脚本
└── lib/
    ├── index.js        # Host：提示词 section + read-turn / mermaid.svg / debug 路由
    └── client.js       # Client：turnTail 渲染 + 灯箱 + 保存导出（__ModuleLoader__ 格式）
```

## 版本历史

- 1.0.0 动态插件移植为 bundle（路由 fetch）
- 1.1.0 加固：SVG 校验 / 图注标题 / 复制缩放 / mermaid / 配置化 / 缓存 / 自检 / 限流 / 网格 / i18n
- 1.2.0 全屏灯箱放大
- 1.2.1 mermaid 方言别名 + 普通代码块静默
- 1.3.0 mermaid 改宿主端渲染（弃 CDN/iframe）
- 1.3.1 卡片版本徽标 + fetch+inline
- 1.3.2 请求级调试日志
- 1.3.3 箭头可见性增强
- 1.3.4 SVG 校验对齐渲染路径
- 1.4.0 保存导出（PNG/SVG/HTML）

完整踩坑历程见 [DEVELOPMENT.md](./DEVELOPMENT.md)。
