import { describe, expect, it } from "vitest";
import { GraphInstagramApi } from "../src/meta/api.js";
import { MetaApiError, NetworkError } from "../src/meta/errors.js";
import { exchangeCode, fetchProfile, subscribeWebhooks } from "../src/meta/oauth.js";

type Call = { url: string; init: RequestInit };

function mockFetch(responses: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses.shift();
    if (!r) throw new Error("unexpected call");
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("GraphInstagramApi", () => {
  it("sends a private reply with recipient.comment_id and bearer auth", async () => {
    const { fn, calls } = mockFetch([{ body: { recipient_id: "u", message_id: "mid.1" } }]);
    const api = new GraphInstagramApi("1784", "TOKEN", fn);
    const r = await api.sendPrivateReply("c123", { text: "hello" });
    expect(r.messageId).toBe("mid.1");
    expect(calls[0].url).toBe("https://graph.instagram.com/v25.0/1784/messages");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer TOKEN");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ recipient: { comment_id: "c123" }, message: { text: "hello" } });
  });

  it("builds a button template with web_url buttons for links", async () => {
    const { fn, calls } = mockFetch([{ body: { message_id: "mid.2" } }]);
    const api = new GraphInstagramApi("1784", "T", fn);
    await api.sendDirectMessage("igsid9", {
      text: "Here you go",
      buttons: [{ title: "A title that is way too long for Meta", url: "https://a.test/r/x" }],
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.recipient).toEqual({ id: "igsid9" });
    expect(body.message.attachment.payload).toMatchObject({
      template_type: "button",
      text: "Here you go",
      buttons: [{ type: "web_url", url: "https://a.test/r/x", title: "A title that is way " }],
    });
  });

  it("maps Graph errors to MetaApiError and network failures to NetworkError", async () => {
    const { fn } = mockFetch([
      { status: 400, body: { error: { message: "(#4) Application request limit reached", code: 4, fbtrace_id: "T1" } } },
      new TypeError("fetch failed"),
      { body: { recipient_id: "x" } },
    ]);
    const api = new GraphInstagramApi("1", "T", fn);
    await expect(api.sendPrivateReply("c", { text: "x" })).rejects.toMatchObject({ code: 4, httpStatus: 400, fbtraceId: "T1" });
    await expect(api.sendPrivateReply("c", { text: "x" })).rejects.toBeInstanceOf(NetworkError);
    // 200 without message_id is treated as "unconfirmed" (code 2)
    await expect(api.sendPrivateReply("c", { text: "x" })).rejects.toMatchObject({ code: 2 });
  });

  it("posts public comment replies to /{comment-id}/replies", async () => {
    const { fn, calls } = mockFetch([{ body: { id: "r1" } }]);
    await new GraphInstagramApi("1", "T", fn).replyToComment("c77", "Check your DMs!");
    expect(calls[0].url).toBe("https://graph.instagram.com/v25.0/c77/replies");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ message: "Check your DMs!" });
  });
});

describe("OAuth exchange", () => {
  it("exchanges code -> short-lived -> long-lived token and strips #_", async () => {
    const { fn, calls } = mockFetch([
      { body: { access_token: "short", user_id: 99, permissions: ["instagram_business_basic"] } },
      { body: { access_token: "long", token_type: "bearer", expires_in: 5184000 } },
    ]);
    const t = await exchangeCode("abc#_", fn);
    expect(t.accessToken).toBe("long");
    expect(t.expiresAt.getTime()).toBeGreaterThan(Date.now() + 59 * 86400_000);
    expect(calls[0].url).toBe("https://api.instagram.com/oauth/access_token");
    const form = new URLSearchParams(String(calls[0].init.body));
    expect(form.get("code")).toBe("abc");
    expect(form.get("redirect_uri")).toBe("http://localhost:3000/api/instagram/callback");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(calls[1].url).toContain("grant_type=ig_exchange_token");
  });

  it("stores user_id (professional account id), not the app-scoped id", async () => {
    const { fn } = mockFetch([{ body: { id: "app-scoped-1", user_id: "17841400000", username: "shop" } }]);
    expect((await fetchProfile("t", fn)).user_id).toBe("17841400000");
  });

  it("subscribes to comments and messages webhook fields", async () => {
    const { fn, calls } = mockFetch([{ body: { success: true } }]);
    expect(await subscribeWebhooks("t", fn)).toBe(true);
    expect(calls[0].url).toContain("/me/subscribed_apps?subscribed_fields=comments%2Cmessages");
    expect(calls[0].init.method).toBe("POST");
  });

  it("surfaces OAuth errors", async () => {
    const { fn } = mockFetch([{ status: 400, body: { error: { message: "Invalid code", code: 100 } } }]);
    await expect(exchangeCode("bad", fn)).rejects.toBeInstanceOf(MetaApiError);
  });
});
