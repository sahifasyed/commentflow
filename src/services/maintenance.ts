import { query } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { classifyError, describeError } from "../meta/errors.js";
import { refreshLongLivedToken } from "../meta/oauth.js";
import { enqueueEvent } from "../queue.js";

export async function logSystemEvent(level: "info" | "warning" | "error", source: string, message: string, detail?: unknown) {
  await query("INSERT INTO system_events (level, source, message, detail) VALUES ($1,$2,$3,$4)", [
    level,
    source,
    message,
    detail === undefined ? null : JSON.stringify(detail),
  ]).catch(() => {});
}

/** Re-enqueue events whose post-commit enqueue failed (e.g. Redis blip). */
export async function sweepUnenqueued(olderThanMs = 30_000): Promise<number> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM inbound_events WHERE enqueued_at IS NULL AND received_at < now() - ($1 || ' milliseconds')::interval ORDER BY received_at LIMIT 500`,
    [String(olderThanMs)]
  );
  for (const r of rows) {
    await enqueueEvent(r.id);
    await query("UPDATE inbound_events SET enqueued_at = now() WHERE id = $1", [r.id]);
  }
  return rows.length;
}

/** A claim left in 'sending' means the worker died mid-send. We cannot know if
 *  Instagram delivered it, so it becomes 'unconfirmed' (never auto-resent). */
export async function expireStaleClaims(olderThanMinutes = 10): Promise<number> {
  const dm = await query(
    `UPDATE message_logs SET dm_status = 'unconfirmed',
            error = 'Worker stopped during send; delivery unconfirmed. Check the Instagram inbox before resending.', updated_at = now()
      WHERE dm_status = 'sending' AND updated_at < now() - ($1 || ' minutes')::interval RETURNING id`,
    [String(olderThanMinutes)]
  );
  const pr = await query(
    `UPDATE message_logs SET public_reply_status = 'unconfirmed', public_reply_error = 'Worker stopped during send; delivery unconfirmed.', updated_at = now()
      WHERE public_reply_status = 'sending' AND updated_at < now() - ($1 || ' minutes')::interval RETURNING id`,
    [String(olderThanMinutes)]
  );
  return dm.length + pr.length;
}

/** When an event job exhausts its retries, close out legs still pending. */
export async function failPendingForEvent(eventId: string, reason: string) {
  await query(
    `UPDATE message_logs SET dm_status = 'failed', error = $2, updated_at = now() WHERE inbound_event_id = $1 AND dm_status = 'pending'`,
    [eventId, reason.slice(0, 1000)]
  );
  await query(
    `UPDATE message_logs SET public_reply_status = 'failed', public_reply_error = $2, updated_at = now() WHERE inbound_event_id = $1 AND public_reply_status = 'pending'`,
    [eventId, reason.slice(0, 1000)]
  );
}

/** Long-lived Instagram tokens last ~60 days and can be refreshed once they are
 *  at least 24h old. Refresh anything expiring within 10 days. */
export async function refreshExpiringTokens(): Promise<{ refreshed: number; failed: number }> {
  const rows = await query<{ id: string; username: string; access_token_enc: string }>(
    `SELECT id, username, access_token_enc FROM ig_accounts
      WHERE is_demo = false AND status = 'active' AND access_token_enc IS NOT NULL
        AND token_expires_at < now() + interval '10 days'
        AND COALESCE(token_refreshed_at, connected_at) < now() - interval '24 hours'`
  );
  let refreshed = 0;
  let failed = 0;
  for (const a of rows) {
    try {
      const t = await refreshLongLivedToken(decryptSecret(a.access_token_enc));
      await query(
        `UPDATE ig_accounts SET access_token_enc = $2, token_expires_at = $3, token_refreshed_at = now(), updated_at = now() WHERE id = $1`,
        [a.id, encryptSecret(t.accessToken), t.expiresAt]
      );
      refreshed++;
    } catch (err) {
      failed++;
      if (classifyError(err) === "auth") {
        await query(`UPDATE ig_accounts SET status = 'token_expired', status_detail = $2 WHERE id = $1`, [a.id, describeError(err)]);
      }
      await logSystemEvent("warning", "token-refresh", `Token refresh failed for @${a.username}`, { error: describeError(err) });
    }
  }
  return { refreshed, failed };
}
