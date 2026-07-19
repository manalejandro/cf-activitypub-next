"use client";

import { useState, useEffect, useRef } from "react";
import { Sidebar } from "@/components/Sidebar";
import { getToken } from "@/lib/client-api";

interface FeaturedTag {
  id: string;
  name: string;
  statuses_count: number;
}

interface Suggestion {
  name: string;
  statuses_count: number;
}

export default function FeaturedTagsPage() {
  const [tags, setTags] = useState<FeaturedTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTagName, setNewTagName] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = getToken();
  const wrapperRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!token) { window.location.href = "/login"; return; }
    void fetchTags();
    void fetchSuggestions();
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function fetchTags() {
    if (!token) return;
    setLoading(true);
    const res = await fetch("/api/v1/featured_tags", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setTags(await res.json() as FeaturedTag[]);
    setLoading(false);
  }

  async function fetchSuggestions() {
    if (!token) return;
    const res = await fetch("/api/v1/featured_tags/suggestions", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setSuggestions(await res.json() as Suggestion[]);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newTagName.trim().toLowerCase();
    if (!name || !token) return;
    setError(null);
    setCreating(true);
    const res = await fetch("/api/v1/featured_tags", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const tag = await res.json() as FeaturedTag;
      setTags((prev) => [tag, ...prev]);
      setNewTagName("");
      setShowSuggestions(false);
      setSuggestions((prev) => prev.filter((s) => s.name !== name));
    } else {
      const err = await res.json() as { error?: string };
      setError(err.error ?? "Error creating tag");
    }
    setCreating(false);
  }

  async function handleDelete(tag: FeaturedTag) {
    if (!token) return;
    setDeletingId(tag.id);
    const res = await fetch(`/api/v1/featured_tags/${encodeURIComponent(tag.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setTags((prev) => prev.filter((t) => t.id !== tag.id));
    }
    setDeletingId(null);
  }

  const filteredSuggestions = suggestions.filter(
    (s) => !newTagName || s.name.includes(newTagName.toLowerCase())
  );

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar currentPath="/settings" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        <div style={{ position: "sticky", top: 0, background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10 }}>
          <h1 style={{ fontWeight: 700, fontSize: "1.25rem" }}>Featured Tags</h1>
        </div>

        {/* Create form */}
        <div style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}>
          <form onSubmit={handleCreate} style={{ display: "flex", gap: "0.5rem", position: "relative" }} ref={wrapperRef}>
            <div style={{ flex: 1, position: "relative" }}>
              <input
                type="text"
                value={newTagName}
                onChange={(e) => {
                  setNewTagName(e.target.value.replace(/[^a-zA-Z0-9_\u00C0-\u024F]/g, ""));
                  setShowSuggestions(true);
                }}
                onFocus={() => setShowSuggestions(true)}
                placeholder="Search or add a tag"
                style={{ width: "100%", padding: "0.5rem 0.75rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: "0.9rem", fontFamily: "inherit", boxSizing: "border-box" }}
                maxLength={64}
              />
              {showSuggestions && filteredSuggestions.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--radius)", marginTop: "2px", maxHeight: 200, overflowY: "auto", zIndex: 20 }}>
                  {filteredSuggestions.map((s) => (
                    <button
                      key={s.name}
                      type="button"
                      onClick={() => {
                        setNewTagName(s.name);
                        setShowSuggestions(false);
                      }}
                      style={{ display: "flex", justifyContent: "space-between", width: "100%", padding: "0.5rem 0.75rem", background: "none", border: "none", cursor: "pointer", textAlign: "left", fontSize: "0.9rem", color: "var(--text)", fontFamily: "inherit" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-bg)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                    >
                      <span>#{s.name}</span>
                      <span style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>{s.statuses_count} posts</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={creating || !newTagName.trim()}>
              {creating ? "…" : "Feature"}
            </button>
          </form>
          {error && (
            <div style={{ color: "var(--danger)", fontSize: "0.82rem", marginTop: "0.375rem" }}>{error}</div>
          )}
        </div>

        {/* Tag list */}
        {loading ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>
        ) : tags.length === 0 ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
            No featured tags yet. Feature a tag above to show it on your profile.
          </div>
        ) : (
          tags.map((tag) => (
            <div key={tag.id} style={{ display: "flex", alignItems: "center", gap: "0.875rem", padding: "0.875rem 1rem", borderBottom: "1px solid var(--border)" }}>
              <div style={{ width: 40, height: 40, flexShrink: 0, borderRadius: "var(--radius)", background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.25rem", fontWeight: 700, color: "var(--accent)" }}>
                #
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>#{tag.name}</div>
                <div style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>{tag.statuses_count} posts</div>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                style={{ background: "var(--danger, #e11d48)", color: "#fff", border: "none", borderRadius: "var(--radius)", padding: "0.35rem 0.875rem", cursor: "pointer", fontWeight: 600, fontSize: "0.85rem" }}
                disabled={deletingId === tag.id}
                onClick={() => handleDelete(tag)}
              >
                {deletingId === tag.id ? "…" : "Remove"}
              </button>
            </div>
          ))
        )}
      </main>
    </div>
  );
}
