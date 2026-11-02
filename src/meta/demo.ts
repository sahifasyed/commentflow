/**
 * Demo provider: behaves like the Graph API but records outbound messages in
 * demo_outbox instead of calling Meta. Used by demo-mode accounts so the whole
 * pipeline (webhook -> queue -> worker -> logs -> analytics) can be exercised
 * without credentials.
 *
 * Failure scenarios are selected by a marker embedded in the simulated comment
 * id / sender id: "__sc_<scenario>".
 *   rate_limit   -> first attempt fails with Meta code 4, retry succeeds
 *   reject       -> permanent code 100 rejection
 *   network      -> network error (delivery unconfirmed, never retried)
 *   template     -> button template rejected (falls back to inline text)
 */
import type { InstagramApi, Media, OutboundMessage } from "./api.js";
import { MetaApiError, NetworkError } from "./errors.js";
import { query } from "../db/pool.js";

export type DemoScenario = "normal" | "rate_limit" | "reject" | "network" | "template";

const rateLimitedOnce = new Set<string>();

export function scenarioOf(id: string): DemoScenario {
  const m = /__sc_([a-z_]+)/.exec(id);
  const s = m?.[1] as DemoScenario | undefined;
  return s && ["rate_limit", "reject", "network", "template"].includes(s) ? s : "normal";
}

export const DEMO_MEDIA: Media[] = [
  { id: "demo_media_reel_1", caption: "How I grew to 10k — comment GUIDE for the free PDF", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-10-28T10:00:00+0000" },
  { id: "demo_media_post_2", caption: "New drop is live. Comment LINK and I'll DM you the shop link", media_type: "IMAGE", media_product_type: "FEED", timestamp: "2026-10-25T16:30:00+0000" },
  { id: "demo_media_reel_3", caption: "My exact morning routine (comment ROUTINE)", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-10-20T08:15:00+0000" },
  { id: "demo_media_post_4", caption: "Giveaway! Comment WIN to enter", media_type: "CAROUSEL_ALBUM", media_product_type: "FEED", timestamp: "2026-10-12T19:45:00+0000" },
];

export class DemoInstagramApi implements InstagramApi {
  constructor(private readonly igAccountId: string) {}

  private async record(kind: string, recipient: string, body: unknown) {
    await query("INSERT INTO demo_outbox (ig_account_id, kind, recipient, body) VALUES ($1,$2,$3,$4)", [
      this.igAccountId,
      kind,
      recipient,
      JSON.stringify(body),
    ]);
  }

  private fail(recipient: string, isTemplate: boolean) {
    const s = scenarioOf(recipient);
    if (s === "reject") throw new MetaApiError("(#100) Demo: recipient cannot receive messages", 100, 2534022, 400);
    if (s === "network") throw new NetworkError("Demo: connection reset after request was sent");
    if (s === "template" && isTemplate) throw new MetaApiError("(#100) Demo: button template not supported", 100, undefined, 400);
    if (s === "rate_limit" && !rateLimitedOnce.has(recipient)) {
      rateLimitedOnce.add(recipient);
      throw new MetaApiError("(#4) Demo: application request limit reached", 4, undefined, 400);
    }
  }

  private async send(kind: string, recipient: string, message: OutboundMessage) {
    this.fail(recipient, Boolean(message.buttons?.length));
    await this.record(kind, recipient, message);
    return { messageId: `demo_mid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
  }

  sendPrivateReply(commentId: string, message: OutboundMessage) {
    return this.send("private_reply", commentId, message);
  }

  sendDirectMessage(igsid: string, message: OutboundMessage) {
    return this.send("dm", igsid, message);
  }

  async replyToComment(commentId: string, text: string) {
    if (scenarioOf(commentId) === "reject") {
      throw new MetaApiError("(#100) Demo: comment replies disabled", 100, undefined, 400);
    }
    await this.record("comment_reply", commentId, { text });
    return { id: `demo_reply_${Date.now()}` };
  }

  async listMedia() {
    return DEMO_MEDIA;
  }

  async getUsername() {
    return null;
  }
}
