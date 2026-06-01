"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { Lightbox } from "@/components/Lightbox";
import { useLocale } from "@/lib/i18n";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MastodonField {
  name: string;
  value: string;
  verified_at: string | null;
}

interface Account {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  note: string;
  avatar: string;
  header: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  locked: boolean;
  bot: boolean;
  url: string;
  created_at: string;
  fields?: MastodonField[];
}

interface PollOption { title: string; votes_count: number | null }
interface Poll {
  id: string;
  expires_at: string | null;
  expired: boolean;
  multiple: boolean;
  votes_count: number;
  voters_count: number;
  voted: boolean;
  own_votes: number[];
  options: PollOption[];
}

interface MediaAttachment {
  id: string;
  type: string;
  url: string;
  preview_url: string | null;
  description: string | null;
}

interface Status {
  id: string;
  content: string;
  created_at: string;
  account: Account;
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  favourited: boolean;
  reblogged: boolean;
  sensitive: boolean;
  spoiler_text: string;
  media_attachments: MediaAttachment[];
  poll: Poll | null;
}

interface Relationship {
  id: string;
  following: boolean;
  requested: boolean;
  blocking: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return d.toLocaleDateString();
}

function AvatarImg({ account, size = 42 }: { account: Account; size?: number }) {
  const [err, setErr] = useState(false);
  const fallback = (account.display_name?.[0] ?? account.username?.[0] ?? "?").toUpperCase();
  if (!err && account.avatar && !account.avatar.endsWith("/default-avatar.png")) {
    return (
      <img src={account.avatar} alt={account.display_name} width={size} height={size}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
        onError={() => setErr(true)} />
    );
  }
  return (
    <div style={{
      width: size, height: size, flexShrink: 0, borderRadius: "50%",
      background: "var(--accent-bg)", display: "flex", alignItems: "center",
      justifyContent: "center", fontSize: size * 0.4, fontWeight: 700, color: "var(--accent)",
    }}>
      {fallback}
    </div>
  );
}

function MediaGrid({ attachments }: { attachments: MediaAttachment[] }) {
  const [lbIdx, setLbIdx] = useState<number | null>(null);
  if (!attachments.length) return null;
  const gridCols = attachments.length === 1 ? 1 : 2;
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${gridCols}, 1fr)`, gap: "0.25rem", marginTop: "0.75rem", borderRadius: "var(--radius)", overflow: "hidden" }}>
        {attachments.map((att, i) =>
          att.type === "image" || att.type === "gifv" ? (
            <button key={att.id} type="button" onClick={() => setLbIdx(i)}
              title={att.description ?? undefined}
              style={{ display: "block", aspectRatio: attachments.length === 1 ? "16/9" : "1/1", overflow: "hidden", border: "none", padding: 0, cursor: "zoom-in", background: "none" }}>
              <img src={att.preview_url ?? att.url} alt={att.description ?? ""} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            </button>
          ) : att.type === "video" ? (
            <button key={att.id} type="button" onClick={() => setLbIdx(i)}
              style={{ display: "block", aspectRatio: "16/9", overflow: "hidden", border: "none", padding: 0, cursor: "pointer", background: "var(--bg-elevated)", position: "relative" }}>
              <video src={att.url} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "2rem" }}>▶</div>
            </button>
          ) : att.type === "audio" ? (
            <button key={att.id} type="button" onClick={() => setLbIdx(i)}
              style={{ display: "block", aspectRatio: "3/1", overflow: "hidden", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 0, cursor: "pointer", background: "var(--bg-elevated)", position: "relative" }}>
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "2rem" }}>🎵</div>
            </button>
          ) : null
        )}
      </div>
      {lbIdx !== null && (
        <Lightbox
          media={attachments.map((a) => ({ url: a.url, preview_url: a.preview_url, description: a.description, type: a.type }))}
          index={lbIdx}
          onClose={() => setLbIdx(null)}
          onNav={setLbIdx}
        />
      )}
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

function AccountRow({ account }: { account: Account }) {
  const href = account.url?.startsWith("http") ? `/users/remote?url=${encodeURIComponent(account.url)}` : "#";
  return (
    <a href={href} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)", textDecoration: "none", color: "var(--text)" }}>
      <AvatarImg account={account} size={42} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: "0.9rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.display_name || account.username}</div>
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>@{account.acct}</div>
      </div>
    </a>
  );
}

function StatusCard({ s, token, onFav, onReblog }: { s: Status; token: string | null; onFav: () => void; onReblog: () => void }) {
  const [expandedCw, setExpandedCw] = useState(false);
  const [pollState, setPollState] = useState<Poll | null>(s.poll ?? null);
  const [voting, setVoting] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const isRemote = s.account.acct.includes("@");
  const profileHref = isRemote ? `/users/remote?url=${encodeURIComponent(s.account.id)}` : `/users/${s.account.username}`;
  const threadHref = `/statuses/${encodeURIComponent(s.id)}`;

  async function vote() {
    if (!token || !pollState || voting || selected.length === 0) return;
    setVoting(true);
    try {
      const res = await fetch(`/api/v1/polls/${pollState.id}/votes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ choices: selected }),
      });
      if (res.ok) setPollState((await res.json()) as Poll);
    } finally { setVoting(false); }
  }

  const poll = pollState;
  const showResults = poll ? (poll.voted || poll.expired) : false;
  const total = poll && poll.votes_count > 0 ? poll.votes_count : 1;

  return (
    <article style={{ display: "flex", gap: "0.875rem", padding: "1rem", borderBottom: "1px solid var(--border)" }}>
      <a href={profileHref} style={{ flexShrink: 0 }}>
        <AvatarImg account={s.account} size={42} />
      </a>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.4rem", marginBottom: "0.25rem", flexWrap: "wrap" }}>
          <a href={profileHref} style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)", textDecoration: "none" }}>{s.account.display_name || s.account.username}</a>
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>@{s.account.acct}</span>
          <a href={threadHref} style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginLeft: "auto", textDecoration: "none" }}>{formatTime(s.created_at)}</a>
        </div>
        {s.spoiler_text && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.375rem 0.625rem", background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)", fontSize: "0.875rem", marginBottom: "0.4rem", color: "var(--text-secondary)", gap: "0.5rem" }}>
            <span>⚠️ {s.spoiler_text}</span>
            <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem", whiteSpace: "nowrap", flexShrink: 0 }} onClick={() => setExpandedCw((v) => !v)}>
              {expandedCw ? "Ocultar" : "Mostrar"}
            </button>
          </div>
        )}
        {(!s.spoiler_text || expandedCw) && (
          <div style={{ fontSize: "0.95rem", lineHeight: 1.55, overflowWrap: "break-word", wordBreak: "break-word", minWidth: 0 }} dangerouslySetInnerHTML={{ __html: s.content }} />
        )}
        {(!s.spoiler_text || expandedCw) && <MediaGrid attachments={s.media_attachments ?? []} />}
        {(!s.spoiler_text || expandedCw) && poll && (
          <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {poll.options.map((opt, i) => {
              const pct = showResults && opt.votes_count != null ? Math.round((opt.votes_count / total) * 100) : 0;
              const isOwn = poll.own_votes.includes(i) || selected.includes(i);
              return (
                <div key={i}>
                  {showResults ? (
                    <div style={{ position: "relative", borderRadius: "var(--radius-sm)", overflow: "hidden", background: "var(--bg-elevated)", padding: "0.35rem 0.75rem" }}>
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: isOwn ? "var(--accent-bg)" : "color-mix(in srgb, var(--accent-bg) 40%, transparent)", transition: "width 0.4s" }} />
                      <div style={{ position: "relative", display: "flex", justifyContent: "space-between", fontSize: "0.875rem" }}>
                        <span style={{ fontWeight: isOwn ? 600 : 400 }}>{opt.title}{isOwn ? " ✓" : ""}</span>
                        <span style={{ color: "var(--text-muted)" }}>{pct}%</span>
                      </div>
                    </div>
                  ) : (
                    <button type="button" onClick={() => { if (poll.multiple) setSelected((p) => p.includes(i) ? p.filter((x) => x !== i) : [...p, i]); else setSelected([i]); }} style={{ width: "100%", textAlign: "left", padding: "0.35rem 0.75rem", border: `1.5px solid ${selected.includes(i) ? "var(--accent)" : "var(--border)"}`, borderRadius: "var(--radius-sm)", background: selected.includes(i) ? "var(--accent-bg)" : "transparent", cursor: "pointer", fontSize: "0.875rem", color: "var(--text)" }}>
                      {opt.title}
                    </button>
                  )}
                </div>
              );
            })}
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
              {!poll.voted && !poll.expired && token && (
                <button type="button" className="btn btn-primary btn-sm" disabled={selected.length === 0 || voting} onClick={() => void vote()}>
                  {voting ? "…" : "Votar"}
                </button>
              )}
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                {poll.votes_count} {poll.votes_count === 1 ? "voto" : "votos"}
                {poll.expires_at && (<> · {poll.expired ? "Cerrada" : `Cierra ${new Date(poll.expires_at).toLocaleDateString()}`}</>)}
                {poll.multiple && " · Opción múltiple"}
              </span>
            </div>
          </div>
        )}
        <div style={{ display: "flex", gap: "1rem", marginTop: "0.625rem", color: "var(--text-muted)", fontSize: "0.82rem" }}>
          <a href={threadHref} className="btn btn-ghost btn-sm" style={{ padding: "0.15rem 0.35rem", gap: "0.25rem", textDecoration: "none", color: "var(--text-muted)" }}>💬 {s.replies_count}</a>
          <button className="btn btn-ghost btn-sm" style={{ padding: "0.15rem 0.35rem", gap: "0.25rem", color: s.reblogged ? "var(--accent)" : "var(--text-muted)" }} onClick={onReblog}>🔁 {s.reblogs_count}</button>
          <button className="btn btn-ghost btn-sm" style={{ padding: "0.15rem 0.35rem", gap: "0.25rem", color: s.favourited ? "var(--danger)" : "var(--text-muted)" }} onClick={onFav}>{s.favourited ? "❤️" : "🤍"} {s.favourites_count}</button>
        </div>
      </div>
    </article>
  );
}

function RemoteProfileInner() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const actorUrl = searchParams.get("url");
  const { t } = useLocale();

  const [account, setAccount] = useState<Account | null>(null);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [followers, setFollowers] = useState<Account[]>([]);
  const [following, setFollowing] = useState<Account[]>([]);
  const [activeTab, setActiveTab] = useState<"posts" | "followers" | "following">("posts");
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [me, setMe] = useState<Account | null>(null);

  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;

  async function load(url: string) {
    setLoading(true);
    const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};

    const [acctRes, meRes] = await Promise.all([
      fetch(`/api/v1/accounts/${encodeURIComponent(url)}`),
      token ? fetch("/api/v1/accounts/verify_credentials", { headers }) : Promise.resolve(null),
    ]);

    if (!acctRes.ok) { setNotFound(true); setLoading(false); return; }
    const acct = await acctRes.json() as Account;
    setAccount(acct);

    if (meRes?.ok) {
      const meData = await meRes.json() as Account;
      setMe(meData);

      const relRes = await fetch(`/api/v1/accounts/relationships?id[]=${encodeURIComponent(acct.id)}`, { headers });
      if (relRes.ok) {
        const [rel] = await relRes.json() as Relationship[];
        setRelationship(rel ?? null);
      }
    }

    // Load cached statuses, followers and following in parallel
    const [statusRes, followersRes, followingRes] = await Promise.all([
      fetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/statuses?limit=20`, { headers }),
      fetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/followers?limit=40`, { headers }),
      fetch(`/api/v1/accounts/${encodeURIComponent(acct.id)}/following?limit=40`, { headers }),
    ]);
    if (statusRes.ok) setStatuses(await statusRes.json() as Status[]);
    if (followersRes.ok) setFollowers(await followersRes.json() as Account[]);
    if (followingRes.ok) setFollowing(await followingRes.json() as Account[]);

    setLoading(false);
  }

  useEffect(() => {
    if (!actorUrl) return;
    void load(actorUrl);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorUrl]);

  async function handleFollow() {
    if (!token || !account) return;
    setFollowBusy(true);
    try {
      const following = relationship?.following === true || relationship?.requested === true;
      const path = following ? "unfollow" : "follow";
      const res = await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json() as { following?: boolean; requested?: boolean };
        setRelationship((prev) => ({
          id: account.id,
          following: data.following ?? (prev?.following ?? false),
          requested: data.requested ?? (prev?.requested ?? false),
          blocking: prev?.blocking ?? false,
        }));
      }
    } catch {
      // silent
    } finally {
      setFollowBusy(false);
    }
  }

  async function handleBlock() {
    if (!token || !account) return;
    setBlockBusy(true);
    try {
      const blocking = relationship?.blocking === true;
      const path = blocking ? "unblock" : "block";
      const res = await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setRelationship((prev) => ({
          id: account.id,
          following: blocking ? (prev?.following ?? false) : false,
          requested: blocking ? (prev?.requested ?? false) : false,
          blocking: !blocking,
        }));
      }
    } catch {
      // silent
    } finally {
      setBlockBusy(false);
    }
  }

  async function toggleFavourite(status: Status) {
    if (!token) return;
    const path = status.favourited ? "unfavourite" : "favourite";
    const res = await fetch(`/api/v1/statuses/${status.id}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setStatuses((prev) => prev.map((s) =>
        s.id === status.id
          ? {
              ...s,
              favourited: !s.favourited,
              favourites_count: s.favourites_count + (s.favourited ? -1 : 1),
            }
          : s
      ));
    }
  }

  async function toggleReblog(status: Status) {
    if (!token) return;
    const path = status.reblogged ? "unreblog" : "reblog";
    const res = await fetch(`/api/v1/statuses/${status.id}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setStatuses((prev) => prev.map((s) =>
        s.id === status.id
          ? {
              ...s,
              reblogged: !s.reblogged,
              reblogs_count: s.reblogs_count + (s.reblogged ? -1 : 1),
            }
          : s
      ));
    }
  }

  if (loading && actorUrl) {
    return (
      <div style={{ display: "flex", minHeight: "100dvh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
        <Sidebar me={me} currentPath={pathname} />
        <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)", padding: "2rem" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div className="skeleton" style={{ height: 180, borderRadius: "var(--radius)" }} />
            <div className="skeleton" style={{ height: 24, width: "40%" }} />
            <div className="skeleton" style={{ height: 14, width: "60%" }} />
          </div>
        </main>
      </div>
    );
  }

  if (!actorUrl || notFound || !account) {
    return (
      <div style={{ display: "flex", minHeight: "100dvh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
        <Sidebar me={me} currentPath={pathname} />
        <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)", padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
          <span style={{ fontSize: "3rem" }}>🌐</span>
          <p style={{ marginTop: "1rem" }}>Cuenta no encontrada</p>
          <p style={{ fontSize: "0.875rem", marginTop: "0.5rem" }}>{actorUrl}</p>
        </main>
      </div>
    );
  }

  const isOwnAccount = me && me.id === account.id;
  const displayName = account.display_name || account.username;
  const isFollowing = relationship?.following === true;
  const isRequested = relationship?.requested === true;

  return (
    <div style={{ display: "flex", minHeight: "100dvh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath={pathname} />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)", overflowY: "auto" }}>
        {/* Header banner */}
        <div style={{
          height: 180, background: account.header ? `url(${account.header}) center/cover no-repeat` : "var(--accent-bg)",
          position: "relative",
        }}>
          {/* Remote badge */}
          <div style={{
            position: "absolute", top: "0.75rem", right: "0.75rem",
            background: "rgba(0,0,0,0.55)", color: "#fff",
            padding: "0.25rem 0.6rem", borderRadius: "var(--radius)",
            fontSize: "0.75rem", display: "flex", alignItems: "center", gap: "0.3rem",
          }}>
            🌐 Cuenta remota
          </div>
        </div>

        {/* Profile info */}
        <div style={{ padding: "0 1.25rem 1rem", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: "-38px", marginBottom: "0.75rem", position: "relative", zIndex: 1 }}>
            <div style={{ border: "3px solid var(--bg)", borderRadius: "50%", background: "var(--bg)" }}>
              <AvatarImg account={account} size={76} />
            </div>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              {/* View on original server */}
              <a href={account.url} target="_blank" rel="noopener noreferrer"
                className="btn btn-ghost btn-sm"
                style={{ display: "flex", alignItems: "center", gap: "0.3rem", textDecoration: "none" }}
                title="Ver en el servidor original">
                🌐 Ver original
              </a>
              {/* Follow / Unfollow / Block */}
              {token && !isOwnAccount && (
                <>
                  <button
                    className={isFollowing || isRequested ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm"}
                    onClick={() => void handleFollow()}
                    disabled={followBusy || relationship?.blocking === true}
                  >
                    {followBusy ? "…" : isFollowing ? t.account_following : isRequested ? t.account_requested : t.account_follow}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ border: "1px solid var(--border)", color: relationship?.blocking ? "var(--danger)" : "var(--text-muted)" }}
                    onClick={() => void handleBlock()}
                    disabled={blockBusy}
                    title={relationship?.blocking ? "Desbloquear" : "Bloquear"}
                  >
                    {blockBusy ? "…" : relationship?.blocking ? "🚫 Bloqueado" : "🚫"}
                  </button>
                </>
              )}
            </div>
          </div>

          <div style={{ fontWeight: 700, fontSize: "1.1rem", marginBottom: "0.1rem" }}>{displayName}</div>
          <div style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>@{account.acct}</div>

          {account.note && (
            <div
              style={{ fontSize: "0.925rem", lineHeight: 1.55, color: "var(--text-secondary)", marginBottom: "0.75rem" }}
              dangerouslySetInnerHTML={{ __html: account.note }}
            />
          )}
          {/* Profile fields */}
          {account.fields && account.fields.length > 0 && (
            <div style={{ marginBottom: "0.75rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
              {account.fields.map((f, i) => (
                <div key={i} style={{ display: "flex", borderBottom: i < (account.fields?.length ?? 0) - 1 ? "1px solid var(--border)" : "none" }}>
                  <div style={{ padding: "0.4rem 0.75rem", background: "var(--bg-elevated)", fontWeight: 600, fontSize: "0.8rem", color: "var(--text-secondary)", minWidth: 100, maxWidth: 140, borderRight: "1px solid var(--border)" }}>
                    {f.name}
                    {f.verified_at && <span style={{ color: "var(--accent)", marginLeft: "0.25rem" }}>✓</span>}
                  </div>
                  <div style={{ padding: "0.4rem 0.75rem", fontSize: "0.85rem", flex: 1, wordBreak: "break-all" }} dangerouslySetInnerHTML={{ __html: f.value }} />
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: "1.5rem", fontSize: "0.85rem", color: "var(--text-muted)" }}>
            <button className="btn btn-ghost btn-sm" style={{ padding: 0, color: activeTab === "posts" ? "var(--accent)" : "inherit" }} onClick={() => setActiveTab("posts")}><strong style={{ color: "var(--text)" }}>{account.statuses_count}</strong> posts</button>
            <button className="btn btn-ghost btn-sm" style={{ padding: 0, color: activeTab === "following" ? "var(--accent)" : "inherit" }} onClick={() => setActiveTab("following")}><strong style={{ color: "var(--text)" }}>{account.following_count}</strong> siguiendo</button>
            <button className="btn btn-ghost btn-sm" style={{ padding: 0, color: activeTab === "followers" ? "var(--accent)" : "inherit" }} onClick={() => setActiveTab("followers")}><strong style={{ color: "var(--text)" }}>{account.followers_count}</strong> seguidores</button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "2px solid var(--border)" }}>
          {(["posts", "following", "followers"] as const).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)} className="btn btn-ghost btn-sm" style={{ flex: 1, borderRadius: 0, borderBottom: activeTab === tab ? "2px solid var(--accent)" : "none", marginBottom: "-2px", fontWeight: activeTab === tab ? 700 : 400, color: activeTab === tab ? "var(--accent)" : "var(--text-muted)" }}>
              {tab === "posts" ? "Posts" : tab === "following" ? "Siguiendo" : "Seguidores"}
            </button>
          ))}
        </div>

        {/* Posts tab */}
        {activeTab === "posts" && (statuses.length === 0 ? (
          <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
            <p>No hay posts cacheados de esta cuenta.</p>
            <p style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
              <a href={account.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
                Ver perfil completo en el servidor original →
              </a>
            </p>
          </div>
        ) : (
          <div>
            {statuses.map((s) => (
              <StatusCard
                key={s.id}
                s={s}
                token={token}
                onFav={() => void toggleFavourite(s)}
                onReblog={() => void toggleReblog(s)}
              />
            ))}
          </div>
        ))}

        {/* Followers tab */}
        {activeTab === "followers" && (
          followers.length === 0 ? (
            <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>Sin seguidores cacheados.</div>
          ) : (
            <div>
              {followers.map((f) => (
                <AccountRow key={f.id} account={f} />
              ))}
            </div>
          )
        )}

        {/* Following tab */}
        {activeTab === "following" && (
          following.length === 0 ? (
            <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>Sin seguidos cacheados.</div>
          ) : (
            <div>
              {following.map((f) => (
                <AccountRow key={f.id} account={f} />
              ))}
            </div>
          )
        )}
      </main>
    </div>
  );
}

export default function RemoteProfilePage() {
  return (
    <Suspense fallback={<div style={{ display: "flex", minHeight: "100dvh", maxWidth: 1100, margin: "0 auto", width: "100%", alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}>Cargando…</div>}>
      <RemoteProfileInner />
    </Suspense>
  );
}
