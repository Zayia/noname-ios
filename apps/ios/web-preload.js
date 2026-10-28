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
 * iOS 的音量 / 播放补丁。
 *
 * 两个 iOS 特有的问题：
 *
 * 1. WebKit 会忽略 `HTMLMediaElement.volume`（读回来永远是 1，输出也不受控），
 *    游戏的「音乐音量 / 音效音量」因此完全失效；
 * 2. `createMediaElementSource` 接管后的媒体元素，开头 0.3~0.6 秒会被吞掉
 *    （媒体时钟在走，音频图里却是静音），「过河拆桥」只听见「拆桥」就是这么来的。
 *
 * 对策：
 *   - 长音频（BGM、视频）：走 MediaElementSource + GainNode，开头损失可以接受；
 *   - 短音效（台词、技能音）：用 `decodeAudioData` 解码成 AudioBuffer，
 *     原生元素静音播放只用来产生 play/ended 等事件，声音由 AudioBufferSourceNode
 *     从头播放——既没有开头损失，也能精确控制音量。
 *
 * 注意：
 *   - iOS 的 AudioContext 要等用户第一次触摸才能 resume；在那之前不接管，避免没声音；
 *   - 同一个元素只能 createMediaElementSource 一次，source 需要缓存复用；
 *   - 播放结束断开节点，避免长时间游戏积累音频节点。
 */
function installIosAudioVolume() {
	if (window.__nonameAudioVolumeInstalled) return;
	window.__nonameAudioVolumeInstalled = true;

	const AudioContextClass = window.AudioContext || window.webkitAudioContext;
	if (!AudioContextClass || !window.HTMLMediaElement) return;

	const proto = HTMLMediaElement.prototype;
	const volumeDescriptor = Object.getOwnPropertyDescriptor(proto, "volume");
	if (!volumeDescriptor || !volumeDescriptor.set) return;

	/** 超过这个时长的音频走 MediaElementSource，否则解码成 buffer 播放 */
	const SHORT_AUDIO_SECONDS = 60;

	let context = null;
	let keepAlive = null;

	const mediaSources = new WeakMap(); // element -> MediaElementAudioSourceNode
	const mediaGains = new WeakMap(); // element -> GainNode
	const shortPlaybacks = new WeakMap(); // element -> { source, gain }
	const stoppedSources = new WeakSet(); // 被主动 stop 的 source
	const desiredVolumes = new WeakMap(); // element -> 游戏设定的音量
	const analysers = new WeakMap(); // 调试用
	const decodeCache = new Map(); // url -> Promise<AudioBuffer>
	const undecodable = new Set(); // 解码失败的 URL，之后直接走原生播放

	const debug = {
		build: "2026-10-28-echo",
		state: "idle",
		routed: 0,
		buffered: 0,
		failed: 0,
		/** 调试用：置 true 可临时关闭接管，对比原生行为 */
		disabled: false,
		/** 调试用：置 true 后新接管的音频会经过一个 AnalyserNode */
		tap: false,
		/** 调试用：读取元素当前的 Web Audio 增益 */
		gainOf(element) {
			return (mediaGains.get(element) ?? shortPlaybacks.get(element)?.gain)?.gain.value ?? null;
		},
		/** 调试用：读取元素的 AnalyserNode */
		analyserOf(element) {
			return analysers.get(element) ?? null;
		},
		/** 调试用：把元素改接到 AnalyserNode */
		attachAnalyser(element) {
			const gain = mediaGains.get(element);
			const ctx = context;
			if (!gain || !ctx) return null;
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 2048;
			try {
				gain.disconnect();
			} catch {}
			gain.connect(analyser);
			analyser.connect(ctx.destination);
			analysers.set(element, analyser);
			return analyser;
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

	/** 常驻一个循环的静音源，让音频图一直处于渲染状态 */
	function keepGraphAlive(ctx) {
		if (keepAlive) return;
		try {
			const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate)), ctx.sampleRate);
			const source = ctx.createBufferSource();
			source.buffer = buffer;
			source.loop = true;
			source.connect(ctx.destination);
			source.start(0);
			keepAlive = source;
		} catch {}
	}

	// MARK: - 长音频：MediaElementSource + GainNode

	function routeMedia(element) {
		if (debug.disabled) return null;
		const ctx = ensureContext();
		if (!ctx || ctx.state !== "running") return null;

		let source = mediaSources.get(element);
		if (!source) {
			try {
				source = ctx.createMediaElementSource(element);
				mediaSources.set(element, source);
			} catch (error) {
				debug.failed++;
				console.warn("iOS: 接管媒体音量失败", error);
				return null;
			}
			// 不要在一首播完后拆掉 gain：BGM 元素会循环复用，
			// 拆掉后下一首会在「没人再设音量」的情况下以全音量播放（iOS 27 上就是这样）
			element.addEventListener("ended", () => {
				if (!mediaGains.has(element)) return;
				const gain = mediaGains.get(element);
				if (gain) gain.gain.value = volumeOf(element);
			});
		}

		let gain = mediaGains.get(element);
		if (!gain) {
			gain = ctx.createGain();
			if (debug.tap) {
				const analyser = ctx.createAnalyser();
				analyser.fftSize = 2048;
				gain.connect(analyser);
				analyser.connect(ctx.destination);
				analysers.set(element, analyser);
			} else {
				gain.connect(ctx.destination);
			}
			source.connect(gain);
			mediaGains.set(element, gain);
			debug.routed++;
		}
		gain.gain.value = volumeOf(element);
		return gain;
	}

	// MARK: - 短音频：解码成 AudioBuffer 播放

	function decodeAudio(url) {
		if (!url) return Promise.reject(new Error("no url"));
		const cached = decodeCache.get(url);
		if (cached) return cached;
		const ctx = ensureContext();
		if (!ctx) return Promise.reject(new Error("no context"));
		const promise = fetch(url)
			.then(response => {
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return response.arrayBuffer();
			})
			.then(data => ctx.decodeAudioData(data))
			.catch(error => {
				undecodable.add(url);
				decodeCache.delete(url);
				throw error;
			});
		decodeCache.set(url, promise);
		// 简单限制缓存数量，避免玩久了占用过多内存
		if (decodeCache.size > 120) {
			const oldest = decodeCache.keys().next().value;
			if (oldest !== url) decodeCache.delete(oldest);
		}
		return promise;
	}

	let silentFailures = 0;

	/** buffer 没接上时解除静音；连续多次失败就整体退回原生播放，保证有声音 */
	function fallbackToNative(element) {
		if (!element.ended) element.muted = false;
		silentFailures++;
		if (silentFailures >= 5 && !debug.disabled) {
			debug.disabled = true;
			console.warn("iOS: 音频接管连续失败，本次会话改用原生播放");
		}
	}

	function stopShortPlayback(element) {
		const playback = shortPlaybacks.get(element);
		if (!playback) return;
		shortPlaybacks.delete(element);
		stoppedSources.add(playback.source);
		try {
			playback.source.stop();
		} catch {}
		try {
			playback.source.disconnect();
		} catch {}
		try {
			playback.gain.disconnect();
		} catch {}
	}

	/**
	 * 短音频播放：元素自身静音（保证 play/ended 事件照常触发），
	 * 实际声音由 AudioBufferSourceNode 从头播放。
	 *
	 * 解码未完成时会等它解码（本地文件通常 10ms 左右），而不是退回原生播放：
	 * iOS 同时播放多个 media element 会把旧的暂停，一退回原生，连续出牌时
	 * 前面的音效就会整段消失。解码真失败时再解除静音，让原生声音兜底。
	 */
	function playShort(element, nativePlay, args) {
		// 被电话 / Siri 打断后 context 可能是 suspended/interrupted，先尝试恢复
		const ctx = resumeContext();
		const url = element.currentSrc || element.src;
		const ready = ctx && ctx.state === "running" && !debug.disabled && !undecodable.has(url);
		const cached = ready ? decodeCache.get(url) : null;

		if (!ready) return nativePlay.apply(element, args);

		// autoplay 已经通过 play 事件开始 buffer 播放了，这里不要再重启一遍
		if (shortPlaybacks.has(element)) return nativePlay.apply(element, args);

		stopShortPlayback(element);
		element.muted = true;
		const result = nativePlay.apply(element, args);
		const startedAt = element.currentTime;

		// 还没解码过也要等它解码完再播，而不是退回原生播放：
		// iOS 同时播放多个 media element 时会把先前的暂停，一旦退回原生，
		// 对家连续出牌时前面的音效就会整段消失。
		// 解码通常只要 10ms 左右，等一会儿比没声音好。
		// 兜底：万一解码卡住（网络/解码器异常），不能一直静音着，
		// 400ms 还没开始 buffer 就解除静音，让原生声音出来
		const watchdog = setTimeout(() => {
			if (!shortPlaybacks.has(element) && element.muted && !element.paused && !element.ended) {
				element.muted = false;
				debug.failed++;
			}
		}, 400);

		(cached ?? decodeAudio(url))
			.then(buffer => {
				clearTimeout(watchdog);
				// 没接上 buffer 就绝不能一直静音着
				if (!startBuffer(element, buffer, startedAt)) fallbackToNative(element);
			})
			.catch(error => {
				// 解码失败就退回原生播放（至少能听到声音，只是音量不可控）
				clearTimeout(watchdog);
				debug.failed++;
				element.muted = false;
				console.warn("iOS: 音频解码失败", error);
				Promise.resolve(nativePlay.apply(element, args)).catch(() => {});
			});

		return result;
	}

	/**
	 * 用 AudioBufferSourceNode 播放，并让原生元素保持静音（只负责事件）。
	 *
	 * @param {HTMLAudioElement} element
	 * @param {AudioBuffer} buffer
	 * @param {number} [startedAt] 元素开始播放时的 currentTime，用来判断是否要追赶进度
	 * @returns {boolean} 是否真的接上了 buffer
	 */
	function startBuffer(element, buffer, startedAt) {
		const ctx = ensureContext();
		if (!ctx) return false;
		// 解码期间可能已经播完 / 换了 src。
		// 不检查 paused：iOS 可能因为并发播放把原生元素暂停，
		// 但 buffer 本身是独立的，仍然应该出声。
		if (element.ended) return true; // 已经播完了，不是失败
		if (shortPlaybacks.has(element)) return true; // 已经在播了
		const url = element.currentSrc || element.src;
		if (!url) return false;

		element.muted = true;

		const source = ctx.createBufferSource();
		source.buffer = buffer;
		const gain = ctx.createGain();
		gain.gain.value = volumeOf(element);
		source.connect(gain);
		if (debug.tap) {
			const analyser = ctx.createAnalyser();
			analyser.fftSize = 2048;
			gain.connect(analyser);
			analyser.connect(ctx.destination);
			analysers.set(element, analyser);
		} else {
			gain.connect(ctx.destination);
		}

		// 正常情况下从 0 开始；如果解码拖了太久，就跟上元素进度，避免不同步
		const elapsed = typeof startedAt === "number" ? element.currentTime - startedAt : element.currentTime;
		const offset = elapsed > 0.25 ? element.currentTime : 0;
		try {
			source.start(0, Math.min(offset, Math.max(0, buffer.duration - 0.02)));
		} catch {
			return false;
		}
		shortPlaybacks.set(element, { source, gain });
		element.__nonameBuffered = true;
		debug.buffered++;

		source.onended = () => {
			// 被主动 stop 的不算自然播完，不要合成 ended 让游戏提前回收元素
			if (stoppedSources.has(source)) return;
			const nativeStillPlaying = !element.paused && !element.ended;
			stopShortPlayback(element);
			// 原生元素如果被 iOS 暂停了，它永远不会触发 ended，
			// 这里补一个，让游戏把元素回收掉
			if (!nativeStillPlaying && !element.ended) {
				element.dispatchEvent(new Event("ended"));
			}
		};
		return true;
	}

	// MARK: - 属性 / 方法接管

	Object.defineProperty(proto, "volume", {
		configurable: true,
		enumerable: volumeDescriptor.enumerable,
		get() {
			return volumeDescriptor.get.call(this);
		},
		set(value) {
			volumeDescriptor.set.call(this, value);
			desiredVolumes.set(this, value);
			const mediaGain = mediaGains.get(this);
			if (mediaGain) {
				mediaGain.gain.value = clampVolume(value);
				return;
			}
			const playback = shortPlaybacks.get(this);
			if (playback) playback.gain.gain.value = clampVolume(value);
			// 游戏是「创建元素 → 设置音量 → 设置 src → 播放」，
			// 长音频可以在这里就先接进音频图
			if (context && context.state === "running" && this.duration > SHORT_AUDIO_SECONDS) routeMedia(this);
		},
	});

	/**
	 * 给本地音频 URL 加一个版本号。
	 *
	 * 构建时会把部分 mp3 换成 AAC，但文件名不变；WKWebView 的磁盘缓存是按 URL 记的，
	 * 老用户可能还缓存着旧的 mp3 字节（Cache-Control 之前是 7 天），
	 * 换了内容也拿不到新文件。加一个固定的 `?v=` 让 URL 变化，强制重新取一次。
	 */
	const AUDIO_CACHE_VERSION = "aac3";
	function versionedAudioUrl(url) {
		if (!url || typeof url !== "string") return url;
		// blob:/data: 不处理；其余（绝对 URL、"/audio/..."、以及 lib.assetURL 为空时的
		// "audio/..." 相对路径）都补一个版本号
		if (/^(?:blob|data|javascript):/i.test(url)) return url;
		if (url.includes("v=")) return url;
		if (!/\.(mp3|m4a|aac|ogg|wav)(\?|#|$)/i.test(url)) return url;
		return `${url}${url.includes("?") ? "&" : "?"}v=${AUDIO_CACHE_VERSION}`;
	}

	const srcDescriptor = Object.getOwnPropertyDescriptor(proto, "src");
	if (srcDescriptor?.set) {
		Object.defineProperty(proto, "src", {
			configurable: true,
			enumerable: srcDescriptor.enumerable,
			get() {
				return srcDescriptor.get.call(this);
			},
			set(value) {
				const url = versionedAudioUrl(value);
				srcDescriptor.set.call(this, url);
				maybePlayShortFromSource(this, url);
			},
		});
	}

	/**
	 * 最后的兜底：iOS 27 在并发时会直接卸载 media element（duration 恒为 0），
	 * 这时 play/playing 事件可能完全不触发，声音就没了。
	 * 只要元素带 autoplay（游戏里的 playAudio 都是这样），
	 * 就自己解码并直接播放，不依赖原生元素是否加载成功。
	 */
	function maybePlayShortFromSource(element, url) {
		if (debug.disabled || !url || undecodable.has(url)) return;
		if (element.tagName !== "AUDIO") return;
		if (!element.autoplay) return;
		queueMicrotask(() => {
			if (element.__nonameBuffered || element.ended) return;
			decodeAudio(url)
				.then(buffer => {
					if (element.__nonameBuffered || element.ended) return;
					if (buffer.duration > SHORT_AUDIO_SECONDS) return;
					startBuffer(element, buffer);
				})
				.catch(() => {});
		});
	}

	const nativePlay = proto.play;
	if (typeof nativePlay === "function") {
		proto.play = function play(...args) {
			// 只有短音频走 buffer；BGM / 视频继续走 MediaElementSource
			const duration = this.duration;
			if (this.tagName === "AUDIO" && Number.isFinite(duration) && duration > 0 && duration <= SHORT_AUDIO_SECONDS) {
				return playShort(this, nativePlay, args);
			}
			// 时长未知时先别接管：MediaElementSource 会吞掉开头 0.3~0.6 秒，
			// 对 1 秒左右的音效来说等于没声音；等 loadedmetadata 再决定
			if (Number.isFinite(duration) && duration > SHORT_AUDIO_SECONDS) {
				try {
					routeMedia(this);
				} catch {}
			}
			return nativePlay.apply(this, args);
		};
	}

	// 资源一开始加载就预解码（比 loadedmetadata 更早），尽量保证第一次播放时
	// buffer 已经就绪，否则第一次播放只能走原生、音量不受控
	document.addEventListener(
		"loadstart",
		event => {
			const element = event.target;
			if (!(element instanceof HTMLAudioElement)) return;
			if (debug.disabled) return;
			const url = element.currentSrc || element.src;
			if (!url || /\/audio\/background\//.test(url)) return;
			if (undecodable.has(url)) return;
			decodeAudio(url).catch(() => {});
		},
		true
	);

	// 元数据就绪后预解码，首次播放也能立刻出声
	document.addEventListener(
		"loadedmetadata",
		event => {
			const element = event.target;
			if (!(element instanceof HTMLAudioElement)) return;
			if (!Number.isFinite(element.duration) || element.duration <= 0) return;
			if (element.duration > SHORT_AUDIO_SECONDS) {
				// 长音频（BGM）走 MediaElementSource
				routeMedia(element);
				return;
			}
			if (debug.disabled) return;
			const url = element.currentSrc || element.src;
			if (undecodable.has(url)) return;
			decodeAudio(url)
				.then(buffer => {
					// autoplay 的元素在 play 事件触发时时长还是 NaN，这里补上 buffer 播放
					if (element.paused || element.ended || shortPlaybacks.has(element)) return;
					element.muted = true;
					if (!startBuffer(element, buffer)) fallbackToNative(element);
				})
				.catch(() => {});
		},
		true
	);

	// autoplay 不会经过 play() 补丁：长音频要接进音频图，短音频要改用 buffer 播放，
	// 否则它就以原生方式播出去（音量不受控，而且会被 iOS 的并发限制掐掉）
	document.addEventListener(
		"play",
		event => {
			const element = event.target;
			if (!(element instanceof HTMLMediaElement)) return;
			// 时长未知：交给 loadedmetadata 处理，绝不在这里接 MediaElementSource
			if (!Number.isFinite(element.duration) || element.duration <= 0) return;
			if (element.duration > SHORT_AUDIO_SECONDS) {
				routeMedia(element);
				return;
			}
			if (debug.disabled || shortPlaybacks.has(element)) return;
			const url = element.currentSrc || element.src;
			if (!url || undecodable.has(url)) return;
			element.muted = true;
			decodeAudio(url)
				.then(buffer => {
					if (!startBuffer(element, buffer)) fallbackToNative(element);
				})
				.catch(() => {
					element.muted = false;
				});
		},
		true
	);

	// 「真正开始出声」时再兜一次底：iOS 27 上 play/loadedmetadata 的先后顺序变了，
	// 只靠那两个事件可能漏掉接管（BGM 会以全音量原生播放、短音效也会绕过 buffer）。
	document.addEventListener(
		"playing",
		event => {
			const element = event.target;
			if (!(element instanceof HTMLMediaElement)) return;
			if (debug.disabled) return;
			if (!Number.isFinite(element.duration) || element.duration <= 0) return;
			if (element.duration > SHORT_AUDIO_SECONDS) {
				if (!mediaGains.has(element)) routeMedia(element);
				return;
			}
			if (shortPlaybacks.has(element)) return;
			const url = element.currentSrc || element.src;
			if (!url || undecodable.has(url)) return;
			decodeAudio(url)
				.then(buffer => {
					if (element.ended || shortPlaybacks.has(element)) return;
					if (!startBuffer(element, buffer)) fallbackToNative(element);
				})
				.catch(() => {});
		},
		true
	);

	// 不再监听 emptied / abort / loadstart / pause 去停 buffer：
	// iOS 27 并发播放时会主动卸载或重载 media element，这些事件都会误触发，
	// 一停就把已经出声的音效掐掉（表现为「同时出牌时有的牌没声音」）。
	// buffer 都是 1 秒级的短音效，放完由 source.onended 自然收尾即可。

	// 不要监听 ended 去停 buffer：
	// iOS 27 上没加载成功的元素也会立刻发 ended（duration 为 0），
	// 跟着停就把刚起头的 buffer 掐掉了。buffer 很短，让它自己播完即可。


	// 从后台回来时 context 可能被挂起
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible" && context) resumeContext();
	});

	// MARK: - 解锁

	function unlock() {
		const ctx = resumeContext();
		if (!ctx) return;
		const attachPlaying = () => {
			if (ctx.state !== "running") return;
			keepGraphAlive(ctx);
			document.querySelectorAll("audio, video").forEach(element => {
				if (!element.paused && element.duration > SHORT_AUDIO_SECONDS) routeMedia(element);
			});
		};
		if (ctx.state === "running") attachPlaying();
		else
			ctx.resume()
				.then(() => {
					keepGraphAlive(ctx);
					attachPlaying();
				})
				.catch(() => {});
	}

	["touchstart", "touchend", "click", "keydown"].forEach(type => {
		document.addEventListener(type, unlock, { passive: true, capture: true });
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
