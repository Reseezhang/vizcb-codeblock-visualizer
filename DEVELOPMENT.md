# vizcb-codeblock-visualizer 开发历程

把 WorkBuddy 内置的「可视化」能力复刻到 DeepSeek Harness 桌面版：让模型在回答中输出 ````svg` / ````html` / ````mermaid` 代码块，宿主把代码块渲染成消息底部的内嵌图表卡片。

---

## 一、架构

**双端插件（Host + Client）**

| 端 | 职责 |
|---|---|
| **Host**（Node 进程） | ① 注入「可视化输出规范」提示词 section（固定色板、圆角矩形、≤6 节点、viewBox 规则）+「可预览文件展示规范」（present-files 指令）② `POST /vizcb/read-turn`：读取回合助手消息、提取行首围栏代码块、解析 present-files 并校验路径、返回 `{blocks, reason, files}` ③ `POST /vizcb/mermaid.svg`：mermaid 在**独立 worker_threads** 渲染为 SVG ④ `GET /vizcb/p/<token>/…`：工作区内文件预览（含 meta 轮询）⑤ `POST /vizcb/reveal`：系统文件管理器定位 ⑥ `GET /vizcb/debug`：自检状态 |
| **Client**（浏览器） | 挂载 `conversation.chat.turnTail` 链位渲染卡片；SVG 消毒内联 / HTML 空 sandbox iframe / mermaid fetch+inline；全屏灯箱放大；复制 / 保存导出；失败原因通知条；present-files → 预览面板（iframe/大图/源码）+ 文件卡片（切换/复制路径/打开目录/mtime 轮询刷新） |

**安全边界**：SVG/mermaid 输出**宿主端 DOMPurify 消毒**（剥 script/on*/javascript:）后才返回客户端；客户端渲染前再消毒一次（纵深防御）；HTML 走 `sandbox=""` iframe（禁脚本）；mermaid 宿主渲染零外联零脚本；**预览文件**只允许工作区内的真实文件（resolve + `path.relative` 包含性校验防 `../` 越界），经不可猜 token 前缀暴露，预览 iframe 仅 `sandbox="allow-scripts"`（无 allow-same-origin，模型 HTML 是唯一隔离层）。

---

## 二、版本迭代

| 版本 | 阶段 | 内容 |
|---|---|---|
| 动态插件 pkg1–5 | 探索期 | 字段 bug → 数据源 bug → 误报修复 → 加固 → TDZ 修复（详见 Bug 篇） |
| **1.0.0** | bundle 移植 | 改为 profile bundle 常驻；`host.call` 改 webserver 路由 + 客户端 fetch |
| **1.1.0** | v2 加固 | SVG 校验 / 图注标题 / 复制+缩放 / mermaid（iframe+CDN）/ 配置化 / per-seq 缓存 / 自检 / 限流 / 网格 / i18n |
| **1.2.0** | 交互 | 全屏灯箱（react-dom portal，Esc/背景/按钮关闭） |
| **1.2.1** | mermaid 修复 | 24 个方言别名（flowchart/graph/…）；普通代码块不再误报 |
| **1.3.0** | mermaid 重构 | **宿主端渲染**（mermaid+svgdom→SVG→内联），彻底弃 CDN/iframe |
| **1.3.1** | 诊断 | 卡片版本徽标；mermaid 改 fetch+inline（复用已验证通道） |
| **1.3.2** | 诊断 | 请求级调试日志（read-turn/mermaid 写文件） |
| **1.3.3** | 视觉 | 箭头可见性增强（亮蓝 2.4px 边 + 1.5× 箭头 + 边标签提亮） |
| **1.3.4** | 一致性 | SVG 校验改用宽松 HTML 解析，与渲染路径对齐（消除"缩略图报错、灯箱正常"） |
| **1.4.0** | 导出 | 保存为图片：原生对话框自选位置与格式（PNG/SVG），HTML 导出源文件 |
| **1.4.1** | 视觉 | 修复深色主题渲染（dark 标志丢失导致浅色主题）；mermaid 配色对齐宿主色板；节点文字自适应（扩宽矩形 + viewBox） |
| **1.5.0** | 评审落地 | mermaid 移入独立 worker_threads（不污染宿主 globalThis）；SVG/mermaid 宿主端 DOMPurify 消毒；mermaid 全局限流 + 同 key 在途去重 + 串行化；readTurn 重试缓存修复；debugLog 配置化；`injectBootGlobals` 转义 `</script>`；主题适配（canvasBg + mermaidDark 自动检测）；灯箱同套 SVG 校验；`node --test` 用例 + GitHub Actions CI；installer 按 files 白名单复制 |
| **1.6.0** | 文件预览 | WorkBuddy html-preview-spec 落地：`present-files` 指令 → 宿主校验（resolve + 包含性）→ 同源 `/vizcb/p/<token>/` 预览（token/越界/大小上限/no-store）→ 客户端预览面板 + 文件卡片（切换/复制路径/`explorer /select` 打开目录/mtime 轮询刷新/关闭后不自动弹开）；提示词新增"可预览文件展示规范" |
| **1.6.1** | 只留渲染 | `hideSourceBlocks`（默认开）隐藏本插件渲染过的源码围栏（svg/html/mermaid 方言别名 + present-files）：仅当宿主解析出对应块时按解析语言精确隐藏（JS 按 class/data-lang 匹配 + MutationObserver 覆盖流式渲染）；源码仍可经卡片"复制"获取 |
| **1.6.2** | 评审修订 | ①移除 CSS 全局隐藏兜底：`pre:has(...)` 会吞掉渲染失败的图（卡片没出源码已被藏）且作用于整个页面的历史消息 → 隐藏完全交给 JS 精确处理，容器查找加三重守卫（深度 ≤12 / 不越过 body / 命中数 ≤24，异常即放弃隐藏保留源码）②`sanitizeSvgText` 消毒失败/非字符串结果 → 失败即拒绝（返回空，不放行未消毒原文）③mermaid GET 兼容通道补 `maxBlockChars`（与 POST 一致）④worker 的 DOMPurify 绑定补注释（mermaid strict 模式的防御性绑定，非笔误） |
| **1.6.3** | 提示词 | mermaid 特殊字符规则：标签含 `|`/引号/`<`/`>` 时用双引号包裹整个标签（`F["A | B"]`），`|` 是连接线标签定界符裸写解析失败；`<br>` 换行 |
| **1.6.5** | 提示词 | subgraph 标题含空格/括号/中文等时用双引号包裹（`subgraph "本地 PC 日志（规格）"`），标题内禁止 `[ ] { }`，节点必须另起一行（修 subgraph 标题带节点 → Lexical error） |
| **1.6.6** | 提示词 | timeline 图 period 内禁止冒号（`:` 是时间与事件分隔符，`10:33` 解析失败）→ 用 `10点33分`/日期格式，描述写在冒号后（渲染器验证：`10:33`、`10:33 启动` FAIL，`10点33分 启动` OK） |
| **1.6.7** | 提取修复 | DSH 结构化存储消息代码块（`{type:code, language, text}` 无围栏）→ `extractEventText` 识别图表语言代码块并还原 ` ```<lang> ` 围栏（数组分支 + collectText 兜底），修"助手消息的图不渲染、read-turn 返回 blocks=0 reason=none"；debug 日志实锤：带图的助手消息 read-turn blocks=0 |
| **1.6.8** | 提示词 | 输出位置规则：代码块紧跟引入句之后、禁止堆积回答末尾；每图前一句说明、图文交替分布（WorkBuddy 建议，解决"图来得晚/图文脱节"） |
| **1.6.9** | 展示详情 | WorkBuddy vizcb-detail-spec 落地（升级灯箱而非新弹层）：渲染/源码 tab（记住上次）、滚轮缩放+拖拽平移、源码原始文本 textContent 直出+横向滚动+超长截断、下载按类型命名（.svg/.html/.mmd）、新窗口打开（svg/html）、遮罩拖动不误关+焦点管理；卡片按钮「放大」→「详情」 |

---

## 三、关键 Bug 与教训（都是踩过的坑）

### 1. `content` vs `text` —— 提示词组装崩溃
`systemPrompt.section()` 的真实字段是 **`text`**（注册时只校验 `order`，组装时才读 `text`）。写错成 `content` 时注册成功、回合开始时 `undefined.indexOf("{{")` → 整轮 run 失败。
**教训**：注册 API 的"静默容忍"字段，要在真实源码里核对，不能靠惯例。

### 2. 动态插件进程失活
动态插件是进程内的 —— 应用重启即失活、需重新授权。桌面版一天重启多次，插件反复消失。
**方案**：改造为 profile **bundle 插件**（`dsh.profile.bundles` + 包内 `cordis.patch.yml`），跨重启常驻。

### 3. `listEvents` 轻量记录 —— 卡片不出现
`sessionQuery.listEvents()` 返回的记录**只有 `{sessionId, seq, type, time, surface}`，没有 content**。最初用它做数据源，提取永远是空。
**修复**：改用 `readEvent()` 拿完整事件快照（`target.data.message.content`）。

### 4. PS 5.1 的 BOM 事故 —— 应用启动崩溃
环境的 `pwsh` 实际是 **PowerShell 5.1**，`-Encoding utf8` 会写入 **UTF-8 BOM**。我写的所有文件带 BOM；应用用严格 `JSON.parse` 读 profile 的 `package.json` → `Unexpected token ''` → **启动崩溃循环**。而 `node require` 会自动剥 BOM，导致我的校验"通过"了。
**连带损失**：应用恢复机制重写清单时，把之前就有热挂载问题的 mermaid 插件**整个清除**（目录+依赖）。
**教训**：写 JSON 给严格解析器必须显式无 BOM（`UTF8Encoding($false)`）；写 .ps1 给 PS 5.1 反而**必须带 BOM**。
**补充教训（1.6.3 踩坑）**：**读** UTF-8 文件也一样——PS 5.1 的 `Get-Content` 默认按 ANSI/GBK 解码，`Get-Content -Raw` 读含中文的 UTF-8 文件会把每个中文字符读成乱码，`-replace` 后 `WriteAllText` 写回即**整文件损坏**（lib/client.js 全部中文注释变乱码，靠 `git checkout` 恢复）。读写含非 ASCII 的文本一律用 `[System.IO.File]::ReadAllText / WriteAllText`（.NET 默认 UTF-8）；含引号/管道的命令参数改用 `git commit -F 文件`，避免 shell 引号转义。

### 5. `const` TDZ —— 运行时 ReferenceError
`const MAX_BLOCKS` 声明在宿主工厂函数 `return` 之后 —— 函数执行到 return 就返回，const 永不初始化；`function` 声明会提升所以其他辅助函数没事。修复：常量移到 return 之前。

### 6. mermaid 渲染三连坑
- **初始化时序**：`initialize({startOnLoad:true})` 在 `window.load` 里调用，DOMContentLoaded 已过 → 自动渲染永不执行 → iframe 空白
- **strict 剥 `<br/>`**：`securityLevel:'strict'` 会剥掉标签里的 `<br/>` → 中文流程图标签全挤一行
- **方言别名**：模型常写 ````flowchart`/````graph` 而不是 ````mermaid` → 不识别
- **iframe+CDN 在应用内不可靠**（浏览器侧 CDN 被拦/脚本不执行，具体层无法外部判定）→ 最终改 **宿主端渲染**（mermaid+svgdom+dompurify+jsdom，与内置 mermaid 插件同架构），客户端内联渲染，彻底摆脱外联。

### 7. 渲染器页面跨宿主重启存活
宿主进程重启≠页面重载 —— 渲染器页面"重连"而非"刷新"，**旧 client bundle 一直驻留内存**，改代码永远不生效。症状：SVG 卡片有新版徽标、mermaid 却是旧行为。
**教训**：加**版本徽标**到卡片头部，一眼确认页面跑的是哪个客户端。

### 8. SVG 校验严格/宽松不一致
缩略图用严格 XML 解析（`image/svg+xml`），灯箱用宽松 HTML 解析 → 模型 SVG 有轻微瑕疵时"缩略图报错、灯箱正常"。
**修复**：校验改用 `text/html` + `<svg>` 根元素检查，与渲染路径（`dangerouslySetInnerHTML` 的 HTML 解析器）完全一致。

### 9. 权限策略与沙箱
文件沙箱 `workspace-write` 拦截对 `~/.dsh` 的写入 → 按规则用 `sandbox_permissions` 升级并附一句 justification（用户审批）。审批策略曾被改为 `never`，之后又恢复 `ask` —— 全程按当前策略行事，不越权。

---

## 四、调试方法论（复现可用）

1. **会话日志解码**：`~/.dsh/sessions/<workspace>/session-<id>/session.jsonl.zstd` 是 **每行一个 zstd 帧**，遍历帧魔数 `28 B5 2F FD` 逐帧解压、按行切分，得到完整事件流（turn/step/assistant-message/tool-call…）。
2. **asar 索引解析**：`app.asar` 文件头 = 4 字节 pickle + 3 个 uint32 尺寸字段，JSON 索引从偏移 16 开始，offset 是字符串；据此定位任意客户端 bundle 源码。
3. **隔离功能测试**：`lib/index.js` 导出纯函数（`analyzeBlocks`/`renderMermaidCached`/`sanitizeSvgText`…），`npm install && node --test test/` 直接 import 跑通（CI 同款），不依赖应用。
4. **请求级日志**：配置 `debugLog: true` 时宿主路由写 `os.tmpdir()/vizcb-debug.log`（客户端随请求上报版本号），一次重启+一次操作=铁证。

---

## 五、教训总结

- **API 契约以真实源码为准**：字段名、返回形状（轻量 vs 快照）、生命周期行为，都要查实现，不能猜。
- **环境差异**：PowerShell 5.1 vs 7 的编码行为；浏览器/Node/应用解析器的宽容度差异。
- **进程架构决定调试路径**：宿主、渲染器、页面的生命周期各自独立，改代码后要知道"谁重载了、谁还驻留"。
- **诊断优先于猜测**：版本徽标、请求日志、隔离测试，让数据说话。
