import express, { Router } from "express";
import { getConfig } from "../../config.js";
import { getPool, one, query } from "../../db/pool.js";
import { hashIp, randomToken } from "../../lib/crypto.js";
import { getRedis } from "../../lib/redis.js";
import { reserve } from "../../lib/ratelimit.js";
import { parseSignedRequest } from "../../meta/oauth.js";
import { HEARTBEAT_KEY, getEventsQueue } from "../../queue.js";
import { clientIp } from "../auth.js";
import { asyncHandler } from "../http.js";
import { lastWebhookAt } from "./webhook.js";

export const publicRouter = Router();

/** Tracked link redirect: /r/:slug?r=<recipient token> */
publicRouter.get(
  "/r/:slug",
  asyncHandler(async (req, res) => {
    const link = await one<{ id: string; workspace_id: string; campaign_id: string; destination_url: string }>(
      "SELECT id, workspace_id, campaign_id, destination_url FROM tracked_links WHERE slug = $1",
      [req.params.slug]
    );
    if (!link) {
      res.status(404).type("text/plain").send("Link not found");
      return;
    }
    const r = typeof req.query.r === "string" && /^[A-Za-z0-9_-]{22}$/.test(req.query.r) ? req.query.r : null;
    const ua = req.header("user-agent") ?? "";
    const isBot = /bot|crawler|spider|facebookexternalhit|preview|slurp/i.test(ua);
    // Link-preview bots and floods don't count as clicks; the redirect still works.
    const allowed = (await reserve(`click:${clientIp(req)}`, 60, 60_000)).allowed;
    if (!isBot && allowed) {
      await query(
        `INSERT INTO link_clicks (workspace_id, campaign_id, tracked_link_id, recipient_hash, ip_hash, user_agent) VALUES ($1,$2,$3,$4,$5,$6)`,
        [link.workspace_id, link.campaign_id, link.id, r, hashIp(clientIp(req)), ua.slice(0, 300) || null]
      );
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.redirect(302, link.destination_url);
  })
);

publicRouter.get(
  "/api/health",
  asyncHandler(async (_req, res) => {
    const out: Record<string, unknown> = { status: "ok" };
    try {
      await getPool().query("SELECT 1");
      out.database = { ok: true };
    } catch (e) {
      out.database = { ok: false, error: (e as Error).message };
      out.status = "degraded";
    }
    try {
      const beat = await getRedis().get(HEARTBEAT_KEY);
      const counts = await getEventsQueue().getJobCounts("waiting", "active", "delayed", "failed");
      const age = beat ? Date.now() - Number(beat) : null;
      out.redis = { ok: true };
      out.worker = { healthy: age !== null && age < 60_000, lastHeartbeatMsAgo: age };
      out.queue = counts;
      if (!(out.worker as any).healthy) out.status = "degraded";
    } catch (e) {
      out.redis = { ok: false, error: (e as Error).message };
      out.status = "degraded";
    }
    out.lastWebhookAt = await lastWebhookAt().catch(() => null);
    out.demoMode = getConfig().DEMO_MODE;
    // ?soft=1 always answers 200 (dashboard); plain /api/health is for uptime checks.
    res.status(out.status === "ok" || _req.query.soft ? 200 : 503).json(out);
  })
);

// ── Meta platform callbacks (configure these URLs in the App Dashboard) ──────

function metaSecrets() {
  const c = getConfig();
  return [c.INSTAGRAM_APP_SECRET, c.FACEBOOK_APP_SECRET].filter(Boolean);
}

const form = express.urlencoded({ extended: false, limit: "64kb" });

/** Deauthorize callback: user removed the app from Instagram. */
publicRouter.post(
  "/api/meta/deauthorize",
  form,
  asyncHandler(async (req, res) => {
    const data = parseSignedRequest(req.body?.signed_request, metaSecrets());
    if (!data?.user_id) {
      res.status(400).json({ error: "Invalid signed_request" });
      return;
    }
    await query(
      `UPDATE ig_accounts SET status = 'disconnected', access_token_enc = NULL, webhook_subscribed = false, status_detail = 'Deauthorized from Instagram', updated_at = now()
        WHERE ig_user_id = $1`,
      [String(data.user_id)]
    );
    await query(
      "UPDATE campaigns SET status = 'paused' WHERE ig_account_id IN (SELECT id FROM ig_accounts WHERE ig_user_id = $1)",
      [String(data.user_id)]
    );
    res.json({ ok: true });
  })
);

/** Data deletion request callback: delete everything we hold for that account. */
publicRouter.post(
  "/api/meta/data-deletion",
  form,
  asyncHandler(async (req, res) => {
    const data = parseSignedRequest(req.body?.signed_request, metaSecrets());
    if (!data?.user_id) {
      res.status(400).json({ error: "Invalid signed_request" });
      return;
    }
    // Cascades to campaigns, events, logs, links and clicks for that account.
    await query("DELETE FROM ig_accounts WHERE ig_user_id = $1", [String(data.user_id)]);
    const code = randomToken(12);
    res.json({ url: `${getConfig().APP_URL}/data-deletion?code=${code}`, confirmation_code: code });
  })
);
