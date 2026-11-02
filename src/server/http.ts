import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodType } from "zod";
import { reserve } from "../lib/ratelimit.js";

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new HttpError(400, issues[0] ? `${issues[0].path ? issues[0].path + ": " : ""}${issues[0].message}` : "Invalid input", issues);
  }
  return r.data;
}

/** Redis-backed request rate limiting (e.g. login brute force). */
export function rateLimit(name: string, max: number, windowMs: number, key: (req: Request) => string): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const r = await reserve(`http:${name}:${key(req)}`, max, windowMs);
    if (!r.allowed) {
      res.setHeader("Retry-After", Math.ceil(r.resetInMs / 1000));
      throw new HttpError(429, "Too many requests. Please wait and try again.");
    }
    next();
  });
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }
  console.error("[api] unhandled error", err);
  res.status(500).json({ error: "Internal server error" });
}
