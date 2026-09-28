import type { NextFunction, Request, Response } from "express";
import { apiError } from "../lib/response";
import { extractBearerToken, verifyAcademyToken, type AcademyJwtPayload } from "../lib/academy/jwt";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AcademyJwtPayload;
    }
  }
}

/** Verifies the Authorization: Bearer <jwt> header. Attaches req.user on success, else 401. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractBearerToken(req.headers.authorization);
  const payload = token ? verifyAcademyToken(token) : null;
  if (!payload) {
    return apiError(res, "UNAUTHORIZED", "A valid session is required.", 401, null, req);
  }
  req.user = payload;
  next();
}

/** Same as requireAuth but only accepts role: 'admin'. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = extractBearerToken(req.headers.authorization);
  const payload = token ? verifyAcademyToken(token) : null;
  if (!payload || payload.role !== "admin") {
    return apiError(res, "UNAUTHORIZED", "Administrator session required.", 401, null, req);
  }
  req.user = payload;
  next();
}

/** Populates req.user if a valid token is present, but never rejects the request. Used by learner routes that behave differently for known vs. anonymous callers (device-id based). */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractBearerToken(req.headers.authorization);
  const payload = token ? verifyAcademyToken(token) : null;
  if (payload) req.user = payload;
  next();
}
