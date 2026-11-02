import { Fragment, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, getWorkspaceId } from "../api";
import { Badge, KIND_LABEL, Notice, SKIP_LABEL, fmtDate } from "../components";
import { useLoad, useSession } from "../session";

export function LogsPage() {
  const { workspace } = useSession();
  const [params, setParams] = useSearchParams();
  const campaigns = useLoad<{ campaigns: any[] }>("/campaigns");
  const [rows, setRows] = useState<any[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState(params.get("q") ?? "");

  const filters = Object.fromEntries(["campaignId", "status", "kind", "q"].map((k) => [k, params.get(k) ?? ""]).filter(([, v]) => v));
  const qs = new URLSearchParams(filters).toString();

  const load = async (before?: string) => {
    try {
      const p = new URLSearchParams({ ...filters, limit: "50", ...(before ? { before } : {}) });
      const r = await api<{ logs: any[]; hasMore: boolean }>(`/logs?${p}`);
      setRows((prev) => (before ? [...prev, ...r.logs] : r.logs));
      setHasMore(r.hasMore);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000); // live-ish refresh
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs, workspace?.id]);

  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const exportUrl = `/api/logs/export.csv?${new URLSearchParams({ ...filters, ws: getWorkspaceId() ?? "" })}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Message log</h1>
          <p>Every keyword match, what was sent, and why anything was skipped or failed. Refreshes every 10 seconds.</p>
        </div>
        <a className="btn" href={exportUrl}>Export CSV</a>
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <select aria-label="Campaign" style={{ width: "auto" }} value={params.get("campaignId") ?? ""} onChange={(e) => setFilter("campaignId", e.target.value)}>
          <option value="">All campaigns</option>
          {campaigns.data?.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select aria-label="Status" style={{ width: "auto" }} value={params.get("status") ?? ""} onChange={(e) => setFilter("status", e.target.value)}>
          <option value="">Any status</option>
          <option value="sent">Sent</option>
          <option value="pending">Queued</option>
          <option value="failed">Failed</option>
          <option value="unconfirmed">Unconfirmed</option>
          <option value="skipped">Skipped</option>
        </select>
        <select aria-label="Trigger" style={{ width: "auto" }} value={params.get("kind") ?? ""} onChange={(e) => setFilter("kind", e.target.value)}>
          <option value="">Any trigger</option>
          <option value="comment">Comments</option>
          <option value="dm">DMs</option>
          <option value="story_reply">Story replies</option>
        </select>
        <form onSubmit={(e) => { e.preventDefault(); setFilter("q", q.trim()); }} className="row">
          <input type="text" aria-label="Search" placeholder="Search text or @username" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
          <button>Search</button>
        </form>
      </div>
      <Notice>{error}</Notice>
      {rows.length === 0 && !error ? (
        <div className="empty">
          <h2>No messages match</h2>
          <p>When a comment, DM or story reply matches an active campaign, it appears here with its delivery status.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>When</th><th>From</th><th>Trigger</th><th>Campaign</th><th>DM</th><th>Public reply</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <Fragment key={l.id}>
                  <tr className="clickable" onClick={() => setOpen(open === l.id ? null : l.id)}>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>{fmtDate(l.created_at)}</td>
                    <td>{l.recipient_username ? `@${l.recipient_username}` : <span className="muted mono">{l.recipient_id.slice(0, 12)}</span>}</td>
                    <td><span className="muted">{KIND_LABEL[l.trigger_kind]}:</span> <span className="clip" style={{ display: "inline-block", verticalAlign: "bottom" }}>{l.trigger_text}</span></td>
                    <td>{l.campaign_name}</td>
                    <td>
                      <Badge status={l.dm_status} />
                      {l.skip_reason && <div className="muted" style={{ fontSize: "0.8rem" }}>{SKIP_LABEL[l.skip_reason] ?? l.skip_reason}</div>}
                    </td>
                    <td>{l.public_reply_status === "none" ? <span className="muted">—</span> : <Badge status={l.public_reply_status} />}</td>
                    <td><button className="link small" aria-expanded={open === l.id}>{open === l.id ? "Hide" : "Details"}</button></td>
                  </tr>
                  {open === l.id && (
                    <tr>
                      <td colSpan={7} style={{ background: "#f8faf8" }}>
                        <div className="grid-2">
                          <div className="stack" style={{ gap: 8 }}>
                            <div><b>Trigger text</b><div>{l.trigger_text}</div></div>
                            <div><b>Matched keyword</b><div>{l.matched_keyword ?? "(any message)"}</div></div>
                            <div><b>Account</b><div>@{l.account_username}{l.media_id ? <span className="muted"> · media {l.media_id}</span> : null}</div></div>
                            <div><b>Attempts</b><div>{l.attempts}{l.sent_at ? ` · sent ${fmtDate(l.sent_at)}` : ""}</div></div>
                          </div>
                          <div className="stack" style={{ gap: 8 }}>
                            {l.dm_text && <div><b>DM sent</b><pre style={{ whiteSpace: "pre-wrap" }}>{l.dm_text}</pre></div>}
                            {l.error && <div><b>{l.dm_status === "skipped" ? "Reason" : "Error"}</b><div className="mono" style={{ wordBreak: "break-word" }}>{l.error}</div></div>}
                            {l.public_reply_text && <div><b>Public reply</b><div>{l.public_reply_text}</div></div>}
                            {l.public_reply_error && <div><b>Public reply error</b><div className="mono">{l.public_reply_error}</div></div>}
                            {l.dm_status === "unconfirmed" && (
                              <Notice kind="warn">Instagram’s response was ambiguous, so this was not retried to avoid a duplicate DM. Check the inbox before contacting this person again.</Notice>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasMore && (
        <div style={{ marginTop: 12 }}>
          <button onClick={() => load(rows[rows.length - 1]?.created_at)}>Load older</button>
        </div>
      )}
    </>
  );
}
