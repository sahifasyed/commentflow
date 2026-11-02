import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { one, query } from "../src/db/pool.js";
import { processInboundEvent } from "../src/services/processor.js";
import { getEventsQueue } from "../src/queue.js";
import { campaignBody, commentPayload, createDemoAccount, postWebhook, resetDatabase, signUp, teardown, testApp } from "./helpers.js";

beforeAll(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await teardown();
});

describe("authentication", () => {
  it("registers, logs in, logs out, and rejects bad passwords", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const h = { "X-Requested-With": "commentflow" };
    const reg = await agent.post("/api/auth/register").set(h).send({ email: "Owner@Example.com", password: "a strong passphrase" });
    expect(reg.status).toBe(201);
    expect(reg.headers["set-cookie"][0]).toMatch(/cf_session=.*HttpOnly.*SameSite=Lax/i);
    const me = await agent.get("/api/auth/me");
    expect(me.body.user.email).toBe("owner@example.com");
    expect(me.body.workspaces).toHaveLength(1);
    expect(me.body.workspaces[0].role).toBe("owner");

    expect((await agent.post("/api/auth/register").set(h).send({ email: "owner@example.com", password: "a strong passphrase" })).status).toBe(409);
    expect((await agent.post("/api/auth/register").set(h).send({ email: "x@example.com", password: "short" })).status).toBe(400);

    await agent.post("/api/auth/logout").set(h);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
    expect((await agent.post("/api/auth/login").set(h).send({ email: "owner@example.com", password: "wrong password" })).status).toBe(401);
    expect((await agent.post("/api/auth/login").set(h).send({ email: "OWNER@example.com", password: "a strong passphrase" })).status).toBe(200);
    expect((await agent.get("/api/auth/me")).status).toBe(200);
  });

  it("requires the CSRF header on state-changing requests", async () => {
    const r = await request(testApp()).post("/api/auth/login").send({ email: "a@b.co", password: "x" });
    expect(r.status).toBe(403);
  });

  it("rate limits repeated login attempts", async () => {
    const h = { "X-Requested-With": "commentflow" };
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await request(testApp()).post("/api/auth/login").set(h).send({ email: "victim@example.com", password: "guess" + i })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[11]).toBe(429);
  });
});

describe("workspaces and roles", () => {
  it("isolates workspaces and enforces roles via invites", async () => {
    const owner = await signUp("boss@example.com");
    const outsider = await signUp("outsider@example.com");
    const acct = await createDemoAccount(owner);

    // Outsider cannot read the owner's workspace.
    const peek = await outsider.agent.get("/api/campaigns").set("X-Workspace-Id", owner.workspaceId);
    expect(peek.status).toBe(404);

    const inv = await owner.post("/api/workspace/invites", { email: "helper@example.com", role: "member" });
    expect(inv.status).toBe(201);
    const token = inv.body.link.split("/invite/")[1];
    expect((await request(testApp()).get(`/api/invites/${token}`)).body.invite.workspace_name).toContain("Test User");

    // Wrong user cannot accept someone else's invite.
    expect((await outsider.post(`/api/invites/${token}/accept`)).status).toBe(403);

    const helper = await signUp("helper@example.com");
    expect((await helper.post(`/api/invites/${token}/accept`)).status).toBe(200);
    const asMember = { "X-Requested-With": "commentflow", "X-Workspace-Id": owner.workspaceId };
    expect((await helper.agent.get("/api/campaigns").set(asMember)).status).toBe(200);
    // Members are read-only.
    const create = await helper.agent.post("/api/campaigns").set(asMember).send(campaignBody(acct.id));
    expect(create.status).toBe(403);
    // Token is single use.
    expect((await helper.post(`/api/invites/${token}/accept`)).status).toBe(404);

    // Owner promotes, then the admin can create campaigns.
    expect((await owner.patch(`/api/workspace/members/${helper.userId}`, { role: "admin" })).status).toBe(200);
    expect((await helper.agent.post("/api/campaigns").set(asMember).send(campaignBody(acct.id))).status).toBe(201);
    // Last owner cannot be demoted.
    expect((await owner.patch(`/api/workspace/members/${owner.userId}`, { role: "admin" })).status).toBe(400);
  });
});

describe("campaigns", () => {
  it("validates input against Meta limits", async () => {
    const s = await signUp();
    const acct = await createDemoAccount(s, "val.account");
    const bad = async (o: object) => (await s.post("/api/campaigns", campaignBody(acct.id, o))).body.error as string;
    expect(await bad({ keywords: [] })).toMatch(/keyword/i);
    expect(await bad({ triggerComments: false })).toMatch(/trigger/i);
    expect(await bad({ links: [{ url: "javascript:alert(1)" }] })).toMatch(/URL|http/);
    expect(await bad({ links: [1, 2, 3].map((i) => ({ url: `https://e.com/${i}` })) })).toMatch(/2|array|Too big/i);
    expect(await bad({ dmMessage: "x".repeat(900) })).toMatch(/too long/);
    expect(await bad({ publicReplyEnabled: true, publicReplies: [] })).toMatch(/public reply/i);
    expect(await bad({ postScope: "specific", postIds: [] })).toMatch(/post/i);
    expect(await bad({ links: [{ url: "https://e.com", buttonLabel: "x".repeat(21) }] })).toBeTruthy();
  });

  it("CRUD keeps tracked link slugs stable when the destination changes", async () => {
    const s = await signUp();
    const acct = await createDemoAccount(s, "crud.account");
    const created = await s.post("/api/campaigns", campaignBody(acct.id));
    expect(created.status).toBe(201);
    const id = created.body.campaign.id;
    const slug = created.body.campaign.links[0].slug;
    const updated = await s.put(`/api/campaigns/${id}`, campaignBody(acct.id, { name: "Renamed", links: [{ url: "https://example.com/v2", buttonLabel: "Open" }, { url: "https://example.com/extra" }] }));
    expect(updated.status).toBe(200);
    expect(updated.body.campaign.name).toBe("Renamed");
    expect(updated.body.campaign.links[0]).toMatchObject({ slug, destination_url: "https://example.com/v2" });
    expect(updated.body.campaign.links).toHaveLength(2);
    expect((await s.patch(`/api/campaigns/${id}/status`, { status: "paused" })).body.status).toBe("paused");
    expect((await s.get("/api/campaigns")).body.campaigns).toHaveLength(1);
    expect((await s.del(`/api/campaigns/${id}`)).status).toBe(200);
    expect((await s.get(`/api/campaigns/${id}`)).status).toBe(404);
  });
});

describe("tracked links, analytics and logs", () => {
  it("counts clicks (unique per recipient), computes CTR, and exports CSV", async () => {
    const s = await signUp();
    const acct = await createDemoAccount(s, "stats.account");
    const c = (await s.post("/api/campaigns", campaignBody(acct.id))).body.campaign;
    await getEventsQueue().obliterate({ force: true });
    for (const [i, user] of ["u1", "u2"].entries()) {
      await postWebhook(commentPayload({ igUserId: acct.ig_user_id, text: "guide", fromId: user, username: `user${i}`, commentId: `stat${i}` }));
    }
    for (const r of await query("SELECT id FROM inbound_events WHERE ig_account_id = $1", [acct.id])) await processInboundEvent(r.id);

    const dm = await one("SELECT body FROM demo_outbox WHERE ig_account_id = $1 LIMIT 1", [acct.id]);
    const url = new URL(dm!.body.buttons[0].url);
    const click = await request(testApp()).get(url.pathname + url.search).set("User-Agent", "Mozilla/5.0");
    expect(click.status).toBe(302);
    expect(click.headers.location).toBe("https://example.com/guide");
    await request(testApp()).get(url.pathname + url.search).set("User-Agent", "Mozilla/5.0"); // same person again
    await request(testApp()).get(url.pathname + url.search).set("User-Agent", "facebookexternalhit/1.1"); // preview bot
    expect((await request(testApp()).get("/r/doesnotexist")).status).toBe(404);

    const a = await s.get(`/api/campaigns/${c.id}/analytics?days=7`);
    expect(a.body.totals).toMatchObject({ triggered: 2, sent: 2, clicks: 2, unique_clicks: 1, ctr: 0.5 });
    expect(a.body.daily).toHaveLength(7);
    expect(a.body.daily.at(-1)).toMatchObject({ sent: 2, clicks: 2 });
    expect(a.body.links[0]).toMatchObject({ clicks: 2, unique_clicks: 1 });

    const logs = await s.get(`/api/logs?campaignId=${c.id}&status=sent`);
    expect(logs.body.logs).toHaveLength(2);
    expect((await s.get(`/api/logs?q=user1`)).body.logs).toHaveLength(1);
    const csv = await s.get(`/api/logs/export.csv`);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text.split("\n")).toHaveLength(3);

    const overview = await s.get("/api/overview");
    expect(overview.body.totals).toMatchObject({ sent: 2, active_campaigns: 1, accounts: 1 });
  });
});

describe("accounts and Meta callbacks", () => {
  it("never exposes tokens and supports disconnect", async () => {
    const s = await signUp();
    const acct = await createDemoAccount(s, "acct.check");
    const list = await s.get("/api/accounts");
    expect(JSON.stringify(list.body)).not.toContain("access_token");
    expect((await s.get(`/api/accounts/${acct.id}/media`)).body.media.length).toBeGreaterThan(0);
    const connect = await s.get("/api/instagram/connect");
    expect(connect.body.url).toMatch(/^https:\/\/www\.instagram\.com\/oauth\/authorize\?client_id=1234567890/);
    expect(connect.body.url).toContain("instagram_business_manage_messages");
    expect((await s.del(`/api/accounts/${acct.id}`)).status).toBe(200);
    expect((await s.get("/api/accounts")).body.accounts).toHaveLength(0);
  });

  it("rejects OAuth callbacks with a forged state", async () => {
    const r = await request(testApp()).get("/api/instagram/callback?code=abc&state=forged.sig");
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/^\/accounts\?error=/);
  });

  it("handles Meta's signed data-deletion request", async () => {
    const s = await signUp();
    const acct = await createDemoAccount(s, "delete.me");
    const payload = Buffer.from(JSON.stringify({ user_id: acct.ig_user_id })).toString("base64url");
    const sig = createHmac("sha256", "test-instagram-app-secret").update(payload).digest("base64url");
    const r = await request(testApp()).post("/api/meta/data-deletion").type("form").send({ signed_request: `${sig}.${payload}` });
    expect(r.status).toBe(200);
    expect(r.body.confirmation_code).toBeTruthy();
    expect(await one("SELECT 1 FROM ig_accounts WHERE id = $1", [acct.id])).toBeNull();
    const bad = await request(testApp()).post("/api/meta/data-deletion").type("form").send({ signed_request: `bad.${payload}` });
    expect(bad.status).toBe(400);
  });

  it("demo simulator signs and ingests through the real webhook path", async () => {
    const s = await signUp();
    const acct = await createDemoAccount(s, "sim.account");
    const r = await s.post("/api/demo/simulate", { accountId: acct.id, kind: "comment", text: "guide", repeat: 2 });
    expect(r.status).toBe(200);
    expect(r.body.deliveries[0]).toMatchObject({ duplicate: false, stored: 1 });
    expect(r.body.deliveries[1]).toMatchObject({ duplicate: true });
  });
});
