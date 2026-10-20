// vizcb-codeblock-visualizer - mermaid 渲染 + 收尾 worker。
// 在独立 worker_threads 里跑 mermaid + svgdom，避免把假 window/document
// 注入宿主进程的 globalThis（防止污染其他插件与宿主环境判断）。
// 渲染后的三步收尾（配色增强 / 节点自适应 / DOMPurify 消毒）也在这里做：
// 它们都需要 jsdom，而 jsdom 绝不能出现在宿主主线程（见 svg-dom.mjs 顶部注释）。
import { parentPort } from "node:worker_threads";
import { createHTMLWindow } from "svgdom";
import mermaid from "mermaid";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { enhanceSvgVisibility, sanitizeSvgText } from "./svg-dom.mjs";

let ready = false;

function ensureReady() {
  if (ready) return;
  // mermaid 内部 import 的 `dompurify` 默认导出即 createDOMPurify 函数对象；
  // 在 Node 环境（无 window）下它的 .sanitize 是"需要 window"的占位实现。
  // 这里生成一个绑定到 JSDOM window 的实例，并把其实例方法拷回默认导出函数，
  // 使 mermaid 在 strict 模式下调用 DOMPurify.sanitize 时能正常消毒。
  // 当前 worker 固定 securityLevel="loose"（消毒在渲染收尾时由 svg-dom.mjs 做），
  // 该绑定属防御性保留。
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
    // polish 关闭时必须连渲染参数一起退回默认，否则「置 false 一键回滚」只是
    // 关掉了后处理，字号/字体栈/间距/曲线还在悄悄变 —— 回滚对不齐，出问题时
    // 就无法用它做 A/B 定位。mermaid.initialize 每次都会把 siteConfig 从
    // defaultConfig 重置再合并，所以这里省略 themeVariables 是安全的，不会残留。
    const polish = msg.polish !== false;
    mermaid.initialize({
      htmlLabels: false,
      flowchart: polish
        ? {
            htmlLabels: false,
            // 曲线与间距：basis 比默认插值更平滑；nodeSpacing/rankSpacing 拉大后
            // 分支之间留白更足。padding 别给太大 —— 单行节点会被撑成 50px 高的空框。
            curve: "basis",
            nodeSpacing: 45,
            rankSpacing: 55,
            padding: 10,
          }
        : { htmlLabels: false },
      startOnLoad: false,
      securityLevel: "loose",
      ...(msg.dark ? { theme: "dark" } : { theme: "default" }),
      // themeVariables 在 dark/default 下同样生效（mermaid 11.17.2 实测），
      // 不要为了改字号切到 theme: "base" —— base 会重置整套配色，classDef 之外的
      // 节点会变灰。字体必须显式给 CJK 字体栈，否则回退到 trebuchet ms，中文由
      // 浏览器兜底，字重与字距跟西文不匹配。
      ...(polish
        ? {
            themeVariables: {
              fontSize: "14px",
              fontFamily: "-apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
              edgeLabelBackground: "transparent",
            },
          }
        : {}),
    });
    const { svg } = await mermaid.render("local-render", msg.code);
    // finish：渲染完直接在 worker 里做完后续三步（配色增强 → 节点自适应/版式重排 → 消毒）。
    // 主线程不再持有 jsdom/DOMPurify，故这些活儿只能在这条线程里收尾。
    const finish = msg.finish;
    const styled = finish ? enhanceSvgVisibility(svg, msg.dark, finish.textColor, finish.lineColor, finish.polish) : svg;
    parentPort.postMessage({ id: msg.id, svg: finish ? sanitizeSvgText(styled) : styled });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: String((e && e.message) || e).split("\n").slice(0, 4).join(" | ") });
  }
});
