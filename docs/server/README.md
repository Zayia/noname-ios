# 配套服务端 · 无名杀联机中继

《无名杀》联机需要一个 WebSocket 中继服务器。本目录给出在 Linux 上部署它的完整方案。

**这套服务端极小**：7 个源文件、一个运行时依赖、最终磁盘占用 **约 470 KB**，
不需要武将立绘、语音、扩展，也不需要构建整个游戏前端。

---

## 1. 先搞清楚服务端是什么

无名杀是**客户端跑游戏逻辑、服务端只转发信令**的模型。`packages/server` 做的事只有：

| 处理的消息 | 作用 |
| --- | --- |
| `roomlist` / `updaterooms` | 房间列表 |
| `createroom` / `join` / `leave` / `close` | 建房、进出房 |
| `updateclients` / `updateevents` | 玩家列表、房间事件同步 |
| `message` | 房间内聊天 |
| `heartbeat` | 保活 |
| `ban` / `banned` / `denied` | 封禁与拒绝 |

源码里 **`version`、`extension`、`image`、`audio`、`character`、`static`、`readFile`、`fs.` 全部零匹配**，
运行时依赖只有 `ws@8`。

由此可以推出三件很重要的事：

1. **服务端不需要任何游戏素材**。立绘、语音、扩展都在客户端里。
2. **服务端不校验版本**。版本一致性要靠你自己保证（见 [§7](#7-版本一致性)）。
3. **服务端不提供网页**。如果玩家都用原生客户端，就完全不需要静态站。
   只有想让没客户端的人用浏览器玩，才需要部署 `dist/`（约 1.2 GB 素材）。

---

## 2. 一键部署

```bash
curl -fsSL https://raw.githubusercontent.com/Zayia/noname-ios/main/docs/server/deploy.sh | sudo bash
```

或者下载下来改参数再跑：

```bash
git clone https://github.com/Zayia/noname-ios.git
cd noname-ios/docs/server
sudo PORT=8091 INSTALL_DIR=/root/docker/noname-srv bash deploy.sh
```

脚本做的事：

1. 从上游按**固定 commit** 拉取 `packages/server` 的 7 个源文件（约 42 KB）
2. `pnpm install` → 只装 `ws`
3. `tsup` 构建 → `dist/cli.js`（约 11 KB）
4. 删掉构建期依赖瘦身（49 MB → 230 KB）
5. 安装 systemd 服务，开机自启、崩溃 3 秒重拉
6. 自检：端口监听 + WebSocket 真连一次

可用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8091` | 监听端口 |
| `INSTALL_DIR` | `/root/docker/noname-srv` | 安装目录 |
| `SERVICE_NAME` | `noname-srv` | systemd 单元名 |
| `UPSTREAM_COMMIT` | 见脚本 | 上游版本，升级时改 |

---

## 3. 手动部署（想知道每一步在干什么）

### 3.1 拉源码

只需要这 7 个文件：

```
package.json  pnpm-lock.yaml  tsup.config.ts
src/cli.ts  src/index.ts  src/types.ts  src/server/createServer.ts
```

```bash
UPSTREAM_COMMIT=1a548c95acdf8ac1ef44d74473403eda2ac86cf0
BASE="https://raw.githubusercontent.com/libnoname/noname/${UPSTREAM_COMMIT}/packages/server"
mkdir -p /root/docker/noname-srv/src/server
cd /root/docker/noname-srv

for f in package.json pnpm-lock.yaml tsup.config.ts \
         src/cli.ts src/index.ts src/types.ts src/server/createServer.ts; do
  curl -fsSL "$BASE/$f" -o "$f"
done

printf 'onlyBuiltDependencies:\n  - esbuild\n' > pnpm-workspace.yaml
```

> **不要克隆整个仓库**。`libnoname/noname` 有 2.55 GB，即使 `--depth 1 --sparse-checkout`
> 也会拉全量 blob（`.git` 就有 1.2 GB）。直接下载这 7 个文件是 76 KB。

### 3.2 安装依赖

```bash
pnpm install --config.strict-dep-builds=false
```

> ⚠️ **必须带 `--config.strict-dep-builds=false`**。
> pnpm 10+ 默认拦截依赖的 build script，esbuild 会被拦下并让 `pnpm install` 直接退出 1。

### 3.3 构建

```bash
./node_modules/.bin/tsup
```

> ⚠️ **不能用 `pnpm build`**。pnpm 11 在执行脚本前会做一次依赖状态校验，
> 那个校验内部又跑 `pnpm install`，于是再次撞上 esbuild 的 build script 检查而失败。
> 直接调用 `tsup` 绕过它。产物是 `dist/cli.js`（11 KB，ESM + CJS 双格式）。

### 3.4 瘦身

```bash
rm -rf node_modules
pnpm install --prod --config.strict-dep-builds=false
```

`tsup`、`typescript`、`esbuild`、`rollup` 这些只在构建时用一次，pnpm 不会自动回收，
不清掉的话 `node_modules` 会一直占 49 MB。清完只剩 `ws`，总占用约 470 KB。

### 3.5 启动

```bash
node dist/cli.js --port 8091
# Server listening on port 8091
```

服务监听 `*:8091`（所有网卡），所以局域网和公网都能连，不需要额外配置绑定地址。

### 3.6 systemd

```bash
sed -e "s|__INSTALL_DIR__|/root/docker/noname-srv|g" \
    -e "s|__NODE_BIN__|$(command -v node)|g" \
    -e "s|__PORT__|8091|g" \
    noname-srv.service > /etc/systemd/system/noname-srv.service

systemctl daemon-reload
systemctl enable --now noname-srv
systemctl status noname-srv
```

---

## 4. 客户端怎么连

### 4.1 地址格式

**必须带端口**：

```
ws://gua.ee:8091
```

### 4.2 为什么必须带端口和 `ws://` 前缀

客户端的 `apps/core/noname/game/index.js` 里，`connect(ip)` 会这样处理玩家输入的地址：

```js
if (URL.canParse(ip) && (ip.startsWith("ws://") || ip.startsWith("wss://"))) {
    tempUrl = new URL(ip);              // 带协议前缀 → 原样使用，不补端口
} else {
    tempUrl = new URL(`${protocol}${ip}`);
    if (ipv4Regex.test(ip)) {
        tempUrl.port = "8080";          // 纯 IP → 强制 8080
    } else if (tempUrl.pathname == "/") {
        // 域名且不带端口 → 也补 8080
        if (!withport) tempUrl.port = "8080";
    }
}
```

实际解析结果：

| 玩家输入 | 实际连接地址 | 结果 |
| --- | --- | --- |
| `ws://gua.ee:8091` | `ws://gua.ee:8091/` | ✅ |
| `gua.ee:8091` | `ws://gua.ee:8091/` | ✅ |
| `gua.ee` | `ws://gua.ee:8080/` | ❌ 端口被补成 8080 |
| `192.168.1.228` | `ws://192.168.1.228:8080/` | ❌ 同上 |
| `wss://gua.ee:8091` | `wss://gua.ee:8091/` | ❌ 服务端不是 TLS，握手失败 |
| `http://gua.ee:8091` | `ws://http//gua.ee:8091` | ❌ 畸形地址 |
| `gua.ee：8091`（全角冒号） | — | ❌ 解析异常 |

**结论：让玩家填 `ws://域名:端口`，最不容易出错。**

---

## 5. 路由器与公网

1. 路由器把 **TCP `8091`** 转发到本机 `8091`
2. 域名 A 记录指向公网 IP（动态 IP 建议配 DDNS）
3. 服务器防火墙放行（Debian 默认 `iptables INPUT policy ACCEPT`，通常不用动）

### 怎么确认公网真的通了

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<域名>:8091
```

返回 **`426`** 就是通了。

> `426 Upgrade Required` 是 `ws` 服务器对普通 HTTP 请求的**正常响应**，
> 意思是"这个端口只接受 WebSocket"。很多人以为 426 是错误，其实这正是端口打通的证据。
>
> 对照判断：
> - `426` → 端口通，服务正常 ✅
> - `Connection refused` → 转发存在但服务没起
> - `Connection timed out` → 转发没配 / 被运营商或安全组拦

---

## 6. 不需要证书

原生客户端（PC / Android / iOS）不是从网页加载的，**没有浏览器的混合内容限制**，
所以明文 `ws://` 完全够用。

只有在**网页版**（HTTPS 页面）里联机才需要 `wss://` + TLS。
但注意：80 端口被封时 Let's Encrypt 的 HTTP-01 验证走不通，得用 DNS-01 或 Cloudflare。

> iOS 客户端虽然用 WKWebView，但它放开 ATS 后 `ws://` 可以直接连，
> 详见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md#1-ios-能连局域网但连不上公网)。

---

## 7. 版本一致性

服务端**不校验版本**，它只转发信令。但无名杀是「客户端跑逻辑 + 服务端同步」的模型：

> **所有玩家的客户端必须是同一个版本**，否则技能判定、牌堆、状态会不同步。

发客户端给朋友之前，确认大家装的是同一版 IPA/APK/PC 包。

---

## 8. 运维

```bash
systemctl status noname-srv        # 状态
systemctl restart noname-srv       # 重启
journalctl -u noname-srv -f        # 系统日志
tail -f /var/log/noname-srv.log    # 服务日志
```

### 升级到上游新版本

改 `UPSTREAM_COMMIT` 重跑部署脚本：

```bash
sudo UPSTREAM_COMMIT=<新 commit> bash deploy.sh
```

服务端只是信令中转，升级通常不影响兼容性；但如果上游改了消息格式，**客户端和服务端要一起升**。

### 容量

房间、客户端、聊天事件都放在内存里，`events` 数组会累积。
**小圈子自用（十几人）完全没问题，不要指望扛几百人。**

---

## 9. 许可

服务端代码来自 [`libnoname/noname`](https://github.com/libnoname/noname)，**GPL-3.0**。

本仓库**不复制上游源码**——部署脚本在运行时从上游拉取，因此本仓库分发的只是
自己的脚本与文档。如果你要修改并分发服务端代码，请遵守 GPL-3.0（保留版权声明、提供对应源码）。
