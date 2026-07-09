"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { useLocale } from "@/lib/i18n";
import { useTimelineStream } from "@/lib/streaming/use-timeline-stream";

interface SidebarAccount {
  username: string;
  display_name: string;
  acct: string;
}

interface SidebarProps {
  me?: SidebarAccount | null;
  currentPath: string;
}

export function Sidebar({ me, currentPath }: SidebarProps) {
  const { t, locale, setLocale } = useLocale();
  const [unreadCount, setUnreadCount] = useState(0);
  const [token, setToken] = useState<string | null>(null);
  // Start with "light" to match SSR; useEffect corrects from localStorage without hydration mismatch
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const saved = localStorage.getItem("theme") as "light" | "dark" | null;
    const resolved: "light" | "dark" =
      saved === "light" || saved === "dark"
        ? saved
        : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    setTheme(resolved);
    document.documentElement.setAttribute("data-theme", resolved);
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("theme", next);
    document.documentElement.setAttribute("data-theme", next);
  }

  // Read token once on mount (localStorage not available during SSR)
  useEffect(() => {
    setToken(localStorage.getItem("access_token"));
  }, []);

  // One-time fetch for existing unread count on mount
  useEffect(() => {
    if (!token) return;
    fetch("/api/v1/notifications/unread_count", {
      headers: { Authorization: `Bearer ${token}` },
    }).then(async (res) => {
      if (res.status === 401) {
        localStorage.removeItem("access_token");
        setToken(null);
        return;
      }
      if (res.ok) {
        const data = await res.json() as { count: number };
        setUnreadCount(data.count);
      }
    }).catch(() => {});
  }, [token]);

  // Real-time notification count via WebSocket streaming (no polling)
  useTimelineStream("user", token, (event) => {
    if (event === "notification") {
      setUnreadCount((c) => c + 1);
    }
  }, { enabled: !!token });

  function handleLogout() {
    localStorage.removeItem("access_token");
    window.location.href = "/login";
  }

  const navItems = [
    { label: t.nav_home, icon: "🏠", href: "/home", badge: 0 },
    { label: t.nav_explore, icon: "🔍", href: "/explore", badge: 0 },
    { label: t.nav_timelines, icon: "🌐", href: "/timelines", badge: 0 },
    { label: t.nav_notifications, icon: "🔔", href: "/notifications", badge: unreadCount, onClick: () => setUnreadCount(0) },
    { label: t.nav_messages, icon: "💬", href: "/messages", badge: 0 },
    { label: t.nav_bookmarks, icon: "🔖", href: "/bookmarks", badge: 0 },
    { label: t.nav_favourites, icon: "❤️", href: "/favourites", badge: 0 },
    { label: t.nav_lists, icon: "📋", href: "/lists", badge: 0 },
    { label: t.nav_followed_tags, icon: "🏷️", href: "/followed_tags", badge: 0 },
    { label: t.nav_mutes, icon: "🤫", href: "/mutes", badge: 0 },
    { label: t.nav_scheduled, icon: "📅", href: "/scheduled", badge: 0 },
    { label: t.nav_profile, icon: "👤", href: me ? `/users/${me.username}` : "/login", badge: 0 },
    { label: t.nav_settings, icon: "⚙️", href: "/settings", badge: 0 },
    { label: "Bloqueos", icon: "🚫", href: "/blocks", badge: 0 },
    { label: "Emojis", icon: "😊", href: "/emojis", badge: 0 },
  ];

  return (
    <>
    <aside
      className="hidden md:flex"
      style={{
        width: 260,
        flexShrink: 0,
        padding: "1.5rem 1rem",
        borderRight: "1px solid var(--border)",
        position: "sticky",
        top: 0,
        height: "100vh",
        flexDirection: "column",
        gap: "1.5rem",
      }}
    >
      {/* Logo */}
      <Link href="/" className="flex items-center gap-2 px-2">
        <Image src="/logo.svg" alt="CF ActivityPub" width={32} height={32} />
        <span style={{ fontWeight: 700, fontSize: "1.1rem" }}>CF ActivityPub</span>
      </Link>

      {/* Nav */}
      <nav className="flex flex-col gap-1">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={item.onClick}
            className="btn btn-ghost"
            style={{
              justifyContent: "flex-start",
              gap: "0.75rem",
              padding: "0.625rem 0.875rem",
              background: currentPath === item.href ? "var(--accent-bg)" : undefined,
            }}
          >
            <span style={{ position: "relative", display: "inline-flex" }}>
              {item.icon}
              {item.badge > 0 && (
                <span
                  style={{
                    position: "absolute",
                    top: -5,
                    right: -8,
                    background: "var(--danger, #e11d48)",
                    color: "white",
                    borderRadius: "99px",
                    fontSize: "0.6rem",
                    fontWeight: 700,
                    padding: "0.1rem 0.28rem",
                    minWidth: 14,
                    lineHeight: "1.4",
                    textAlign: "center",
                    pointerEvents: "none",
                  }}
                >
                  {item.badge > 99 ? "99+" : item.badge}
                </span>
              )}
            </span>
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>

      {/* Bottom: language toggle + user info + logout */}
      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <button
          onClick={toggleTheme}
          className="btn btn-ghost btn-sm"
          style={{ width: "100%", justifyContent: "space-between" }}
          title={theme === "dark" ? t.theme_dark : t.theme_light}
        >
          <span>{theme === "dark" ? "🌙" : "☀️"}</span>
          <span>{theme === "dark" ? t.theme_dark : t.theme_light}</span>
        </button>

        {/* Language toggle */}
        <div style={{ display: "flex", gap: "0.375rem" }}>
          <button
            onClick={() => setLocale("en")}
            className="btn btn-ghost btn-sm"
            style={{
              flex: 1,
              fontWeight: locale === "en" ? 700 : 400,
              background: locale === "en" ? "var(--accent-bg)" : undefined,
              color: locale === "en" ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            EN
          </button>
          <button
            onClick={() => setLocale("es")}
            className="btn btn-ghost btn-sm"
            style={{
              flex: 1,
              fontWeight: locale === "es" ? 700 : 400,
              background: locale === "es" ? "var(--accent-bg)" : undefined,
              color: locale === "es" ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            ES
          </button>
        </div>

        {/* User info + logout */}
        {me ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.625rem",
              padding: "0.625rem 0.75rem",
              borderRadius: "var(--radius)",
              background: "var(--bg-elevated)",
            }}
          >
            <div
              className="avatar"
              style={{
                width: 34,
                height: 34,
                flexShrink: 0,
                background: "var(--accent-bg)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "1.1rem",
              }}
            >
              {(me.display_name?.[0] ?? me.username?.[0] ?? "?").toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {me.display_name || me.username}
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>@{me.acct}</div>
            </div>
            <button
              onClick={handleLogout}
              className="btn btn-ghost btn-sm"
              style={{ flexShrink: 0, padding: "0.3rem 0.45rem", fontSize: "1rem", lineHeight: 1 }}
              title={t.nav_logout}
            >
              🚪
            </button>
          </div>
        ) : (
          <button
            onClick={handleLogout}
            className="btn btn-ghost btn-sm"
            style={{ width: "100%", justifyContent: "center", color: "var(--text-muted)" }}
          >
            🚪 {t.nav_logout}
          </button>
        )}
      </div>
    </aside>

    {/* Mobile bottom navigation bar */}
    <nav
      className="flex md:hidden"
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        background: "var(--bg-surface)",
        borderTop: "1px solid var(--border)",
        justifyContent: "space-around",
        alignItems: "stretch",
        height: 56,
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      {navItems.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.15rem",
            fontSize: "1.3rem",
            color: currentPath === item.href ? "var(--accent)" : "var(--text-muted)",
            textDecoration: "none",
            position: "relative",
            background: currentPath === item.href ? "var(--accent-bg)" : undefined,
          }}
          title={item.label}
        >
          <span style={{ position: "relative", display: "inline-flex" }}>
            {item.icon}
            {item.badge > 0 && (
              <span
                style={{
                  position: "absolute",
                  top: -4,
                  right: -8,
                  background: "var(--danger, #e11d48)",
                  color: "white",
                  borderRadius: "99px",
                  fontSize: "0.55rem",
                  fontWeight: 700,
                  padding: "0.1rem 0.25rem",
                  minWidth: 13,
                  lineHeight: "1.4",
                  textAlign: "center",
                  pointerEvents: "none",
                }}
              >
                {item.badge > 99 ? "99+" : item.badge}
              </span>
            )}
          </span>
        </Link>
      ))}
      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "1.3rem",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-muted)",
        }}
        title={theme === "dark" ? t.theme_dark : t.theme_light}
      >
        {theme === "dark" ? "🌙" : "☀️"}
      </button>
    </nav>
    </>
  );
}
