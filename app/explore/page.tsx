"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/Sidebar";
import { Lightbox } from "@/components/Lightbox";
import { useLocale } from "@/lib/i18n";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Account {
  id: string;
  username: string;
  display_name: string;
  avatar: string;
  acct: string;
  note: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  bot?: boolean;
  url?: string;
}

interface MediaAttachment {
  id: string;
  type: string;
  url: string;
  preview_url: string | null;
  description: string | null;
}

interface PollOption { title: string; votes_count: number | null }
interface Poll {
  id: string;
  expires_at: string | null;
  expired: boolean;
  multiple: boolean;
  votes_count: number;
  voters_count: number | null;
  voted: boolean;
  own_votes: number[];
  options: PollOption[];
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
  media_attachments: MediaAttachment[];
  sensitive: boolean;
  spoiler_text: string;
  poll: Poll | null;
}

interface Hashtag { name: string; url: string; history: unknown[]; }
interface SearchResults { accounts: Account[]; statuses: Status[]; hashtags: Hashtag[]; }
type Tab = "trending" | "accounts" | "hashtags" | "statuses";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return d.toLocaleDateString();
}

function AvatarBubble({ account, size = 42 }: { account: Account; size?: number }) {
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
      justifyContent: "center", fontSize: size * 0.45, fontWeight: 700, color: "var(--accent)",
    }}>
      {fallback}
    </div>
  );
}

function MediaGrid({ attachments }: { attachments: MediaAttachment[] }) {
  const [lbIdx, setLbIdx] = useState<number | null>(null);
  if (!attachments.length) return null;
  const cols = attachments.length === 1 ? 1 : attachments.length === 2 ? 2 : 2;
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: "0.25rem", marginTop: "0.75rem", borderRadius: "var(--radius)", overflow: "hidden" }}>
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

export default function ExplorePage() {
  const [me, setMe] = useState<Account | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tab, setTab] = useState<Tab>("trending");
  const [trending, setTrending] = useState<Status[]>([]);
  const [results, setResults] = useState<SearchResults>({ accounts: [], statuses: [], hashtags: [] });
  const [loading, setLoading] = useState(false);
  const [trendingLoading, setTrendingLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
  const { t } = useLocale();

  async function fetchTrending() {
    const res = await fetch("/api/v1/timelines/public?limit=40");
    if (res.ok) setTrending(await res.json() as Status[]);
    setTrendingLoading(false);
  }

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setMe(await res.json() as Account);
  }

  const runSearch = useCallback(async (q: string) => {
    setLoading(true);
    const resolveFlag = q.includes("@") ? "&resolve=true" : "";
    const res = await fetch(`/api/v2/search?q=${encodeURIComponent(q)}${resolveFlag}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const data = await res.json() as SearchResults;
      setResults(data);
      if (data.accounts.length) setTab("accounts");
      else if (data.hashtags.length) setTab("hashtags");
      else if (data.statuses.length) setTab("statuses");
      else setTab("accounts");
    }
    setLoading(false);
  }, [token]);

  useEffect(() => {
    void fetchTrending();
    if (token) void fetchMe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  useEffect(() => {
    if (!debouncedQuery.trim()) return;
    void runSearch(debouncedQuery.trim());
  }, [debouncedQuery, runSearch]);

  async function toggleFavourite(s: Status) {
    if (!token) return;
    const path = s.favourited ? "unfavourite" : "favourite";
    const res = await fetch(`/api/v1/statuses/${s.id}/${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const update = (prev: Status[]) => prev.map((x) => x.id === s.id ? { ...x, favourited: !x.favourited, favourites_count: x.favourites_count + (x.favourited ? -1 : 1) } : x);
      setTrending(update);
      setResults((prev) => ({ ...prev, statuses: update(prev.statuses) }));
    }
  }

  const isSearching = debouncedQuery.trim().length > 0;
  const hasResults = results.accounts.length + results.statuses.length + results.hashtags.length > 0;

  const TABS: { id: Tab; label: string; count?: number }[] = isSearching
    ? [
        { id: "accounts", label: t.explore_tab_accounts, count: results.accounts.length },
        { id: "hashtags", label: t.explore_tab_hashtags, count: results.hashtags.length },
        { id: "statuses", label: t.explore_tab_posts, count: results.statuses.length },
      ]
    : [{ id: "trending", label: t.explore_tab_trending }];

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/explore" />

      {/* Main */}
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        {/* Search bar */}
        <div style={{ padding: "0.875rem 1rem", borderBottom: "1px solid var(--border)", position: "sticky", top: 0, zIndex: 10, background: "var(--bg)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", background: "var(--bg-elevated)", borderRadius: "var(--radius-full)", padding: "0.5rem 1rem", border: "1px solid var(--border)" }}>
            <span style={{ fontSize: "1rem", flexShrink: 0 }}>🔍</span>
            <input
              type="search"
              placeholder={t.explore_search_ph}
              value={query}
              onChange={(e) => {
                const next = e.target.value;
                setQuery(next);
                if (!next.trim()) {
                  setDebouncedQuery("");
                  setResults({ accounts: [], statuses: [], hashtags: [] });
                  setTab("trending");
                }
              }}
              style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: "0.9rem", color: "var(--text)" }}
            />
            {loading && <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", flexShrink: 0 }}>{t.explore_searching}</span>}
            {query && !loading && (
              <button onClick={() => { setQuery(""); setDebouncedQuery(""); }}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "1rem", padding: 0, flexShrink: 0 }}>
                ✕
              </button>
            )}
          </div>
          {query.includes("@") && !query.startsWith("#") && (
            <p style={{ fontSize: "0.75rem", color: "var(--accent)", marginTop: "0.4rem", paddingLeft: "0.5rem" }}>
              {t.explore_resolving}
            </p>
          )}
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
          {TABS.map((t) => (
            <button key={t.id} className="btn btn-ghost" onClick={() => setTab(t.id)}
              style={{ flex: 1, borderRadius: 0, padding: "0.75rem", borderBottom: tab === t.id ? "2px solid var(--accent)" : "2px solid transparent", color: tab === t.id ? "var(--accent)" : "var(--text-muted)", fontWeight: tab === t.id ? 600 : 400 }}>
              {t.label}
              {(t.count ?? 0) > 0 && (
                <span style={{ marginLeft: "0.4rem", background: "var(--accent-bg)", color: "var(--accent)", borderRadius: "var(--radius-full)", fontSize: "0.72rem", padding: "0.05rem 0.45rem" }}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Trending tab */}
        {tab === "trending" && (
          trendingLoading ? <LoadingSkeletons /> :
          trending.length === 0 ? <EmptyState emoji="🌐" text={t.explore_nothing} /> :
          <>{trending.map((s) => <StatusCard key={s.id} s={s} token={token} onToggleFav={() => void toggleFavourite(s)} />)}</>
        )}

        {/* Search result tabs */}
        {tab === "accounts" && isSearching && (
          results.accounts.length === 0 && !loading ? <EmptyState emoji="👤" text={t.explore_no_accounts} /> :
          <>{results.accounts.map((a) => <AccountCard key={a.id} account={a} token={token} />)}</>
        )}
        {tab === "hashtags" && isSearching && (
          results.hashtags.length === 0 && !loading ? <EmptyState emoji="#️⃣" text={t.explore_no_hashtags} /> :
          <>{results.hashtags.map((tag) => <HashtagCard key={tag.name} tag={tag} />)}</>
        )}
        {tab === "statuses" && isSearching && (
          results.statuses.length === 0 && !loading ? <EmptyState emoji="📝" text={t.explore_no_posts} /> :
          <>{results.statuses.map((s) => <StatusCard key={s.id} s={s} token={token} onToggleFav={() => void toggleFavourite(s)} />)}</>
        )}

        {isSearching && !loading && !hasResults && (
          <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
            <span style={{ fontSize: "2.5rem", display: "block", marginBottom: "0.75rem" }}>🔍</span>
            <p style={{ fontWeight: 600 }}>{t.explore_no_results} &ldquo;{debouncedQuery}&rdquo;</p>
            <p style={{ fontSize: "0.875rem", marginTop: "0.5rem" }}>{t.explore_remote_tip}</p>
          </div>
        )}
      </main>

      {/* Right panel */}
      <div className="hidden lg:block" style={{ width: 300, padding: "1.5rem 1rem" }}>
        <div style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius-lg)", border: "1px solid var(--border)", padding: "1rem" }}>
          <h3 style={{ fontWeight: 700, marginBottom: "0.625rem", fontSize: "0.95rem" }}>{t.explore_search_tips}</h3>
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: "0.375rem" }}>
            <div>👤 <code>@usuario</code> — {t.explore_tip_local}</div>
            <div>🌐 <code>@user@server.com</code> — {t.explore_tip_remote}</div>
            <div>#️⃣ <code>#hashtag</code> — {t.explore_tip_hashtag}</div>
            <div>💬 {t.explore_tip_text}</div>
          </div>
        </div>
        {!token && (
          <div style={{ marginTop: "1rem", background: "var(--bg-elevated)", borderRadius: "var(--radius-lg)", border: "1px solid var(--border)", padding: "1rem" }}>
            <h3 style={{ fontWeight: 700, marginBottom: "0.75rem", fontSize: "0.95rem" }}>{t.explore_join}</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <Link href="/register" className="btn btn-primary btn-sm" style={{ textAlign: "center" }}>{t.explore_create}</Link>
              <Link href="/login" className="btn btn-ghost btn-sm" style={{ textAlign: "center" }}>{t.explore_signin}</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function LoadingSkeletons() {
  return (
    <div>
      {[1, 2, 3].map((i) => (
        <div key={i} style={{ display: "flex", gap: "0.875rem", padding: "1rem", borderBottom: "1px solid var(--border)" }}>
          <div className="skeleton" style={{ width: 42, height: 42, borderRadius: "50%", flexShrink: 0 }} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div className="skeleton" style={{ height: 13, width: "40%" }} />
            <div className="skeleton" style={{ height: 13, width: "80%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ emoji, text }: { emoji: string; text: string }) {
  return (
    <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
      <span style={{ fontSize: "2.5rem", display: "block", marginBottom: "0.75rem" }}>{emoji}</span>
      <p>{text}</p>
    </div>
  );
}

function AccountCard({ account, token }: { account: Account; token: string | null }) {
  const [following, setFollowing] = useState(false);
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const isRemote = account.acct.includes("@");
  const { t } = useLocale();

  useEffect(() => {
    if (!token) return;
    void (async () => {
      const res = await fetch(`/api/v1/accounts/relationships?id[]=${encodeURIComponent(account.id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const [rel] = await res.json() as Array<{ following?: boolean; requested?: boolean }>;
      setFollowing(Boolean(rel?.following));
      setRequested(Boolean(rel?.requested));
    })();
  }, [account.id, token]);

  async function handleFollow() {
    if (!token) return;
    setBusy(true);
    try {
      const path = following || requested ? "unfollow" : "follow";
      const res = await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json() as { following?: boolean; requested?: boolean };
        setFollowing(Boolean(data.following));
        setRequested(Boolean(data.requested));
      }
    } catch {
      // silently ignore network errors
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "0.875rem", padding: "0.875rem 1rem", borderBottom: "1px solid var(--border)" }}>
      <Link href={isRemote ? `/users/remote?url=${encodeURIComponent(account.id)}` : `/users/${account.username}`}>
        <AvatarBubble account={account} size={46} />
      </Link>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
          <Link href={isRemote ? `/users/remote?url=${encodeURIComponent(account.id)}` : `/users/${account.username}`}
            style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)" }}>
            {account.display_name || account.username}
          </Link>
          {account.bot && <span style={{ fontSize: "0.68rem", padding: "0.1rem 0.35rem", borderRadius: "var(--radius-sm)", background: "var(--accent-bg)", color: "var(--accent)" }}>BOT</span>}
          {isRemote && <span style={{ fontSize: "0.68rem", padding: "0.1rem 0.35rem", borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", color: "var(--text-muted)" }}>🌐 {t.explore_tip_remote}</span>}
        </div>
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.1rem" }}>@{account.acct}</div>
        {account.note && (
          <div style={{ fontSize: "0.82rem", color: "var(--text-secondary)", marginTop: "0.3rem", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
            dangerouslySetInnerHTML={{ __html: account.note }} />
        )}
        <div style={{ display: "flex", gap: "1rem", marginTop: "0.4rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>
          <span><strong style={{ color: "var(--text)" }}>{account.followers_count}</strong> seguidores</span>
          <span><strong style={{ color: "var(--text)" }}>{account.statuses_count}</strong> posts</span>
        </div>
      </div>
      {token && (
        <button
          className={following || requested ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm"}
          style={{ flexShrink: 0 }}
          onClick={() => void handleFollow()}
          disabled={busy}
        >
          {busy ? "…" : following ? t.account_following : requested ? t.account_requested : t.account_follow}
        </button>
      )}
      {isRemote && (
        <a href={account.url ?? "#"} target="_blank" rel="noopener noreferrer"
          style={{ flexShrink: 0, color: "var(--text-muted)", fontSize: "0.85rem", textDecoration: "none" }}
          title="Ver perfil remoto">🌐</a>
      )}
    </div>
  );
}

function HashtagCard({ tag }: { tag: Hashtag }) {
  return (
    <Link href={`/tags/${encodeURIComponent(tag.name)}`}
      style={{ display: "flex", alignItems: "center", gap: "0.875rem", padding: "0.875rem 1rem", borderBottom: "1px solid var(--border)", textDecoration: "none", color: "var(--text)" }}>
      <div style={{ width: 42, height: 42, flexShrink: 0, borderRadius: "50%", background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.2rem", fontWeight: 700, color: "var(--accent)" }}>
        #
      </div>
      <div>
        <div style={{ fontWeight: 600 }}>#{tag.name}</div>
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.1rem" }}>Ver posts con este tag</div>
      </div>
      <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: "1rem" }}>→</span>
    </Link>
  );
}

function PollView({ poll: initialPoll, token }: { poll: Poll; token: string | null }) {
  const [poll, setPoll] = useState<Poll>(initialPoll);
  const [voting, setVoting] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const total = poll.votes_count > 0 ? poll.votes_count : 1;
  const showResults = poll.voted || poll.expired;
  const canVote = !poll.voted && !poll.expired && !!token;

  async function vote() {
    if (!token || voting || selected.length === 0) return;
    setVoting(true);
    try {
      const res = await fetch(`/api/v1/polls/${poll.id}/votes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ choices: selected }),
      });
      if (res.ok) setPoll((await res.json()) as Poll);
    } finally { setVoting(false); }
  }

  return (
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
              <button type="button"
                onClick={() => poll.multiple ? setSelected((p) => p.includes(i) ? p.filter((x) => x !== i) : [...p, i]) : setSelected([i])}
                style={{ width: "100%", textAlign: "left", padding: "0.35rem 0.75rem", border: `1.5px solid ${selected.includes(i) ? "var(--accent)" : "var(--border)"}`, borderRadius: "var(--radius-sm)", background: selected.includes(i) ? "var(--accent-bg)" : "transparent", cursor: "pointer", fontSize: "0.875rem", color: "var(--text)" }}>
                {opt.title}
              </button>
            )}
          </div>
        );
      })}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
        {canVote && (
          <button type="button" className="btn btn-primary btn-sm" disabled={selected.length === 0 || voting} onClick={() => void vote()}>
            {voting ? "…" : "Votar"}
          </button>
        )}
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
          {poll.votes_count} {poll.votes_count === 1 ? "voto" : "votos"}
          {poll.expires_at && <> · {poll.expired ? "Cerrada" : `Cierra ${new Date(poll.expires_at).toLocaleDateString()}`}</>}
          {poll.multiple && " · Opción múltiple"}
        </span>
      </div>
    </div>
  );
}

function StatusCard({ s, token, onToggleFav }: { s: Status; token: string | null; onToggleFav: () => void }) {
  return (
    <article style={{ display: "flex", gap: "0.875rem", padding: "1rem", borderBottom: "1px solid var(--border)" }}>
      <AvatarBubble account={s.account} size={42} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.4rem", marginBottom: "0.25rem" }}>
          <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{s.account.display_name || s.account.username}</span>
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>@{s.account.acct}</span>
          <Link href={`/statuses/${encodeURIComponent(s.id)}`} style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginLeft: "auto", textDecoration: "none" }}>{formatTime(s.created_at)}</Link>
        </div>
        {s.spoiler_text && <div style={{ padding: "0.35rem 0.6rem", background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)", fontSize: "0.875rem", marginBottom: "0.5rem", color: "var(--text-secondary)" }}>⚠️ {s.spoiler_text}</div>}
        <div style={{ fontSize: "0.95rem", lineHeight: 1.55, wordBreak: "break-word" }} dangerouslySetInnerHTML={{ __html: s.content }} />
        {s.poll && <PollView poll={s.poll} token={token} />}
        <MediaGrid attachments={s.media_attachments ?? []} />
        <div style={{ display: "flex", gap: "1.25rem", marginTop: "0.625rem", color: "var(--text-muted)", fontSize: "0.82rem", alignItems: "center" }}>
          <Link href={`/statuses/${encodeURIComponent(s.id)}`} style={{ color: "var(--text-muted)", textDecoration: "none" }}>
            <button className="btn btn-ghost btn-sm" style={{ padding: "0.2rem 0.4rem" }}>💬 {s.replies_count}</button>
          </Link>
          <button className="btn btn-ghost btn-sm" style={{ padding: "0.2rem 0.4rem" }}>🔁 {s.reblogs_count}</button>
          <button className="btn btn-ghost btn-sm" style={{ padding: "0.2rem 0.4rem", color: s.favourited ? "var(--danger)" : "var(--text-muted)" }} onClick={onToggleFav}>
            {s.favourited ? "❤️" : "🤍"} {s.favourites_count}
          </button>
        </div>
      </div>
    </article>
  );
}
