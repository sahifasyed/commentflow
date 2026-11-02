/**
 * Instagram API with Instagram Login (graph.instagram.com) client, plus the
 * provider interface implemented by both the real client and the demo client.
 */
import { getConfig } from "../config.js";
import { MetaApiError, NetworkError } from "./errors.js";
import { BUTTON_TEXT_MAX, MAX_BUTTONS, clampBytes, clampButtonTitle } from "../lib/restrictions.js";

export interface LinkButton {
  title: string;
  url: string;
}

export interface OutboundMessage {
  text: string;
  buttons?: LinkButton[];
}

export interface Media {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  thumbnail_url?: string;
  media_url?: string;
  timestamp?: string;
}

export interface Profile {
  user_id: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
  account_type?: string;
}

export interface InstagramApi {
  /** One-time private reply to a comment (recipient.comment_id). */
  sendPrivateReply(commentId: string, message: OutboundMessage): Promise<{ messageId: string }>;
  /** DM inside the 24h standard messaging window (recipient.id). */
  sendDirectMessage(igsid: string, message: OutboundMessage): Promise<{ messageId: string }>;
  /** Public reply under a comment. */
  replyToComment(commentId: string, text: string): Promise<{ id: string }>;
  listMedia(limit?: number): Promise<Media[]>;
  getUsername(igsid: string): Promise<string | null>;
}

export type FetchFn = typeof fetch;

export function graphBase(): string {
  return `https://graph.instagram.com/${getConfig().META_GRAPH_API_VERSION}`;
}

export async function graphRequest<T>(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit & { token?: string } = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new NetworkError(`Network error calling Instagram API: ${(err as Error).message}`);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new MetaApiError(`Non-JSON response from Instagram API (${res.status})`, res.status >= 500 ? 2 : 0, undefined, res.status);
  }
  if (!res.ok || data?.error) {
    const e = data?.error ?? {};
    const path = (() => {
      try {
        return new URL(url).pathname; // never include the query string (may carry tokens)
      } catch {
        return "";
      }
    })();
    throw new MetaApiError(
      `${e.message ?? `HTTP ${res.status}`} (${path})`,
      typeof e.code === "number" ? e.code : res.status,
      e.error_subcode,
      res.status,
      e.fbtrace_id
    );
  }
  return data as T;
}

function buildMessage(message: OutboundMessage) {
  if (message.buttons && message.buttons.length > 0) {
    return {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: clampBytes(message.text, BUTTON_TEXT_MAX),
          buttons: message.buttons.slice(0, MAX_BUTTONS).map((b) => ({
            type: "web_url",
            url: b.url,
            title: clampButtonTitle(b.title),
          })),
        },
      },
    };
  }
  return { text: clampBytes(message.text) };
}

export class GraphInstagramApi implements InstagramApi {
  constructor(
    private readonly igUserId: string,
    private readonly accessToken: string,
    private readonly fetchFn: FetchFn = fetch
  ) {}

  private async send(recipient: object, message: OutboundMessage) {
    const data = await graphRequest<{ message_id?: string }>(this.fetchFn, `${graphBase()}/${this.igUserId}/messages`, {
      method: "POST",
      token: this.accessToken,
      body: JSON.stringify({ recipient, message: buildMessage(message) }),
    });
    if (!data?.message_id) {
      // 200 without an id: we cannot prove it was or wasn't delivered.
      throw new MetaApiError("Send returned no message_id", 2, undefined, 200);
    }
    return { messageId: data.message_id };
  }

  sendPrivateReply(commentId: string, message: OutboundMessage) {
    return this.send({ comment_id: commentId }, message);
  }

  sendDirectMessage(igsid: string, message: OutboundMessage) {
    return this.send({ id: igsid }, message);
  }

  async replyToComment(commentId: string, text: string) {
    const url = `${graphBase()}/${encodeURIComponent(commentId)}/replies`;
    const data = await graphRequest<{ id: string }>(this.fetchFn, url, {
      method: "POST",
      token: this.accessToken,
      body: JSON.stringify({ message: text }),
    });
    return { id: data.id };
  }

  async listMedia(limit = 24) {
    const url = new URL(`${graphBase()}/${this.igUserId}/media`);
    url.searchParams.set("fields", "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp");
    url.searchParams.set("limit", String(limit));
    const data = await graphRequest<{ data: Media[] }>(this.fetchFn, url.toString(), { token: this.accessToken });
    return data.data ?? [];
  }

  async getUsername(igsid: string) {
    try {
      const url = new URL(`${graphBase()}/${encodeURIComponent(igsid)}`);
      url.searchParams.set("fields", "username");
      const data = await graphRequest<{ username?: string }>(this.fetchFn, url.toString(), { token: this.accessToken });
      return data.username ?? null;
    } catch {
      return null; // personalization is best-effort
    }
  }
}
