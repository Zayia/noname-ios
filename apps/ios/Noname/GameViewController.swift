import UIKit
import WebKit

/// 游戏主界面：一个全屏 WKWebView，加载内置本地服务器上的 `index.html`。
final class GameViewController: UIViewController {
	private var webView: WKWebView!
	private let server = LocalServer.shared
	private var serverPort: UInt16 = 0
	private var downloadDestinations: [ObjectIdentifier: URL] = [:]

	private static let landscape: UIInterfaceOrientationMask = .landscape

	override func viewDidLoad() {
		super.viewDidLoad()

		view.backgroundColor = .black

		do {
			serverPort = try server.start()
		} catch {
			showFatalError("本地文件服务启动失败：\(error)")
			return
		}

		setupWebView()
		#if DEBUG
		server.debugEvaluate = { [weak self] script, completion in
			DispatchQueue.main.async {
				self?.webView.callAsyncJavaScript(
					"return await (0, eval)(__nonameScript);",
					arguments: ["__nonameScript": script],
					in: nil,
					in: .page
				) { result in
					switch result {
					case .success(let value):
						completion(value)
					case .failure(let error):
						completion("ERROR: \(error.localizedDescription)")
					}
				}
			}
		}
		#endif
		loadGame()
		prepareUserDocuments()
	}

	// MARK: - 界面

	private func setupWebView() {
		let configuration = WKWebViewConfiguration()
		configuration.allowsInlineMediaPlayback = true
		configuration.mediaTypesRequiringUserActionForPlayback = []
		configuration.allowsAirPlayForMediaPlayback = true
		configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
		configuration.defaultWebpagePreferences.allowsContentJavaScript = true
		configuration.websiteDataStore = .default()

		// 允许本地页面打开新窗口（game.open）
		configuration.userContentController.add(self, name: "noname")

		// 关闭长按菜单、双击缩放，贴近原生客户端的手感
		let css = """
		html { -webkit-touch-callout: none; -webkit-user-select: none; }
		"""
		let style = WKUserScript(
			source: "var s=document.createElement('style');s.textContent=\(jsString(css));document.documentElement.appendChild(s);",
			injectionTime: .atDocumentStart,
			forMainFrameOnly: false
		)
		configuration.userContentController.addUserScript(style)

		#if DEBUG
		// 自动化测试/截图时跳过 GPL 确认弹窗
		if ProcessInfo.processInfo.environment["NONAME_AUTO_CONFIRM"] == "1" {
			let autoConfirm = WKUserScript(
				source: "try { localStorage.setItem('gplv3_noname_alerted', 'true'); } catch (e) {}",
				injectionTime: .atDocumentStart,
				forMainFrameOnly: true
			)
			configuration.userContentController.addUserScript(autoConfirm)
		}
		#endif

		webView = WKWebView(frame: .zero, configuration: configuration)
		webView.translatesAutoresizingMaskIntoConstraints = false
		webView.navigationDelegate = self
		webView.uiDelegate = self
		webView.allowsBackForwardNavigationGestures = false
		webView.scrollView.bounces = false
		webView.scrollView.contentInsetAdjustmentBehavior = .never
		webView.scrollView.showsVerticalScrollIndicator = false
		webView.scrollView.showsHorizontalScrollIndicator = false
		webView.isOpaque = false
		webView.backgroundColor = .black
		webView.scrollView.backgroundColor = .black
		#if DEBUG
		if #available(iOS 16.4, *) {
			webView.isInspectable = true
		}
		#endif

		view.addSubview(webView)

		// 让 WebView 落在安全区内：
		// iPhone 横屏时刘海在左右两侧、底部有 Home 指示条，游戏顶部的系统按钮
		// 和底部的操作区正好会被挡住，这里直接避开安全区，用黑色填充。
		NSLayoutConstraint.activate([
			webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
			webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
			webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
			webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
		])
	}

	private func loadGame() {
		guard let url = URL(string: "http://127.0.0.1:\(serverPort)/index.html") else {
			showFatalError("地址无效")
			return
		}
		webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
	}

	/// 在「文件」App 里放一份说明，方便玩家自行放扩展 / 存档。
	private func prepareUserDocuments() {
		let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
		let readme = documents.appendingPathComponent("使用说明.txt")
		let text = """
		无名杀 iOS 版

		【目录说明】
		「文件」App → 我的 iPhone → 无名杀 → Noname 就是游戏的可写目录，
		它的结构和游戏根目录一致，放进去的同名文件会覆盖 App 内置资源
		（删掉同名文件即可恢复内置版本）。游戏里导入的扩展、导出的存档、
		下载的资源也都会保存在这里。

		【安装扩展的三种方式】
		1. 游戏内导入（最方便）：
		   选项 → 扩展 → 获取扩展 → 展开「导入扩展」→ 选择 .zip 扩展包 → 确定。
		   导入成功后会自动重启，扩展默认是关闭的，需要到「扩展」页手动开启。
		2. 从「文件」App 放进去：
		   把整个扩展文件夹（含 extension.js 或 info.json）拷到 Noname/extension/ 下，
		   然后在 选项 → 通用 里打开「自动导入扩展」并重启游戏。
		   （也可以重启后在 选项 → 扩展 里手动开启）
		3. 用「文件」App 直接替换资源：
		   例如把自定义图片放到 Noname/image/ 下，会覆盖内置图片。

		【备份 / 迁移存档】
		存档与配置在 App 的 IndexedDB 里；要迁移请用游戏内的
		选项 → 其它 → 导出游戏设置 / 导出存档，再用另一台设备导入。
		Noname/ 目录本身可以直接整包拷出来备份。

		【注意】
		免费 Apple ID 签名的 App 7 天过期，重签时请「覆盖安装」，
		不要先删除 App，否则存档和这里放的文件会一起丢失。
		"""
		try? text.write(to: readme, atomically: true, encoding: .utf8)
	}

	private func showFatalError(_ message: String) {
		let label = UILabel()
		label.text = message
		label.numberOfLines = 0
		label.textColor = .white
		label.textAlignment = .center
		label.translatesAutoresizingMaskIntoConstraints = false
		view.addSubview(label)
		NSLayoutConstraint.activate([
			label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
			label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
			label.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, multiplier: 0.8),
		])
	}

	// MARK: - 系统栏 / 旋转

	override var supportedInterfaceOrientations: UIInterfaceOrientationMask { Self.landscape }
	override var prefersStatusBarHidden: Bool { true }
	override var prefersHomeIndicatorAutoHidden: Bool { true }
	override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }

	// MARK: - 分享

	func shareFile(at url: URL) {
		// 已经弹着别的界面时（例如 JS alert）不要再叠加，避免 present 失败
		guard presentedViewController == nil else { return }
		let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
		activity.popoverPresentationController?.sourceView = view
		activity.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
		present(activity, animated: true)
	}
}

// MARK: - WKScriptMessageHandler

extension GameViewController: WKScriptMessageHandler {
	func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
		guard let payload = message.body as? [String: Any], let action = payload["action"] as? String else { return }

		switch action {
		case "export":
			guard let relative = payload["path"] as? String else { return }
			let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
			let url = documents.appendingPathComponent("Noname").appendingPathComponent(relative)
			guard FileManager.default.fileExists(atPath: url.path) else { return }
			shareFile(at: url)

		case "exit":
			break

		case "log":
			// NSLog 的第一个参数是格式串：页面日志里可能含 %（例如 URL 编码），
			// 直接插值会被当作格式符，必须用 "%@" 包一层。
			NSLog("%@", "[Noname] \(payload["message"] ?? "")")

		default:
			break
		}
	}
}

// MARK: - WKNavigationDelegate

extension GameViewController: WKNavigationDelegate {
	func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		NSLog("[Noname] provisional navigation failed: \(error)")
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		NSLog("[Noname] page loaded")
	}

	/// 页面里 <a download> 触发的下载（例如旧版导出逻辑）。
	func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
		if navigationAction.shouldPerformDownload {
			decisionHandler(.download)
			return
		}
		decisionHandler(.allow)
	}

	func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
		if !navigationResponse.canShowMIMEType {
			decisionHandler(.download)
			return
		}
		decisionHandler(.allow)
	}

	func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
		download.delegate = self
	}

	func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
		download.delegate = self
	}
}

// MARK: - WKDownloadDelegate

extension GameViewController: WKDownloadDelegate {
	func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
		let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
		let exports = documents.appendingPathComponent("Noname/export", isDirectory: true)
		try? FileManager.default.createDirectory(at: exports, withIntermediateDirectories: true)

		let destination = exports.appendingPathComponent(suggestedFilename.isEmpty ? "noname" : suggestedFilename)
		try? FileManager.default.removeItem(at: destination)
		downloadDestinations[ObjectIdentifier(download)] = destination
		completionHandler(destination)
	}

	func downloadDidFinish(_ download: WKDownload) {
		if let url = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) {
			shareFile(at: url)
		}
	}

	func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
		NSLog("[Noname] download failed: \(error)")
	}
}

// MARK: - WKUIDelegate

extension GameViewController: WKUIDelegate {
	func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
		let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
		alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler() })
		present(alert, animated: true)
	}

	func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
		let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
		alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
		alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
		present(alert, animated: true)
	}

	func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
		let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
		alert.addTextField { field in field.text = defaultText }
		alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
		alert.addAction(UIAlertAction(title: "确定", style: .default) { [weak alert] _ in
			completionHandler(alert?.textFields?.first?.text)
		})
		present(alert, animated: true)
	}

	/// `window.open` / `target=_blank`：交给系统浏览器
	func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
		if let url = navigationAction.request.url, url.scheme == "http" || url.scheme == "https" {
			UIApplication.shared.open(url)
		}
		return nil
	}
}

/// 把 Swift 字符串转成 JS 字符串字面量。
func jsString(_ value: String) -> String {
	let data = try! JSONSerialization.data(withJSONObject: [value], options: [])
	var text = String(data: data, encoding: .utf8) ?? "[\"\"]"
	text.removeFirst()
	text.removeLast()
	return text
}
