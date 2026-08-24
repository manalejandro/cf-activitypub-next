"use client";

import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import Image from "next/image";
import { getToken } from "@/lib/client-api";
import { useLocale } from "@/lib/i18n";
import { useTimelineStream } from "@/lib/streaming/use-timeline-stream";
import { Icon } from "@/components/Icon";

interface SidebarAccount {
  username: string;
  display_name: string;
  acct: string;
  roles?: { id?: string; name: string; color?: string }[];
}

interface SidebarProps {
  me?: SidebarAccount | null;
  currentPath: string;
}

export function Sidebar({ me: propMe, currentPath }: SidebarProps) {
  const { t } = useLocale();
  const [unreadCount, setUnreadCount] = useState(0);
  const [version, setVersion] = useState<string | null>(null);
  const [localMe, setLocalMe] = useState<SidebarAccount | null | undefined>(propMe);
  const me = propMe ?? localMe;
  const isStaff = me?.roles?.some((r) => r.name.toLowerCase() === "admin" || r.name.toLowerCase() === "moderator") ?? false;
  const [menuOpen, setMenuOpen] = useState(false);
  const topBarRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  // Client-only flag so the mobile top bar (rendered via portal) never runs on
  // the server, avoiding a hydration mismatch. False during SSR, true on client.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  // Start with "light" to match SSR; effect corrects from localStorage without hydration mismatch
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    Promise.resolve().then(() => {
      const saved = localStorage.getItem("theme") as "light" | "dark" | null;
      const resolved: "light" | "dark" =
        saved === "light" || saved === "dark"
          ? saved
          : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
      setTheme(resolved);
      document.documentElement.setAttribute("data-theme", resolved);
    });
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("theme", next);
    document.documentElement.setAttribute("data-theme", next);
  }

  // One-time fetch for existing unread count on mount
  useEffect(() => {
    fetch("/api/v1/notifications/unread_count", { credentials: "include", cache: "no-store" }).then(async (res) => {
      if (res.ok) {
        const data = await res.json() as { count: number };
        setUnreadCount(data.count);
      }
    }).catch(() => {});
  }, []);

  // Fetch the instance version for the logo caption.
  useEffect(() => {
    fetch("/api/v1/instance").then(async (res) => {
      if (res.ok) {
        const data = await res.json() as { version?: string };
        if (data.version) {
          const m = data.version.match(/compatible;\s*([^)]+)/);
          setVersion(m ? m[1] : data.version);
        }
      }
    }).catch(() => {});
  }, []);

  // Self-fetch current user info when page doesn't pass `me` prop
  useEffect(() => {
    if (propMe !== undefined) return;
    Promise.resolve().then(() => {
      const token = getToken();
      if (!token) { setLocalMe(null); return; }
      fetch("/api/v1/accounts/verify_credentials", {
        headers: { Authorization: `Bearer ${token}` },
      }).then(async (res) => {
        if (res.ok) {
          const data = await res.json() as SidebarAccount;
          setLocalMe(data);
        } else {
          setLocalMe(null);
        }
      }).catch(() => setLocalMe(null));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real-time notification count via WebSocket streaming (no polling)
  useTimelineStream("user", (event) => {
    if (event === "notification") {
      setUnreadCount((c) => c + 1);
    }
  }, {
    onReconnect: () => {
      // Re-sync after a reconnect gap so the badge doesn't go stale while the
      // socket was down (increments are missed for that window).
      fetch("/api/v1/notifications/unread_count", { credentials: "include", cache: "no-store" })
        .then((res) => (res.ok ? res.json() as Promise<{ count: number }> : null))
        .then((data) => { if (data) setUnreadCount(data.count); })
        .catch(() => {});
    },
  });

  // Mobile browsers move `position: fixed; top: 0` behind the URL bar when it
  // expands/collapses during scroll, leaving a gap above the header. Sync the
  // bar's top (and the drawer's) to the visual viewport so they hug the visible
  // top edge. Depends on `mounted`: the portal bar only exists on the client,
  // so the ref is null until `mounted` flips to true.
  useEffect(() => {
    if (!mounted) return;
    const bar = topBarRef.current;
    const drawer = drawerRef.current;
    if (!bar || !window.visualViewport) return;
    const sync = () => {
      const top = window.visualViewport!.offsetTop;
      bar.style.top = `${top}px`;
      if (drawer) drawer.style.top = `${top + 56}px`;
    };
    sync();
    window.visualViewport.addEventListener("scroll", sync);
    window.visualViewport.addEventListener("resize", sync);
    return () => {
      window.visualViewport!.removeEventListener("scroll", sync);
      window.visualViewport!.removeEventListener("resize", sync);
    };
  }, [mounted, menuOpen]);

  // Close the mobile drawer with Escape
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    window.location.href = "/login";
  }

  const navItems = [
    { label: t.nav_home, icon: "home", href: "/home", badge: 0 },
    { label: t.nav_explore, icon: "search", href: "/explore", badge: 0 },
    { label: t.nav_timelines, icon: "globe", href: "/timelines", badge: 0 },
    { label: t.nav_notifications, icon: "bell", href: "/notifications", badge: unreadCount, onClick: () => setUnreadCount(0) },
    { label: t.nav_messages, icon: "comment", href: "/messages", badge: 0 },
    { label: t.nav_e2ee, icon: "lock", href: "/e2ee", badge: 0 },
    { label: t.nav_bookmarks, icon: "bookmark", href: "/bookmarks", badge: 0 },
    { label: t.nav_favourites, icon: "heart", href: "/favourites", badge: 0 },
    { label: t.nav_lists, icon: "list-alt", href: "/lists", badge: 0 },
    { label: t.nav_collections, icon: "users", href: "/collections", badge: 0 },
    { label: t.nav_followed_tags, icon: "tags", href: "/followed_tags", badge: 0 },
    { label: t.nav_mutes, icon: "microphone-slash", href: "/mutes", badge: 0 },
    { label: t.nav_scheduled, icon: "calendar", href: "/scheduled", badge: 0 },
    { label: t.nav_profile, icon: "user", href: me ? `/users/${me.username}` : "/login", badge: 0 },
    { label: t.nav_settings, icon: "cog", href: "/settings", badge: 0 },
    { label: t.nav_blocks, icon: "ban", href: "/blocks", badge: 0 },
    { label: t.nav_announcements, icon: "bullhorn", href: "/announcements", badge: 0 },
  ];

  if (isStaff) {
    navItems.push({ label: t.nav_emojis, icon: "smile-o", href: "/emojis", badge: 0 });
    navItems.push({ label: t.nav_admin, icon: "shield", href: "/admin", badge: 0 });
  }

  return (
    <>
    <aside
      aria-label={t.a11y_primary_nav}
      style={{
        width: 260,
        flexShrink: 0,
        position: "sticky",
        top: 0,
        height: "100vh",
        overflowY: "auto",
        padding: "1rem 1rem 1.5rem",
        borderRight: "1px solid var(--border)",
        flexDirection: "column",
        gap: "1.5rem",
        overflowX: "hidden",
      }}
      className="hidden md:flex sidebar-scroll"
    >
      {/* Logo */}
      <Link href="/" className="flex items-center gap-2 px-2">
        <Image src="/logo.svg" alt="CF ActivityPub" width={32} height={32} />
        <span style={{ fontWeight: 700, fontSize: "1rem" }}>CF ActivityPub</span>
        {version && (
          <span style={{ fontSize: "0.7rem", fontWeight: 400, color: "var(--accent-light)", opacity: 0.75 }}>v{version}</span>
        )}
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
              <Icon name={item.icon} fixedWidth />
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
          style={{ width: "100%", justifyContent: "flex-start", gap: "0.75rem" }}
          title={theme === "dark" ? t.theme_dark : t.theme_light}
        >
          <Icon name={theme === "dark" ? "moon" : "sun"} fixedWidth />
          <span>{theme === "dark" ? t.theme_dark : t.theme_light}</span>
        </button>

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
              <Icon name="sign-out" />
            </button>
          </div>
        ) : (
          <button
            onClick={handleLogout}
            className="btn btn-ghost btn-sm"
            style={{ width: "100%", justifyContent: "center", color: "var(--text-muted)" }}
          >
            <Icon name="sign-out" /> {t.nav_logout}
          </button>
        )}
      </div>
    </aside>

    {/* Mobile top bar + menu — rendered via portal so it is NOT inside the
        `.page-sidebar` container, which `globals.css` hides on mobile. */}
    {mounted &&
      createPortal(
        <div className="md:hidden">
          {/* Fixed top bar */}
          <div
            ref={topBarRef}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              zIndex: 50,
              height: 56,
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0 0.75rem",
              background: "var(--bg-surface)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <button
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={t.a11y_menu}
              aria-expanded={menuOpen}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: "1.4rem",
                lineHeight: 1,
                color: "var(--accent)",
                padding: "0.35rem 0.5rem",
                borderRadius: "var(--radius)",
              }}
            >
              {menuOpen ? <Icon name="times" color="var(--accent)" /> : <Icon name="bars" color="var(--accent)" />}
            </button>
            <Link href="/" style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 700, color: "var(--accent-light)", textDecoration: "none" }}>
              <Image src="/logo.svg" alt="CF ActivityPub" width={26} height={26} />
              <span style={{ fontSize: "1rem" }}>CF ActivityPub</span>
              {version && (
                <span style={{ fontSize: "0.68rem", fontWeight: 400, opacity: 0.75 }}>v{version}</span>
              )}
            </Link>
            <button
              onClick={toggleTheme}
              style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", fontSize: "1.3rem", lineHeight: 1, color: "var(--accent)" }}
              title={theme === "dark" ? t.theme_dark : t.theme_light}
            >
              <Icon name={theme === "dark" ? "moon" : "sun"} color="var(--accent)" />
            </button>
          </div>

          {/* Slide-down drawer */}
          {menuOpen && (
            <div
              ref={drawerRef}
              style={{
                position: "fixed",
                top: 56,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 49,
                background: "var(--bg-surface)",
                overflowY: "auto",
                overflowX: "hidden",
                padding: "0.5rem 0.75rem 1.5rem",
              }}
            >
              <nav style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                {navItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => { setMenuOpen(false); item.onClick?.(); }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.75rem",
                      padding: "0.7rem 0.875rem",
                      borderRadius: "var(--radius)",
                      color: currentPath === item.href ? "var(--accent)" : "var(--text)",
                      background: currentPath === item.href ? "var(--accent-bg)" : undefined,
                      textDecoration: "none",
                      fontWeight: currentPath === item.href ? 700 : 400,
                      position: "relative",
                      minWidth: 0,
                    }}
                  >
                    <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
                      <Icon name={item.icon} fixedWidth />
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
                    <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{item.label}</span>
                  </Link>
                ))}
              </nav>

              {/* User info + logout */}
              <div style={{ padding: "0.5rem", marginTop: "0.25rem" }}>
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
                      <Icon name="sign-out" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleLogout}
                    className="btn btn-ghost btn-sm"
                    style={{ width: "100%", justifyContent: "center", color: "var(--text-muted)" }}
                  >
                    <Icon name="sign-out" /> {t.nav_logout}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  );
}
