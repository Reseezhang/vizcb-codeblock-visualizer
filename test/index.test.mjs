// vizcb-codeblock-visualizer - node --test 冒烟测试。
// 运行：npm install && node --test test/
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  resolveConfig,
  analyzeBlocks,
  sanitizeSvgText,
  renderMermaidCached,
  estimateLabelWidth,
  extractTitle,
  extractEventText,
  decodeBase64Url,
  parsePresentDirective,
  extractPresentDirectives,
  resolvePresentedPath,
  buildFiles,
  langOfExt,
  handlePreviewFileRequest,
  injectBootGlobals,
  shutdownMermaidWorker,
  PLUGIN_VERSION,
} from "../lib/index.js";

// 版本断言不硬编码字面量：每次发版必然失效（曾断言 1.6.9，实际已 1.6.10）。
// 改为与独立读取的 package.json 版本比对，并校验形状。
const pkgVersion = createRequire(import.meta.url)("../package.json").version;

after(() => { shutdownMermaidWorker(); }); // 终止 worker，让测试进程正常退出

test("version reads package.json", () => {
  assert.equal(PLUGIN_VERSION, pkgVersion);
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+/);
});

test("config defaults", () => {
  const cfg = resolveConfig({});
  assert.equal(cfg.maxBlocks, 8);
  assert.equal(cfg.debugLog, false);
  assert.equal(cfg.canvasBg, "#0F172A");
  assert.equal(cfg.mermaidRateMax, 30);
  assert.equal(cfg.previewEnabled, true);
  assert.equal(cfg.previewMaxBytes, 5 * 1024 * 1024);
  assert.equal(cfg.hideSourceBlocks, true);
});

test("v1.7.0 重试契约：退避阶梯 + 放弃时限下发到客户端", () => {
  const cfg = resolveConfig({});
  // 阶梯首项必须远小于旧的固定 2000ms（流式场景下首屏等待主要来自这里）
  assert.ok(Array.isArray(cfg.retryDelaysMs) && cfg.retryDelaysMs.length > 0);
  assert.ok(cfg.retryDelaysMs[0] < 2000, "阶梯首项应远小于 2000ms，实际 " + cfg.retryDelaysMs[0]);
  assert.equal(cfg.retryGiveUpMs, 6000);
  // 阶梯应单调不减，否则末位兜底会来回跳
  for (let i = 1; i < cfg.retryDelaysMs.length; i++) {
    assert.ok(cfg.retryDelaysMs[i] >= cfg.retryDelaysMs[i - 1]);
  }
  const boot = JSON.parse(/window\.__VIZCB_CONFIG__=(\{.*?\})<\/script>/s.exec(injectBootGlobals("<body></body>", cfg))[1]);
  assert.deepEqual(boot.retryDelaysMs, cfg.retryDelaysMs);
  assert.equal(boot.retryGiveUpMs, cfg.retryGiveUpMs);
  // 默认不下发旧的 retryDelayMs：否则客户端会当作用户显式配置，把退避阶梯一直挡住
  assert.equal(boot.retryDelayMs, undefined);
  assert.equal(boot.hideSourceBlocks, true);
});

test("v1.7.0 重试契约：用户显式配 retryDelayMs 时按固定间隔下发（兼容老配置）", () => {
  const cfg = resolveConfig({ retryDelayMs: 1500 });
  cfg.retryDelayMsExplicit = 1500; // apply() 里做的来源判定
  const boot = JSON.parse(/window\.__VIZCB_CONFIG__=(\{.*?\})<\/script>/s.exec(injectBootGlobals("<body></body>", cfg))[1]);
  assert.equal(boot.retryDelayMs, 1500);
});

test("analyzeBlocks extracts svg block with title", () => {
  const cfg = resolveConfig({});
  const text = "前言\n\n```svg 架构图\n<svg viewBox=\"0 0 200 100\"><rect x=\"10\" y=\"10\" width=\"180\" height=\"80\" rx=\"8\"/></svg>\n```\n\n结尾";
  const out = analyzeBlocks(text, cfg);
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].lang, "svg");
  assert.equal(out.blocks[0].title, "前言");
});

test("extractEventText reconstructs fences for structured code blocks", () => {
  const text = extractEventText({
    data: { message: { content: [
      { type: "text", text: "前言" },
      { type: "code", language: "mermaid", text: "graph TD\n  A --> B" },
      { type: "code", lang: "svg", text: "<svg viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\"/></svg>" },
      { type: "code", language: "lua", text: "local x = 1" }, // 非图表语言不动
    ] } },
  });
  assert.ok(text.includes("```mermaid"), "mermaid fence reconstructed");
  assert.ok(text.includes("```svg"), "svg fence reconstructed");
  const out = analyzeBlocks(text, resolveConfig({}));
  assert.deepEqual(out.blocks.map((b) => b.lang), ["mermaid", "svg"]);
});

test("extractEventText keeps raw fenced text as-is", () => {
  const text = extractEventText({ data: { message: { content: ["前言\n\n```mermaid\ngraph TD;A-->B\n```"] } } });
  assert.ok(text.includes("```mermaid"));
  assert.equal(analyzeBlocks(text, resolveConfig({})).blocks.length, 1);
});

test("mermaid dialect aliases normalize to mermaid", () => {
  const cfg = resolveConfig({});
  const out = analyzeBlocks("```flowchart\nA-->B\n```", cfg);
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].lang, "mermaid");
});

test("sanitizeSvgText strips script/onload/javascript:", async () => {
  const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect onload="evil()" x="0" y="0" width="10" height="10"/><a href="javascript:alert(2)"><text>hi</text></a></svg>';
  const clean = await sanitizeSvgText(dirty);
  assert.ok(!/<script/i.test(clean));
  assert.ok(!/onload/i.test(clean));
  assert.ok(!/javascript:/i.test(clean));
  assert.ok(clean.includes("<svg"));
});

test("host main-thread module never imports jsdom/dompurify", async () => {
  // 回归防线：DSH 0.2.0-rc.2 解析 profile 插件引用的 CJS 依赖（jsdom）时会在
  // ResolutionRouter.routeScoped 抛 "createRequire.resolve.paths is not a function"，
  // 插件的整次 import 失败，宿主只报 "failed to import"。所以 lib/index.js（主线程入口）
  // 必须与 jsdom/DOMPurify 彻底隔离，需要 DOM 的活儿一律放 worker（lib/svg-dom.mjs）。
  const src = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.ok(!/from\s+["']jsdom["']/.test(src), "lib/index.js 不得静态 import jsdom");
  assert.ok(!/import\s*\(\s*["']jsdom["']\s*\)/.test(src), "lib/index.js 不得动态 import jsdom");
  assert.ok(!/from\s+["']dompurify["']/.test(src), "lib/index.js 不得 import dompurify");
  const domWorkerSrc = await readFile(new URL("../lib/svg-dom.mjs", import.meta.url), "utf8");
  assert.match(domWorkerSrc, /from\s+["']jsdom["']/, "svg-dom.mjs 才是 jsdom 的容身处");
});

test("renderMermaidCached renders, caches and dedups in-flight", async () => {
  const cfg = resolveConfig({});
  const diagram = "graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[通过]\n  B -->|否| D[重试]";
  const svg = await renderMermaidCached(diagram, true, cfg);
  assert.ok(typeof svg === "string" && svg.includes("<svg"));
  assert.ok(!/<script/i.test(svg));
  const cached = await renderMermaidCached(diagram, true, cfg);
  assert.equal(cached, svg); // 缓存命中
  const [a, b] = await Promise.all([renderMermaidCached(diagram, false, cfg), renderMermaidCached(diagram, false, cfg)]);
  assert.equal(a, b); // 同 key 在途去重
  assert.notEqual(a, svg); // 不同主题缓存分离
});

test("worker survives a bad diagram", async () => {
  const cfg = resolveConfig({});
  const diagram = "graph TD\n  A --> B";
  const good = await renderMermaidCached(diagram, false, cfg);
  await assert.rejects(() => renderMermaidCached("this is not a diagram at all", false, cfg));
  const again = await renderMermaidCached(diagram, false, cfg);
  assert.equal(again, good);
});

test("pure helpers", () => {
  assert.ok(estimateLabelWidth("开始", 16) > 20);
  assert.equal(extractTitle("标题\n\n```svg\nx\n```", 4), "标题");
  assert.equal(decodeBase64Url(Buffer.from("graph TD;A-->B").toString("base64url")), "graph TD;A-->B");
});

// ── present-files（可预览文件）──────────────────────────────────────

test("parsePresentDirective handles list markers/comments/blank lines", () => {
  const dir = "# 说明注释\n\n- report.html\n  - ../outside.html\n\n* assets/logo.png\nC:\\abs\\file.txt\n";
  const paths = parsePresentDirective(dir);
  assert.deepEqual(paths, ["report.html", "../outside.html", "assets/logo.png", "C:\\abs\\file.txt"]);
});

test("extractPresentDirectives finds present-files fences at line start", () => {
  const text = "回复内容\n\n```present-files\n- report.html\n- result.png\n```\n\n结束";
  const paths = extractPresentDirectives(text);
  assert.deepEqual(paths, ["report.html", "result.png"]);
  // 不在行首的围栏不识别
  assert.deepEqual(extractPresentDirectives("文字```present-files\nx\n```"), []);
});

test("resolvePresentedPath enforces workspace containment", () => {
  const root = path.resolve("C:/ws");
  const inside = resolvePresentedPath("sub/report.html", root);
  assert.ok(inside.inside);
  assert.equal(inside.rel, path.join("sub", "report.html"));
  const outside = resolvePresentedPath("../secret.txt", root);
  assert.equal(outside.inside, false);
  const absOutside = resolvePresentedPath(path.resolve("D:/other/evil.html"), root);
  assert.equal(absOutside.inside, false);
  assert.equal(resolvePresentedPath("", root), null);
});

test("langOfExt buckets file types", () => {
  assert.equal(langOfExt(".html"), "html");
  assert.equal(langOfExt(".PNG"), "image");
  assert.equal(langOfExt(".css"), "css");
  assert.equal(langOfExt(".js"), "js");
  assert.equal(langOfExt(".md"), "text");
  assert.equal(langOfExt(".exe"), "other");
});

test("buildFiles validates real files inside workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vizcb-test-"));
  try {
    await writeFile(path.join(root, "report.html"), "<h1>hi</h1>");
    await writeFile(path.join(root, "logo.png"), "PNG");
    await writeFile(path.join(root, "secret.txt"), "top secret");
    const { items, invalid } = await buildFiles(
      ["report.html", "missing.html", "../secret.txt", "logo.png"],
      resolveConfig({ maxFiles: 12 }),
      root,
    );
    assert.deepEqual(items.map((i) => i.rel), ["report.html", "logo.png"]);
    assert.equal(items[0].lang, "html");
    assert.equal(items[1].lang, "image");
    assert.deepEqual(invalid.map((i) => i.reason), ["not-found", "outside-workspace"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handlePreviewFileRequest serves contained files and blocks traversal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vizcb-test-"));
  const token = "tok-abc123";
  const cfg = resolveConfig({ previewMaxBytes: 1024 * 1024 });
  const server = http.createServer((req, res) => {
    handlePreviewFileRequest(req, res, cfg, root, token).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    await writeFile(path.join(root, "a b.html"), "<html>hello</html>");
    await writeFile(path.join(root, "secret.txt"), "top secret");
    const rel = encodeURIComponent("a b.html");
    const res = await fetch(base + "/vizcb/p/" + token + "/" + rel);
    assert.equal(res.status, 200);
    assert.equal((await res.text()).trim(), "<html>hello</html>");
    // meta 轮询
    const meta = await (await fetch(base + "/vizcb/p/" + token + "/meta?p=" + encodeURIComponent("a b.html"))).json();
    assert.equal(meta.exists, true);
    assert.ok(meta.mtimeMs > 0);
    assert.equal(meta.size, "<html>hello</html>".length);
    // 越界（编码后的 ../）必须被拒
    const trav = await fetch(base + "/vizcb/p/" + token + "/..%2Fsecret.txt");
    assert.equal(trav.status, 403);
    // 错误 token
    const badToken = await fetch(base + "/vizcb/p/wrong-token/secret.txt");
    assert.equal(badToken.status, 403);
    // 不存在文件
    const missing = await fetch(base + "/vizcb/p/" + token + "/nope.html");
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});

test("handlePreviewFileRequest enforces size cap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vizcb-test-"));
  const token = "tok-size";
  const cfg = resolveConfig({ previewMaxBytes: 32 });
  const server = http.createServer((req, res) => {
    handlePreviewFileRequest(req, res, cfg, root, token).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    await writeFile(path.join(root, "big.html"), "x".repeat(100));
    const res = await fetch(base + "/vizcb/p/" + token + "/big.html");
    assert.equal(res.status, 413);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});
