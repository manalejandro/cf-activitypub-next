"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";

interface Account {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

export default function BlocksPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<"users" | "instances">("users");

  // Users tab state
  const [blocked, setBlocked] = useState<Account[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [unblockingId, setUnblockingId] = useState<string | null>(null);

  // Instances tab state
  const [domains, setDomains] = useState<string[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(true);
  const [newDomain, setNewDomain] = useState("");
  const [addingDomain, setAddingDomain] = useState(false);
  const [removingDomain, setRemovingDomain] = useState<string | null>(null);
  const [domainError, setDomainError] = useState<string | null>(null);

  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    void fetchMe();
    void fetchBlocked();
    void fetchDomains();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchBlocked() {
    if (!token) return;
    setLoadingUsers(true);
    const res = await fetch("/api/v1/blocks", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setBlocked(await res.json() as Account[]);
    setLoadingUsers(false);
  }

  async function fetchDomains() {
    if (!token) return;
    setLoadingDomains(true);
    const res = await fetch("/api/v1/domain_blocks", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setDomains(await res.json() as string[]);
    setLoadingDomains(false);
  }

  async function handleUnblock(account: Account) {
    if (!token) return;
    setUnblockingId(account.id);
    const res = await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/unblock`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setBlocked((prev) => prev.filter((a) => a.id !== account.id));
    setUnblockingId(null);
  }

  async function handleAddDomain(e: React.FormEvent) {
    e.preventDefault();
    const domain = newDomain.trim().toLowerCase();
    if (!domain || !token) return;
    setDomainError(null);
    setAddingDomain(true);
    const res = await fetch("/api/v1/domain_blocks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
    });
    if (res.ok) {
      setDomains((prev) => (prev.includes(domain) ? prev : [domain, ...prev]));
      setNewDomain("");
    } else {
      const err = await res.json() as { error?: string };
      setDomainError(err.error ?? "Error al bloquear dominio");
    }
    setAddingDomain(false);
  }

  async function handleRemoveDomain(domain: string) {
    if (!token) return;
    setRemovingDomain(domain);
    const res = await fetch(`/api/v1/domain_blocks?domain=${encodeURIComponent(domain)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setDomains((prev) => prev.filter((d) => d !== domain));
    setRemovingDomain(null);
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/blocks" />

      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        {/* Header */}
        <div
          style={{
            position: "sticky",
            top: 0,
            background: "var(--bg)",
            borderBottom: "1px solid var(--border)",
            padding: "0.75rem 1rem",
            display: "flex",
            alignItems: "center",
            gap: "1rem",
            zIndex: 10,
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
          <span style={{ fontWeight: 600 }}>Bloqueos</span>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
          {(["users", "instances"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              style={{
                flex: 1,
                padding: "0.75rem",
                fontWeight: tab === t ? 700 : 400,
                color: tab === t ? "var(--accent)" : "var(--text-muted)",
                borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
                background: "none",
                border: "none",
                borderBottomStyle: "solid",
                borderBottomWidth: 2,
                borderBottomColor: tab === t ? "var(--accent)" : "transparent",
                cursor: "pointer",
                fontSize: "0.95rem",
              }}
            >
              {t === "users" ? "Usuarios" : "Instancias"}
            </button>
          ))}
        </div>

        {/* Users tab */}
        {tab === "users" && (
          <div>
            {loadingUsers ? (
              <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
                Cargando…
              </div>
            ) : blocked.length === 0 ? (
              <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
                No tienes ningún usuario bloqueado.
              </div>
            ) : (
              blocked.map((account) => {
                const isRemote = account.acct.includes("@");
                const profileHref = isRemote
                  ? `/users/remote?url=${encodeURIComponent(account.id)}`
                  : `/users/${account.username}`;
                return (
                  <div
                    key={account.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.875rem",
                      padding: "0.875rem 1rem",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    {/* Avatar */}
                    <Link href={profileHref} style={{ flexShrink: 0 }}>
                      {account.avatar && !account.avatar.endsWith("/default-avatar.png") ? (
                        <img
                          src={account.avatar}
                          alt=""
                          style={{ width: 42, height: 42, borderRadius: "50%", objectFit: "cover" }}
                        />
                      ) : (
                        <div
                          style={{
                            width: 42, height: 42, borderRadius: "50%", background: "var(--accent-bg)",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontWeight: 700, color: "var(--accent)", fontSize: "1rem",
                          }}
                        >
                          {(account.display_name?.[0] ?? account.username?.[0] ?? "?").toUpperCase()}
                        </div>
                      )}
                    </Link>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Link
                        href={profileHref}
                        style={{ fontWeight: 600, fontSize: "0.95rem", color: "var(--text)", textDecoration: "none" }}
                      >
                        {account.display_name || account.username}
                      </Link>
                      <div style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>
                        @{account.acct}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ background: "var(--danger, #e11d48)", color: "#fff", border: "none", borderRadius: "var(--radius)", padding: "0.35rem 0.875rem", cursor: "pointer", fontWeight: 600 }}
                      disabled={unblockingId === account.id}
                      onClick={() => handleUnblock(account)}
                    >
                      {unblockingId === account.id ? "…" : "Desbloquear"}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Instances tab */}
        {tab === "instances" && (
          <div>
            {/* Add domain form */}
            <div style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}>
              <form onSubmit={handleAddDomain} style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  type="text"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  placeholder="ej: mastodon.social"
                  style={{
                    flex: 1,
                    padding: "0.5rem 0.75rem",
                    borderRadius: "var(--radius)",
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    color: "var(--text)",
                    fontSize: "0.9rem",
                    fontFamily: "inherit",
                  }}
                />
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={addingDomain || !newDomain.trim()}
                >
                  {addingDomain ? "…" : "Bloquear instancia"}
                </button>
              </form>
              {domainError && (
                <div style={{ color: "var(--danger)", fontSize: "0.82rem", marginTop: "0.375rem" }}>
                  {domainError}
                </div>
              )}
            </div>

            {loadingDomains ? (
              <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
                Cargando…
              </div>
            ) : domains.length === 0 ? (
              <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
                No tienes ninguna instancia bloqueada.
              </div>
            ) : (
              domains.map((domain) => (
                <div
                  key={domain}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.875rem",
                    padding: "0.875rem 1rem",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div
                    style={{
                      width: 40, height: 40, flexShrink: 0, borderRadius: "var(--radius)",
                      background: "var(--bg-elevated)", display: "flex", alignItems: "center",
                      justifyContent: "center", fontSize: "1.25rem",
                    }}
                  >
                    🌐
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>{domain}</div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                      Instancia bloqueada
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ background: "var(--danger, #e11d48)", color: "#fff", border: "none", borderRadius: "var(--radius)", padding: "0.35rem 0.875rem", cursor: "pointer", fontWeight: 600 }}
                    disabled={removingDomain === domain}
                    onClick={() => handleRemoveDomain(domain)}
                  >
                    {removingDomain === domain ? "…" : "Desbloquear"}
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </main>
    </div>
  );
}
