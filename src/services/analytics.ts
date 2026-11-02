import { query, one } from "../db/pool.js";

/** Unique clicks: one per recipient token, else per hashed IP, else per click. */
const UNIQUE_CLICK = "count(DISTINCT COALESCE(lc.recipient_hash, lc.ip_hash, lc.id::text))";

export async function campaignSummaries(workspaceId: string) {
  return query(
    `SELECT c.id, c.name, c.status, c.keywords, c.match_mode, c.trigger_comments, c.trigger_dms, c.trigger_story_replies,
            c.post_scope, c.post_ids, c.public_reply_enabled, c.created_at, c.updated_at, c.ig_account_id,
            a.username AS account_username, a.status AS account_status, a.is_demo AS account_is_demo,
            COALESCE(s.triggered, 0) AS triggered, COALESCE(s.sent, 0) AS sent, COALESCE(s.failed, 0) AS failed,
            COALESCE(k.clicks, 0) AS clicks, COALESCE(k.unique_clicks, 0) AS unique_clicks
       FROM campaigns c
       JOIN ig_accounts a ON a.id = c.ig_account_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS triggered,
                count(*) FILTER (WHERE dm_status = 'sent')::int AS sent,
                count(*) FILTER (WHERE dm_status = 'failed')::int AS failed
           FROM message_logs WHERE campaign_id = c.id) s ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS clicks, ${UNIQUE_CLICK}::int AS unique_clicks FROM link_clicks lc WHERE lc.campaign_id = c.id) k ON true
      WHERE c.workspace_id = $1
      ORDER BY c.created_at DESC`,
    [workspaceId]
  );
}

function dailySeries(scope: "campaign" | "workspace") {
  const col = scope === "campaign" ? "campaign_id" : "workspace_id";
  return `
    WITH days AS (
      SELECT generate_series(date_trunc('day', now() AT TIME ZONE 'UTC') - ($2::int - 1) * interval '1 day',
                             date_trunc('day', now() AT TIME ZONE 'UTC'), interval '1 day')::date AS day
    )
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
           COALESCE((SELECT count(*) FROM message_logs m WHERE m.${col} = $1 AND (m.created_at AT TIME ZONE 'UTC')::date = d.day), 0)::int AS triggered,
           COALESCE((SELECT count(*) FROM message_logs m WHERE m.${col} = $1 AND m.dm_status = 'sent' AND (m.sent_at AT TIME ZONE 'UTC')::date = d.day), 0)::int AS sent,
           COALESCE((SELECT count(*) FROM link_clicks lc WHERE lc.${col} = $1 AND (lc.created_at AT TIME ZONE 'UTC')::date = d.day), 0)::int AS clicks
      FROM days d ORDER BY d.day`;
}

async function totals(where: string, params: unknown[]) {
  const t = await one(
    `SELECT count(*)::int AS triggered,
            count(*) FILTER (WHERE dm_status = 'sent')::int AS sent,
            count(*) FILTER (WHERE dm_status = 'failed')::int AS failed,
            count(*) FILTER (WHERE dm_status = 'skipped')::int AS skipped,
            count(*) FILTER (WHERE dm_status = 'unconfirmed')::int AS unconfirmed,
            count(*) FILTER (WHERE dm_status IN ('pending','sending'))::int AS pending,
            count(*) FILTER (WHERE public_reply_status = 'sent')::int AS public_replies,
            count(DISTINCT recipient_id) FILTER (WHERE dm_status = 'sent')::int AS unique_recipients
       FROM message_logs WHERE ${where}`,
    params
  );
  return t!;
}

export async function campaignAnalytics(workspaceId: string, campaignId: string, days: number) {
  const t = await totals("workspace_id = $1 AND campaign_id = $2", [workspaceId, campaignId]);
  const clicks = await one<{ clicks: number; unique_clicks: number }>(
    `SELECT count(*)::int AS clicks, ${UNIQUE_CLICK}::int AS unique_clicks FROM link_clicks lc WHERE campaign_id = $1`,
    [campaignId]
  );
  const links = await query(
    `SELECT tl.id, tl.slug, tl.destination_url, tl.button_label, tl.position,
            count(lc.id)::int AS clicks, ${UNIQUE_CLICK}::int AS unique_clicks
       FROM tracked_links tl LEFT JOIN link_clicks lc ON lc.tracked_link_id = tl.id
      WHERE tl.campaign_id = $1 GROUP BY tl.id ORDER BY tl.position`,
    [campaignId]
  );
  const byTrigger = await query(
    `SELECT trigger_kind, count(*)::int AS triggered, count(*) FILTER (WHERE dm_status = 'sent')::int AS sent
       FROM message_logs WHERE campaign_id = $1 GROUP BY trigger_kind ORDER BY trigger_kind`,
    [campaignId]
  );
  const skipReasons = await query(
    `SELECT skip_reason, count(*)::int AS n FROM message_logs WHERE campaign_id = $1 AND skip_reason IS NOT NULL
      GROUP BY skip_reason ORDER BY n DESC`,
    [campaignId]
  );
  const keywords = await query(
    `SELECT COALESCE(matched_keyword, '(any message)') AS keyword, count(*)::int AS n FROM message_logs
      WHERE campaign_id = $1 GROUP BY 1 ORDER BY n DESC LIMIT 10`,
    [campaignId]
  );
  const daily = await query(dailySeries("campaign"), [campaignId, days]);
  const c = clicks ?? { clicks: 0, unique_clicks: 0 };
  return {
    totals: { ...t, ...c, ctr: t.sent > 0 ? c.unique_clicks / t.sent : null },
    links,
    byTrigger,
    skipReasons,
    keywords,
    daily,
  };
}

export async function workspaceOverview(workspaceId: string, days: number) {
  const t = await totals("workspace_id = $1", [workspaceId]);
  const clicks = await one<{ clicks: number; unique_clicks: number }>(
    `SELECT count(*)::int AS clicks, ${UNIQUE_CLICK}::int AS unique_clicks FROM link_clicks lc WHERE workspace_id = $1`,
    [workspaceId]
  );
  const counts = await one(
    `SELECT (SELECT count(*)::int FROM campaigns WHERE workspace_id = $1 AND status = 'active') AS active_campaigns,
            (SELECT count(*)::int FROM ig_accounts WHERE workspace_id = $1 AND status <> 'disconnected') AS accounts`,
    [workspaceId]
  );
  const daily = await query(dailySeries("workspace"), [workspaceId, days]);
  const c = clicks ?? { clicks: 0, unique_clicks: 0 };
  return { totals: { ...t, ...c, ...counts, ctr: t.sent > 0 ? c.unique_clicks / t.sent : null }, daily };
}
