/**
 * Meta webhook verification and payload normalization.
 * Parsing rules mirror OpenReply's lib/meta/webhook.ts (self-comment and echo
 * filtering, ad original_media_id handling), extended with Story-reply detection.
 */
import { createHmac } from "node:crypto";
import { getConfig } from "../config.js";
import { hmac, safeEqual } from "../lib/crypto.js";
import type { TriggerKind } from "../lib/restrictions.js";

/** Secrets accepted for X-Hub-Signature-256. Instagram-Login apps sign with the
 *  Instagram app secret, Facebook-Login apps with the Facebook app secret, so
 *  both are accepted. Demo mode adds a local-only secret for the simulator. */
export function webhookSecrets(): string[] {
  const c = getConfig();
  const secrets = [c.INSTAGRAM_APP_SECRET, c.FACEBOOK_APP_SECRET].filter(Boolean);
  if (c.DEMO_MODE) secrets.push(demoWebhookSecret());
  return secrets;
}

export function demoWebhookSecret(): string {
  return hmac("demo-webhook-secret", "demo");
}

export function signBody(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(rawBody: string | Buffer, header: string | undefined | null): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  return webhookSecrets().some((secret) => {
    const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
    return safeEqual(header, expected);
  });
}

export interface NormalizedEvent {
  igUserId: string; // entry.id: the connected professional account
  kind: TriggerKind;
  externalId: string; // comment id or message mid
  senderId: string;
  senderUsername?: string;
  text: string;
  mediaId?: string; // post/reel id for comments; story id for story replies
  originalMediaId?: string; // organic post behind an ad
  occurredAt: Date;
}

interface Entry {
  id?: string;
  time?: number;
  changes?: Array<{ field?: string; value?: any }>;
  messaging?: Array<any>;
}

function toDate(ts: number | undefined, fallback: Date): Date {
  if (!ts || !Number.isFinite(ts)) return fallback;
  return new Date(ts > 1e12 ? ts : ts * 1000);
}

export function parseWebhook(payload: unknown, now: Date = new Date()): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const p = payload as { object?: string; entry?: Entry[] };
  if (!p || p.object !== "instagram" || !Array.isArray(p.entry)) return events;

  for (const entry of p.entry) {
    const accountId = entry.id ? String(entry.id) : undefined;
    const entryTime = toDate(entry.time, now);

    for (const change of entry.changes ?? []) {
      // live_comments are intentionally ignored: private replies to Live
      // comments are only valid during the broadcast.
      if (change.field !== "comments") continue;
      const v = change.value ?? {};
      const commentId = v.id ?? v.comment_id;
      const senderId = v.from?.id;
      const mediaId = v.media?.id ?? v.media_id;
      if (!accountId || !commentId || !senderId) continue;
      if (String(senderId) === accountId) continue; // own comment / own reply
      const original = v.media?.original_media_id;
      events.push({
        igUserId: accountId,
        kind: "comment",
        externalId: String(commentId),
        senderId: String(senderId),
        senderUsername: v.from?.username,
        text: typeof v.text === "string" ? v.text : "",
        mediaId: mediaId ? String(mediaId) : undefined,
        originalMediaId: original && original !== mediaId ? String(original) : undefined,
        occurredAt: entryTime,
      });
    }

    for (const m of entry.messaging ?? []) {
      const msg = m?.message;
      if (!msg) continue; // postbacks, reads, reactions, referrals: not triggers
      if (msg.is_echo || msg.is_deleted || msg.is_unsupported) continue;
      const senderId = m.sender?.id ? String(m.sender.id) : undefined;
      const owner = accountId ?? (m.recipient?.id ? String(m.recipient.id) : undefined);
      const text = typeof msg.text === "string" ? msg.text.trim() : "";
      if (!owner || !senderId || !msg.mid || !text) continue; // attachment-only, story mentions w/o text
      if (senderId === owner) continue;
      const story = msg.reply_to?.story;
      events.push({
        igUserId: owner,
        kind: story ? "story_reply" : "dm",
        externalId: String(msg.mid),
        senderId,
        text,
        mediaId: story?.id ? String(story.id) : undefined,
        occurredAt: toDate(m.timestamp, entryTime),
      });
    }
  }
  return events;
}
