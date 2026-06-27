// Graph Explorer Service Worker
//
// 职责:
//   1. App Shell 预缓存（index.html + 构建产物 hash 资源）
//   2. 静态资源 cache-first（hash 文件永久有效）
//   3. index.html network-first（保证拿到最新版本）
//   4. 不拦截动态请求（/api/*、SSE、/a2a、/mcp、/.well-known/）
//
// 更新策略:
//   - CACHE_VERSION 改变时，新 SW 接管并清理旧缓存
//   - skipWaiting + clients.claim 让新版本立即生效
//   - sw.js 本身由服务器以 no-cache 提供，确保浏览器总能拿到最新版

const CACHE_VERSION = "v1";
const CACHE_NAME = `graph-explorer-${CACHE_VERSION}`;

// 预缓存：核心资源（install 时拉取）
// 注意: hash 资源名（assets/index-*.js）在构建时未知，运行时按需缓存
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

// 不应被 SW 拦截的路径（必须实时回源）
const NEVER_CACHE = [
  "/api/",
  "/a2a",
  "/mcp",
  "/.well-known/",
];

function shouldNeverCache(url) {
  return NEVER_CACHE.some((p) => url.pathname.startsWith(p));
}

// ─── Install: 预缓存核心资源 ───
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 逐个添加，单个失败不影响整体（如离线时）
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            await cache.add(url);
          } catch {
            // 忽略单个资源失败
          }
        }),
      );
      // 立即激活，不等旧 SW 释放
      await self.skipWaiting();
    })(),
  );
});

// ─── Activate: 清理旧版本缓存 ───
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      );
      // 立即接管所有客户端
      await self.clients.claim();
    })(),
  );
});

// ─── Fetch: 路由策略 ───
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // 只处理同源 GET 请求
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 动态请求/流式接口：不拦截，直接回源
  if (shouldNeverCache(url)) return;

  // 导航请求（HTML 页面）：network-first
  // 保证用户总能拿到最新 index.html，离线时回退到缓存
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE_NAME);
          cache.put("/index.html", fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match("/index.html")) || (await cache.match("/"));
        }
      })(),
    );
    return;
  }

  // 静态资源：cache-first（hash 资源永久有效；固定名资源也缓存但通过版本号更新）
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        // 只缓存成功的响应
        if (fresh.ok || fresh.type === "opaque") {
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch {
        // 离线且无缓存：返回空响应，让调用方处理
        return new Response("", { status: 504, statusText: "Offline" });
      }
    })(),
  );
});
