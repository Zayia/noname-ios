# 无名杀 iOS 客户端（自动构建）

《无名杀》的 iOS 原生客户端壳 + 自动打包流水线。仓库里只放 iOS 外壳（`apps/ios/`）和 GitHub Actions
配置；构建时由 CI 拉取官方仓库最新代码，把 `apps/ios` 叠加进去，编译成**未签名 IPA** 并发布到 Releases。

## 下载安装

1. 打开 [Releases](../../releases) 下载最新的 `noname-unsigned-full.ipa`；
2. 用 **Sideloadly** / **AltStore** / **轻松签** / **TrollStore** 自签安装；
3. 免费 Apple ID 签名的 App **7 天有效**；过期后重新签名**覆盖安装**即可，不要先删除 App（会丢存档）。

## 自动更新

- 每天 **北京时间 02:30** 检查一次官方 [`libnoname/noname`](https://github.com/libnoname/noname) 的 `main`；
- 有更新就自动构建并发布 Release，标签格式 `ios-<官方提交>-<iOS客户端提交>-<变体>`；
- 同一组合已经构建过就跳过，不浪费构建时间；只保留最近 **3 个** Release；
- 也可以手动触发：**Actions → Build iOS (unsigned IPA) → Run workflow**
  - `variant`：`full` / `no-audio` / `core`（体积从小到大）
  - `upstream_ref`：官方分支 / 标签 / 提交（默认 `main`）
  - `force`：同一版本强制重建

## 版本核对

游戏内 **选项 → 其它 → 更新** 会显示 `游戏版本：1.11.7 (release @ <官方提交>)`，
其中的 commit 就是构建时嵌入的官方代码版本，可以和 Release 标签对上。

## 本地构建

需要官方仓库 + macOS / Xcode：

```bash
git clone https://github.com/libnoname/noname.git
rsync -a --exclude web --exclude build --exclude node_modules \
  /path/to/noname-ios/apps/ios/ noname/apps/ios/
cd noname
pnpm install
pnpm build
pnpm -F @noname/ios build:ios --skip-web-build
# → apps/ios/build/ipa/noname-unsigned.ipa
```

## 文档

架构、签名安装、扩展导入等技术细节见 [apps/ios/README.md](apps/ios/README.md)。

## 许可

GPL-3.0，与上游一致，见 [LICENSE](LICENSE)。
