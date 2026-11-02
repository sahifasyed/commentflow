/**
 * Event processor (runs in the worker).
 *
 * For each active campaign on the account that matches the trigger:
 *   1. upsert a message_logs row (campaign x event is unique -> idempotent)
 *   2. public reply leg (comments only, optional), independent of the DM
 *   3. DM leg: Meta restriction checks -> hourly limit reservation -> atomic
 *      claim (pending -> sending) -> send -> record outcome
 *
 * The whole function is safe to re-run for the same event: finished legs are
 * skipped, in-flight/uncertain legs are never re-sent.
 */
import { getConfig } from "../config.js";
import { one, query } from "../db/pool.js";
import { matchCampaign, type MatchMode } from "../lib/keywords.js";
import { release, reserve, sendBucket } from "../lib/ratelimit.js";
import {
  PUBLIC_REPLY_MAX,
  SKIP_REASON_LABELS,
  checkSendWindow,
  clampText,
  type SkipReason,
  type TriggerKind,
} from "../lib/restrictions.js";
import { pickRandom, renderForButtons, renderInline, renderPublicReply, trackedUrl } from "../lib/templates.js";
import type { InstagramApi, OutboundMessage } from "../meta/api.js";
import { classifyError, describeError, type ErrorClass } from "../meta/errors.js";
import { getInstagramApi } from "../meta/provider.js";

export const MAX_SEND_ATTEMPTS = 3;
const HOUR = 3600_000;

export interface ProcessOutcome {
  /** Our own hourly limiter is full: re-run the event after this delay. */
  deferMs?: number;
  /** Meta throttled us (explicit rejection, safe to retry with backoff). */
  retryableError?: Error;
  matchedCampaigns: number;
}

interface EventRow {
  id: string;
  workspace_id: string;
  ig_account_id: string;
  kind: TriggerKind;
  external_id: string;
  sender_id: string;
  sender_username: string | null;
  text: string;
  media_id: string | null;
  original_media_id: string | null;
  occurred_at: Date;
  // account
  ig_user_id: string;
  is_demo: boolean;
  access_token_enc: string | null;
  account_status: string;
}

interface CampaignRow {
  id: string;
  name: string;
  keywords: string[];
  match_mode: MatchMode;
  dm_message: string;
  public_reply_enabled: boolean;
  public_replies: string[];
  cooldown_hours: number;
}

interface LogRow {
  id: string;
  dm_status: string;
  attempts: number;
  public_reply_status: string;
}

async function setDm(logId: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await query(`UPDATE message_logs SET ${sets}, updated_at = now() WHERE id = $1`, [logId, ...keys.map((k) => fields[k])]);
}

async function skip(logId: string, reason: SkipReason) {
  await setDm(logId, { dm_status: "skipped", skip_reason: reason, error: SKIP_REASON_LABELS[reason] });
}

function limitFor(kind: "private_reply" | "dm" | "public_reply") {
  const c = getConfig();
  return kind === "private_reply" ? c.PRIVATE_REPLY_HOURLY_LIMIT : kind === "dm" ? c.DM_HOURLY_LIMIT : c.PUBLIC_REPLY_HOURLY_LIMIT;
}

async function markAccountAuthFailure(accountId: string, err: unknown) {
  await query(
    `UPDATE ig_accounts SET status = 'token_expired', status_detail = $2, updated_at = now() WHERE id = $1 AND status = 'active'`,
    [accountId, describeError(err).slice(0, 500)]
  );
}

async function resolveUsername(ev: EventRow, api: InstagramApi | null): Promise<string | null> {
  if (ev.sender_username) return ev.sender_username;
  const conv = await one<{ username: string | null }>(
    "SELECT username FROM conversations WHERE ig_account_id = $1 AND igsid = $2",
    [ev.ig_account_id, ev.sender_id]
  );
  if (conv?.username) return conv.username;
  // Comments carry the username; for DMs we may already know it from a comment.
  const prior = await one<{ sender_username: string }>(
    `SELECT sender_username FROM inbound_events WHERE ig_account_id = $1 AND sender_id = $2 AND sender_username IS NOT NULL LIMIT 1`,
    [ev.ig_account_id, ev.sender_id]
  );
  let name = prior?.sender_username ?? null;
  if (!name && api) name = await api.getUsername(ev.sender_id);
  if (name) {
    await query("UPDATE conversations SET username = $3 WHERE ig_account_id = $1 AND igsid = $2", [ev.ig_account_id, ev.sender_id, name]);
  }
  return name;
}

export async function processInboundEvent(eventId: string, now: Date = new Date()): Promise<ProcessOutcome> {
  const outcome: ProcessOutcome = { matchedCampaigns: 0 };
  const ev = await one<EventRow>(
    `SELECT e.*, a.ig_user_id, a.is_demo, a.access_token_enc, a.status AS account_status
       FROM inbound_events e JOIN ig_accounts a ON a.id = e.ig_account_id WHERE e.id = $1`,
    [eventId]
  );
  if (!ev) return outcome;

  const triggerColumn =
    ev.kind === "comment" ? "trigger_comments" : ev.kind === "dm" ? "trigger_dms" : "trigger_story_replies";
  const campaigns = await query<CampaignRow>(
    `SELECT id, name, keywords, match_mode, dm_message, public_reply_enabled, public_replies, cooldown_hours
       FROM campaigns
      WHERE ig_account_id = $1 AND status = 'active' AND ${triggerColumn} = true
        AND ($2::text <> 'comment' OR post_scope = 'any' OR $3::text = ANY(post_ids) OR $4::text = ANY(post_ids))
      ORDER BY created_at ASC`,
    [ev.ig_account_id, ev.kind, ev.media_id ?? "", ev.original_media_id ?? ""]
  );

  const matched = campaigns
    .map((c) => ({ c, m: matchCampaign(ev.text, c.keywords, c.match_mode) }))
    .filter((x) => x.m.matched);
  outcome.matchedCampaigns = matched.length;
  if (matched.length === 0) {
    await query("UPDATE inbound_events SET processed_at = now() WHERE id = $1", [ev.id]);
    return outcome;
  }

  let api: InstagramApi | null = null;
  let apiError: string | null = null;
  if (ev.account_status === "active") {
    try {
      api = getInstagramApi({
        id: ev.ig_account_id,
        ig_user_id: ev.ig_user_id,
        is_demo: ev.is_demo,
        access_token_enc: ev.access_token_enc,
      });
    } catch (err) {
      apiError = `Could not load Instagram credentials: ${(err as Error).message}`;
    }
  }
  const username = await resolveUsername(ev, api);
  const conv = await one<{ last_inbound_at: Date }>(
    "SELECT last_inbound_at FROM conversations WHERE ig_account_id = $1 AND igsid = $2",
    [ev.ig_account_id, ev.sender_id]
  );
  const links = await query<{ campaign_id: string; slug: string; destination_url: string; button_label: string | null }>(
    "SELECT campaign_id, slug, destination_url, button_label FROM tracked_links WHERE campaign_id = ANY($1) ORDER BY position",
    [matched.map((x) => x.c.id)]
  );
  const baseUrl = getConfig().APP_URL;

  for (const { c, m } of matched) {
    const log = await one<LogRow>(
      `INSERT INTO message_logs
         (workspace_id, campaign_id, ig_account_id, inbound_event_id, trigger_kind, recipient_id, recipient_username, trigger_text, matched_keyword,
          public_reply_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (campaign_id, inbound_event_id) DO UPDATE SET recipient_username = COALESCE(message_logs.recipient_username, EXCLUDED.recipient_username)
       RETURNING id, dm_status, attempts, public_reply_status`,
      [
        ev.workspace_id, c.id, ev.ig_account_id, ev.id, ev.kind, ev.sender_id, username, ev.text, m.matchedKeyword,
        ev.kind === "comment" && c.public_reply_enabled && c.public_replies.length > 0 ? "pending" : "none",
      ]
    );
    if (!log) continue;

    if (!api) {
      if (log.dm_status === "pending") {
        if (apiError) await setDm(log.id, { dm_status: "failed", error: apiError });
        else await skip(log.id, "account_inactive");
      }
      continue;
    }

    // ── Public reply leg ────────────────────────────────────────────────────
    if (log.public_reply_status === "pending") {
      const res = await sendPublicReply(api, ev, c, log, username);
      if (res.deferMs) outcome.deferMs = Math.min(outcome.deferMs ?? Infinity, res.deferMs);
      if (res.retryable) outcome.retryableError = res.retryable;
      if (res.authFailed) {
        api = null;
        continue;
      }
    }

    // ── DM leg ───────────────────────────────────────────────────────────────
    if (log.dm_status !== "pending") continue;

    const windowSkip = checkSendWindow({ kind: ev.kind, occurredAt: ev.occurred_at, lastInboundAt: conv?.last_inbound_at, now });
    if (windowSkip) {
      await skip(log.id, windowSkip);
      continue;
    }
    if (c.cooldown_hours > 0) {
      const recent = await one(
        `SELECT 1 FROM message_logs WHERE campaign_id = $1 AND recipient_id = $2 AND dm_status = 'sent' AND sent_at > $3 AND id <> $4 LIMIT 1`,
        [c.id, ev.sender_id, new Date(now.getTime() - c.cooldown_hours * HOUR), log.id]
      );
      if (recent) {
        await skip(log.id, "cooldown");
        continue;
      }
    }
    if (ev.kind === "comment") {
      const taken = await one(
        `SELECT 1 FROM message_logs WHERE inbound_event_id = $1 AND id <> $2 AND dm_status IN ('sending','sent','unconfirmed') LIMIT 1`,
        [ev.id, log.id]
      );
      if (taken) {
        await skip(log.id, "comment_already_replied");
        continue;
      }
    }
    if (log.attempts >= MAX_SEND_ATTEMPTS) {
      await setDm(log.id, { dm_status: "failed", skip_reason: "max_attempts", error: SKIP_REASON_LABELS.max_attempts });
      continue;
    }

    const bucketKind = ev.kind === "comment" ? "private_reply" : "dm";
    const bucket = sendBucket(bucketKind, ev.ig_account_id);
    const slot = await reserve(bucket, limitFor(bucketKind), HOUR);
    if (!slot.allowed) {
      await setDm(log.id, { error: `Waiting for hourly ${bucketKind.replace("_", " ")} limit (${limitFor(bucketKind)}/h)` });
      outcome.deferMs = Math.min(outcome.deferMs ?? Infinity, Math.max(slot.resetInMs, 1000));
      continue;
    }

    // Atomic claim. The partial unique index enforces one private reply per
    // comment even if two workers race.
    let claimed: { id: string } | null = null;
    try {
      claimed = await one(
        `UPDATE message_logs SET dm_status = 'sending', attempts = attempts + 1, error = NULL, updated_at = now()
          WHERE id = $1 AND dm_status = 'pending' RETURNING id`,
        [log.id]
      );
    } catch (err: any) {
      await release(bucket);
      if (err?.code === "23505") {
        await skip(log.id, "comment_already_replied");
        continue;
      }
      throw err;
    }
    if (!claimed) {
      await release(bucket);
      continue;
    }

    const campaignLinks = links.filter((l) => l.campaign_id === c.id);
    const ctx = { username, recipientId: ev.sender_id, baseUrl };
    const inlineText = renderInline(c.dm_message, {
      ...ctx,
      links: campaignLinks.map((l) => ({ slug: l.slug, destinationUrl: l.destination_url })),
    });
    let message: OutboundMessage = campaignLinks.length
      ? {
          text: renderForButtons(c.dm_message, ctx) || "Here's your link 👇",
          buttons: campaignLinks.map((l) => ({
            title: l.button_label || "Open link",
            url: trackedUrl(baseUrl, l.slug, ev.sender_id),
          })),
        }
      : { text: inlineText };

    const send = (msg: OutboundMessage) =>
      ev.kind === "comment" ? api!.sendPrivateReply(ev.external_id, msg) : api!.sendDirectMessage(ev.sender_id, msg);

    let result: { messageId: string } | null = null;
    let error: unknown = null;
    try {
      result = await send(message);
    } catch (err) {
      error = err;
      // A button-template rejection proves nothing was delivered; fall back to
      // plain text with the tracked link inline.
      if (classifyError(err) === "template_rejected" && message.buttons) {
        message = { text: inlineText };
        error = null;
        try {
          result = await send(message);
        } catch (err2) {
          error = err2;
        }
      }
    }

    if (result) {
      await setDm(log.id, {
        dm_status: "sent",
        dm_message_id: result.messageId,
        dm_text: message.buttons
          ? `${message.text}\n${message.buttons.map((b) => `[${b.title}] ${b.url}`).join("\n")}`
          : message.text,
        sent_at: new Date(),
        error: null,
      });
      continue;
    }

    const cls: ErrorClass = classifyError(error);
    const detail = describeError(error).slice(0, 1000);
    if (cls === "unconfirmed") {
      // Keep the rate-limit slot: the message may have been delivered.
      await setDm(log.id, {
        dm_status: "unconfirmed",
        error: `Delivery unconfirmed; not retried automatically to avoid a duplicate DM. ${detail}`,
      });
      continue;
    }
    await release(bucket);
    if (cls === "rate_limited") {
      await setDm(log.id, { dm_status: "pending", error: `Instagram rate limit, will retry: ${detail}` });
      outcome.retryableError = new Error(detail);
    } else if (cls === "auth") {
      await setDm(log.id, { dm_status: "failed", error: `Instagram token rejected; reconnect the account. ${detail}` });
      await markAccountAuthFailure(ev.ig_account_id, error);
      api = null;
    } else {
      await setDm(log.id, { dm_status: "failed", error: detail });
    }
  }

  await query("UPDATE inbound_events SET processed_at = now() WHERE id = $1", [ev.id]);
  return outcome;
}

async function sendPublicReply(
  api: InstagramApi,
  ev: EventRow,
  c: CampaignRow,
  log: LogRow,
  username: string | null
): Promise<{ deferMs?: number; retryable?: Error; authFailed?: boolean }> {
  const bucket = sendBucket("public_reply", ev.ig_account_id);
  const slot = await reserve(bucket, limitFor("public_reply"), HOUR);
  if (!slot.allowed) return { deferMs: Math.max(slot.resetInMs, 1000) };

  const claimed = await one(
    `UPDATE message_logs SET public_reply_status = 'sending', updated_at = now()
      WHERE id = $1 AND public_reply_status = 'pending' RETURNING id`,
    [log.id]
  );
  if (!claimed) {
    await release(bucket);
    return {};
  }
  const text = clampText(renderPublicReply(pickRandom(c.public_replies) ?? "", username), PUBLIC_REPLY_MAX);
  try {
    await api.replyToComment(ev.external_id, text);
    await query(
      `UPDATE message_logs SET public_reply_status = 'sent', public_reply_text = $2, public_reply_error = NULL, updated_at = now() WHERE id = $1`,
      [log.id, text]
    );
    return {};
  } catch (err) {
    const cls = classifyError(err);
    const detail = describeError(err).slice(0, 1000);
    if (cls === "unconfirmed") {
      await query(
        `UPDATE message_logs SET public_reply_status = 'unconfirmed', public_reply_text = $2, public_reply_error = $3, updated_at = now() WHERE id = $1`,
        [log.id, text, detail]
      );
      return {};
    }
    await release(bucket);
    const retry = cls === "rate_limited";
    await query(
      `UPDATE message_logs SET public_reply_status = $2, public_reply_error = $3, updated_at = now() WHERE id = $1`,
      [log.id, retry ? "pending" : "failed", detail]
    );
    if (cls === "auth") {
      await markAccountAuthFailure(ev.ig_account_id, err);
      await query(`UPDATE message_logs SET dm_status = 'failed', error = $2 WHERE id = $1 AND dm_status = 'pending'`, [
        log.id,
        `Instagram token rejected; reconnect the account. ${detail}`,
      ]);
      return { authFailed: true };
    }
    return retry ? { retryable: new Error(detail) } : {};
  }
}
