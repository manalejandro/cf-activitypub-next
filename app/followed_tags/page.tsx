"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";

interface Tag {
  name: string;
  url: string;
  following: boolean;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

export default function FollowedTagsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [unfollowing, setUnfollowing] = useState<string | null>(null);
  const token = getToken();
  const { t } = useLocale();

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    void fetchMe();
    void fetchTags();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchTags() {
    if (!token) return;
    setLoading(true);
    const res = await fetch("/api/v1/followed_tags", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setTags(await res.json() as Tag[]);
    setLoading(false);
  }

  async function handleUnfollow(name: string) {
    if (!token) return;
    setUnfollowing(name);
    await fetch(`/api/v1/tags/${encodeURIComponent(name)}/unfollow`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    setTags((prev) => prev.filter((t) => t.name !== name));
    setUnfollowing(null);
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/followed_tags" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10 }}>
          <h1 className="text-lg font-bold">{t.followed_tags_title}</h1>
        </div>
        {loading ? (
          <div className="p-4" style={{ color: "var(--text-muted)" }}>{t.loading}</div>
        ) : tags.length === 0 ? (
          <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>🏷️</div>
            <div style={{ fontWeight: 600 }}>{t.followed_tags_empty}</div>
            <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>{t.followed_tags_empty_sub}</div>
          </div>
        ) : (
          tags.map((tag) => (
            <div key={tag.name} className="flex items-center gap-3" style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)" }}>
              <Link href={`/tags/${encodeURIComponent(tag.name)}`} style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: "0.9rem", color: "var(--accent)", textDecoration: "none" }}>
                #{tag.name}
              </Link>
              <button
                className="btn btn-ghost btn-sm"
                style={{ flexShrink: 0, color: "var(--text-muted)" }}
                onClick={() => void handleUnfollow(tag.name)}
                disabled={unfollowing === tag.name}
              >
                {unfollowing === tag.name ? "…" : t.followed_tags_unfollow}
              </button>
            </div>
          ))
        )}
      </main>
    </div>
  );
}
