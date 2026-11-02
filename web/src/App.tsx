import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { post } from "./api";
import { Logo } from "./components";
import { SessionProvider, useSession } from "./session";
import { LoginPage } from "./pages/Login";
import { OverviewPage } from "./pages/Overview";
import { CampaignsPage } from "./pages/Campaigns";
import { CampaignEditorPage } from "./pages/CampaignEditor";
import { CampaignDetailPage } from "./pages/CampaignDetail";
import { LogsPage } from "./pages/Logs";
import { AccountsPage } from "./pages/Accounts";
import { WorkspacePage } from "./pages/Workspace";
import { SimulatorPage } from "./pages/Simulator";
import { InvitePage } from "./pages/Invite";
import { LegalPage } from "./pages/Legal";

export function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/privacy" element={<LegalPage kind="privacy" />} />
        <Route path="/terms" element={<LegalPage kind="terms" />} />
        <Route path="/data-deletion" element={<LegalPage kind="data-deletion" />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/*" element={<Authed />} />
      </Routes>
    </SessionProvider>
  );
}

function Authed() {
  const { loading, user, workspaces, workspace, switchWorkspace, config } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  if (loading) return <div className="main muted">Loading…</div>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;

  const logout = async () => {
    await post("/auth/logout");
    window.location.href = "/login";
  };

  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">
          <Logo /> CommentFlow
        </div>
        {workspaces.length > 1 && (
          <select
            aria-label="Workspace"
            value={workspace?.id}
            onChange={(e) => {
              switchWorkspace(e.target.value);
              navigate("/");
            }}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
        <NavLink to="/" end>Overview</NavLink>
        <NavLink to="/campaigns">Campaigns</NavLink>
        <NavLink to="/logs">Message log</NavLink>
        <NavLink to="/accounts">Instagram accounts</NavLink>
        {config?.demoMode && <NavLink to="/simulator">Test simulator</NavLink>}
        <NavLink to="/workspace">Workspace</NavLink>
        <div className="spacer" />
        <div className="who">
          {user.email}
          <br />
          <button className="link" onClick={logout}>
            Sign out
          </button>
        </div>
      </nav>
      <div>
        {config?.demoMode && (
          <div className="demo-strip">
            Demo mode is on. Demo accounts never contact Instagram; messages they “send” appear in the simulator outbox.
          </div>
        )}
        <main className="main">
          {!workspace ? (
            <p>You are not a member of any workspace.</p>
          ) : (
            <Routes>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/campaigns" element={<CampaignsPage />} />
              <Route path="/campaigns/new" element={<CampaignEditorPage />} />
              <Route path="/campaigns/:id" element={<CampaignDetailPage />} />
              <Route path="/campaigns/:id/edit" element={<CampaignEditorPage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/accounts" element={<AccountsPage />} />
              <Route path="/simulator" element={<SimulatorPage />} />
              <Route path="/workspace" element={<WorkspacePage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
        </main>
      </div>
    </div>
  );
}
