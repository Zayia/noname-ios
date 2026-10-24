import Foundation

/// 一次完整的 HTTP 请求。
struct HTTPRequest {
	let method: String
	/// 百分号解码后的路径，例如 `/image/card/standard.jpg`
	let path: String
	let query: [String: String]
	let headers: [String: String]
	let body: Data

	/// 客户端是否要求处理完本次响应后关闭连接。
	var closeAfterResponse: Bool {
		if let connection = headers["connection"], connection.lowercased().contains("close") {
			return true
		}
		return false
	}

	/// 从缓冲区中解析出一个请求；数据不完整时返回 nil。
	static func parse(from buffer: Data) -> (request: HTTPRequest, consumed: Int)? {
		guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
			return nil
		}

		let headerData = buffer[buffer.startIndex..<headerEnd.lowerBound]
		guard let headerText = String(data: headerData, encoding: .utf8) else {
			return nil
		}

		var lines = headerText.components(separatedBy: "\r\n")
		guard !lines.isEmpty else { return nil }

		let requestLine = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true)
		guard requestLine.count >= 2 else { return nil }

		let method = String(requestLine[0]).uppercased()
		let target = String(requestLine[1])

		var headers: [String: String] = [:]
		for line in lines {
			guard let separator = line.firstIndex(of: ":") else { continue }
			let name = line[line.startIndex..<separator].trimmingCharacters(in: .whitespaces).lowercased()
			let value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
			headers[name] = value
		}

		let contentLength = Int(headers["content-length"] ?? "0") ?? 0
		if contentLength < 0 || contentLength > 512 * 1024 * 1024 {
			return nil
		}

		let bodyStart = headerEnd.upperBound
		let available = buffer.distance(from: bodyStart, to: buffer.endIndex)
		if available < contentLength {
			return nil
		}

		let bodyEnd = buffer.index(bodyStart, offsetBy: contentLength)
		let body = Data(buffer[bodyStart..<bodyEnd])
		let consumed = buffer.distance(from: buffer.startIndex, to: bodyEnd)

		var rawPath = target
		var query: [String: String] = [:]
		if let questionMark = target.firstIndex(of: "?") {
			rawPath = String(target[target.startIndex..<questionMark])
			let queryString = String(target[target.index(after: questionMark)...])
			for pair in queryString.split(separator: "&") {
				let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
				let key = String(kv[0]).removingPercentEncoding ?? String(kv[0])
				let value = kv.count > 1 ? (String(kv[1]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String(kv[1])) : ""
				query[key] = value
			}
		}

		let path = (rawPath.removingPercentEncoding ?? rawPath)
		return (
			HTTPRequest(method: method, path: path, query: query, headers: headers, body: body),
			consumed
		)
	}
}

/// 一次 HTTP 响应。
struct HTTPResponse {
	var status: Int = 200
	var headers: [String: String] = [:]
	var body: Data = Data()

	static let reasonPhrases: [Int: String] = [
		200: "OK",
		206: "Partial Content",
		400: "Bad Request",
		403: "Forbidden",
		404: "Not Found",
		405: "Method Not Allowed",
		416: "Range Not Satisfiable",
		500: "Internal Server Error",
	]

	func serialize() -> Data {
		var head = "HTTP/1.1 \(status) \(HTTPResponse.reasonPhrases[status] ?? "OK")\r\n"
		var allHeaders = headers
		if allHeaders["Content-Length"] == nil {
			allHeaders["Content-Length"] = String(body.count)
		}
		allHeaders["Connection"] = allHeaders["Connection"] ?? "keep-alive"
		for (name, value) in allHeaders {
			head += "\(name): \(value)\r\n"
		}
		head += "\r\n"

		var data = Data(head.utf8)
		data.append(body)
		return data
	}

	static func json(_ object: Any, status: Int = 200) -> HTTPResponse {
		let data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{}".utf8)
		return HTTPResponse(status: status, headers: ["Content-Type": "application/json; charset=utf-8"], body: data)
	}

	static func ok(_ data: Any? = nil) -> HTTPResponse {
		var payload: [String: Any] = ["success": true, "code": 200]
		payload["data"] = data ?? NSNull()
		return json(payload)
	}

	static func failure(_ message: String, status: Int = 400) -> HTTPResponse {
		return json(["success": false, "code": status, "errorMsg": message], status: status)
	}

	static func text(_ string: String, status: Int = 200) -> HTTPResponse {
		HTTPResponse(status: status, headers: ["Content-Type": "text/plain; charset=utf-8"], body: Data(string.utf8))
	}
}
