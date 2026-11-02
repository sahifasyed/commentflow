import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, api, getWorkspaceId, setWorkspaceId, type AppConfig, type Workspace } from "./api";

interface SessionState {
  loading: boolean;
  user: { id: string; email: string; name: string | null } | null;
  workspaces: Workspace[];
  workspace: Workspace | null;
  config: AppConfig | null;
  refresh: () => Promise<void>;
  switchWorkspace: (id: string) => void;
  canEdit: boolean;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<SessionState, "refresh" | "switchWorkspace" | "canEdit">>({
    loading: true,
    user: null,
    workspaces: [],
    workspace: null,
    config: null,
  });

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: SessionState["user"]; workspaces: Workspace[]; config: AppConfig }>("/auth/me");
      const current = me.workspaces.find((w) => w.id === getWorkspaceId()) ?? me.workspaces[0] ?? null;
      setWorkspaceId(current?.id ?? null);
      setState({ loading: false, user: me.user, workspaces: me.workspaces, workspace: current, config: me.config });
    } catch (e) {
      const config = await api<AppConfig>("/config").catch(() => null);
      if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      setState({ loading: false, user: null, workspaces: [], workspace: null, config });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const switchWorkspace = (id: string) => {
    setWorkspaceId(id);
    setState((s) => ({ ...s, workspace: s.workspaces.find((w) => w.id === id) ?? s.workspace }));
  };

  const canEdit = state.workspace?.role === "owner" || state.workspace?.role === "admin";
  return <Ctx.Provider value={{ ...state, refresh, switchWorkspace, canEdit }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside provider");
  return s;
}

/** Tiny data hook: reloads when deps (incl. workspace) change. */
export function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const { workspace } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setError(null);
    api<T>(path)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, workspace?.id, tick, ...deps]);
  return { data, error, reload: () => setTick((t) => t + 1), setData };
}
