import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { del, patch } from "../api";
import { Badge, DailyBars, Notice, SKIP_LABEL, pct } from "../components";
import { useLoad, useSession } from "../session";

export function CampaignDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit } = useSession();
  const [days, setDays] = useState(14);
  const c = useLoad<{ campaign: any }>(`/campaigns/${id}`);
  const a = useLoad<any>(`/campaigns/${id}/analytics?days=${days}`, [days]);
  const [error, setError] = useState<string | null>(null);
  const campaign = c.data?.campaign;
  const t = a.data?.totals;

  const toggle = async () => {
    try {
      await patch(`/campaigns/${id}/status`, { status: campaign.status === "active" ? "paused" : "active" });
      c.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete “${campaign.name}”? Its message log and click stats are deleted too.`)) return;
    await del(`/campaigns/${id}`);
    navigate("/campaigns");
  };

  if (c.error) return <Notice>{c.error}</Notice>;
  if (!campaign) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row" style={{ gap: 12 }}>
            <h1>{campaign.name}</h1>
            <Badge status={campaign.status} />
          </div>
          <p>
            {campaign.match_mode === "any_message" ? "Replies to any message" : `Keywords: ${campaign.keywords.join(", ")}`}
          </p>
        </div>
        <div className="row">
          <select aria-label="Date range" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: "auto" }}>
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <Link className="btn" to={`/logs?campaignId=${id}`}>View log</Link>
          {canEdit && (
            <>
              <button onClick={toggle}>{campaign.status === "active" ? "Pause" : "Resume"}</button>
              <Link className="btn btn-primary" to={`/campaigns/${id}/edit`}>Edit</Link>
            </>
          )}
        </div>
      </div>
      <Notice>{error}</Notice>

      {t && (
        <div className="stats">
          <div className="stat"><div className="v">{t.triggered}</div><div className="k">Matches</div></div>
          <div className="stat"><div className="v">{t.sent}</div><div className="k">DMs sent</div></div>
          <div className="stat"><div className="v">{t.unique_recipients}</div><div className="k">People reached</div></div>
          <div className="stat"><div className="v">{t.public_replies}</div><div className="k">Public replies</div></div>
          <div className="stat"><div className="v">{t.unique_clicks}</div><div className="k">Unique clicks</div></div>
          <div className="stat"><div className="v">{pct(t.ctr)}</div><div className="k">CTR (unique clicks / sent)</div></div>
        </div>
      )}

      {a.data && (
        <div className="grid-2">
          <div className="panel">
            <DailyBars title="DMs sent per day" unit="sent" color="var(--data-sent)" data={a.data.daily.map((d: any) => ({ day: d.day, value: d.sent }))} />
          </div>
          <div className="panel">
            <DailyBars title="Link clicks per day" unit="clicks" color="var(--data-clicks)" data={a.data.daily.map((d: any) => ({ day: d.day, value: d.clicks }))} />
          </div>
        </div>
      )}

      {a.data && (
        <div className="grid-2" style={{ marginTop: 16 }}>
          <div className="panel">
            <h2>Tracked links</h2>
            <p className="sub">Clicks are counted once per recipient for “unique”. Link-preview bots are ignored.</p>
            {a.data.links.length === 0 ? (
              <p className="muted">This campaign sends no links.</p>
            ) : (
              <table>
                <thead><tr><th>Button</th><th>Destination</th><th className="num">Clicks</th><th className="num">Unique</th></tr></thead>
                <tbody>
                  {a.data.links.map((l: any) => (
                    <tr key={l.id}>
                      <td>{l.button_label || "Open link"}</td>
                      <td><a className="clip" style={{ display: "inline-block" }} href={l.destination_url} target="_blank" rel="noreferrer">{l.destination_url}</a></td>
                      <td className="num">{l.clicks}</td>
                      <td className="num">{l.unique_clicks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="panel">
            <h2>Outcomes</h2>
            <p className="sub">Why messages did or didn’t go out.</p>
            <table>
              <tbody>
                <tr><td>Sent</td><td className="num">{t.sent}</td></tr>
                <tr><td>Queued or sending</td><td className="num">{t.pending}</td></tr>
                <tr><td>Failed</td><td className="num">{t.failed}</td></tr>
                <tr><td>Unconfirmed (check inbox)</td><td className="num">{t.unconfirmed}</td></tr>
                {a.data.skipReasons.map((s: any) => (
                  <tr key={s.skip_reason}><td className="muted">Skipped: {SKIP_LABEL[s.skip_reason] ?? s.skip_reason}</td><td className="num">{s.n}</td></tr>
                ))}
                {a.data.byTrigger.map((b: any) => (
                  <tr key={b.trigger_kind}><td className="muted">From {({ comment: "comments", dm: "DMs", story_reply: "Story replies" } as Record<string, string>)[b.trigger_kind] ?? b.trigger_kind} (sent / matched)</td><td className="num">{b.sent} / {b.triggered}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {canEdit && (
        <div style={{ marginTop: 28 }}>
          <button className="danger" onClick={remove}>Delete campaign</button>
        </div>
      )}
    </>
  );
}
