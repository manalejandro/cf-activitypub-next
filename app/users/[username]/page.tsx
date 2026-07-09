"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { Lightbox } from "@/components/Lightbox";
import { useStartCallButton } from "@/components/CallOverlay";
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
  fields: MastodonField[];
  supports_calls?: boolean;
  source?: {
    note: string;
    fields: MastodonField[];
    privacy: string;
    auto_delete_after?: number | null;
  };
}

type ActiveTab = "posts" | "replies" | "media" | "followers" | "following";

interface MediaAttachment {
  id: string;
  type: string;
  url: string;
  preview_url: string | null;
  description: string | null;
  blurhash: string | null;
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

interface Status {
  id: string;
  content: string;
  created_at: string;
  in_reply_to_id: string | null;
  account: Account;
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  favourited: boolean;
  reblogged: boolean;
  sensitive: boolean;
  spoiler_text: string;
  media_attachments: MediaAttachment[];
  visibility: string;
  poll: Poll | null;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
  source?: {
    note: string;
    fields: MastodonField[];
    privacy: string;
    auto_delete_after?: number | null;
  };
}

interface Relationship {
  id: string;
  following: boolean;
  requested: boolean;
  blocking: boolean;
  muting?: boolean;
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

function Avatar({ account, size = 42 }: { account: { display_name: string; username: string; avatar: string }; size?: number }) {
  const [imgError, setImgError] = useState(false);
  const fallback = (account.display_name?.[0] ?? account.username?.[0] ?? "?").toUpperCase();

  if (!imgError && account.avatar) {
    return (
      <img
        src={account.avatar}
        alt={account.display_name}
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <div
      style={{
        width: size, height: size, flexShrink: 0,
        background: "var(--accent-bg)",
        border: "1px solid var(--border)",
        display: "flex", alignItems: "center", justifyContent: "center",
        borderRadius: "50%", fontSize: size * 0.45, fontWeight: 700,
        color: "var(--accent)",
      }}
    >
      {fallback}
    </div>
  );
}

function MediaGrid({ attachments }: { attachments: MediaAttachment[] }) {
  const [lbIdx, setLbIdx] = useState<number | null>(null);
  if (!attachments.length) return null;
  const gridCols = attachments.length === 1 ? 1 : attachments.length === 2 ? 2 : attachments.length <= 3 ? 3 : 2;

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
          gap: "0.25rem",
          marginTop: "0.75rem",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        {attachments.map((att, i) => {
          if (att.type === "image" || att.type === "gifv") {
            return (
              <button
                key={att.id}
                type="button"
                onClick={() => setLbIdx(i)}
                title={att.description ?? undefined}
                style={{ display: "block", aspectRatio: attachments.length === 1 ? "16/9" : "1/1", overflow: "hidden", border: "none", padding: 0, cursor: "zoom-in", background: "none" }}
              >
                <img
                  src={att.preview_url ?? att.url}
                  alt={att.description ?? "media"}
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                />
              </button>
            );
          }
          if (att.type === "video") {
            return (
              <button
                key={att.id}
                type="button"
                onClick={() => setLbIdx(i)}
                style={{ display: "block", aspectRatio: "16/9", overflow: "hidden", border: "none", padding: 0, cursor: "pointer", background: "var(--bg-elevated)", position: "relative" }}
              >
                <video src={att.url} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "2rem" }}>▶</div>
              </button>
            );
          }
          if (att.type === "audio") {
            return (
              <button
                key={att.id}
                type="button"
                onClick={() => setLbIdx(i)}
                style={{ display: "block", aspectRatio: "3/1", overflow: "hidden", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 0, cursor: "pointer", background: "var(--bg-elevated)", position: "relative" }}
              >
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "0.25rem" }}>
                  <span style={{ fontSize: "2rem" }}>🎵</span>
                  {att.description && <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", maxWidth: "90%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{att.description}</span>}
                </div>
              </button>
            );
          }
          return null;
        })}
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

// Reusable status article card
function StatusCard({ s, onFav, token, me: meProp, onEdit, onDelete }: { s: Status; onFav: () => void; token: string | null; me?: Me | null; onEdit?: (s: Status) => void; onDelete?: (s: Status) => void }) {
  const [expandedCw, setExpandedCw] = useState(false);
  const [pollState, setPollState] = useState<Poll | null>(s.poll ?? null);
  const [voting, setVoting] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const isRemote = s.account.acct.includes("@");
  const profileHref = isRemote
    ? `/users/remote?url=${encodeURIComponent(s.account.id)}`
    : `/users/${s.account.username}`;
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
    } finally {
      setVoting(false);
    }
  }

  const poll = pollState;
  const showResults = poll ? (poll.voted || poll.expired) : false;
  const total = poll && poll.votes_count > 0 ? poll.votes_count : 1;

  return (
    <article style={{ display: "flex", gap: "0.875rem", padding: "1rem", borderBottom: "1px solid var(--border)" }}>
      <Link href={profileHref} style={{ flexShrink: 0 }}>
        <Avatar account={s.account} size={42} />
      </Link>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="flex items-baseline gap-2" style={{ marginBottom: "0.3rem" }}>
          <Link href={profileHref} style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)", textDecoration: "none" }}>
            {s.account.display_name || s.account.username}
          </Link>
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>@{s.account.acct}</span>
          <Link href={threadHref} title={new Date(s.created_at).toLocaleString()} style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginLeft: "auto", textDecoration: "none" }}>
            {formatTime(s.created_at)}
          </Link>
        </div>
        {s.spoiler_text && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.375rem 0.625rem", background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)", fontSize: "0.875rem", marginBottom: "0.4rem", color: "var(--text-secondary)", gap: "0.5rem" }}>
            <span>⚠️ {s.spoiler_text}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem", whiteSpace: "nowrap", flexShrink: 0 }}
              onClick={() => setExpandedCw((v) => !v)}
            >
              {expandedCw ? "Ocultar" : "Mostrar"}
            </button>
          </div>
        )}
        {(!s.spoiler_text || expandedCw) && (
          <div style={{ fontSize: "0.95rem", lineHeight: 1.55, overflowWrap: "break-word", wordBreak: "break-word", minWidth: 0 }} dangerouslySetInnerHTML={{ __html: s.content }} />
        )}
        {(!s.spoiler_text || expandedCw) && <MediaGrid attachments={s.media_attachments} />}
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
                    <button
                      type="button"
                      onClick={() => {
                        if (poll.multiple) {
                          setSelected((p) => p.includes(i) ? p.filter((x) => x !== i) : [...p, i]);
                        } else {
                          setSelected([i]);
                        }
                      }}
                      style={{ width: "100%", textAlign: "left", padding: "0.35rem 0.75rem", border: `1.5px solid ${selected.includes(i) ? "var(--accent)" : "var(--border)"}`, borderRadius: "var(--radius-sm)", background: selected.includes(i) ? "var(--accent-bg)" : "transparent", cursor: "pointer", fontSize: "0.875rem", color: "var(--text)" }}
                    >
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
        <div className="flex gap-5 mt-3" style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
          <button className="btn btn-ghost btn-sm" style={{ padding: "0.2rem 0.4rem", gap: "0.35rem" }}>💬 {s.replies_count}</button>
          <button className="btn btn-ghost btn-sm" style={{ padding: "0.2rem 0.4rem", gap: "0.35rem" }}>🔁 {s.reblogs_count}</button>
          <button
            className="btn btn-ghost btn-sm"
            style={{ padding: "0.2rem 0.4rem", gap: "0.35rem", color: s.favourited ? "var(--danger)" : "var(--text-muted)" }}
            onClick={onFav}
          >
            {s.favourited ? "❤️" : "🤍"} {s.favourites_count}
          </button>
          {meProp && meProp.id === s.account.id && (
            <>
              {onEdit && (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ padding: "0.2rem 0.4rem", marginLeft: "auto" }}
                  onClick={() => onEdit(s)}
                  title="Editar"
                >
                  ✏️
                </button>
              )}
              {onDelete && (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ padding: "0.2rem 0.4rem", color: "var(--danger)" }}
                  onClick={() => onDelete(s)}
                  title="Eliminar"
                >
                  🗑️
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

// Flat media grid with global lightbox (for profile media tab)
function ProfileMediaGrid({ attachments }: { attachments: MediaAttachment[] }) {
  const [lbIdx, setLbIdx] = useState<number | null>(null);

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "2px", padding: "2px" }}>
        {attachments.map((att, i) => (
          <button
            key={att.id}
            type="button"
            onClick={() => setLbIdx(i)}
            title={att.description ?? undefined}
            style={{ display: "block", aspectRatio: "1/1", overflow: "hidden", border: "none", padding: 0, cursor: "zoom-in", background: "var(--bg-elevated)" }}
          >
            {att.type === "image" || att.type === "gifv" ? (
              <img
                src={att.preview_url ?? att.url}
                alt={att.description ?? ""}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
            ) : (
              <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "2rem" }}>
                {att.type === "video" ? "🎬" : "🎵"}
              </div>
            )}
          </button>
        ))}
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

// Account card for followers/following lists
function AccountCard({ acct }: { acct: Account }) {
  const isRemote = acct.acct.includes("@");
  const profileHref = isRemote
    ? `/users/remote?url=${encodeURIComponent(acct.id)}`
    : `/users/${acct.username}`;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.875rem 1rem", borderBottom: "1px solid var(--border)" }}>
      <Link href={profileHref} style={{ flexShrink: 0 }}><Avatar account={acct} size={46} /></Link>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Link href={profileHref} style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)", textDecoration: "none" }}>
          {acct.display_name || acct.username}
        </Link>
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.1rem" }}>@{acct.acct}</div>
        {acct.note && (
          <div
            style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "0.25rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            dangerouslySetInnerHTML={{ __html: acct.note }}
          />
        )}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const router = useRouter();
  const [username, setUsername] = useState<string>("");
  const [account, setAccount] = useState<Account | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [replies, setReplies] = useState<Status[]>([]);
  const [followers, setFollowers] = useState<Account[]>([]);
  const [following, setFollowing] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>("posts");
  const [tabLoaded, setTabLoaded] = useState<Record<string, boolean>>({ posts: false });
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);
  const [hasMorePosts, setHasMorePosts] = useState(true);
  const [loadingMorePosts, setLoadingMorePosts] = useState(false);
  const [hasMoreFollowers, setHasMoreFollowers] = useState(true);
  const [loadingMoreFollowers, setLoadingMoreFollowers] = useState(false);
  const [hasMoreFollowing, setHasMoreFollowing] = useState(true);
  const [loadingMoreFollowing, setLoadingMoreFollowing] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Status edit state
  const [editingStatus, setEditingStatus] = useState<Status | null>(null);
  const [editText, setEditText] = useState("");
  const [editSpoiler, setEditSpoiler] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  // Edit form state
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editLocked, setEditLocked] = useState(false);
  const [editAutoDelete, setEditAutoDelete] = useState(0);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [headerFile, setHeaderFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [headerPreview, setHeaderPreview] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<{ name: string; value: string }[]>([]);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const headerInputRef = useRef<HTMLInputElement>(null);

  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;

  async function load(uname: string) {
    const authHeaders: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};

    const [accountRes, meRes] = await Promise.all([
      fetch(`/api/v1/accounts/lookup?acct=${encodeURIComponent(uname)}`),
      token ? fetch("/api/v1/accounts/verify_credentials", { headers: authHeaders }) : Promise.resolve(null),
    ]);

    if (!accountRes.ok) { setNotFound(true); setLoading(false); return; }
    const acct = await accountRes.json() as Account;
    setAccount(acct);

    if (meRes?.ok) {
      const meData = await meRes.json() as Me;
      setMe(meData);

      if (meData.id !== acct.id) {
        const relRes = await fetch(`/api/v1/accounts/relationships?id[]=${encodeURIComponent(acct.id)}`, {
          headers: authHeaders,
        });
        if (relRes.ok) {
          const [rel] = await relRes.json() as Relationship[];
          setRelationship(rel ?? null);
        }
      }
    }

    // Load statuses
    const statusRes = await fetch(
      `/api/v1/accounts/${encodeURIComponent(acct.id)}/statuses?limit=20`,
      { headers: authHeaders }
    );
    if (statusRes.ok) {
      const data = await statusRes.json() as Status[];
      setStatuses(data);
      setHasMorePosts(data.length >= 20);
    }
    setTabLoaded((p) => ({ ...p, posts: true }));

    setLoading(false);
  }

  useEffect(() => {
    params.then(({ username: u }) => {
      setUsername(u);
      void load(u);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadMorePosts() {
    if (!account || loadingMorePosts || !hasMorePosts || statuses.length === 0) return;
    const authHeaders: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
    setLoadingMorePosts(true);
    const oldestId = statuses[statuses.length - 1].id;
    const res = await fetch(
      `/api/v1/accounts/${encodeURIComponent(account.id)}/statuses?max_id=${encodeURIComponent(oldestId)}&limit=20`,
      { headers: authHeaders }
    );
    if (res.ok) {
      const data = await res.json() as Status[];
      setStatuses((prev) => [...prev, ...data]);
      setHasMorePosts(data.length >= 20);
    }
    setLoadingMorePosts(false);
  }

  async function loadMoreFollowers() {
    if (!account || loadingMoreFollowers || !hasMoreFollowers) return;
    const authHeaders: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
    setLoadingMoreFollowers(true);
    const nextPage = Math.floor(followers.length / 40);
    const res = await fetch(
      `/api/v1/accounts/${encodeURIComponent(account.id)}/followers?limit=40&page=${nextPage}`,
      { headers: authHeaders }
    );
    if (res.ok) {
      const data = await res.json() as Account[];
      setFollowers((prev) => [...prev, ...data]);
      setHasMoreFollowers(data.length >= 40);
    }
    setLoadingMoreFollowers(false);
  }

  async function loadMoreFollowing() {
    if (!account || loadingMoreFollowing || !hasMoreFollowing) return;
    const authHeaders: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
    setLoadingMoreFollowing(true);
    const nextPage = Math.floor(following.length / 40);
    const res = await fetch(
      `/api/v1/accounts/${encodeURIComponent(account.id)}/following?limit=40&page=${nextPage}`,
      { headers: authHeaders }
    );
    if (res.ok) {
      const data = await res.json() as Account[];
      setFollowing((prev) => [...prev, ...data]);
      setHasMoreFollowing(data.length >= 40);
    }
    setLoadingMoreFollowing(false);
  }

  // Infinite scroll for posts, followers, following tabs
  useEffect(() => {
    if (!bottomRef.current) return;
    if (activeTab === "posts" && (!hasMorePosts || loadingMorePosts)) return;
    if (activeTab === "followers" && (!hasMoreFollowers || loadingMoreFollowers)) return;
    if (activeTab === "following" && (!hasMoreFollowing || loadingMoreFollowing)) return;
    if (activeTab !== "posts" && activeTab !== "followers" && activeTab !== "following") return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        if (activeTab === "posts") void loadMorePosts();
        else if (activeTab === "followers") void loadMoreFollowers();
        else if (activeTab === "following") void loadMoreFollowing();
      },
      { rootMargin: "300px" }
    );
    obs.observe(bottomRef.current);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMorePosts, loadingMorePosts, statuses, activeTab, hasMoreFollowers, loadingMoreFollowers, followers, hasMoreFollowing, loadingMoreFollowing, following]);

  async function loadTab(tab: ActiveTab, acctId: string) {
    if (tabLoaded[tab]) return;
    const authHeaders: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};

    if (tab === "replies") {
      const res = await fetch(
        `/api/v1/accounts/${encodeURIComponent(acctId)}/statuses?only_replies=true&limit=20`,
        { headers: authHeaders }
      );
      if (res.ok) setReplies(await res.json() as Status[]);
    } else if (tab === "followers") {
      const res = await fetch(
        `/api/v1/accounts/${encodeURIComponent(acctId)}/followers?limit=40`,
        { headers: authHeaders }
      );
      if (res.ok) {
        const data = await res.json() as Account[];
        setFollowers(data);
        setHasMoreFollowers(data.length >= 40);
      }
    } else if (tab === "following") {
      const res = await fetch(
        `/api/v1/accounts/${encodeURIComponent(acctId)}/following?limit=40`,
        { headers: authHeaders }
      );
      if (res.ok) {
        const data = await res.json() as Account[];
        setFollowing(data);
        setHasMoreFollowing(data.length >= 40);
      }
    }
    setTabLoaded((p) => ({ ...p, [tab]: true }));
  }

  function handleTabChange(tab: ActiveTab) {
    setActiveTab(tab);
    if (account) void loadTab(tab, account.id);
  }

  function openEdit(acct: Account) {
    setEditDisplayName(acct.display_name || "");
    setEditNote(acct.source?.note ?? me?.source?.note ?? acct.note ?? "");
    setEditLocked(Boolean(acct.locked));
    setEditAutoDelete((acct.source ?? me?.source)?.auto_delete_after ?? 0);
    setAvatarPreview(null);
    setHeaderPreview(null);
    setAvatarFile(null);
    setHeaderFile(null);
    setEditError(null);
    const currentFields = (acct.source?.fields ?? acct.fields ?? []).slice(0, 4);
    setEditFields(currentFields.map((f) => ({ name: f.name, value: f.value })));
    setEditOpen(true);
  }

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSaving(true);
    setEditError(null);

    const form = new FormData();
    form.append("display_name", editDisplayName);
    form.append("note", editNote);
    form.append("locked", editLocked ? "true" : "false");
    form.append("auto_delete_after", editAutoDelete > 0 ? String(editAutoDelete) : "");
    if (avatarFile) form.append("avatar", avatarFile);
    if (headerFile) form.append("header", headerFile);
    editFields.forEach((f, i) => {
      form.append(`fields_attributes[${i}][name]`, f.name);
      form.append(`fields_attributes[${i}][value]`, f.value);
    });

    const res = await fetch("/api/v1/accounts/verify_credentials", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    if (res.ok) {
      const updated = await res.json() as Account;
      setAccount(updated);
      setEditOpen(false);
    } else {
      const err = await res.json() as { error?: string };
      setEditError(err.error ?? "Failed to save");
    }
    setSaving(false);
  }

  function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setAvatarFile(f);
    setAvatarPreview(URL.createObjectURL(f));
  }

  function handleHeaderChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setHeaderFile(f);
    setHeaderPreview(URL.createObjectURL(f));
  }

  function addField() {
    if (editFields.length >= 4) return;
    setEditFields((p) => [...p, { name: "", value: "" }]);
  }

  function removeField(i: number) {
    setEditFields((p) => p.filter((_, idx) => idx !== i));
  }

  function updateField(i: number, key: "name" | "value", val: string) {
    setEditFields((p) => p.map((f, idx) => (idx === i ? { ...f, [key]: val } : f)));
  }

  async function toggleFavourite(s: Status) {
    if (!token) return;
    const path = s.favourited ? "unfavourite" : "favourite";
    const res = await fetch(`/api/v1/statuses/${s.id}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const updateFn = (prev: Status[]) =>
        prev.map((x) =>
          x.id === s.id
            ? { ...x, favourited: !x.favourited, favourites_count: x.favourites_count + (x.favourited ? -1 : 1) }
            : x
        );
      setStatuses(updateFn);
      setReplies(updateFn);
    }
  }

  function openStatusEdit(s: Status) {
    const div = typeof document !== "undefined" ? document.createElement("div") : null;
    if (div) {
      div.innerHTML = s.content.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n");
      setEditText((div.textContent ?? div.innerText ?? "").trim());
    } else {
      setEditText(s.content.replace(/<[^>]*>/g, "").trim());
    }
    setEditSpoiler(s.spoiler_text ?? "");
    setEditingStatus(s);
  }

  async function handleStatusEditSave() {
    if (!editText.trim() || !editingStatus || !token) return;
    setEditBusy(true);
    const res = await fetch(`/api/v1/statuses/${editingStatus.id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: editText, spoiler_text: editSpoiler, sensitive: !!editSpoiler }),
    });
    if (res.ok) {
      const updated = await res.json() as Status;
      const updateFn = (prev: Status[]) => prev.map((x) => (x.id === editingStatus.id ? updated : x));
      setStatuses(updateFn);
      setReplies(updateFn);
      setEditingStatus(null);
    }
    setEditBusy(false);
  }

  async function handleDelete(s: Status) {
    if (!token) return;
    if (!confirm("¿Eliminar este estado?")) return;
    const res = await fetch(`/api/v1/statuses/${encodeURIComponent(s.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setStatuses((prev) => prev.filter((x) => x.id !== s.id));
      setReplies((prev) => prev.filter((x) => x.id !== s.id));
    }
  }

  async function toggleFollow() {
    if (!token || !account || followBusy) return;
    setFollowBusy(true);
    const following = relationship?.following === true || relationship?.requested === true;
    const path = following ? "unfollow" : "follow";
    const res = await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json() as { following?: boolean; requested?: boolean };
      setRelationship((prev) => ({
        ...(prev ?? { id: account.id, blocking: false }),
        following: data.following ?? false,
        requested: data.requested ?? false,
      }));
    }
    setFollowBusy(false);
  }

  async function toggleBlock() {
    if (!token || !account || blockBusy) return;
    setBlockBusy(true);
    const blocking = relationship?.blocking === true;
    const path = blocking ? "unblock" : "block";
    const res = await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setRelationship((prev) => ({
        ...(prev ?? { id: account.id, following: false, requested: false }),
        blocking: !blocking,
        // unblock doesn't automatically re-follow
        following: blocking ? (prev?.following ?? false) : false,
        requested: blocking ? (prev?.requested ?? false) : false,
      }));
    }
    setBlockBusy(false);
  }

  async function toggleMute() {
    if (!token || !account || muteBusy) return;
    setMuteBusy(true);
    const muting = relationship?.muting === true;
    const path = muting ? "unmute" : "mute";
    await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    setRelationship((prev) => prev ? { ...prev, muting: !muting } : prev);
    setMuteBusy(false);
  }

  const isOwnProfile = me && account && me.id === account.id;
  const allAttachments = statuses.flatMap((s) => s.media_attachments);
  const { t } = useLocale();
  const { startCall: initiateCall } = useStartCallButton(token);

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath={`/users/${username}`} />

      {/* Main */}
      <main style={{ flex: 1, maxWidth: 600, minWidth: 0, width: "100%", borderRight: "1px solid var(--border)" }}>
        {loading ? (
          <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.loading}</div>
        ) : notFound || !account ? (
          <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
            <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>👤</div>
            <p style={{ fontWeight: 600 }}>{t.profile_not_found}</p>
            <Link href="/explore" className="btn btn-ghost btn-sm" style={{ marginTop: "1rem" }}>{t.nav_explore}</Link>
          </div>
        ) : (
          <>
            {/* Header banner */}
            <div
              style={{
                height: 160, position: "relative",
                background: account.header
                  ? `url(${account.header}) center/cover no-repeat`
                  : "linear-gradient(135deg, var(--accent-bg) 0%, var(--bg-elevated) 100%)",
              }}
            />

            {/* Avatar + actions row */}
            <div
              style={{
                display: "flex", alignItems: "flex-end", justifyContent: "space-between",
                padding: "0 1rem",
                marginTop: -44,
                position: "relative",
                zIndex: 1,
              }}
            >
              <div
                style={{
                  width: 88, height: 88,
                  borderRadius: "50%",
                  border: "4px solid var(--bg)",
                  overflow: "hidden",
                  background: "var(--accent-bg)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "2.5rem", fontWeight: 700, color: "var(--accent)",
                }}
              >
                {account.avatar ? (
                  <img
                    src={account.avatar}
                    alt={account.display_name}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  (account.display_name?.[0] ?? account.username?.[0] ?? "?").toUpperCase()
                )}
              </div>

              <div className="flex gap-2" style={{ paddingBottom: "0.5rem" }}>
                {isOwnProfile ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ border: "1px solid var(--border)" }}
                    onClick={() => openEdit(account)}
                  >
                    {t.profile_edit}
                  </button>
                ) : token ? (
                  <>
                    <button
                      className={relationship?.following || relationship?.requested ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm"}
                      onClick={() => void toggleFollow()}
                      disabled={followBusy || relationship?.blocking}
                    >
                      {followBusy
                        ? "…"
                        : relationship?.following
                        ? t.account_following
                        : relationship?.requested
                        ? t.account_requested
                        : t.account_follow}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ border: "1px solid var(--border)", color: relationship?.blocking ? "var(--danger)" : "var(--text-muted)" }}
                      onClick={() => void toggleBlock()}
                      disabled={blockBusy}
                      title={relationship?.blocking ? "Desbloquear" : "Bloquear"}
                    >
                      {blockBusy ? "…" : relationship?.blocking ? "🚫 Bloqueado" : "🚫"}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ border: "1px solid var(--border)", color: relationship?.muting ? "var(--danger)" : "var(--text-muted)" }}
                      onClick={() => void toggleMute()}
                      disabled={muteBusy}
                      title={relationship?.muting ? "Dejar de silenciar" : "Silenciar"}
                    >
                      {muteBusy ? "…" : relationship?.muting ? "🤫 Silenciado" : "🤫"}
                    </button>
                    {!relationship?.blocking && (
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ border: "1px solid var(--border)" }}
                        onClick={() => router.push("/messages")}
                        title="Mensaje directo"
                      >
                        💬
                      </button>
                    )}
                    {account.supports_calls && (<>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ border: "1px solid var(--border)" }}
                        title="Voice call"
                        onClick={() => void initiateCall(account.acct, "audio")}
                      >
                        📞
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ border: "1px solid var(--border)" }}
                        title="Video call"
                        onClick={() => void initiateCall(account.acct, "video")}
                      >
                        📹
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ border: "1px solid var(--border)" }}
                        title="Share screen"
                        onClick={() => void initiateCall(account.acct, "screen")}
                      >
                        🖥️
                      </button>
                    </>)}
                  </>
                ) : (
                  <Link href="/login" className="btn btn-primary btn-sm">{t.account_follow}</Link>
                )}
              </div>
            </div>

            {/* Profile info */}
            <div style={{ padding: "0.75rem 1rem 0" }}>
              <div style={{ fontWeight: 700, fontSize: "1.15rem" }}>
                {account.display_name || account.username}
                {account.bot && (
                  <span
                    style={{
                      marginLeft: "0.5rem", fontSize: "0.7rem", padding: "0.1rem 0.4rem",
                      borderRadius: "var(--radius-sm)", background: "var(--accent-bg)",
                      color: "var(--accent)", verticalAlign: "middle",
                    }}
                  >
                    BOT
                  </span>
                )}
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: "0.875rem", marginBottom: "0.5rem" }}>
                @{account.acct}
              </div>

              {account.note && (
                <div
                  style={{ fontSize: "0.9rem", lineHeight: 1.55, marginBottom: "0.75rem", whiteSpace: "pre-line" }}
                  dangerouslySetInnerHTML={{ __html: account.note }}
                />
              )}

              {/* Profile fields (Mastodon-style key/value pairs) */}
              {account.fields && account.fields.length > 0 && (
                <div style={{ marginBottom: "0.75rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
                  {account.fields.map((f, i) => (
                    <div key={i} style={{ display: "flex", borderBottom: i < account.fields.length - 1 ? "1px solid var(--border)" : "none" }}>
                      <div style={{ padding: "0.4rem 0.75rem", background: "var(--bg-elevated)", fontWeight: 600, fontSize: "0.8rem", color: "var(--text-secondary)", minWidth: 100, maxWidth: 140, borderRight: "1px solid var(--border)" }}>
                        {f.name}
                      </div>
                      <div
                        style={{ padding: "0.4rem 0.75rem", fontSize: "0.85rem", flex: 1, wordBreak: "break-all" }}
                        dangerouslySetInnerHTML={{ __html: f.value }}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Stats */}
              <div className="flex gap-5" style={{ padding: "0.75rem 0", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
                {[
                  { label: t.profile_posts, value: account.statuses_count },
                  { label: t.profile_following, value: account.following_count },
                  { label: t.profile_followers, value: account.followers_count },
                ].map((s) => (
                  <div key={s.label} className="flex flex-col items-center gap-0.5">
                    <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>{s.value.toLocaleString()}</span>
                    <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{s.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Tabs */}
            <div className="flex" style={{ borderBottom: "1px solid var(--border)", overflowX: "auto" }}>
              {([
                { key: "posts" as ActiveTab, label: t.profile_posts, count: account.statuses_count },
                { key: "replies" as ActiveTab, label: t.profile_replies },
                { key: "media" as ActiveTab, label: t.profile_media, count: allAttachments.length },
                { key: "following" as ActiveTab, label: t.profile_following, count: account.following_count },
                { key: "followers" as ActiveTab, label: t.profile_followers, count: account.followers_count },
              ]).map((tab) => (
                <button
                  key={tab.key}
                  className="btn btn-ghost"
                  onClick={() => handleTabChange(tab.key)}
                  style={{
                    flex: "0 0 auto",
                    borderRadius: 0,
                    padding: "0.875rem 1rem",
                    borderBottom: activeTab === tab.key ? "2px solid var(--accent)" : "2px solid transparent",
                    color: activeTab === tab.key ? "var(--accent)" : "var(--text-muted)",
                    fontWeight: activeTab === tab.key ? 600 : 400,
                    whiteSpace: "nowrap",
                    fontSize: "0.875rem",
                  }}
                >
                  {tab.label}
                  {tab.count !== undefined && (
                    <span style={{ marginLeft: "0.35rem", fontSize: "0.78rem", opacity: 0.7 }}>{tab.count.toLocaleString()}</span>
                  )}
                </button>
              ))}
            </div>

            {/* Tab content */}
            {activeTab === "posts" && (
              statuses.length === 0 ? (
                <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
                  <span style={{ fontSize: "2rem", display: "block", marginBottom: "0.75rem" }}>📝</span>
                  {t.profile_no_posts}
                </div>
              ) : (
                <>
                  {statuses.map((s) => <StatusCard key={s.id} s={s} onFav={() => void toggleFavourite(s)} token={token} me={me} onEdit={openStatusEdit} onDelete={handleDelete} />)}
                  <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.82rem" }}>
                    {loadingMorePosts ? "Cargando…" : ""}
                  </div>
                </>
              )
            )}

            {activeTab === "replies" && (
              !tabLoaded.replies ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.loading}</div>
              ) : replies.length === 0 ? (
                <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
                  <span style={{ fontSize: "2rem", display: "block", marginBottom: "0.75rem" }}>💬</span>
                  {t.profile_no_replies}
                </div>
              ) : (
                replies.map((s) => <StatusCard key={s.id} s={s} onFav={() => void toggleFavourite(s)} token={token} me={me} onEdit={openStatusEdit} onDelete={handleDelete} />)
              )
            )}

            {activeTab === "media" && (
              allAttachments.length === 0 ? (
                <div style={{ padding: "3rem 1rem", textAlign: "center", color: "var(--text-muted)" }}>{t.profile_no_media}</div>
              ) : (
                <ProfileMediaGrid attachments={allAttachments} />
              )
            )}

            {activeTab === "followers" && (
              !tabLoaded.followers ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.loading}</div>
              ) : followers.length === 0 ? (
                <div style={{ padding: "3rem 1rem", textAlign: "center", color: "var(--text-muted)" }}>{t.profile_no_followers}</div>
              ) : (
                <>
                  {followers.map((f) => <AccountCard key={f.id} acct={f} />)}
                  <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.82rem" }}>
                    {loadingMoreFollowers ? "Cargando…" : ""}
                  </div>
                </>
              )
            )}

            {activeTab === "following" && (
              !tabLoaded.following ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>{t.loading}</div>
              ) : following.length === 0 ? (
                <div style={{ padding: "3rem 1rem", textAlign: "center", color: "var(--text-muted)" }}>{t.profile_no_following}</div>
              ) : (
                <>
                  {following.map((f) => <AccountCard key={f.id} acct={f} />)}
                  <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.82rem" }}>
                    {loadingMoreFollowing ? "Cargando…" : ""}
                  </div>
                </>
              )
            )}
          </>
        )}
      </main>

      {/* Edit profile modal */}
      {editOpen && account && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 50,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.7)",
            padding: "1rem",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setEditOpen(false); }}
        >
          <div
            style={{
              background: "var(--bg-surface)", borderRadius: "var(--radius-lg)",
              border: "1px solid var(--border)", width: "100%", maxWidth: 480,
              boxShadow: "var(--shadow-lg)",
            }}
          >
            {/* Modal header */}
            <div
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "1rem 1.25rem", borderBottom: "1px solid var(--border)",
              }}
            >
              <h2 style={{ fontWeight: 700, fontSize: "1.1rem", margin: 0 }}>{t.profile_edit}</h2>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setEditOpen(false)}
                style={{ fontSize: "1.2rem", padding: "0.25rem 0.5rem" }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={(e) => void handleEditSave(e)} style={{ padding: "1.25rem" }}>
              {/* Header image upload */}
              <div
                onClick={() => headerInputRef.current?.click()}
                style={{
                  height: 100, borderRadius: "var(--radius)",
                  background: headerPreview
                    ? `url(${headerPreview}) center/cover no-repeat`
                    : account.header
                    ? `url(${account.header}) center/cover no-repeat`
                    : "linear-gradient(135deg, var(--accent-bg) 0%, var(--bg-elevated) 100%)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  cursor: "pointer",
                  border: "1px solid var(--border)",
                  marginBottom: "0.75rem",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    background: "rgba(0,0,0,0.55)", borderRadius: "var(--radius-sm)",
                    padding: "0.25rem 0.625rem", fontSize: "0.8rem", color: "#fff",
                  }}
                >
                  📷 {t.profile_edit_header}
                </div>
                <input
                  ref={headerInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={handleHeaderChange}
                />
              </div>

              {/* Avatar upload */}
              <div className="flex items-center gap-3" style={{ marginBottom: "1.25rem" }}>
                <div
                  onClick={() => avatarInputRef.current?.click()}
                  style={{
                    width: 64, height: 64, borderRadius: "50%",
                    border: "3px solid var(--border)",
                    overflow: "hidden", cursor: "pointer",
                    background: "var(--accent-bg)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    position: "relative",
                  }}
                >
                  {avatarPreview || account.avatar ? (
                    <img
                      src={avatarPreview ?? account.avatar}
                      alt="avatar"
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    <span style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--accent)" }}>
                      {(account.display_name?.[0] ?? account.username?.[0] ?? "?").toUpperCase()}
                    </span>
                  )}
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={handleAvatarChange}
                  />
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  {t.profile_edit_avatar}<br />
                  <span style={{ fontSize: "0.75rem" }}>JPEG, PNG, GIF, WebP · max 2 MB</span>
                </div>
              </div>

              {/* Display name */}
              <div className="flex flex-col gap-1" style={{ marginBottom: "1rem" }}>
                <label style={{ fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 500 }}>
                  {t.profile_display_name}
                </label>
                <input
                  type="text"
                  className="input"
                  maxLength={30}
                  value={editDisplayName}
                  onChange={(e) => setEditDisplayName(e.target.value)}
                  placeholder={t.profile_edit_placeholder_name}
                />
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", textAlign: "right" }}>
                  {editDisplayName.length}/30
                </span>
              </div>

              {/* Bio */}
              <div className="flex flex-col gap-1" style={{ marginBottom: "1.25rem" }}>
                <label style={{ fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 500 }}>
                  {t.profile_bio}
                </label>
                <textarea
                  className="input"
                  style={{ resize: "none", minHeight: 90, fontFamily: "inherit" }}
                  maxLength={500}
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  placeholder={t.profile_edit_placeholder_bio}
                />
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", textAlign: "right" }}>
                  {editNote.length}/500
                </span>
              </div>

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.6rem",
                  marginBottom: "1.25rem",
                  fontSize: "0.85rem",
                  color: "var(--text-secondary)",
                }}
              >
                <input
                  type="checkbox"
                  checked={editLocked}
                  onChange={(e) => setEditLocked(e.target.checked)}
                  style={{ width: 16, height: 16 }}
                />
                {t.profile_follow_requests_manual}
              </label>

              {/* Profile fields section */}
              <div style={{ marginBottom: "1.25rem" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                  <label style={{ fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 500 }}>
                    {t.profile_edit_fields}
                  </label>
                  {editFields.length < 4 && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={addField} style={{ fontSize: "0.8rem", padding: "0.2rem 0.5rem" }}>
                      {t.profile_edit_add_field}
                    </button>
                  )}
                </div>
                {editFields.length === 0 && (
                  <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: 0 }}>
                    {t.profile_edit_fields_hint}
                  </p>
                )}
                {editFields.map((f, i) => (
                  <div key={i} className="flex gap-2" style={{ marginBottom: "0.5rem", alignItems: "center" }}>
                    <input
                      type="text"
                      className="input"
                      style={{ flex: "0 0 35%", fontSize: "0.85rem" }}
                      placeholder={t.profile_edit_fields_label}
                      maxLength={255}
                      value={f.name}
                      onChange={(e) => updateField(i, "name", e.target.value)}
                    />
                    <input
                      type="text"
                      className="input"
                      style={{ flex: 1, fontSize: "0.85rem" }}
                      placeholder={t.profile_edit_fields_content}
                      maxLength={255}
                      value={f.value}
                      onChange={(e) => updateField(i, "value", e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => removeField(i)}
                      style={{ padding: "0.2rem 0.5rem", color: "var(--danger)", flexShrink: 0 }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              {/* Auto-delete setting */}
              <div style={{ marginBottom: "1.25rem" }}>
                <label style={{ display: "block", fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: 500, marginBottom: "0.375rem" }}>
                  {t.profile_edit_auto_delete}
                </label>
                <select
                  value={editAutoDelete}
                  onChange={(e) => setEditAutoDelete(Number(e.target.value))}
                  className="input"
                  style={{ width: "100%", fontSize: "0.875rem" }}
                >
                  <option value={0}>{t.profile_edit_auto_delete_off}</option>
                  <option value={3600}>{t.profile_edit_auto_delete_1h}</option>
                  <option value={21600}>{t.profile_edit_auto_delete_6h}</option>
                  <option value={86400}>{t.profile_edit_auto_delete_1d}</option>
                  <option value={259200}>{t.profile_edit_auto_delete_3d}</option>
                  <option value={604800}>{t.profile_edit_auto_delete_1w}</option>
                  <option value={2592000}>{t.profile_edit_auto_delete_30d}</option>
                </select>
                <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
                  {t.profile_edit_auto_delete_hint}
                </p>
              </div>

              {editError && (
                <div
                  style={{
                    marginBottom: "1rem",
                    background: "rgba(248,113,113,0.1)",
                    border: "1px solid rgba(248,113,113,0.3)",
                    color: "var(--danger)",
                    borderRadius: "var(--radius)",
                    padding: "0.5rem 0.75rem",
                    fontSize: "0.875rem",
                  }}
                >
                  {editError}
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setEditOpen(false)}
                  disabled={saving}
                >
                  {t.profile_cancel}
                </button>
                <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
                  {saving ? t.profile_saving : t.profile_save}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit status modal */}
      {editingStatus && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setEditingStatus(null); }}
        >
          <div style={{ background: "var(--bg)", borderRadius: "var(--radius-lg)", padding: "1.25rem", width: "min(520px, 95vw)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 700, fontSize: "1rem" }}>Editar estado</span>
              <button type="button" onClick={() => setEditingStatus(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "1.1rem", padding: "0.25rem" }}>✕</button>
            </div>
            {editSpoiler !== "" || editingStatus.spoiler_text ? (
              <input
                type="text"
                value={editSpoiler}
                onChange={(e) => setEditSpoiler(e.target.value)}
                placeholder="Advertencia de contenido"
                className="input"
                style={{ width: "100%" }}
              />
            ) : null}
            <textarea
              autoFocus
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              placeholder="Edita tu estado…"
              maxLength={500}
              className="input"
              style={{ resize: "none", minHeight: 120, fontFamily: "inherit", width: "100%" }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{editText.length}/500</span>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingStatus(null)}>Cancelar</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={!editText.trim() || editBusy} onClick={() => void handleStatusEditSave()}>
                  {editBusy ? "…" : "Guardar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
