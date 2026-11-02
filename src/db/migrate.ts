/**
 * Minimal forward-only SQL migration runner.
 * Applies every migrations/NNN_name.sql not yet recorded in schema_migrations,
 * each in its own transaction, guarded by a Postgres advisory lock so the web
 * app and worker can both run it safely at boot.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getPool, closePool } from "./pool.js";

const LOCK_ID = 727274;

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/db -> ../../migrations ; dist/db -> ../../migrations
  for (const candidate of [resolve(here, "../../migrations"), resolve(process.cwd(), "migrations")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("migrations directory not found");
}

export async function migrate(log: (msg: string) => void = console.log): Promise<string[]> {
  const client = await getPool().connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    );
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const dir = migrationsDir();
    const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
        log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    if (applied.length === 0) log("[migrate] database is up to date");
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
  }
  return applied;
}

// CLI entry: `npm run migrate`
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { loadEnvFile } = await import("../lib/env-file.js");
  loadEnvFile();
  migrate()
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err.message);
      await closePool();
      process.exit(1);
    });
}
