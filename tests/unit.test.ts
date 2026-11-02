import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hashPassword, recipientToken, verifyPassword } from "../src/lib/crypto.js";
import { foldDiacritics, matchCampaign, matchKeywords, stripSpecialCharacters } from "../src/lib/keywords.js";
import { checkSendWindow, clampBytes, clampButtonTitle } from "../src/lib/restrictions.js";
import { renderForButtons, renderInline, renderPublicReply, trackedUrl } from "../src/lib/templates.js";
import { MetaApiError, NetworkError, classifyError } from "../src/meta/errors.js";
import { parseWebhook, signBody, verifySignature } from "../src/meta/webhook.js";
import { createState, parseSignedRequest, verifyState } from "../src/meta/oauth.js";
import { createHmac } from "node:crypto";

describe("keyword matcher (ported from OpenReply)", () => {
  it("matches whole words case-insensitively and ignores emoji/punctuation", () => {
    expect(matchKeywords("LINK please 🔥", ["link"]).matched).toBe(true);
    expect(matchKeywords("link!!!", ["link"]).matchedKeyword).toBe("link");
    expect(matchKeywords("linking", ["link"], true).matched).toBe(false);
    expect(matchKeywords("linking", ["link"], false).matched).toBe(true);
  });
  it("handles non-Latin scripts and diacritics", () => {
    expect(matchKeywords("хочу Клод", ["клод"]).matched).toBe(true);
    expect(matchKeywords("qual o PREÇO?", ["preco"]).matched).toBe(true);
    expect(foldDiacritics("señor")).toBe("senor");
    expect(stripSpecialCharacters("Hello 🔥 World 💪")).toBe("Hello World");
  });
  it("folds Arabic-script keyboard variants (Urdu/Persian)", () => {
    expect(matchKeywords("لينك", ["لینک"]).matched).toBe(true);
  });
  it("folds letter O into 0 only for numeric keywords", () => {
    expect(matchKeywords("O8", ["08"]).matched).toBe(true);
    expect(matchKeywords("love", ["l0ve"]).matched).toBe(false);
  });
  it("supports multi-word keywords and any-message mode", () => {
    expect(matchKeywords("send me the free guide now", ["free guide"]).matched).toBe(true);
    expect(matchCampaign("anything", [], "any_message").matched).toBe(true);
    expect(matchCampaign("   ", [], "any_message").matched).toBe(false);
    expect(matchCampaign("GUIDEbook", ["guide"], "contains").matched).toBe(true);
  });
});

describe("crypto", () => {
  it("round-trips encrypted tokens and rejects tampering", () => {
    const enc = encryptSecret("IGAAtoken123");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("IGAAtoken123");
    expect(decryptSecret(enc)).toBe("IGAAtoken123");
    const raw = Buffer.from(enc.slice(3), "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => decryptSecret("v1:" + raw.toString("base64"))).toThrow();
    expect(encryptSecret("same")).not.toBe(encryptSecret("same")); // random IV
  });
  it("hashes and verifies passwords", async () => {
    const h = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("derives stable, opaque recipient tokens", () => {
    expect(recipientToken("123")).toBe(recipientToken("123"));
    expect(recipientToken("123")).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(recipientToken("123")).not.toContain("123");
  });
});

describe("Meta restrictions", () => {
  const now = new Date("2026-11-02T12:00:00Z");
  it("enforces the 7-day private reply window", () => {
    expect(checkSendWindow({ kind: "comment", occurredAt: new Date("2026-10-27T12:00:00Z"), now })).toBeNull();
    expect(checkSendWindow({ kind: "comment", occurredAt: new Date("2026-10-26T11:00:00Z"), now })).toBe("comment_too_old");
  });
  it("enforces the 24-hour messaging window using the latest inbound message", () => {
    const old = new Date("2026-10-31T11:00:00Z");
    expect(checkSendWindow({ kind: "dm", occurredAt: old, now })).toBe("outside_messaging_window");
    expect(checkSendWindow({ kind: "story_reply", occurredAt: old, lastInboundAt: new Date("2026-11-02T10:00:00Z"), now })).toBeNull();
  });
  it("clamps text by UTF-8 bytes without splitting emoji", () => {
    const s = "😀".repeat(400); // 1600 bytes
    const out = clampBytes(s, 1000);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(1000);
    expect(out.endsWith("…")).toBe(true);
    expect(clampButtonTitle("A very long button title here")).toHaveLength(20);
  });
});

describe("templates", () => {
  const ctx = { username: "jane", recipientId: "r1", baseUrl: "https://app.test", links: [{ slug: "abc", destinationUrl: "https://x.com" }] };
  it("personalizes and swaps in tracked links", () => {
    const out = renderInline("Hi {username}, here: {link}", ctx);
    expect(out).toBe(`Hi @jane, here: https://app.test/r/abc?r=${recipientToken("r1")}`);
  });
  it("appends the link when no placeholder is used", () => {
    expect(renderInline("Thanks!", ctx)).toContain("\nhttps://app.test/r/abc?r=");
  });
  it("falls back to 'there' without a username and strips placeholders for buttons", () => {
    expect(renderForButtons("Hi {username}! Tap below {link}", { ...ctx, username: null })).toBe("Hi there! Tap below");
    expect(renderPublicReply("Sent you a DM {username} {link}", "bo")).toBe("Sent you a DM @bo");
    expect(trackedUrl("https://a.b/", "s")).toBe("https://a.b/r/s");
  });
});

describe("error classification", () => {
  const e = (code: number, http = 400, msg = "x") => new MetaApiError(msg, code, undefined, http);
  it("classifies Meta errors by retry safety", () => {
    expect(classifyError(e(4))).toBe("rate_limited");
    expect(classifyError(e(613))).toBe("rate_limited");
    expect(classifyError(e(190))).toBe("auth");
    expect(classifyError(e(100))).toBe("rejected");
    expect(classifyError(e(10, 403))).toBe("rejected");
    expect(classifyError(e(1, 500))).toBe("unconfirmed");
    expect(classifyError(e(2))).toBe("unconfirmed");
    expect(classifyError(new NetworkError("reset"))).toBe("unconfirmed");
    expect(classifyError(e(100, 400, "Invalid button template"))).toBe("template_rejected");
    expect(classifyError(e(100, 400, "Template outside of allowed window"))).toBe("rejected");
  });
});

describe("webhook verification and parsing", () => {
  it("verifies X-Hub-Signature-256 with the app secret only", () => {
    const body = '{"object":"instagram","entry":[]}';
    expect(verifySignature(body, signBody(body, "test-instagram-app-secret"))).toBe(true);
    expect(verifySignature(body, signBody(body, "wrong"))).toBe(false);
    expect(verifySignature(body, undefined)).toBe(false);
    expect(verifySignature(body + " ", signBody(body, "test-instagram-app-secret"))).toBe(false);
  });

  it("parses comments, skips own comments, keeps ad original media", () => {
    const events = parseWebhook({
      object: "instagram",
      entry: [
        {
          id: "IG1",
          time: 1_700_000_000,
          changes: [
            { field: "comments", value: { id: "c1", text: "LINK", from: { id: "u1", username: "a" }, media: { id: "m1" } } },
            { field: "comments", value: { id: "c2", text: "LINK", from: { id: "IG1", username: "me" }, media: { id: "m1" } } },
            { field: "comments", value: { id: "c3", text: "x", from: { id: "u2" }, media: { id: "ad1", original_media_id: "m9" } } },
            { field: "live_comments", value: { id: "c4", text: "LINK", from: { id: "u3" }, media: { id: "live" } } },
          ],
        },
      ],
    });
    expect(events.map((e) => e.externalId)).toEqual(["c1", "c3"]);
    expect(events[0]).toMatchObject({ kind: "comment", igUserId: "IG1", senderUsername: "a", mediaId: "m1" });
    expect(events[0].occurredAt.toISOString()).toBe(new Date(1_700_000_000_000).toISOString());
    expect(events[1].originalMediaId).toBe("m9");
  });

  it("parses DMs and Story replies, drops echoes, deletions and attachment-only messages", () => {
    const m = (message: object, sender = "u1") => ({ sender: { id: sender }, recipient: { id: "IG1" }, timestamp: 1_700_000_000_123, message });
    const events = parseWebhook({
      object: "instagram",
      entry: [
        {
          id: "IG1",
          time: 1,
          messaging: [
            m({ mid: "m1", text: "guide" }),
            m({ mid: "m2", text: "guide", reply_to: { story: { id: "s1", url: "u" } } }),
            m({ mid: "m3", text: "guide", is_echo: true }),
            m({ mid: "m4", is_deleted: true }),
            m({ mid: "m5", attachments: [{ type: "story_mention" }] }),
            m({ mid: "m6", text: "hi" }, "IG1"),
            { sender: { id: "u1" }, recipient: { id: "IG1" }, postback: { payload: "x" } },
          ],
        },
      ],
    });
    expect(events.map((e) => [e.externalId, e.kind])).toEqual([
      ["m1", "dm"],
      ["m2", "story_reply"],
    ]);
    expect(events[1].mediaId).toBe("s1");
    expect(events[0].occurredAt.getTime()).toBe(1_700_000_000_123);
  });

  it("ignores non-instagram objects", () => {
    expect(parseWebhook({ object: "page", entry: [] })).toEqual([]);
    expect(parseWebhook(null)).toEqual([]);
  });
});

describe("OAuth state and signed_request", () => {
  it("signs state and rejects tampering or expiry", () => {
    const s = createState("ws-1", "user-1");
    expect(verifyState(s)).toMatchObject({ w: "ws-1", u: "user-1" });
    expect(verifyState(s.replace(/.$/, (c) => (c === "a" ? "b" : "a")))).toBeNull();
    expect(verifyState(s, Date.now() + 11 * 60_000)).toBeNull();
    expect(verifyState(undefined)).toBeNull();
  });
  it("verifies Meta signed_request payloads", () => {
    const payload = Buffer.from(JSON.stringify({ user_id: "42", algorithm: "HMAC-SHA256" })).toString("base64url");
    const sig = createHmac("sha256", "sek").update(payload).digest("base64url");
    expect(parseSignedRequest(`${sig}.${payload}`, ["sek"])).toMatchObject({ user_id: "42" });
    expect(parseSignedRequest(`${sig}.${payload}`, ["other"])).toBeNull();
  });
});
