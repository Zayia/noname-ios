import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 把 WebKit 解不了的 MP3 转成 AAC（仍然使用 .mp3 文件名）。
 *
 * 背景：iOS 的 `decodeAudioData` 对一部分低码率 MP3（主要是 MPEG-2 Layer III @32kbps）
 * 会直接抛 `EncodingError`，例如 `audio/card/male/guohe.mp3`（过河拆桥）。
 * 这类文件只能退回原生播放：声音完整，但音量不可控。
 *
 * 处理方式：构建时用 macOS 自带的 `afconvert` 把它们转成 64kbps AAC，
 * 文件内容变成 MP4 容器，但文件名仍保持 `.mp3`（游戏里的路径不能动）。
 * 本地 HTTP 服务会按文件头（`ftyp`）返回 `audio/mp4`，浏览器/`decodeAudioData`
 * 都能正常识别，于是它们也能走 AudioBuffer 路径，音量就可控了。
 */

export interface TranscodeResult {
	converted: number;
	skipped: number;
	failed: number;
	bytesBefore: number;
	bytesAfter: number;
	elapsedMs: number;
}

/** 只读文件头，避免为了看 4 个字节把整首歌读进内存 */
function readHead(file: string, bytes: number): Buffer | null {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const buffer = Buffer.alloc(bytes);
		const read = readSync(fd, buffer, 0, bytes, 0);
		return buffer.subarray(0, read);
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** 读取 MP3 帧头，返回码率（kbps）和 MPEG 版本；不是 MP3 返回 null。 */
function parseMp3Header(file: string): { bitrate: number; version: number; layer: number } | null {
	// 帧头最多在 ID3 之后，读前 64KB 足够覆盖超长 ID3
	const data = readHead(file, 64 * 1024);
	if (!data) return null;

	let offset = 0;
	if (data.length > 10 && data.toString("latin1", 0, 3) === "ID3") {
		const size = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
		offset = 10 + size;
	}

	while (offset < data.length - 4) {
		if (data[offset] === 0xff && (data[offset + 1] & 0xe0) === 0xe0) {
			const b1 = data[offset + 1];
			const b2 = data[offset + 2];
			const version = (b1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
			const layer = (b1 >> 1) & 0x03; // 1=Layer III
			const bitrateIndex = (b2 >> 4) & 0x0f;
			const table =
				version === 3
					? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
					: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
			return { bitrate: table[bitrateIndex] ?? 0, version, layer };
		}
		offset++;
	}
	return null;
}

/** MP4/ AAC 文件在偏移 4 处是 `ftyp` */
function isMp4Container(file: string): boolean {
	const head = readHead(file, 12);
	return !!head && head.length >= 8 && head.toString("latin1", 4, 8) === "ftyp";
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

/**
 * 扫描 `audioRoot` 下的 mp3，把低码率 MPEG-2/2.5 Layer III 转成 AAC。
 *
 * 只处理「WebKit 大概率解不了」的那一类（码率 ≤ 32kbps），
 * 转换是幂等的：已经是 MP4 容器的文件会跳过。
 */
export function transcodeAudio(audioRoot: string, options: { dryRun?: boolean; concurrency?: number } = {}): TranscodeResult {
	const startedAt = Date.now();
	const result: TranscodeResult = { converted: 0, skipped: 0, failed: 0, bytesBefore: 0, bytesAfter: 0, elapsedMs: 0 };

	if (!existsSync(audioRoot)) return result;

	if (spawnSync("afconvert", ["-h"], { stdio: "ignore" }).error) {
		console.warn("    ⚠ 找不到 afconvert（需要 macOS），跳过音频转码");
		return result;
	}

	const files = walk(audioRoot).filter(file => file.toLowerCase().endsWith(".mp3"));
	const jobs: string[] = [];

	for (const file of files) {
		if (isMp4Container(file)) {
			result.skipped++;
			continue;
		}
		const header = parseMp3Header(file);
		// 不是可解析的 MP3，或者码率高于 32kbps：不动它
		if (!header || header.layer !== 1 || header.bitrate === 0 || header.bitrate > 32) {
			result.skipped++;
			continue;
		}
		jobs.push(file);
	}

	if (!jobs.length) return result;

	if (options.dryRun) {
		console.log(`    [dry-run] 需要转码 ${jobs.length} 个文件`);
		return { ...result, converted: jobs.length };
	}

	for (const file of jobs) {
		const temp = `${file}.tmp.m4a`;
		const before = statSync(file).size;
		const run = spawnSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", "64000", file, temp], { stdio: "ignore" });
		if (run.status !== 0 || !existsSync(temp)) {
			rmSync(temp, { force: true });
			result.failed++;
			continue;
		}
		renameSync(temp, file); // 保持 .mp3 文件名
		result.converted++;
		result.bytesBefore += before;
		result.bytesAfter += statSync(file).size;
	}

	result.elapsedMs = Date.now() - startedAt;
	return result;
}

// 允许单独运行：tsx scripts/transcodeAudio.ts <audioDir> [--dry-run]
if (process.argv[1]?.endsWith("transcodeAudio.ts")) {
	const dir = process.argv[2];
	const dryRun = process.argv.includes("--dry-run");
	if (!dir) {
		console.error("用法: tsx scripts/transcodeAudio.ts <audioDir> [--dry-run]");
		process.exit(1);
	}
	const result = transcodeAudio(dir, { dryRun });
	const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	console.log(
		`转码完成：${result.converted} 个，跳过 ${result.skipped} 个，失败 ${result.failed} 个，` +
			`${mb(result.bytesBefore)} → ${mb(result.bytesAfter)}，耗时 ${(result.elapsedMs / 1000).toFixed(1)}s`
	);
}
