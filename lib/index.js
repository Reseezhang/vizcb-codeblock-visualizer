// vizcb-codeblock-visualizer - node half (v6 / 1.6.0).
// 1) Registers the visualization prompt section + the present-files rules.
// 2) Serves:
//      POST /vizcb/read-turn          -> { blocks: [{lang, code, title}], reason, files? }
//      POST /vizcb/mermaid.svg        -> mermaid rendered to SVG (host-side, worker-isolated)
//      GET  /vizcb/p/<token>/<rel>    -> preview file streaming (workspace-contained)
//      GET  /vizcb/p/<token>/meta     -> { exists, mtimeMs, size } for change polling
//      POST /vizcb/reveal             -> open file location in system file manager
//      GET  /vizcb/debug              -> self-check status JSON
//    with request-body limit, per-session rate limiting (read-turn) and a
//    global render limit + serialized worker rendering (mermaid).
// 3) Injects window.__VIZCB_CONFIG__ boot globals for the browser half.
//
// 安全：SVG/mermaid 输出在宿主端经 DOMPurify 消毒后才返回给客户端；
//       预览文件只允许工作区目录内的真实文件（resolve + 包含性校验），
//       经不可猜 token 前缀暴露，iframe 无 allow-same-origin。
// 隔离：mermaid + svgdom 运行在独立 worker_threads，不污染宿主 globalThis。
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const proc = require("node:process");

export const PLUGIN_VERSION = typeof pkg.version === "string" ? pkg.version : "unknown";
export const LOCAL_ROUTE_PATH = "/vizcb";
export const ROUTE_READ_TURN = LOCAL_ROUTE_PATH + "/read-turn";
export const ROUTE_MERMAID = LOCAL_ROUTE_PATH + "/mermaid.svg";
export const ROUTE_DEBUG = LOCAL_ROUTE_PATH + "/debug";
export const ROUTE_PREVIEW = LOCAL_ROUTE_PATH + "/p/"; // /vizcb/p/<token>/<relpath> 与 /vizcb/p/<token>/meta
export const ROUTE_REVEAL = LOCAL_ROUTE_PATH + "/reveal";

const DEFAULTS = {
  maxBlocks: 8,
  maxBlockChars: 64 * 1024,
  retryDelayMs: 2000,
  minSvgHeight: 120,
  mermaidEnabled: true,
  htmlAllowScripts: false,
  maxBodyBytes: 16 * 1024,
  rateLimitWindowMs: 10000,
  rateLimitMax: 30,
  // mermaid 画布配色（对齐宿主提示词色板；可用 profile 配置覆盖）
  mermaidTextColor: "#E5E7EB",
  mermaidLineColor: "#4F8CFF",
  // mermaid 全局渲染限流（滑动窗口内最大渲染次数）
  mermaidRateMax: 30,
  // 请求级调试日志（默认关闭；开启时写入 os.tmpdir()/vizcb-debug.log）
  debugLog: false,
  // 深色画布背景色（卡片图区 / PNG 导出底色）
  canvasBg: "#0F172A",
  // ── 可预览文件（present-files）─────────────────────────
  previewEnabled: true,       // 是否启用 present-files 文件预览
  workspaceRoot: "",          // 工作区根目录；留空时取 sandboxPolicy.workspaceRoot，再退回进程 cwd
  previewMaxBytes: 5 * 1024 * 1024, // 单文件预览上限（超过提示用浏览器打开）
  previewPollMs: 3000,        // 客户端文件变化轮询间隔（ms）
  maxFiles: 12,               // 一次展示最多卡片数
  hideSourceBlocks: true,     // 隐藏本插件渲染过的源码围栏（svg/html/mermaid/present-files），只留渲染结果
};

// ── 宿主端消毒（DOMPurify，SVG/mermaid 输出在返回客户端前净化）───────────
let purify = null;
function getPurify() {
  if (purify === null) {
    const window = new JSDOM("").window;
    purify = createDOMPurify(window);
  }
  return purify;
}
export function sanitizeSvgText(text) {
  if (typeof text !== "string" || !text.includes("<svg")) return text;
  try {
    const clean = getPurify().sanitize(text, { USE_PROFILES: { svg: true, svgFilters: true } });
    return typeof clean === "string" ? clean : "";
  } catch (e) {
    return ""; // 安全件失败即拒绝：绝不把未消毒的原始内容放行（宁可显示空白/错误，不放行原文）
  }
}

// ── mermaid 渲染：独立 worker_threads（不污染宿主 globalThis）──────────────
let mermaidWorker = null;
let workerChain = Promise.resolve();
const mermaidInflight = new Map(); // cacheKey -> Promise
const RENDER_TIMEOUT_MS = 30000;

function spawnWorker() {
  const worker = new Worker(new URL("./mermaid-worker.mjs", import.meta.url));
  worker.on("error", () => { if (mermaidWorker === worker) mermaidWorker = null; });
  worker.on("exit", (code) => { if (code !== 0 && mermaidWorker === worker) mermaidWorker = null; });
  return worker;
}

function callWorker(code, dark) {
  const worker = mermaidWorker || (mermaidWorker = spawnWorker());
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      worker.off("message", onMessage);
      reject(new Error("mermaid render timeout"));
    }, RENDER_TIMEOUT_MS);
    const onMessage = (msg) => {
      if (!msg || msg.id !== id) return;
      clearTimeout(timer);
      worker.off("message", onMessage);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.svg);
    };
    worker.on("message", onMessage);
    try {
      worker.postMessage({ id, code, dark });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

// 串行化渲染：worker 单线程且 mermaid 非并发安全，同一时刻只允许一个渲染。
function enqueueWorker(code, dark) {
  const task = workerChain.then(() => callWorker(code, dark));
  workerChain = task.catch(() => {});
  return task;
}

// 渲染结果按 (theme + code) 内存缓存 + 同 key 在途去重。
const mermaidCache = new Map();
export async function renderMermaidCached(code, dark, cfg) {
  const key = (dark ? "d:" : "l:") + code.length + ":" + code;
  const hit = mermaidCache.get(key);
  if (hit !== undefined) return hit;
  const pending = mermaidInflight.get(key);
  if (pending !== undefined) return pending;
  const task = enqueueWorker(code, dark)
    .then((raw) => {
      const svg = sanitizeSvgText(enhanceSvgVisibility(raw, dark, cfg));
      if (mermaidCache.size > 200) mermaidCache.clear();
      mermaidCache.set(key, svg);
      mermaidInflight.delete(key);
      return svg;
    })
    .catch((e) => {
      mermaidInflight.delete(key);
      throw e;
    });
  mermaidInflight.set(key, task);
  return task;
}

// 测试/卸载收尾：终止 worker 线程、清空渲染队列与缓存，让进程可正常退出。
export function shutdownMermaidWorker() {
  if (mermaidWorker !== null) {
    const w = mermaidWorker;
    mermaidWorker = null;
    try { w.terminate().catch(() => {}); } catch (e) { /* ignore */ }
  }
  workerChain = Promise.resolve();
  mermaidInflight.clear();
  mermaidCache.clear();
}

// 估算一行文本的渲染宽度（px）。svgdom/fontkit 在 Node 端测量 CJK 宽度偏窄，
// 导致 mermaid 按偏窄文本布局、浏览器实际渲染时文字溢出矩形 —— 这里用保守系数
// （CJK/全角 1.05em、ASCII 0.6em）估算，留安全余量。
export function estimateLabelWidth(text, fontSize) {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code > 0x2e7f || (code >= 0x3000 && code <= 0x30ff) || (code >= 0x4e00 && code <= 0x9fff)) units += 1.05;
    else units += 0.6;
  }
  return units * (fontSize || 16);
}

// 节点文本自适应：加宽不足的节点矩形，并同步扩大 viewBox，避免文字溢出边框。
function fitNodesToText(svgText) {
  let doc;
  try {
    doc = new JSDOM(svgText, { contentType: "image/svg+xml" });
  } catch (e) {
    return svgText;
  }
  const document = doc.window.document;
  const svgEl = document.documentElement;
  const fontSize = 16;
  const padding = 12;
  const nodes = [];
  for (const node of document.querySelectorAll("g.node")) {
    const rect = node.querySelector("rect.label-container");
    if (rect === null) continue;
    const rows = [];
    for (const tspan of node.querySelectorAll("tspan.text-inner-tspan")) {
      const t = (tspan.textContent || "").trim();
      if (t.length > 0) rows.push(t);
    }
    const maxRowW = Math.max(0, ...rows.map((r) => estimateLabelWidth(r, fontSize)));
    const rectW = parseFloat(rect.getAttribute("width") || "0");
    const finalW = Math.max(rectW, maxRowW + padding * 2);
    if (finalW > rectW) {
      rect.setAttribute("width", String(finalW));
      rect.setAttribute("x", String(-finalW / 2));
    }
    const tm = (node.getAttribute("transform") || "").match(/translate\(\s*([-\d.]+)/);
    nodes.push({ tx: tm ? parseFloat(tm[1]) : 0, w: finalW });
  }
  const vb = svgEl.getAttribute("viewBox");
  if (vb && nodes.length > 0) {
    const parts = vb.trim().split(/\s+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      const [minX, minY, w, h] = parts;
      let lo = minX;
      let hi = minX + w;
      for (const n of nodes) {
        lo = Math.min(lo, n.tx - n.w / 2);
        hi = Math.max(hi, n.tx + n.w / 2);
      }
      if (lo < minX || hi > minX + w) {
        const pad = 8;
        const newMinX = Math.floor(lo - pad);
        const newW = Math.ceil(hi - lo + pad * 2);
        svgEl.setAttribute("viewBox", `${newMinX} ${minY} ${newW} ${h}`);
        const style = svgEl.getAttribute("style") || "";
        svgEl.setAttribute("style", style.replace(/max-width:\s*[\d.]+px/, `max-width:${newW}px`));
      }
    }
  }
  try {
    return new doc.window.XMLSerializer().serializeToString(svgEl);
  } catch (e) {
    return svgText;
  }
}

// 增强渲染后 SVG：深色主题提亮文字、连线/箭头换主色，并做节点文本自适应。
function enhanceSvgVisibility(svg, dark, cfg) {
  if (typeof svg !== "string" || !svg.includes("<svg")) return svg;
  const textColor = (cfg && cfg.mermaidTextColor) || "#E5E7EB";
  const lineColor = (cfg && cfg.mermaidLineColor) || "#4F8CFF";
  const textBoost =
    dark
      ? "#local-render{fill:" + textColor + "!important}" +
        "#local-render .label{color:" + textColor + "!important}" +
        "#local-render .cluster-label text{fill:" + textColor + "!important}" +
        "#local-render .cluster-label span{color:" + textColor + "!important}" +
        "#local-render .node .label-container{stroke:" + lineColor + "!important;stroke-opacity:.55!important;stroke-width:1.2px!important}"
      : "";
  const boost =
    "<style>" +
    textBoost +
    "#local-render .edgePath .path{stroke:" + lineColor + "!important;stroke-width:2.4px!important}" +
    "#local-render .flowchart-link{stroke:" + lineColor + "!important;stroke-width:2.4px!important}" +
    "#local-render .messageLine0{stroke:" + lineColor + "!important;stroke-width:2.4px!important}" +
    "#local-render .messageLine1{stroke:" + lineColor + "!important;stroke-width:2.4px!important}" +
    "#local-render .actor-line{stroke:" + lineColor + "!important;stroke-width:1.6px!important}" +
    "#local-render .arrowheadPath{fill:" + lineColor + "!important}" +
    "#local-render .marker{fill:" + lineColor + "!important;stroke:" + lineColor + "!important}" +
    "#local-render-arrowhead path{fill:" + lineColor + "!important;stroke:" + lineColor + "!important}" +
    "#local-render .edgeLabel{background-color:transparent!important}" +
    "#local-render .edgeLabel p{color:" + textColor + "!important}" +
    "</style>";
  let out = svg;
  const open = out.indexOf("<svg");
  const close = out.indexOf(">", open) + 1;
  if (close > open) out = out.slice(0, close) + boost + out.slice(close);
  // 箭头 marker 放大 1.5 倍
  out = out.replace(/(marker(?:Width|Height)=")([\d.]+)(")/g, (m, pre, num, post) => pre + (Math.round(parseFloat(num) * 1.5 * 10) / 10) + post);
  // 节点文本自适应（扩宽矩形 + viewBox）
  return fitNodesToText(out);
}

export function decodeBase64Url(input) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const bytes = Buffer.from(padded, "base64");
  return bytes.toString("utf8");
}

const PROMPT_TEXT = [
  "## 可视化输出规范",
  "",
  "当回答涉及流程、架构、数据对比、时序或任何「一图胜千言」的内容时，直接用代码块输出可视化图表，不要只写文字描述。宿主应用会把以下格式的代码块渲染为内嵌图表卡片。",
  "",
  "可用格式：",
  "- ```svg：自包含 SVG 矢量图（首选）",
  "- ```html：自包含 HTML 页面（复杂布局）",
  "- ```mermaid：Mermaid 流程图（宿主端渲染，适合流程/时序图）",
  "",
  "SVG 设计规范（必须遵守，否则渲染出来会很难看）：",
  "1. 色板固定如下，不要用色板外的颜色：主色 #4F8CFF、次色 #34D399、强调 #F59E0B、警示 #F87171；文本 #E5E7EB（正文）、#9CA3AF（次级）",
  "2. 节点用圆角矩形（rx=8），填充用主色半透明（fill-opacity 0.12~0.18）+ 1px 同色描边，背景保持透明（宿主会给深色画布）",
  "3. 连线用平滑曲线，箭头指向目标节点",
  "4. 单图不超过 6 个节点；节点间距不小于 40px；文字 13~14px 居中",
  "5. viewBox 用整数尺寸（如 0 0 640 400），宽度自适应卡片，高度由 viewBox 比例决定",
  "6. 只允许纯矢量图形 + <text> 文本；禁止 <script>、on* 事件属性、外部资源引用、javascript: 链接",
  "7. 中文文本直接写入 SVG，字体用系统默认，不要指定特殊字体族",
  "",
  "Mermaid 补充：",
  "- 节点/边标签内含 |、双引号、<、> 等特殊字符时，用双引号包裹整个标签（如 F[\"A | B\"]）；| 是连接线标签定界符，裸写会导致解析失败",
  "- subgraph 标题含空格/括号/中文等字符时用双引号包裹（如 subgraph \"本地 PC 日志（规格）\"）；标题内禁止出现 [ ] { } 等语法字符，且节点必须另起一行，不能和 subgraph 写在同一行",
  "- timeline 图的 period（时间）内禁止冒号：`:` 是时间与事件的分隔符，`10:33` 会解析失败；用 `10点33分`/`10时33分` 或 `2026-08-30` 日期格式，描述写在冒号后",
  "- <br> 可用于标签内换行；每条消息内同一图只画一次，不要拼块",
  "",
  "HTML 规范：",
  "- 自包含单文件、无外部依赖、无 <script>；body 背景透明、文字用浅色（#E5E7EB）",
  "- 宽度自适应（width:100%），内容高度不超过 560px，超出部分由宿主滚动",
  "",
  "多张图时分成多个独立代码块（每个 ```svg / ```html / ```mermaid 只放一张图），不要拼在一个块里。",
].join("\n");

const PROMPT_PRESENT_TEXT = [
  "## 可预览文件展示规范",
  "",
  "当产出可预览的文件（HTML 页面、报告、图片等）后，用下面的指令把文件交给宿主展示：",
  "1. 在回复末尾输出一个 ```present-files 代码块，每行一个文件路径（相对工作区的路径或绝对路径均可，不要加引号或反引号包裹）",
  "2. 第一行是用户最应优先查看的文件，会自动打开预览；其余文件排成卡片列表，点击切换",
  "3. 一次任务产出多个文件时合并到同一个 ```present-files 块，不要分多次输出",
  "4. 只在任务完成、文件是最终成品时输出；中间过程文件、临时文件、构建产物不要展示",
  "5. 展示后文字回复用一两句话概括文件内容即可，不要长篇复述文件里写了什么",
].join("\n");

export function resolveConfig(config) {
  const merged = { ...DEFAULTS };
  if (config && typeof config === "object") {
    for (const key of Object.keys(DEFAULTS)) {
      if (config[key] !== undefined) merged[key] = config[key];
    }
  }
  return merged;
}

function blockText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  return "";
}

// DSH 可能把消息里的代码块按结构化存储（type=code/fence/pre + language + text），
// 文本里没有围栏标记。识别图表语言的代码块并还原 ```<lang> 围栏，供 analyzeBlocks 检测。
function fencedCodeBlock(block) {
  if (!block || typeof block !== "object") return null;
  const isCodeType =
    typeof block.type === "string" &&
    ["code", "fence", "pre", "codeblock", "block"].includes(block.type.toLowerCase());
  const langRaw =
    typeof block.language === "string" ? block.language :
    typeof block.lang === "string" ? block.lang :
    typeof block.info === "string" ? block.info : "";
  if (!isCodeType && langRaw.length === 0) return null;
  const body =
    typeof block.text === "string" ? block.text :
    typeof block.content === "string" ? block.content : null;
  if (body === null || body.trim().length === 0) return null;
  const lang = normalizeLang(langRaw.trim());
  if (!SUPPORTED.has(lang)) return null; // 非图表语言不动
  if (body.includes("```")) return body; // 已含围栏，原样返回
  return "```" + lang + "\n" + body + "\n```";
}

export function extractEventText(target) {
  if (!target || typeof target !== "object") return "";
  const content =
    target.data?.message?.content ??
    target.data?.message?.blocks ??
    target.data?.content ??
    target.message?.content ??
    target.message?.parts ??
    target.content ??
    target.parts;
  if (Array.isArray(content)) {
    const out = [];
    for (const block of content) {
      if (typeof block === "string") { out.push(block); continue; }
      if (block && typeof block === "object") {
        const fenced = fencedCodeBlock(block);
        if (fenced !== null) { out.push(fenced); continue; }
        const t = blockText(block);
        if (t.length > 0) out.push(t);
      }
    }
    return out.join("\n");
  }
  if (typeof content === "string") return content;
  const out = [];
  collectText(target, out);
  return out.join("\n");
}

function collectText(node, out) {
  if (node == null) return;
  if (typeof node === "string") { out.push(node); return; }
  if (Array.isArray(node)) { for (const v of node) collectText(v, out); return; }
  if (typeof node === "object") {
    if (typeof node.text === "string") {
      const fenced = fencedCodeBlock(node);
      out.push(fenced !== null ? fenced : node.text);
      return;
    }
    if (typeof node.content === "string" && typeof node.type === "string") {
      const fenced = fencedCodeBlock(node);
      out.push(fenced !== null ? fenced : node.content);
      return;
    }
    for (const k of Object.keys(node)) {
      if (k === "seq" || k === "type" || k === "id" || k === "time" || k === "turn" || k === "step" || k === "index" || k === "dt" || k === "usage" || k === "meta") continue;
      const v = node[k];
      if (typeof v === "string") out.push(v);
      else collectText(v, out);
    }
  }
}

// 从代码块前最多 3 行里提取一行标题（跳过空行、列表/标题标记、其他围栏）。
export function extractTitle(text, fenceIndex) {
  const before = text.slice(0, fenceIndex);
  const lines = before.split("\n");
  let skipped = 0;
  for (let i = lines.length - 1; i >= 0 && skipped <= 2; i--) {
    const line = lines[i].trim();
    if (line === "") { skipped++; continue; }
    if (line.length > 40) return null;
    if (/^```/.test(line)) return null;
    if (/^[-*#>]|\d+[.、]/.test(line)) return null;
    const title = line.replace(/[：:。，、;；]+$/, "").trim();
    if (title.length === 0 || title.length > 40) return null;
    return title;
  }
  return null;
}

// mermaid 方言/别名：模型常用 ```flowchart / ```graph / ```sequenceDiagram 等
// 代替 ```mermaid，全部归一到 mermaid。
export const MERMAID_ALIASES = [
  "mermaid", "mmd", "flowchart", "graph", "sequencediagram", "classdiagram",
  "statediagram", "statediagram-v2", "erdiagram", "gantt", "journey", "pie",
  "gitgraph", "mindmap", "timeline", "requirementdiagram", "quadrantchart",
  "sankey", "xychart", "block", "c4context", "c4container", "c4component",
  "c4dynamic", "c4deployment",
];
const LANG_ALT = ["svg", "html", "html5", ...MERMAID_ALIASES];
const SUPPORTED = new Set(LANG_ALT);

export function normalizeLang(raw) {
  const l = String(raw || "").toLowerCase();
  if (l === "html5") return "html";
  if (l === "mmd") return "mermaid";
  if (MERMAID_ALIASES.includes(l)) return "mermaid";
  return l;
}

export function analyzeBlocks(text, cfg) {
  const blocks = [];
  let lineStartFences = 0;
  let skippedMermaid = 0;
  const re = new RegExp("(?:^|\\n)[ \\t]*```(" + LANG_ALT.join("|") + ")\\b([^\\n]*)\\n([\\s\\S]*?)```", "gi");
  let m;
  while ((m = re.exec(text)) !== null) {
    lineStartFences++;
    const lang = normalizeLang(m[1]);
    if (lang === "mermaid" && !cfg.mermaidEnabled) { skippedMermaid++; continue; }
    if (blocks.length >= cfg.maxBlocks) continue;
    const code = m[3];
    if (typeof code !== "string" || code.trim().length === 0) continue;
    if (code.length > cfg.maxBlockChars) continue;
    blocks.push({ lang, code, title: extractTitle(text, m.index) });
  }
  if (blocks.length > 0) return { blocks, reason: null };
  if (lineStartFences > 0) {
    if (skippedMermaid > 0) return { blocks: [], reason: "mermaid-disabled" };
    return { blocks: [], reason: "block-invalid" };
  }
  const fences = text.match(/```[a-z0-9]*/gi) || [];
  if (fences.length === 0) return { blocks: [], reason: "none" };
  const langs = [];
  for (const fence of fences) { const l = fence.slice(3).toLowerCase(); if (l) langs.push(l); }
  if (langs.some((l) => SUPPORTED.has(l))) return { blocks: [], reason: "fence-not-at-line-start" };
  // 只有"明显试图画图"的围栏语言才提示不支持；普通代码块（js/py 等）静默。
  const diagramAttempt = ["dot", "plantuml", "graphviz", "ditaa", "uml"];
  if (langs.some((l) => diagramAttempt.includes(l))) return { blocks: [], reason: "unsupported-language" };
  return { blocks: [], reason: "none" };
}

// ── 可预览文件（present-files）─────────────────────────────────────
// 模型在回复末尾输出 ```present-files 块，每行一个路径（支持 markdown 列表标记、
// 空行与 # 注释），第一行最先展示。

export function parsePresentDirective(code) {
  const paths = [];
  for (const raw of String(code).split(/\r?\n/)) {
    let line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    line = line.replace(/^[-*+]\s+/, "").trim();
    if (line.length === 0) continue;
    paths.push(line);
  }
  return paths;
}

export function extractPresentDirectives(text) {
  const paths = [];
  if (typeof text !== "string") return paths;
  const re = /(?:^|\n)[ \t]*```present-files\b[^\n]*\n([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    for (const p of parsePresentDirective(m[1])) paths.push(p);
  }
  return paths;
}

// 把用户/模型给出的路径规范化为绝对路径，并判断是否落在工作区内。
// 防 `../` 越界：path.relative 的结果不能以 ".." 开头且不能是绝对路径。
export function resolvePresentedPath(input, root) {
  if (typeof input !== "string" || input.trim().length === 0) return null;
  const abs = path.resolve(root, input.trim());
  const rel = path.relative(root, abs);
  const inside = rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  return { abs, rel, inside };
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif"]);
const TEXT_EXT = new Set([".md", ".txt", ".json", ".log", ".csv", ".tsv", ".yaml", ".yml", ".toml", ".ini", ".xml"]);
export function langOfExt(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === ".html" || e === ".htm") return "html";
  if (e === ".css") return "css";
  if (e === ".js" || e === ".mjs" || e === ".cjs") return "js";
  if (IMAGE_EXT.has(e)) return "image";
  if (TEXT_EXT.has(e)) return "text";
  return "other";
}

function mimeOf(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8", ".xml": "text/xml; charset=utf-8", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif",
  };
  return map[ext] || "application/octet-stream";
}

// 校验并统计一批路径；返回 { items, invalid }。
export async function buildFiles(rawPaths, cfg, root) {
  const items = [];
  const invalid = [];
  const limit = Math.max(1, Number(cfg.maxFiles) || 12);
  for (const raw of rawPaths) {
    const r = resolvePresentedPath(raw, root);
    if (r === null) { invalid.push({ input: String(raw), reason: "empty" }); continue; }
    if (!r.inside) { invalid.push({ input: String(raw), reason: "outside-workspace" }); continue; }
    let st;
    try { st = await fsp.stat(r.abs); } catch (e) { invalid.push({ input: String(raw), reason: "not-found" }); continue; }
    if (!st.isFile()) { invalid.push({ input: String(raw), reason: "not-a-file" }); continue; }
    if (items.length >= limit) { invalid.push({ input: String(raw), reason: "too-many" }); continue; }
    items.push({
      rel: r.rel.split(path.sep).join("/"),
      abs: r.abs,
      name: path.basename(r.abs),
      ext: path.extname(r.abs).toLowerCase().replace(".", ""),
      size: st.size,
      mtimeMs: st.mtimeMs,
      lang: langOfExt(path.extname(r.abs)),
    });
  }
  return { items, invalid };
}

// 工作区根目录解析：显式配置 > sandboxPolicy.workspaceRoot > 进程 cwd。
function resolveWorkspaceRoot(cfg, ctx) {
  if (typeof cfg.workspaceRoot === "string" && cfg.workspaceRoot.trim().length > 0) {
    return path.resolve(cfg.workspaceRoot.trim());
  }
  try {
    const sp = ctx && typeof ctx.get === "function" ? ctx.get("sandboxPolicy") : undefined;
    if (sp && typeof sp.workspaceRoot === "string" && sp.workspaceRoot.length > 0) {
      return path.resolve(sp.workspaceRoot);
    }
  } catch (e) { /* ignore */ }
  try { return proc.cwd(); } catch (e) { return "."; }
}

// 预览文件服务：token 前缀 + 包含性校验 + 大小上限 + no-store + HEAD/meta。
export async function handlePreviewFileRequest(req, res, cfg, root, token) {
  const url = new URL(req.url, "http://localhost");
  const prefix = ROUTE_PREVIEW + token + "/";
  if (!url.pathname.startsWith(prefix)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: "bad token" }));
  }
  const rest = url.pathname.slice(prefix.length);
  const sendJsonLocal = (status, body) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  };
  if (rest === "meta") {
    const p = url.searchParams.get("p") || "";
    const r = resolvePresentedPath(p, root);
    if (r === null || !r.inside) return sendJsonLocal(200, { exists: false, mtimeMs: 0, size: 0 });
    try {
      const st = await fsp.stat(r.abs);
      return sendJsonLocal(200, { exists: st.isFile(), mtimeMs: st.mtimeMs, size: st.isFile() ? st.size : 0 });
    } catch (e) {
      return sendJsonLocal(200, { exists: false, mtimeMs: 0, size: 0 });
    }
  }
  let decoded;
  try { decoded = decodeURIComponent(rest); } catch (e) { return sendJsonLocal(400, { error: "bad path" }); }
  const r = resolvePresentedPath(decoded, root);
  if (r === null || !r.inside) return sendJsonLocal(403, { error: "outside workspace" });
  let st;
  try { st = await fsp.stat(r.abs); } catch (e) { return sendJsonLocal(404, { error: "not found" }); }
  if (!st.isFile()) return sendJsonLocal(403, { error: "not a file" });
  if (st.size > cfg.previewMaxBytes) return sendJsonLocal(413, { error: "file too large" });
  res.statusCode = 200;
  res.setHeader("Content-Type", mimeOf(r.abs));
  res.setHeader("Content-Length", st.size);
  res.setHeader("Last-Modified", st.mtime.toUTCString());
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(r.abs).pipe(res);
}

// 在系统文件管理器中定位文件（仅用户点击触发；校验工作区内）。
async function handleReveal(req, res, cfg, root) {
  let payload;
  try { payload = JSON.parse(await readBody(req, cfg.maxBodyBytes)); } catch (e) { return sendJson(res, 400, { ok: false, reason: "bad-body" }); }
  const input = payload && typeof payload.path === "string" ? payload.path : "";
  const r = resolvePresentedPath(input, root);
  if (r === null || !r.inside) return sendJson(res, 403, { ok: false, reason: "outside-workspace" });
  try {
    let child;
    if (proc.platform === "win32") child = spawn("explorer.exe", ["/select,", r.abs], { detached: true, stdio: "ignore", windowsHide: true });
    else if (proc.platform === "darwin") child = spawn("open", ["-R", r.abs], { detached: true, stdio: "ignore" });
    else child = spawn("xdg-open", [path.dirname(r.abs)], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 500, { ok: false, reason: "spawn-failed" });
  }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reject(new Error("stream error")));
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

// 每会话滑动窗口限流（read-turn）。
const rateBuckets = new Map();
function rateLimited(sessionId, windowMs, max) {
  if (rateBuckets.size > 1000) rateBuckets.clear();
  const now = Date.now();
  let bucket = rateBuckets.get(sessionId);
  if (bucket === undefined || now - bucket.windowStart > windowMs) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(sessionId, bucket);
  }
  bucket.count++;
  return bucket.count > max;
}

// mermaid 渲染全局限流（滑动窗口，与 read-turn 的会话限流互补）。
const mermaidRateTimes = [];
function mermaidRateLimited(cfg) {
  const now = Date.now();
  while (mermaidRateTimes.length > 0 && now - mermaidRateTimes[0] > cfg.rateLimitWindowMs) mermaidRateTimes.shift();
  if (mermaidRateTimes.length >= cfg.mermaidRateMax) return true;
  mermaidRateTimes.push(now);
  return false;
}

const mountedAt = Date.now();

// 请求级调试日志：默认关闭（cfg.debugLog: true 开启，写 os.tmpdir()/vizcb-debug.log）。
function debugLog(cfg, ...parts) {
  if (!cfg || !cfg.debugLog) return;
  try {
    const fs = require("node:fs");
    const os = require("node:os");
    const p = require("node:path");
    fs.appendFileSync(p.join(os.tmpdir(), "vizcb-debug.log"), `[${new Date().toISOString()}] ${parts.join(" ")}\n`);
  } catch (e) { /* ignore */ }
}

async function handleReadTurn(req, res, sessionQuery, cfg, root, token) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req, cfg.maxBodyBytes));
  } catch (e) {
    return sendJson(res, 400, { blocks: [], reason: "bad-body" });
  }
  const sessionId = payload && typeof payload.sessionId === "string" ? payload.sessionId : undefined;
  const seq = Number(payload && payload.seq);
  const clientVersion = payload && typeof payload.clientVersion === "string" ? payload.clientVersion : "?";
  if (!sessionId || !Number.isFinite(seq)) return sendJson(res, 200, { blocks: [], reason: "invalid-args" });
  if (rateLimited(sessionId, cfg.rateLimitWindowMs, cfg.rateLimitMax)) {
    return sendJson(res, 429, { blocks: [], reason: "rate-limited" });
  }
  if (sessionQuery === undefined) return sendJson(res, 200, { blocks: [], reason: "no-query-service" });
  let text = "";
  try {
    const result = await sessionQuery.readEvent({ sessionId, seq });
    text = extractEventText(result && result.target);
  } catch (e) {
    debugLog(cfg, "read-turn", "ERR", "session=" + sessionId, "seq=" + seq, "ver=" + clientVersion, "readEvent failed:", (e && e.message) || e);
    return sendJson(res, 200, { blocks: [], reason: "read-failed" });
  }
  if (text.length === 0) {
    debugLog(cfg, "read-turn", "NO-TEXT", "session=" + sessionId, "seq=" + seq, "ver=" + clientVersion);
    return sendJson(res, 200, { blocks: [], reason: "no-text" });
  }
  const out = analyzeBlocks(text, cfg);
  if (out.blocks && out.blocks.length > 0) {
    for (const bl of out.blocks) {
      if (bl.lang === "svg") bl.code = sanitizeSvgText(bl.code);
    }
  }
  // present-files 指令：校验路径并附上预览文件清单（同一次 read-turn 一起返回）。
  if (cfg.previewEnabled) {
    const dirs = extractPresentDirectives(text);
    if (dirs.length > 0) {
      const { items, invalid } = await buildFiles(dirs, cfg, root);
      out.files = { token, items, invalid };
    }
  }
  debugLog(cfg, "read-turn", "OK", "session=" + sessionId, "seq=" + seq, "ver=" + clientVersion, "blocks=" + out.blocks.length, "reason=" + out.reason, "files=" + ((out.files && out.files.items) ? out.files.items.length : 0), "langs=" + out.blocks.map((bl) => bl.lang).join(","));
  return sendJson(res, 200, out);
}

function handleDebug(res, sessionQuery, cfg, root) {
  return sendJson(res, 200, {
    ok: true,
    plugin: "vizcb-codeblock-visualizer",
    version: PLUGIN_VERSION,
    mountedAt,
    uptimeMs: Date.now() - mountedAt,
    routes: [ROUTE_READ_TURN, ROUTE_MERMAID, ROUTE_PREVIEW, ROUTE_REVEAL, ROUTE_DEBUG],
    services: { sessionQuery: sessionQuery !== undefined, webServer: true, systemPrompt: true, mermaidWorker: mermaidWorker !== null },
    config: { ...cfg, maxBodyBytes: cfg.maxBodyBytes, rateLimitMax: cfg.rateLimitMax, mermaidRateMax: cfg.mermaidRateMax },
    workspace: { root, previewEnabled: cfg.previewEnabled, previewMaxBytes: cfg.previewMaxBytes },
  });
}

function handleMermaid(req, res, cfg) {
  const sendError = (e) => {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: String((e && e.message) || e).split("\n").slice(0, 3).join(" | ") }));
  };
  const finish = (code, dark) => {
    if (mermaidRateLimited(cfg)) {
      return sendJson(res, 429, { error: "render rate limited" });
    }
    renderMermaidCached(code, dark, cfg)
      .then((svg) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(svg);
      })
      .catch(sendError);
  };
  if (req.method === "POST") {
    // 客户端主通道：POST { code, dark } -> SVG（与 read-turn 同一已验证传输）
    // body 上限取 maxBlockChars（块级上限），避免 16KB 请求体限制拒掉合法大图。
    readBody(req, Math.max(cfg.maxBodyBytes, cfg.maxBlockChars))
      .then((raw) => {
        const payload = JSON.parse(raw);
        const code = payload && typeof payload.code === "string" ? payload.code : "";
        if (code.trim().length === 0) throw new Error("empty diagram");
        if (code.length > cfg.maxBlockChars) throw new Error("diagram too large");
        const dark = !!(payload && payload.dark === true);
        debugLog(cfg, "mermaid", "POST", "codeLen=" + code.length, "ver=" + (payload && payload.clientVersion || "?"), "dark=" + dark);
        finish(code, dark);
      })
      .catch((e) => {
        debugLog(cfg, "mermaid", "POST-ERR", String((e && e.message) || e));
        sendError(e);
      });
    return;
  }
  if (req.method !== "GET") return sendJson(res, 405, { blocks: [], reason: "method-not-allowed" });
  // GET ?d=<base64url>（旧 img 通道，保留兼容）
  const url = new URL(req.url, "http://localhost");
  const dark = url.searchParams.get("theme") === "dark";
  const d = url.searchParams.get("d");
  if (typeof d !== "string" || d.length === 0 || d.length > 64 * 1024) {
    return sendJson(res, 400, { error: "missing or oversized d param" });
  }
  let code;
  try {
    code = decodeBase64Url(d);
  } catch (e) {
    return sendJson(res, 400, { error: "invalid base64" });
  }
  if (code.trim().length === 0) return sendJson(res, 400, { error: "empty diagram" });
  // 与 POST 通道一致：解码后的代码同样受 maxBlockChars 上限约束
  if (code.length > cfg.maxBlockChars) return sendJson(res, 400, { error: "diagram too large" });
  finish(code, dark);
}

function route(req, res, sessionQuery, cfg, root, token) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === ROUTE_READ_TURN && req.method === "POST") {
    handleReadTurn(req, res, sessionQuery, cfg, root, token);
  } else if (url.pathname === ROUTE_MERMAID) {
    handleMermaid(req, res, cfg);
  } else if (url.pathname === ROUTE_REVEAL && req.method === "POST") {
    handleReveal(req, res, cfg, root);
  } else if (url.pathname.startsWith(ROUTE_PREVIEW) && (req.method === "GET" || req.method === "HEAD")) {
    handlePreviewFileRequest(req, res, cfg, root, token);
  } else if (url.pathname === ROUTE_DEBUG && req.method === "GET") {
    handleDebug(res, sessionQuery, cfg, root);
  } else {
    sendJson(res, 404, { blocks: [], reason: "not-found" });
  }
}

function injectBootGlobals(html, cfg) {
  // JSON 内容转义 <，防止配置值提前闭合 script 标签。
  const json = JSON.stringify({
    retryDelayMs: cfg.retryDelayMs,
    minSvgHeight: cfg.minSvgHeight,
    mermaidEnabled: cfg.mermaidEnabled,
    htmlAllowScripts: cfg.htmlAllowScripts,
    canvasBg: cfg.canvasBg,
    previewEnabled: cfg.previewEnabled,
    previewPollMs: cfg.previewPollMs,
    hideSourceBlocks: cfg.hideSourceBlocks,
    version: PLUGIN_VERSION,
  }).replace(/</g, "\\u003c");
  const script = "<script>window.__VIZCB_CONFIG__=" + json + "<\/script>";
  const body = /<body(?:\s[^>]*)?>/i.exec(html);
  if (body === null) return html + script;
  const at = body.index + body[0].length;
  return html.slice(0, at) + script + html.slice(at);
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const root = resolveWorkspaceRoot(cfg, ctx);
  const token = randomBytes(16).toString("hex"); // 预览 URL 不可猜前缀
  console.log(`[vizcb] mounted v${PLUGIN_VERSION}`, JSON.stringify({ maxBlocks: cfg.maxBlocks, mermaidEnabled: cfg.mermaidEnabled, htmlAllowScripts: cfg.htmlAllowScripts, debugLog: cfg.debugLog, previewEnabled: cfg.previewEnabled, workspaceRoot: root }));
  ctx.inject(["systemPrompt"], (sp) => {
    try {
      sp.systemPrompt.section({ name: "visualizer.codeblock", order: 950, text: PROMPT_TEXT });
      sp.systemPrompt.section({ name: "visualizer.present-files", order: 960, text: PROMPT_PRESENT_TEXT });
    } catch (e) {
      // duplicate registration or invalid shape - non-fatal
    }
  });
  ctx.inject(["webServer", "sessionQuery"], (http) => {
    http.effect(() => http.webServer.tapIndex((html) => injectBootGlobals(html, cfg)), "vizcb-codeblock-visualizer: boot globals");
    http.effect(() => http.webServer.register({
      kind: "prefix",
      path: LOCAL_ROUTE_PATH,
      handler: (req, res) => route(req, res, http.sessionQuery, cfg, root, token),
    }), "vizcb-codeblock-visualizer: routes");
  });
}
