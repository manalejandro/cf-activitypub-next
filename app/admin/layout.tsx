"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { getToken } from "@/lib/client-api";
import { useLocale, type Translations } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { Loading } from "@/components/Loading";

const navItems: { key: keyof Translations; href: string; icon: string }[] = [
  { key: "admin_dashboard", href: "/admin", icon: "bar-chart" },
  { key: "admin_accounts", href: "/admin/accounts", icon: "users" },
  { key: "admin_suspended", href: "/admin/suspended", icon: "ban" },
  { key: "admin_blocked", href: "/admin/blocked", icon: "lock" },
  { key: "admin_reports", href: "/admin/reports", icon: "flag" },
  { key: "admin_moderation_log", href: "/admin/moderation_log", icon: "file-text-o" },
  { key: "admin_settings", href: "/admin/settings", icon: "cog" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useLocale();
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
        <Loading />
      </div>
    );
  }

  if (!authorized) return null;

  return (
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-title">
          <Link href="/admin">Admin</Link>
        </div>
        {navItems.map((item) => {
          const active = pathname === item.href || (item.href !== "/admin" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`admin-nav-item${active ? " active" : ""}`}
            >
              <Icon name={item.icon} /> {t[item.key]}
            </Link>
          );
        })}
        <div className="admin-nav-back">
          <Link href="/home"><Icon name="arrow-left" /> {t.admin_back_to_app}</Link>
        </div>
      </aside>
      <main className="admin-main">{children}</main>
    </div>
  );
}
