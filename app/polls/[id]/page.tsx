"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { getToken } from "@/lib/client-api";

interface PollOption {
  title: string;
  votes_count: number | null;
}

interface EmojiData {
  shortcode: string;
  url: string;
  static_url: string;
}

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
  emojis: EmojiData[];
}

function formatTimeLeft(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "Closed";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m ${s}s left`;
  return `${s}s left`;
}

export default function PollPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = getToken();

  const rawId = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? params.id[0] : "";
  const pollId = decodeURIComponent(rawId);
  const statusId = searchParams.get("status");

  const [poll, setPoll] = useState<Poll | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<number[]>([]);
  const [voting, setVoting] = useState(false);

  useEffect(() => {
    if (!pollId) return;
    setLoading(true);
    async function load() {
      try {
        const res = await fetch(`/api/v1/polls/${encodeURIComponent(pollId)}`, {
          credentials: "include",
        });
        if (res.ok) {
          const data = (await res.json()) as Poll;
          setPoll(data);
          if (data.voted && data.own_votes) {
            setSelected(data.own_votes);
          }
        }
      } catch (e) {
        console.error("Failed to load poll", e);
      }
      setLoading(false);
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollId]);

  const showResults = !!poll && (poll.voted || poll.expired);
  const canVote = !!poll && !poll.voted && !poll.expired && !!token;

  async function handleVote() {
    if (!poll || !token || voting || selected.length === 0) return;
    setVoting(true);
    try {
      const res = await fetch(`/api/v1/polls/${poll.id}/votes`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choices: selected }),
      });
      if (res.ok) {
        setPoll((await res.json()) as Poll);
      }
    } finally {
      setVoting(false);
    }
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={null} currentPath="" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        <div
          style={{
            position: "sticky",
            top: 0,
            background: "var(--bg)",
            borderBottom: "1px solid var(--border)",
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            gap: "1rem",
            padding: "0.75rem 1rem",
          }}
        >
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => router.back()}
            style={{ fontSize: "1.1rem" }}
          >
            ←
          </button>
          <span style={{ fontWeight: 600 }}>Poll</span>
        </div>

        {loading ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
            Loading poll...
          </div>
        ) : !poll ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
            Poll not found.
          </div>
        ) : (
          <div style={{ padding: "1.25rem" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {poll.options.map((opt, i) => {
                const total = poll.votes_count > 0 ? poll.votes_count : 1;
                const pct =
                  showResults && opt.votes_count != null
                    ? Math.round((opt.votes_count / total) * 100)
                    : 0;
                const isOwn = poll.own_votes.includes(i) || selected.includes(i);

                if (showResults) {
                  return (
                    <div
                      key={i}
                      style={{
                        position: "relative",
                        borderRadius: "var(--radius-sm)",
                        overflow: "hidden",
                        background: "var(--bg-elevated)",
                        padding: "0.5rem 0.75rem",
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: `${pct}%`,
                          background: isOwn
                            ? "var(--accent-bg)"
                            : "color-mix(in srgb, var(--accent-bg) 40%, transparent)",
                          transition: "width 0.5s ease",
                        }}
                      />
                      <div
                        style={{
                          position: "relative",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          fontSize: "0.9rem",
                        }}
                      >
                        <span style={{ fontWeight: isOwn ? 600 : 400 }}>
                          {opt.title}
                          {isOwn ? " ✓" : ""}
                        </span>
                        <span style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
                          {pct}%
                          {opt.votes_count != null ? ` (${opt.votes_count})` : ""}
                        </span>
                      </div>
                    </div>
                  );
                }

                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      if (poll.multiple) {
                        setSelected((p) =>
                          p.includes(i) ? p.filter((x) => x !== i) : [...p, i],
                        );
                      } else {
                        setSelected([i]);
                      }
                    }}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "0.5rem 0.75rem",
                      border: `1.5px solid ${selected.includes(i) ? "var(--accent)" : "var(--border)"}`,
                      borderRadius: "var(--radius-sm)",
                      background: selected.includes(i)
                        ? "var(--accent-bg)"
                        : "transparent",
                      cursor: "pointer",
                      fontSize: "0.9rem",
                      color: "var(--text)",
                      display: "flex",
                      alignItems: "center",
                      gap: "0.65rem",
                    }}
                  >
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: poll.multiple ? "3px" : "50%",
                        border: `2px solid ${selected.includes(i) ? "var(--accent)" : "var(--border)"}`,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        background: selected.includes(i)
                          ? "var(--accent)"
                          : "transparent",
                      }}
                    >
                      {selected.includes(i) && (
                        <span
                          style={{
                            color: "#fff",
                            fontSize: "0.6rem",
                            lineHeight: 1,
                          }}
                        >
                          {poll.multiple ? "✓" : "●"}
                        </span>
                      )}
                    </span>
                    {opt.title}
                  </button>
                );
              })}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                flexWrap: "wrap",
                marginTop: "0.75rem",
              }}
            >
              {canVote && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={selected.length === 0 || voting}
                  onClick={() => void handleVote()}
                >
                  {voting ? "…" : "Vote"}
                </button>
              )}
              <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
                {poll.votes_count} vote{poll.votes_count !== 1 ? "s" : ""}
                {poll.voters_count != null &&
                  ` · ${poll.voters_count} voter${poll.voters_count !== 1 ? "s" : ""}`}
                {poll.expires_at && (
                  <>
                    {" · "}
                    {poll.expired ? "Closed" : formatTimeLeft(poll.expires_at)}
                  </>
                )}
                {poll.multiple && " · Multiple choice"}
              </span>
            </div>

            {statusId && (
              <div
                style={{
                  marginTop: "1rem",
                  borderTop: "1px solid var(--border)",
                  paddingTop: "0.75rem",
                }}
              >
                <Link
                  href={`/statuses/${encodeURIComponent(statusId)}`}
                  style={{
                    fontSize: "0.85rem",
                    color: "var(--accent)",
                    textDecoration: "none",
                  }}
                >
                  ← View original post
                </Link>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
