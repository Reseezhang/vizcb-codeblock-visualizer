// vizcb-codeblock-visualizer - 版式后处理（polish）的规则版本号。
//
// 为什么单独一个零依赖文件：POLISH_VERSION 要进 lib/index.js（宿主主线程）的
// 渲染缓存 key，而规则实现在 lib/svg-dom.mjs —— 那个模块顶层 import jsdom。
// 主线程若从 svg-dom.mjs 取值，等于把 jsdom 拖进主线程的模块图，DSH 0.2.0-rc.2
// 上插件会整体 import 失败（见 svg-dom.mjs 顶部注释、test/index.test.mjs 的回归断言）。
//
// 约定：改动 svg-dom.mjs 里 polishNodes 的任何规则，都要递增这里的版本号，
// 否则老缓存会绕过新规则，出现「同一张图新旧两种版式」的半新半旧状态。
export const POLISH_VERSION = 2;
