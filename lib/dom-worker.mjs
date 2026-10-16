// vizcb-codeblock-visualizer - 宿主端消毒 worker（只做 SVG 消毒，不碰 mermaid）。
//
// 为什么单独一条线程：模型输出的 ```svg 代码块在返回客户端之前必须经 DOMPurify
// 消毒，而 DOMPurify 需要一个 DOM（jsdom）；jsdom 一旦出现在宿主主线程，DSH 的
// 模块解析路由器就会崩掉、插件整体 import 失败（见 DEVELOPMENT.md 的教训）。
// 这条线程与 mermaid 渲染线程分开，是为了让 read-turn 的消毒不必排在
// （可能长达几十秒的）mermaid 渲染后面。
import { parentPort } from "node:worker_threads";
import { sanitizeSvgText } from "./svg-dom.mjs";

parentPort.on("message", (msg) => {
  try {
    parentPort.postMessage({ id: msg.id, text: sanitizeSvgText(msg.text) });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: String((e && e.message) || e).split("\n").slice(0, 4).join(" | ") });
  }
});
