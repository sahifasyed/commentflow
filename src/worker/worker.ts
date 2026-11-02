import { DelayedError, Worker, type Job } from "bullmq";
import { getConfig } from "../config.js";
import { query } from "../db/pool.js";
import { getRedis } from "../lib/redis.js";
import { SKIP_REASON_LABELS } from "../lib/restrictions.js";
import { EVENTS_QUEUE, HEARTBEAT_KEY, MAINTENANCE_QUEUE, getMaintenanceQueue, type EventJob } from "../queue.js";
import { processInboundEvent } from "../services/processor.js";
import {
  expireStaleClaims,
  failPendingForEvent,
  logSystemEvent,
  refreshExpiringTokens,
  sweepUnenqueued,
} from "../services/maintenance.js";

export const MAX_RATE_LIMIT_DEFERRALS = 48;

export async function handleEventJob(job: Job<EventJob>, token?: string): Promise<{ matched: number }> {
  const outcome = await processInboundEvent(job.data.inboundEventId);

  if (outcome.retryableError) {
    // Meta explicitly throttled us: let BullMQ retry with exponential backoff.
    throw outcome.retryableError;
  }
  if (outcome.deferMs !== undefined) {
    const deferrals = (job.data.rateLimitDeferrals ?? 0) + 1;
    if (deferrals > MAX_RATE_LIMIT_DEFERRALS) {
      await query(
        `UPDATE message_logs SET dm_status = 'skipped', skip_reason = 'rate_limited', error = $2, updated_at = now()
          WHERE inbound_event_id = $1 AND dm_status = 'pending'`,
        [job.data.inboundEventId, SKIP_REASON_LABELS.rate_limited]
      );
      return { matched: outcome.matchedCampaigns };
    }
    await job.updateData({ ...job.data, rateLimitDeferrals: deferrals });
    // Our own hourly cap is full: wait for the window, without spending a retry attempt.
    await job.moveToDelayed(Date.now() + outcome.deferMs + Math.floor(Math.random() * 5000), token);
    throw new DelayedError();
  }
  return { matched: outcome.matchedCampaigns };
}

export function startWorkers() {
  const cfg = getConfig();
  const redis = getRedis();

  const events = new Worker<EventJob>(EVENTS_QUEUE, handleEventJob, {
    connection: redis.duplicate({ maxRetriesPerRequest: null }),
    concurrency: cfg.WORKER_CONCURRENCY,
  });
  events.on("failed", async (job, err) => {
    if (!job) return;
    const final = job.attemptsMade >= (job.opts.attempts ?? 1);
    console.error(`[worker] event ${job.data.inboundEventId} attempt ${job.attemptsMade} failed: ${err.message}`);
    if (final) {
      await failPendingForEvent(job.data.inboundEventId, `Gave up after ${job.attemptsMade} attempts: ${err.message}`);
      await logSystemEvent("error", "worker", "Event processing failed permanently", {
        eventId: job.data.inboundEventId,
        error: err.message,
      });
    }
  });

  const maintenance = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      switch (job.name) {
        case "sweep-unenqueued":
          return { swept: await sweepUnenqueued() };
        case "expire-stale-claims":
          return { expired: await expireStaleClaims() };
        case "refresh-tokens":
          return refreshExpiringTokens();
      }
    },
    { connection: redis.duplicate({ maxRetriesPerRequest: null }), concurrency: 1 }
  );
  maintenance.on("failed", (job, err) => console.error(`[worker] maintenance ${job?.name} failed: ${err.message}`));

  const q = getMaintenanceQueue();
  void Promise.all([
    q.upsertJobScheduler("sweep-unenqueued", { every: 60_000 }, { name: "sweep-unenqueued" }),
    q.upsertJobScheduler("expire-stale-claims", { every: 5 * 60_000 }, { name: "expire-stale-claims" }),
    q.upsertJobScheduler("refresh-tokens", { every: 12 * 3600_000 }, { name: "refresh-tokens" }),
  ]).catch((e) => console.error("[worker] scheduler setup failed", e.message));

  const beat = () => redis.set(HEARTBEAT_KEY, String(Date.now()), "EX", 60).catch(() => {});
  void beat();
  const heartbeat = setInterval(beat, 15_000);

  return {
    events,
    maintenance,
    async close() {
      clearInterval(heartbeat);
      await Promise.all([events.close(), maintenance.close()]);
    },
  };
}
