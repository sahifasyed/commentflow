/**
 * Graph API error model and classification.
 *
 * The classification decides retry safety. Following OpenReply's delivery
 * policy (docs/delivery-retries.md): only an explicit rejection proves a
 * message was NOT delivered. Meta code 1/2, 5xx, timeouts and network errors
 * have been observed alongside actual delivery, so they are "unconfirmed" and
 * are never automatically re-sent.
 */
export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly subcode: number | undefined,
    public readonly httpStatus: number,
    public readonly fbtraceId?: string
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

export type ErrorClass =
  | "rate_limited" // explicit throttle: not delivered, retry later
  | "auth" // token invalid/expired: not delivered, account needs reconnect
  | "template_rejected" // button template refused: safe to fall back to text
  | "rejected" // permanent refusal: not delivered, do not retry
  | "unconfirmed"; // may have been delivered: never auto-retry

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const UNCONFIRMED_CODES = new Set([1, 2]);
const NON_TEMPLATE_PATTERNS = [/outside of allowed window/i, /invalid for a private reply/i, /cannot be found/i];

export function classifyError(err: unknown): ErrorClass {
  if (err instanceof MetaApiError) {
    if (err.code === 190) return "auth";
    if (RATE_LIMIT_CODES.has(err.code)) return "rate_limited";
    if (UNCONFIRMED_CODES.has(err.code) || err.httpStatus >= 500) return "unconfirmed";
    if (
      err.code === 100 &&
      /template|button/i.test(err.message) &&
      !NON_TEMPLATE_PATTERNS.some((p) => p.test(err.message))
    ) {
      return "template_rejected";
    }
    if (err.httpStatus >= 400 && err.httpStatus < 500) return "rejected";
    return "unconfirmed";
  }
  return "unconfirmed"; // NetworkError, TypeError from fetch, JSON errors...
}

export function describeError(err: unknown): string {
  if (err instanceof MetaApiError) {
    return `${err.message} [code=${err.code} sub=${err.subcode ?? "-"} http=${err.httpStatus}${
      err.fbtraceId ? ` trace=${err.fbtraceId}` : ""
    }]`;
  }
  return err instanceof Error ? err.message : String(err);
}
