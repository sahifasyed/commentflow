import { Router } from "express";
import { z } from "zod";
import { one, query, tx } from "../../db/pool.js";
import { randomToken } from "../../lib/crypto.js";
import { BUTTON_TITLE_MAX, MAX_LINK_BUTTONS, PUBLIC_REPLY_MAX } from "../../lib/restrictions.js";
import { campaignAnalytics, campaignSummaries } from "../../services/analytics.js";
import { requireWorkspace } from "../auth.js";
import { HttpError, asyncHandler, parse } from "../http.js";

export const campaignsRouter = Router();

const httpUrl = z
  .string()
  .trim()
  .url("Must be a full URL starting with https://")
  .refine((u) => /^https?:\/\//i.test(u), "Only http(s) links are allowed");

// DM templates leave room for {username} expansion and tracked URLs inside
// Meta's 1000-byte text cap.
const DM_TEMPLATE_MAX_BYTES = 850;

export const campaignInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    igAccountId: z.string().uuid(),
    status: z.enum(["active", "paused"]).default("active"),
    triggerComments: z.boolean().default(true),
    triggerDms: z.boolean().default(false),
    triggerStoryReplies: z.boolean().default(false),
    postScope: z.enum(["any", "specific"]).default("any"),
    postIds: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
    keywords: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    matchMode: z.enum(["whole_word", "contains", "any_message"]).default("whole_word"),
    dmMessage: z
      .string()
      .trim()
      .min(1, "DM message is required")
      .refine((s) => Buffer.byteLength(s) <= DM_TEMPLATE_MAX_BYTES, `DM message is too long (max ~${DM_TEMPLATE_MAX_BYTES} bytes)`),
    links: z
      .array(z.object({ url: httpUrl, buttonLabel: z.string().trim().max(BUTTON_TITLE_MAX).optional().default("") }))
      .max(MAX_LINK_BUTTONS)
      .default([]),
    publicReplyEnabled: z.boolean().default(false),
    publicReplies: z.array(z.string().trim().min(1).max(PUBLIC_REPLY_MAX)).max(10).default([]),
    cooldownHours: z.number().int().min(0).max(720).default(0),
  })
  .superRefine((c, ctx) => {
    if (!c.triggerComments && !c.triggerDms && !c.triggerStoryReplies) {
      ctx.addIssue({ code: "custom", path: ["triggerComments"], message: "Choose at least one trigger" });
    }
    if (c.matchMode !== "any_message" && c.keywords.length === 0) {
      ctx.addIssue({ code: "custom", path: ["keywords"], message: "Add at least one keyword (or match any message)" });
    }
    if (c.triggerComments && c.postScope === "specific" && c.postIds.length === 0) {
      ctx.addIssue({ code: "custom", path: ["postIds"], message: "Pick at least one post, or choose any post" });
    }
    if (c.publicReplyEnabled && c.publicReplies.length === 0) {
      ctx.addIssue({ code: "custom", path: ["publicReplies"], message: "Add at least one public reply" });
    }
  });

type CampaignInput = z.infer<typeof campaignInput>;

async function assertAccount(workspaceId: string, accountId: string, activating: boolean) {
  const a = await one<{ status: string }>("SELECT status FROM ig_accounts WHERE id = $1 AND workspace_id = $2", [accountId, workspaceId]);
  if (!a || a.status === "disconnected") throw new HttpError(400, "Instagram account not found in this workspace");
  if (activating && a.status !== "active") throw new HttpError(400, "Reconnect this Instagram account before activating campaigns");
}

async function loadCampaign(workspaceId: string, id: string) {
  const c = await one("SELECT * FROM campaigns WHERE id = $1 AND workspace_id = $2", [id, workspaceId]);
  if (!c) throw new HttpError(404, "Campaign not found");
  const links = await query(
    "SELECT id, slug, destination_url, button_label, position FROM tracked_links WHERE campaign_id = $1 ORDER BY position",
    [id]
  );
  return { ...c, links };
}

async function writeLinks(db: any, workspaceId: string, campaignId: string, links: CampaignInput["links"]) {
  // Update in place by position so existing tracked URLs (already sent in DMs)
  // keep working and keep their click history.
  for (const [position, l] of links.entries()) {
    await db.query(
      `INSERT INTO tracked_links (workspace_id, campaign_id, slug, destination_url, button_label, position)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (campaign_id, position) DO UPDATE SET destination_url = EXCLUDED.destination_url, button_label = EXCLUDED.button_label`,
      [workspaceId, campaignId, randomToken(6), l.url, l.buttonLabel || null, position]
    );
  }
  await db.query("DELETE FROM tracked_links WHERE campaign_id = $1 AND position >= $2", [campaignId, links.length]);
}

const columns = (c: CampaignInput) => [
  c.name, c.igAccountId, c.status, c.triggerComments, c.triggerDms, c.triggerStoryReplies, c.postScope,
  c.postScope === "specific" ? c.postIds : [], c.keywords, c.matchMode, c.dmMessage, c.publicReplyEnabled,
  c.publicReplies, c.cooldownHours,
];

campaignsRouter.get(
  "/campaigns",
  requireWorkspace("member"),
  asyncHandler(async (req, res) => {
    res.json({ campaigns: await campaignSummaries(req.workspace!.id) });
  })
);

campaignsRouter.post(
  "/campaigns",
  requireWorkspace("admin"),
  asyncHandler(async (req, res) => {
    const c = parse(campaignInput, req.body);
    await assertAccount(req.workspace!.id, c.igAccountId, c.status === "active");
    const id = await tx(async (db): Promise<string> => {
      const newId: string = (
        await db.query(
          `INSERT INTO campaigns (name, ig_account_id, status, trigger_comments, trigger_dms, trigger_story_replies, post_scope, post_ids,
             keywords, match_mode, dm_message, public_reply_enabled, public_replies, cooldown_hours, workspace_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
          [...columns(c), req.workspace!.id, req.user!.id]
        )
      ).rows[0].id;
      await writeLinks(db, req.workspace!.id, newId, c.links);
      return newId;
    });
    res.status(201).json({ campaign: await loadCampaign(req.workspace!.id, id) });
  })
);

campaignsRouter.get(
  "/campaigns/:id",
  requireWorkspace("member"),
  asyncHandler(async (req, res) => {
    res.json({ campaign: await loadCampaign(req.workspace!.id, req.params.id) });
  })
);

campaignsRouter.put(
  "/campaigns/:id",
  requireWorkspace("admin"),
  asyncHandler(async (req, res) => {
    await loadCampaign(req.workspace!.id, req.params.id);
    const c = parse(campaignInput, req.body);
    await assertAccount(req.workspace!.id, c.igAccountId, c.status === "active");
    await tx(async (db) => {
      await db.query(
        `UPDATE campaigns SET name=$1, ig_account_id=$2, status=$3, trigger_comments=$4, trigger_dms=$5, trigger_story_replies=$6,
           post_scope=$7, post_ids=$8, keywords=$9, match_mode=$10, dm_message=$11, public_reply_enabled=$12, public_replies=$13,
           cooldown_hours=$14, updated_at=now() WHERE id=$15 AND workspace_id=$16`,
        [...columns(c), req.params.id, req.workspace!.id]
      );
      await writeLinks(db, req.workspace!.id, req.params.id, c.links);
    });
    res.json({ campaign: await loadCampaign(req.workspace!.id, req.params.id) });
  })
);

campaignsRouter.patch(
  "/campaigns/:id/status",
  requireWorkspace("admin"),
  asyncHandler(async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(["active", "paused"]) }), req.body);
    const c = await loadCampaign(req.workspace!.id, req.params.id);
    if (status === "active") await assertAccount(req.workspace!.id, c.ig_account_id, true);
    await query("UPDATE campaigns SET status = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2", [c.id, req.workspace!.id, status]);
    res.json({ ok: true, status });
  })
);

campaignsRouter.delete(
  "/campaigns/:id",
  requireWorkspace("admin"),
  asyncHandler(async (req, res) => {
    const r = await query("DELETE FROM campaigns WHERE id = $1 AND workspace_id = $2 RETURNING id", [req.params.id, req.workspace!.id]);
    if (!r.length) throw new HttpError(404, "Campaign not found");
    res.json({ ok: true });
  })
);

campaignsRouter.get(
  "/campaigns/:id/analytics",
  requireWorkspace("member"),
  asyncHandler(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    await loadCampaign(req.workspace!.id, req.params.id);
    res.json(await campaignAnalytics(req.workspace!.id, req.params.id, days));
  })
);
