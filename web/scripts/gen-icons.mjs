// 生成 PWA 所需的 PNG 图标（从 SVG 渲染，保证形状质量）
//
// 依赖:
//   - @resvg/resvg-js（WASM 预编译 SVG 渲染器，无系统依赖）
//   - 幂等：每次运行覆盖生成
//
// 产物（写入 web/public/）:
//   - apple-touch-icon.png  180x180  iOS 主屏图标
//   - icon-192.png          192x192  Android manifest
//   - icon-512.png          512x512  Android manifest 高清 + 启动屏
//
// 设计:
//   - 紫色 #863bff 圆角矩形满铺背景（maskable 需要实心背景）
//   - 白色闪电图形居中（经典 Z 形，四周留 safe zone）
//   - 视觉与 favicon.svg / EmptyState 品牌图标一致

import { Resvg } from "@resvg/resvg-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "..", "public");

// 闪电 SVG path（经典 Z 形，Heroicons bolt 风格）
// 在 100x100 viewBox 内绘制，圆角矩形背景 + 居中白色闪电
function iconSVG(size) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <!-- 紫色圆角矩形背景（maskable 实心背景） -->
  <rect width="100" height="100" rx="22" fill="#863bff"/>
  <!-- 白色闪电（居中，留 safe zone，加粗以提升小尺寸可见性） -->
  <path
    fill="#ffffff"
    d="M 60 14 L 26 58 L 48 58 L 40 86 L 74 42 L 52 42 Z"
  />
</svg>`;
}

function generate(size, outPath) {
  const svg = iconSVG(size);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
  });
  const pngData = resvg.render().asPng();
  writeFileSync(outPath, pngData);
  console.log(`  ✓ ${outPath} (${size}x${size})`);
}

mkdirSync(PUBLIC_DIR, { recursive: true });
console.log("Generating PWA icons...");

generate(180, resolve(PUBLIC_DIR, "apple-touch-icon.png"));
generate(192, resolve(PUBLIC_DIR, "icon-192.png"));
generate(512, resolve(PUBLIC_DIR, "icon-512.png"));

console.log("Done.");
