import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Load ./.env if present (Node 20.12+ built-in). Real env vars take precedence. */
export function loadEnvFile() {
  const file = resolve(process.cwd(), ".env");
  if (existsSync(file) && typeof process.loadEnvFile === "function") {
    const before = { ...process.env };
    process.loadEnvFile(file);
    // loadEnvFile does not overwrite existing vars, but be explicit.
    Object.assign(process.env, before);
  }
}
