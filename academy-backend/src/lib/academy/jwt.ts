// JWT bearer-token issuance/verification — replaces the original app's
// HttpOnly signed-cookie sessions (lib/academy/user-auth.ts,
// lib/academy/admin-auth.ts) now that the frontend (Vercel) and backend
// (Cloud Run) are different origins.

import jwt from "jsonwebtoken";
import { env } from "../../config/env";

export type UserRole = "learner" | "admin";

export interface AcademyJwtPayload {
  userId: string;
  role: UserRole;
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
  isDemo?: boolean;
}

export function signAcademyToken(payload: AcademyJwtPayload): string {
  return jwt.sign(payload, env.ACADEMY_JWT_SECRET, {
    expiresIn: env.ACADEMY_JWT_TTL_SECONDS,
  });
}

export function verifyAcademyToken(token: string): AcademyJwtPayload | null {
  try {
    const decoded = jwt.verify(token, env.ACADEMY_JWT_SECRET);
    if (typeof decoded !== "object" || decoded === null) return null;
    const { userId, role } = decoded as Record<string, unknown>;
    if (typeof userId !== "string" || (role !== "learner" && role !== "admin")) return null;
    return decoded as unknown as AcademyJwtPayload;
  } catch {
    return null;
  }
}

export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const [scheme, token] = authorizationHeader.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}
