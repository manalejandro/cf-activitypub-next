"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/Sidebar";
import { Lightbox } from "@/components/Lightbox";
import { useLocale } from "@/lib/i18n";
import { useTimelineStream } from "@/lib/streaming/use-timeline-stream";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Account {
  id: string;
  username: string;
  display_name: string;
  avatar: string;
  acct: string;
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

type TimelineView = "local" | "federated";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return d.toLocaleDateString();
}

// ─── AvatarBubble ─────────────────────────────────────────────────────────────

function AvatarBubble({ account, size = 42 }: { account: Account; size?: number }) {
  const [err, setErr] = useState(false);
  const fallback = (account.display_name?.[0] ?? account.username?.[0] ?? "?").toUpperCase();
  if (!err && account.avatar && !account.avatar.endsWith("/default-avatar.png")) {
    return (
      <img
        src={account.avatar}
        alt={account.display_name}
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
        onError={() => setErr(true)}
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: "50%",
        background: "var(--accent-bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.45,
        fontWeight: 700,
        color: "var(--accent)",
      }}
    >
      {fallback}
    </div>
  );
}

// ─── MediaGrid ────────────────────────────────────────────────────────────────

function MediaGrid({ attachments }: { attachments: MediaAttachment[] }) {
  const [lbIdx, setLbIdx] = useState<number | null>(null);
  if (!attachments.length) return null;
  const cols = attachments.length === 1 ? 1 : 2;
  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: "0.25rem",
          marginTop: "0.75rem",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        {attachments.map((att, i) =>
          att.type === "image" || att.type === "gifv" ? (
            <button
              key={att.id}
              type="button"
              onClick={() => setLbIdx(i)}
              title={att.description ?? undefined}
              style={{
                display: "block",
                aspectRatio: attachments.length === 1 ? "16/9" : "1/1",
                overflow: "hidden",
                border: "none",
                padding: 0,
                cursor: "zoom-in",
                background: "none",
              }}
            >
              <img
                src={att.preview_url ?? att.url}
                alt={att.description ?? ""}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
            </button>
          ) : att.type === "video" ? (
            <button
              key={att.id}
              type="button"
              onClick={() => setLbIdx(i)}
              style={{
                display: "block",
                aspectRatio: "16/9",
                overflow: "hidden",
                border: "none",
                padding: 0,
                cursor: "pointer",
                background: "var(--bg-elevated)",
                position: "relative",
              }}
            >
              <video src={att.url} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "2rem",
                }}
              >
                ▶
              </div>
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
          media={attachments.map((a) => ({
            url: a.url,
            preview_url: a.preview_url,
            description: a.description,
            type: a.type,
          }))}
          index={lbIdx}
          onClose={() => setLbIdx(null)}
          onNav={setLbIdx}
        />
      )}
    </>
  );
}

// ─── PollView ─────────────────────────────────────────────────────────────────

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

// ─── Main Component ───────────────────────────────────────────────────────────

export default function TimelinesPage() {
  const [view, setView] = useState<TimelineView>("local");
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [me, setMe] = useState<Account | null>(null);
  const { t } = useLocale();

  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
  const viewRef = useRef<TimelineView>("local");
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());

  // Streaming: subscribe to the correct channel whenever the view changes
  const streamName = view === "local" ? "public:local" : "public";
  useTimelineStream(streamName, null, (event, payload) => {
    if (event !== "update") return;
    try {
      const status = JSON.parse(payload) as Status;
      if (seenIdsRef.current.has(status.id)) return;
      seenIdsRef.current.add(status.id);
      setStatuses((prev) => [status, ...prev]);
    } catch { /* ignore malformed payload */ }
  });

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Account);
  }

  async function fetchTimeline(v: TimelineView) {
    setLoading(true);
    setStatuses([]);
    seenIdsRef.current = new Set();
    const local = v === "local";
    const res = await fetch(`/api/v1/timelines/public?limit=40${local ? "&local=true" : ""}`);
    if (res.ok) {
      const data = await res.json() as Status[];
      setStatuses(data);
      // Pre-fill the seen set so streaming duplicates are filtered out
      for (const s of data) seenIdsRef.current.add(s.id);
    }
    setLoading(false);
  }

  async function loadMore() {
    if (loadingMore || statuses.length === 0) return;
    setLoadingMore(true);
    const lastId = statuses[statuses.length - 1].id;
    const local = view === "local";
    const res = await fetch(
      `/api/v1/timelines/public?max_id=${encodeURIComponent(lastId)}&limit=20${local ? "&local=true" : ""}`
    );
    if (res.ok) {
      const more = await res.json() as Status[];
      setStatuses((prev) => [...prev, ...more]);
    }
    setLoadingMore(false);
  }

  async function toggleAction(s: Status, action: "favourite" | "reblog") {
    if (!token) return;
    const isActive = action === "favourite" ? s.favourited : s.reblogged;
    const path =
      action === "favourite"
        ? isActive ? "unfavourite" : "favourite"
        : isActive ? "unreblog" : "reblog";
    const res = await fetch(`/api/v1/statuses/${encodeURIComponent(s.id)}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setStatuses((prev) =>
        prev.map((x) =>
          x.id !== s.id
            ? x
            : {
                ...x,
                favourited: action === "favourite" ? !isActive : x.favourited,
                reblogged: action === "reblog" ? !isActive : x.reblogged,
                favourites_count:
                  action === "favourite"
                    ? x.favourites_count + (isActive ? -1 : 1)
                    : x.favourites_count,
                reblogs_count:
                  action === "reblog"
                    ? x.reblogs_count + (isActive ? -1 : 1)
                    : x.reblogs_count,
              }
        )
      );
    }
  }

  // Mount: initial load
  useEffect(() => {
    void fetchTimeline("local");
    void fetchMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // View change: reload timeline
  useEffect(() => {
    viewRef.current = view;
    void fetchTimeline(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Infinite scroll sentinel
  useEffect(() => {
    if (!bottomRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) void loadMore();
      },
      { threshold: 0.1 }
    );
    observer.observe(bottomRef.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses, loadingMore]);

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/timelines" />

      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        {/* Sticky header with tabs */}
        <div
          style={{
            padding: "0.875rem 1rem 0",
            borderBottom: "1px solid var(--border)",
            position: "sticky",
            top: 0,
            background: "var(--bg)",
            zIndex: 10,
          }}
        >
          <h1 style={{ fontWeight: 700, fontSize: "1.2rem", marginBottom: "0.75rem" }}>
            {t.nav_timelines}
          </h1>
          <div style={{ display: "flex" }}>
            {(["local", "federated"] as TimelineView[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className="btn btn-ghost"
                style={{
                  flex: 1,
                  borderRadius: 0,
                  padding: "0.6rem 1rem",
                  borderBottom: view === v ? "2px solid var(--accent)" : "2px solid transparent",
                  color: view === v ? "var(--accent)" : "var(--text-muted)",
                  fontWeight: view === v ? 600 : 400,
                }}
              >
                {v === "local" ? `🏘️ ${t.timeline_local}` : `🌐 ${t.timeline_federated}`}
              </button>
            ))}
          </div>
        </div>



        {/* Loading skeletons */}
        {loading && (
          <div>
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: "0.875rem",
                  padding: "1rem",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div
                  className="skeleton"
                  style={{ width: 42, height: 42, borderRadius: "50%", flexShrink: 0 }}
                />
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <div className="skeleton" style={{ height: 13, width: "40%" }} />
                  <div className="skeleton" style={{ height: 13, width: "80%" }} />
                  <div className="skeleton" style={{ height: 13, width: "60%" }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && statuses.length === 0 && (
          <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
            <span style={{ fontSize: "2.5rem", display: "block", marginBottom: "0.75rem" }}>
              {view === "local" ? "🏘️" : "🌐"}
            </span>
            <p style={{ fontWeight: 600 }}>
              {view === "local" ? t.timeline_public_empty : t.timeline_federated_empty}
            </p>
          </div>
        )}

        {/* Status list */}
        {!loading && statuses.length > 0 && (
          <div>
            {statuses.map((s) => {
              const isRemote = s.account.acct.includes("@");
              const profileHref = isRemote
                ? `/users/remote?url=${encodeURIComponent(s.account.id)}`
                : `/users/${s.account.username}`;
              return (
                <article
                  key={s.id}
                  style={{
                    display: "flex",
                    gap: "0.875rem",
                    padding: "1rem",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <Link href={profileHref} style={{ flexShrink: 0 }}>
                    <AvatarBubble account={s.account} size={42} />
                  </Link>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: "0.4rem",
                        marginBottom: "0.25rem",
                        flexWrap: "wrap",
                      }}
                    >
                      <Link
                        href={profileHref}
                        style={{
                          fontWeight: 600,
                          fontSize: "0.9rem",
                          color: "var(--text)",
                          textDecoration: "none",
                        }}
                      >
                        {s.account.display_name || s.account.username}
                      </Link>
                      <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                        @{s.account.acct}
                      </span>
                      <Link
                        href={`/statuses/${encodeURIComponent(s.id)}`}
                        style={{
                          fontSize: "0.75rem",
                          color: "var(--text-muted)",
                          marginLeft: "auto",
                          textDecoration: "none",
                        }}
                      >
                        {formatTime(s.created_at)}
                      </Link>
                    </div>
                    {s.spoiler_text && (
                      <div
                        style={{
                          padding: "0.35rem 0.6rem",
                          background: "var(--bg-elevated)",
                          borderRadius: "var(--radius-sm)",
                          fontSize: "0.875rem",
                          marginBottom: "0.5rem",
                          color: "var(--text-secondary)",
                        }}
                      >
                        ⚠️ {s.spoiler_text}
                      </div>
                    )}
                    <div
                      style={{ fontSize: "0.95rem", lineHeight: 1.55, wordBreak: "break-word" }}
                      dangerouslySetInnerHTML={{ __html: s.content }}
                    />
                    {s.poll && <PollView poll={s.poll} token={token} />}
                    <MediaGrid attachments={s.media_attachments ?? []} />
                    <div
                      style={{
                        display: "flex",
                        gap: "1.25rem",
                        marginTop: "0.625rem",
                        color: "var(--text-muted)",
                        fontSize: "0.82rem",
                        alignItems: "center",
                      }}
                    >
                      <Link
                        href={`/statuses/${encodeURIComponent(s.id)}`}
                        style={{ color: "var(--text-muted)", textDecoration: "none" }}
                      >
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: "0.2rem 0.4rem" }}
                        >
                          💬 {s.replies_count}
                        </button>
                      </Link>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{
                          padding: "0.2rem 0.4rem",
                          color: s.reblogged ? "var(--accent)" : "var(--text-muted)",
                        }}
                        onClick={() => void toggleAction(s, "reblog")}
                        disabled={!token}
                      >
                        🔁 {s.reblogs_count}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{
                          padding: "0.2rem 0.4rem",
                          color: s.favourited ? "var(--danger)" : "var(--text-muted)",
                        }}
                        onClick={() => void toggleAction(s, "favourite")}
                        disabled={!token}
                      >
                        {s.favourited ? "❤️" : "🤍"} {s.favourites_count}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
            <div ref={bottomRef} style={{ height: 1 }} />
            {loadingMore && (
              <div
                style={{
                  padding: "1rem",
                  textAlign: "center",
                  color: "var(--text-muted)",
                  fontSize: "0.875rem",
                }}
              >
                {t.loading}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Right panel — join CTA if not logged in */}
      {!token && (
        <div className="hidden lg:block" style={{ width: 300, padding: "1.5rem 1rem" }}>
          <div
            style={{
              background: "var(--bg-elevated)",
              borderRadius: "var(--radius-lg)",
              border: "1px solid var(--border)",
              padding: "1rem",
            }}
          >
            <h3 style={{ fontWeight: 700, marginBottom: "0.75rem", fontSize: "0.95rem" }}>
              {t.explore_join}
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <Link
                href="/register"
                className="btn btn-primary btn-sm"
                style={{ textAlign: "center" }}
              >
                {t.explore_create}
              </Link>
              <Link
                href="/login"
                className="btn btn-ghost btn-sm"
                style={{ textAlign: "center" }}
              >
                {t.explore_signin}
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
