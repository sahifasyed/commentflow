import { useState, type ReactNode } from "react";

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#3fb59c" />
      <path d="M8 10h16v9H15l-5 4v-4H8z" fill="#1b2420" />
    </svg>
  );
}

const STATUS: Record<string, { cls: string; icon: string; label: string }> = {
  sent: { cls: "good", icon: "✓", label: "Sent" },
  pending: { cls: "info", icon: "◷", label: "Queued" },
  sending: { cls: "info", icon: "◷", label: "Sending" },
  failed: { cls: "bad", icon: "✕", label: "Failed" },
  unconfirmed: { cls: "warn", icon: "?", label: "Unconfirmed" },
  skipped: { cls: "", icon: "–", label: "Skipped" },
  none: { cls: "", icon: "", label: "Off" },
  active: { cls: "good", icon: "●", label: "Active" },
  paused: { cls: "", icon: "❚❚", label: "Paused" },
  token_expired: { cls: "bad", icon: "!", label: "Reconnect needed" },
};

export function Badge({ status }: { status: string }) {
  const s = STATUS[status] ?? { cls: "", icon: "", label: status };
  return (
    <span className={`badge ${s.cls}`}>
      {s.icon && <span aria-hidden="true">{s.icon}</span>}
      {s.label}
    </span>
  );
}

export const KIND_LABEL: Record<string, string> = { comment: "Comment", dm: "DM", story_reply: "Story reply" };

export const SKIP_LABEL: Record<string, string> = {
  comment_too_old: "Comment older than 7 days",
  outside_messaging_window: "Outside 24-hour window",
  comment_already_replied: "Comment already got its private reply",
  cooldown: "Recipient in cooldown",
  rate_limited: "Hourly limit",
  account_inactive: "Account disconnected",
  max_attempts: "Max attempts",
  self_message: "Own message",
};

export function Notice({ kind = "error", children }: { kind?: "error" | "ok" | "warn"; children: ReactNode }) {
  if (!children) return null;
  return (
    <div className={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  const d = new Date(s);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function pct(v: number | null | undefined) {
  return v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`;
}

/** Single-series daily bar chart with hover tooltip and an accessible table. */
export function DailyBars({
  title,
  data,
  color,
  unit,
}: {
  title: string;
  data: { day: string; value: number }[];
  color: string;
  unit: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 520;
  const H = 150;
  const pad = { l: 28, r: 4, t: 8, b: 22 };
  const max = Math.max(1, ...data.map((d) => d.value));
  const nice = max <= 4 ? max : Math.ceil(max / 4) * 4;
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = iw / Math.max(1, data.length);
  const bw = Math.max(2, Math.min(28, slot - 2));
  const y = (v: number) => pad.t + ih - (v / nice) * ih;
  const ticks = nice <= 4 ? Array.from({ length: nice + 1 }, (_, i) => i) : [0, nice / 4, nice / 2, (3 * nice) / 4, nice];
  const total = data.reduce((a, d) => a + d.value, 0);
  const label = (day: string) => new Date(day + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const every = Math.ceil(data.length / 7);

  return (
    <div className="chart">
      <div className="chart-title">
        <h3>{title}</h3>
        <span className="total">
          {total.toLocaleString()} {unit}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${total} ${unit} over ${data.length} days`} onMouseLeave={() => setHover(null)}>
        <g className="grid">
          {ticks.map((t) => (
            <line key={t} x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} strokeWidth={t === 0 ? 1 : 0.5} />
          ))}
        </g>
        <g className="axis">
          {ticks.map((t) => (
            <text key={t} x={pad.l - 6} y={y(t) + 4} textAnchor="end">
              {Math.round(t)}
            </text>
          ))}
          {data.map((d, i) =>
            (data.length - 1 - i) % every === 0 ? (
              <text key={d.day} x={pad.l + slot * i + slot / 2} y={H - 6} textAnchor="middle">
                {label(d.day)}
              </text>
            ) : null
          )}
        </g>
        {data.map((d, i) => {
          const x = pad.l + slot * i + (slot - bw) / 2;
          const h = Math.max(0, pad.t + ih - y(d.value));
          const r = Math.min(4, bw / 2, h);
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${label(d.day)}: ${d.value} ${unit}`}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill="transparent" />
              {h > 0 && (
                <path
                  d={`M${x},${pad.t + ih} V${pad.t + ih - h + r} Q${x},${pad.t + ih - h} ${x + r},${pad.t + ih - h} H${x + bw - r} Q${x + bw},${pad.t + ih - h} ${x + bw},${pad.t + ih - h + r} V${pad.t + ih} Z`}
                  fill={color}
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && data[hover] && (
        <div className="tip" style={{ left: `${((pad.l + slot * hover + slot / 2) / W) * 100}%`, top: `${(y(data[hover].value) / H) * 100}%` }}>
          {label(data[hover].day)}: <b>{data[hover].value}</b> {unit}
        </div>
      )}
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{d.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
