export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let workspaceId: string | null = localStorage.getItem("cf.workspace");

export function setWorkspaceId(id: string | null) {
  workspaceId = id;
  try {
    if (id) localStorage.setItem("cf.workspace", id);
    else localStorage.removeItem("cf.workspace");
  } catch {
    /* storage unavailable */
  }
}
export function getWorkspaceId() {
  return workspaceId;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "commentflow" };
  if (workspaceId) headers["X-Workspace-Id"] = workspaceId;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? "GET",
    headers,
    credentials: "same-origin",
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const post = <T = any>(p: string, body?: unknown) => api<T>(p, { method: "POST", body: body ?? {} });
export const put = <T = any>(p: string, body: unknown) => api<T>(p, { method: "PUT", body });
export const patch = <T = any>(p: string, body: unknown) => api<T>(p, { method: "PATCH", body });
export const del = <T = any>(p: string) => api<T>(p, { method: "DELETE" });

export interface Workspace {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
}
export interface AppConfig {
  demoMode: boolean;
  allowRegistration: boolean;
  metaConfigured: boolean;
  appUrl: string;
}
export interface Account {
  id: string;
  ig_user_id: string;
  username: string;
  name: string | null;
  profile_picture_url: string | null;
  is_demo: boolean;
  webhook_subscribed: boolean;
  status: "active" | "token_expired" | "disconnected";
  status_detail: string | null;
  token_expires_at: string | null;
  connected_at: string;
  active_campaigns: number;
}
