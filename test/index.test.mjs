// vizcb-codeblock-visualizer - node --test 冒烟测试。
// 运行：npm install && node --test test/
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  resolveConfig,
  analyzeBlocks,
  sanitizeSvgText,
  renderMermaidCached,
  estimateLabelWidth,
  extractTitle,
  decodeBase64Url,
  shutdownMermaidWorker,
  PLUGIN_VERSION,
} from "../lib/index.js";

after(() => { shutdownMermaidWorker(); }); // 终止 worker，让测试进程正常退出

test("version reads package.json", () => {
  assert.equal(PLUGIN_VERSION, "1.5.0");
});

test("config defaults", () => {
  const cfg = resolveConfig({});
  assert.equal(cfg.maxBlocks, 8);
  assert.equal(cfg.debugLog, false);
  assert.equal(cfg.canvasBg, "#0F172A");
  assert.equal(cfg.mermaidRateMax, 30);
});

test("analyzeBlocks extracts svg block with title", () => {
  const cfg = resolveConfig({});
  const text = "前言\n\n```svg 架构图\n<svg viewBox=\"0 0 200 100\"><rect x=\"10\" y=\"10\" width=\"180\" height=\"80\" rx=\"8\"/></svg>\n```\n\n结尾";
  const out = analyzeBlocks(text, cfg);
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].lang, "svg");
  assert.equal(out.blocks[0].title, "前言");
});

test("mermaid dialect aliases normalize to mermaid", () => {
  const cfg = resolveConfig({});
  const out = analyzeBlocks("```flowchart\nA-->B\n```", cfg);
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].lang, "mermaid");
});

test("sanitizeSvgText strips script/onload/javascript:", () => {
  const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect onload="evil()" x="0" y="0" width="10" height="10"/><a href="javascript:alert(2)"><text>hi</text></a></svg>';
  const clean = sanitizeSvgText(dirty);
  assert.ok(!/<script/i.test(clean));
  assert.ok(!/onload/i.test(clean));
  assert.ok(!/javascript:/i.test(clean));
  assert.ok(clean.includes("<svg"));
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
