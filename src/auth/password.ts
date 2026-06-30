// 密码哈希工具 — 基于 Node 内置 crypto 的 scrypt
//
// 设计:
//   - scrypt（内存困难 KDF）抵抗暴力破解，比 bcrypt 更现代
//   - 每次哈希生成独立随机盐（16 字节），同密码两次哈希结果不同
//   - timingSafeEqual 校验，抵抗时序攻击
//   - 存储格式: "<saltHex>:<hashHex>"，便于序列化进 JSON
//
// 性能: 单次哈希约 80-120ms（N=16384 默认），注册/登录时轻微延迟，可接受。
// 零第三方依赖。

import { scrypt as scryptCallback, randomBytes, timingSafeEqual } from "node:crypto";

const SALT_BYTES = 16;
const KEY_LENGTH = 64; // 512-bit 哈希输出
// scrypt 参数: N（CPU/内存代价）、r（块大小）、p（并行度）
// N=16384 是 OWASP 推荐的最小值，单次约 100ms
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/** Promise 化的 scrypt */
function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/**
 * 哈希密码。
 * @returns 格式 "saltHex:hashHex"
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(password, salt);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * 校验密码是否匹配存储的哈希。
 * @param password 用户输入的明文密码
 * @param stored 存储的 "saltHex:hashHex"
 * @returns true 表示匹配
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const colonIdx = stored.indexOf(":");
  if (colonIdx === -1) return false;
  const saltHex = stored.slice(0, colonIdx);
  const hashHex = stored.slice(colonIdx + 1);
  let salt: Buffer;
  let expectedHash: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expectedHash = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length !== SALT_BYTES || expectedHash.length !== KEY_LENGTH) return false;

  const actualHash = await scryptAsync(password, salt);
  // 长度一致时 timingSafeEqual 安全；不一致直接返回 false（不泄露信息）
  if (actualHash.length !== expectedHash.length) return false;
  return timingSafeEqual(actualHash, expectedHash);
}

/** 简单密码强度校验（验证期最小规则） */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) return "密码至少 8 位";
  if (password.length > 128) return "密码过长";
  return null;
}
