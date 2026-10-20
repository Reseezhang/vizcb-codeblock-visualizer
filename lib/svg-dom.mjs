// vizcb-codeblock-visualizer - 需要 DOM 的宿主端任务（消毒 / 节点自适应 / 配色增强 / 版式后处理）。
//
// 【重要】本模块 import jsdom（CJS 包）。它只能被 worker 线程 import，绝不能被
// lib/index.js（宿主主线程）直接或间接 import —— DSH 0.2.0-rc.2 在解析 profile
// 插件引用的 CJS 依赖时，会在 ResolutionRouter.routeScoped 抛
//   TypeError: createRequire.resolve.paths is not a function or its return value is not iterable
// 于是插件的整次 import 失败，宿主只留下一句 "failed to import"（详见 DEVELOPMENT.md）。
// worker 线程走的是自己的 loader，没有宿主那层解析钩子，jsdom 在那边完全正常。
// 同理：polish 的版本号放在零依赖的 lib/polish-version.mjs，不要从本模块 export 给主线程。
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { estimateLabelWidth } from "./label-metrics.mjs";

// ── 消毒（DOMPurify，SVG/mermaid 输出在返回客户端前净化）───────────────
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

// ── 版式后处理（polish）───────────────────────────────────────────────
// mermaid 的多行标签在 SVG 里是「每行一个 tspan.text-outer-tspan」，字号字重完全一致，
// 自动生成的图因此显得「平」；同时 svgdom 下字体测量不准，mermaid 按「换行前」的行数
// 算子块居中与框高，实渲染折成更多行后行与行会叠在一起、末行压出框。这里在返回客户端前
// 重排一次（纯视觉层，不改布局坐标）：
//   · 节点标签首行 → 主标题（14px / 500），其余行 → 副标题（11.5px / 0.72）
//   · 边标签 → 12px（弱化，不与节点抢注意力）
//   · 按真实行数用像素重算行盒，并把整块文字在方框内垂直居中
//   · 方框补 rx/ry=6 圆角、边标签去底色
// 注意：连线粗细不在这里改 —— 它由 enhanceSvgVisibility 里那条 #local-render 规则统一
// 产出（class 选择器打不过 #id，见 enhanceSvgVisibility 的注释）。
//
// 只对 flowchart 生效：state / class / ER 的 g.node 结构不同（方框不一定以节点原点为心、
// 有的节点内含属性行），按固定行盒重排会把标题顶到框上沿。
const MAIN_H = 20; // 主标题行盒
const SUB_H = 17;  // 副标题行盒
const PAD_V = 6;   // 上下内边距（框已够高时仅作为最小留白）

// 根节点上 mermaid 会写 aria-roledescription="flowchart-v2"；老版本只有 class。
function isFlowchart(svgEl) {
  const role = (svgEl.getAttribute("aria-roledescription") || "").toLowerCase();
  if (role.length > 0) return role.startsWith("flowchart");
  return (svgEl.getAttribute("class") || "").toLowerCase().split(/\s+/).includes("flowchart");
}

function polishNodes(document, svgEl) {
  const SVG_NS = "http://www.w3.org/2000/svg";

  // 1) 标签分级：首行主标题、其余行副标题。
  // 必须改「内层」tspan（text-inner-tspan）：外层 row 上的 y/dy 是以 em 计的，
  // em 相对自身字号解析 —— 改外层字号会让行距跟着缩短，两行文字直接叠在一起。
  // 另外内层 tspan 自带 font-weight="normal"，不改它的话 font-weight="500" 会被覆盖。
  for (const text of document.querySelectorAll("g.node .label text")) {
    const rows = text.querySelectorAll("tspan.text-outer-tspan");
    rows.forEach((row, i) => {
      const inner = Array.from(row.querySelectorAll("tspan.text-inner-tspan"));
      for (const t of inner.length > 0 ? inner : [row]) {
        if (i === 0) {
          t.setAttribute("font-size", "14");
          t.setAttribute("font-weight", "500");
        } else {
          t.setAttribute("font-size", "11.5");
          t.setAttribute("font-weight", "400");
          t.setAttribute("opacity", "0.72");
        }
      }
    });
  }

  // 2) 边标签降一档。改 text 元素本身是安全的：子行继承同一字号，
  // y/dy 的 em 基准等比缩小，行距仍然一致。
  for (const text of document.querySelectorAll("g.edgeLabel text")) {
    text.setAttribute("font-size", "12");
  }

  // 3) 垂直重排（最关键的一步）。按真实行数用像素重算行盒：
  //    框不够高 → 补高并保持中心；框比内容高 → 整块文字居中（否则贴住框上沿）。
  const bounds = [];
  for (const node of document.querySelectorAll("g.node")) {
    const rect = node.querySelector("rect.label-container");
    if (rect === null) continue; // 胶囊 / 菱形用 path 渲染，交给图形自身
    const label = node.querySelector("g.label");
    const text = (label || node).querySelector("text");
    if (text === null) continue;
    const rows = Array.from(text.querySelectorAll("tspan.text-outer-tspan"));
    if (rows.length === 0) continue;
    const heights = rows.map((_, i) => (i === 0 ? MAIN_H : SUB_H));
    const contentH = heights.reduce((a, b) => a + b, 0);
    const need = contentH + PAD_V * 2;
    let h = parseFloat(rect.getAttribute("height") || "0");
    if (need > h) {
      rect.setAttribute("height", String(need));
      rect.setAttribute("y", String(-need / 2));
      h = need;
    }
    if (label !== null) label.setAttribute("transform", "translate(0, 0)");
    let top = -h / 2 + (h - contentH) / 2; // 整块文字在框内居中
    rows.forEach((row, i) => {
      // 行盒内基线；四舍五入到 0.01px，避免 17*0.78 这类浮点尾巴进到 SVG 属性里
      const y = Math.round((top + heights[i] * 0.78) * 100) / 100;
      row.setAttribute("y", String(y));
      row.setAttribute("dy", "0");
      top += heights[i];
    });
    const ty = (node.getAttribute("transform") || "").match(/translate\(\s*[-\d.]+[, ]+([-\d.]+)/);
    const baseY = ty ? parseFloat(ty[1]) : 0;
    const rectY = parseFloat(rect.getAttribute("y") || "0");
    bounds.push({ top: baseY + rectY, bot: baseY + rectY + h });
  }

  // 4) 方框补高后可能顶出画布：按需扩展 viewBox（只改高，宽度由 fitNodesToText 负责）。
  const vbRaw = svgEl.getAttribute("viewBox");
  if (vbRaw && bounds.length > 0) {
    const [vx, vy, vw, vh] = vbRaw.trim().split(/\s+/).map(Number);
    if ([vx, vy, vw, vh].every(Number.isFinite)) {
      const top = Math.min(vy, ...bounds.map((b) => b.top));
      const bot = Math.max(vy + vh, ...bounds.map((b) => b.bot));
      if (top < vy || bot > vy + vh) {
        const pad = 8;
        svgEl.setAttribute("viewBox", `${vx} ${Math.floor(top - pad)} ${vw} ${Math.ceil(bot - top + pad * 2)}`);
      }
    }
  }

  // 5) 圆角：只补没有 rx 的直边矩形；胶囊/菱形用 path 渲染，不受影响。
  for (const rect of document.querySelectorAll("g.node rect.label-container")) {
    if (!rect.getAttribute("rx")) {
      rect.setAttribute("rx", "6");
      rect.setAttribute("ry", "6");
    }
  }

  // 6) 边标签底色合并成一层 <style>。两个约束：
  // 1) 必须 appendChild 到末尾 —— mermaid 自己也用同优先级规则写 #<id> 前缀，
  //    排在它后面才能覆盖（插到最前面会被反向覆盖）。
  // 2) 作用域用 class 而不是 #id —— 一条消息里的每张图根节点都叫 id="local-render"，
  //    内联进宿主文档后 #id 规则会命中所有同 id 元素（实测会串主题），
  //    换成 class 至少把本插件自己的规则关在 .vizcb-mmd 作用域内。
  const POLISH_CLASS = "vizcb-mmd";
  const cls = svgEl.getAttribute("class") || "";
  if (!cls.split(/\s+/).includes(POLISH_CLASS)) {
    svgEl.setAttribute("class", (cls + " " + POLISH_CLASS).trim());
  }
  const sel = "." + POLISH_CLASS;
  const style = document.createElementNS(SVG_NS, "style");
  style.textContent =
    sel + " .flowchart-link{stroke-opacity:.9!important}" +
    sel + " .edgeLabel," + sel + " .edgeLabel p{background-color:transparent!important}" +
    sel + " .edgeLabel rect{fill:transparent!important;opacity:1!important}";
  svgEl.appendChild(style);
}

// ── 节点文本自适应：加宽不足的节点矩形，并同步扩大 viewBox，避免文字溢出边框 ──
// polish=true 时在同一趟解析里顺带做版式重排（省掉一次 jsdom parse+serialize，
// 实测 20KB SVG 上两次解析约 90ms，合并后只多几毫秒）。
export function fitNodesToText(svgText, polish) {
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
  if (polish === true && isFlowchart(svgEl)) polishNodes(document, svgEl);
  try {
    return new doc.window.XMLSerializer().serializeToString(svgEl);
  } catch (e) {
    return svgText;
  }
}

// 独立入口（单测 / 其他宿主复用）：自行解析 → 处理 → 序列化。
export function polishSvgLayout(svgText) {
  if (typeof svgText !== "string" || !svgText.includes("<svg")) return svgText;
  let doc;
  try {
    doc = new JSDOM(svgText, { contentType: "image/svg+xml" });
  } catch (e) {
    return svgText;
  }
  const document = doc.window.document;
  const svgEl = document.documentElement;
  if (isFlowchart(svgEl)) polishNodes(document, svgEl);
  try {
    return new doc.window.XMLSerializer().serializeToString(svgEl);
  } catch (e) {
    return svgText;
  }
}

// ── 增强渲染后 SVG：深色主题提亮文字、连线/箭头换主色，并做节点文本自适应 ──
// textColor / lineColor 由主线程从插件配置里取好传进来（worker 不读配置）。
//
// 连线粗细只能在这里定：mermaid 自己的规则带 #<svgId> 前缀（特异度 1,1,0），
// 后处理注入的 class 规则（0,2,0）即使加 !important 也赢不了 —— !important 只改变
// 「重要性等级」，同一等级内仍比特异度。想改线宽就改这一处，别在下游再写一条覆盖。
export function enhanceSvgVisibility(svg, dark, textColor, lineColor, polish) {
  if (typeof svg !== "string" || !svg.includes("<svg")) return svg;
  const text = textColor || "#E5E7EB";
  const line = lineColor || "#4F8CFF";
  const lineW = polish === true ? "1.4px" : "2.4px";
  const textBoost =
    dark
      ? "#local-render{fill:" + text + "!important}" +
        "#local-render .label{color:" + text + "!important}" +
        "#local-render .cluster-label text{fill:" + text + "!important}" +
        "#local-render .cluster-label span{color:" + text + "!important}" +
        "#local-render .node .label-container{stroke:" + line + "!important;stroke-opacity:.55!important;stroke-width:1.2px!important}"
      : "";
  const boost =
    "<style>" +
    textBoost +
    "#local-render .edgePath .path{stroke:" + line + "!important;stroke-width:" + lineW + "!important}" +
    "#local-render .flowchart-link{stroke:" + line + "!important;stroke-width:" + lineW + "!important}" +
    "#local-render .messageLine0{stroke:" + line + "!important;stroke-width:" + lineW + "!important}" +
    "#local-render .messageLine1{stroke:" + line + "!important;stroke-width:" + lineW + "!important}" +
    "#local-render .actor-line{stroke:" + line + "!important;stroke-width:1.6px!important}" +
    "#local-render .arrowheadPath{fill:" + line + "!important}" +
    "#local-render .marker{fill:" + line + "!important;stroke:" + line + "!important}" +
    "#local-render-arrowhead path{fill:" + line + "!important;stroke:" + line + "!important}" +
    "#local-render .edgeLabel{background-color:transparent!important}" +
    "#local-render .edgeLabel p{color:" + text + "!important}" +
    "</style>";
  let out = svg;
  const open = out.indexOf("<svg");
  const close = out.indexOf(">", open) + 1;
  if (close > open) out = out.slice(0, close) + boost + out.slice(close);
  // 箭头 marker 放大 1.5 倍
  out = out.replace(/(marker(?:Width|Height)=")([\d.]+)(")/g, (m, pre, num, post) => pre + (Math.round(parseFloat(num) * 1.5 * 10) / 10) + post);
  // 节点文本自适应（扩宽矩形 + viewBox），polish 时同一趟解析里顺带做版式重排
  return fitNodesToText(out, polish === true);
}
