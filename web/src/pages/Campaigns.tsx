import { Link, useNavigate } from "react-router-dom";
import { Badge, Notice, pct } from "../components";
import { useLoad, useSession } from "../session";

function triggers(c: any) {
  const t = [];
  if (c.trigger_comments) t.push(c.post_scope === "any" ? "Comments on any post" : `Comments on ${c.post_ids.length} post${c.post_ids.length === 1 ? "" : "s"}`);
  if (c.trigger_dms) t.push("DMs");
  if (c.trigger_story_replies) t.push("Story replies");
  return t.join(", ");
}

export function CampaignsPage() {
  const { canEdit } = useSession();
  const navigate = useNavigate();
  const { data, error } = useLoad<{ campaigns: any[] }>("/campaigns");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Campaigns</h1>
          <p>Each campaign listens for keywords and replies with a DM, and optionally a public comment reply.</p>
        </div>
        {canEdit && <Link className="btn btn-primary" to="/campaigns/new">New campaign</Link>}
      </div>
      <Notice>{error}</Notice>
      {data && data.campaigns.length === 0 && (
        <div className="empty">
          <h2>No campaigns yet</h2>
          <p>Pick a post, choose a keyword like GUIDE, and write the DM people get when they comment it.</p>
          {canEdit && <Link className="btn btn-primary" to="/campaigns/new">Create your first campaign</Link>}
        </div>
      )}
      {data && data.campaigns.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Campaign</th><th>Keywords</th><th>Listens to</th><th>Status</th>
                <th className="num">Matches</th><th className="num">DMs sent</th><th className="num">Clicks</th><th className="num">CTR</th>
              </tr>
            </thead>
            <tbody>
              {data.campaigns.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/campaigns/${c.id}`)}>
                  <td>
                    <Link to={`/campaigns/${c.id}`} onClick={(e) => e.stopPropagation()}><b>{c.name}</b></Link>
                    <div className="muted">@{c.account_username}</div>
                  </td>
                  <td>{c.match_mode === "any_message" ? <span className="muted">Any message</span> : <span className="clip">{c.keywords.join(", ")}</span>}</td>
                  <td>{triggers(c)}</td>
                  <td>{c.account_status === "token_expired" ? <Badge status="token_expired" /> : <Badge status={c.status} />}</td>
                  <td className="num">{c.triggered}</td>
                  <td className="num">{c.sent}</td>
                  <td className="num">{c.unique_clicks}</td>
                  <td className="num">{pct(c.sent ? c.unique_clicks / c.sent : null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
