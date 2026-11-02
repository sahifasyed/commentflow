import { loadEnvFile } from "../lib/env-file.js";
loadEnvFile();

const { getConfig } = await import("../config.js");
const { migrate } = await import("../db/migrate.js");
const { closePool } = await import("../db/pool.js");
const { closeRedis } = await import("../lib/redis.js");
const { closeQueues } = await import("../queue.js");
const { startWorkers } = await import("./worker.js");

const cfg = getConfig();
await migrate((m) => console.log(m));
const workers = startWorkers();
console.log(
  `[worker] running (concurrency=${cfg.WORKER_CONCURRENCY}, demo=${cfg.DEMO_MODE}, limits: private=${cfg.PRIVATE_REPLY_HOURLY_LIMIT}/h dm=${cfg.DM_HOURLY_LIMIT}/h public=${cfg.PUBLIC_REPLY_HOURLY_LIMIT}/h)`
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal} received, finishing in-flight jobs...`);
  await workers.close();
  await closeQueues();
  await closeRedis();
  await closePool();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
