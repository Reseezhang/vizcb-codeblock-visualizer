// vizcb-codeblock-visualizer - browser half (v2.1).
// Renders svg/html/mermaid fenced blocks in the closing assistant message as
// diagram cards (turnTail chain slot). Content is fetched from the Host route
// POST /vizcb/read-turn; config comes from window.__VIZCB_CONFIG__.
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

		const VERSION = "1.4.1";

		const CFG_DEFAULTS = {
			retryDelayMs: 2000,
			minSvgHeight: 120,
			mermaidEnabled: true,
			htmlAllowScripts: false,
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
					"unavailable": "可视化服务暂不可用，未渲染",
					"rate-limited": "请求过于频繁，稍后再试",
				},
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
					"unavailable": "visualizer service unavailable",
					"rate-limited": "too many requests, try later",
				},
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
		].join("");

		const tagId = "vizcb-codeblock-visualizer/tail.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "vizcb-codeblock-visualizer";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// per-(session,seq) 结果缓存，避免切视图/重挂载重复请求。
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
					cache.set(key, res);
					return res;
				})
				.catch(() => {
					const err = { blocks: [], reason: "unavailable" };
					cache.set(key, err);
					return err;
				});
		}

		function VizTail(props) {
			const matched = props && props.matched;
			const seq = props && props.seq != null ? props.seq : (matched && matched.seq);
			const sessionId = props && props.sessionId;
			const t = textsOf(props);
			const [state, setState] = react.useState({ status: "loading" });

			react.useEffect(() => {
				if (seq == null || sessionId == null) return;
				let alive = true;
				let timer = null;
				const finish = (res) => {
					if (!alive) return;
					const blocks = (Array.isArray(res.blocks) ? res.blocks : []).filter((b) => b && typeof b.code === "string");
					const reason = typeof res.reason === "string" ? res.reason : null;
					setState({ status: "done", blocks: blocks, reason: reason });
				};
				readTurn(sessionId, seq).then((res) => {
					if (!alive) return;
					const blocks = (Array.isArray(res.blocks) ? res.blocks : []).filter((b) => b && typeof b.code === "string");
					const reason = typeof res.reason === "string" ? res.reason : null;
					const retryable = blocks.length === 0 && (reason === null || reason === "read-failed" || reason === "no-text");
					if (retryable) {
						timer = window.setTimeout(() => { readTurn(sessionId, seq).then(finish); }, CFG.retryDelayMs);
					} else {
						finish(res);
					}
				});
				return () => { alive = false; if (timer !== null) window.clearTimeout(timer); };
			}, [sessionId, seq]);

			if (state.status === "loading") return null;
			if (state.blocks.length > 0) {
				const items = state.blocks.map((b, i) =>
					react.createElement(VizCard, { key: i + ":" + b.lang, lang: b.lang, code: b.code, title: b.title || null, t: t }),
				);
				return react.createElement("div", { className: "dsh-viz-strip" + (items.length > 1 ? " dsh-viz-grid" : "") }, items);
			}
			const text = t.notice[state.reason];
			if (!text) return null;
			return react.createElement("div", { className: "dsh-viz-notice" }, t.failedPrefix + text);
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
				body = react.createElement("div", { className: "dsh-viz-lb-svg", dangerouslySetInnerHTML: { __html: sanitizeSvg(code) } });
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
			return '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#0F172A;color:#E5E7EB;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;padding:12px}</style></head><body>' + String(code) + "</body></html>";
		}

		// mermaid 走宿主渲染：POST /vizcb/mermaid.svg { code, dark } -> SVG 文本，
		// 与 read-turn 同一已验证的传输通道，消毒后内联渲染。
		function MermaidBlock(props) {
			const { code, t, className } = props;
			const [svg, setSvg] = react.useState(null);
			const [err, setErr] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				fetch("/vizcb/mermaid.svg", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ code: code, dark: true, clientVersion: VERSION }),
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
							ctx.fillStyle = "#0F172A"; // 卡片画布底色
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
