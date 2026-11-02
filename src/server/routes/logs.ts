import { Router } from "express";
import { z } from "zod";
import { query } from "../../db/pool.js";
import { workspaceOverview } from "../../services/analytics.js";
import { requireWorkspace } from "../auth.js";
import { asyncHandler, parse } from "../http.js";

export const logsRouter = Router();

const filters = z.object({
  campaignId: z.string().uuid().optional(),
  status: z.enum(["pending", "sending", "sent", "failed", "unconfirmed", "skipped"]).optional(),
  kind: z.enum(["comment", "dm", "story_reply"]).optional(),
  q: z.string().trim().max(100).optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function buildWhere(workspaceId: string, f: z.infer<typeof filters>) {
  const where = ["l.workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll(/\?#?/g, `$${params.length}`));
  };
  if (f.campaignId) add("l.campaign_id = ?", f.campaignId);
  if (f.status) add("l.dm_status = ?", f.status);
  if (f.kind) add("l.trigger_kind = ?", f.kind);
  if (f.q) add("(l.trigger_text ILIKE ? OR l.recipient_username ILIKE ?)", `%${f.q}%`);
  if (f.before) add("l.created_at < ?", f.before);
  return { where: where.join(" AND "), params };
}

const SELECT = `SELECT l.id, l.created_at, l.updated_at, l.sent_at, l.trigger_kind, l.recipient_id, l.recipient_username, l.trigger_text,
  l.matched_keyword, l.dm_status, l.skip_reason, l.dm_text, l.attempts, l.error, l.public_reply_status, l.public_reply_text,
  l.public_reply_error, l.campaign_id, c.name AS campaign_name, a.username AS account_username, e.media_id
  FROM message_logs l JOIN campaigns c ON c.id = l.campaign_id JOIN ig_accounts a ON a.id = l.ig_account_id
  JOIN inbound_events e ON e.id = l.inbound_event_id`;

logsRouter.get(
  "/logs",
  requireWorkspace("member"),
  asyncHandler(async (req, res) => {
    const f = parse(filters, req.query);
    const { where, params } = buildWhere(req.workspace!.id, f);
    params.push(f.limit + 1);
    const rows = await query(`${SELECT} WHERE ${where} ORDER BY l.created_at DESC LIMIT $${params.length}`, params);
    const hasMore = rows.length > f.limit;
    res.json({ logs: rows.slice(0, f.limit), hasMore });
  })
);

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

logsRouter.get(
  "/logs/export.csv",
  requireWorkspace("member"),
  asyncHandler(async (req, res) => {
    const f = parse(filters.extend({ limit: z.coerce.number().int().min(1).max(50_000).default(10_000) }), req.query);
    const { where, params } = buildWhere(req.workspace!.id, f);
    params.push(f.limit);
    const rows = await query(`${SELECT} WHERE ${where} ORDER BY l.created_at DESC LIMIT $${params.length}`, params);
    const cols = [
      "created_at", "campaign_name", "account_username", "trigger_kind", "recipient_username", "recipient_id", "trigger_text",
      "matched_keyword", "dm_status", "skip_reason", "attempts", "sent_at", "error", "public_reply_status", "public_reply_error",
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="message-logs.csv"`);
    res.send([cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n"));
  })
);

logsRouter.get(
  "/overview",
  requireWorkspace("member"),
  asyncHandler(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const overview = await workspaceOverview(req.workspace!.id, days);
    const recent = await query(`${SELECT} WHERE l.workspace_id = $1 ORDER BY l.created_at DESC LIMIT 8`, [req.workspace!.id]);
    res.json({ ...overview, recent });
  })
);
