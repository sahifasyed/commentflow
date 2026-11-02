/**
 * Webhook ingestion (runs in the web process).
 *
 * Everything is written in one transaction BEFORE we answer 200, so if the
 * database is down we return 500 and Meta redelivers. Dedup happens at two
 * levels:
 *   1. webhook_deliveries.body_sha256  - identical redelivered bodies
 *   2. inbound_events (account, kind, external_id) - the same comment/message
 *      arriving in a different batch
 * Queueing happens after commit with jobId = event id. If Redis is briefly
 * unavailable the worker's sweeper enqueues anything left un-enqueued.
 */
import { sha256 } from "../lib/crypto.js";
import { query, tx } from "../db/pool.js";
import { parseWebhook } from "../meta/webhook.js";
import { enqueueEvent } from "../queue.js";

export interface IngestResult {
  duplicate: boolean;
  parsed: number;
  stored: number;
  enqueued: number;
}

export async function ingestWebhook(rawBody: string, payload: unknown): Promise<IngestResult> {
  const bodyHash = sha256(rawBody);
  const events = parseWebhook(payload);

  const stored = await tx(async (db) => {
    const delivery = await db.query(
      `INSERT INTO webhook_deliveries (body_sha256, payload, event_count) VALUES ($1, $2, $3)
       ON CONFLICT (body_sha256) DO NOTHING RETURNING id`,
      [bodyHash, rawBody, events.length]
    );
    if (delivery.rowCount === 0) return null; // exact duplicate delivery

    if (events.length === 0) return [];
    const igIds = [...new Set(events.map((e) => e.igUserId))];
    const accounts = await db.query(
      `SELECT id, workspace_id, ig_user_id FROM ig_accounts WHERE ig_user_id = ANY($1) AND status <> 'disconnected'`,
      [igIds]
    );
    const byIg = new Map(accounts.rows.map((a) => [a.ig_user_id, a]));

    const ids: string[] = [];
    for (const e of events) {
      const acct = byIg.get(e.igUserId);
      if (!acct) continue; // not one of ours
      const ins = await db.query(
        `INSERT INTO inbound_events
           (workspace_id, ig_account_id, kind, external_id, sender_id, sender_username, text, media_id, original_media_id, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (ig_account_id, kind, external_id) DO NOTHING RETURNING id`,
        [acct.workspace_id, acct.id, e.kind, e.externalId, e.senderId, e.senderUsername ?? null, e.text, e.mediaId ?? null, e.originalMediaId ?? null, e.occurredAt]
      );
      if (e.kind !== "comment") {
        // Inbound DM (incl. story reply) opens/extends the 24h messaging window.
        await db.query(
          `INSERT INTO conversations (ig_account_id, igsid, last_inbound_at) VALUES ($1,$2,$3)
           ON CONFLICT (ig_account_id, igsid) DO UPDATE SET last_inbound_at = GREATEST(conversations.last_inbound_at, EXCLUDED.last_inbound_at)`,
          [acct.id, e.senderId, e.occurredAt]
        );
      }
      if (ins.rows[0]) ids.push(ins.rows[0].id);
    }
    return ids;
  });

  if (stored === null) return { duplicate: true, parsed: events.length, stored: 0, enqueued: 0 };

  let enqueued = 0;
  for (const id of stored) {
    try {
      await enqueueEvent(id);
      await query("UPDATE inbound_events SET enqueued_at = now() WHERE id = $1", [id]);
      enqueued++;
    } catch (err) {
      console.error("[ingest] enqueue failed; sweeper will retry", id, (err as Error).message);
    }
  }
  return { duplicate: false, parsed: events.length, stored: stored.length, enqueued };
}
