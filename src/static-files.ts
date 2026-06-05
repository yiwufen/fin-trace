// 静态文件 serve + SPA fallback — 生产模式托管 web/dist/
//
// 路由策略:
//   1. 路径包含 ".." → 404（路径穿越防护）
//   2. 精确匹配文件 → 返回文件内容 + MIME type
//   3. 不存在 → SPA fallback → index.html

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 包内 web/dist/ 目录 — 相对 dist/ 的上级目录
const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = resolve(__dirname, "..", "web", "dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function extname(path: string): string {
  const i = path.lastIndexOf(".");
  if (i < 0) return "";
  return path.slice(i).toLowerCase();
}

/** 返回 true 表示请求已被处理 */
export function handleStatic(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? "/";
  const path = url.split("?")[0].split("#")[0];

  // 只处理 GET/HEAD
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  // 路径穿越防护
  if (path.includes("..")) {
    res.writeHead(404);
    res.end();
    return true;
  }

  let filePath = resolve(STATIC_ROOT, "." + path);

  // 确保解析后的路径仍在 STATIC_ROOT 内
  const normalized = normalize(filePath);
  if (!normalized.startsWith(STATIC_ROOT)) {
    res.writeHead(404);
    res.end();
    return true;
  }

  // 文件存在且是文件 → 直接 serve
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";

    // 静态资源带 hash，可长缓存
    const cacheControl = /\.(js|css|svg|png|jpg|woff2?|ico)$/i.test(ext)
      ? "public, max-age=31536000, immutable"
      : "no-cache";

    const content = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": content.length,
      "Cache-Control": cacheControl,
    });
    res.end(content);
    return true;
  }

  // SPA fallback — 所有非文件路径返回 index.html
  const indexPath = resolve(STATIC_ROOT, "index.html");
  if (existsSync(indexPath)) {
    const content = readFileSync(indexPath);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": content.length,
      "Cache-Control": "no-cache",
    });
    res.end(content);
    return true;
  }

  return false;
}
