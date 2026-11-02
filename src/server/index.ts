import { loadEnvFile } from "../lib/env-file.js";
loadEnvFile();

const { getConfig } = await import("../config.js");
const { migrate } = await import("../db/migrate.js");
const { closePool } = await import("../db/pool.js");
const { closeRedis } = await import("../lib/redis.js");
const { closeQueues } = await import("../queue.js");
const { createApp } = await import("./app.js");

const cfg = getConfig();
await migrate((m) => console.log(m));

const server = createApp().listen(cfg.PORT, () => {
  console.log(`[api] listening on :${cfg.PORT} (public URL ${cfg.APP_URL})`);
  if (cfg.DEMO_MODE) console.log("[api] DEMO_MODE is on: demo accounts and the simulator are enabled");
  if (!cfg.metaConfigured) console.log("[api] Meta app not configured: real Instagram connections are disabled");
});

async function shutdown() {
  server.close();
  await closeQueues();
  await closeRedis();
  await closePool();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
