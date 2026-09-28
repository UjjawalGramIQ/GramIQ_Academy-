// Login attempt rate limiting — ported from lib/academy/admin-auth.ts.
// Two gates: per-IP (hashed, never stored/logged raw) and a global backstop
// so a botnet presenting many distinct IPs still can't brute-force
// unbounded. In-process only — correct within a single server instance,
// which is what this needs for a login gate (unlike throughput limiting,
// this must fail CLOSED, not open, so it can't rely on an external cache
// being reachable).

import { createHmac } from "node:crypto";
import type { Request } from "express";

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map<string, { count: number; windowStart: number }>();

const GLOBAL_MAX_ATTEMPTS = 30;
let globalAttempts = { count: 0, windowStart: 0 };

function hashIp(ip: string): string {
  return createHmac("sha256", "academy-login-rl").update(ip).digest("hex").slice(0, 16);
}

function checkCounter(
  store: { count: number; windowStart: number },
  maxAttempts: number,
): { allowed: boolean; retryAfterSeconds: number; next: { count: number; windowStart: number } } {
  const now = Date.now();
  if (now - store.windowStart > LOGIN_WINDOW_MS) {
    return { allowed: true, retryAfterSeconds: 0, next: { count: 1, windowStart: now } };
  }
  if (store.count >= maxAttempts) {
    const retryAfterSeconds = Math.ceil((store.windowStart + LOGIN_WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSeconds, next: store };
  }
  return { allowed: true, retryAfterSeconds: 0, next: { count: store.count + 1, windowStart: store.windowStart } };
}

/** Checks and increments both the per-IP and global login attempt counters. Call BEFORE verifying the password. */
export function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfterSeconds: number } {
  const key = hashIp(ip);
  const entry = loginAttempts.get(key) ?? { count: 0, windowStart: 0 };

  const perIp = checkCounter(entry, LOGIN_MAX_ATTEMPTS);
  const global = checkCounter(globalAttempts, GLOBAL_MAX_ATTEMPTS);

  if (perIp.allowed && global.allowed) {
    loginAttempts.set(key, perIp.next);
    globalAttempts = global.next;
  }

  if (!perIp.allowed) return { allowed: false, retryAfterSeconds: perIp.retryAfterSeconds };
  if (!global.allowed) return { allowed: false, retryAfterSeconds: global.retryAfterSeconds };
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Client IP extraction, trusting a standard reverse-proxy layout (Cloud Run
 * included): the proxy appends the true client IP as the LAST entry of
 * x-forwarded-for, so a client-supplied value can only occupy earlier
 * positions and cannot forge the final hop. Requires `app.set('trust
 * proxy', ...)` to be configured accordingly in app.ts.
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const forwardedStr = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (forwardedStr) {
    const parts = forwardedStr.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1] as string;
  }
  return req.ip ?? "unknown";
}
