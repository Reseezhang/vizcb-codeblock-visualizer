// vizcb-codeblock-visualizer - node half (v3).
// 1) Registers the visualization prompt section.
// 2) Serves:
//      POST /vizcb/read-turn          -> { blocks: [{lang, code, title}], reason }
//      GET  /vizcb/mermaid.svg?d=...  -> mermaid rendered to SVG (host-side)
//      GET  /vizcb/debug              -> self-check status JSON
//    with request-body limit and per-session rate limiting.
// 3) Injects window.__VIZCB_CONFIG__ boot globals for the browser half.
import { createRequire } from "node:module";
import { createHTMLWindow } from "svgdom";
import mermaid from "mermaid";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

export const PLUGIN_VERSION = typeof pkg.version === "string" ? pkg.version : "unknown";
export const LOCAL_ROUTE_PATH = "/vizcb";
export const ROUTE_READ_TURN = LOCAL_ROUTE_PATH + "/read-turn";
export const ROUTE_MERMAID = LOCAL_ROUTE_PATH + "/mermaid.svg";
export const ROUTE_DEBUG = LOCAL_ROUTE_PATH + "/debug";

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
  // mermaid 深色画布配色（对齐宿主提示词色板；可用 profile 配置覆盖）
  mermaidTextColor: "#E5E7EB",
  mermaidLineColor: "#4F8CFF",
};

// ── mermaid + svgdom 渲染引擎（纯 Node，无 Chrome）──────────────────────────
// svgdom 的 window 只在首次渲染时注入全局，避免模块加载即污染 Host。
let mermaidReady = false;

function ensureMermaidReady() {
  if (mermaidReady) return;
  const DOMPurifyWindow = new JSDOM("").window;
  const DOMPurify = createDOMPurify(DOMPurifyWindow);
  Object.assign(createDOMPurify, DOMPurify);
  const svgWindow = createHTMLWindow();
  Object.assign(globalThis, { window: svgWindow, document: svgWindow.document });
  if (typeof globalThis.CSSStyleSheet === "undefined") {
    globalThis.CSSStyleSheet = class {
      constructor() { this.cssRules = []; }
      insertRule(rule, index = 0) { this.cssRules.splice(index, 0, rule); return index; }
    };
  }
  mermaidReady = true;
}

async function renderMermaid(code, dark, cfg) {
  ensureMermaidReady();
  mermaid.initialize({
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    startOnLoad: false,
    securityLevel: "loose",
    ...(dark ? { theme: "dark" } : { theme: "default" }),
  });
  const { svg } = await mermaid.render("local-render", code);
  return svg;
}

// 渲染结果按 (theme + code) 内存缓存，避免重复渲染。
const mermaidCache = new Map();
async function renderMermaidCached(code, dark, cfg) {
  const key = (dark ? "d:" : "l:") + code.length + ":" + code;
  const hit = mermaidCache.get(key);
  if (hit !== undefined) return hit;
  const svg = enhanceSvgVisibility(await renderMermaid(code, dark, cfg), dark, cfg);
  if (mermaidCache.size > 200) mermaidCache.clear();
  mermaidCache.set(key, svg);
  return svg;
}

// 估算一行文本的渲染宽度（px）。svgdom/fontkit 在 Node 端测量 CJK 宽度偏窄，
// 导致 mermaid 按偏窄文本布局、浏览器实际渲染时文字溢出矩形 —— 这里用保守系数
// （CJK/全角 1.05em、ASCII 0.6em）估算，留安全余量。
function estimateLabelWidth(text, fontSize) {
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

function decodeBase64Url(input) {
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
  "- ```mermaid：Mermaid 流程图（渲染在沙箱内，适合流程/时序图）",
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
  "HTML 规范：",
  "- 自包含单文件、无外部依赖、无 <script>；body 背景透明、文字用浅色（#E5E7EB）",
  "- 宽度自适应（width:100%），内容高度不超过 560px，超出部分由宿主滚动",
  "",
  "多张图时分成多个独立代码块（每个 ```svg / ```html / ```mermaid 只放一张图），不要拼在一个块里。",
].join("\n");

function resolveConfig(config) {
  const merged = { ...DEFAULTS };
  if (config && typeof config === "object") {
    for (const key of Object.keys(DEFAULTS)) {
      if (config[key] !== undefined) merged[key] = config[key];
    }
  }
  return merged;
}

function extractEventText(target) {
  if (!target || typeof target !== "object") return "";
  const content =
    target.data?.message?.content ??
    target.data?.content ??
    target.message?.content ??
    target.content;
  if (Array.isArray(content)) {
    const out = [];
    for (const block of content) {
      if (typeof block === "string") out.push(block);
      else if (block && typeof block === "object" && typeof block.text === "string" && (block.type === undefined || block.type === "text")) out.push(block.text);
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
    if (typeof node.text === "string") { out.push(node.text); return; }
    for (const k of Object.keys(node)) {
      if (k === "seq" || k === "type" || k === "id" || k === "time" || k === "turn" || k === "step" || k === "index" || k === "dt" || k === "usage" || k === "meta") continue;
      const v = node[k];
      if (typeof v === "string") out.push(v);
      else collectText(v, out);
    }
  }
}

// 从代码块前最多 3 行里提取一行标题（跳过空行、列表/标题标记、其他围栏）。
function extractTitle(text, fenceIndex) {
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
const MERMAID_ALIASES = [
  "mermaid", "mmd", "flowchart", "graph", "sequencediagram", "classdiagram",
  "statediagram", "statediagram-v2", "erdiagram", "gantt", "journey", "pie",
  "gitgraph", "mindmap", "timeline", "requirementdiagram", "quadrantchart",
  "sankey", "xychart", "block", "c4context", "c4container", "c4component",
  "c4dynamic", "c4deployment",
];
const LANG_ALT = ["svg", "html", "html5", ...MERMAID_ALIASES];
const SUPPORTED = new Set(LANG_ALT);

function normalizeLang(raw) {
  const l = String(raw || "").toLowerCase();
  if (l === "html5") return "html";
  if (l === "mmd") return "mermaid";
  if (MERMAID_ALIASES.includes(l)) return "mermaid";
  return l;
}

function analyzeBlocks(text, cfg) {
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

// 每会话滑动窗口限流。
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

const mountedAt = Date.now();

// 请求级调试日志（诊断用，定位后移除）
const DEBUG_LOG_PATH = "D:/usermind/vizcb-debug.log";
function debugLog(...parts) {
  try {
    const fs = require("node:fs");
    fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${parts.join(" ")}\n`);
  } catch (e) { /* ignore */ }
}

async function handleReadTurn(req, res, sessionQuery, cfg) {
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
    debugLog("read-turn", "ERR", "session=" + sessionId, "seq=" + seq, "ver=" + clientVersion, "readEvent failed:", (e && e.message) || e);
    return sendJson(res, 200, { blocks: [], reason: "read-failed" });
  }
  if (text.length === 0) {
    debugLog("read-turn", "NO-TEXT", "session=" + sessionId, "seq=" + seq, "ver=" + clientVersion);
    return sendJson(res, 200, { blocks: [], reason: "no-text" });
  }
  const out = analyzeBlocks(text, cfg);
  debugLog("read-turn", "OK", "session=" + sessionId, "seq=" + seq, "ver=" + clientVersion, "blocks=" + out.blocks.length, "reason=" + out.reason, "langs=" + out.blocks.map((bl) => bl.lang).join(","));
  return sendJson(res, 200, out);
}

function handleDebug(res, sessionQuery, cfg) {
  return sendJson(res, 200, {
    ok: true,
    plugin: "vizcb-codeblock-visualizer",
    version: PLUGIN_VERSION,
    mountedAt,
    uptimeMs: Date.now() - mountedAt,
    routes: [ROUTE_READ_TURN, ROUTE_DEBUG],
    services: { sessionQuery: sessionQuery !== undefined, webServer: true, systemPrompt: true },
    config: { ...cfg, maxBodyBytes: cfg.maxBodyBytes, rateLimitMax: cfg.rateLimitMax },
  });
}

function handleMermaid(req, res, cfg) {
  const sendError = (e) => {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: String((e && e.message) || e).split("\n").slice(0, 3).join(" | ") }));
  };
  const finish = (code, dark) => {
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
    readBody(req, cfg.maxBodyBytes)
      .then((raw) => {
        const payload = JSON.parse(raw);
        const code = payload && typeof payload.code === "string" ? payload.code : "";
        if (code.trim().length === 0) throw new Error("empty diagram");
        if (code.length > cfg.maxBlockChars) throw new Error("diagram too large");
        // dark 以请求体为准（客户端发送 dark: true）；URL ?theme= 仅旧 GET 通道使用
        const dark = !!(payload && payload.dark === true);
        debugLog("mermaid", "POST", "codeLen=" + code.length, "ver=" + (payload && payload.clientVersion || "?"), "dark=" + dark);
        finish(code, dark);
      })
      .catch((e) => {
        debugLog("mermaid", "POST-ERR", String((e && e.message) || e));
        sendError(e);
      });
    return;
  }
  if (req.method !== "GET") return sendJson(res, 405, { blocks: [], reason: "method-not-allowed" });
  // GET ?d=<base64url>（旧 img 通道，保留兼容）
  const dark = new URL(req.url, "http://localhost").searchParams.get("theme") === "dark";
  const d = new URL(req.url, "http://localhost").searchParams.get("d");
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
  finish(code, dark);
}

function route(req, res, sessionQuery, cfg) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === ROUTE_READ_TURN && req.method === "POST") {
    handleReadTurn(req, res, sessionQuery, cfg);
  } else if (url.pathname === ROUTE_MERMAID) {
    handleMermaid(req, res, cfg);
  } else if (url.pathname === ROUTE_DEBUG && req.method === "GET") {
    handleDebug(res, sessionQuery, cfg);
  } else {
    sendJson(res, 404, { blocks: [], reason: "not-found" });
  }
}

function injectBootGlobals(html, cfg) {
  const script =
    "<script>window.__VIZCB_CONFIG__=" +
    JSON.stringify({
      retryDelayMs: cfg.retryDelayMs,
      minSvgHeight: cfg.minSvgHeight,
      mermaidEnabled: cfg.mermaidEnabled,
      htmlAllowScripts: cfg.htmlAllowScripts,
      version: PLUGIN_VERSION,
    }) +
    "<\/script>";
  const body = /<body(?:\s[^>]*)?>/i.exec(html);
  if (body === null) return html + script;
  const at = body.index + body[0].length;
  return html.slice(0, at) + script + html.slice(at);
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  console.log(`[vizcb] mounted v${PLUGIN_VERSION}`, JSON.stringify({ maxBlocks: cfg.maxBlocks, mermaidEnabled: cfg.mermaidEnabled, htmlAllowScripts: cfg.htmlAllowScripts }));
  ctx.inject(["systemPrompt"], (sp) => {
    try {
      sp.systemPrompt.section({ name: "visualizer.codeblock", order: 950, text: PROMPT_TEXT });
    } catch (e) {
      // duplicate registration or invalid shape - non-fatal
    }
  });
  ctx.inject(["webServer", "sessionQuery"], (http) => {
    http.effect(() => http.webServer.tapIndex((html) => injectBootGlobals(html, cfg)), "vizcb-codeblock-visualizer: boot globals");
    http.effect(() => http.webServer.register({
      kind: "prefix",
      path: LOCAL_ROUTE_PATH,
      handler: (req, res) => route(req, res, http.sessionQuery, cfg),
    }), "vizcb-codeblock-visualizer: routes");
  });
}
