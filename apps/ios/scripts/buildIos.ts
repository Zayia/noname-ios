import { spawnSync } from "node:child_process";
import { transcodeAudio } from "./transcodeAudio";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * iOS 构建脚本：把 Web 产物装进原生壳，编译出可自签名的 IPA。
 *
 * 用法：
 *   pnpm -F @noname/ios build:ios
 *   pnpm -F @noname/ios build:ios -- --skip-web-build
 *   pnpm -F @noname/ios build:ios -- --no-audio      # 去掉 audio/，体积小一半
 *   pnpm -F @noname/ios build:ios -- --core          # 只保留核心资源（体积最小）
 */

const iosRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(iosRoot, "../..");
const distDir = resolve(workspaceRoot, "dist");
const webDir = resolve(iosRoot, "web");
const buildDir = resolve(iosRoot, "build");
const derivedData = resolve(buildDir, "DerivedData");
const outputDir = resolve(buildDir, "ipa");

const args = new Set(process.argv.slice(2));
const skipWebBuild = args.has("--skip-web-build");
const stripAudio = args.has("--no-audio") || args.has("--core");
const coreOnly = args.has("--core");
const configuration = args.has("--debug") ? "Debug" : "Release";
// CI 用：构建完立刻删掉中间产物（dist/、Payload/），把磁盘占用压到最低
const prune = args.has("--prune");

if (args.has("--help")) {
	console.log(`用法: pnpm build:ios [选项]

选项:
  --skip-web-build   复用已有的 dist/，不再执行 pnpm build
  --no-audio         打包时剔除 audio/（体积约减半）
  --core             只保留核心资源，剔除 audio/ 与 image/（体积最小，需要联网下载资源）
  --debug            构建 Debug 配置
  --prune            构建后删除 dist/ 与 Payload/ 等中间产物（CI 节省磁盘用）
  --no-transcode     跳过「mp3 → AAC」转码（调试用）
  --help             显示帮助
`);
	process.exit(0);
}

console.log("==> 1/5 构建 Web 产物");
if (skipWebBuild) {
	if (!existsSync(distDir)) {
		throw new Error("--skip-web-build 需要先存在 dist/，请先执行 pnpm build");
	}
	console.log("    复用已有 dist/");
} else {
	run("pnpm", ["build"], workspaceRoot, "Web 构建");
}

console.log("==> 2/5 准备 App 内置资源目录");
stageWebAssets();

// 把 WebKit 解不了的低码率 mp3 转成 AAC，让它们也能走 AudioBuffer 路径
if (!args.has("--no-transcode")) {
	const started = Date.now();
	const result = transcodeAudio(join(webDir, "audio"));
	if (result.converted || result.failed) {
		const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		console.log(
			`    音频转码: ${result.converted} 个 → AAC，失败 ${result.failed} 个，` +
				`${mb(result.bytesBefore)} → ${mb(result.bytesAfter)}，耗时 ${((Date.now() - started) / 1000).toFixed(0)}s`
		);
	} else {
		console.log("    音频转码: 无需转码");
	}
}

if (prune) {
	// 资源已经拷进 apps/ios/web/，dist/ 就不再需要了
	rmSync(distDir, { recursive: true, force: true });
	console.log("    已删除 dist/（--prune）");
}

console.log("==> 3/5 生成 Xcode 工程");
ensureProject();

console.log(`==> 4/5 编译 iOS App（${configuration}）`);
rmSync(derivedData, { recursive: true, force: true });
run(
	"xcodebuild",
	[
		"-project",
		join(iosRoot, "Noname.xcodeproj"),
		"-scheme",
		"Noname",
		"-configuration",
		configuration,
		"-sdk",
		"iphoneos",
		"-derivedDataPath",
		derivedData,
		"CODE_SIGNING_ALLOWED=NO",
		"CODE_SIGNING_REQUIRED=NO",
		"CODE_SIGN_IDENTITY=",
		"EXPANDED_CODE_SIGN_IDENTITY=",
		"DEVELOPMENT_TEAM=",
		"ONLY_ACTIVE_ARCH=NO",
		"build",
	],
	iosRoot,
	"xcodebuild"
);

const appPath = resolve(derivedData, `Build/Products/${configuration}-iphoneos/Noname.app`);
if (!existsSync(appPath)) {
	throw new Error(`编译完成但没找到产物: ${appPath}`);
}

console.log("==> 5/6 校验 App 包（iOS 27 启动条件）");
verifyBundle(appPath);

console.log("==> 6/6 打包未签名 IPA");
const ipaPath = packageIPA(appPath);
const size = statSync(ipaPath).size / 1024 / 1024 / 1024;
console.log(`\n✅ 完成: ${ipaPath} (${size.toFixed(2)} GB)`);
console.log("   这是一个未签名 IPA，可用 Sideloadly / AltStore / 自签工具签名后安装。");
console.log("   详细说明见 apps/ios/README.md");

/**
 * iOS 27 起，用 iOS 27（或更新）SDK 构建的 App 必须采用 UIScene 生命周期，
 * 否则一启动就会被 UIKit 终止（EXC_BREAKPOINT / _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption）。
 *
 * 这个错误在 iOS 26 模拟器上完全看不出来（26 只打印警告），所以打包前强制校验，
 * 避免再产出「签名后直接闪退」的 IPA。
 */
function verifyBundle(bundlePath: string) {
	const infoPath = resolve(bundlePath, "Info.plist");
	const result = spawnSync("plutil", ["-convert", "json", "-o", "-", infoPath], { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`读取 Info.plist 失败: ${result.stderr || result.stdout}`);
	}

	const info = JSON.parse(result.stdout) as {
		UIApplicationSceneManifest?: {
			UISceneConfigurations?: Record<string, Array<Record<string, string>>>;
		};
	};
	const configurations = info.UIApplicationSceneManifest?.UISceneConfigurations;
	const applicationConfigurations = configurations?.UIWindowSceneSessionRoleApplication;
	if (!applicationConfigurations || applicationConfigurations.length === 0) {
		throw new Error(
			"Info.plist 缺少 UIApplicationSceneManifest / UISceneConfigurations：\n" +
				"    iOS 27 上这样的 App 会一启动就闪退（UIScene lifecycle is required）。"
		);
	}

	const delegate = applicationConfigurations[0].UISceneDelegateClassName;
	if (!delegate) {
		throw new Error("UISceneDelegateClassName 未配置，场景无法创建");
	}

	const nm = spawnSync("nm", [resolve(bundlePath, "Noname")], { encoding: "utf8" });
	if (nm.status === 0 && !nm.stdout.includes("SceneDelegate")) {
		throw new Error("二进制中找不到 SceneDelegate，请确认 SceneDelegate.swift 已加入编译（Sources）");
	}

	console.log(`    场景代理: ${delegate}`);
	if (nm.status === 0) console.log("    SceneDelegate 符号: 已找到");
}

function stageWebAssets() {
	rmSync(webDir, { recursive: true, force: true });
	mkdirSync(webDir, { recursive: true });
	// 占位文件：保证仓库里 web/ 目录始终存在，Xcode 工程里的文件夹引用不会变红
	writeFileSync(join(webDir, ".gitkeep"), "");

	console.log("    复制 dist/ → apps/ios/web/");
	cpSync(distDir, webDir, {
		recursive: true,
		filter: source => {
			const relative = source.slice(distDir.length).replace(/^\//, "");
			if (!relative) return true;
			if (stripAudio && (relative === "audio" || relative.startsWith("audio/"))) return false;
			if (coreOnly && (relative === "image" || relative.startsWith("image/"))) return false;
			return true;
		},
	});

	// iOS 专用 preload：补上 game.download / game.export
	copyFileSync(resolve(iosRoot, "web-preload.js"), resolve(webDir, "preload.js"));

	// WKWebView 不支持 serviceWorker（仅 app-bound domain 可用），
	// 保留上游注入的 JIT 脚本会弹「无法启用即时编译功能」并额外刷新两次页面，
	// 这里直接把这段内联脚本去掉。
	stripJitBootstrap();

	const indexHtml = resolve(webDir, "index.html");
	if (!existsSync(indexHtml)) {
		throw new Error("dist/index.html 不存在，Web 构建似乎失败了");
	}

	console.log(`    内置资源大小: ${(directorySize(webDir) / 1024 / 1024 / 1024).toFixed(2)} GB`);
}

function stripJitBootstrap() {
	const file = resolve(webDir, "index.html");
	let html = readFileSync(file, "utf8");
	const marker = '<script type="module">// src/entry.ts';
	const start = html.indexOf(marker);
	if (start < 0) return;

	const end = html.indexOf("</script>", start);
	if (end < 0) return;

	html = html.slice(0, start) + html.slice(end + "</script>".length);
	writeFileSync(file, html);
	console.log("    已移除 index.html 中的 serviceWorker/JIT 引导脚本");
}

function ensureProject() {
	const projectPath = resolve(iosRoot, "Noname.xcodeproj");
	const projectYml = resolve(iosRoot, "project.yml");

	const xcodegen = which("xcodegen");
	if (xcodegen) {
		console.log("    使用 XcodeGen 重新生成 Noname.xcodeproj");
		run(xcodegen, ["generate", "--spec", projectYml, "--project", iosRoot], iosRoot, "XcodeGen");
		return;
	}

	if (existsSync(projectPath)) {
		console.log("    未检测到 xcodegen，使用仓库中已生成的 Noname.xcodeproj");
		return;
	}

	throw new Error("找不到 xcodegen，也没有现成的 Noname.xcodeproj。请先安装：brew install xcodegen");
}

function packageIPA(appPath: string) {
	rmSync(outputDir, { recursive: true, force: true });
	const payload = resolve(outputDir, "Payload");
	mkdirSync(payload, { recursive: true });

	const destination = resolve(payload, "Noname.app");
	console.log("    移动 .app 到 Payload/");
	try {
		// 同一分区时用 rename，避免再复制一份 1.3GB（CI 的磁盘只有 14GB）
		renameSync(appPath, destination);
	} catch {
		cpSync(appPath, destination, { recursive: true, verbatimSymlinks: true });
	}

	const ipaPath = resolve(outputDir, "noname-unsigned.ipa");
	rmSync(ipaPath, { force: true });
	run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", "Payload", ipaPath], outputDir, "打包 IPA");

	// 方便核对：记录版本与文件清单
	const info = spawnSync("defaults", ["read", resolve(destination, "Info"), "CFBundleShortVersionString"], { encoding: "utf8" });
	writeFileSync(resolve(outputDir, "BUILD.txt"), `version: ${(info.stdout || "").trim()}\nbuiltAt: ${new Date().toISOString()}\n`);

	if (prune) {
		rmSync(payload, { recursive: true, force: true });
		console.log("    已删除 Payload/（--prune）");
	}
	return ipaPath;
}

function directorySize(path: string): number {
	let total = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const full = join(path, entry.name);
		if (entry.isDirectory()) {
			total += directorySize(full);
		} else if (entry.isFile()) {
			total += statSync(full).size;
		}
	}
	return total;
}

function which(command: string): string | null {
	const result = spawnSync("which", [command], { encoding: "utf8" });
	const path = (result.stdout || "").trim();
	return path.length > 0 ? path : null;
}

function run(command: string, commandArgs: string[], cwd: string, step: string) {
	console.log(`    $ ${command} ${commandArgs.join(" ")}`);
	const result = spawnSync(command, commandArgs, { cwd, stdio: "inherit" });
	if (result.error) {
		throw new Error(`${step} 执行失败: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`${step} 失败，退出码 ${result.status ?? "unknown"}`);
	}
}

void dirname;
