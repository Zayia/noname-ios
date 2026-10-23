import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
	func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
		// 窗口与根控制器由 SceneDelegate 创建：iOS 27 起必须使用 UIScene 生命周期，
		// 在这里手动建 window 的旧写法会让 App 在 iOS 27 上一启动就被系统终止。
		true
	}

	func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
		.landscape
	}

	/// 场景配置的双保险：
	/// `Info.plist` 里已经声明了 `UIApplicationSceneManifest`，这里再提供一份动态配置。
	/// 万一某个签名工具改写了 Info.plist、把场景清单弄丢，App 在 iOS 27 上仍然能启动
	/// （TN3187 允许「清单」或「本方法」二选一）。
	func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
		let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
		configuration.delegateClass = SceneDelegate.self
		return configuration
	}

	func applicationWillTerminate(_ application: UIApplication) {
		LocalServer.shared.stop()
	}
}
