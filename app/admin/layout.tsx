"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { getToken } from "@/lib/client-api";

const navItems = [
  { label: "Dashboard", href: "/admin" },
  { label: "Accounts", href: "/admin/accounts" },
  { label: "Reports", href: "/admin/reports" },
  { label: "Invites", href: "/admin/invites" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [authorized, setAuthorized] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }

    fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json() as Promise<{ id: string; username: string; roles: { name: string }[] }>)
      .then((me) => {
        const roleName = me.roles?.[0]?.name?.toLowerCase() ?? "user";
        if (roleName === "admin" || roleName === "moderator") {
          setAuthorized(true);
        } else {
          router.push("/home");
        }
      })
      .catch(() => router.push("/login"))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
        <div style={{ color: "var(--text-muted)" }}>Loading...</div>
      </div>
    );
  }

  if (!authorized) return null;

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1200, margin: "0 auto", width: "100%" }}>
      <aside
        style={{
          width: 220,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          padding: "1.5rem 0",
          display: "flex",
          flexDirection: "column",
          gap: "0.25rem",
        }}
      >
        <div style={{ padding: "0 1rem", marginBottom: "1rem" }}>
          <Link href="/admin" style={{ fontWeight: 700, fontSize: "1.1rem", color: "var(--text-primary)" }}>
            Admin
          </Link>
        </div>
        {navItems.map((item) => {
          const active = pathname === item.href || (item.href !== "/admin" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              style={{
                display: "block",
                padding: "0.625rem 1rem",
                fontSize: "0.9rem",
                fontWeight: active ? 600 : 400,
                color: active ? "var(--accent)" : "var(--text-secondary)",
                background: active ? "var(--accent-bg)" : "transparent",
                borderRight: active ? "2px solid var(--accent)" : "2px solid transparent",
                textDecoration: "none",
                transition: "background 0.12s, color 0.12s",
              }}
            >
              {item.label}
            </Link>
          );
        })}
        <div style={{ marginTop: "auto", padding: "1rem", borderTop: "1px solid var(--border)" }}>
          <Link href="/home" style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
            ← Back to app
          </Link>
        </div>
      </aside>
      <main style={{ flex: 1, padding: "1.5rem 2rem", overflow: "auto" }}>
        {children}
      </main>
    </div>
  );
}
