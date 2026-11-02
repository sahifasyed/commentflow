import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, del, post, type Account } from "../api";
import { Badge, Notice, fmtDate } from "../components";
import { useLoad, useSession } from "../session";

export function AccountsPage() {
  const { canEdit, config } = useSession();
  const [params, setParams] = useSearchParams();
  const { data, error, reload } = useLoad<{ accounts: Account[] }>("/accounts");
  const health = useLoad<any>("/health?soft=1");
  const [msg, setMsg] = useState<{ kind: "error" | "ok" | "warn"; text: string } | null>(
    params.get("error")
      ? { kind: "error", text: params.get("error")! }
      : params.get("connected")
        ? { kind: params.get("warning") ? "warn" : "ok", text: `Connected @${params.get("connected")}. ${params.get("warning") ?? ""}` }
        : null
  );
  const [demoName, setDemoName] = useState("demo.creator");

  const connect = async () => {
    try {
      const r = await api<{ url: string }>("/instagram/connect");
      window.location.href = r.url;
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  };
  const addDemo = async () => {
    try {
      await post("/accounts/demo", { username: demoName });
      setMsg({ kind: "ok", text: `Added demo account @${demoName}.` });
      reload();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  };
  const resubscribe = async (a: Account) => {
    try {
      const r = await post(`/accounts/${a.id}/resubscribe`);
      setMsg({ kind: r.subscribed ? "ok" : "warn", text: r.subscribed ? `@${a.username} is subscribed to comments and messages.` : "Meta did not confirm the subscription." });
      reload();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  };
  const disconnect = async (a: Account) => {
    if (!confirm(`Disconnect @${a.username}? Its token is deleted and its campaigns are paused.`)) return;
    await del(`/accounts/${a.id}`);
    reload();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Instagram accounts</h1>
          <p>Connect Instagram Business or Creator accounts through Meta’s official login. CommentFlow never asks for your Instagram password.</p>
        </div>
        {canEdit && (
          <button className="primary" onClick={connect} disabled={!config?.metaConfigured} title={config?.metaConfigured ? "" : "Meta app not configured"}>
            Connect Instagram
          </button>
        )}
      </div>
      {msg && (
        <div style={{ marginBottom: 16 }}>
          <Notice kind={msg.kind}>{msg.text}</Notice>
        </div>
      )}
      {params.toString() && (
        <p style={{ marginTop: -8, marginBottom: 12 }}>
          <button className="link" onClick={() => { setParams({}); setMsg(null); }}>Dismiss</button>
        </p>
      )}
      <Notice>{error}</Notice>
      {!config?.metaConfigured && (
        <div style={{ marginBottom: 16 }}>
          <Notice kind="warn">
            Real Instagram connections are off because the Meta app isn’t configured. Set INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET and
            WEBHOOK_VERIFY_TOKEN, then restart. See docs/META_SETUP.md.
          </Notice>
        </div>
      )}

      {data && data.accounts.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table>
            <thead>
              <tr><th>Account</th><th>Status</th><th>Webhooks</th><th>Token expires</th><th className="num">Active campaigns</th><th></th></tr>
            </thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <b>@{a.username}</b> {a.is_demo && <span className="badge info">Demo</span>}
                    <div className="muted mono">{a.ig_user_id}</div>
                  </td>
                  <td>
                    <Badge status={a.status} />
                    {a.status_detail && <div className="muted" style={{ fontSize: "0.8rem", maxWidth: 260 }}>{a.status_detail}</div>}
                  </td>
                  <td>{a.webhook_subscribed ? <span className="badge good">✓ Subscribed</span> : <span className="badge warn">! Not subscribed</span>}</td>
                  <td className="muted">{a.is_demo ? "—" : fmtDate(a.token_expires_at)}</td>
                  <td className="num">{a.active_campaigns}</td>
                  <td>
                    {canEdit && (
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        {a.status === "token_expired" && <button className="small primary" onClick={connect}>Reconnect</button>}
                        {!a.is_demo && a.status === "active" && <button className="small" onClick={() => resubscribe(a)}>Resubscribe webhooks</button>}
                        <button className="small danger" onClick={() => disconnect(a)}>{a.is_demo ? "Remove" : "Disconnect"}</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.accounts.length === 0 && (
        <div className="empty" style={{ marginBottom: 16 }}>
          <h2>No accounts connected</h2>
          <p>
            {config?.metaConfigured
              ? "Click Connect Instagram and approve the requested permissions. Your account must be a Business or Creator account."
              : "Add a demo account below to try everything without credentials."}
          </p>
        </div>
      )}

      {config?.demoMode && canEdit && (
        <div className="panel">
          <h2>Add a demo account</h2>
          <p className="sub">Demo accounts never contact Instagram. Use the test simulator to send fake comments, DMs and Story replies.</p>
          <div className="row">
            <input type="text" aria-label="Demo username" value={demoName} onChange={(e) => setDemoName(e.target.value)} style={{ width: 240 }} />
            <button onClick={addDemo}>Add demo account</button>
          </div>
        </div>
      )}

      {health.data && (
        <div className="panel">
          <h2>System status</h2>
          <table>
            <tbody>
              <tr><td>Database</td><td>{health.data.database?.ok ? "✓ OK" : "✕ Down"}</td></tr>
              <tr><td>Redis queue</td><td>{health.data.redis?.ok ? "✓ OK" : "✕ Down"}</td></tr>
              <tr>
                <td>Background worker</td>
                <td>{health.data.worker?.healthy ? "✓ Running" : "✕ Not running — messages won’t send. Start it with npm run start:worker (or the worker container)."}</td>
              </tr>
              <tr><td>Last webhook received</td><td>{health.data.lastWebhookAt ? fmtDate(health.data.lastWebhookAt) : "Never"}</td></tr>
              <tr><td>Webhook URL for Meta</td><td className="mono">{config?.appUrl}/api/webhook</td></tr>
              <tr><td>OAuth redirect URI</td><td className="mono">{config?.appUrl}/api/instagram/callback</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
