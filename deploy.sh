#!/usr/bin/env bash
# 部署 fin-trace 到 baidu 服务器 (182.61.1.77) via Docker Compose
#
# 用法（需 Git Bash / WSL / Linux）:
#   bash deploy.sh
#
# 流程:
#   1. rsync 同步本地源码（含未提交改动）到 baidu:~/fin-trace/
#   2. ssh 上去 docker compose up -d --build
#
# 注意：data/ 不被同步（运行时数据持久化在服务器），首次部署后配置走服务器的 data/settings.json

set -euo pipefail

REMOTE="baidu"
REMOTE_DIR="~/fin-trace"

echo "==> [1/3] 同步源码到 ${REMOTE}:${REMOTE_DIR} （排除 node_modules / dist / data / config.json）"

# rsync 排除运行时数据与依赖；--delete 保持远端与本地源码一致
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude 'web/node_modules' \
  --exclude 'dist' \
  --exclude 'web/dist' \
  --exclude 'data' \
  --exclude 'config.json' \
  --exclude '.git' \
  --exclude '*.tsbuildinfo' \
  --exclude '*.log' \
  ./ "${REMOTE}:${REMOTE_DIR}/"

echo ""
echo "==> [2/3] 远端构建并启动容器"
ssh "${REMOTE}" "cd ${REMOTE_DIR} && docker compose up -d --build"

echo ""
echo "==> [3/3] 完成"
echo "服务地址: http://182.61.1.77:3001"
echo "HR 分享链接形如: http://182.61.1.77:3001/s/<token>"
echo ""
echo "查看日志:  ssh ${REMOTE} 'cd ${REMOTE_DIR} && docker compose logs -f'"
echo "查看状态:  ssh ${REMOTE} 'cd ${REMOTE_DIR} && docker compose ps'"
