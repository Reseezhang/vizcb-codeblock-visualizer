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
| **1.7.0** | 呈现层 | 「绘制过程」不再外露：占位骨架 + 180ms 淡入，源码围栏在**检测到成对闭合围栏**时立即隐藏（与骨架同一轮提交），宿主始终读不到块则还原源码（`retryGiveUpMs` 默认 6s），重试改递增退避阶梯（400/800/2000ms），骨架占位高度按语言预留。同时修复 v1.6.1 起**一直失效**的源码隐藏（教训 10） |

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

### 10. 选择器写在"我以为的 DOM"上 —— 源码隐藏静默失效（v1.6.1~1.6.10）
`hideSourceBlocks` 一直按 `code.language-mermaid` / `pre[data-lang]` 找围栏。但宿主渲染器的 `CodeBlock`（`@deepseek-ai/dsh-client-ui-primitives/lib/index.js`）只在**空围栏**这一种情况下输出 `language-*` 类；有内容的围栏渲染成
`div.md-code-block > div._block > (div[data-code-block-banner] > div.infostring + div[data-code-block-content] > pre > code)`，
语言名只以**文本**形式出现在横幅 `infostring` 里。于是 `matchFences` 永远返回空数组，"隐藏源码"这条功能从上线起就没生效过——而且**不报错、不告警**，只看截图完全看不出来（截图里的源码围栏很容易被当成"另一个代码块"）。
**修复**：按真实 DOM 定位（横幅 infostring / 源码首行 ` ```lang ` 标记），按序号与宿主解析结果对账，对不上就放弃隐藏（宁可少藏，不可误藏用户的普通代码块）。
**教训**：① 跨包依赖 DOM 结构时，去那个包的源码里确认它到底渲染成什么，不要按惯例猜；② "功能没生效"和"功能有效果但被别的东西盖住"在观感上无法区分，必须靠断言落地（本次补了客户端测试）；③ 与宿主结果对账时，宁可漏藏也不能误藏——误藏用户代码是更严重的事故。

### 11. 自造 React 替身的天花板
为了给"流式 DOM 时序"加回归测试，写了一个只实现 useState/useRef/useEffect 的极简 React 替身 + jsdom。它足以覆盖**围栏发现/隐藏/不误藏**（这轮改动最危险的部分，确实抓到并修掉了两个真 bug：多语言时只隐藏第一种、`data-code-block-content` 的父节点不是整块），但在"state 更新触发重渲染"这条链上不忠实——同序复用 hook 对象 + 自造调度，导致"骨架出现""失败还原"这类断言时好时坏。
**处置**：只保留替身能可靠观察的断言（5 条），其余改由 host 单测（重试契约）+ 真机实测覆盖，并在测试文件里写明哪三项没在替身里断言、为什么。
**教训**：测试替身省事，但要清楚它的边界；在替身里反复"修到绿"会掩盖真实行为。发现自己在为一个自造渲染器写第三个补丁时，就该停下来改用真机验证。

### 12. jsdom 让插件整体 `failed to import`（v1.7.1，DSH 0.2.0-rc.2）
插件装好后宿主只给一句 `vizcb-codeblock-visualizer (vizcb-codeblock-visualizer): failed to import`，没有堆栈。把宿主逼到 fatal（占住端口让 webserver 起不来）后，`~/.dsh/logs/startup-*.log` 里才露出真身：`TypeError: createRequire.resolve.paths is not a function or its return value is not iterable`，位于 `dsh-app-boot/lib/index.js` 的 `ResolutionRouter.routeScoped`，调用链是 desktop host 的 resolve 钩子 → CJS loader → 被 patch 的 `Module._resolveFilename`。

定位过程（每一步都可复制）：
1. 手工拷贝安装、pnpm 正规安装、绕开 desktop host 直接用 `dsh` bin 启动 —— 三种都失败，所以与装法、与 desktop 专有钩子无关（普通 `dsh web` 同样中招）。
2. 在隔离的 probe profile（`$DSH_HOME/profiles/probe`：拷 profile 配置 + 对 node_modules 逐项建 junction，再把插件目录换成可编辑副本）里二分：去掉 `import { JSDOM } from "jsdom"` 后立刻 `[vizcb] mounted`；只留 dompurify 静态导入也能挂载；只留 jsdom 就失败；把 jsdom 改成 `await import("jsdom")` **仍然失败**。
3. 结论：**宿主主线程一旦解析 jsdom 这个 CJS 依赖就崩**（dompurify 走 ESM 所以没事；`ue-log-reader` 只 import node 内置模块所以一直没事）。worker 线程没有这层解析钩子 —— `lib/mermaid-worker.mjs` 里 import jsdom 一直是好的。

**处置**：`lib/index.js` 与 jsdom/DOMPurify 彻底隔离。`lib/svg-dom.mjs`（jsdom + DOMPurify + 节点自适应 + 配色增强）只被 worker import；新增 `lib/dom-worker.mjs` 专做 ````svg` 块消毒（与 mermaid 渲染分线程，免得 read-turn 排在渲染后面）；mermaid 渲染完在 worker 里就地收尾（增强 → 自适应 → 消毒）；`sanitizeSvgText` 变 async（失败仍 fail-closed 返回空串）；纯度量抽到 `lib/label-metrics.mjs` 供两侧共用。`apply()` 里预热消毒线程，避免把整条线程的冷启动（jsdom 冷加载 + 杀软扫描可能十几秒）算在第一个请求头上。
**防线**：单测直接读 `lib/index.js` 源码，断言其中不出现 jsdom/dompurify（静态或动态 import）——这条坑不写断言，下次重构就会把它挪回来。
**教训**：宿主插件里，**"能不能 import"和"装了没装"是两回事**；宿主对加载失败只报一句没有堆栈的话时，先用 fatal 启动把 `startup-*.log` 逼出来，再用二分法在隔离 profile 里定位到具体那一行 import。第三方 CJS 依赖出现在插件主线程入口，是 DSH 这版解析路由器的雷区。

### 13. 客户端插槽 API 漂移：list slot 必须带 `options.id`（v1.7.2）
服务端修好之后，页面上卡片依然只是代码块。最迷惑人的地方是**宿主侧全绿**：`/vizcb/debug` 200、mermaid 渲染 200、提示词 section 也注入了 —— 但 `os.tmpdir()/vizcb-debug.log` 里一条 `read-turn` 都没有（客户端只要挂载就一定会轮询）。客户端报错（浏览器 console）是决定性的：

```
Uncaught Error: list slot "conversation.chat.turnTail" requires options.id
    at fh.register (index-*.js)
    at bc.<anonymous> (client.js:1177)
```

`ctx.slots.register(options, Component)` 的**插槽种类**决定必填字段：`single` 无、`keyed` 要 `options.key`、`list` 要 `options.id`、`chain` 要 `options.select`；`order`/`label`/`priority`/`select`/`inject`/`children` 都是可选透传字段。这些常量可以直接从宿主 bundle 里读出来（见调试方法论第 7 条）：`"<slot 名>" requires options.` 就是校验点。本插件注册的 `conversation.chat.turnTail` 是 list 类，补上 `id: "vizcb-codeblock-visualizer"` 即可（旧宿主多传无害）。
**教训**：① 客户端插件"注册成功"没有任何回执，`inject` 的插槽名不存在或注册抛错都是静默的，唯一可靠的信号是**宿主侧有没有收到客户端的请求**（本插件的 read-turn 就是活体探针）；② 报错一定要拿 console，不要让用户只描述症状 —— 同一句"还是代码块"在服务端没挂载、客户端没挂载、DOM 认不出三种情况下长得一模一样。
**副产品**：本地 `file:` 依赖是**快照式**的，改了源码只重跑 `dsh plugin --profile desktop add file:<dir>` 不会刷新（pnpm 认为 spec 没变就复用），必须 `remove` 再 `add`（或改版本号）；客户端 bundle 由宿主按内容/修订号提供，页面 **Ctrl+Shift+R** 才会换到新的一份。

---

## 四、调试方法论（复现可用）

1. **会话日志解码**：`~/.dsh/sessions/<workspace>/session-<id>/session.jsonl.zstd` 是 **每行一个 zstd 帧**，遍历帧魔数 `28 B5 2F FD` 逐帧解压、按行切分，得到完整事件流（turn/step/assistant-message/tool-call…）。
2. **asar 索引解析**：`app.asar` 文件头 = 4 字节 pickle + 3 个 uint32 尺寸字段，JSON 索引从偏移 16 开始，offset 是字符串；据此定位任意客户端 bundle 源码。
3. **隔离功能测试**：`lib/index.js` 导出纯函数（`analyzeBlocks`/`renderMermaidCached`/`sanitizeSvgText`…），`npm install && node --test test/` 直接 import 跑通（CI 同款），不依赖应用。客户端另有一组 `test/client.test.mjs`：jsdom + 极简 React 替身驱动真实 `lib/client.js`，专测围栏发现/隐藏/不误藏（注意该替身的能力边界，见教训 11）。
4. **请求级日志**：配置 `debugLog: true` 时宿主路由写 `os.tmpdir()/vizcb-debug.log`（客户端随请求上报版本号），一次重启+一次操作=铁证。
5. **隔离 profile 二分**：`$DSH_HOME/profiles/<probe>` 必须是独立 profile 名（`desktop` 被 Electron 独占，CLI 会拒绝），拷 `package.json`/`cordis*.yml`/`pnpm-workspace.yaml` 后对原 profile 的 `node_modules` 逐项建 junction，再把要改的插件目录换成可编辑副本 —— 这样可以在不影响在用安装的前提下反复"改一行 → 起一次宿主 → 看挂载日志"。
6. **逼出 fatal 启动日志**：非 required 插件激活失败时宿主只在控制台留一句 `did not activate`，不写文件。先用一个临时 `TcpListener` 占住 profile 的默认端口（web profile 是 3080），宿主启动即 fatal，`~/.dsh/logs/startup-*.log` 会带上每个 entry 的 outcome 与全部 startup messages（含真实堆栈）。

---

## 五、教训总结

- **API 契约以真实源码为准**：字段名、返回形状（轻量 vs 快照）、生命周期行为，都要查实现，不能猜。
- **环境差异**：PowerShell 5.1 vs 7 的编码行为；浏览器/Node/应用解析器的宽容度差异。
- **进程架构决定调试路径**：宿主、渲染器、页面的生命周期各自独立，改代码后要知道"谁重载了、谁还驻留"。
- **诊断优先于猜测**：版本徽标、请求日志、隔离测试，让数据说话。
