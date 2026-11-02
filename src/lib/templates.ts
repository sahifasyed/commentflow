/**
 * Message rendering: {username}, {first_name}-style personalization and
 * {link}/{link2} tracked-link substitution. Behavior follows OpenReply's
 * tracking/message.ts: an unknown username falls back to "there".
 */
import { recipientToken } from "./crypto.js";

export interface RenderLink {
  slug: string;
  destinationUrl: string;
  buttonLabel?: string | null;
}

export interface RenderContext {
  username?: string | null;
  recipientId: string;
  baseUrl: string;
  links: RenderLink[];
}

export const TEMPLATE_VARIABLES = ["{username}", "{link}", "{link2}"] as const;

export function trackedUrl(baseUrl: string, slug: string, recipientId?: string): string {
  const url = `${baseUrl.replace(/\/$/, "")}/r/${slug}`;
  return recipientId ? `${url}?r=${recipientToken(recipientId)}` : url;
}

function personalize(text: string, username?: string | null): string {
  const handle = username ? `@${username.replace(/^@/, "")}` : "there";
  return text.replace(/\{username\}/gi, handle);
}

/** Inline rendering: {link}/{link2} become tracked URLs. If a link exists but
 *  no placeholder is used, the first link is appended so it is never lost. */
export function renderInline(template: string, ctx: RenderContext): string {
  let out = personalize(template, ctx.username);
  const urls = ctx.links.map((l) => trackedUrl(ctx.baseUrl, l.slug, ctx.recipientId));
  const hadPlaceholder = /\{link2?\}/i.test(out);
  out = out.replace(/\{link\}/gi, urls[0] ?? "").replace(/\{link2\}/gi, urls[1] ?? "");
  if (!hadPlaceholder && urls[0]) out = `${out.trimEnd()}\n${urls[0]}`;
  return out.replace(/[ \t]+\n/g, "\n").trim();
}

/** Rendering for button templates: links travel as buttons, so placeholders
 *  are removed from the body text. */
export function renderForButtons(template: string, ctx: Omit<RenderContext, "links">): string {
  return personalize(template, ctx.username)
    .replace(/\s*\{link2?\}\s*/gi, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function renderPublicReply(template: string, username?: string | null): string {
  return personalize(template, username).replace(/\s*\{link2?\}\s*/gi, " ").trim();
}

export function pickRandom<T>(items: T[], rand: () => number = Math.random): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rand() * items.length)];
}
