import type { NextFunction, Request, RequestHandler, Response } from "express";
import { apiError } from "../lib/response";
import { env } from "../config/env";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Wraps an async route handler so a rejected promise reaches the error middleware instead of crashing the process — Express 5 does this automatically for async handlers, but this also records latency, matching the old withApiHandler(). */
export function asyncHandler(handler: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    const start = performance.now();
    Promise.resolve(handler(req, res, next))
      .then(() => {
        const latencyMs = Math.round(performance.now() - start);
        if (!res.headersSent) return;
        res.setHeader("X-Response-Time", `${latencyMs}ms`);
      })
      .catch(next);
  };
}

export function notFoundHandler(req: Request, res: Response) {
  apiError(res, "NOT_FOUND", "Not Found", 404, null, req);
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const message = err instanceof Error ? err.message : "An unexpected server error occurred.";
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(`[API Handler Error] ${req.method} ${req.originalUrl}:`, err);

  apiError(
    res,
    "INTERNAL_SERVER_ERROR",
    message,
    500,
    env.NODE_ENV === "development" ? { stack } : undefined,
    req,
  );
}
