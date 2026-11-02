/**
 * Business Login for Instagram (Instagram API with Instagram Login).
 * Flow: authorize on www.instagram.com -> short-lived token from
 * api.instagram.com -> long-lived (60 day) token from graph.instagram.com ->
 * /me -> subscribe the account to the app's webhook fields.
 */
import { createHmac } from "node:crypto";
import { getConfig } from "../config.js";
import { hmac, randomToken, safeEqual } from "../lib/crypto.js";
import { graphBase, graphRequest, type FetchFn, type Profile } from "./api.js";

export const OAUTH_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
];
export const WEBHOOK_FIELDS = ["comments", "messages"];
const STATE_TTL_MS = 10 * 60 * 1000;

export function redirectUri(): string {
  return `${getConfig().APP_URL}/api/instagram/callback`;
}

interface StatePayload {
  w: string; // workspace id
  u: string; // user id
  t: number; // issued at
  n: string; // nonce
}

export function createState(workspaceId: string, userId: string): string {
  const body = Buffer.from(JSON.stringify({ w: workspaceId, u: userId, t: Date.now(), n: randomToken(8) })).toString(
    "base64url"
  );
  return `${body}.${hmac(body, "oauth-state")}`;
}

export function verifyState(state: string | undefined, now = Date.now()): StatePayload | null {
  if (!state) return null;
  const [body, sig] = state.split(".");
  if (!body || !sig || !safeEqual(sig, hmac(body, "oauth-state"))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
    if (typeof p.t !== "number" || now - p.t < 0 || now - p.t > STATE_TTL_MS) return null;
    if (typeof p.w !== "string" || typeof p.u !== "string") return null;
    return p;
  } catch {
    return null;
  }
}

export function authorizeUrl(state: string): string {
  const c = getConfig();
  const params = new URLSearchParams({
    client_id: c.INSTAGRAM_APP_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: OAUTH_SCOPES.join(","),
    state,
  });
  return `https://www.instagram.com/oauth/authorize?${params}`;
}

export async function exchangeCode(code: string, fetchFn: FetchFn = fetch) {
  const c = getConfig();
  const body = new URLSearchParams({
    client_id: c.INSTAGRAM_APP_ID,
    client_secret: c.INSTAGRAM_APP_SECRET,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
    code: code.replace(/#_$/, ""), // Instagram appends "#_" to the code
  });
  const short = await graphRequest<{ access_token: string; user_id: number | string; permissions?: string[] }>(
    fetchFn,
    "https://api.instagram.com/oauth/access_token",
    { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  const longUrl = new URL(`${graphBase()}/access_token`);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", c.INSTAGRAM_APP_SECRET);
  longUrl.searchParams.set("access_token", short.access_token);
  const long = await graphRequest<{ access_token: string; expires_in: number }>(fetchFn, longUrl.toString());
  return {
    accessToken: long.access_token,
    expiresAt: new Date(Date.now() + (long.expires_in ?? 60 * 24 * 3600) * 1000),
    grantedScopes: short.permissions ?? [],
  };
}

export async function refreshLongLivedToken(token: string, fetchFn: FetchFn = fetch) {
  const url = new URL(`${graphBase()}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", token);
  const data = await graphRequest<{ access_token: string; expires_in: number }>(fetchFn, url.toString());
  return { accessToken: data.access_token, expiresAt: new Date(Date.now() + data.expires_in * 1000) };
}

export async function fetchProfile(token: string, fetchFn: FetchFn = fetch): Promise<Profile> {
  const url = new URL(`${graphBase()}/me`);
  url.searchParams.set("fields", "user_id,username,name,profile_picture_url,account_type");
  const me = await graphRequest<Profile & { id: string }>(fetchFn, url.toString(), { token });
  // `user_id` is the professional account id used in webhooks and messaging;
  // `id` is app-scoped. Store user_id.
  return { ...me, user_id: String(me.user_id ?? me.id) };
}

export async function subscribeWebhooks(token: string, fetchFn: FetchFn = fetch): Promise<boolean> {
  const url = new URL(`${graphBase()}/me/subscribed_apps`);
  url.searchParams.set("subscribed_fields", WEBHOOK_FIELDS.join(","));
  const data = await graphRequest<{ success?: boolean }>(fetchFn, url.toString(), { method: "POST", token });
  return Boolean(data?.success);
}

/** Parse Meta's signed_request (deauthorize / data deletion callbacks). */
export function parseSignedRequest(signed: string | undefined, secrets: string[]): { user_id?: string } | null {
  if (!signed) return null;
  const [sigB64, payloadB64] = signed.split(".");
  if (!sigB64 || !payloadB64) return null;
  const ok = secrets.some((s) => {
    const expected = createHmac("sha256", s).update(payloadB64).digest("base64url");
    return safeEqual(expected, sigB64.replace(/=+$/, ""));
  });
  if (!ok) return null;
  try {
    return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
