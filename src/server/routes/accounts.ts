import { Router } from "express";
import { z } from "zod";
import { getConfig } from "../../config.js";
import { one, query } from "../../db/pool.js";
import { encryptSecret, randomToken } from "../../lib/crypto.js";
import { describeError } from "../../meta/errors.js";
import { authorizeUrl, createState, exchangeCode, fetchProfile, subscribeWebhooks, verifyState } from "../../meta/oauth.js";
import { getInstagramApi } from "../../meta/provider.js";
import { logSystemEvent } from "../../services/maintenance.js";
import { requireWorkspace } from "../auth.js";
import { HttpError, asyncHandler, parse } from "../http.js";

export const accountsRouter = Router();

const PUBLIC_COLUMNS = `id, ig_user_id, username, name, profile_picture_url, is_demo, webhook_subscribed, status, status_detail,
  token_expires_at, connected_at`;

accountsRouter.get(
  "/accounts",
  requireWorkspace("member"),
  asyncHandler(async (req, res) => {
    const accounts = await query(
      `SELECT ${PUBLIC_COLUMNS},
              (SELECT count(*)::int FROM campaigns c WHERE c.ig_account_id = a.id AND c.status = 'active') AS active_campaigns
         FROM ig_accounts a WHERE workspace_id = $1 AND status <> 'disconnected' ORDER BY connected_at`,
      [req.workspace!.id]
    );
    res.json({ accounts });
  })
);

accountsRouter.post(
  "/accounts/demo",
  requireWorkspace("admin"),
  asyncHandler(async (req, res) => {
    if (!getConfig().DEMO_MODE) throw new HttpError(403, "Demo mode is disabled (set DEMO_MODE=true)");
    const { username } = parse(
      z.object({ username: z.string().trim().regex(/^[a-zA-Z0-9._]{1,30}$/, "Letters, numbers, . and _ only").default("demo.creator") }),
      req.body ?? {}
    );
    const account = await one(
      `INSERT INTO ig_accounts (workspace_id, ig_user_id, username, name, is_demo, webhook_subscribed, token_expires_at)
       VALUES ($1, $2, $3, $4, true, true, now() + interval '60 days') RETURNING ${PUBLIC_COLUMNS}`,
      [req.workspace!.id, `demo_${randomToken(9)}`, username, "Demo account"]
    );
    res.status(201).json({ account });
  })
);

accountsRouter.get(
  "/instagram/connect",
  requireWorkspace("admin"),
  asyncHandler(async (req, res) => {
    if (!getConfig().metaConfigured) {
      throw new HttpError(400, "Meta app is not configured. Set INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET and WEBHOOK_VERIFY_TOKEN.");
    }
    res.json({ url: authorizeUrl(createState(req.workspace!.id, req.user!.id)) });
  })
);

/** OAuth redirect target. The browser lands here, so respond with redirects. */
accountsRouter.get(
  "/instagram/callback",
  asyncHandler(async (req, res) => {
    const back = (params: Record<string, string>) => res.redirect(`/accounts?${new URLSearchParams(params)}`);
    if (req.query.error) {
      return back({ error: String(req.query.error_description || req.query.error_reason || req.query.error) });
    }
    const state = verifyState(String(req.query.state ?? ""));
    if (!state) return back({ error: "Login session expired or was tampered with. Please try connecting again." });
    if (!req.user || req.user.id !== state.u) return back({ error: "Please sign in as the user who started the connection." });
    const member = await one(
      "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND role IN ('owner','admin')",
      [state.w, state.u]
    );
    if (!member) return back({ error: "You no longer have admin access to that workspace." });
    const code = String(req.query.code ?? "");
    if (!code) return back({ error: "Instagram did not return an authorization code." });

    try {
      const token = await exchangeCode(code);
      const profile = await fetchProfile(token.accessToken);
      if (profile.account_type && !["BUSINESS", "MEDIA_CREATOR"].includes(profile.account_type)) {
        return back({ error: "Only Instagram Business or Creator (professional) accounts can be connected." });
      }
      const existing = await one<{ workspace_id: string; status: string }>(
        "SELECT workspace_id, status FROM ig_accounts WHERE ig_user_id = $1",
        [profile.user_id]
      );
      if (existing && existing.workspace_id !== state.w && existing.status !== "disconnected") {
        return back({ error: `@${profile.username} is already connected to another workspace. Disconnect it there first.` });
      }
      if (existing && existing.workspace_id !== state.w) {
        // Disconnected in another workspace: drop that stale row (and its campaigns)
        // so campaigns can never act across workspaces.
        await query("DELETE FROM ig_accounts WHERE ig_user_id = $1 AND workspace_id <> $2", [profile.user_id, state.w]);
      }
      let subscribed = false;
      let subError: string | null = null;
      try {
        subscribed = await subscribeWebhooks(token.accessToken);
      } catch (err) {
        subError = describeError(err);
      }
      await query(
        `INSERT INTO ig_accounts (workspace_id, ig_user_id, username, name, profile_picture_url, access_token_enc, token_expires_at,
                                  token_refreshed_at, webhook_subscribed, status, status_detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8, 'active', $9)
         ON CONFLICT (ig_user_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, username = EXCLUDED.username, name = EXCLUDED.name,
           profile_picture_url = EXCLUDED.profile_picture_url, access_token_enc = EXCLUDED.access_token_enc,
           token_expires_at = EXCLUDED.token_expires_at, token_refreshed_at = now(), webhook_subscribed = EXCLUDED.webhook_subscribed,
           status = 'active', status_detail = EXCLUDED.status_detail, updated_at = now()`,
        [
          state.w,
          profile.user_id,
          profile.username,
          profile.name ?? null,
          profile.profile_picture_url ?? null,
          encryptSecret(token.accessToken),
          token.expiresAt,
          subscribed,
          subError ? `Webhook subscription failed: ${subError}` : null,
        ]
      );
      return back({ connected: profile.username, ...(subError ? { warning: "Connected, but webhook subscription failed. Use Resubscribe." } : {}) });
    } catch (err) {
      await logSystemEvent("error", "oauth", "Instagram connection failed", { error: describeError(err) });
      return back({ error: `Instagram connection failed: ${describeError(err)}` });
    }
  })
);

async function loadAccount(workspaceId: string, id: string) {
  const a = await one("SELECT * FROM ig_accounts WHERE id = $1 AND workspace_id = $2 AND status <> 'disconnected'", [id, workspaceId]);
  if (!a) throw new HttpError(404, "Account not found");
  return a;
}

accountsRouter.post(
  "/accounts/:id/resubscribe",
  requireWorkspace("admin"),
  asyncHandler(async (req, res) => {
    const a = await loadAccount(req.workspace!.id, req.params.id);
    if (a.is_demo) return res.json({ subscribed: true });
    const { decryptSecret } = await import("../../lib/crypto.js");
    try {
      const ok = await subscribeWebhooks(decryptSecret(a.access_token_enc));
      await query("UPDATE ig_accounts SET webhook_subscribed = $2, status_detail = NULL WHERE id = $1", [a.id, ok]);
      res.json({ subscribed: ok });
    } catch (err) {
      throw new HttpError(502, `Webhook subscription failed: ${describeError(err)}`);
    }
  })
);

accountsRouter.get(
  "/accounts/:id/media",
  requireWorkspace("member"),
  asyncHandler(async (req, res) => {
    const a = await loadAccount(req.workspace!.id, req.params.id);
    try {
      res.json({ media: await getInstagramApi(a).listMedia(30) });
    } catch (err) {
      throw new HttpError(502, `Could not load posts from Instagram: ${describeError(err)}`);
    }
  })
);

accountsRouter.delete(
  "/accounts/:id",
  requireWorkspace("admin"),
  asyncHandler(async (req, res) => {
    const a = await loadAccount(req.workspace!.id, req.params.id);
    if (a.is_demo) {
      await query("DELETE FROM ig_accounts WHERE id = $1", [a.id]);
    } else {
      // Wipe the token immediately; keep logs for history. Campaigns are paused.
      await query(
        `UPDATE ig_accounts SET status = 'disconnected', access_token_enc = NULL, webhook_subscribed = false, updated_at = now() WHERE id = $1`,
        [a.id]
      );
      await query("UPDATE campaigns SET status = 'paused', updated_at = now() WHERE ig_account_id = $1", [a.id]);
    }
    res.json({ ok: true });
  })
);
