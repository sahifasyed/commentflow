/**
 * End-to-end pipeline tests against real PostgreSQL + Redis:
 * signed webhook -> ingestion/dedup -> processor -> demo provider -> logs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { resetConfig } from "../src/config.js";
import { one, query } from "../src/db/pool.js";
import { recipientToken } from "../src/lib/crypto.js";
import { getRedis } from "../src/lib/redis.js";
import { MetaApiError } from "../src/meta/errors.js";
import { setInstagramApiFactory } from "../src/meta/provider.js";
import { getEventsQueue } from "../src/queue.js";
import { processInboundEvent } from "../src/services/processor.js";
import { expireStaleClaims, sweepUnenqueued } from "../src/services/maintenance.js";
import { startWorkers } from "../src/worker/worker.js";
import {
  campaignBody,
  commentPayload,
  createDemoAccount,
  dmPayload,
  postWebhook,
  resetDatabase,
  signUp,
  teardown,
  testApp,
  type Session,
} from "./helpers.js";

let s: Session;
let account: { id: string; ig_user_id: string };

async function eventIds() {
  return (await query<{ id: string }>("SELECT id FROM inbound_events ORDER BY received_at")).map((r) => r.id);
}
async function processAll() {
  const out = [];
  for (const id of await eventIds()) out.push(await processInboundEvent(id));
  return out;
}
async function logs() {
  return query("SELECT l.*, c.name AS campaign_name FROM message_logs l JOIN campaigns c ON c.id = l.campaign_id ORDER BY c.created_at");
}
async function outbox() {
  return query("SELECT kind, recipient, body FROM demo_outbox ORDER BY id");
}

beforeAll(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await teardown();
});

beforeEach(async () => {
  setInstagramApiFactory(null);
  await query("TRUNCATE users, workspaces, webhook_deliveries, system_events RESTART IDENTITY CASCADE");
  await getRedis().flushdb();
  s = await signUp();
  account = await createDemoAccount(s);
  // Jobs enqueued by ingest are processed manually in these tests.
  await getEventsQueue().obliterate({ force: true });
});

describe("webhook endpoint", () => {
  it("answers Meta's verification challenge only with the right token", async () => {
    const ok = await request(testApp()).get("/api/webhook").query({ "hub.mode": "subscribe", "hub.verify_token": "verify-me-please", "hub.challenge": "12345" });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe("12345");
    const bad = await request(testApp()).get("/api/webhook").query({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1" });
    expect(bad.status).toBe(403);
  });

  it("rejects unsigned or wrongly signed deliveries", async () => {
    const r1 = await request(testApp()).post("/api/webhook").set("Content-Type", "application/json").send("{}");
    expect(r1.status).toBe(401);
    const r2 = await postWebhook(commentPayload({ igUserId: account.ig_user_id, text: "guide" }), "not-the-secret");
    expect(r2.status).toBe(401);
    expect(await eventIds()).toHaveLength(0);
  });

  it("ignores events for accounts that are not connected", async () => {
    const r = await postWebhook(commentPayload({ igUserId: "someone-else", text: "guide" }));
    expect(r.status).toBe(200);
    expect(r.body.stored).toBe(0);
  });
});

describe("comment-to-DM", () => {
  it("sends a personalized private reply with tracked link buttons, plus a public reply", async () => {
    await s.post("/api/campaigns", campaignBody(account.id, { publicReplyEnabled: true, publicReplies: ["Sent! Check your DMs {username} ✨"] }));
    const r = await postWebhook(commentPayload({ igUserId: account.ig_user_id, commentId: "c1", text: "GUIDE please!! 🙏", fromId: "u42", username: "jane.doe" }));
    expect(r.body).toMatchObject({ duplicate: false, stored: 1, enqueued: 1 });

    const [res] = await processAll();
    expect(res.matchedCampaigns).toBe(1);
    const [log] = await logs();
    expect(log).toMatchObject({ dm_status: "sent", public_reply_status: "sent", matched_keyword: "guide", recipient_username: "jane.doe", attempts: 1 });
    expect(log.public_reply_text).toBe("Sent! Check your DMs @jane.doe ✨");

    const sent = await outbox();
    expect(sent.map((o) => o.kind).sort()).toEqual(["comment_reply", "private_reply"]);
    const pr = sent.find((o) => o.kind === "private_reply")!;
    expect(pr.recipient).toBe("c1");
    expect(pr.body.text).toBe("Hey @jane.doe! Here is your guide:");
    const slug = (await one("SELECT slug FROM tracked_links"))!.slug;
    expect(pr.body.buttons).toEqual([{ title: "Get the guide", url: `http://localhost:3000/r/${slug}?r=${recipientToken("u42")}` }]);
  });

  it("does nothing for non-matching comments", async () => {
    await s.post("/api/campaigns", campaignBody(account.id));
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, text: "nice reel" }));
    const [res] = await processAll();
    expect(res.matchedCampaigns).toBe(0);
    expect(await logs()).toHaveLength(0);
  });

  it("respects post scope (specific posts only)", async () => {
    await s.post("/api/campaigns", campaignBody(account.id, { postScope: "specific", postIds: ["media_A"] }));
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, text: "guide", mediaId: "media_B" }));
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, text: "guide", mediaId: "media_A" }));
    await processAll();
    expect(await logs()).toHaveLength(1);
  });

  it("dedupes identical redeliveries and the same comment in a different batch", async () => {
    await s.post("/api/campaigns", campaignBody(account.id));
    const p = commentPayload({ igUserId: account.ig_user_id, commentId: "dup1", text: "guide", timeSec: 1_800_000_000 });
    expect((await postWebhook(p)).body.stored).toBe(1);
    expect((await postWebhook(p)).body.duplicate).toBe(true);
    const p2 = commentPayload({ igUserId: account.ig_user_id, commentId: "dup1", text: "guide", timeSec: 1_800_000_001 });
    const r = await postWebhook(p2);
    expect(r.body).toMatchObject({ duplicate: false, stored: 0 });
    expect(await eventIds()).toHaveLength(1);
    // Processing the same event twice never sends twice.
    await processAll();
    await processAll();
    expect((await outbox()).filter((o) => o.kind === "private_reply")).toHaveLength(1);
  });

  it("allows only ONE private reply per comment across campaigns (public replies still go out)", async () => {
    await s.post("/api/campaigns", campaignBody(account.id, { name: "First", publicReplyEnabled: true, publicReplies: ["one"] }));
    await s.post("/api/campaigns", campaignBody(account.id, { name: "Second", publicReplyEnabled: true, publicReplies: ["two"] }));
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, text: "guide" }));
    await processAll();
    const [a, b] = await logs();
    expect(a).toMatchObject({ campaign_name: "First", dm_status: "sent", public_reply_status: "sent" });
    expect(b).toMatchObject({ campaign_name: "Second", dm_status: "skipped", skip_reason: "comment_already_replied", public_reply_status: "sent" });
    expect((await outbox()).filter((o) => o.kind === "private_reply")).toHaveLength(1);
  });

  it("skips comments older than Meta's 7-day private reply window", async () => {
    await s.post("/api/campaigns", campaignBody(account.id));
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, text: "guide", timeSec: Math.floor(Date.now() / 1000) - 8 * 86400 }));
    await processAll();
    expect((await logs())[0]).toMatchObject({ dm_status: "skipped", skip_reason: "comment_too_old" });
    expect(await outbox()).toHaveLength(0);
  });

  it("enforces a per-recipient cooldown", async () => {
    await s.post("/api/campaigns", campaignBody(account.id, { cooldownHours: 24 }));
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, text: "guide", fromId: "same" }));
    await processAll();
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, text: "guide again", fromId: "same" }));
    await processAll();
    const statuses = (await query("SELECT dm_status, skip_reason FROM message_logs ORDER BY created_at")).map((r) => r.skip_reason ?? r.dm_status);
    expect(statuses).toEqual(["sent", "cooldown"]);
  });

  it("ignores paused campaigns", async () => {
    const c = await s.post("/api/campaigns", campaignBody(account.id, { status: "paused" }));
    expect(c.status).toBe(201);
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, text: "guide" }));
    await processAll();
    expect(await logs()).toHaveLength(0);
  });
});

describe("DM and Story reply triggers", () => {
  it("replies to a matching inbound DM inside the 24h window (inline link, no buttons configured)", async () => {
    await s.post("/api/campaigns", campaignBody(account.id, { triggerComments: false, triggerDms: true, links: [], dmMessage: "Here you go {username}" }));
    // The username is learned from an earlier comment by the same person.
    await query(
      `INSERT INTO inbound_events (workspace_id, ig_account_id, kind, external_id, sender_id, sender_username, text, occurred_at, processed_at)
       VALUES ($1,$2,'comment','old','dmuser','dm.person','hi', now(), now())`,
      [s.workspaceId, account.id]
    );
    await postWebhook(dmPayload({ igUserId: account.ig_user_id, text: "GUIDE", fromId: "dmuser" }));
    await processAll();
    const sent = await outbox();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "dm", recipient: "dmuser", body: { text: "Here you go @dm.person" } });
  });

  it("does not answer DMs when only the comment trigger is on", async () => {
    await s.post("/api/campaigns", campaignBody(account.id));
    await postWebhook(dmPayload({ igUserId: account.ig_user_id, text: "guide" }));
    await processAll();
    expect(await logs()).toHaveLength(0);
  });

  it("triggers on Story replies separately from DMs", async () => {
    await s.post("/api/campaigns", campaignBody(account.id, { triggerComments: false, triggerStoryReplies: true }));
    await postWebhook(dmPayload({ igUserId: account.ig_user_id, text: "guide", storyId: "story_1" }));
    await postWebhook(dmPayload({ igUserId: account.ig_user_id, text: "guide" })); // plain DM: ignored
    await processAll();
    const l = await logs();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ trigger_kind: "story_reply", dm_status: "sent" });
  });

  it("refuses to DM outside the 24-hour standard messaging window", async () => {
    await s.post("/api/campaigns", campaignBody(account.id, { triggerComments: false, triggerDms: true }));
    await postWebhook(dmPayload({ igUserId: account.ig_user_id, text: "guide", tsMs: Date.now() - 25 * 3600_000 }));
    await processAll();
    expect((await logs())[0]).toMatchObject({ dm_status: "skipped", skip_reason: "outside_messaging_window" });
  });
});

describe("failures, retries and rate limits", () => {
  it("Meta rate limit (code 4): logs pending + retryable, then succeeds on retry", async () => {
    await s.post("/api/campaigns", campaignBody(account.id));
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, commentId: "c__sc_rate_limit", text: "guide" }));
    const [first] = await processAll();
    expect(first.retryableError).toBeDefined();
    expect((await logs())[0]).toMatchObject({ dm_status: "pending", attempts: 1 });
    // The reserved slot was released because Meta rejected the call.
    const [second] = await processAll();
    expect(second.retryableError).toBeUndefined();
    expect((await logs())[0]).toMatchObject({ dm_status: "sent", attempts: 2 });
  });

  it("ambiguous failures (network) become 'unconfirmed' and are never re-sent", async () => {
    await s.post("/api/campaigns", campaignBody(account.id));
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, commentId: "c__sc_network", text: "guide" }));
    await processAll();
    await processAll();
    const [l] = await logs();
    expect(l.dm_status).toBe("unconfirmed");
    expect(l.attempts).toBe(1);
  });

  it("permanent rejections are marked failed without retry", async () => {
    await s.post("/api/campaigns", campaignBody(account.id));
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, commentId: "c__sc_reject", text: "guide" }));
    const [r] = await processAll();
    expect(r.retryableError).toBeUndefined();
    expect((await logs())[0]).toMatchObject({ dm_status: "failed" });
    expect((await logs())[0].error).toContain("code=100");
  });

  it("falls back to an inline tracked link when Meta rejects the button template", async () => {
    await s.post("/api/campaigns", campaignBody(account.id));
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, commentId: "c__sc_template", text: "guide", fromId: "u7" }));
    await processAll();
    const [l] = await logs();
    expect(l.dm_status).toBe("sent");
    const [o] = await outbox();
    expect(o.body.buttons).toBeUndefined();
    expect(o.body.text).toMatch(/^Hey @fan\.one! Here is your guide: http:\/\/localhost:3000\/r\/\w+/);
  });

  it("our hourly limiter defers instead of sending (750/h private replies by default)", async () => {
    process.env.PRIVATE_REPLY_HOURLY_LIMIT = "1";
    resetConfig();
    try {
      await s.post("/api/campaigns", campaignBody(account.id));
      await postWebhook(commentPayload({ igUserId: account.ig_user_id, text: "guide" }));
      await postWebhook(commentPayload({ igUserId: account.ig_user_id, text: "guide" }));
      const results = await processAll();
      expect(results[0].deferMs).toBeUndefined();
      expect(results[1].deferMs).toBeGreaterThan(0);
      const statuses = (await query("SELECT dm_status FROM message_logs ORDER BY created_at")).map((r) => r.dm_status);
      expect(statuses).toEqual(["sent", "pending"]);
    } finally {
      process.env.PRIVATE_REPLY_HOURLY_LIMIT = "750";
      resetConfig();
    }
  });

  it("an invalid token marks the account token_expired and stops sending", async () => {
    setInstagramApiFactory(() => ({
      sendPrivateReply: async () => {
        throw new MetaApiError("Error validating access token", 190, 463, 400);
      },
      sendDirectMessage: async () => ({ messageId: "x" }),
      replyToComment: async () => ({ id: "x" }),
      listMedia: async () => [],
      getUsername: async () => null,
    }));
    await s.post("/api/campaigns", campaignBody(account.id));
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, text: "guide" }));
    await processAll();
    expect((await logs())[0].dm_status).toBe("failed");
    expect((await one("SELECT status FROM ig_accounts WHERE id = $1", [account.id]))!.status).toBe("token_expired");
    // New events for this account are skipped, not sent.
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, text: "guide" }));
    await processAll();
    const l = await query("SELECT dm_status, skip_reason FROM message_logs ORDER BY created_at");
    expect(l[1]).toMatchObject({ dm_status: "skipped", skip_reason: "account_inactive" });
  });

  it("a crashed mid-send claim becomes 'unconfirmed', never re-sent", async () => {
    await s.post("/api/campaigns", campaignBody(account.id));
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, text: "guide" }));
    await processAll();
    await query("UPDATE message_logs SET dm_status = 'sending', updated_at = now() - interval '1 hour'");
    expect(await expireStaleClaims()).toBe(1);
    expect((await logs())[0].dm_status).toBe("unconfirmed");
  });

  it("the sweeper enqueues events whose post-commit enqueue failed", async () => {
    await postWebhook(commentPayload({ igUserId: account.ig_user_id, text: "guide" }));
    await query("UPDATE inbound_events SET enqueued_at = NULL, received_at = now() - interval '5 minutes'");
    expect(await sweepUnenqueued()).toBe(1);
    expect(await sweepUnenqueued()).toBe(0);
  });
});

describe("BullMQ worker end-to-end", () => {
  it("processes a webhook through the real queue and worker", async () => {
    await s.post("/api/campaigns", campaignBody(account.id));
    const workers = startWorkers();
    try {
      await postWebhook(commentPayload({ igUserId: account.ig_user_id, commentId: "live1", text: "guide" }));
      const deadline = Date.now() + 10_000;
      let status = "";
      while (Date.now() < deadline) {
        status = (await one("SELECT dm_status FROM message_logs"))?.dm_status ?? "";
        if (status === "sent") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(status).toBe("sent");
      const health = await request(testApp()).get("/api/health");
      expect(health.body.worker.healthy).toBe(true);
    } finally {
      await workers.close();
    }
  });
});
