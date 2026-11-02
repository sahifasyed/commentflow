/**
 * Demo simulator: builds a Meta-shaped webhook payload, signs it with the
 * demo-only secret and pushes it through the exact same verification +
 * ingestion path as a real Meta delivery. Only available when DEMO_MODE=true
 * and only for demo accounts.
 */
import { Router } from "express";
import { z } from "zod";
import { getConfig } from "../../config.js";
import { one, query } from "../../db/pool.js";
import { randomToken } from "../../lib/crypto.js";
import { demoWebhookSecret, signBody, verifySignature } from "../../meta/webhook.js";
import { ingestWebhook } from "../../services/ingest.js";
import { requireWorkspace } from "../auth.js";
import { HttpError, asyncHandler, parse } from "../http.js";

export const demoRouter = Router();

const simulateSchema = z.object({
  accountId: z.string().uuid(),
  kind: z.enum(["comment", "dm", "story_reply"]),
  text: z.string().trim().min(1).max(500),
  username: z.string().trim().regex(/^[a-zA-Z0-9._]{1,30}$/).default("happy.follower"),
  mediaId: z.string().trim().max(64).optional(),
  scenario: z.enum(["normal", "rate_limit", "reject", "network", "template"]).default("normal"),
  ageHours: z.number().min(0).max(24 * 30).default(0),
  /** Re-send the identical body to demonstrate duplicate suppression. */
  repeat: z.number().int().min(1).max(3).default(1),
});

export function buildDemoPayload(input: z.infer<typeof simulateSchema>, igUserId: string) {
  const sc = input.scenario === "normal" ? "" : `__sc_${input.scenario}`;
  // A stable per-username sender id so cooldowns and conversations behave realistically.
  const senderId = `demo_user_${Buffer.from(input.username).toString("hex").slice(0, 16)}${sc}`;
  const ts = Date.now() - input.ageHours * 3600_000;
  if (input.kind === "comment") {
    return {
      object: "instagram",
      entry: [
        {
          id: igUserId,
          time: Math.floor(ts / 1000),
          changes: [
            {
              field: "comments",
              value: {
                id: `demo_comment_${randomToken(8)}${sc}`,
                from: { id: senderId, username: input.username },
                text: input.text,
                media: { id: input.mediaId || "demo_media_reel_1", media_product_type: "REELS" },
              },
            },
          ],
        },
      ],
    };
  }
  return {
    object: "instagram",
    entry: [
      {
        id: igUserId,
        time: ts,
        messaging: [
          {
            sender: { id: senderId },
            recipient: { id: igUserId },
            timestamp: ts,
            message: {
              mid: `demo_mid_${randomToken(10)}`,
              text: input.text,
              ...(input.kind === "story_reply"
                ? { reply_to: { story: { id: input.mediaId || "demo_story_1", url: "https://example.com/story.jpg" } } }
                : {}),
            },
          },
        ],
      },
    ],
  };
}

demoRouter.post(
  "/demo/simulate",
  requireWorkspace("admin"),
  asyncHandler(async (req, res) => {
    if (!getConfig().DEMO_MODE) throw new HttpError(403, "Demo mode is disabled");
    const input = parse(simulateSchema, req.body);
    const acct = await one<{ ig_user_id: string; is_demo: boolean }>(
      "SELECT ig_user_id, is_demo FROM ig_accounts WHERE id = $1 AND workspace_id = $2 AND status <> 'disconnected'",
      [input.accountId, req.workspace!.id]
    );
    if (!acct) throw new HttpError(404, "Account not found");
    if (!acct.is_demo) throw new HttpError(400, "The simulator only works with demo accounts");

    const body = JSON.stringify(buildDemoPayload(input, acct.ig_user_id));
    const signature = signBody(body, demoWebhookSecret());
    if (!verifySignature(body, signature)) throw new HttpError(500, "Demo signature failed verification");
    const results = [];
    for (let i = 0; i < input.repeat; i++) results.push(await ingestWebhook(body, JSON.parse(body)));
    res.json({ deliveries: results, payload: JSON.parse(body) });
  })
);

demoRouter.get(
  "/demo/outbox",
  requireWorkspace("member"),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT o.id, o.kind, o.recipient, o.body, o.created_at, a.username AS account_username
         FROM demo_outbox o JOIN ig_accounts a ON a.id = o.ig_account_id
        WHERE a.workspace_id = $1 ORDER BY o.id DESC LIMIT 50`,
      [req.workspace!.id]
    );
    res.json({ outbox: rows });
  })
);
