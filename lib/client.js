// vizcb-codeblock-visualizer - browser half (v2.3 / 1.6.0).
// Renders svg/html/mermaid fenced blocks in the closing assistant message as
// diagram cards (turnTail chain slot), and renders the ```present-files
// directive as a preview panel + file cards (click-to-switch, copy path,
// reveal in file manager, mtime polling for live refresh).
// Content is fetched from the Host route POST /vizcb/read-turn; config comes
// from window.__VIZCB_CONFIG__.
// v1.6.0: present-files preview (spec: html-preview-spec.md).
// v1.6.1: hideSourceBlocks - 隐藏本插件渲染过的源码围栏（svg/html/mermaid/present-files），
// 只留下渲染结果；仅当宿主确认从本条消息解析出了对应块时才隐藏（按解析出的语言精确匹配）。
// Zoom opens a full-viewport lightbox (portal to body when react-dom is
// available), so a diagram is always visible in full regardless of layout.
window.__ModuleLoader__.load({
	id: "vizcb-codeblock-visualizer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let reactDom = null;
		try { reactDom = require("react-dom"); } catch (e) { reactDom = null; }

		const VERSION = "1.6.6";

		const CFG_DEFAULTS = {
			retryDelayMs: 2000,
			minSvgHeight: 120,
			mermaidEnabled: true,
			htmlAllowScripts: false,
			canvasBg: "#0F172A",
			mermaidDark: null, // null = 自动检测主题；true/false = 强制
			previewEnabled: true,
			previewPollMs: 3000,
			previewMaxBytes: 5 * 1024 * 1024,
			hideSourceBlocks: true, // 隐藏本插件渲染过的源码围栏，只留渲染结果
		};
		function readConfig() {
			const raw = typeof window !== "undefined" ? window.__VIZCB_CONFIG__ : void 0;
			const out = { ...CFG_DEFAULTS };
			if (raw && typeof raw === "object") {
				for (const k of Object.keys(CFG_DEFAULTS)) if (raw[k] !== undefined) out[k] = raw[k];
			}
			return out;
		}
		const CFG = readConfig();

		// 主题检测：优先看宿主显式 mermaidDark 配置，其次 html data-theme，
		// 再退回 prefers-color-scheme；默认深色（宿主画布即深色契约）。
		function mermaidDarkValue() {
			if (CFG.mermaidDark === true || CFG.mermaidDark === false) return CFG.mermaidDark;
			try {
				if (typeof document !== "undefined") {
					const root = document.documentElement;
					const attr = String(root.getAttribute("data-theme") || root.getAttribute("theme") || "").toLowerCase();
					if (attr.indexOf("dark") !== -1) return true;
					if (attr.indexOf("light") !== -1) return false;
				}
				if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
					const mq = window.matchMedia("(prefers-color-scheme: dark)");
					if (mq && mq.matches) return true;
				}
			} catch (e) { /* ignore */ }
			return true;
		}

		const TEXTS = {
			zh: {
				card: "可视化图表",
				copy: "复制",
				copied: "已复制",
				zoom: "放大",
				close: "关闭",
				save: "保存",
				saving: "保存中…",
				invalid: "SVG 语法错误，无法渲染",
				failedPrefix: "图表未渲染：",
				notice: {
					"fence-not-at-line-start": "svg/html/mermaid 围栏不在行首，未渲染",
					"unsupported-language": "代码块语言不受支持（仅 svg/html/mermaid）",
					"block-invalid": "代码块为空或超过大小上限，未渲染",
					"mermaid-disabled": "mermaid 渲染已在配置中禁用",
					"read-failed": "读取会话数据失败，未渲染",
					"no-text": "未读取到消息文本，未渲染",
					"unavailable": "可视化服务暂不可用，未渲染",
					"rate-limited": "请求过于频繁，稍后再试",
					"invalid-args": "参数无效，未渲染",
					"no-query-service": "可视化服务不可用，未渲染",
					"bad-body": "请求数据无效，未渲染",
					"not-found": "接口不存在，未渲染",
				},
				presentTitle: "可预览文件",
				presentOpen: "打开预览",
				presentClose: "关闭预览",
				preview: "预览",
				copyPath: "复制路径",
				reveal: "打开所在目录",
				revealFail: "无法打开目录",
				previewLoading: "加载中…",
				previewUnsupported: "该类型无法在面板中预览，请复制路径或用浏览器打开",
				previewTooLarge: "文件过大，请用浏览器打开",
				invalidPaths: "以下路径无效（已跳过）",
			},
			en: {
				card: "Visualization",
				copy: "Copy",
				copied: "Copied",
				zoom: "Zoom",
				close: "Close",
				save: "Save",
				saving: "Saving…",
				invalid: "Invalid SVG syntax",
				failedPrefix: "Not rendered: ",
				notice: {
					"fence-not-at-line-start": "fence is not at line start",
					"unsupported-language": "unsupported language (svg/html/mermaid only)",
					"block-invalid": "empty or oversized code block",
					"mermaid-disabled": "mermaid rendering disabled in config",
					"read-failed": "failed to read session data",
					"no-text": "no message text",
					"unavailable": "visualizer service unavailable",
					"rate-limited": "too many requests, try later",
					"invalid-args": "invalid arguments",
					"no-query-service": "visualizer service unavailable",
					"bad-body": "invalid request",
					"not-found": "route not found",
				},
				presentTitle: "Files",
				presentOpen: "Open preview",
				presentClose: "Close preview",
				preview: "Preview",
				copyPath: "Copy path",
				reveal: "Show in folder",
				revealFail: "Cannot open folder",
				previewLoading: "Loading…",
				previewUnsupported: "This type cannot be previewed here",
				previewTooLarge: "File too large, open in a browser",
				invalidPaths: "Invalid paths (skipped)",
			},
		};
		function textsOf(props) {
			let localeId = "zh";
			const locale = props && props.locale;
			if (locale && typeof locale.getLocale === "function") {
				const snap = locale.getLocale();
				const raw = snap && typeof snap === "object" ? snap.locale ?? snap.id ?? "" : "";
				if (typeof raw === "string" && /^en/i.test(raw)) localeId = "en";
			}
			return TEXTS[localeId] || TEXTS.zh;
		}

		const css = [
			".dsh-viz-strip{display:flex;flex-direction:column;gap:10px;margin:10px 2px 2px}",
			".dsh-viz-strip.dsh-viz-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));align-items:start}",
			".dsh-viz-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}",
			".dsh-viz-head{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
			".dsh-viz-badge{font-size:11px;font-weight:600;letter-spacing:.4px;color:#e8f0ff;background:rgba(79,140,255,.16);border:1px solid rgba(79,140,255,.45);border-radius:6px;padding:1px 7px;flex:none}",
			".dsh-viz-badge-html{color:#d1fae5;background:rgba(52,211,153,.14);border-color:rgba(52,211,153,.45)}",
			".dsh-viz-badge-mermaid{color:#fef3c7;background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.45)}",
			".dsh-viz-title{font-size:12px;color:var(--dsw-alias-label-secondary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-viz-actions{display:flex;gap:6px;flex:none}",
			".dsh-viz-ver{font-size:10px;color:var(--dsw-alias-label-tertiary);flex:none;opacity:.7}",
			".dsh-viz-btn{font-size:11px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 8px;cursor:pointer}",
			".dsh-viz-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}",
			".dsh-viz-body{background:#0F172A;cursor:zoom-in}",
			".dsh-viz-svg{padding:12px;min-height:120px}",
			".dsh-viz-svg svg{display:block;width:100%;height:auto}",
			".dsh-viz-frame{display:block;width:100%;height:420px;border:0;background:#0F172A}",
			".dsh-viz-img{display:block;width:100%;height:auto;max-height:420px;object-fit:contain;margin:0 auto;padding:12px;box-sizing:border-box}",
			".dsh-viz-lb-img{display:block;max-width:88vw;max-height:80vh;object-fit:contain;margin:0 auto}",
			".dsh-viz-invalid{padding:24px 12px;text-align:center;font-size:13px;color:var(--dsw-alias-state-error-primary,#F87171)}",
			".dsh-viz-notice{display:flex;align-items:center;gap:6px;padding:10px 12px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
			".dsh-viz-lightbox{position:fixed;inset:0;z-index:2147483000;background:rgba(4,10,24,.85);display:flex;align-items:center;justify-content:center;padding:24px}",
			".dsh-viz-lb-box{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;max-width:94vw;max-height:92vh;display:flex;flex-direction:column;overflow:hidden}",
			".dsh-viz-lb-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
			".dsh-viz-lb-title{font-size:13px;color:var(--dsw-alias-label-primary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-viz-lb-actions{display:flex;gap:6px;flex:none}",
			".dsh-viz-lb-body{background:#0F172A;overflow:auto;flex:1;display:flex;align-items:flex-start;justify-content:center;padding:16px}",
			".dsh-viz-lb-svg{width:min(88vw,1200px)}",
			".dsh-viz-lb-svg svg{display:block;width:100%;height:auto}",
			".dsh-viz-lb-frame{display:block;width:min(88vw,1200px);height:78vh;border:0}",
			// ── present-files 预览 ──
			".dsh-viz-present{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);margin:10px 2px 2px}",
			".dsh-viz-present-head{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
			".dsh-viz-present-title{font-size:12px;color:var(--dsw-alias-label-secondary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-viz-prev-frame{display:block;width:100%;height:480px;border:0;background:#fff}",
			".dsh-viz-prev-imgwrap{display:flex;align-items:center;justify-content:center;background:#0F172A;padding:12px;min-height:160px}",
			".dsh-viz-prev-img{display:block;max-width:100%;max-height:460px;object-fit:contain}",
			".dsh-viz-prev-pre{display:block;margin:0;padding:12px;max-height:480px;overflow:auto;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-primary);background:#0F172A;white-space:pre-wrap;word-break:break-all}",
			".dsh-viz-prev-empty{padding:24px 12px;text-align:center;font-size:13px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-viz-files{display:flex;flex-wrap:wrap;gap:8px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1)}",
			".dsh-viz-file{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 9px;cursor:pointer;background:transparent;max-width:320px;text-align:left}",
			".dsh-viz-file:hover{border-color:var(--dsw-alias-border-l2)}",
			".dsh-viz-file-selected{border-color:rgba(79,140,255,.6);background:rgba(79,140,255,.08)}",
			".dsh-viz-file-name{font-size:12px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-viz-file-ext{font-size:10px;font-weight:600;color:#e8f0ff;background:rgba(79,140,255,.16);border-radius:4px;padding:1px 5px;flex:none}",
			".dsh-viz-file-size{font-size:10px;color:var(--dsw-alias-label-tertiary);flex:none}",
			".dsh-viz-file-actions{display:flex;gap:4px;margin-left:2px;flex:none}",
			// 注意：不再放 CSS 全局隐藏规则。无条件隐藏会把「渲染失败/被禁用的图」的源码
			// 也藏掉（用户既看不到图也看不到代码），且选择器作用于整个页面所有历史消息。
			// 隐藏完全交给 JS 按「本条消息实际解析出的块」精确处理。
		].join("").split("#0F172A").join(CFG.canvasBg);

		const tagId = "vizcb-codeblock-visualizer/tail.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "vizcb-codeblock-visualizer";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// per-(session,seq) 结果缓存，避免切视图/重挂载重复请求。
		// v1.5.0 修复：可重试的失败（读取失败/无文本/网络不可用）不再入缓存，
		// 否则 2s 后的重试会命中缓存拿到同一个失败结果，永远修不好。
		const RETRYABLE = new Set(["read-failed", "no-text", "unavailable", null]);
		function isRetryable(res) {
			const blocks = Array.isArray(res && res.blocks) ? res.blocks : [];
			if (blocks.length > 0) return false;
			const reason = res && typeof res.reason === "string" ? res.reason : null;
			return RETRYABLE.has(reason);
		}
		const cache = new Map();
		function readTurn(sessionId, seq) {
			const key = sessionId + ":" + seq;
			const hit = cache.get(key);
			if (hit !== undefined) return Promise.resolve(hit);
			return fetch("/vizcb/read-turn", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId: sessionId, seq: seq, clientVersion: VERSION }),
			})
				.then((r) => (r.ok ? r.json() : { blocks: [], reason: "unavailable" }))
				.then((res) => {
					if (!isRetryable(res)) cache.set(key, res);
					return res;
				})
				.catch(() => ({ blocks: [], reason: "unavailable" })); // 网络失败不缓存
		}

		// 用户手动关闭预览面板后，同一次会话内后续展示不再自动弹开（规格 §三）。
		let previewUserClosed = false;

		// ── hideSourceBlocks：隐藏本插件渲染过的源码围栏 ──────────────
		// 只在宿主确认解析出对应块时才隐藏（state.blocks 的语言 + present-files），
		// 覆盖 mermaid 方言别名的围栏类名（```flowchart / ```graph / ...）。
		const MERMAID_CLASSES = ["mermaid", "mmd", "flowchart", "graph", "sequencediagram", "classdiagram", "statediagram", "statediagram-v2", "erdiagram", "gantt", "journey", "pie", "gitgraph", "mindmap", "timeline", "requirementdiagram", "quadrantchart", "sankey", "xychart", "block", "c4context", "c4container", "c4component", "c4dynamic", "c4deployment"];
		function hideSetFor(blocks, hasFiles) {
			const set = new Set();
			for (const b of blocks) {
				if (!b || typeof b.lang !== "string") continue;
				if (b.lang === "mermaid") { for (const c of MERMAID_CLASSES) set.add(c); }
				else if (b.lang === "html") { set.add("html"); set.add("html5"); }
				else if (b.lang === "svg") { set.add("svg"); }
			}
			if (hasFiles) set.add("present-files");
			return set;
		}
		function fenceLangOf(el) {
			const cls = String(el.className || "");
			for (const token of cls.split(/\s+/)) {
				if (token.indexOf("language-") === 0) return token.slice("language-".length).toLowerCase();
			}
			const dl = el.getAttribute && el.getAttribute("data-lang");
			if (dl) return String(dl).toLowerCase();
			return null;
		}
		function matchFences(container, hideSet) {
			if (!container || !hideSet || hideSet.size === 0) return [];
			const out = [];
			const els = container.querySelectorAll("pre, code, [data-lang]");
			for (const el of els) {
				const lang = fenceLangOf(el);
				if (lang === null || !hideSet.has(lang)) continue;
				out.push(el.tagName === "CODE" ? (el.closest("pre") || el) : el);
			}
			return out;
		}
		function hideFences(container, hideSet) {
			for (const target of matchFences(container, hideSet)) {
				if (target.style.display !== "none") target.style.display = "none";
			}
		}

		function VizTail(props) {
			const matched = props && props.matched;
			const seq = props && props.seq != null ? props.seq : (matched && matched.seq);
			const sessionId = props && props.sessionId;
			const t = textsOf(props);
			const [state, setState] = react.useState({ status: "loading" });
			const tailRef = react.useRef(null);

			react.useEffect(() => {
				if (seq == null || sessionId == null) return;
				let alive = true;
				let timer = null;
				const finish = (res) => {
					if (!alive) return;
					const blocks = (Array.isArray(res.blocks) ? res.blocks : []).filter((b) => b && typeof b.code === "string");
					const reason = typeof res.reason === "string" ? res.reason : null;
					setState({ status: "done", blocks: blocks, reason: reason, files: res.files || null });
				};
				readTurn(sessionId, seq).then((res) => {
					if (!alive) return;
					const blocks = (Array.isArray(res.blocks) ? res.blocks : []).filter((b) => b && typeof b.code === "string");
					const reason = typeof res.reason === "string" ? res.reason : null;
					const retryable = blocks.length === 0 && !(res.files && Array.isArray(res.files.items) && res.files.items.length > 0) && (reason === null || reason === "read-failed" || reason === "no-text");
					if (retryable) {
						timer = window.setTimeout(() => { readTurn(sessionId, seq).then(finish); }, CFG.retryDelayMs);
					} else {
						finish(res);
					}
				});
				return () => { alive = false; if (timer !== null) window.clearTimeout(timer); };
			}, [sessionId, seq]);

			// hideSourceBlocks：本条消息的源码围栏在渲染出卡片/预览后隐藏（含流式期间新增的）。
			react.useEffect(() => {
				if (!CFG.hideSourceBlocks || state.status !== "done") return;
				const filesNow = state.files && Array.isArray(state.files.items) && state.files.items.length > 0;
				const hideSet = hideSetFor(state.blocks, filesNow === true);
				if (hideSet.size === 0) return;
				const root = tailRef.current;
				if (!root || typeof document === "undefined") return;
				// 找本条消息的容器：沿祖先向上，停在第一个包含代码块的节点。
				// 深度上限 + 不越过 body + 命中数上限三重守卫：任何异常都放弃隐藏
				// （宁可保留源码，也不误藏其他消息的围栏）。
				let container = root.parentElement;
				let depth = 0;
				while (container && container !== document.body && container !== document.documentElement && depth < 12 && !container.querySelector("pre, code, [data-lang]")) {
					container = container.parentElement;
					depth++;
				}
				if (!container || container === document.body || container === document.documentElement) return;
				if (matchFences(container, hideSet).length === 0) return; // 找不到归属围栏
				if (matchFences(container, hideSet).length > 24) return;   // 疑似爬到整个会话区，放弃
				const apply = () => hideFences(container, hideSet);
				apply();
				if (typeof MutationObserver !== "undefined") {
					const obs = new MutationObserver(apply);
					obs.observe(container, { childList: true, subtree: true });
					return () => obs.disconnect();
				}
			}, [state.status, state.blocks, state.files]);

			if (state.status === "loading") return null;

			const files = state.files && Array.isArray(state.files.items) && state.files.items.length > 0 ? state.files : null;
			const invalid = state.files && Array.isArray(state.files.invalid) ? state.files.invalid : [];
			const pieces = [];
			if (state.blocks.length > 0) {
				const items = state.blocks.map((b, i) =>
					react.createElement(VizCard, { key: i + ":" + b.lang, lang: b.lang, code: b.code, title: b.title || null, t: t }),
				);
				pieces.push(react.createElement("div", { className: "dsh-viz-strip" + (items.length > 1 ? " dsh-viz-grid" : "") }, items));
			}
			if (files !== null) {
				pieces.push(react.createElement(PresentSection, { key: "present", token: files.token, items: files.items, invalid: invalid, t: t }));
			} else if (invalid.length > 0) {
				pieces.push(react.createElement("div", { className: "dsh-viz-notice" }, t.failedPrefix + t.invalidPaths + "：" + invalid.map((v) => v.input).slice(0, 3).join("、")));
			}
			if (pieces.length > 0) return react.createElement("div", { ref: tailRef }, ...pieces);
			const text = t.notice[state.reason];
			if (!text) return null;
			return react.createElement("div", { className: "dsh-viz-notice" }, t.failedPrefix + text);
		}

		function previewUrl(token, rel) {
			return "/vizcb/p/" + token + "/" + String(rel).split("/").map(encodeURIComponent).join("/");
		}
		function metaUrl(token, rel) {
			return "/vizcb/p/" + token + "/meta?p=" + encodeURIComponent(rel);
		}
		function formatBytes(n) {
			const num = Number(n) || 0;
			if (num < 1024) return num + " B";
			if (num < 1024 * 1024) return (num / 1024).toFixed(1) + " KB";
			return (num / (1024 * 1024)).toFixed(1) + " MB";
		}

		function PresentSection(props) {
			const { token, items, invalid, t } = props;
			const [selected, setSelected] = react.useState(items[0] ? items[0].rel : null);
			const [panelOpen, setPanelOpen] = react.useState(!previewUserClosed);
			const [revealState, setRevealState] = react.useState({}); // rel -> "busy"|"ok"|"fail"
			const selectedItem = items.find((i) => i.rel === selected) || items[0] || null;

			const onClose = () => { setPanelOpen(false); previewUserClosed = true; };
			const onReopen = () => { setPanelOpen(true); previewUserClosed = false; };
			const onReveal = (item) => {
				if (revealState[item.rel] === "busy") return;
				setRevealState((s) => ({ ...s, [item.rel]: "busy" }));
				fetch("/vizcb/reveal", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: item.abs }),
				})
					.then((r) => r.json())
					.then((j) => setRevealState((s) => ({ ...s, [item.rel]: j && j.ok ? "ok" : "fail" })))
					.catch(() => setRevealState((s) => ({ ...s, [item.rel]: "fail" })));
			};

			return react.createElement("div", { className: "dsh-viz-present" },
				react.createElement("div", { className: "dsh-viz-present-head" },
					react.createElement("span", { className: "dsh-viz-badge" }, t.presentTitle),
					react.createElement("span", { className: "dsh-viz-present-title" }, selectedItem ? selectedItem.abs : ""),
					react.createElement("div", { className: "dsh-viz-actions" },
						react.createElement("button", { type: "button", className: "dsh-viz-btn", onClick: panelOpen ? onClose : onReopen }, panelOpen ? t.presentClose : t.presentOpen),
					),
				),
				panelOpen && selectedItem ? react.createElement(PreviewPanel, { key: selectedItem.rel, item: selectedItem, token: token, t: t }) : null,
				react.createElement("div", { className: "dsh-viz-files" },
					items.map((item) =>
						react.createElement(FileCard, {
							key: item.rel,
							item: item,
							t: t,
							selected: selectedItem !== null && item.rel === selectedItem.rel,
							onSelect: () => setSelected(item.rel),
							onReveal: () => onReveal(item),
							revealState: revealState[item.rel] || null,
						}),
					),
				),
				invalid.length > 0
					? react.createElement("div", { className: "dsh-viz-notice" }, t.failedPrefix + t.invalidPaths + "：" + invalid.map((v) => v.input).slice(0, 3).join("、"))
					: null,
			);
		}

		function FileCard(props) {
			const { item, t, selected, onSelect, onReveal, revealState } = props;
			const [copied, setCopied] = react.useState(false);
			const onCopy = (e) => {
				e.stopPropagation();
				if (typeof navigator === "undefined" || !navigator.clipboard) return;
				navigator.clipboard.writeText(item.abs).then(() => {
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1500);
				}).catch(() => {});
			};
			const onRevealClick = (e) => {
				e.stopPropagation();
				onReveal();
			};
			const revealLabel = revealState === "busy" ? "…" : revealState === "fail" ? t.revealFail : t.reveal;
			return react.createElement("button", { type: "button", className: "dsh-viz-file" + (selected ? " dsh-viz-file-selected" : ""), onClick: onSelect },
				react.createElement("span", { className: "dsh-viz-file-ext" }, item.ext || "?"),
				react.createElement("span", { className: "dsh-viz-file-name", title: item.abs }, item.name),
				react.createElement("span", { className: "dsh-viz-file-size" }, formatBytes(item.size)),
				react.createElement("span", { className: "dsh-viz-file-actions" },
					react.createElement("button", { type: "button", className: "dsh-viz-btn", onClick: onCopy }, copied ? t.copied : t.copyPath),
					react.createElement("button", { type: "button", className: "dsh-viz-btn", onClick: onRevealClick }, revealLabel),
				),
			);
		}

		// 预览面板：html -> sandbox iframe（allow-scripts，无 allow-same-origin）；
		// 图片 -> 大图；css/js/text -> 文本；其余 -> 提示。轮询 meta 检测文件变化后整体刷新。
		function PreviewPanel(props) {
			const { item, token, t } = props;
			const url = previewUrl(token, item.rel);
			const [reload, setReload] = react.useState(0);
			const [text, setText] = react.useState(null);
			const [err, setErr] = react.useState(null);

			react.useEffect(() => {
				let alive = true;
				let last = item.mtimeMs;
				const iv = window.setInterval(() => {
					fetch(metaUrl(token, item.rel))
						.then((r) => (r.ok ? r.json() : null))
						.then((m) => {
							if (alive && m && m.exists && m.mtimeMs !== last) { last = m.mtimeMs; setReload((k) => k + 1); }
						})
						.catch(() => {});
				}, Math.max(500, Number(CFG.previewPollMs) || 3000));
				return () => { alive = false; window.clearInterval(iv); };
			}, [token, item.rel]);

			react.useEffect(() => {
				let alive = true;
				setText(null);
				setErr(null);
				if (item.lang === "html" || item.lang === "image" || item.lang === "other") return;
				fetch(url)
					.then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
					.then((tx) => { if (alive) setText(tx); })
					.catch((e) => { if (alive) setErr(String((e && e.message) || e)); });
				return () => { alive = false; };
			}, [url, reload]);

			if (item.size > CFG.previewMaxBytes) {
				return react.createElement("div", { className: "dsh-viz-prev-empty" }, t.previewTooLarge);
			}
			if (item.lang === "html") {
				return react.createElement("iframe", {
					key: reload,
					className: "dsh-viz-prev-frame",
					sandbox: "allow-scripts", // 无 allow-same-origin：模型 HTML 是唯一隔离层（规格 §五.3）
					src: url + (reload > 0 ? "?_=" + reload : ""),
					title: item.name,
				});
			}
			if (item.lang === "image") {
				return react.createElement("div", { className: "dsh-viz-prev-imgwrap" },
					react.createElement("img", { className: "dsh-viz-prev-img", src: url + (reload > 0 ? "?_=" + reload : ""), alt: item.name }),
				);
			}
			if (item.lang === "css" || item.lang === "js" || item.lang === "text") {
				if (err !== null) return react.createElement("div", { className: "dsh-viz-prev-empty" }, t.failedPrefix + err);
				if (text === null) return react.createElement("div", { className: "dsh-viz-prev-empty" }, t.previewLoading);
				return react.createElement("pre", { className: "dsh-viz-prev-pre" }, text);
			}
			return react.createElement("div", { className: "dsh-viz-prev-empty" }, t.previewUnsupported);
		}

		function VizCard(props) {
			const lang = props.lang;
			const code = props.code;
			const t = props.t;
			const [copied, setCopied] = react.useState(false);
			const [saving, setSaving] = react.useState(false);
			const [open, setOpen] = react.useState(false);
			const [mermaidSvg, setMermaidSvg] = react.useState(null);

			const badge = lang === "html" ? "HTML" : lang === "mermaid" ? "MERMAID" : "SVG";
			const title = props.title || t.card;

			const onCopy = () => {
				if (typeof navigator === "undefined" || !navigator.clipboard) return;
				navigator.clipboard.writeText(code).then(() => {
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1500);
				}).catch(() => {});
			};

			const onSave = () => {
				if (saving) return;
				setSaving(true);
				const finish = () => window.setTimeout(() => setSaving(false), 800);
				if (lang === "html") {
					// HTML 无法无痕转图，保存源文件
					saveTextFile(safeFileName(title) + ".html", [{ description: "HTML", accept: { "text/html": [".html"] } }], new Blob([code], { type: "text/html" })).then(finish);
					return;
				}
				// SVG / mermaid：先拿到 SVG 文本
				const svgText = lang === "mermaid" ? (mermaidSvg || "") : sanitizeSvg(code);
				if (!svgText) { finish(); return; }
				saveSvgAsImage(svgText, safeFileName(title)).then(finish);
			};

			let body;
			if (lang === "mermaid") {
				body = react.createElement(MermaidBlock, { code: code, t: t, className: "dsh-viz-svg", onSvg: setMermaidSvg });
			} else if (lang === "html") {
				body = react.createElement("iframe", {
					className: "dsh-viz-frame",
					sandbox: CFG.htmlAllowScripts ? "allow-scripts" : "",
					srcDoc: htmlDoc(code),
					title: "HTML",
				});
			} else {
				const svgText = sanitizeSvg(code);
				const valid = isValidSvg(svgText);
				body = valid
					? react.createElement("div", {
						className: "dsh-viz-svg",
						dangerouslySetInnerHTML: { __html: svgText },
					})
					: react.createElement("div", { className: "dsh-viz-invalid" }, t.invalid);
			}

			const card = react.createElement("div", { className: "dsh-viz-card" },
				react.createElement("div", { className: "dsh-viz-head" },
					react.createElement("span", { className: "dsh-viz-badge dsh-viz-badge-" + lang }, badge),
					react.createElement("span", { className: "dsh-viz-title", title: title }, title),
					react.createElement("div", { className: "dsh-viz-actions" },
						react.createElement("button", { type: "button", className: "dsh-viz-btn", onClick: onCopy }, copied ? t.copied : t.copy),
						react.createElement("button", { type: "button", className: "dsh-viz-btn", onClick: onSave }, saving ? t.saving : t.save),
						react.createElement("button", { type: "button", className: "dsh-viz-btn", onClick: () => setOpen(true) }, t.zoom),
					),
					react.createElement("span", { className: "dsh-viz-ver" }, "v" + VERSION),
				),
				react.createElement("div", { className: "dsh-viz-body", onClick: () => setOpen(true) }, body),
			);

			const lightbox = open
				? react.createElement(Lightbox, { lang: lang, code: code, title: title, t: t, onClose: () => setOpen(false) })
				: null;

			if (lightbox !== null && reactDom !== null && typeof reactDom.createPortal === "function" && typeof document !== "undefined") {
				return react.createElement(react.Fragment, null, card, reactDom.createPortal(lightbox, document.body));
			}
			return react.createElement(react.Fragment, null, card, lightbox);
		}

		function Lightbox(props) {
			const { lang, code, title, t, onClose } = props;
			const [copied, setCopied] = react.useState(false);
			const onCopy = () => {
				if (typeof navigator === "undefined" || !navigator.clipboard) return;
				navigator.clipboard.writeText(code).then(() => {
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1500);
				}).catch(() => {});
			};
			react.useEffect(() => {
				const onKey = (e) => { if (e.key === "Escape") onClose(); };
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, []);

			let body;
			if (lang === "mermaid") {
				body = react.createElement(MermaidBlock, { code: code, t: t, className: "dsh-viz-lb-svg" });
			} else if (lang === "html") {
				body = react.createElement("iframe", { className: "dsh-viz-lb-frame", sandbox: CFG.htmlAllowScripts ? "allow-scripts" : "", srcDoc: htmlDoc(code), title: "HTML" });
			} else {
				// v1.5.0：灯箱与卡片用同一套校验，无效 SVG 显示错误而非空白/报错。
				const svgText = sanitizeSvg(code);
				const valid = isValidSvg(svgText);
				body = valid
					? react.createElement("div", { className: "dsh-viz-lb-svg", dangerouslySetInnerHTML: { __html: svgText } })
					: react.createElement("div", { className: "dsh-viz-invalid" }, t.invalid);
			}

			return react.createElement("div", { className: "dsh-viz-lightbox", onClick: onClose, role: "dialog", "aria-modal": "true" },
				react.createElement("div", { className: "dsh-viz-lb-box", onClick: (e) => e.stopPropagation() },
					react.createElement("div", { className: "dsh-viz-lb-head" },
						react.createElement("span", { className: "dsh-viz-lb-title" }, title),
						react.createElement("div", { className: "dsh-viz-lb-actions" },
							react.createElement("button", { type: "button", className: "dsh-viz-btn", onClick: onCopy }, copied ? t.copied : t.copy),
							react.createElement("button", { type: "button", className: "dsh-viz-btn", onClick: onClose }, t.close),
						),
					),
					react.createElement("div", { className: "dsh-viz-lb-body" }, body),
				),
			);
		}

		function isValidSvg(svgText) {
			if (typeof DOMParser === "undefined") return true;
			try {
				// 与渲染路径一致：dangerouslySetInnerHTML 走浏览器 HTML 解析器（宽松、自动纠错）。
				// 严格 XML 解析（image/svg+xml）会把轻微瑕疵（未转义 &、多余文本等）判为错误，
				// 但实际渲染正常 —— 所以这里用 text/html 解析，只要存在 <svg> 根元素即视为有效。
				const doc = new DOMParser().parseFromString(svgText, "text/html");
				return doc.querySelector("svg") !== null;
			} catch (e) {
				return false;
			}
		}

		function sanitizeSvg(code) {
			return String(code)
				.replace(/<script[\s\S]*?<\/script\s*>/gi, "")
				.replace(/<script\b[^>]*\/>/gi, "")
				.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
				.replace(/\s(?:href|xlink:href)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, "");
		}

		function htmlDoc(code) {
			return '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:' + CFG.canvasBg + ';color:#E5E7EB;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;padding:12px}</style></head><body>' + String(code) + "</body></html>";
		}

		// mermaid 走宿主渲染：POST /vizcb/mermaid.svg { code, dark } -> SVG 文本，
		// 与 read-turn 同一已验证的传输通道，消毒后内联渲染。
		function MermaidBlock(props) {
			const { code, t, className } = props;
			const [svg, setSvg] = react.useState(null);
			const [err, setErr] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				const dark = mermaidDarkValue();
				fetch("/vizcb/mermaid.svg", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ code: code, dark: dark, clientVersion: VERSION }),
				})
					.then((r) => (r.ok ? r.text() : r.json().then((j) => { throw new Error((j && j.error) || "HTTP " + r.status); })))
					.then((text) => {
						if (!alive) return;
						setSvg(text);
						if (typeof props.onSvg === "function") props.onSvg(text);
					})
					.catch((e) => { if (alive) setErr(String((e && e.message) || e)); });
				return () => { alive = false; };
			}, [code]);
			if (err !== null) {
				return react.createElement("div", { className: "dsh-viz-invalid" }, t.failedPrefix + err);
			}
			if (svg === null) {
				return react.createElement("div", { className: "dsh-viz-invalid" }, "mermaid 渲染中…");
			}
			return react.createElement("div", { className: className || "dsh-viz-svg", dangerouslySetInnerHTML: { __html: sanitizeSvg(svg) } });
		}

		// ── 保存为图片 ─────────────────────────────────────────────
		// 原生保存对话框（用户自选位置与格式）；不可用时退回 anchor 下载。
		function saveFilePicker(suggestedName, types, blob) {
			if (typeof window !== "undefined" && typeof window.showSaveFilePicker === "function") {
				return window.showSaveFilePicker({ suggestedName: suggestedName, types: types })
					.then((handle) => handle.createWritable())
					.then((writable) => writable.write(blob).then(() => writable.close()))
					.catch((e) => {
						if (e && e.name === "AbortError") return; // 用户取消
						fallbackDownload(suggestedName, blob);
					});
			}
			fallbackDownload(suggestedName, blob);
			return Promise.resolve();
		}
		function fallbackDownload(name, blob) {
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = name;
			a.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 5000);
		}
		function safeFileName(title) {
			const s = String(title || "diagram").replace(/[\\/:*?"<>|]/g, "_").trim();
			return s.length > 0 ? s : "diagram";
		}
		function svgViewBoxSize(svgText) {
			const m = svgText.match(/viewBox\s*=\s*["']([\d.\-e]+)\s+([\d.\-e]+)\s+([\d.\-e]+)\s+([\d.\-e]+)["']/i);
			if (m) return { w: Math.abs(parseFloat(m[3]) - parseFloat(m[1])), h: Math.abs(parseFloat(m[4]) - parseFloat(m[2])) };
			return null;
		}
		// 导出用 SVG：把 width/height="100%" 换成 viewBox 比例 × scale 的像素尺寸，保证 PNG 清晰。
		function svgForExport(svgText, scale) {
			const v = svgViewBoxSize(svgText);
			if (v === null) return svgText;
			const w = Math.max(1, Math.round(v.w * scale));
			const h = Math.max(1, Math.round(v.h * scale));
			return svgText
				.replace(/\swidth\s*=\s*["'][^"']*["']/i, ' width="' + w + '"')
				.replace(/\sheight\s*=\s*["'][^"']*["']/i, ' height="' + h + '"');
		}
		function svgToPngBlob(svgText) {
			return new Promise((resolve) => {
				try {
					const exported = svgForExport(svgText, 2);
					const blob = new Blob([exported], { type: "image/svg+xml;charset=utf-8" });
					const url = URL.createObjectURL(blob);
					const img = new Image();
					img.onload = () => {
						try {
							const v = svgViewBoxSize(exported);
							const w = Math.max(1, Math.round(v ? v.w * 2 : img.width));
							const h = Math.max(1, Math.round(v ? v.h * 2 : img.height));
							const canvas = document.createElement("canvas");
							canvas.width = w;
							canvas.height = h;
							const ctx = canvas.getContext("2d");
							ctx.fillStyle = CFG.canvasBg; // 卡片画布底色（与配置一致）
							ctx.fillRect(0, 0, w, h);
							ctx.drawImage(img, 0, 0, w, h);
							canvas.toBlob((png) => { URL.revokeObjectURL(url); resolve(png); }, "image/png");
						} catch (e) {
							URL.revokeObjectURL(url);
							resolve(null);
						}
					};
					img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
					img.src = url;
				} catch (e) {
					resolve(null);
				}
			});
		}
		// 保存 SVG/mermaid 为 PNG（优先）或 SVG（用户可在对话框里切换格式）。
		async function saveSvgAsImage(svgText, baseName) {
			const types = [
				{ description: "PNG 图片", accept: { "image/png": [".png"] } },
				{ description: "SVG 矢量图", accept: { "image/svg+xml": [".svg"] } },
			];
			if (typeof window !== "undefined" && typeof window.showSaveFilePicker === "function") {
				let handle;
				try {
					handle = await window.showSaveFilePicker({ suggestedName: baseName + ".png", types: types });
				} catch (e) {
					if (e && e.name === "AbortError") return;
					handle = null;
				}
				if (handle === null) return;
				const name = handle.name || "";
				const isPng = /\.png$/i.test(name);
				const blob = isPng ? (await svgToPngBlob(svgText)) : null;
				const finalBlob = blob !== null ? blob : new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
				const writable = await handle.createWritable();
				await writable.write(finalBlob);
				await writable.close();
				return;
			}
			// 无原生对话框：直接下载 PNG，失败则 SVG
			const png = await svgToPngBlob(svgText);
			if (png !== null) fallbackDownload(baseName + ".png", png);
			else fallbackDownload(baseName + ".svg", new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }));
		}
		async function saveTextFile(suggestedName, types, blob) {
			await saveFilePicker(suggestedName, types, blob);
		}

		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register(
				{
					name: "conversation.chat.turnTail",
					select: (owner) => {
						if (owner && typeof owner === "object" && typeof owner.seq === "number") {
							return { kind: "visualizer", seq: owner.seq };
						}
						return null;
					},
					inject: () => ({ locale: ctx.get("locale") }),
				},
				VizTail,
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
