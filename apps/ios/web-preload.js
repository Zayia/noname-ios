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
