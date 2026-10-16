// vizcb-codeblock-visualizer - 客户端渲染行为测试（v1.7.0 呈现层）。
//
// 为什么需要这组测试：
//   ① 流式中间态（开了没关）误判为闭合 → 源码被提前藏掉，只剩半截
//   ② 宿主解析不出块（渲染失败/被禁用/超限）时不还原 → 退化成 v1.6.2「藏了没图」的空白
//   ③ 无门控显示骨架 → 纯文字消息也顶出一块占位
//   ④ 误藏普通代码块（对账失败时必须放弃隐藏，而不是硬按序号藏）
//
// 关键前提：DOM 按宿主渲染器的**真实结构**造。CodeBlock 输出的是
//   div.md-code-block > div[data-code-block-banner] > div.infostring(mermaid)
//                    > div[data-code-block-content] > pre > code
// 它除了「空围栏」以外**从不**输出 `language-*` 类——v1.6.1~1.6.10 的隐藏逻辑
// 就是被这一点废掉的（选择器永远匹配不到）。测试必须复刻这个结构，否则测的是空气。
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = readFileSync(join(HERE, "..", "lib", "client.js"), "utf8");

// jsdom 解析：优先仓库本地 node_modules（CI 会 npm install），否则退回已安装的
// DSH profile 插件里的依赖（本地开发没装 node_modules 时也能跑）。
// 走 createRequire 而非 import：jsdom 是 CJS，其传递依赖靠 require 的向上查找链，
// NODE_PATH 能让这条链指到「提升后的兄弟依赖」所在目录。
const require_ = createRequire(import.meta.url);
const JSMAIN = (() => {
	const candidates = [
		{ pkg: join(HERE, "..", "node_modules", "jsdom", "package.json"), host: join(HERE, "..", "node_modules") },
		{ pkg: join(process.env.USERPROFILE || "", ".dsh", "profiles", "desktop", "node_modules", "vizcb-codeblock-visualizer", "node_modules", "jsdom", "package.json"), host: join(process.env.USERPROFILE || "", ".dsh", "profiles", "desktop", "node_modules", "vizcb-codeblock-visualizer", "node_modules") },
	];
	for (const c of candidates) {
		if (!c.pkg || !existsSync(c.pkg)) continue;
		const pkg = JSON.parse(readFileSync(c.pkg, "utf8"));
		const entry = resolve(dirname(c.pkg), pkg.main || "lib/api.js");
		if (!existsSync(entry)) continue;
		// 传递依赖是否可从宿主 node_modules 解析（profile 布局里它们是提升的兄弟目录）
		try {
			require_.resolve("@asamuzakjp/css-color/package.json", { paths: [c.host] });
		} catch (e) {
			const prev = process.env.NODE_PATH || "";
			process.env.NODE_PATH = prev ? prev + ";" + c.host : c.host;
			(require_("node:module").Module || {})._initPaths?.();
		}
		return entry;
	}
	throw new Error("找不到可用的 jsdom：请在仓库根目录执行 npm install");
})();
const JSDOM = (() => {
	const mod = require_(JSMAIN);
	return mod.JSDOM || (mod.default && mod.default.JSDOM);
})();
assert.ok(typeof JSDOM === "function", "jsdom 未加载成功");

// ── 极简 React 替身：只为驱动函数组件的 hook 生命周期 ────────────────
function createReactStub() {
	let store = { hooks: [], idx: 0, pending: false, root: null, container: null, effects: [] };
	let rerender = null;

	function invalidate() {
		if (store.pending) return;
		store.pending = true;
		queueMicrotask(() => {
			store.pending = false;
			rerender();
		});
	}

	const react = {
		createElement(type, props, ...children) {
			const p = props ? { ...props } : {};
			if (children.length > 0) p.children = children.length === 1 ? children[0] : children;
			return { __el: true, type: type, props: p };
		},
		Fragment: "__Fragment__",
		useState(init) {
			const i = store.idx++;
			if (!store.hooks[i]) store.hooks[i] = { value: init, deps: undefined, cleanup: null };
			const h = store.hooks[i];
			const setter = (v) => {
				if (h.value === v) return;
				h.value = v;
				invalidate();
			};
			return [h.value, setter];
		},
		useRef(init) {
			const i = store.idx++;
			if (!store.hooks[i]) store.hooks[i] = { value: { current: init === undefined ? null : init }, deps: undefined, cleanup: null };
			return store.hooks[i].value;
		},
		useEffect(fn, deps) {
			const i = store.idx++;
			if (!store.hooks[i]) store.hooks[i] = { deps: undefined, cleanup: null };
			const h = store.hooks[i];
			const changed = deps === undefined || !h.deps || deps.length !== h.deps.length || deps.some((d, k) => d !== h.deps[k]);
			if (!changed) return;
			h.deps = deps ? deps.slice() : undefined;
			// 同一代 render 里重复注册（同一 hook 位）时后注册的胜出
			const existing = store.effects.findIndex((e) => e.h === h);
			if (existing !== -1) store.effects.splice(existing, 1);
			store.effects.push({ h: h, fn: fn });
		},
	};

	function renderTree(el, domNode, topLevel) {
		if (el === null || el === undefined || el === false || el === true) return;
		if (Array.isArray(el)) { for (const c of el) renderTree(c, domNode, topLevel); return; }
		if (!el.__el) { domNode.appendChild(document.createTextNode(String(el))); return; }
		if (typeof el.type === "function") {
			// 每个组件实例用自己的 hook 存储 + 自己的游标；父组件的 hooks/游标原样恢复。
			// （早期写法把子组件的空 hooks 写回父组件，导致父组件状态被清空。）
			const outer = store;
			const sub = { hooks: [], idx: 0, pending: false, effects: [] };
			store = sub;
			const out = el.type(el.props || {});
			store = outer;
			outer.idx = sub.idx;
			for (const e of sub.effects) if (!outer.effects.includes(e)) outer.effects.push(e);
			renderTree(out, domNode, false);
			return;
		}
		const node = document.createElement(String(el.type));
		const p = el.props || {};
		for (const k of Object.keys(p)) {
			if (k === "children" || k === "key") continue;
			if (k === "ref") { if (typeof p[k] === "function") p[k](node); else if (p[k]) p[k].current = node; continue; }
			if (k === "style" && p[k] && typeof p[k] === "object") { for (const s of Object.keys(p[k])) node.style[s] = p[k][s]; continue; }
			if (k === "dangerouslySetInnerHTML") { node.innerHTML = p[k].__html; continue; }
			if (/^on[A-Z]/.test(k)) continue;
			if (p[k] === null || p[k] === undefined || p[k] === false) continue;
			node.setAttribute(k === "className" ? "class" : k, String(p[k]));
		}
		domNode.appendChild(node);
		const kids = p.children;
		if (kids !== undefined && kids !== null) (Array.isArray(kids) ? kids : [kids]).forEach((c) => renderTree(c, node, false));
	}

	return {
		react: react,
		reactDom: { createPortal: (node) => node },
		setRoot(rootEl, container) {
			store.root = rootEl;
			store.container = container;
			rerender = () => { if (store.container) renderTree(store.root, store.container, true); };
		},
		render() {
			store.idx = 0;
			store.effects = [];
			store.container.innerHTML = "";
			renderTree(store.root, store.container, true);
			const effects = store.effects;
			store.effects = [];
			for (const e of effects) {
				const r = e.fn();
				if (typeof r === "function") e.h.cleanup = r;
			}
		},
	};
}

// ── 按宿主真实结构造一个代码块 ──────────────────────────────────────
// lang 为 null 时造「普通代码块」（无横幅语言标签），用于验证不会误藏。
function fenceDom(lang, code, opts) {
	const o = opts || {};
	const banner = lang === null ? "" : '<div data-code-block-banner="true"><div class="infostring">' + lang + "</div></div>";
	const body = '<pre class="shiki css-variables"><code>' + (o.closeFence === false ? code : code + "\n```") + "</code></pre>";
	return '<div class="md-code-block"><div class="cssXYZ_block">' + banner + '<div data-code-block-content="true">' + body + "</div></div></div>";
}
function fencedBlock(lang, code, opts) {
	return fenceDom(lang, "```" + (lang === null ? "" : lang) + "\n" + code, opts);
}

function messageHtml(inner) {
	return '<div class="flowitem"><div class="column"><div class="msg">' + inner + '</div></div><div class="tail"></div></div>';
}

function mount(inner, opts) {
	const options = opts || {};
	const dom = new JSDOM("<!doctype html><html><body>" + messageHtml(inner) + "</body></html>", { pretendToBeVisual: true });
	const win = dom.window;
	const doc = win.document;
	// 替身渲染器用的是 Node 侧的全局 document，指向本用例的 jsdom（测试串行执行，不互相干扰）
	globalThis.document = doc;
	globalThis.window = win;
	globalThis.MutationObserver = win.MutationObserver;
	win.__VIZCB_CONFIG__ = { hideSourceBlocks: options.hideSourceBlocks !== false, retryDelaysMs: [50, 100], retryGiveUpMs: 150 };

	const stub = createReactStub();
	const fetchCalls = [];
	const timers = [];
	const realSetTimeout = win.setTimeout.bind(win);
	let turnAnswer = options.answer || { blocks: [], reason: "no-text" };
	win.fetch = (url) => {
		fetchCalls.push(url);
		const answer = url === "/vizcb/read-turn" ? (typeof turnAnswer === "function" ? turnAnswer() : turnAnswer) : "<svg></svg>";
		return Promise.resolve({
			ok: true,
			json: () => Promise.resolve(answer),
			text: () => Promise.resolve(typeof answer === "string" ? answer : JSON.stringify(answer)),
		});
	};
	win.setTimeout = function (fn, delay) { timers.push(delay); return realSetTimeout(fn, delay); };

	let factory = null;
	const sandbox = {
		window: win, document: doc, console, setTimeout: win.setTimeout, clearTimeout: win.clearTimeout.bind(win),
		fetch: win.fetch, MutationObserver: win.MutationObserver, requestAnimationFrame: win.requestAnimationFrame.bind(win),
		Promise, Symbol, Object, Array, String, Number, JSON, Map, Set, Math, Date, Error, RegExp, isNaN, parseInt,
		queueMicrotask: (f) => queueMicrotask(f),
	};
	sandbox.globalThis = sandbox;
	sandbox.__ModuleLoader__ = { load: (def) => { factory = def.factory; } };
	win.__ModuleLoader__ = sandbox.__ModuleLoader__;
	vm.createContext(sandbox);
	vm.runInContext(CLIENT_SRC, sandbox, { filename: "client.js" });
	assert.ok(typeof factory === "function", "client.js 应通过 __ModuleLoader__ 暴露 factory");

	const mod = factory((name) => {
		if (name === "react") return stub.react;
		if (name === "react-dom") return stub.reactDom;
		throw new Error("unexpected require: " + name);
	});
	let registered = null;
	mod.apply({
		slots: { inject: (slot, cb) => cb(), register: (meta, component) => { registered = { meta, component }; } },
		get: () => null,
	});
	assert.ok(registered, "应注册 conversation.chat.turnTail 插槽");

	const tail = doc.querySelector(".tail");
	const el = stub.react.createElement(registered.component, { seq: 7, sessionId: "s1", locale: null });
	stub.setRoot(el, tail);
	stub.render();

	return {
		win, doc, tail, stub, fetchCalls, timers,
		setAnswer(a) { turnAnswer = a; },
		tick: () => stub.render(),
		sleep: (ms) => new Promise((r) => realSetTimeout(r, ms)),
		hidden: () => Array.from(doc.querySelectorAll(".md-code-block")).map((b) => b.style.display === "none"),
	};
}

const MERMAID_OK = { blocks: [{ lang: "mermaid", code: "graph TD\n  A --> B", title: null }], reason: null };

// 说明：本文件只断言「替身渲染器能可靠观察到的 DOM 行为」——发现/隐藏/还原围栏、
// 不误藏普通代码块、骨架不误现。以下三项不在替身里断言，改由真机 + host 单测覆盖：
//   ① 骨架 → 淡入成品的状态流转（依赖真 React 的 state 重渲染）
//   ② 宿主无块时还原源码（同上）
//   ③ 重试阶梯的生效值（由 lib/index.js 的 DEFAULTS / injectBootGlobals 单测覆盖）
// 这些确实是我这个自造替身的短板，不是刻意回避：它连 useState 的重渲染都不保证。

test("流式中间态（开了没关）：不隐藏源码、不显示骨架", async () => {
	const env = mount(fencedBlock("mermaid", "graph TD", { closeFence: false }), { answer: { blocks: [], reason: "no-text" } });
	const blockOf = () => env.doc.querySelector(".md-code-block");
	const first = blockOf();
	const code = env.doc.querySelector("code");
	await env.sleep(30);
	env.tick();
	assert.equal(blockOf(), first, "源码节点不应被重建（否则测不出 observer 的补隐藏）");
	assert.notEqual(blockOf().style.display, "none", "围栏未闭合时源码必须保留");
	assert.equal(env.tail.querySelector(".dsh-viz-skeleton"), null, "未闭合时不应顶出骨架");
	// 闭围栏到达：在微任务里改 DOM，让 MutationObserver 拿到机会触发 → 补隐藏
	await new Promise((r) => queueMicrotask(() => { code.textContent = code.textContent + "\n```"; r(); }));
	await env.sleep(40);
	assert.ok(String(blockOf().textContent).includes("```mermaid"), "文本应已更新");
	env.tick();
	await env.sleep(20);
	assert.equal(blockOf().style.display, "none", "闭合后应隐藏源码");
});

test("普通代码块（非本插件语言）：源码永不被隐藏", async () => {
	const env = mount(fencedBlock(null, "const a = 1;"), { answer: { blocks: [], reason: "none" } });
	await env.sleep(30);
	env.tick();
	await env.sleep(40);
	const block = env.doc.querySelector(".md-code-block");
	assert.notEqual(block.style.display, "none", "普通代码块绝不能被误藏");
	assert.equal(env.tail.querySelector(".dsh-viz-skeleton"), null, "普通代码块不应顶出骨架");
});

test("纯文字消息：不显示骨架", async () => {
	const env = mount("<p>这是一段没有任何图表的回复。</p>", { answer: { blocks: [], reason: "none" } });
	await env.sleep(60);
	env.tick();
	await env.sleep(20);
	assert.equal(env.tail.querySelector(".dsh-viz-skeleton"), null, "纯文字消息不应顶出骨架");
});

test("对账失败（宿主跳过了中间块）：宁可不隐藏，也不误藏普通代码块", async () => {
	// DOM：mermaid 块 + javascript 块；宿主只解析出 mermaid（javascript 被超限跳过）
	const env = mount(
		fencedBlock("mermaid", "graph TD\n  A --> B") + fencedBlock(null, "const a = 1;"),
		{ answer: { blocks: [], reason: "no-text" } },
	);
	env.setAnswer({ blocks: [{ lang: "mermaid", code: "graph TD\n  A --> B", title: null }], reason: null });
	await env.sleep(60);
	const blocks = Array.from(env.doc.querySelectorAll(".md-code-block"));
	assert.equal(blocks[0].style.display, "none", "对上的 mermaid 块应隐藏");
	assert.notEqual(blocks[1].style.display, "none", "对不上的普通代码块必须保留");
});

test("hideSourceBlocks 关闭：不动源码", async () => {
	const env = mount(fencedBlock("mermaid", "graph TD"), { hideSourceBlocks: false, answer: MERMAID_OK });
	const block = env.doc.querySelector(".md-code-block");
	await env.sleep(60);
	env.tick();
	assert.notEqual(block.style.display, "none", "配置关闭时绝不能隐藏源码");
});
