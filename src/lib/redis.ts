import { Redis } from "ioredis";
import { getConfig } from "../config.js";

let client: Redis | null = null;

/** Shared connection. maxRetriesPerRequest=null is required by BullMQ. */
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(getConfig().REDIS_URL, { maxRetriesPerRequest: null });
    client.on("error", (e) => console.error("[redis]", e.message));
  }
  return client;
}

export async function closeRedis() {
  if (client) {
    const c = client;
    client = null;
    await c.quit().catch(() => c.disconnect());
  }
}
