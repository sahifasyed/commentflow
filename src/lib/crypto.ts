import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { getConfig } from "../config.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

// ── Token encryption at rest (AES-256-GCM) ─────────────────────────────────────
// Format: "v1:" + base64(iv[12] | tag[16] | ciphertext). The version prefix
// allows key rotation later without guessing formats.

function key(): Buffer {
  return Buffer.from(getConfig().ENCRYPTION_KEY, "hex");
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return "v1:" + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decryptSecret(value: string): string {
  if (!value.startsWith("v1:")) throw new Error("Unknown secret format");
  const raw = Buffer.from(value.slice(3), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// ── Passwords (scrypt, N=2^15) ─────────────────────────────────────────────────

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt" || !n || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const derived = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    ...SCRYPT,
    N: Number(n),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ── Misc helpers ───────────────────────────────────────────────────────────────

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmac(value: string, purpose: string): string {
  return createHmac("sha256", getConfig().SESSION_SECRET).update(`${purpose}:${value}`).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Short keyed hash put on tracked links (?r=) so clicks dedupe per recipient
 *  without exposing the Instagram-scoped id. */
export function recipientToken(recipientId: string): string {
  return hmac(recipientId, "recipient").slice(0, 22);
}

export function hashIp(ip: string | null | undefined): string | null {
  return ip ? hmac(ip, "click-ip").slice(0, 32) : null;
}
