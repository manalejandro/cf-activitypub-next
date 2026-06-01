"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
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
            <button
              key={att.id}
              type="button"
              onClick={() => setLbIdx(i)}
              style={{
                display: "block",
                aspectRatio: "3/1",
                overflow: "hidden",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: 0,
                cursor: "pointer",
                background: "var(--bg-elevated)",
                position: "relative",
              }}
            >
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
                🎵
              </div>
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

// ─── Main Component ───────────────────────────────────────────────────────────

export default function HashtagPage() {
  const params = useParams();
  const hashtag = typeof params.hashtag === "string" ? params.hashtag : "";

  const [statuses, setStatuses] = useState<Status[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [me, setMe] = useState<{ id: string; username: string; display_name: string; avatar: string; acct: string } | null>(null);
  const { t } = useLocale();

  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());

  // Real-time hashtag streaming
  useTimelineStream("hashtag", null, (event, payload) => {
    if (event !== "update") return;
    try {
      const status = JSON.parse(payload) as Status;
      if (seenIdsRef.current.has(status.id)) return;
      seenIdsRef.current.add(status.id);
      setStatuses((prev) => [status, ...prev]);
    } catch { /* ignore */ }
  }, { enabled: !!hashtag, extraParams: hashtag ? { tag: hashtag.toLowerCase() } : undefined });

  async function fetchTimeline() {
    setLoading(true);
    setHasMore(true);
    seenIdsRef.current = new Set();
    const res = await fetch(`/api/v1/timelines/tag/${encodeURIComponent(hashtag)}?limit=20`);
    if (res.ok) {
      const data = await res.json() as Status[];
      setStatuses(data);
      for (const s of data) seenIdsRef.current.add(s.id);
      if (data.length < 20) setHasMore(false);
    }
    setLoading(false);
  }

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as typeof me);
  }

  async function loadMore() {
    if (loadingMore || !hasMore || statuses.length === 0) return;
    setLoadingMore(true);
    const lastId = statuses[statuses.length - 1].id;
    const res = await fetch(
      `/api/v1/timelines/tag/${encodeURIComponent(hashtag)}?max_id=${encodeURIComponent(lastId)}&limit=20`
    );
    if (res.ok) {
      const more = await res.json() as Status[];
      setStatuses((prev) => [...prev, ...more]);
      if (more.length < 20) setHasMore(false);
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

  useEffect(() => {
    if (!hashtag) return;
    void fetchTimeline();
    void fetchMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hashtag]);

  // Infinite scroll
  useEffect(() => {
    if (!bottomRef.current || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) void loadMore();
      },
      { threshold: 0.1 }
    );
    observer.observe(bottomRef.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses, loadingMore, hasMore]);

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath={`/tags/${hashtag}`} />

      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        {/* Header */}
        <div
          style={{
            padding: "0.875rem 1rem",
            borderBottom: "1px solid var(--border)",
            position: "sticky",
            top: 0,
            background: "var(--bg)",
            zIndex: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={() => history.back()}
              className="btn btn-ghost btn-sm"
              style={{ padding: "0.3rem 0.5rem", fontSize: "1rem" }}
            >
              ←
            </button>
            <div>
              <h1 style={{ fontWeight: 700, fontSize: "1.15rem", margin: 0 }}>
                #{hashtag}
              </h1>
              <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", margin: 0 }}>
                {t.hashtag_timeline} #{hashtag}
              </p>
            </div>
          </div>
        </div>

        {/* Loading skeletons */}
        {loading && (
          <div>
            {[1, 2, 3].map((i) => (
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
            <span style={{ fontSize: "2.5rem", display: "block", marginBottom: "0.75rem" }}>#️⃣</span>
            <p style={{ fontWeight: 600 }}>{t.hashtag_empty}</p>
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
                    <MediaGrid attachments={s.media_attachments ?? []} />
                    <div
                      style={{
                        display: "flex",
                        gap: "1.25rem",
                        marginTop: "0.625rem",
                        color: "var(--text-muted)",
                        fontSize: "0.82rem",
                      }}
                    >
                      <Link
                        href={`/statuses/${encodeURIComponent(s.id)}`}
                        style={{ color: "var(--text-muted)", textDecoration: "none" }}
                      >
                        <span>💬 {s.replies_count}</span>
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
            <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
              {loadingMore ? t.loading : hasMore ? "" : ""}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
