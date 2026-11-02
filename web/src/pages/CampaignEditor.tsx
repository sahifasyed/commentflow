import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, post, put, type Account } from "../api";
import { Notice } from "../components";
import { useLoad, useSession } from "../session";

interface Form {
  name: string;
  igAccountId: string;
  status: "active" | "paused";
  triggerComments: boolean;
  triggerDms: boolean;
  triggerStoryReplies: boolean;
  postScope: "any" | "specific";
  postIds: string[];
  keywords: string[];
  matchMode: "whole_word" | "contains" | "any_message";
  dmMessage: string;
  links: { url: string; buttonLabel: string }[];
  publicReplyEnabled: boolean;
  publicReplies: string[];
  cooldownHours: number;
}

const BLANK: Form = {
  name: "",
  igAccountId: "",
  status: "active",
  triggerComments: true,
  triggerDms: false,
  triggerStoryReplies: false,
  postScope: "any",
  postIds: [],
  keywords: [],
  matchMode: "whole_word",
  dmMessage: "Hey {username}! Here’s the link you asked for 👇",
  links: [{ url: "", buttonLabel: "Open link" }],
  publicReplyEnabled: false,
  publicReplies: ["Sent you a DM {username} ✨"],
  cooldownHours: 0,
};

function fromCampaign(c: any): Form {
  return {
    name: c.name,
    igAccountId: c.ig_account_id,
    status: c.status,
    triggerComments: c.trigger_comments,
    triggerDms: c.trigger_dms,
    triggerStoryReplies: c.trigger_story_replies,
    postScope: c.post_scope,
    postIds: c.post_ids,
    keywords: c.keywords,
    matchMode: c.match_mode,
    dmMessage: c.dm_message,
    links: c.links.map((l: any) => ({ url: l.destination_url, buttonLabel: l.button_label ?? "" })),
    publicReplyEnabled: c.public_reply_enabled,
    publicReplies: c.public_replies.length ? c.public_replies : BLANK.publicReplies,
    cooldownHours: c.cooldown_hours,
  };
}

export function CampaignEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit } = useSession();
  const accounts = useLoad<{ accounts: Account[] }>("/accounts");
  const [form, setForm] = useState<Form>(BLANK);
  const [loaded, setLoaded] = useState(!id);
  const [kwDraft, setKwDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [media, setMedia] = useState<any[] | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!id) return;
    api(`/campaigns/${id}`).then((r) => {
      setForm(fromCampaign(r.campaign));
      setLoaded(true);
    }, (e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    if (!form.igAccountId && accounts.data?.accounts[0]) set("igAccountId", accounts.data.accounts[0].id);
  }, [accounts.data, form.igAccountId]);

  useEffect(() => {
    if (!form.igAccountId) return;
    setMedia(null);
    setMediaError(null);
    api(`/accounts/${form.igAccountId}/media`).then((r) => setMedia(r.media), (e) => setMediaError(e.message));
  }, [form.igAccountId]);

  const addKeyword = (raw: string) => {
    const parts = raw.split(",").map((k) => k.trim()).filter(Boolean);
    if (parts.length) set("keywords", [...new Set([...form.keywords, ...parts])].slice(0, 30));
    setKwDraft("");
  };
  const onKwKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addKeyword(kwDraft);
    } else if (e.key === "Backspace" && !kwDraft && form.keywords.length) {
      set("keywords", form.keywords.slice(0, -1));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const keywords = kwDraft.trim() ? [...new Set([...form.keywords, ...kwDraft.split(",").map((k) => k.trim()).filter(Boolean)])] : form.keywords;
    const body = {
      ...form,
      keywords,
      links: form.links.filter((l) => l.url.trim()).map((l) => ({ url: l.url.trim(), buttonLabel: l.buttonLabel.trim() })),
      publicReplies: form.publicReplies.map((r) => r.trim()).filter(Boolean),
    };
    try {
      const r = id ? await put(`/campaigns/${id}`, body) : await post("/campaigns", body);
      navigate(`/campaigns/${r.campaign.id}`);
    } catch (err) {
      setError((err as Error).message);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setBusy(false);
    }
  };

  const account = accounts.data?.accounts.find((a) => a.id === form.igAccountId);
  const bytes = useMemo(() => new TextEncoder().encode(form.dmMessage).length, [form.dmMessage]);

  if (!canEdit) return <Notice>You have view-only access to this workspace.</Notice>;
  if (accounts.data && accounts.data.accounts.length === 0) {
    return (
      <div className="empty">
        <h2>Connect an Instagram account first</h2>
        <p>Campaigns belong to a connected Instagram professional account.</p>
        <Link className="btn btn-primary" to="/accounts">Go to Instagram accounts</Link>
      </div>
    );
  }
  if (!loaded) return <p className="muted">Loading campaign…</p>;

  return (
    <form onSubmit={submit}>
      <div className="page-head">
        <div>
          <h1>{id ? "Edit campaign" : "New campaign"}</h1>
          <p>Choose what triggers it, what it listens for, and what people receive.</p>
        </div>
        <div className="row">
          <Link className="btn" to={id ? `/campaigns/${id}` : "/campaigns"}>Cancel</Link>
          <button className="primary" disabled={busy}>{busy ? "Saving…" : id ? "Save changes" : "Create campaign"}</button>
        </div>
      </div>
      <Notice>{error}</Notice>

      <div className="editor" style={{ marginTop: error ? 16 : 0 }}>
        <div className="stack">
          <section className="panel stack">
            <h2>Basics</h2>
            <div className="grid-2">
              <label className="field">
                Campaign name
                <input type="text" required maxLength={100} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Free guide giveaway" />
              </label>
              <label className="field">
                Instagram account
                <select value={form.igAccountId} onChange={(e) => set("igAccountId", e.target.value)}>
                  {accounts.data?.accounts.map((a) => (
                    <option key={a.id} value={a.id}>@{a.username}{a.is_demo ? " (demo)" : ""}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={form.status === "active"} onChange={(e) => set("status", e.target.checked ? "active" : "paused")} />
              <span>Active<small>Paused campaigns ignore new comments and messages.</small></span>
            </label>
          </section>

          <section className="panel stack">
            <div>
              <h2>Triggers</h2>
              <p className="sub" style={{ margin: 0 }}>Where the keyword can come from.</p>
            </div>
            <div className="trigger-set">
              <label className="check">
                <input type="checkbox" checked={form.triggerComments} onChange={(e) => set("triggerComments", e.target.checked)} />
                <span>Comments on posts and reels<small>Sends Instagram’s one-time private reply. Meta allows one per comment, within 7 days.</small></span>
              </label>
              <label className="check">
                <input type="checkbox" checked={form.triggerDms} onChange={(e) => set("triggerDms", e.target.checked)} />
                <span>Direct messages<small>Replies inside the 24-hour window after the person messages you.</small></span>
              </label>
              <label className="check">
                <input type="checkbox" checked={form.triggerStoryReplies} onChange={(e) => set("triggerStoryReplies", e.target.checked)} />
                <span>Story replies<small>For “Reply LINK to this story”. Same 24-hour window as DMs.</small></span>
              </label>
            </div>
            {form.triggerComments && (
              <div className="stack" style={{ gap: 10 }}>
                <div className="row">
                  <label className="check"><input type="radio" name="scope" checked={form.postScope === "any"} onChange={() => set("postScope", "any")} /> Any post or reel</label>
                  <label className="check"><input type="radio" name="scope" checked={form.postScope === "specific"} onChange={() => set("postScope", "specific")} /> Only selected posts</label>
                </div>
                {form.postScope === "specific" && (
                  <div>
                    {mediaError && <Notice>{mediaError}</Notice>}
                    {!media && !mediaError && <p className="muted">Loading posts…</p>}
                    {media && media.length === 0 && <p className="muted">This account has no posts yet.</p>}
                    {media && media.length > 0 && (
                      <div className="table-wrap" style={{ maxHeight: 280, overflowY: "auto" }}>
                        <table>
                          <tbody>
                            {media.map((m) => (
                              <tr key={m.id}>
                                <td style={{ width: 32 }}>
                                  <input
                                    type="checkbox"
                                    aria-label={`Select post ${m.caption ?? m.id}`}
                                    checked={form.postIds.includes(m.id)}
                                    onChange={(e) => set("postIds", e.target.checked ? [...form.postIds, m.id] : form.postIds.filter((p) => p !== m.id))}
                                  />
                                </td>
                                <td style={{ width: 56 }}>
                                  {m.thumbnail_url || (m.media_type === "IMAGE" && m.media_url) ? (
                                    <img src={m.thumbnail_url || m.media_url} alt="" width={44} height={44} style={{ objectFit: "cover", borderRadius: 6 }} />
                                  ) : (
                                    <div style={{ width: 44, height: 44, borderRadius: 6, background: "var(--bubble-in)" }} />
                                  )}
                                </td>
                                <td>
                                  <div className="clip">{m.caption || <span className="muted">No caption</span>}</div>
                                  <div className="muted" style={{ fontSize: "0.82rem" }}>
                                    {(m.media_product_type || m.media_type || "").toLowerCase()} · {m.timestamp ? new Date(m.timestamp).toLocaleDateString() : ""}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="panel stack">
            <h2>Keywords</h2>
            <div className="row">
              <label className="check"><input type="radio" name="mm" checked={form.matchMode === "whole_word"} onChange={() => set("matchMode", "whole_word")} /> Whole word</label>
              <label className="check"><input type="radio" name="mm" checked={form.matchMode === "contains"} onChange={() => set("matchMode", "contains")} /> Contains</label>
              <label className="check"><input type="radio" name="mm" checked={form.matchMode === "any_message"} onChange={() => set("matchMode", "any_message")} /> Any message</label>
            </div>
            {form.matchMode !== "any_message" ? (
              <label className="field">
                Keywords
                <div className="chips" style={{ marginBottom: 4 }}>
                  {form.keywords.map((k) => (
                    <span className="chip" key={k}>
                      {k}
                      <button type="button" aria-label={`Remove ${k}`} onClick={() => set("keywords", form.keywords.filter((x) => x !== k))}>×</button>
                    </span>
                  ))}
                </div>
                <input type="text" value={kwDraft} onChange={(e) => setKwDraft(e.target.value)} onKeyDown={onKwKey} onBlur={() => kwDraft && addKeyword(kwDraft)} placeholder="Type a keyword and press Enter" />
                <span className="hint">Case, emoji, punctuation and accents are ignored, so “guide!!” matches GUIDE.</span>
              </label>
            ) : (
              <Notice kind="warn">Every comment or message on the selected triggers gets a reply. Use this sparingly.</Notice>
            )}
          </section>

          <section className="panel stack">
            <h2>Direct message</h2>
            <label className="field">
              Message
              <textarea value={form.dmMessage} onChange={(e) => set("dmMessage", e.target.value)} />
              <span className="hint">
                Use {"{username}"} for their handle and {"{link}"} / {"{link2}"} for tracked links. {bytes}/850 bytes.
              </span>
            </label>
            <div className="stack" style={{ gap: 10 }}>
              <div className="section-title" style={{ margin: 0 }}>
                <h3>Link buttons</h3>
                {form.links.length < 2 && (
                  <button type="button" className="small" onClick={() => set("links", [...form.links, { url: "", buttonLabel: "" }])}>Add link</button>
                )}
              </div>
              <p className="hint">Each link becomes a tracked redirect, so clicks are counted. Leave empty to send text only.</p>
              {form.links.map((l, i) => (
                <div className="row" key={i} style={{ alignItems: "end" }}>
                  <label className="field" style={{ flex: 2, minWidth: 220 }}>
                    Link {i + 1} URL
                    <input type="url" value={l.url} placeholder="https://" onChange={(e) => set("links", form.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
                  </label>
                  <label className="field" style={{ flex: 1, minWidth: 140 }}>
                    Button label
                    <input type="text" maxLength={20} value={l.buttonLabel} placeholder="Open link" onChange={(e) => set("links", form.links.map((x, j) => (j === i ? { ...x, buttonLabel: e.target.value } : x)))} />
                  </label>
                  <button type="button" className="danger small" onClick={() => set("links", form.links.filter((_, j) => j !== i))}>Remove</button>
                </div>
              ))}
            </div>
            <label className="field" style={{ maxWidth: 260 }}>
              Cooldown per person (hours)
              <input type="number" min={0} max={720} value={form.cooldownHours} onChange={(e) => set("cooldownHours", Math.max(0, Number(e.target.value) || 0))} />
              <span className="hint">0 = send every time they trigger it.</span>
            </label>
          </section>

          {form.triggerComments && (
            <section className="panel stack">
              <label className="check">
                <input type="checkbox" checked={form.publicReplyEnabled} onChange={(e) => set("publicReplyEnabled", e.target.checked)} />
                <span>Also reply publicly under the comment<small>One reply is picked at random each time, so replies don’t look copy-pasted.</small></span>
              </label>
              {form.publicReplyEnabled && (
                <>
                  {form.publicReplies.map((r, i) => (
                    <div className="row" key={i}>
                      <input type="text" aria-label={`Public reply ${i + 1}`} value={r} onChange={(e) => set("publicReplies", form.publicReplies.map((x, j) => (j === i ? e.target.value : x)))} style={{ flex: 1 }} />
                      {form.publicReplies.length > 1 && (
                        <button type="button" className="danger small" onClick={() => set("publicReplies", form.publicReplies.filter((_, j) => j !== i))}>Remove</button>
                      )}
                    </div>
                  ))}
                  {form.publicReplies.length < 10 && (
                    <div><button type="button" className="small" onClick={() => set("publicReplies", [...form.publicReplies, ""])}>Add variation</button></div>
                  )}
                </>
              )}
            </section>
          )}
        </div>

        <aside className="preview" aria-label="Preview">
          <Preview form={form} accountName={account?.username ?? "your.account"} />
        </aside>
      </div>
    </form>
  );
}

function Preview({ form, accountName }: { form: Form; accountName: string }) {
  const who = "maya.makes";
  const kw = form.keywords[0] ?? "LINK";
  const fill = (t: string, withLinks: boolean) => {
    let s = t.replace(/\{username\}/gi, `@${who}`);
    if (withLinks) s = s.replace(/\{link\}/gi, "yourapp.com/r/x7Kq2").replace(/\{link2\}/gi, "yourapp.com/r/b9Tz1");
    else s = s.replace(/\s*\{link2?\}\s*/gi, " ");
    return s.trim();
  };
  const links = form.links.filter((l) => l.url.trim());
  const viaComment = form.triggerComments;
  return (
    <>
      <div className="phone">
        <div className="phone-bar">
          <div className="avatar them">M</div>
          {viaComment ? "Comments" : `@${accountName} · DM`}
        </div>
        <div className="convo">
          {viaComment ? (
            <>
              <div className="comment-line">
                <div className="avatar them">M</div>
                <div><b>{who}</b> {form.matchMode === "any_message" ? "love this!" : `${kw.toUpperCase()} please 🙏`}</div>
              </div>
              {form.publicReplyEnabled && form.publicReplies[0] && (
                <div className="comment-line reply">
                  <div className="avatar">{accountName[0]?.toUpperCase()}</div>
                  <div><b>{accountName}</b> {fill(form.publicReplies[0], false)}</div>
                </div>
              )}
              <div className="when">Private reply in their inbox</div>
            </>
          ) : (
            <div className="bubble in">{form.matchMode === "any_message" ? "hey!" : kw}</div>
          )}
          <div className="bubble out">
            {links.length ? fill(form.dmMessage, false) || "Here’s your link 👇" : fill(form.dmMessage, true)}
            {links.length > 0 && (
              <div className="btns">
                {links.map((l, i) => <span key={i}>{l.buttonLabel || "Open link"}</span>)}
              </div>
            )}
          </div>
        </div>
      </div>
      <p className="preview-note">Preview only. Instagram renders the final layout.</p>
    </>
  );
}
