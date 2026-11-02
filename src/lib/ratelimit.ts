/**
 * Redis fixed-window counters, reserved atomically with a Lua script so
 * concurrent workers can never overshoot the cap. Pattern adapted from
 * OpenReply's rate-limiter (reserve before send, release on confirmed
 * rejection so failed sends don't burn quota).
 */
import type { Redis } from "ioredis";
import { getRedis } from "./redis.js";

const RESERVE = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local max = tonumber(ARGV[1])
if current >= max then
  return {0, current, redis.call("PTTL", KEYS[1])}
end
local n = redis.call("INCR", KEYS[1])
if n == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[2]) end
return {1, n, redis.call("PTTL", KEYS[1])}
`;

const RELEASE = `
local v = tonumber(redis.call("GET", KEYS[1]) or "0")
if v > 0 then return redis.call("DECR", KEYS[1]) end
return 0
`;

export interface Reservation {
  allowed: boolean;
  count: number;
  /** ms until the window resets */
  resetInMs: number;
}

export async function reserve(
  bucket: string,
  max: number,
  windowMs: number,
  redis: Redis = getRedis()
): Promise<Reservation> {
  if (max <= 0) return { allowed: true, count: 0, resetInMs: 0 };
  const [ok, count, pttl] = (await redis.eval(RESERVE, 1, `rl:${bucket}`, max, windowMs)) as number[];
  return { allowed: ok === 1, count, resetInMs: Math.max(0, pttl) };
}

export async function release(bucket: string, redis: Redis = getRedis()): Promise<void> {
  await redis.eval(RELEASE, 1, `rl:${bucket}`);
}

/** Per-account send buckets. */
export const sendBucket = (kind: "private_reply" | "dm" | "public_reply", igAccountId: string) =>
  `send:${kind}:${igAccountId}`;
