import type { NextFunction, Request, Response } from "express";
import { getConfig } from "../config.js";
import { one, query } from "../db/pool.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { HttpError, asyncHandler } from "./http.js";

export const SESSION_COOKIE = "cf_session";
const SESSION_DAYS = 30;

export type Role = "owner" | "admin" | "member";
const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

export interface AuthedUser {
  id: string;
  email: string;
  name: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
      workspace?: { id: string; name: string; role: Role };
    }
  }
}

export async function createSession(res: Response, userId: string, userAgent?: string) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await query("INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES ($1,$2,$3,$4)", [
    sha256(token),
    userId,
    expires,
    userAgent?.slice(0, 300) ?? null,
  ]);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: getConfig().APP_URL.startsWith("https://"),
    sameSite: "lax",
    expires,
    path: "/",
  });
}

export async function destroySession(req: Request, res: Response) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await query("DELETE FROM sessions WHERE id = $1", [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export const loadUser = asyncHandler(async (req, _res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const row = await one<AuthedUser>(
      `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.expires_at > now()`,
      [sha256(token)]
    );
    if (row) req.user = row;
  }
  next();
});

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, "Please sign in"));
  next();
}

/** Resolves the active workspace from the X-Workspace-Id header and enforces a minimum role. */
export function requireWorkspace(minRole: Role = "member") {
  return asyncHandler(async (req, _res, next) => {
    if (!req.user) throw new HttpError(401, "Please sign in");
    const wsId = (req.header("x-workspace-id") || (req.query.ws as string) || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(wsId)) throw new HttpError(400, "Missing or invalid X-Workspace-Id header");
    const ws = await one<{ id: string; name: string; role: Role }>(
      `SELECT w.id, w.name, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.workspace_id = $1 AND m.user_id = $2`,
      [wsId, req.user.id]
    );
    if (!ws) throw new HttpError(404, "Workspace not found");
    if (RANK[ws.role] < RANK[minRole]) throw new HttpError(403, `This action requires the ${minRole} role`);
    req.workspace = ws;
    next();
  });
}

/** CSRF defence: cross-site forms cannot set custom headers, and we never
 *  enable CORS. Every state-changing /api call must send this header. */
export function requireCsrfHeader(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.header("x-requested-with") !== "commentflow") {
    return next(new HttpError(403, "Missing X-Requested-With header"));
  }
  next();
}

export function clientIp(req: Request): string {
  return req.ip ?? "unknown";
}
