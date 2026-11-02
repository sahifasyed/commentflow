import { Queue } from "bullmq";
import { getRedis } from "./lib/redis.js";

export const EVENTS_QUEUE = "cf-events";
export const MAINTENANCE_QUEUE = "cf-maintenance";
export const HEARTBEAT_KEY = "cf:worker:heartbeat";

export interface EventJob {
  inboundEventId: string;
  /** How many times our own hourly limiter has deferred this job. */
  rateLimitDeferrals?: number;
}

export type MaintenanceJobName = "refresh-tokens" | "sweep-unenqueued" | "expire-stale-claims";

let eventsQueue: Queue<EventJob> | null = null;
let maintenanceQueue: Queue | null = null;

export function getEventsQueue(): Queue<EventJob> {
  if (!eventsQueue) {
    eventsQueue = new Queue<EventJob>(EVENTS_QUEUE, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 30_000 }, // 30s, 60s, 120s, 240s
        removeOnComplete: { age: 24 * 3600, count: 10_000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }
  return eventsQueue;
}

export function getMaintenanceQueue(): Queue {
  if (!maintenanceQueue) {
    maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: getRedis(),
      defaultJobOptions: { removeOnComplete: 100, removeOnFail: 100 },
    });
  }
  return maintenanceQueue;
}

/** Job id = inbound event id, so the same event can never be queued twice. */
export async function enqueueEvent(inboundEventId: string) {
  await getEventsQueue().add("process-event", { inboundEventId }, { jobId: inboundEventId });
}

export async function closeQueues() {
  await Promise.all([eventsQueue?.close(), maintenanceQueue?.close()]);
  eventsQueue = null;
  maintenanceQueue = null;
}
