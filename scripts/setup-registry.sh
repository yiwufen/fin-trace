#!/usr/bin/env bash
# 一次性初始化：私有 Docker Registry（服务器端）
#
# 用法（在百度服务器上运行）:
#   bash scripts/setup-registry.sh
#
# 做完后还需要:
#   1. 更新外部 knowledge-caddy Caddyfile，添加 registry 路由
#   2. 在 GitHub 仓库配置 5 个 Secrets
#   3. 提交代码、推送 main 触发首次 CI 部署
#
# 注意：此脚本只需在服务器上运行一次。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# ─── 检查依赖 ───
command -v docker >/dev/null 2>&1 || { echo "错误: 需要 docker"; exit 1; }
command -v htpasswd >/dev/null 2>&1 || { echo "提示: 未安装 htpasswd，尝试用 apache2-utils..."; }
command -v openssl >/dev/null 2>&1 || { echo "错误: 需要 openssl"; exit 1; }

echo "╔══════════════════════════════════════════════════╗"
echo "║     私有 Docker Registry 初始化                 ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ─── 生成凭据 ───
REGISTRY_USER="${REGISTRY_USER:-fin-trace}"
REGISTRY_DIR="$PROJECT_DIR/registry-auth"
REGISTRY_DATA="$PROJECT_DIR/registry-data"

mkdir -p "$REGISTRY_DIR" "$REGISTRY_DATA"

HTPASSWD_FILE="$REGISTRY_DIR/htpasswd"

if [ -f "$HTPASSWD_FILE" ]; then
  echo "⚠ htpasswd 已存在: $HTPASSWD_FILE"
  echo "  如需重新生成请先删除此文件"
  echo ""
else
  # 生成随机密码
  REGISTRY_PASSWORD=$(openssl rand -base64 24)
  echo "  Registry 用户: $REGISTRY_USER"
  echo "  Registry 密码: $REGISTRY_PASSWORD"
  echo ""

  # 生成 htpasswd
  if command -v htpasswd >/dev/null 2>&1; then
    htpasswd -Bbn "$REGISTRY_USER" "$REGISTRY_PASSWORD" > "$HTPASSWD_FILE"
  else
    # 用 docker 运行 htpasswd
    docker run --rm httpd:alpine htpasswd -Bbn "$REGISTRY_USER" "$REGISTRY_PASSWORD" > "$HTPASSWD_FILE"
  fi
  echo "✓ htpasswd 已写入: $HTPASSWD_FILE"
fi

# ─── 读取 htpasswd hash ───
HTPASSWD_HASH=$(cut -d: -f2 "$HTPASSWD_FILE")
REGISTRY_PASSWORD="${REGISTRY_PASSWORD:-<见上方输出>}"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  第一步：更新 knowledge-caddy Caddyfile         ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "在 knowledge-caddy 项目的 Caddyfile 中添加:"
echo ""
echo "  registry.fin.182-61-1-77.nip.io {"
echo "      basic_auth {"
echo "          $REGISTRY_USER $HTPASSWD_HASH"
echo "      }"
echo "      reverse_proxy fin-trace-registry:5000"
echo "  }"
echo ""
echo "然后 reload: docker exec knowledge-caddy caddy reload --config /etc/caddy/Caddyfile"
echo ""

echo "╔══════════════════════════════════════════════════╗"
echo "║  第二步：配置 GitHub Secrets                    ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "在 GitHub 仓库 Settings → Secrets and variables → Actions 中配置:"
echo ""
echo "  REGISTRY_USER      = $REGISTRY_USER"
echo "  REGISTRY_PASSWORD  = $REGISTRY_PASSWORD"
echo "  SSH_HOST           = 182.61.1.77"
echo "  SSH_USER           = deployer"
echo "  SSH_PRIVATE_KEY    = <deployer 用户私钥内容>"
echo ""
echo "获取私钥: cat ~/.ssh/id_rsa   (注意复制完整内容，含 BEGIN/END 行)"
echo ""

echo "╔══════════════════════════════════════════════════╗"
echo "║  第三步：启动 Registry 容器                     ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "  cd ~/fin-trace && docker compose up -d registry"
echo ""

echo "╔══════════════════════════════════════════════════╗"
echo "║  第四步：提交代码 & 推送触发首次部署            ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "  git add .github/workflows/deploy.yml docker-compose.yml scripts/"
echo "  git commit -m 'feat: CI 构建推送部署方案'"
echo "  git push origin main"
echo ""

echo "初始化完成！按以上四步操作即可。"
