import request from "supertest";
import type { Express } from "express";
import { getPool, closePool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { getRedis, closeRedis } from "../src/lib/redis.js";
import { closeQueues } from "../src/queue.js";
import { createApp } from "../src/server/app.js";
import { signBody } from "../src/meta/webhook.js";

export const IG_SECRET = "test-instagram-app-secret";

export async function resetDatabase() {
  const pool = getPool();
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(() => {});
  await getRedis().flushdb();
}

export async function teardown() {
  await closeQueues();
  await closeRedis();
  await closePool();
}

let app: Express | null = null;
export function testApp(): Express {
  if (!app) app = createApp();
  return app;
}

/** A logged-in supertest agent with CSRF + workspace headers pre-set. */
export async function signUp(email = `user${Math.random().toString(36).slice(2, 8)}@example.com`) {
  const agent = request.agent(testApp());
  const res = await agent
    .post("/api/auth/register")
    .set("X-Requested-With", "commentflow")
    .send({ email, password: "correct horse battery", name: "Test User" });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const me = await agent.get("/api/auth/me");
  const workspaceId: string = me.body.workspaces[0].id;
  const h = { "X-Requested-With": "commentflow", "X-Workspace-Id": workspaceId };
  return {
    agent,
    email,
    workspaceId,
    userId: me.body.user.id as string,
    get: (url: string) => agent.get(url).set(h),
    post: (url: string, body?: object) => agent.post(url).set(h).send(body ?? {}),
    put: (url: string, body?: object) => agent.put(url).set(h).send(body ?? {}),
    patch: (url: string, body?: object) => agent.patch(url).set(h).send(body ?? {}),
    del: (url: string) => agent.delete(url).set(h),
  };
}

export type Session = Awaited<ReturnType<typeof signUp>>;

export async function postWebhook(payload: object, secret = IG_SECRET) {
  const body = JSON.stringify(payload);
  return request(testApp())
    .post("/api/webhook")
    .set("Content-Type", "application/json")
    .set("X-Hub-Signature-256", signBody(body, secret))
    .send(body);
}

export function commentPayload(opts: {
  igUserId: string;
  commentId?: string;
  text: string;
  fromId?: string;
  username?: string;
  mediaId?: string;
  timeSec?: number;
}) {
  return {
    object: "instagram",
    entry: [
      {
        id: opts.igUserId,
        time: opts.timeSec ?? Math.floor(Date.now() / 1000),
        changes: [
          {
            field: "comments",
            value: {
              id: opts.commentId ?? `c_${Math.random().toString(36).slice(2)}`,
              from: { id: opts.fromId ?? "user_1", username: opts.username ?? "fan.one" },
              text: opts.text,
              media: { id: opts.mediaId ?? "media_1", media_product_type: "REELS" },
            },
          },
        ],
      },
    ],
  };
}

export function dmPayload(opts: { igUserId: string; mid?: string; text: string; fromId?: string; storyId?: string; tsMs?: number }) {
  const ts = opts.tsMs ?? Date.now();
  return {
    object: "instagram",
    entry: [
      {
        id: opts.igUserId,
        time: ts,
        messaging: [
          {
            sender: { id: opts.fromId ?? "user_dm_1" },
            recipient: { id: opts.igUserId },
            timestamp: ts,
            message: {
              mid: opts.mid ?? `m_${Math.random().toString(36).slice(2)}`,
              text: opts.text,
              ...(opts.storyId ? { reply_to: { story: { id: opts.storyId, url: "https://x/y.jpg" } } } : {}),
            },
          },
        ],
      },
    ],
  };
}

export async function createDemoAccount(s: Session, username = "demo.creator") {
  const r = await s.post("/api/accounts/demo", { username });
  if (r.status !== 201) throw new Error(`demo account failed: ${JSON.stringify(r.body)}`);
  return r.body.account as { id: string; ig_user_id: string; username: string };
}

export function campaignBody(igAccountId: string, overrides: Record<string, unknown> = {}) {
  return {
    name: "Guide campaign",
    igAccountId,
    keywords: ["guide"],
    dmMessage: "Hey {username}! Here is your guide: {link}",
    links: [{ url: "https://example.com/guide", buttonLabel: "Get the guide" }],
    ...overrides,
  };
}
