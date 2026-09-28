import type { Request, Response } from "express";

// Ported from the original Next.js apiSuccess/apiError envelope
// (lib/api-response.ts) so the frontend's existing response-parsing code
// keeps working unchanged.

export interface ApiMeta {
  latency_ms?: number;
  timestamp: string;
  version: string;
  count?: number;
  total?: number;
  limit?: number;
  offset?: number;
  source?: string;
  request_id?: string;
  [key: string]: unknown;
}

export interface ApiErrorDetail {
  code: string;
  message: string;
  status: number;
  details?: unknown;
  instance?: string;
  timestamp: string;
  request_id: string;
}

const API_VERSION = "1.0.0";

export function generateRequestId(): string {
  return "req_" + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
}

export function apiSuccess<T>(
  res: Response,
  data: T,
  meta: Partial<ApiMeta> = {},
  status = 200,
): Response {
  const requestId = meta.request_id || generateRequestId();
  const timestamp = meta.timestamp || new Date().toISOString();

  const fullMeta: ApiMeta = {
    timestamp,
    version: API_VERSION,
    request_id: requestId,
    ...meta,
  };

  res.setHeader("X-GramIQ-Request-Id", requestId);
  res.setHeader("X-API-Version", API_VERSION);
  if (fullMeta.latency_ms !== undefined) {
    res.setHeader("X-Response-Time", `${fullMeta.latency_ms}ms`);
  }

  return res.status(status).json({
    success: true,
    data,
    meta: fullMeta,
  });
}

export function apiError(
  res: Response,
  code: string,
  message: string,
  status = 400,
  details: unknown = null,
  req?: Request,
): Response {
  const requestId = generateRequestId();
  const timestamp = new Date().toISOString();
  const instance = req?.originalUrl;

  const errorObj: ApiErrorDetail = {
    code,
    message,
    status,
    timestamp,
    request_id: requestId,
    ...(instance ? { instance } : {}),
    ...(details ? { details } : {}),
  };

  res.setHeader("X-GramIQ-Request-Id", requestId);
  res.setHeader("X-API-Version", API_VERSION);

  return res.status(status).json({
    success: false,
    error: errorObj,
  });
}
