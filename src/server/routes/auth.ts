import { Router } from "express";
import { z } from "zod";
import { getConfig } from "../../config.js";
import { one, query, tx } from "../../db/pool.js";
import { hashPassword, verifyPassword } from "../../lib/crypto.js";
import { clientIp, createSession, destroySession, requireAuth } from "../auth.js";
import { HttpError, asyncHandler, parse, rateLimit } from "../http.js";

export const authRouter = Router();

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, "Password must be at least 10 characters").max(200);

const registerSchema = z.object({
  email,
  password,
  name: z.string().trim().max(100).optional(),
  workspaceName: z.string().trim().min(1).max(100).optional(),
});

const authLimiter = rateLimit("auth", 10, 15 * 60_000, (req) => `${clientIp(req)}:${String(req.body?.email ?? "").toLowerCase()}`);
const ipLimiter = rateLimit("auth-ip", 50, 15 * 60_000, (req) => clientIp(req));

export function publicConfig() {
  const c = getConfig();
  return {
    demoMode: c.DEMO_MODE,
    allowRegistration: c.ALLOW_REGISTRATION,
    metaConfigured: c.metaConfigured,
    appUrl: c.APP_URL,
  };
}

authRouter.get("/config", (_req, res) => {
  res.json(publicConfig());
});

authRouter.post(
  "/auth/register",
  ipLimiter,
  authLimiter,
  asyncHandler(async (req, res) => {
    const c = getConfig();
    const body = parse(registerSchema, req.body);
    const pendingInvite = await one(
      `SELECT 1 FROM workspace_invites WHERE lower(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
      [body.email]
    );
    if (!c.ALLOW_REGISTRATION && !pendingInvite) throw new HttpError(403, "Registration is disabled on this instance");
    if (c.allowedEmails.length && !c.allowedEmails.includes(body.email) && !pendingInvite) {
      throw new HttpError(403, "This email is not allowed to register on this instance");
    }
    const exists = await one("SELECT 1 FROM users WHERE lower(email) = $1", [body.email]);
    if (exists) throw new HttpError(409, "An account with this email already exists");

    const hash = await hashPassword(body.password);
    const user = await tx(async (db) => {
      const u = (
        await db.query("INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id, email, name", [
          body.email,
          body.name ?? null,
          hash,
        ])
      ).rows[0];
      // Invited users join the inviter's workspace on accept; everyone gets a personal one.
      const ws = (
        await db.query("INSERT INTO workspaces (name) VALUES ($1) RETURNING id", [
          body.workspaceName || `${body.name || body.email.split("@")[0]}'s workspace`,
        ])
      ).rows[0];
      await db.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws.id, u.id]);
      return u;
    });
    await createSession(res, user.id, req.header("user-agent"));
    res.status(201).json({ user });
  })
);

authRouter.post(
  "/auth/login",
  ipLimiter,
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ email, password: z.string().min(1).max(200) }), req.body);
    const user = await one<{ id: string; email: string; name: string | null; password_hash: string }>(
      "SELECT id, email, name, password_hash FROM users WHERE lower(email) = $1",
      [body.email]
    );
    // Verify against a dummy hash when the user doesn't exist to keep timing uniform.
    const ok = await verifyPassword(
      body.password,
      user?.password_hash ?? "scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    );
    if (!user || !ok) throw new HttpError(401, "Incorrect email or password");
    await createSession(res, user.id, req.header("user-agent"));
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  })
);

authRouter.post(
  "/auth/logout",
  asyncHandler(async (req, res) => {
    await destroySession(req, res);
    res.json({ ok: true });
  })
);

authRouter.get(
  "/auth/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const workspaces = await query(
      `SELECT w.id, w.name, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = $1 ORDER BY m.created_at`,
      [req.user!.id]
    );
    res.json({ user: req.user, workspaces, config: publicConfig() });
  })
);

authRouter.post(
  "/auth/password",
  requireAuth,
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), req.body);
    const row = await one<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [req.user!.id]);
    if (!row || !(await verifyPassword(body.currentPassword, row.password_hash))) {
      throw new HttpError(401, "Current password is incorrect");
    }
    await query("UPDATE users SET password_hash = $2 WHERE id = $1", [req.user!.id, await hashPassword(body.newPassword)]);
    await query("DELETE FROM sessions WHERE user_id = $1", [req.user!.id]);
    await createSession(res, req.user!.id, req.header("user-agent"));
    res.json({ ok: true });
  })
);
