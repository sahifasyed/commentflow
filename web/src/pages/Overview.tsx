import { Link } from "react-router-dom";
import { Badge, DailyBars, KIND_LABEL, Notice, fmtDate, pct } from "../components";
import { useLoad, useSession } from "../session";

export function OverviewPage() {
  const { workspace } = useSession();
  const { data, error } = useLoad<any>("/overview?days=14");
  const t = data?.totals;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{workspace?.name}</h1>
          <p>Last 14 days across every campaign in this workspace.</p>
        </div>
        <Link className="btn btn-primary" to="/campaigns/new">
          New campaign
        </Link>
      </div>
      <Notice>{error}</Notice>
      {t && t.accounts === 0 && (
        <div className="empty" style={{ marginBottom: 16 }}>
          <h2>Connect an Instagram account to start</h2>
          <p>Campaigns run on an Instagram Business or Creator account. Connect one, then create a keyword campaign.</p>
          <Link className="btn btn-primary" to="/accounts">
            Connect an account
          </Link>
        </div>
      )}
      {t && (
        <div className="stats">
          <div className="stat"><div className="v">{t.triggered}</div><div className="k">Keyword matches</div></div>
          <div className="stat"><div className="v">{t.sent}</div><div className="k">DMs sent</div></div>
          <div className="stat"><div className="v">{t.public_replies}</div><div className="k">Public replies</div></div>
          <div className="stat"><div className="v">{t.unique_clicks}</div><div className="k">Unique link clicks</div></div>
          <div className="stat"><div className="v">{pct(t.ctr)}</div><div className="k">Click-through rate</div></div>
          <div className="stat"><div className="v">{t.failed + t.unconfirmed}</div><div className="k">Need attention</div></div>
        </div>
      )}
      {data && (
        <div className="grid-2">
          <div className="panel">
            <DailyBars title="DMs sent per day" unit="sent" color="var(--data-sent)" data={data.daily.map((d: any) => ({ day: d.day, value: d.sent }))} />
          </div>
          <div className="panel">
            <DailyBars title="Link clicks per day" unit="clicks" color="var(--data-clicks)" data={data.daily.map((d: any) => ({ day: d.day, value: d.clicks }))} />
          </div>
        </div>
      )}
      {data && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="section-title">
            <h2>Latest activity</h2>
            <Link to="/logs">Open message log</Link>
          </div>
          {data.recent.length === 0 ? (
            <p className="muted">Nothing yet. When someone comments or messages a keyword, it shows up here.</p>
          ) : (
            <table>
              <thead>
                <tr><th>When</th><th>From</th><th>Trigger</th><th>Campaign</th><th>DM</th></tr>
              </thead>
              <tbody>
                {data.recent.map((l: any) => (
                  <tr key={l.id}>
                    <td className="muted">{fmtDate(l.created_at)}</td>
                    <td>{l.recipient_username ? `@${l.recipient_username}` : <span className="muted">{l.recipient_id.slice(0, 10)}…</span>}</td>
                    <td><span className="muted">{KIND_LABEL[l.trigger_kind]}:</span> <span className="clip">{l.trigger_text}</span></td>
                    <td>{l.campaign_name}</td>
                    <td><Badge status={l.dm_status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
