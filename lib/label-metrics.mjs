// vizcb-codeblock-visualizer - 纯文本度量（零依赖，不含任何 DOM）。
//
// 为什么单独成一个文件：宿主主线程只要 import jsdom，DSH 的模块解析路由器就会在
// CJS 解析阶段抛 TypeError，插件的整次 import 失败（详见 DEVELOPMENT.md 的教训）。
// 所以 jsdom 只允许出现在 worker 里，而主线程仍需复用这套度量（estimateLabelWidth
// 对外导出、有测试），于是把它放进这个零依赖模块，主线程与 worker 各自 import。

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
