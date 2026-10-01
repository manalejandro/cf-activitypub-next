"use client";

import i18next from "i18next";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/client-api";
import { useLocale, type Translations } from "@/lib/i18n";
import { Icon } from "@/components/Icon";

interface AdminRelay {
  id: string;
  inboxUrl: string;
  actorUri: string | null;
  state: "idle" | "pending" | "accepted" | "rejected";
  followActivityId: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function AdminRelaysPage() {
  const router = useRouter();
  const { t } = useLocale();
  const token = getToken();

  const [relays, setRelays] = useState<AdminRelay[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newInbox, setNewInbox] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  // Relay management is full-admin only (federation policy): moderators can
  // read the list but the write buttons are hidden and the API answers 403.
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch("/api/v1/accounts/verify_credentials", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null) as Promise<{ roles?: { name: string }[] } | null>)
      .then((me) => setIsAdmin((me?.roles?.[0]?.name ?? "").toLowerCase() === "admin"))
      .catch(() => setIsAdmin(false));
  }, [token]);

  const fetchRelays = useCallback(async (silent = false) => {
    if (!token) return;
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/v1/admin/relays", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { router.push("/login"); return; }
      const data = await res.json() as { relays: AdminRelay[] };
      setRelays(data.relays ?? []);
    } catch {
      if (!silent) router.push("/login");
    }
    if (!silent) setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    Promise.resolve().then(() => void fetchRelays());
  }, [fetchRelays]);

  // The relay answers the Follow asynchronously (its Accept arrives later): the
  // table polls while a subscription is pending so it flips to "activated" on
  // its own — no websocket involved. A background tab skips the poll and the
  // visibility handler below refetches on return.
  const hasPending = relays.some((r) => r.state === "pending");
  useEffect(() => {
    if (!hasPending) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void fetchRelays(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [hasPending, fetchRelays]);

  // Returning to the tab shows the current state without a manual reload.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "visible") void fetchRelays(true);
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [fetchRelays]);

  function flash(key: string) {
    setNotice(t[key as keyof Translations] as string);
    window.setTimeout(() => setNotice(null), 3000);
  }

  async function action(relay: AdminRelay, act: "enable" | "disable" | "remove") {
    if (!token || busy) return;
    if (act === "remove" && !window.confirm(t.admin_relays_remove_confirm)) return;
    setBusy(relay.id);
    try {
      const res = await fetch("/api/v1/admin/relays", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: relay.id, action: act }),
      });
      if (res.status === 401) { router.push("/login"); return; }
      if (!res.ok) {
        flash(res.status === 403 ? "admin_relays_admin_only" : "admin_relays_error_failed");
      } else {
        const data = await res.json().catch(() => ({})) as { ok?: boolean };
        if (data.ok) {
          flash(act === "enable" ? "admin_relays_notice_enabled" : act === "disable" ? "admin_relays_notice_disabled" : "admin_relays_notice_removed");
        }
        await fetchRelays();
      }
    } catch { /* ignore */ }
    setBusy(null);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const inbox = newInbox.trim();
    if (!token || !inbox || busy) return;
    setBusy("add");
    try {
      const res = await fetch("/api/v1/admin/relays", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inbox_url: inbox, action: "add" }),
      });
      if (res.status === 401) { router.push("/login"); return; }
      if (!res.ok) {
        flash(res.status === 422 ? "admin_relays_error_url" : res.status === 403 ? "admin_relays_admin_only" : "admin_relays_error_failed");
      } else {
        flash("admin_relays_notice_added");
        setNewInbox("");
        setAdding(false);
        await fetchRelays();
      }
    } catch { /* ignore */ }
    setBusy(null);
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleString(i18next.language || "en", {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  function stateOf(state: AdminRelay["state"]): { key: string; hint: string; color: string; bg: string } {
    switch (state) {
      case "accepted":
        return { key: "admin_relay_state_accepted", hint: "admin_relay_hint_accepted", color: "var(--success)", bg: "rgba(74,222,128,0.12)" };
      case "pending":
        return { key: "admin_relay_state_pending", hint: "admin_relay_hint_pending", color: "var(--warning)", bg: "rgba(251,191,36,0.12)" };
      case "rejected":
        return { key: "admin_relay_state_rejected", hint: "admin_relay_hint_rejected", color: "var(--danger)", bg: "rgba(248,113,113,0.12)" };
      default:
        return { key: "admin_relay_state_idle", hint: "admin_relay_hint_idle", color: "var(--text-muted)", bg: "var(--bg-elevated)" };
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
        <Icon name="rss" /> {t.admin_relays}
        <span style={{ fontSize: "0.9rem", color: "var(--text-muted)", fontWeight: 400, marginLeft: "0.5rem" }}>
          ({relays.length})
        </span>
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: "0.875rem", marginBottom: "1.25rem" }}>
        {t.admin_relays_desc}
      </p>

      {notice && (
        <div style={{ marginBottom: "1rem", padding: "0.5rem 0.75rem", borderRadius: "var(--radius-sm)", background: "var(--accent-bg)", color: "var(--accent)", fontSize: "0.85rem" }}>
          {notice}
        </div>
      )}

      {!isAdmin && (
        <div style={{ marginBottom: "1rem", padding: "0.5rem 0.75rem", borderRadius: "var(--radius-sm)", background: "rgba(251,191,36,0.12)", color: "var(--warning)", fontSize: "0.85rem" }}>
          {t.admin_relays_admin_only}
        </div>
      )}

      {isAdmin && (
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          {!adding ? (
            <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              {t.admin_relays_add}
            </button>
          ) : (
            <form onSubmit={(e) => void handleAdd(e)} style={{ display: "flex", gap: "0.5rem", flex: 1, minWidth: 320 }}>
              <input
                className="input"
                placeholder={t.admin_relays_add_ph}
                aria-label={t.admin_relays_add_ph}
                value={newInbox}
                onChange={(e) => setNewInbox(e.target.value)}
                autoFocus
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={!newInbox.trim() || busy === "add"}>
                {busy === "add" ? "…" : t.admin_relays_add}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>
                {t.profile_cancel}
              </button>
            </form>
          )}
        </div>
      )}

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_relays_loading}</div>
      ) : relays.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_relays_empty}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_relays_col_relay}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_status}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_relays_col_updated}</th>
                <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_actions}</th>
              </tr>
            </thead>
            <tbody>
              {relays.map((relay) => {
                const badge = stateOf(relay.state);
                const busyRow = busy === relay.id;
                let host = relay.inboxUrl;
                try { host = new URL(relay.inboxUrl).hostname; } catch { /* keep raw */ }
                return (
                  <tr key={relay.id} style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s" }}
                    onMouseOver={(e) => (e.currentTarget as HTMLElement).style.background = "var(--accent-bg)"}
                    onMouseOut={(e) => (e.currentTarget as HTMLElement).style.background = ""}
                  >
                    <td style={{ padding: "0.625rem 0.75rem" }}>
                      <div style={{ fontWeight: 600 }}>{host}</div>
                      <a href={relay.inboxUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
                        {relay.inboxUrl}
                      </a>
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem" }}>
                      <span className="badge" style={{ background: badge.bg, color: badge.color }} title={t[badge.hint as keyof Translations] as string}>
                        {t[badge.key as keyof Translations] as string}
                      </span>
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                      {formatDate(relay.updatedAt)}
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem", textAlign: "right", whiteSpace: "nowrap" }}>
                      {isAdmin && (
                        <>
                          {relay.state === "accepted" || relay.state === "pending" ? (
                            <button className="btn btn-outline btn-sm" style={{ marginRight: "0.35rem" }}
                              disabled={busyRow} onClick={() => void action(relay, "disable")}>
                              {t.admin_relays_btn_disable}
                            </button>
                          ) : (
                            <button className="btn btn-primary btn-sm" style={{ marginRight: "0.35rem" }}
                              disabled={busyRow} onClick={() => void action(relay, "enable")}>
                              {t.admin_relays_btn_enable}
                            </button>
                          )}
                          <button className="btn btn-danger btn-sm" disabled={busyRow} onClick={() => void action(relay, "remove")}>
                            {t.admin_relays_btn_remove}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
