import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, post, setWorkspaceId } from "../api";
import { Notice } from "../components";
import { useSession } from "../session";

export function InvitePage() {
  const { token } = useParams();
  const { user, loading, refresh } = useSession();
  const navigate = useNavigate();
  const [invite, setInvite] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api(`/invites/${token}`).then((r) => setInvite(r.invite), (e) => setError(e.message));
  }, [token]);

  const accept = async () => {
    try {
      const r = await post(`/invites/${token}/accept`);
      setWorkspaceId(r.workspaceId);
      await refresh();
      navigate("/");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const next = encodeURIComponent(`/invite/${token}`);
  return (
    <div className="legal">
      <h1>Join a workspace</h1>
      <Notice>{error}</Notice>
      {invite && !loading && (
        <div className="panel stack">
          <p>
            You’ve been invited to <b>{invite.workspace_name}</b> as {invite.role === "admin" ? "an admin" : "a member"}. The invite is for{" "}
            <b>{invite.email}</b>.
          </p>
          {user ? (
            <div><button className="primary" onClick={accept}>Join {invite.workspace_name}</button></div>
          ) : (
            <div className="row">
              <Link className="btn btn-primary" to={`/login?mode=register&email=${encodeURIComponent(invite.email)}&next=${next}`}>Create an account</Link>
              <Link className="btn" to={`/login?email=${encodeURIComponent(invite.email)}&next=${next}`}>Sign in</Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
