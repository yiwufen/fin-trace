# 多阶段构建：构建阶段装依赖 + 编译 TS + 构建 web；运行阶段只含产物
#
# 构建由 CI 在服务器上执行：docker build --network host \
#   --build-arg BUILD_PROXY=http://127.0.0.1:7890 ...
# （服务器无法直连外网，构建容器共享宿主机网络访问代理；
#   compose 中无 build 配置，统一走上面的 docker build。
#   本地构建不设 BUILD_PROXY 即可。）

# ─── 构建阶段 ───
FROM node:20-slim AS builder

ARG BUILD_PROXY=""

WORKDIR /app

# 构建期代理（npm/git 走宿主机 :7890）
# 使用 host 网络时 127.0.0.1 即宿主机；不设 BUILD_PROXY 则跳过
RUN if [ -n "$BUILD_PROXY" ]; then \
      npm config set proxy "$BUILD_PROXY" \
      && npm config set https-proxy "$BUILD_PROXY" \
      && git config --global http.proxy "$BUILD_PROXY" 2>/dev/null || true \
      && git config --global https.proxy "$BUILD_PROXY" 2>/dev/null || true; \
      echo "proxy set: $BUILD_PROXY"; \
    else echo "no build proxy"; fi

# 先拷包描述以利用 docker 层缓存
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/

# 装依赖（含 devDependencies，构建需要 tsx/tsc/vite）
RUN npm ci --include-workspace-root

# 拷全部源码（.dockerignore 已排除 node_modules/dist/data/config.json）
COPY . .

# 编译后端 TS → dist/，构建前端 → web/dist/
RUN npm run build

# ─── 运行阶段（slim）───
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HEADLESS=true
ENV PORT=3001

# 只装运行时依赖
COPY package.json package-lock.json ./
COPY web/package.json ./web/

# 用构建阶段的依赖树（只装 production 依赖）
RUN npm ci --omit=dev --include-workspace-root || npm install --omit=dev --include-workspace-root

# 拷构建产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/config.example.json ./config.example.json

# data/ 通过 volume 挂载，持久化 sessions / settings / share-tokens
RUN mkdir -p data

# node:20-slim 自带 uid 1000 的 node 用户。
# 让 /app 整体归 node 用户，使以 user 1000 运行时能写 config.json / data 卷。
RUN chown -R node:node /app

EXPOSE 3001

# 健康检查：命中 web 根路径
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 以非 root 用户运行（uid 1000，匹配宿主机 deployer，使 data 卷文件 deployer 可读写）
USER node

CMD ["node", "dist/index.js"]
