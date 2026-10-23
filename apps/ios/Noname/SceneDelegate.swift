import UIKit

/// 场景代理：负责创建承载游戏的窗口。
///
/// iOS 27 起，用 iOS 27 SDK 构建的 App 必须采用 UIScene 生命周期，
/// 否则启动时会被 UIKit 以 runtime issue 直接终止：
///
/// ```
/// Application failed to launch: UIScene life cycle is required for apps built with this SDK.
/// EXC_BREAKPOINT (SIGTRAP) _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption
/// ```
///
/// 这正是「签完名一打开就闪退」的原因：之前只有 iOS 26.5 模拟器可测，
/// 而 iOS 26 对旧生命周期只是打印警告，iOS 27 才真正拒绝启动。
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
	var window: UIWindow?

	func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
		guard let windowScene = scene as? UIWindowScene else { return }

		let window = UIWindow(windowScene: windowScene)
		window.rootViewController = GameViewController()
		window.makeKeyAndVisible()
		self.window = window
	}
}
