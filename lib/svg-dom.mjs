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
// 算子块居中与图形尺寸，实渲染折成更多行后行与行会叠在一起、末行压出图形。这里在返回
// 客户端前重排一次（纯视觉层，不改布局坐标）：
//   · 节点标签首行 → 主标题（14px / 500），其余行 → 副标题（11.5px / 0.72）
//   · 边标签 → 12px（弱化，不与节点抢注意力）
//   · 按真实行数用像素重算行盒，并把整块文字在图形内垂直居中
//   · 方框补 rx/ry=6 圆角、边标签去底色
//   · 图形装不下文字时把它撑开：矩形直接改宽高；胶囊/菱形/圆柱等改不了路径
//     （mermaid 的 outer-path 是带随机抖动的 rough 路径），按需做非等比缩放
// 注意：连线粗细不在这里改 —— 它由 enhanceSvgVisibility 里那条 #local-render 规则统一
// 产出（class 选择器打不过 #id，见 enhanceSvgVisibility 的注释）。
//
// 只对 flowchart 生效：state / class / ER 的 g.node 结构不同（方框不一定以节点原点为心、
// 有的节点内含属性行），按固定行盒重排会把标题顶到框上沿。
const MAIN_H = 20;   // 主标题行盒
const SUB_H = 17;    // 副标题行盒
const PAD_V = 6;     // 上下内边距（图形已够大时仅作为最小留白）
const PAD_H = 6;     // 左右内边距
const K_MAX = 1.6;   // 图形放大的上限；超出部分改为压小字号

// 根节点上 mermaid 会写 aria-roledescription="flowchart-v2"；老版本只有 class。
function isFlowchart(svgEl) {
  const role = (svgEl.getAttribute("aria-roledescription") || "").toLowerCase();
  if (role.length > 0) return role.startsWith("flowchart");
  return (svgEl.getAttribute("class") || "").toLowerCase().split(/\s+/).includes("flowchart");
}

// 解析 path 的包围盒。mermaid 的图形路径是绝对坐标（含弧与曲线），这里按命令参数
// 逐个推进当前点，取端点/控制点的极值。控制点会略微放大包围盒 —— 我们只用它判断
// 「图形够不够大」，偏大是安全方向（宁可少放大，不会放大过头）。
const PATH_ARITY = { m: 2, l: 2, t: 2, h: 1, v: 1, c: 6, s: 4, q: 4, a: 7, z: 0 };
function pathBox(d) {
  const tokens = String(d).match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
  if (tokens === null) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const put = (px, py) => {
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  };
  let cmd = "";
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) { cmd = tokens[i]; i++; }
    const low = cmd.toLowerCase();
    const ar = PATH_ARITY[low];
    if (ar === undefined) { i++; continue; }
    if (ar === 0) continue; // z / Z
    const nums = tokens.slice(i, i + ar).map(Number);
    if (nums.length < ar || nums.some((v) => !Number.isFinite(v))) { i += ar; continue; }
    i += ar;
    const rel = cmd === low;
    if (low === "h") { x = rel ? x + nums[0] : nums[0]; put(x, y); continue; }
    if (low === "v") { y = rel ? y + nums[0] : nums[0]; put(x, y); continue; }
    if (low === "a") { // 前 5 个是半径/转角/标志位，只有最后两个是端点
      const ex = rel ? x + nums[5] : nums[5];
      const ey = rel ? y + nums[6] : nums[6];
      x = ex; y = ey; put(x, y);
      continue;
    }
    for (let k = 0; k + 1 < nums.length; k += 2) {
      const px = rel ? x + nums[k] : nums[k];
      const py = rel ? y + nums[k + 1] : nums[k + 1];
      put(px, py);
      if (k + 2 >= nums.length) { x = px; y = py; }
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// 非矩形节点的图形盒：{ el(要缩放的元素), w, h, cx, cy, tx, ty }。
// cx/cy 是该元素自身坐标系里的包围盒中心（缩放绕它做），tx/ty 是它自带 transform 的
// 位移 —— 标签行坐标在「节点坐标系」里，所以算行位置要用 cx+tx / cy+ty。
//   · 菱形等 → <polygon class="label-container" points="...">
//   · 胶囊/圆柱等 → <g class="label-container …"><path d="…"/></g> 或 <path class="label-container">
function ownedTranslate(el) {
  const m = (el.getAttribute("transform") || "").match(/translate\(\s*([-\d.]+)[,\s]+([-\d.]+)/);
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 0];
}

function shapeGeom(node) {
  const poly = node.querySelector("polygon.label-container");
  if (poly !== null) {
    const nums = String(poly.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
    if (nums.length < 4) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      minX = Math.min(minX, nums[i]); maxX = Math.max(maxX, nums[i]);
      minY = Math.min(minY, nums[i + 1]); maxY = Math.max(maxY, nums[i + 1]);
    }
    const [tx, ty] = ownedTranslate(poly);
    return { el: poly, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, tx, ty };
  }
  const holder = node.querySelector("g.label-container");
  const el = holder !== null && holder.querySelector("path") !== null ? holder : node.querySelector("path.label-container");
  if (el === null) return null;
  const path = el.tagName.toLowerCase() === "path" ? el : el.querySelector("path");
  const box = pathBox(path.getAttribute("d") || "");
  if (box === null || box.w <= 0 || box.h <= 0) return null;
  const [tx, ty] = ownedTranslate(el);
  return { el, w: box.w, h: box.h, cx: box.cx, cy: box.cy, tx, ty };
}

// 以图形自身中心为原点缩放（保留原 transform 前缀，位置不变）；描边不跟着变粗。
function scaleShape(geom, kx, ky) {
  const r = (v) => Math.round(v * 100) / 100;
  const own = (geom.el.getAttribute("transform") || "").trim();
  const near = Math.abs(geom.cx) < 0.01 && Math.abs(geom.cy) < 0.01;
  const t = near
    ? `scale(${r(kx)},${r(ky)})`
    : `translate(${r(geom.cx)},${r(geom.cy)}) scale(${r(kx)},${r(ky)}) translate(${r(-geom.cx)},${r(-geom.cy)})`;
  geom.el.setAttribute("transform", own.length > 0 ? own + " " + t : t);
  const paths = geom.el.tagName.toLowerCase() === "path" ? [geom.el] : Array.from(geom.el.querySelectorAll("path"));
  for (const p of paths) p.setAttribute("vector-effect", "non-scaling-stroke");
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

  // 3) 垂直重排 + 撑开图形（最关键的一步）。
  //    行盒一律改成绝对像素 y，整块文字落在图形中心；图形装不下就放大
  //    （矩形改宽高，其它形状按需 scale），超出 K_MAX 的那部分靠压字号兜住。
  const bounds = [];
  for (const node of document.querySelectorAll("g.node")) {
    const label = node.querySelector("g.label");
    const text = (label || node).querySelector("text");
    if (text === null) continue;
    const rows = Array.from(text.querySelectorAll("tspan.text-outer-tspan"));
    if (rows.length === 0) continue;
    const rect = node.querySelector("rect.label-container");
    const geom = rect === null ? shapeGeom(node) : null;
    if (rect === null && geom === null) continue; // 结构不认识就不动，免得越改越坏

    // 文字实际需要多大：按真实字号保守估算（CJK 1.05em / ASCII 0.6em）
    let rowFonts = rows.map((_, i) => (i === 0 ? 14 : 11.5));
    let needW = Math.max(0, ...rows.map((r, i) => estimateLabelWidth((r.textContent || "").trim(), rowFonts[i]))) + PAD_H * 2;
    let heights = rows.map((_, i) => (i === 0 ? MAIN_H : SUB_H));
    let contentH = heights.reduce((a, b) => a + b, 0);
    let needH = contentH + PAD_V * 2;
    let kx = 1;
    let ky = 1;

    if (rect === null) {
      let rx = needW / geom.w;
      let ry = needH / geom.h;
      if (rx > K_MAX || ry > K_MAX) {
        // 图形最多放大 K_MAX 倍，剩余差额压字号（行盒同比缩小）
        const shrink = Math.max(rx, ry) / K_MAX;
        for (const row of rows) {
          const inner = Array.from(row.querySelectorAll("tspan.text-inner-tspan"));
          for (const t of inner.length > 0 ? inner : [row]) {
            const cur = parseFloat(t.getAttribute("font-size") || "14");
            t.setAttribute("font-size", String(Math.max(9, Math.round((cur / shrink) * 10) / 10)));
          }
        }
        heights = heights.map((h) => h / shrink);
        contentH = heights.reduce((a, b) => a + b, 0);
        needH = contentH + PAD_V * 2;
        rowFonts = rows.map((r, i) => {
          const inner = r.querySelector("tspan.text-inner-tspan");
          const fs = inner ? parseFloat(inner.getAttribute("font-size") || "") : NaN;
          return Number.isFinite(fs) ? fs : (i === 0 ? 14 : 11.5);
        });
        needW = Math.max(0, ...rows.map((r, i) => estimateLabelWidth((r.textContent || "").trim(), rowFonts[i]))) + PAD_H * 2;
        rx = needW / geom.w;
        ry = needH / geom.h;
      }
      kx = Math.max(1, Math.min(K_MAX, rx));
      ky = Math.max(1, Math.min(K_MAX, ry));
      if (kx > 1.01 || ky > 1.01) scaleShape(geom, kx, ky);
    } else {
      const h = parseFloat(rect.getAttribute("height") || "0");
      if (needH > h) { // 框不够高：补高，中心保持在原位
        rect.setAttribute("height", String(needH));
        rect.setAttribute("y", String(-needH / 2));
      }
    }

    // 行盒：整块文字在图形中心（矩形中心由其 y/height 推出，其它图形用包围盒中心）
    if (label !== null) label.setAttribute("transform", "translate(0, 0)");
    let boxH;
    let centerY;
    if (rect === null) {
      boxH = geom.h * ky;
      centerY = geom.cy + geom.ty; // 行坐标在节点坐标系，要算上图形自带的 translate
    } else {
      const rectY = parseFloat(rect.getAttribute("y") || "0");
      boxH = parseFloat(rect.getAttribute("height") || "0");
      centerY = rectY + boxH / 2;
    }
    let top = centerY - contentH / 2;
    rows.forEach((row, i) => {
      // 行盒内基线；四舍五入到 0.01px，避免 17*0.78 这类浮点尾巴进到 SVG 属性里
      const y = Math.round((top + heights[i] * 0.78) * 100) / 100;
      row.setAttribute("y", String(y));
      row.setAttribute("dy", "0");
      top += heights[i];
    });

    const tym = (node.getAttribute("transform") || "").match(/translate\(\s*[-\d.]+[, ]+([-\d.]+)/);
    const baseY = tym ? parseFloat(tym[1]) : 0;
    bounds.push({ top: baseY + centerY - boxH / 2, bot: baseY + centerY + boxH / 2 });
  }

  // 4) 图形放大后可能顶出画布：按需扩展 viewBox（只改高，宽度由 fitNodesToText 负责）。
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
