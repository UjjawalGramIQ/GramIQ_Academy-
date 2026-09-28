// Scrypt password hashing — ported verbatim from the original
// lib/academy/admin-auth.ts / user-auth.ts (format: scrypt$N$r$p$saltB64$hashB64)
// so any existing hash strings issued by the old app remain verifiable here.

import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

function fromBase64url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/** Verifies a plaintext password against a scrypt hash string. Returns false (never throws) on mismatch or malformed hash. */
export async function verifyPasswordAgainstHash(plain: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  try {
    const salt = fromBase64url(saltB64);
    const expected = fromBase64url(hashB64);
    const derived = await scrypt(plain, salt, expected.length, { N, r, p });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Generates a scrypt hash string in the ACADEMY_ADMIN_PASSWORD_HASH format. */
export async function hashPassword(plain: string, N = 16384, r = 8, p = 1): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(plain, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${base64url(salt)}$${base64url(derived)}`;
}
