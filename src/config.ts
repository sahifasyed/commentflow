import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int().nonnegative());

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: int(3000),
    APP_URL: z.string().url().default("http://localhost:3000"),
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_KEY must be exactly 64 hex characters (openssl rand -hex 32)"),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    TRUST_PROXY: int(1),

    DEMO_MODE: bool(false),
    ALLOW_REGISTRATION: bool(true),
    ALLOWED_EMAILS: z.string().optional().default(""),

    META_GRAPH_API_VERSION: z.string().default("v25.0"),
    INSTAGRAM_APP_ID: z.string().optional().default(""),
    INSTAGRAM_APP_SECRET: z.string().optional().default(""),
    FACEBOOK_APP_SECRET: z.string().optional().default(""),
    WEBHOOK_VERIFY_TOKEN: z.string().optional().default(""),

    // Meta documents 750 private replies / hour / professional account.
    PRIVATE_REPLY_HOURLY_LIMIT: int(750),
    // Conservative defaults for other send types; tune to your account.
    DM_HOURLY_LIMIT: int(200),
    PUBLIC_REPLY_HOURLY_LIMIT: int(200),
    WORKER_CONCURRENCY: int(5),
  });

export type Config = z.infer<typeof schema> & {
  allowedEmails: string[];
  metaConfigured: boolean;
  isProd: boolean;
};

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}\nSee .env.example.`);
  }
  const c = parsed.data;
  cached = {
    ...c,
    APP_URL: c.APP_URL.replace(/\/$/, ""),
    allowedEmails: c.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
    metaConfigured: Boolean(c.INSTAGRAM_APP_ID && c.INSTAGRAM_APP_SECRET && c.WEBHOOK_VERIFY_TOKEN),
    isProd: c.NODE_ENV === "production",
  };
  if (cached.metaConfigured && !cached.APP_URL.startsWith("https://")) {
    console.warn("[config] APP_URL is not https://. Meta webhooks and Instagram login require a public HTTPS URL.");
  }
  return cached;
}

/** Test helper: re-read process.env on next getConfig(). */
export function resetConfig() {
  cached = null;
}
