import { useState } from "react";
import { del, patch, post } from "../api";
import { Notice, fmtDate } from "../components";
import { useLoad, useSession } from "../session";

export function WorkspacePage() {
  const { workspace, user, refresh, switchWorkspace } = useSession();
  const { data, reload } = useLoad<any>("/workspace/members");
  const [name, setName] = useState(workspace?.name ?? "");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [link, setLink] = useState<string | null>(null);
  const [newWs, setNewWs] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const isAdmin = workspace?.role !== "member";
  const isOwner = workspace?.role === "owner";

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) setMsg({ kind: "ok", text: ok });
      reload();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Workspace</h1>
          <p>Workspaces keep accounts, campaigns and logs separate, for example one per client.</p>
        </div>
      </div>
      {msg && <div style={{ marginBottom: 16 }}><Notice kind={msg.kind}>{msg.text}</Notice></div>}

      <div className="grid-2">
        <div className="panel stack">
          <h2>Settings</h2>
          <label className="field">
            Workspace name
            <input type="text" value={name} disabled={!isAdmin} onChange={(e) => setName(e.target.value)} />
          </label>
          {isAdmin && (
            <div><button onClick={() => run(async () => { await patch("/workspace", { name }); await refresh(); }, "Workspace renamed.")}>Save name</button></div>
          )}
          <p className="muted">Your role here: <b>{workspace?.role}</b></p>
        </div>
        <div className="panel stack">
          <h2>New workspace</h2>
          <label className="field">
            Name
            <input type="text" value={newWs} onChange={(e) => setNewWs(e.target.value)} placeholder="Client name" />
          </label>
          <div>
            <button
              disabled={!newWs.trim()}
              onClick={() =>
                run(async () => {
                  const r = await post("/workspaces", { name: newWs.trim() });
                  await refresh();
                  switchWorkspace(r.workspace.id);
                  setNewWs("");
                }, "Workspace created and selected.")
              }
            >
              Create workspace
            </button>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h2>Members</h2>
        <p className="sub">Owners manage members and roles. Admins manage accounts and campaigns. Members can view everything.</p>
        <table>
          <thead><tr><th>Person</th><th>Role</th><th>Joined</th><th></th></tr></thead>
          <tbody>
            {data?.members.map((m: any) => (
              <tr key={m.id}>
                <td>{m.name ?? m.email}<div className="muted">{m.email}</div></td>
                <td>
                  {isOwner ? (
                    <select aria-label={`Role for ${m.email}`} value={m.role} style={{ width: "auto" }} onChange={(e) => run(() => patch(`/workspace/members/${m.id}`, { role: e.target.value }), "Role updated.")}>
                      <option value="owner">Owner</option>
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                    </select>
                  ) : (
                    m.role
                  )}
                </td>
                <td className="muted">{fmtDate(m.created_at)}</td>
                <td>
                  {(isAdmin || m.id === user?.id) && (
                    <button className="small danger" onClick={() => confirm(m.id === user?.id ? "Leave this workspace?" : `Remove ${m.email}?`) && run(async () => { await del(`/workspace/members/${m.id}`); if (m.id === user?.id) window.location.href = "/"; }, "Member removed.")}>
                      {m.id === user?.id ? "Leave" : "Remove"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <div className="panel">
          <h2>Invite someone</h2>
          <p className="sub">Creates a link valid for 7 days. Send it to them yourself; they sign up or sign in with that email to join.</p>
          <div className="row">
            <input type="email" aria-label="Invite email" placeholder="teammate@example.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: 280 }} />
            <select aria-label="Invite role" value={role} onChange={(e) => setRole(e.target.value)} style={{ width: "auto" }}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button className="primary" disabled={!email} onClick={() => run(async () => { const r = await post("/workspace/invites", { email, role }); setLink(r.link); setEmail(""); })}>
              Create invite link
            </button>
          </div>
          {link && (
            <div style={{ marginTop: 12 }}>
              <Notice kind="ok">
                Invite link (shown once): <span className="mono" style={{ wordBreak: "break-all" }}>{link}</span>{" "}
                <button className="link" onClick={() => navigator.clipboard?.writeText(link)}>Copy</button>
              </Notice>
            </div>
          )}
          {data?.invites.length > 0 && (
            <table style={{ marginTop: 14 }}>
              <thead><tr><th>Pending invite</th><th>Role</th><th>Expires</th><th></th></tr></thead>
              <tbody>
                {data.invites.map((i: any) => (
                  <tr key={i.id}>
                    <td>{i.email}</td><td>{i.role}</td><td className="muted">{fmtDate(i.expires_at)}</td>
                    <td><button className="small danger" onClick={() => run(() => del(`/workspace/invites/${i.id}`), "Invite revoked.")}>Revoke</button></td>
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
