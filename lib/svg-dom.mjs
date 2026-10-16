// vizcb-codeblock-visualizer - 需要 DOM 的宿主端任务（消毒 / 节点自适应 / 配色增强）。
//
// 【重要】本模块 import jsdom（CJS 包）。它只能被 worker 线程 import，绝不能被
// lib/index.js（宿主主线程）直接或间接 import —— DSH 0.2.0-rc.2 在解析 profile
// 插件引用的 CJS 依赖时，会在 ResolutionRouter.routeScoped 抛
//   TypeError: createRequire.resolve.paths is not a function or its return value is not iterable
// 于是插件的整次 import 失败，宿主只留下一句 "failed to import"（详见 DEVELOPMENT.md）。
// worker 线程走的是自己的 loader，没有宿主那层解析钩子，jsdom 在那边完全正常。
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

// ── 节点文本自适应：加宽不足的节点矩形，并同步扩大 viewBox，避免文字溢出边框 ──
export function fitNodesToText(svgText) {
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

// ── 增强渲染后 SVG：深色主题提亮文字、连线/箭头换主色，并做节点文本自适应 ──
// textColor / lineColor 由主线程从插件配置里取好传进来（worker 不读配置）。
export function enhanceSvgVisibility(svg, dark, textColor, lineColor) {
  if (typeof svg !== "string" || !svg.includes("<svg")) return svg;
  const text = textColor || "#E5E7EB";
  const line = lineColor || "#4F8CFF";
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
    "#local-render .edgePath .path{stroke:" + line + "!important;stroke-width:2.4px!important}" +
    "#local-render .flowchart-link{stroke:" + line + "!important;stroke-width:2.4px!important}" +
    "#local-render .messageLine0{stroke:" + line + "!important;stroke-width:2.4px!important}" +
    "#local-render .messageLine1{stroke:" + line + "!important;stroke-width:2.4px!important}" +
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
  // 节点文本自适应（扩宽矩形 + viewBox）
  return fitNodesToText(out);
}
