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
