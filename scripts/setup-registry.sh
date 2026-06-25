#!/usr/bin/env bash
# 一次性初始化：私有 Docker Registry（仅 localhost 访问）
#
# 在服务器上运行一次即可：
#   bash scripts/setup-registry.sh
#
# 后续部署由 CI 自动完成。

set -euo pipefail

cd "$(dirname "$0")/.."

command -v docker >/dev/null 2>&1 || { echo "错误: 需要 docker"; exit 1; }

REGISTRY_USER="${REGISTRY_USER:-fin-trace}"

# ─── 生成凭据 ───
mkdir -p registry-auth registry-data

HTPASSWD_FILE="registry-auth/htpasswd"

if [ -f "$HTPASSWD_FILE" ]; then
  echo "⚠ htpasswd 已存在: $HTPASSWD_FILE，跳过生成"
  echo "  如需重新生成请先: rm $HTPASSWD_FILE"
  REGISTRY_PASSWORD="<已存在，见上方文件>"
else
  REGISTRY_PASSWORD=$(openssl rand -base64 24)
  docker run --rm httpd:alpine htpasswd -Bbn "$REGISTRY_USER" "$REGISTRY_PASSWORD" > "$HTPASSWD_FILE"
  echo "✓ htpasswd 已生成"
fi

echo ""
echo "============================================"
echo "  Registry 初始化完成"
echo "============================================"
echo ""
echo "  用户名: $REGISTRY_USER"
echo "  密码:   $REGISTRY_PASSWORD"
echo ""
echo "============================================"
echo "  接下来需要配置 GitHub Secrets:"
echo "============================================"
echo ""
echo "  REGISTRY_USER      = $REGISTRY_USER"
echo "  REGISTRY_PASSWORD  = $REGISTRY_PASSWORD"
echo "  SSH_HOST           = 182.61.1.77"
echo "  SSH_USER           = deployer"
echo "  SSH_PRIVATE_KEY    = <服务器 ~/.ssh/id_rsa 内容>"
echo ""
echo "============================================"
echo "  配置完成后启动 Registry:"
echo "============================================"
echo ""
echo "  docker compose up -d registry"
echo "  docker compose up -d"
echo ""
