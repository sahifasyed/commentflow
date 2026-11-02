import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { post, type Account } from "../api";
import { Notice, fmtDate } from "../components";
import { useLoad, useSession } from "../session";

const SCENARIOS: Record<string, string> = {
  normal: "Instagram accepts the message",
  rate_limit: "Instagram rate-limits the first try (retried with backoff)",
  template: "Instagram rejects link buttons (falls back to inline link)",
  reject: "Instagram permanently rejects the message",
  network: "Connection drops mid-send (marked unconfirmed, never re-sent)",
};

export function SimulatorPage() {
  const { config, canEdit } = useSession();
  const accounts = useLoad<{ accounts: Account[] }>("/accounts");
  const outbox = useLoad<{ outbox: any[] }>("/demo/outbox");
  const demoAccounts = accounts.data?.accounts.filter((a) => a.is_demo) ?? [];
  const [accountId, setAccountId] = useState("");
  const [kind, setKind] = useState<"comment" | "dm" | "story_reply">("comment");
  const [text, setText] = useState("GUIDE please!");
  const [username, setUsername] = useState("maya.makes");
  const [mediaId, setMediaId] = useState("demo_media_reel_1");
  const [scenario, setScenario] = useState("normal");
  const [ageHours, setAgeHours] = useState(0);
  const [repeat, setRepeat] = useState(1);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId && demoAccounts[0]) setAccountId(demoAccounts[0].id);
  }, [demoAccounts, accountId]);
  useEffect(() => {
    const t = setInterval(outbox.reload, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!config?.demoMode) return <Notice kind="warn">The simulator is only available when DEMO_MODE=true.</Notice>;

  const send = async () => {
    setError(null);
    try {
      setResult(await post("/demo/simulate", { accountId, kind, text, username, mediaId: mediaId || undefined, scenario, ageHours, repeat }));
      setTimeout(outbox.reload, 1500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Test simulator</h1>
          <p>
            Sends a Meta-shaped, signed webhook through the same endpoint, queue and worker as real traffic. Demo accounts record what they would
            have sent in the outbox below instead of calling Instagram.
          </p>
        </div>
      </div>
      {demoAccounts.length === 0 && accounts.data && (
        <div className="empty" style={{ marginBottom: 16 }}>
          <h2>Add a demo account first</h2>
          <p>The simulator only targets demo accounts, so it can never message real people.</p>
          <Link className="btn btn-primary" to="/accounts">Add a demo account</Link>
        </div>
      )}
      <Notice>{error}</Notice>
      {demoAccounts.length > 0 && (
        <div className="grid-2">
          <div className="panel stack">
            <h2>Send a test event</h2>
            <div className="grid-2">
              <label className="field">Demo account
                <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  {demoAccounts.map((a) => <option key={a.id} value={a.id}>@{a.username}</option>)}
                </select>
              </label>
              <label className="field">Event
                <select value={kind} onChange={(e) => setKind(e.target.value as any)}>
                  <option value="comment">Comment on a post</option>
                  <option value="dm">Direct message</option>
                  <option value="story_reply">Story reply</option>
                </select>
              </label>
            </div>
            <label className="field">Text<input type="text" value={text} onChange={(e) => setText(e.target.value)} /></label>
            <div className="grid-2">
              <label className="field">From username<input type="text" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
              <label className="field">{kind === "story_reply" ? "Story ID" : "Post ID"}
                <input type="text" value={mediaId} onChange={(e) => setMediaId(e.target.value)} disabled={kind === "dm"} />
              </label>
            </div>
            <label className="field">Instagram’s response
              <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
                {Object.entries(SCENARIOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <div className="grid-2">
              <label className="field">Event age (hours)
                <input type="number" min={0} max={720} value={ageHours} onChange={(e) => setAgeHours(Number(e.target.value) || 0)} />
                <span className="hint">Try 200 for a comment (over 7 days) or 30 for a DM (over 24 hours).</span>
              </label>
              <label className="field">Deliveries
                <select value={repeat} onChange={(e) => setRepeat(Number(e.target.value))}>
                  <option value={1}>Once</option>
                  <option value={2}>Twice (duplicate test)</option>
                  <option value={3}>Three times</option>
                </select>
              </label>
            </div>
            <div><button className="primary" onClick={send} disabled={!canEdit || !accountId}>Send test event</button></div>
            {result && (
              <Notice kind="ok">
                {result.deliveries.map((d: any, i: number) => (
                  <div key={i}>Delivery {i + 1}: {d.duplicate ? "ignored as a duplicate" : `${d.stored} event stored, ${d.enqueued} queued`}</div>
                ))}
                <div>Check the <Link to="/logs">message log</Link> to see what the worker did.</div>
              </Notice>
            )}
            {result && (
              <details className="raw"><summary>Webhook payload</summary><pre>{JSON.stringify(result.payload, null, 2)}</pre></details>
            )}
          </div>
          <div className="panel">
            <h2>Demo outbox</h2>
            <p className="sub">What demo accounts “sent”. Refreshes every 3 seconds.</p>
            {outbox.data?.outbox.length === 0 && <p className="muted">Nothing sent yet. Is the worker running?</p>}
            <div className="stack" style={{ gap: 10 }}>
              {outbox.data?.outbox.map((o) => (
                <div key={o.id} style={{ borderBottom: "1px solid var(--rule)", paddingBottom: 10 }}>
                  <div className="muted" style={{ fontSize: "0.8rem" }}>
                    {fmtDate(o.created_at)} · @{o.account_username} · {o.kind === "private_reply" ? "Private reply" : o.kind === "comment_reply" ? "Public comment reply" : "DM"}
                  </div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{o.body.text}</div>
                  {o.body.buttons?.map((b: any, i: number) => (
                    <div key={i} className="mono muted">[{b.title}] {b.url}</div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
