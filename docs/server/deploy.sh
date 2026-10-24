#!/usr/bin/env bash
#
# 无名杀联机中继服务 · 一键部署
#
#   curl -fsSL https://raw.githubusercontent.com/Zayia/noname-ios/main/docs/server/deploy.sh | sudo bash
#
# 或者先下载再执行，可以改参数：
#
#   sudo PORT=9000 INSTALL_DIR=/opt/noname-srv ./deploy.sh
#
# 提示：生产环境建议先把脚本下载下来看一眼，再 sudo bash deploy.sh 执行。
#
# 设计说明：
#   * 只从上游取 packages/server 这一个包的 7 个源文件，不克隆 2.5 GB 仓库；
#   * 上游代码按 GPL-3.0 分发，本脚本在部署时才拉取，本仓库不复制其源码；
#   * 版本钉死在 UPSTREAM_COMMIT，上游 main 变动不会让部署失效。
#
set -euo pipefail

# ── 可覆盖参数 ────────────────────────────────────────────────────────────────
# 上游版本（libnoname/noname 的 commit）。升级时改这里，并重跑脚本。
UPSTREAM_COMMIT="${UPSTREAM_COMMIT:-1a548c95acdf8ac1ef44d74473403eda2ac86cf0}"
INSTALL_DIR="${INSTALL_DIR:-/root/docker/noname-srv}"
PORT="${PORT:-8091}"
SERVICE_NAME="${SERVICE_NAME:-noname-srv}"
LOG_FILE="${LOG_FILE:-/var/log/noname-srv.log}"

UPSTREAM_REPO="${UPSTREAM_REPO:-libnoname/noname}"
BASE_URL="https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_COMMIT}/packages/server"

# 服务端只需要这 7 个文件，加起来约 42 KB
FILES=(
  package.json
  pnpm-lock.yaml
  tsup.config.ts
  src/cli.ts
  src/index.ts
  src/types.ts
  src/server/createServer.ts
)

# ── 输出 ──────────────────────────────────────────────────────────────────────
info() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✔ %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 前置检查 ──────────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "需要 root 权限（要写 systemd 单元和 /var/log）"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "找不到 node，请先安装 Node.js 18+"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 版本过低（当前 $(node -v)），需要 18+"

command -v pnpm >/dev/null || die "找不到 pnpm，请先安装：npm i -g pnpm"

info "Node $(node -v) · pnpm $(pnpm -v) · 上游 ${UPSTREAM_COMMIT:0:8}"

# ── 1. 拉取源码 ───────────────────────────────────────────────────────────────
info "拉取服务端源码到 ${INSTALL_DIR}"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

for f in "${FILES[@]}"; do
  mkdir -p "$(dirname "$f")"
  curl -fsSL --max-time 30 "${BASE_URL}/${f}" -o "$f" \
    || die "下载失败：${BASE_URL}/${f}"
done

# pnpm 10+ 把 onlyBuiltDependencies 放在 pnpm-workspace.yaml 里
printf 'onlyBuiltDependencies:\n  - esbuild\n' > pnpm-workspace.yaml

ok "源码就位（$(du -sh src | cut -f1)）"

# ── 2. 安装依赖 ───────────────────────────────────────────────────────────────
# 运行时依赖只有 ws 一个；esbuild 是构建期依赖
# strict-dep-builds=false 用来放行 esbuild 的安装脚本，否则 pnpm 11 会直接退出
info "安装依赖"
pnpm install --config.strict-dep-builds=false >/dev/null 2>&1 \
  || die "pnpm install 失败，去掉 >/dev/null 看详细输出"

# ── 3. 构建 ───────────────────────────────────────────────────────────────────
# 注意：不能用 pnpm build —— pnpm 11 在跑脚本前会做依赖校验，会再次触发
# esbuild 的 build script 检查并失败。直接调用 tsup 即可。
info "构建"
./node_modules/.bin/tsup >/dev/null 2>&1 || die "tsup 构建失败"
[ -f dist/cli.js ] || die "构建产物 dist/cli.js 不存在"

# ── 4. 瘦身：去掉构建期依赖 ───────────────────────────────────────────────────
# 49 MB → 约 230 KB。留下的只有 ws。
# 之后要重新构建，重跑本脚本即可（会重装 devDependencies）。
info "清理构建期依赖"
rm -rf node_modules
pnpm install --prod --config.strict-dep-builds=false >/dev/null 2>&1 \
  || die "prod 安装失败"
node -e "import('ws').then(()=>{},()=>{process.exit(1)})" \
  || die "ws 无法解析，node_modules 不完整"

ok "部署完成，占用 $(du -sh "$INSTALL_DIR" | cut -f1)"

# ── 5. 安装 systemd 服务 ──────────────────────────────────────────────────────
info "安装 systemd 服务 ${SERVICE_NAME}"

UNIT_SRC="$(dirname "$(readlink -f "$0")")/noname-srv.service"
UNIT_DST="/etc/systemd/system/${SERVICE_NAME}.service"

if [ -f "$UNIT_SRC" ]; then
  sed -e "s|__INSTALL_DIR__|${INSTALL_DIR}|g" \
      -e "s|__NODE_BIN__|${NODE_BIN}|g" \
      -e "s|__PORT__|${PORT}|g" \
      -e "s|__LOG_FILE__|${LOG_FILE}|g" \
      "$UNIT_SRC" > "$UNIT_DST"
else
  # 通过 curl | bash 执行时没有模板文件，内联生成
  cat > "$UNIT_DST" <<EOF
[Unit]
Description=Noname (无名杀) WebSocket 联机中继服务
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} dist/cli.js --port ${PORT}
Restart=always
RestartSec=3
MemoryMax=512M
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=multi-user.target
EOF
fi

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1
systemctl restart "${SERVICE_NAME}"

sleep 2
systemctl is-active --quiet "${SERVICE_NAME}" \
  || { journalctl -u "${SERVICE_NAME}" -n 20 --no-pager; die "服务启动失败"; }

ok "服务已启动"

# ── 5.5 日志轮转 ──────────────────────────────────────────────────────────────
# 服务直接 append 写日志文件，不轮转会一直涨
if [ -d /etc/logrotate.d ]; then
  cat > "/etc/logrotate.d/${SERVICE_NAME}" <<EOF
${LOG_FILE} {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
}
EOF
  ok "日志轮转：/etc/logrotate.d/${SERVICE_NAME}"
fi

# ── 6. 自检 ───────────────────────────────────────────────────────────────────
info "自检"

if command -v ss >/dev/null 2>&1; then
  ss -tulpn 2>/dev/null | grep -q ":${PORT}\b" \
    && ok "监听 :${PORT}" \
    || die "端口 ${PORT} 没有监听"
else
  (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null \
    && ok "监听 :${PORT}" \
    || die "端口 ${PORT} 没有监听"
fi

# 用 ws 客户端真连一次，确认能拿到房间列表
if ( cd "$INSTALL_DIR" && P="$PORT" node -e '
const WebSocket = require("ws");
const ws = new WebSocket("ws://127.0.0.1:" + process.env.P);
const t = setTimeout(() => { console.error("timeout"); process.exit(1); }, 8000);
ws.on("message", d => { clearTimeout(t); console.log(String(d).slice(0, 80)); ws.close(); process.exit(0); });
ws.on("error", e => { clearTimeout(t); console.error(e.message); process.exit(1); });
' ); then
  ok "WebSocket 握手成功"
else
  die "WebSocket 自检失败，看 journalctl -u ${SERVICE_NAME} -n 50"
fi

# ── 完成 ──────────────────────────────────────────────────────────────────────
cat <<EOF

$(printf '\033[32m部署完成\033[0m')

  安装目录   ${INSTALL_DIR}
  监听端口   :${PORT}
  日志       ${LOG_FILE}
  服务管理   systemctl {status,restart,stop} ${SERVICE_NAME}

接下来：

  1. 路由器把 TCP ${PORT} 转发到本机 ${PORT}
  2. 客户端联机地址填：ws://<你的域名或公网IP>:${PORT}

     ⚠️ 不要只填域名或 IP 不带端口 —— 客户端会自动补成 :8080，连不上。
     ⚠️ 若客户端是 iOS，确认 Info.plist 已放开 ATS，见 docs/server/TROUBLESHOOTING.md

EOF
