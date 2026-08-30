// vizcb-codeblock-visualizer - mermaid 渲染 worker。
// 在独立 worker_threads 里跑 mermaid + svgdom，避免把假 window/document
// 注入宿主进程的 globalThis（防止污染其他插件与宿主环境判断）。
import { parentPort } from "node:worker_threads";
import { createHTMLWindow } from "svgdom";
import mermaid from "mermaid";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

let ready = false;

function ensureReady() {
  if (ready) return;
  // mermaid 内部 import 的 `dompurify` 默认导出即 createDOMPurify 函数对象；
  // 在 Node 环境（无 window）下它的 .sanitize 是"需要 window"的占位实现。
  // 这里生成一个绑定到 JSDOM window 的实例，并把其实例方法拷回默认导出函数，
  // 使 mermaid 在 strict 模式下调用 DOMPurify.sanitize 时能正常消毒。
  // 当前 worker 固定 securityLevel="loose"（消毒在宿主主线程做），该绑定属防御性保留。
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
  ready = true;
}

parentPort.on("message", async (msg) => {
  try {
    ensureReady();
    mermaid.initialize({
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      startOnLoad: false,
      securityLevel: "loose",
      ...(msg.dark ? { theme: "dark" } : { theme: "default" }),
    });
    const { svg } = await mermaid.render("local-render", msg.code);
    parentPort.postMessage({ id: msg.id, svg });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: String((e && e.message) || e).split("\n").slice(0, 4).join(" | ") });
  }
});
