/**
 * Meta / Instagram messaging restrictions, enforced in one place.
 *
 * Sources (Meta developer docs, Instagram Platform):
 *  - Private replies: only ONE message per comment, and it must be sent within
 *    7 days of the comment's creation time. Live comments only during the broadcast.
 *  - Standard messaging window: a business may reply to a user's DM within 24
 *    hours of that user's last message.
 *  - Button template: text <= 640 chars, <= 3 buttons, titles <= 20 chars.
 *  - Text messages: <= 1000 characters (UTF-8 text).
 *  - Private replies are rate limited (750 / hour / professional account).
 */

export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const STANDARD_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TEXT_MAX = 1000;
export const BUTTON_TEXT_MAX = 640;
export const BUTTON_TITLE_MAX = 20;
export const MAX_BUTTONS = 3;
export const MAX_LINK_BUTTONS = 2; // product choice, within Meta's 3
export const PUBLIC_REPLY_MAX = 2200; // Instagram comment length cap

export type TriggerKind = "comment" | "dm" | "story_reply";

export type SkipReason =
  | "comment_too_old"
  | "outside_messaging_window"
  | "comment_already_replied"
  | "self_message"
  | "cooldown"
  | "rate_limited"
  | "account_inactive"
  | "max_attempts";

export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  comment_too_old: "Comment is older than 7 days; Meta no longer allows a private reply",
  outside_messaging_window: "User's last message is older than 24 hours (standard messaging window closed)",
  comment_already_replied: "Another campaign already sent the one private reply Meta allows for this comment",
  self_message: "Sender is the connected account itself",
  cooldown: "Recipient already received this campaign's DM within the cooldown period",
  rate_limited: "Hourly send limit reached repeatedly; gave up",
  account_inactive: "Instagram account is disconnected or its token expired",
  max_attempts: "Maximum send attempts reached",
};

export function checkSendWindow(args: {
  kind: TriggerKind;
  occurredAt: Date;
  lastInboundAt?: Date | null;
  now?: Date;
}): SkipReason | null {
  const now = (args.now ?? new Date()).getTime();
  if (args.kind === "comment") {
    return now - args.occurredAt.getTime() > PRIVATE_REPLY_WINDOW_MS ? "comment_too_old" : null;
  }
  const last = (args.lastInboundAt ?? args.occurredAt).getTime();
  return now - last > STANDARD_MESSAGING_WINDOW_MS ? "outside_messaging_window" : null;
}

/** Truncate on a code-point boundary, never splitting an emoji. */
export function clampText(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max - 1).join("") + "…";
}

/** Meta caps DM text at 1000 UTF-8 *bytes*; trim by code point until it fits. */
export function clampBytes(text: string, maxBytes: number = TEXT_MAX): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const chars = Array.from(text);
  let out = "";
  let size = Buffer.byteLength("…");
  for (const ch of chars) {
    const n = Buffer.byteLength(ch);
    if (size + n > maxBytes) break;
    out += ch;
    size += n;
  }
  return out + "…";
}

export function clampButtonTitle(title: string): string {
  return Array.from(title.trim()).slice(0, BUTTON_TITLE_MAX).join("");
}
