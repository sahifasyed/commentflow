import { Router } from "express";
import { z } from "zod";
import { getConfig } from "../../config.js";
import { one, query, tx } from "../../db/pool.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { requireAuth, requireWorkspace } from "../auth.js";
import { HttpError, asyncHandler, parse } from "../http.js";

export const workspacesRouter = Router();
const INVITE_DAYS = 7;

workspacesRouter.post(
  "/workspaces",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(100) }), req.body);
    const ws = await tx(async (db) => {
      const w = (await db.query("INSERT INTO workspaces (name) VALUES ($1) RETURNING id, name", [name])).rows[0];
      await db.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [w.id, req.user!.id]);
      return w;
    });
    res.status(201).json({ workspace: { ...ws, role: "owner" } });
  })
);

workspacesRouter.patch(
  "/workspace",
  requireWorkspace("admin"),
  asyncHandler(async (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(100) }), req.body);
    await query("UPDATE workspaces SET name = $2 WHERE id = $1", [req.workspace!.id, name]);
    res.json({ ok: true });
  })
);

workspacesRouter.delete(
  "/workspace",
  requireWorkspace("owner"),
  asyncHandler(async (req, res) => {
    await query("DELETE FROM workspaces WHERE id = $1", [req.workspace!.id]);
    res.json({ ok: true });
  })
);

workspacesRouter.get(
  "/workspace/members",
  requireWorkspace("member"),
  asyncHandler(async (req, res) => {
    const members = await query(
      `SELECT u.id, u.email, u.name, m.role, m.created_at FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1 ORDER BY m.created_at`,
      [req.workspace!.id]
    );
    const invites =
      req.workspace!.role === "member"
        ? []
        : await query(
            `SELECT id, email, role, expires_at, created_at FROM workspace_invites
              WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
            [req.workspace!.id]
          );
    res.json({ members, invites, myRole: req.workspace!.role });
  })
);

workspacesRouter.patch(
  "/workspace/members/:userId",
  requireWorkspace("owner"),
  asyncHandler(async (req, res) => {
    const { role } = parse(z.object({ role: z.enum(["owner", "admin", "member"]) }), req.body);
    if (req.params.userId === req.user!.id && role !== "owner") {
      const owners = await one<{ n: number }>(
        "SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'",
        [req.workspace!.id]
      );
      if ((owners?.n ?? 0) <= 1) throw new HttpError(400, "A workspace needs at least one owner");
    }
    const r = await query("UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2 RETURNING user_id", [
      req.workspace!.id,
      req.params.userId,
      role,
    ]);
    if (!r.length) throw new HttpError(404, "Member not found");
    res.json({ ok: true });
  })
);

workspacesRouter.delete(
  "/workspace/members/:userId",
  requireWorkspace("member"),
  asyncHandler(async (req, res) => {
    const self = req.params.userId === req.user!.id;
    if (!self && req.workspace!.role === "member") throw new HttpError(403, "Only admins can remove members");
    const target = await one<{ role: string }>("SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [
      req.workspace!.id,
      req.params.userId,
    ]);
    if (!target) throw new HttpError(404, "Member not found");
    if (target.role === "owner") {
      if (req.workspace!.role !== "owner") throw new HttpError(403, "Only an owner can remove an owner");
      const owners = await one<{ n: number }>(
        "SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'",
        [req.workspace!.id]
      );
      if ((owners?.n ?? 0) <= 1) throw new HttpError(400, "A workspace needs at least one owner");
    }
    await query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [req.workspace!.id, req.params.userId]);
    res.json({ ok: true });
  })
);

workspacesRouter.post(
  "/workspace/invites",
  requireWorkspace("admin"),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(["admin", "member"]).default("member") }),
      req.body
    );
    const token = randomToken(24);
    await query(
      `UPDATE workspace_invites SET revoked_at = now() WHERE workspace_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [req.workspace!.id, body.email]
    );
    const invite = await one(
      `INSERT INTO workspace_invites (workspace_id, email, role, token_hash, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval) RETURNING id, email, role, expires_at`,
      [req.workspace!.id, body.email, body.role, sha256(token), req.user!.id, String(INVITE_DAYS)]
    );
    // The link is shown once; share it with the invitee yourself.
    res.status(201).json({ invite, link: `${getConfig().APP_URL}/invite/${token}` });
  })
);

workspacesRouter.delete(
  "/workspace/invites/:id",
  requireWorkspace("admin"),
  asyncHandler(async (req, res) => {
    await query("UPDATE workspace_invites SET revoked_at = now() WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspace!.id]);
    res.json({ ok: true });
  })
);

workspacesRouter.get(
  "/invites/:token",
  asyncHandler(async (req, res) => {
    const inv = await one(
      `SELECT i.email, i.role, w.name AS workspace_name FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
      [sha256(req.params.token)]
    );
    if (!inv) throw new HttpError(404, "This invite link is invalid or has expired");
    res.json({ invite: inv });
  })
);

workspacesRouter.post(
  "/invites/:token/accept",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await tx(async (db) => {
      const inv = (
        await db.query(
          `SELECT id, workspace_id, email, role FROM workspace_invites
            WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
          [sha256(req.params.token)]
        )
      ).rows[0];
      if (!inv) throw new HttpError(404, "This invite link is invalid or has expired");
      if (inv.email.toLowerCase() !== req.user!.email.toLowerCase()) {
        throw new HttpError(403, `This invite was sent to ${inv.email}. Sign in with that email to accept it.`);
      }
      await db.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [inv.workspace_id, req.user!.id, inv.role]
      );
      await db.query("UPDATE workspace_invites SET accepted_at = now() WHERE id = $1", [inv.id]);
      return inv.workspace_id;
    });
    res.json({ workspaceId: result });
  })
);
