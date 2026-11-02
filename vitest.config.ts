import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup-env.ts"],
    // Integration tests share one Postgres database and one Redis db.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
