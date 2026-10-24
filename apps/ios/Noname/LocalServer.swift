import Foundation
import Network

/// 内置的本地 HTTP 服务。
///
/// 设计目标与 PC 端的 `noname-server` 保持一致：
///
/// * 用 `http://127.0.0.1:端口/` 提供整个游戏目录的静态文件；
/// * 同时实现 `@noname/fs` 约定的文件读写接口（`/checkFile`、`/readFile`、`/writeFile` ……），
///   这样游戏前端的 `init/browser.js` 可以原样复用，不需要为 iOS 单独写一份 preload。
///
/// 读取顺序是「可写覆盖层 → 只读内置资源」：
/// 沙盒 `Documents/Noname` 是可写层，App 包内的 `web/` 是只读层。
/// 因此玩家通过「文件」App 放进来的扩展、以及游戏内导入的扩展，都会覆盖内置资源。
final class LocalServer {
	static let shared = LocalServer()

	private let queue = DispatchQueue(label: "com.libnoname.noname.http")
	private let fileManager = FileManager.default
	private var listener: NWListener?
	/// 必须持有连接对象，否则 `HTTPConnection` 会在 `start()` 返回后立刻释放。
	private var connections: [ObjectIdentifier: HTTPConnection] = [:]

	/// 只读层：App 包内的 `web/`。
	private(set) var webRoot: URL!
	/// 可写层：`Documents/Noname`。
	private(set) var dataRoot: URL!

	private(set) var port: UInt16 = 0

	#if DEBUG
	/// 仅调试构建可用：在 WebView 中执行 JS，便于自动化验证。
	var debugEvaluate: ((String, @escaping (Any?) -> Void) -> Void)?
	#endif

	private init() {}

	/// 启动服务，返回实际监听的端口。
	///
	/// 端口必须固定，否则每次启动的 origin（`http://127.0.0.1:端口`）都会变化，
	/// 导致 localStorage / IndexedDB 里的存档与配置全部丢失。
	@discardableResult
	func start(preferredPorts: [UInt16] = [19530, 19531, 19532, 19533, 19534]) throws -> UInt16 {
		if listener != nil {
			return port
		}

		guard let web = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true) else {
			throw ServerError.missingWebRoot
		}
		webRoot = web

		let documents = fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
		dataRoot = documents.appendingPathComponent("Noname", isDirectory: true)
		try? fileManager.createDirectory(at: dataRoot, withIntermediateDirectories: true)

		var lastError: Error = ServerError.portUnavailable
		for candidate in preferredPorts {
			do {
				try startListener(port: candidate)
				port = candidate
				NSLog("[Noname] local server listening on http://127.0.0.1:\(candidate)")
				return candidate
			} catch {
				lastError = error
				NSLog("[Noname] failed to bind port \(candidate): \(error)")
			}
		}

		throw lastError
	}

	private func startListener(port candidate: UInt16) throws {
		guard let nwPort = NWEndpoint.Port(rawValue: candidate) else {
			throw ServerError.portUnavailable
		}

		let parameters = NWParameters.tcp
		parameters.allowLocalEndpointReuse = true
		// 只监听回环地址，避免同一局域网内的其它设备访问到游戏文件
		parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: nwPort)

		let newListener = try NWListener(using: parameters)
		newListener.newConnectionHandler = { [weak self] connection in
			guard let self else {
				connection.cancel()
				return
			}
			let httpConnection = HTTPConnection(connection: connection, server: self, queue: self.queue)
			self.connections[ObjectIdentifier(httpConnection)] = httpConnection
			httpConnection.start()
		}

		let ready = DispatchSemaphore(value: 0)
		var startupError: Error?
		newListener.stateUpdateHandler = { state in
			switch state {
			case .ready:
				ready.signal()
			case .failed(let error):
				startupError = error
				ready.signal()
			default:
				break
			}
		}

		newListener.start(queue: queue)
		if ready.wait(timeout: .now() + 3) == .timedOut {
			newListener.cancel()
			throw ServerError.portUnavailable
		}

		if let startupError {
			newListener.cancel()
			throw startupError
		}

		listener = newListener
	}

	func connectionDidClose(_ connection: HTTPConnection) {
		connections.removeValue(forKey: ObjectIdentifier(connection))
	}

	func stop() {
		listener?.cancel()
		listener = nil
	}

	// MARK: - 路径解析

	/// 把请求路径规范化为相对路径，拒绝越界访问。
	func relativePath(_ rawPath: String) -> String? {
		var path = rawPath
		if let questionMark = path.firstIndex(of: "?") {
			path = String(path[path.startIndex..<questionMark])
		}
		if path.contains("\0") { return nil }

		var parts: [String] = []
		for component in path.split(separator: "/", omittingEmptySubsequences: true) {
			let part = String(component)
			if part == "." { continue }
			if part == ".." { return nil }
			parts.append(part)
		}
		return parts.joined(separator: "/")
	}

	func dataURL(for relativePath: String) -> URL {
		dataRoot.appendingPathComponent(relativePath)
	}

	func bundleURL(for relativePath: String) -> URL {
		webRoot.appendingPathComponent(relativePath)
	}

	/// 覆盖层优先，其次内置资源。
	func resolve(relativePath: String) -> URL? {
		let overlay = dataURL(for: relativePath)
		if fileManager.fileExists(atPath: overlay.path) {
			return overlay
		}
		let bundled = bundleURL(for: relativePath)
		if fileManager.fileExists(atPath: bundled.path) {
			return bundled
		}
		return nil
	}

	func isDirectory(_ url: URL) -> Bool {
		var isDirectory: ObjCBool = false
		let exists = fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory)
		return exists && isDirectory.boolValue
	}

	// MARK: - 请求分发

	func handle(_ request: HTTPRequest, completion: @escaping (HTTPResponse) -> Void) {
		#if DEBUG
		NSLog("%@", "[Noname] \(request.method) \(request.path)")
		if request.path == "/__eval" {
			// 调试接口会在 WebView 里执行 JS，而这段 JS 往往又要请求本服务。
			// 如果它跑在串行队列上，就会把队列堵住、等自己的请求，直到超时才返回。
			// 所以单独放到全局队列，主队列保持可用。
			DispatchQueue.global(qos: .userInitiated).async {
				let response = self.route(request)
				completion(response)
			}
			return
		}
		#endif
		queue.async {
			let response = self.route(request)
			completion(response)
		}
	}

	private func route(_ request: HTTPRequest) -> HTTPResponse {
		switch request.path {
		case "/checkFile":
			return fileTypeResponse(path: request.query["fileName"])
		case "/checkDir":
			return fileTypeResponse(path: request.query["dir"])
		case "/readFile":
			return readFile(request.query["fileName"], asText: false)
		case "/readFileAsText":
			return readFile(request.query["fileName"], asText: true)
		case "/writeFile":
			return writeFile(request.body)
		case "/removeFile":
			return removeFile(request.query["fileName"])
		case "/removeDir":
			return removeDir(request.query["dir"])
		case "/getFileList":
			return listDirectory(request.query["dir"] ?? "")
		case "/createDir":
			return createDirectory(request.query["dir"] ?? "")
		#if DEBUG
		case "/__eval":
			return debugEval(script: request.query["js"] ?? "")
		#endif
		default:
			break
		}

		guard request.method == "GET" || request.method == "HEAD" else {
			return .failure("Method Not Allowed", status: 405)
		}
		return serveStatic(request)
	}

	#if DEBUG
	private func debugEval(script: String) -> HTTPResponse {
		guard let evaluate = debugEvaluate else {
			return .failure("调试接口未启用", status: 500)
		}

		let semaphore = DispatchSemaphore(value: 0)
		var output: Any?
		evaluate(script) { result in
			output = result
			semaphore.signal()
		}
		_ = semaphore.wait(timeout: .now() + 5)
		return .ok(output ?? NSNull())
	}
	#endif

	// MARK: - 静态文件

	private func serveStatic(_ request: HTTPRequest) -> HTTPResponse {
		guard var relative = relativePath(request.path) else {
			return .failure("非法路径", status: 403)
		}

		if relative.isEmpty || relative.hasSuffix("/") {
			relative += "index.html"
		}

		var url = resolve(relativePath: relative)
		if let candidate = url, isDirectory(candidate) {
			url = resolve(relativePath: relative + "/index.html")
		}

		guard let fileURL = url, !isDirectory(fileURL) else {
			return .text("404 Not Found: \(request.path)", status: 404)
		}

		guard let data = try? Data(contentsOf: fileURL, options: .mappedIfSafe) else {
			return .text("403 Forbidden", status: 403)
		}

		let contentType = contentType(for: fileURL, data: data)
		var headers: [String: String] = [
			"Content-Type": contentType,
			"Accept-Ranges": "bytes",
			"Cache-Control": cacheControl(for: fileURL.path),
		]

		// Range 请求：音频、视频拖动进度条时必需
		if let rangeHeader = request.headers["range"], let range = ByteRange.parse(rangeHeader, total: data.count) {
			let slice = data.subdata(in: range.start..<range.end)
			headers["Content-Range"] = "bytes \(range.start)-\(range.end - 1)/\(data.count)"
			headers["Content-Type"] = contentType
			return HTTPResponse(status: 206, headers: headers, body: request.method == "HEAD" ? Data() : slice)
		}

		if request.method == "HEAD" {
			headers["Content-Length"] = String(data.count)
			return HTTPResponse(status: 200, headers: headers, body: Data())
		}
		return HTTPResponse(status: 200, headers: headers, body: data)
	}

	/// 构建脚本会把非 BGM 的音频统一转成 AAC（文件名仍是 .mp3），
	/// 素材里也有扩展名是 .mp3、内容其实是 WAV/Ogg 的文件。
	/// 这里按文件头返回正确的 MIME，否则浏览器会按 audio/mpeg 解错。
	private func contentType(for url: URL, data: Data) -> String {
		guard url.pathExtension.lowercased() == "mp3", data.count >= 12 else {
			return MimeType.of(path: url.path)
		}
		if data.subdata(in: 4..<8) == Data("ftyp".utf8) {
			return "audio/mp4"
		}
		if data.subdata(in: 0..<4) == Data("RIFF".utf8), data.subdata(in: 8..<12) == Data("WAVE".utf8) {
			return "audio/wav"
		}
		if data.subdata(in: 0..<4) == Data("OggS".utf8) {
			return "audio/ogg"
		}
		if data[0] == 0xff, (data[1] & 0xf6) == 0xf0 {
			return "audio/aac" // ADTS
		}
		return MimeType.of(path: url.path)
	}

	private func cacheControl(for path: String) -> String {
		let ext = (path as NSString).pathExtension.lowercased()
		switch ext {
		// 音频/视频只做协商缓存：构建时可能会把 mp3 转成 AAC，长缓存会拿到旧字节
		case "mp3", "ogg", "wav", "m4a", "mp4", "webm":
			return "no-cache"
		case "png", "jpg", "jpeg", "gif", "webp", "woff", "woff2", "ttf", "otf":
			return "public, max-age=604800"
		default:
			return "no-cache"
		}
	}

	// MARK: - 文件系统接口

	/// `/checkFile`、`/checkDir` 的响应。
	///
	/// 必须和 PC 端的 `@noname/fs` 服务（packages/fs）保持一致：`data` 是**字符串**
	/// `"file"` / `"directory"`，路径不存在时是 `null`。
	///
	/// 之前这里返回的是 `{ "type": "file" }` 这样的对象，而前端 `BrowserAdapter.stat()`
	/// 判断的是 `data === "file"`，于是所有 `checkFile` 都变成「不存在」：
	/// 表现就是「自动导入扩展」永远导入不了新扩展、`重置无效扩展` 会把所有扩展删掉。
	private func fileTypeResponse(path: String?) -> HTTPResponse {
		guard let raw = path, let relative = relativePath(raw) else {
			return .failure("缺少路径参数")
		}
		guard !relative.isEmpty else { return .ok(nil) }

		if let url = resolve(relativePath: relative) {
			return .ok(isDirectory(url) ? "directory" : "file")
		}
		return .ok(nil)
	}

	private func readFile(_ path: String?, asText: Bool) -> HTTPResponse {
		guard let raw = path, let relative = relativePath(raw), !relative.isEmpty else {
			return .failure("缺少文件名")
		}
		guard let url = resolve(relativePath: relative) else {
			return .failure("\(relative) 不存在")
		}
		guard !isDirectory(url) else {
			return .failure("\(relative) 不是文件")
		}
		guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
			return .failure("无法读取 \(relative)")
		}

		if asText {
			guard let text = String(data: data, encoding: .utf8) else {
				return .failure("\(relative) 不是 UTF-8 文本")
			}
			return .ok(text)
		}
		return .ok(data.base64EncodedString())
	}

	private func writeFile(_ body: Data) -> HTTPResponse {
		guard
			let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
			let rawPath = object["path"] as? String,
			let relative = relativePath(rawPath),
			!relative.isEmpty
		 else {
			return .failure("请求体格式错误")
		}

		let data: Data?
		if let bytes = object["data"] as? [Int] {
			data = Data(bytes.map { UInt8(clamping: $0) })
		} else if let base64 = object["data"] as? String {
			data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters)
		} else {
			data = nil
		}
		guard let contents = data else {
			return .failure("缺少写入数据")
		}

		let target = dataURL(for: relative)
		do {
			try fileManager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
			try contents.write(to: target, options: .atomic)
			return .ok(true)
		} catch {
			return .failure("写入失败: \(error.localizedDescription)")
		}
	}

	private func createDirectory(_ rawPath: String) -> HTTPResponse {
		guard let relative = relativePath(rawPath) else {
			return .failure("非法路径")
		}
		do {
			try fileManager.createDirectory(at: dataURL(for: relative), withIntermediateDirectories: true)
			return .ok(true)
		} catch {
			return .failure("创建目录失败: \(error.localizedDescription)")
		}
	}

	private func removeFile(_ path: String?) -> HTTPResponse {
		guard let raw = path, let relative = relativePath(raw), !relative.isEmpty else {
			return .failure("缺少文件名")
		}
		let target = dataURL(for: relative)
		guard fileManager.fileExists(atPath: target.path) else {
			if resolve(relativePath: relative) != nil {
				return .failure("内置资源只读: \(relative)")
			}
			return .failure("\(relative) 不存在")
		}
		guard !isDirectory(target) else {
			return .failure("\(relative) 不是文件")
		}
		do {
			try fileManager.removeItem(at: target)
			return .ok(true)
		} catch {
			return .failure("删除失败: \(error.localizedDescription)")
		}
	}

	private func removeDir(_ path: String?) -> HTTPResponse {
		guard let raw = path, let relative = relativePath(raw), !relative.isEmpty else {
			return .failure("缺少目录名")
		}
		let target = dataURL(for: relative)
		guard fileManager.fileExists(atPath: target.path) else {
			if resolve(relativePath: relative) != nil {
				return .failure("内置资源只读: \(relative)")
			}
			return .failure("\(relative) 不存在")
		}
		guard isDirectory(target) else {
			return .failure("\(relative) 不是目录")
		}
		do {
			try fileManager.removeItem(at: target)
			return .ok(true)
		} catch {
			return .failure("删除目录失败: \(error.localizedDescription)")
		}
	}

	private func listDirectory(_ rawPath: String) -> HTTPResponse {
		let relative = relativePath(rawPath) ?? ""
		let overlay = dataURL(for: relative)
		let bundled = bundleURL(for: relative)

		var entries: [String: Bool] = [:]
		var sawDirectory = false

		if isDirectory(bundled) {
			sawDirectory = true
			for entry in (try? fileManager.contentsOfDirectory(atPath: bundled.path)) ?? [] {
				guard isVisible(entry) else { continue }
				entries[entry] = isDirectory(bundled.appendingPathComponent(entry))
			}
		}

		if isDirectory(overlay) {
			sawDirectory = true
			for entry in (try? fileManager.contentsOfDirectory(atPath: overlay.path)) ?? [] {
				guard isVisible(entry) else { continue }
				entries[entry] = isDirectory(overlay.appendingPathComponent(entry))
			}
		}

		if !sawDirectory {
			if resolve(relativePath: relative) != nil {
				return .failure("\(relative) 不是文件夹")
			}
			return .failure("\(relative) 不存在")
		}

		var folders: [String] = []
		var files: [String] = []
		for (name, isDir) in entries {
			if isDir {
				folders.append(name)
			} else {
				files.append(name)
			}
		}
		folders.sort()
		files.sort()

		return .ok(["folders": folders, "files": files])
	}

	private func isVisible(_ name: String) -> Bool {
		!name.hasPrefix(".") && !name.hasPrefix("_")
	}

	enum ServerError: Error {
		case missingWebRoot
		case portUnavailable
	}
}

/// 单条 TCP 连接上的 HTTP/1.1 处理。
final class HTTPConnection {
	private let connection: NWConnection
	private unowned let server: LocalServer
	private let queue: DispatchQueue
	private var buffer = Data()
	private var busy = false
	private var receiving = false
	private var closed = false

	init(connection: NWConnection, server: LocalServer, queue: DispatchQueue) {
		self.connection = connection
		self.server = server
		self.queue = queue
	}

	func start() {
		connection.stateUpdateHandler = { [weak self] state in
			switch state {
			case .ready:
				self?.pump()
			case .failed, .cancelled:
				self?.close()
			default:
				break
			}
		}
		connection.start(queue: queue)
	}

	/// 读取更多数据；同一时间只允许有一个未完成的 receive。
	private func pump() {
		guard !closed, !busy, !receiving else { return }
		receiving = true
		connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, isComplete, error in
			guard let self else { return }
			self.receiving = false

			if let data, !data.isEmpty {
				self.buffer.append(data)
			}
			if error != nil {
				self.close()
				return
			}
			if isComplete && self.buffer.isEmpty {
				self.close()
				return
			}

			self.drain()
			if !self.busy {
				self.pump()
			}
		}
	}

	private func drain() {
		guard !busy, !closed else { return }
		guard let parsed = HTTPRequest.parse(from: buffer) else { return }

		buffer.removeFirst(parsed.consumed)
		busy = true

		server.handle(parsed.request) { [weak self] response in
			guard let self, !self.closed else { return }
			let data = response.serialize()
			self.connection.send(content: data, completion: .contentProcessed { [weak self] _ in
				guard let self, !self.closed else { return }
				self.busy = false
				if parsed.request.closeAfterResponse {
					self.close()
				} else {
					self.drain()
					self.pump()
				}
			})
		}
	}

	private func close() {
		guard !closed else { return }
		closed = true
		connection.cancel()
		server.connectionDidClose(self)
	}
}

struct ByteRange {
	let start: Int
	let end: Int

	static func parse(_ header: String, total: Int) -> ByteRange? {
		guard header.lowercased().hasPrefix("bytes=") else { return nil }
		let spec = header.dropFirst("bytes=".count)
		let parts = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
		guard parts.count == 2 else { return nil }

		let startText = parts[0].trimmingCharacters(in: .whitespaces)
		let endText = parts[1].trimmingCharacters(in: .whitespaces)

		if startText.isEmpty {
			// bytes=-500 → 最后 500 字节
			guard let suffix = Int(endText), suffix > 0 else { return nil }
			let start = max(0, total - suffix)
			return ByteRange(start: start, end: total)
		}

		guard let start = Int(startText), start >= 0, start < total else { return nil }
		if endText.isEmpty {
			return ByteRange(start: start, end: total)
		}
		guard let rawEnd = Int(endText) else { return nil }
		let end = min(total, rawEnd + 1)
		guard end > start else { return nil }
		return ByteRange(start: start, end: end)
	}
}

enum MimeType {
	private static let table: [String: String] = [
		"html": "text/html; charset=utf-8",
		"htm": "text/html; charset=utf-8",
		"js": "text/javascript; charset=utf-8",
		"mjs": "text/javascript; charset=utf-8",
		"css": "text/css; charset=utf-8",
		"json": "application/json; charset=utf-8",
		"map": "application/json; charset=utf-8",
		"ts": "text/plain; charset=utf-8",
		"md": "text/markdown; charset=utf-8",
		"txt": "text/plain; charset=utf-8",
		"png": "image/png",
		"jpg": "image/jpeg",
		"jpeg": "image/jpeg",
		"gif": "image/gif",
		"webp": "image/webp",
		"svg": "image/svg+xml",
		"ico": "image/x-icon",
		"mp3": "audio/mpeg",
		"ogg": "audio/ogg",
		"oga": "audio/ogg",
		"wav": "audio/wav",
		"m4a": "audio/mp4",
		"aac": "audio/aac",
		"mp4": "video/mp4",
		"webm": "video/webm",
		"woff": "font/woff",
		"woff2": "font/woff2",
		"ttf": "font/ttf",
		"otf": "font/otf",
		"wasm": "application/wasm",
	]

	static func of(path: String) -> String {
		let ext = (path as NSString).pathExtension.lowercased()
		return table[ext] ?? "application/octet-stream"
	}
}
