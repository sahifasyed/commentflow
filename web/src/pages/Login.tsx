import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { post } from "../api";
import { Logo, Notice } from "../components";
import { useSession } from "../session";

export function LoginPage() {
  const { user, config, refresh } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">(params.get("mode") === "register" ? "register" : "login");
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get("next") || "/";

  if (user) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await post("/auth/login", { email, password });
      else await post("/auth/register", { email, password, name: name || undefined });
      await refresh();
      navigate(next, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <section className="auth-side">
        <div className="brand" style={{ padding: 0 }}>
          <Logo size={28} /> CommentFlow
        </div>
        <h1>Someone comments a keyword. They get your link in their DMs.</h1>
        <div className="flow" aria-hidden="true">
          <div className="bubble in">
            <b>@maya.makes</b> GUIDE please 🙏
          </div>
          <div className="bubble out">Hey @maya.makes! Here’s the free guide you asked for.</div>
        </div>
        <p style={{ maxWidth: "52ch", color: "#b9c6c0" }}>
          Self-hosted automation for Instagram professional accounts, using Meta’s official API. Your data and tokens stay on your server.
        </p>
      </section>
      <section className="auth-form">
        <form onSubmit={submit}>
          <h2>{mode === "login" ? "Sign in" : "Create your account"}</h2>
          <Notice>{error}</Notice>
          {mode === "register" && (
            <label className="field">
              Your name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </label>
          )}
          <label className="field">
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </label>
          <label className="field">
            Password
            <input
              type="password"
              required
              minLength={mode === "register" ? 10 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
            {mode === "register" && <span className="hint">At least 10 characters.</span>}
          </label>
          <button className="primary" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
          {(config?.allowRegistration || mode === "register") && (
            <p className="muted">
              {mode === "login" ? "New here? " : "Already have an account? "}
              <button type="button" className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
                {mode === "login" ? "Create an account" : "Sign in"}
              </button>
            </p>
          )}
          <p className="muted" style={{ fontSize: "0.82rem" }}>
            <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
          </p>
        </form>
      </section>
    </div>
  );
}
