# 无名杀 iOS 客户端（自动构建）

《无名杀》的 iOS 原生客户端壳 + 自动打包流水线。仓库里只放 iOS 外壳（`apps/ios/`）和 GitHub Actions
配置；构建时由 CI 拉取官方仓库最新代码，把 `apps/ios` 叠加进去，编译成**未签名 IPA** 并发布到 Releases。

## 下载安装

1. 打开 [Releases](../../releases) 下载最新的 `noname-unsigned-full.ipa`；
2. 用 **Sideloadly** / **AltStore** / **轻松签** / **TrollStore** 自签安装；
3. 免费 Apple ID 签名的 App **7 天有效**；过期后重新签名**覆盖安装**即可，不要先删除 App（会丢存档）。

## 自动更新

- 每天 **北京时间 02:30** 检查一次官方 [`libnoname/noname`](https://github.com/libnoname/noname) 的**最新正式版标签**（latest）；
  默认不跟 `main`——`main` 上常是「暂未发布，仅供测试」的版本，版本号比正式版大，
  联机时会被「禁止不同版本玩家进房」拦住；
- 有更新就自动构建并发布 Release，标签格式 `ios-<官方提交>-<iOS客户端提交>-<变体>`；
- 同一组合已经构建过就跳过，不浪费构建时间；只保留最近 **3 个** Release；
- 也可以手动触发：**Actions → Build iOS (unsigned IPA) → Run workflow**
  - `variant`：`full` / `no-audio` / `core`（体积从小到大）
  - `upstream_ref`：官方版本，默认 `latest`（最新正式版标签），也可填 `v1.11.6` 之类的标签或 `main` 测试版
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

## 配套服务端（联机）

《无名杀》联机需要一个 WebSocket 中继服务器。它在 [`docs/server/`](docs/server/) 里有完整的部署方案：

```bash
curl -fsSL https://raw.githubusercontent.com/Zayia/noname-ios/main/docs/server/deploy.sh | sudo bash
```

服务端**极小**——7 个源文件、一个 `ws` 依赖、最终占用约 **470 KB**，
不需要武将立绘/语音/扩展，也不需要构建游戏前端。

部署完在客户端联机地址填 `ws://<域名或公网IP>:<端口>`（**必须带端口**，否则客户端会补成 8080）。

- [部署教程](docs/server/README.md)
- [排障清单](docs/server/TROUBLESHOOTING.md)

## 文档

架构、签名安装、扩展导入等技术细节见 [apps/ios/README.md](apps/ios/README.md)。

服务端部署与排障见 [docs/server/](docs/server/)。

## 许可

GPL-3.0，与上游一致，见 [LICENSE](LICENSE)。
