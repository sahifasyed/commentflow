import express, { Router } from "express";
import { getConfig } from "../../config.js";
import { query } from "../../db/pool.js";
import { safeEqual } from "../../lib/crypto.js";
import { verifySignature } from "../../meta/webhook.js";
import { ingestWebhook } from "../../services/ingest.js";
import { logSystemEvent } from "../../services/maintenance.js";
import { asyncHandler } from "../http.js";

export const webhookRouter = Router();

/** Meta's subscription handshake (GET with hub.* params). */
webhookRouter.get("/webhook", (req, res) => {
  const token = getConfig().WEBHOOK_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const verify = String(req.query["hub.verify_token"] ?? "");
  const challenge = String(req.query["hub.challenge"] ?? "");
  if (mode === "subscribe" && token && safeEqual(verify, token)) {
    res.type("text/plain").status(200).send(challenge);
    return;
  }
  res.status(403).json({ error: "Webhook verification failed" });
});

/** Event delivery. Raw body is required for signature verification. */
webhookRouter.post(
  "/webhook",
  express.raw({ type: "*/*", limit: "2mb" }),
  asyncHandler(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const signature = req.header("x-hub-signature-256");
    if (!verifySignature(raw, signature)) {
      await logSystemEvent("warning", "webhook", "Webhook signature verification failed", {
        hasSignature: Boolean(signature),
        bytes: raw.length,
      });
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
    let payload: unknown;
    const text = raw.toString("utf8");
    try {
      payload = JSON.parse(text);
    } catch {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }
    // Throws (-> 500, Meta retries) if the DB is unavailable.
    const result = await ingestWebhook(text, payload);
    res.status(200).json({ ok: true, ...result });
  })
);

/** Diagnostics for the Accounts page: when did we last hear from Meta? */
export async function lastWebhookAt(): Promise<string | null> {
  const r = await query<{ received_at: Date }>("SELECT received_at FROM webhook_deliveries ORDER BY id DESC LIMIT 1");
  return r[0]?.received_at?.toISOString() ?? null;
}
