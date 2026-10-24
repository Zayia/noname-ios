import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 把 MP3 转成 AAC（仍然使用 .mp3 文件名）。
 *
 * 背景：iOS 的 `decodeAudioData` 对一部分 MP3 会直接抛 `EncodingError`
 * （已知集中在 MPEG-2 Layer III @32kbps，例如 `audio/card/male/guohe.mp3`）。
 * 这类文件只能退回原生播放：声音完整，但音量不可控。
 *
 * 为了保证**所有**音效/台词都能走 AudioBuffer 路径（音量可控），构建时把所有
 * 非 BGM 的 mp3 统一转成 96kbps AAC：
 *   - 文件内容变成 MP4 容器，但文件名仍保持 `.mp3`（游戏里的路径不能动）；
 *   - 本地 HTTP 服务按文件头（`ftyp`）返回 `audio/mp4`；
 *   - BGM（`audio/background/`）不转：它们是长音频，走 MediaElementSource，
 *     音量本来就可控，转了只会白白增加构建时间。
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

/** 读取 MP3 采样率；解析失败返回 null。 */
function sampleRateOf(file: string): number | null {
	const data = readHead(file, 64 * 1024);
	if (!data) return null;

	let offset = 0;
	if (data.length > 10 && data.toString("latin1", 0, 3) === "ID3") {
		const size = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
		offset = 10 + size;
	}

	while (offset < data.length - 4) {
		if (data[offset] === 0xff && (data[offset + 1] & 0xe0) === 0xe0) {
			const version = (data[offset + 1] >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
			const sampleRateIndex = (data[offset + 2] >> 2) & 0x03;
			const table = version === 3 ? [44100, 48000, 32000] : version === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
			return table[sampleRateIndex] ?? null;
		}
		offset++;
	}
	return null;
}

type Container = "mp4" | "wav" | "ogg" | "aac" | "mp3" | "unknown";

/**
 * 按文件头判断真实容器。
 * 素材里有不少“扩展名是 .mp3、内容却不是 mp3”的文件（WAV / Ogg / ADTS），
 * afconvert 会按扩展名选解析器，所以转码时要换成正确的临时扩展名。
 */
function detectContainer(file: string): Container {
	const head = readHead(file, 12);
	if (!head || head.length < 4) return "unknown";
	if (head.length >= 8 && head.toString("latin1", 4, 8) === "ftyp") return "mp4";
	if (head.toString("latin1", 0, 4) === "RIFF" && head.length >= 12 && head.toString("latin1", 8, 12) === "WAVE") return "wav";
	if (head.toString("latin1", 0, 4) === "OggS") return "ogg";
	if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return "aac"; // ADTS
	return "mp3";
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
export function transcodeAudio(audioRoot: string, options: { dryRun?: boolean; bitrate?: number } = {}): TranscodeResult {
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
		// BGM 是长音频，走 MediaElementSource，不需要转
		const relative = file.slice(audioRoot.length + 1).replace(/\\/g, "/");
		if (relative.startsWith("background/")) {
			result.skipped++;
			continue;
		}
		if (detectContainer(file) === "mp4") {
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
		const container = detectContainer(file);
		// 非 mp3 的输入要换成正确的临时扩展名，afconvert 才会用对应的解析器
		const extension = container === "wav" ? "wav" : container === "ogg" ? "ogg" : container === "aac" ? "aac" : null;
		const input = extension ? `${file}.tmp.${extension}` : file;
		if (extension) writeFileSync(input, readFileSync(file));

		const sampleRate = container === "mp3" ? sampleRateOf(file) : null;
		// 低采样率（22.05k/16k…）的 AAC 编码器不支持高码率，统一用 64k；
		// 44.1k/48k 用 96k，音质好一些
		const preferred = options.bitrate ?? (sampleRate && sampleRate <= 24000 ? 64000 : container === "wav" || container === "ogg" ? 64000 : 96000);
		const candidates = [...new Set([preferred, 64000])];
		let ok = false;
		for (const bitrate of candidates) {
			const run = spawnSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", String(bitrate), input, temp], { stdio: "ignore" });
			if (run.status === 0 && existsSync(temp)) {
				ok = true;
				break;
			}
			rmSync(temp, { force: true });
		}
		if (extension) rmSync(input, { force: true });
		if (!ok) {
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
