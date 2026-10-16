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
	let store = { hooks: [], idx: 0, pending: false, root: null, container: null, effects: [], pendingCleanups: [] };
	// 组件实例的 hook 存储必须跨渲染复用：否则 useState 每次渲染都回到初值（state 永不生效），
	// "确认阶段 / 骨架"这类依赖 state 的路径在替身里根本不可达；子组件的 effect 也会因为 deps
	// 每次都是新的而反复重跑，自动重渲染直接变成死循环。
	// 替身没有真正的实例身份，用「组件函数 + 本次渲染中的第几个实例」当键：树形状稳定它就稳定。
	const instances = new Map();
	let instanceCounters = new Map();
	let renderCount = 0;
	let rerender = null;

	function invalidate() {
		if (store.pending) return;
		store.pending = true;
		queueMicrotask(() => {
			store.pending = false;
			rerender();
		});
	}

	// 一次完整的「渲染 + 提交 effect」。自动重渲染（setState → invalidate）也必须走这条路径：
	// 早期它只调 renderTree，effect 的 deps 被标记成已消费却没执行，那个 effect 就再也不会跑
	//（确认阶段 / 骨架这类断言因此在替身里永远到不了）。
	function renderNow() {
		if (++renderCount > 300) throw new Error("替身重渲染超过 300 次：疑似 effect/state 死循环");
		store.idx = 0;
		store.effects = [];
		store.container.innerHTML = "";
		instanceCounters = new Map();
		renderTree(store.root, store.container, true);
		// 先跑上一次的 cleanup，再跑本次的 effect（React 的提交顺序）。
		const cleanups = store.pendingCleanups;
		store.pendingCleanups = [];
		for (const h of cleanups) {
			const c = h.cleanup;
			h.cleanup = null;
			if (typeof c === "function") c();
		}
		const effects = store.effects;
		store.effects = [];
		for (const e of effects) {
			const r = e.fn();
			if (typeof r === "function") e.h.cleanup = r;
		}
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
			// React 在重跑 effect 前先执行上一次的 cleanup。替身也必须执行：否则换代逻辑不会发生
			// （例如等待期装的 MutationObserver 不会断开，旧的观察者会继续改 DOM、把已还原的源码
			// 再藏回去），这会让断言看起来"莫名其妙地失败"。
			if (typeof h.cleanup === "function") store.pendingCleanups.push(h);
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
			const ord = instanceCounters.get(el.type) || 0;
			instanceCounters.set(el.type, ord + 1);
			const instanceKey = (el.type.name || "anon") + "#" + ord;
			let hooks = instances.get(instanceKey);
			if (!hooks) { hooks = []; instances.set(instanceKey, hooks); }
			const sub = { hooks: hooks, idx: 0, pending: false, effects: [], pendingCleanups: outer.pendingCleanups };
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
			rerender = () => { if (store.container) renderNow(); };
		},
		render() {
			renderNow();
		},
	};
}

// ── 按宿主真实结构造一个代码块 ──────────────────────────────────────
// 关键前提：宿主的类名来自 CSS Modules，是**哈希过的**（dsh-web-frontend 产物里实测：
// infostring -> `_infostring_7gxqk_45`、banner -> `_banner_7gxqk_24`、content -> `_content_7gxqk_74`），
// 只有 `md-code-block` 和 `data-code-block-*` 是字面量；renderCode 传给 CodeBlock 的 code 只有
// `node.value`，围栏 ``` 标记在解析阶段就被吃掉了。插件的语言识别曾经写死 `.infostring`，
// 在真实 DOM 上永远匹配不到；fixture 若用未哈希的 class 就永远测不出这个 bug。
const CLS = {
	block: "_block_7gxqk_4",
	bannerWrap: "_bannerWrap_7gxqk_24",
	banner: "_banner_7gxqk_24",
	infostring: "_infostring_7gxqk_45",
	action: "_action_7gxqk_56",
	copyButton: "_copyButton_7gxqk_62",
	content: "_content_7gxqk_74",
	header: "_header_1a2b3_1",
	heading: "_heading_1a2b3_2",
	language: "_language_1pq26_30",
	actions: "_actions_1a2b3_4",
	card: "_card_7gxqk_107",
};
// 代码正文按文本插入（宿主是 React，文本会被转义）。不转义的话 <svg>/<html> 这类内容会被
// HTML 解析成子元素，textContent 变空 —— 正文特征识别就永远看不到内容。
function esc(text) {
	return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// lang 为 null 时造「普通代码块」（无横幅语言标签），用于验证不会误藏。
function fenceDom(lang, code, opts) {
	const o = opts || {};
	const banner = lang === null
		? ""
		: '<div class="' + CLS.bannerWrap + '"><div class="' + CLS.banner + '" data-code-block-banner="true">'
			+ '<div class="' + CLS.infostring + '">' + esc(lang) + "</div>"
			+ '<div class="' + CLS.action + '"><button type="button" class="' + CLS.copyButton + '">复制</button></div>'
			+ "</div></div>";
	const body = '<pre class="shiki css-variables"><code>' + esc(o.closeFence === false ? code : code + "\n```") + "</code></pre>";
	return '<div class="' + CLS.block + ' md-code-block">' + banner
		+ '<div class="' + CLS.content + '" data-code-block-content="true">' + body + "</div></div>";
}
// CodeToolbar 分支（toolbarLabels 有值时走这里）：同样渲染 data-code-block-banner。
// 真机形态下横幅显示的是**通用标签**——宿主用 `isLang(lang) ? lang : codeLabel`，而 isLang 基于
// shiki 语法集，svg/mermaid 都不在其中，所以语言在 DOM 上根本读不到（实测 label="代码块"）。
function realToolbarFenceDom(code, label) {
	return '<div class="' + CLS.block + ' md-code-block ' + CLS.card + '">'
		+ '<div class="' + CLS.bannerWrap + '"><div class="' + CLS.header + '" data-code-block-banner="true">'
		+ '<div class="' + CLS.heading + '"><span class="' + CLS.language + '">' + esc(label === undefined ? "代码块" : label) + "</span></div>"
		+ '<div class="' + CLS.actions + '"><button type="button">复制</button></div>'
		+ "</div></div>"
		+ '<div class="' + CLS.content + '" data-code-block-content="true">'
		+ '<pre class="shiki css-variables"><code>' + esc(code) + "</code></pre></div>"
		+ "</div>";
}
// 语言标签确实是语言的形态（普通横幅分支）——保留覆盖。
function toolbarFenceDom(lang, code) {
	return '<div class="' + CLS.block + ' md-code-block">'
		+ '<div class="' + CLS.bannerWrap + '"><div class="' + CLS.header + '" data-code-block-banner="true">'
		+ '<div class="' + CLS.heading + '"><span class="' + CLS.language + '">' + esc(lang) + "</span></div>"
		+ '<div class="' + CLS.actions + '"><button type="button">复制</button></div>'
		+ "</div></div>"
		+ '<div class="' + CLS.content + '" data-code-block-content="true">'
		+ '<pre class="shiki css-variables"><code>' + esc(code) + "</code></pre></div>"
		+ "</div>";
}
function fencedBlock(lang, code, opts) {
	return fenceDom(lang, "```" + (lang === null ? "" : lang) + "\n" + code, opts);
}

function messageHtml(inner) {
	return '<div class="flowitem"><div class="column"><div class="msg">' + inner + '</div></div><div class="tail"></div></div>';
}
// 真实节点结构（dsh-web-frontend 实测）：每个流节点是一个带 data-chat-turn 的 flowItem；
// turnTail 节点与「助手消息节点」是**兄弟**，本插件组件渲染在 <div data-turn-tail="T"> 内。
// 更早的回合里刻意放一个图表块：旧实现向上爬容器会把它一起收进来，于是 fences 与本轮解析结果
// 按序号对账错位、什么都不隐藏——这正是真机上的症状。
function realMessageHtml(inner) {
	return '<div data-chat-flow>'
		+ '<div data-chat-turn="1" data-chat-flow-kind="assistant-step"><div class="msg">'
		+ fenceDom("mermaid", "graph TD\n  OLD --> BLOCK", { closeFence: false })
		+ "</div></div>"
		+ '<div data-chat-turn="7" data-chat-flow-kind="assistant-step"><div class="msg">' + inner + "</div></div>"
		+ '<div data-chat-turn="7" data-chat-flow-kind="turn-tail"><div data-turn-tail="7"><div class="tail"></div></div></div>'
		+ "</div>";
}

function mount(inner, opts) {
	const options = opts || {};
	const tree = options.tree === "real" ? realMessageHtml(inner) : messageHtml(inner);
	const dom = new JSDOM("<!doctype html><html><body>" + tree + "</body></html>", { pretendToBeVisual: true });
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

test("真实宿主 DOM（哈希类名 + textContent 无围栏标记）+ 流式未结束：立即隐藏源码并顶骨架", async () => {
	// 回归（本地补丁 L1a + L2）：宿主 renderCode 传的 code 只有 node.value，``` 标记在解析阶段
	// 就被吃掉；语言标签的类名又是 CSS Modules 哈希名。旧的 `.infostring` 选择器在这套 DOM 上
	// 永远匹配不到，domFences 一直返回空数组，隐藏逻辑从未生效。
	const env = mount(fenceDom("mermaid", "graph TD\n  A --> B", { closeFence: false }), { answer: { blocks: [], reason: "no-text" } });
	const blockOf = () => env.doc.querySelector(".md-code-block");
	const first = blockOf();
	assert.ok(!String(first.textContent).includes("```"), "回归前提：真实宿主 DOM 不含围栏标记");
	assert.equal(env.doc.querySelector(".infostring"), null, "回归前提：真实 DOM 里没有未哈希的 .infostring");
	assert.ok(env.doc.querySelector('[class*="infostring"]'), "回归前提：语言标签是哈希类名");
	// 替身的 rerender 不复位 hook 游标，骨架这类依赖 state 重渲染的断言必须经 render() 驱动
	// （作者在文件顶部已声明该短板；此处只断言「隐藏」与「骨架存在」这两件稳定可观察的事）。
	env.tick();
	await env.sleep(20);
	env.tick();
	await env.sleep(10);
	assert.equal(blockOf(), first, "源码节点不应被重建（否则测不出 observer 的补隐藏）");
	assert.equal(blockOf().style.display, "none", "识别出支持语言的真实代码块后应立即隐藏源码");
	assert.notEqual(env.tail.querySelector(".dsh-viz-skeleton"), null, "应与隐藏同一轮顶出占位骨架");
});

test("围栏刚打出、宿主还没解析成代码块（中间态）：不隐藏、不顶骨架", async () => {
	// isRealCodeBlock 守卫：这种元素的 textContent 里才有 ```，它属于正文，
	// 隐藏它会连带隐藏正文——必须等宿主把它解析成真代码块后再隐藏。
	const env = mount("<p><code>```mermaid</code></p>", { answer: { blocks: [], reason: "no-text" } });
	await env.sleep(40);
	env.tick();
	await env.sleep(20);
	const code = env.doc.querySelector("code");
	assert.notEqual(code.style.display, "none", "未成块的裸围栏文本必须保留");
	assert.equal(env.tail.querySelector(".dsh-viz-skeleton"), null, "中间态不应顶出骨架");
});

test("真实节点结构（turnTail 与消息节点是兄弟）：只隐藏本轮的图，不碰其它回合", async () => {
	// 本地补丁 L3 回归：作用域必须按 data-chat-turn 收窄。旧实现向上爬到整个会话容器后，
	// fences 里混进其它回合的图表块，与本轮解析结果按序号对账必然错位 → 一个都不隐藏。
	const env = mount(
		fenceDom("mermaid", "graph TD\n  A --> B", { closeFence: false }),
		{ tree: "real", answer: { blocks: [], reason: "no-text" } },
	);
	env.tick();
	await env.sleep(20);
	env.tick();
	await env.sleep(10);
	const all = Array.from(env.doc.querySelectorAll(".md-code-block"));
	assert.equal(all.length, 2, "前置：DOM 里有「其它回合」与本轮各一个图表块");
	const mine = env.doc.querySelector('[data-chat-turn="7"] .md-code-block');
	const other = env.doc.querySelector('[data-chat-turn="1"] .md-code-block');
	assert.equal(mine.style.display, "none", "本轮图表块的源码应被隐藏");
	assert.notEqual(other.style.display, "none", "其它回合的源码不得被碰");
});

test("真机 toolbar 分支（横幅只有通用标签「代码块」）：靠正文特征识别并隐藏", async () => {
	// 实测：宿主 isLang 基于 shiki 语法集，svg/mermaid 都不在其中，横幅只显示通用标签，
	// 语言在 DOM 上读不到 —— 只能从代码正文特征判断。
	const env = mount(realToolbarFenceDom('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'), { answer: { blocks: [], reason: "no-text" } });
	env.tick();
	await env.sleep(20);
	env.tick();
	await env.sleep(10);
	const block = env.doc.querySelector(".md-code-block");
	assert.equal(block.style.display, "none", "真机 toolbar 形态的 svg 块应被识别并隐藏");
});

test("真机 toolbar 分支 + 正文认不出来：确认阶段按宿主解析结果的正文内容对账隐藏", async () => {
	// 宿主 toolbar 形态下语言读不到，正文特征也认不出来（例如 mermaid 用了非常规开头）——
	// 这时只能靠宿主解析出的 code 文本做内容对账。
	const code = "A --> B\nB --> C";
	const env = mount(realToolbarFenceDom(code), { answer: { blocks: [], reason: "no-text" } });
	env.setAnswer({ blocks: [{ lang: "mermaid", code: code, title: null }], reason: null });
	await env.sleep(80);
	env.tick();
	await env.sleep(20);
	const block = env.doc.querySelector(".md-code-block");
	assert.equal(block.style.display, "none", "宿主已确认的块应按正文内容对上并隐藏");
});

test("CodeToolbar 分支（语言标签就是语言名）同样能识别并隐藏", async () => {
	// 宿主 toolbarLabels 有值时走 CodeToolbar，横幅语言标签不再是 infostring 而是 _language_xxx。
	const env = mount(toolbarFenceDom("mermaid", "graph TD\n  A --> B"), { answer: { blocks: [], reason: "no-text" } });
	env.tick();
	await env.sleep(20);
	env.tick();
	await env.sleep(10);
	const block = env.doc.querySelector(".md-code-block");
	assert.equal(block.style.display, "none", "toolbar 分支的图表块也应被识别并隐藏");
});

test("普通代码块内容里含 ```mermaid 示例：不得误判成图表块、不得误藏", async () => {
	// L2 的配套守卫：语言只认横幅。若在没有横幅可信来源时回退到「正则扫正文里的 ```」，
	// 这种「讲解 mermaid 语法的普通代码块」会被误判成图表块，用户的代码就被藏了。
	const env = mount(fenceDom("markdown", "```mermaid\ngraph TD\n  A --> B\n```", { closeFence: false }), { answer: { blocks: [], reason: "no-text" } });
	env.tick();
	await env.sleep(20);
	env.tick();
	await env.sleep(20);
	const block = env.doc.querySelector(".md-code-block");
	assert.notEqual(block.style.display, "none", "带图表示例的普通代码块绝不能被误藏");
	assert.equal(env.tail.querySelector(".dsh-viz-skeleton"), null, "不应为它顶出骨架");
});

test("宿主只确认了部分块：多藏的早隐藏元素被还原（L1b 收口）", async () => {
	// 两个真代码块、宿主只确认一个（另一个被 maxBlocks / maxBlockChars 跳过）：
	// 没被确认的那个必须把源码还回去，不能「藏了没图」。
	const env = mount(
		fenceDom("mermaid", "graph TD\n  A --> B", { closeFence: false }) + fenceDom("mermaid", "graph TD\n  C --> D", { closeFence: false }),
		{ answer: { blocks: [], reason: "no-text" } },
	);
	env.setAnswer({ blocks: [{ lang: "mermaid", code: "graph TD\n  A --> B", title: null }], reason: null });
	// 首次轮询拿到空结果 → 50ms（测试用退避阶梯）后第二次轮询才拿到确认结果。
	await env.sleep(80);
	env.tick(); // status 变化 → 确认阶段对账 + 收口
	await env.sleep(20);
	const blocks = Array.from(env.doc.querySelectorAll(".md-code-block"));
	assert.equal(blocks[0].style.display, "none", "被宿主确认的块应隐藏");
	assert.notEqual(blocks[1].style.display, "none", "宿主没确认的块必须还原源码");
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
