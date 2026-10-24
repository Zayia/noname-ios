# 排障清单

按"现象 → 原因 → 解决"组织。每条都是实际踩过的坑。

---

## 1. iOS 能连局域网但连不上公网

**现象**

- 客户端填 `192.168.1.228:8091` → 能连
- 客户端填 `ws://gua.ee:8091` → 连接失败
- 服务端日志里看不到任何来自公网的连接尝试

**原因：iOS 的 App Transport Security（ATS）**

`Info.plist` 里如果只有 `NSAllowsLocalNetworking`，它的放行范围是：

- ✅ `.local` 域名
- ✅ **私有 IP**（`192.168.x.x` / `10.x.x.x` / `127.0.0.1`）
- ❌ **公网域名和公网 IP 一律拦截**

所以私有 IP 能连、公网域名连不上——现象和这个配置完全对应。

**解决**

本仓库的 `apps/ios/Noname/Info.plist` 已经放开了：

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsArbitraryLoadsInWebContent</key>
    <true/>
    <key>NSAllowsArbitraryLoadsForMedia</key>
    <true/>
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
```

关键点是 **`NSAllowsArbitraryLoadsInWebContent`**：

- WebSocket 是从 WKWebView 里的 JS 发起的，属于 **web content**
- `NSAllowsArbitraryLoads` 管的是 App 自己的 `URLSession`，**管不到 WKWebView 里的内容**
- **iOS 10 起，只要出现 `...InWebContent` 这类细分键，`NSAllowsArbitraryLoads` 就会被忽略**

所以只写 `NSAllowsArbitraryLoads` 是不够的，真正起作用的是 `...InWebContent`。

> **装的是旧包也会出现同样现象。** 改完 `Info.plist` 必须重新构建 IPA 并覆盖安装，
> 用旧 IPA 测永远是失败的。

**只想放开单个域名**（更克制，App Store 审核也更友好）：

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
    <key>NSExceptionDomains</key>
    <dict>
        <key>gua.ee</key>
        <dict>
            <key>NSExceptionAllowsInsecureHTTPLoads</key>
            <true/>
            <key>NSIncludesSubdomains</key>
            <true/>
        </dict>
    </dict>
</dict>
```

`NSExceptionAllowsInsecureHTTPLoads` 对 WebSocket 同样生效。

---

## 2. 客户端提示连接失败，但服务端日志毫无动静

**原因：客户端把端口补成了 8080**

客户端 `connect(ip)` 的逻辑：

- 输入是**纯 IP**（如 `192.168.1.228`）→ 强制补 `:8080`
- 输入是**域名且不带端口**（如 `gua.ee`）→ 也补 `:8080`
- 输入以 `ws://` / `wss://` 开头 → **原样使用，不补端口**

**解决**

让玩家填完整地址：

```
ws://gua.ee:8091
```

用 `ws://` 前缀能绕开所有端口补全逻辑。详见 [README §4.2](README.md#42-为什么必须带端口和-ws-前缀)。

---

## 3. 全角冒号

**现象**：提示"无效联机地址"

**原因**：中文输入法下打出了全角 `：`，客户端 `lastIndexOf(":")` 返回 `-1`，
判定为"不带端口"，随后 URL 解析抛异常。

**解决**：切成英文输入法，确认是半角 `:`。最稳的办法是直接填 `ws://域名:端口`。

---

## 4. 填了 `wss://` 连不上

**现象**：连接失败，服务端日志里可能出现 TLS 握手错误

**原因**：服务端是**明文 ws**，不是 TLS。客户端用 `wss://` 会走 TLS 握手，
服务端回的是 WebSocket 帧，TLS 直接报 `wrong version number`。

本地复现：

```
wss://gua.ee:8091 -> 失败: SSL routines: tls_validate_record_header:wrong version number
```

**解决**：改成 `ws://`。原生客户端不需要 TLS（见 [README §6](README.md#6-不需要证书)）。

---

## 5. 判断公网端口到底通没通

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<域名>:8091
```

| 返回 | 含义 | 下一步 |
| --- | --- | --- |
| `426` | **通了**，`ws` 服务器正常拒绝普通 HTTP | 没问题，继续查客户端 |
| `Connection refused` | 转发规则存在，但服务没在监听 | `systemctl status noname-srv` |
| `Connection timed out` | 包被丢弃 | 查路由器转发、运营商封端口、云安全组 |

`426 Upgrade Required` 是 `ws` 服务器对非 WebSocket 请求的**标准响应**，
它恰恰证明「公网 → 路由器 → 服务器」整条链路是通的。**不要把它当错误。**

想看服务端真的能握手，用 `ws` 客户端直连：

```bash
node -e '
const WebSocket = require("ws");
const ws = new WebSocket("ws://gua.ee:8091");
ws.on("open", () => console.log("OPEN ok"));
ws.on("message", d => { console.log(String(d).slice(0,80)); process.exit(0); });
ws.on("error", e => { console.error(e.message); process.exit(1); });
'
```

正常会打印一行房间列表，形如 `["roomlist",[],[],[...],"3282150034"]`。

---

## 6. `pnpm install` 直接退出 1

**现象**

```
Ignored build scripts: esbuild@0.27.7.
```

**原因**：pnpm 10+ 默认拦截依赖的 build script，esbuild 被拦下后 install 以非零码退出。

**解决**

```bash
pnpm install --config.strict-dep-builds=false
```

同时确认 `pnpm-workspace.yaml` 里有：

```yaml
onlyBuiltDependencies:
  - esbuild
```

---

## 7. `pnpm build` 失败，但 `tsup` 能跑

**现象**：`pnpm build` 报依赖状态校验失败

**原因**：pnpm 11 在执行 `package.json` 的 scripts 前会做一次依赖状态校验，
那个校验内部又调 `pnpm install`，于是再次撞上 esbuild 的 build script 检查。

**解决**：绕过 pnpm 的脚本包装，直接调二进制：

```bash
./node_modules/.bin/tsup
```

---

## 8. 端口被占用

```bash
ss -tulpn | grep :8091
```

常见冲突：`8080` 常被各种 Web 面板/网关占，`8082` 也容易被占。
默认用 `8091` 就是为了避开它们。换端口直接改 `PORT`：

```bash
sudo PORT=9000 bash deploy.sh
```

---

## 9. 服务起来了，但客户端显示房间列表为空

**这是正常的。** 房间列表里只有一条 `["server", ...]` 之类的特殊条目，
表示中继服务在线；真正的房间要等有人**建房**才会出现。

如果多人分别建房互相看不见，检查：

1. 所有人连的是**同一个地址**（别一半局域网 IP、一半公网域名）
2. 客户端版本一致（见下条）

---

## 10. 联机能连上，但游戏内技能判定不同步

**原因：客户端版本不一致**

服务端**不校验版本**，它只转发信令。游戏逻辑在各客户端本地跑，
版本不同会导致技能、牌堆、状态判定出现分歧。

**解决**：所有人装同一个版本。iOS 用户看 Release 标签里的
`ios-<官方提交>-<iOS客户端提交>-<变体>`，前两段一致才算同版本。

---

## 11. 收不到日志

日志在 `/var/log/noname-srv.log`。如果文件不存在或为空：

```bash
journalctl -u noname-srv -n 50 --no-pager
```

systemd 的 `StandardOutput=append:` 只在服务启动后才写文件，启动前的报错要看 journal。
