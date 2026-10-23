/**
 * iOS 客户端的 preload 脚本。
 *
 * 游戏前端启动时会尝试 `import("/preload.js")`，存在则用它替换默认的初始化流程。
 * iOS 版没有走 Capacitor/Cordova，而是复用浏览器端初始化（`init/browser.js`）：
 * 本地 HTTP 服务已经实现了 `@noname/fs` 需要的所有接口，所以 `lib.fs` 可以照常工作。
 *
 * 这里只补齐两件浏览器端没有的事情：
 *   1. `game.download`：把远程资源（扩展、资源更新）下载到可写目录；
 *   2. `game.export`：把文件写到可写目录，并调起系统分享面板。
 */

import browserReady from "./noname/init/browser.js";

/**
 * iOS 的音量补丁。
 *
 * WebKit 在 iOS 上会忽略 `HTMLMediaElement.volume`（属性可以写，但读取会被重置成 1，
 * 实际输出也不受它控制，音量只能靠机身按键）。后果就是游戏里的
 * 「音乐音量 / 音效音量」在 iPhone 上完全没反应。
 *
 * 做法：把每个 <audio>/<video> 接进 Web Audio 的 GainNode，用 gain 真正控制音量；
 * 元素自己的 volume 继续保留（游戏逻辑会读它）。
 *
 * 注意：
 *   1. iOS 的 AudioContext 要等用户第一次触摸才能 resume，所以在 resume 之前不接管，
 *      否则接进还没运行的音频图会直接没声音；
 *   2. 同一个元素只能 createMediaElementSource 一次，所以 source 缓存起来复用；
 *   3. 播放结束后断开 gain，避免长时间游戏积累一堆音频节点。
 */
function installIosAudioVolume() {
	if (window.__nonameAudioVolumeInstalled) return;
	window.__nonameAudioVolumeInstalled = true;

	const AudioContextClass = window.AudioContext || window.webkitAudioContext;
	if (!AudioContextClass || !window.HTMLMediaElement) return;

	const proto = HTMLMediaElement.prototype;
	const volumeDescriptor = Object.getOwnPropertyDescriptor(proto, "volume");
	if (!volumeDescriptor || !volumeDescriptor.set) return;

	let context = null;
	const sources = new WeakMap(); // element -> MediaElementAudioSourceNode
	const gains = new WeakMap(); // element -> GainNode（仅在播放期间保留）
	const desiredVolumes = new WeakMap(); // element -> 游戏设定的音量
	const debug = {
		state: "idle",
		routed: 0,
		failed: 0,
		/** 调试用：读取某个元素当前的 Web Audio 增益 */
		gainOf(element) {
			return gains.get(element)?.gain.value ?? null;
		},
	};
	window.__nonameAudio = debug;

	function ensureContext() {
		if (context) return context;
		try {
			context = new AudioContextClass();
			debug.state = context.state;
			context.addEventListener?.("statechange", () => {
				debug.state = context.state;
			});
		} catch (error) {
			debug.failed++;
			console.warn("iOS: 无法创建 AudioContext", error);
		}
		return context;
	}

	function resumeContext() {
		const ctx = ensureContext();
		if (!ctx) return null;
		if (ctx.state !== "running") {
			ctx.resume().then(() => (debug.state = ctx.state)).catch(() => {});
		}
		return ctx;
	}

	function clampVolume(value) {
		const number = Number(value);
		if (!Number.isFinite(number)) return 1;
		return Math.min(1, Math.max(0, number));
	}

	function volumeOf(element) {
		return clampVolume(desiredVolumes.get(element) ?? volumeDescriptor.get.call(element));
	}

	/** 把元素接进音频图；context 还没 running 时先不接，避免直接没声音。 */
	function route(element) {
		const ctx = ensureContext();
		if (!ctx || ctx.state !== "running") return null;

		let source = sources.get(element);
		if (!source) {
			try {
				source = ctx.createMediaElementSource(element);
				sources.set(element, source);
			} catch (error) {
				debug.failed++;
				console.warn("iOS: 接管媒体音量失败", error);
				return null;
			}
			element.addEventListener(
				"ended",
				() => {
					const gain = gains.get(element);
					if (!gain) return;
					try {
						gain.disconnect();
					} catch {}
					gains.delete(element);
				},
				{ once: false }
			);
		}

		let gain = gains.get(element);
		if (!gain) {
			gain = ctx.createGain();
			gain.connect(ctx.destination);
			source.connect(gain);
			gains.set(element, gain);
			debug.routed++;
		}
		gain.gain.value = volumeOf(element);
		return gain;
	}

	// 游戏通过 `audio.volume = x` 设置音量；这里同步到 GainNode
	Object.defineProperty(proto, "volume", {
		configurable: true,
		enumerable: volumeDescriptor.enumerable,
		get() {
			return volumeDescriptor.get.call(this);
		},
		set(value) {
			volumeDescriptor.set.call(this, value);
			desiredVolumes.set(this, value);
			const gain = gains.get(this);
			if (gain) gain.gain.value = clampVolume(value);
		},
	});

	// iOS 上 AudioContext 必须在用户手势里 resume
	function unlock() {
		const ctx = resumeContext();
		if (!ctx) return;
		const attachPlaying = () => {
			if (ctx.state !== "running") return;
			document.querySelectorAll("audio, video").forEach(element => {
				if (!element.paused) route(element);
			});
		};
		if (ctx.state === "running") attachPlaying();
		else ctx.resume().then(attachPlaying).catch(() => {});
	}

	["touchstart", "touchend", "click", "keydown"].forEach(type => {
		document.addEventListener(type, unlock, { passive: true, capture: true });
	});

	// 每次开始播放时挂上（覆盖新建的音效元素、以及换曲后的 BGM）
	document.addEventListener(
		"play",
		event => {
			const element = event.target;
			if (element instanceof HTMLMediaElement) route(element);
		},
		true
	);

	// 从后台回来时 context 可能被挂起
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible" && context) resumeContext();
	});
}

installIosAudioVolume();

function postToNative(action, payload = {}) {
	try {
		window.webkit?.messageHandlers?.noname?.postMessage({ action, ...payload });
	} catch (error) {
		console.warn("原生桥接不可用", error);
	}
}

function sanitizeFileName(name) {
	return String(name || "noname").replace(/\\|\/|:|\?|"|\*|<|>|\|/g, "-");
}

function toBytes(data) {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	if (typeof Blob !== "undefined" && data instanceof Blob) return data.arrayBuffer().then(buffer => new Uint8Array(buffer));
	return new TextEncoder().encode(String(data));
}

export default async function preload(ctx) {
	const { lib, game, get } = ctx;

	await browserReady(ctx);

	if (!lib.fs) {
		// 本地文件服务没起来时不要继续覆盖，让游戏按浏览器模式降级运行
		console.warn("iOS: 文件系统不可用，跳过 preload 覆盖");
		return;
	}

	/**
	 * 下载远程文件到可写目录（`folder` 是完整的目标文件路径，与 cordova/node 端一致）。
	 */
	game.download = function download(url, folder, onsuccess, onerror, dev, onprogress) {
		if (!url.startsWith("http")) {
			url = get.url(dev) + url;
		}

		const target = String(folder).replace(/^\.?\//, "");
		const directory = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";

		(async () => {
			const response = await fetch(encodeURI(url), { cache: "no-cache" });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			}

			const total = Number(response.headers.get("content-length")) || 0;
			let bytes;
			if (response.body && typeof response.body.getReader === "function") {
				const reader = response.body.getReader();
				const chunks = [];
				let loaded = 0;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(value);
					loaded += value.length;
					if (onprogress) onprogress(loaded, total);
				}
				bytes = new Uint8Array(loaded);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.length;
				}
			} else {
				bytes = new Uint8Array(await response.arrayBuffer());
			}

			if (directory) {
				await lib.fs.createDir(directory, { recursive: true });
			}
			await lib.fs.write(target, bytes);

			lib.config.brokenFile?.remove?.(target);
			game.saveConfigValue?.("brokenFile");
			if (onsuccess) onsuccess();
		})().catch(error => {
			console.error("下载失败", url, error);
			if (onerror) onerror(error);
		});
	};

	/**
	 * 导出文件：写到可写目录的 `export/`，然后调起系统分享面板。
	 */
	game.export = function exportFile(data, name) {
		const fileName = sanitizeFileName(name);

		(async () => {
			const bytes = await toBytes(data);
			await lib.fs.createDir("export", { recursive: true });
			await lib.fs.write(`export/${fileName}`, bytes);
			// 直接弹系统分享面板：可以「存储到文件」、发给好友，或存到 iCloud
			postToNative("export", { path: `export/${fileName}` });
		})().catch(error => {
			console.error(error);
			alert(`文件导出失败: ${error instanceof Error ? error.message : String(error)}`);
		});
	};

	// iOS 上窗口无法真正关闭，直接保持现状即可
	game.exit = function exitApp() {
		postToNative("log", { message: "game.exit called" });
	};

	window.__nonameIos = { fsReady: !!lib.fs };

	postToNative("log", { message: "preload ready fs=\(!!lib.fs)" });
}
