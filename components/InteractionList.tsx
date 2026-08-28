"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { AvatarBubble } from "./StatusCard";
import { Icon } from "@/components/Icon";
import { useLocale } from "@/lib/i18n";
import { DisplayName } from "@/components/DisplayName";
import type { EmojiData } from "@/lib/emoji";

interface Account {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
  emojis?: EmojiData[];
  verified?: boolean;
}

export function InteractionList({
  apiUrl,
  title,
  onClose,
}: {
  apiUrl: string;
  title: string;
  onClose: () => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const { t } = useLocale();

  useEffect(() => {
    Promise.resolve().then(() => {
      setLoading(true);
      fetch(apiUrl, { credentials: "include" })
        .then((res) => {
          if (!res.ok) throw new Error("Failed to fetch");
          return res.json() as Promise<Account[]>;
        })
        .then((data) => {
          setAccounts(data);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    });
  }, [apiUrl]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.55)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "var(--bg)",
          borderRadius: "var(--radius-lg)",
          width: "min(420px, 95vw)",
          maxHeight: "min(80vh, 600px)",
          border: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "0.875rem 1rem",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ fontWeight: 700, fontSize: "1rem" }}>{title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.action_close}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--text-muted)",
              fontSize: "1.1rem",
              padding: "0.25rem",
            }}
          >
            <Icon name="times" color="var(--text-muted)" />
          </button>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                  padding: "0.75rem 1rem",
                }}
              >
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: "50%",
                    background: "var(--bg-elevated)",
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      height: "0.9rem",
                      width: "60%",
                      background: "var(--bg-elevated)",
                      borderRadius: "var(--radius-sm)",
                      marginBottom: "0.25rem",
                    }}
                  />
                  <div
                    style={{
                      height: "0.75rem",
                      width: "40%",
                      background: "var(--bg-elevated)",
                      borderRadius: "var(--radius-sm)",
                    }}
                  />
                </div>
              </div>
            ))
          ) : accounts.length === 0 ? (
            <div
              style={{
                padding: "2rem",
                textAlign: "center",
                color: "var(--text-muted)",
              }}
            >
              No one yet
            </div>
          ) : (
            accounts.map((account) => {
              const isRemote = account.acct.includes("@");
              const profileHref = isRemote
                ? `/users/remote?url=${encodeURIComponent(account.id)}`
                : `/users/${account.username}`;
              return (
                <Link
                  key={account.id}
                  href={profileHref}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.75rem",
                    padding: "0.75rem 1rem",
                    textDecoration: "none",
                    color: "inherit",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "var(--accent-bg)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  <AvatarBubble account={account} size={36} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: "0.9rem",
                        color: "var(--text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <DisplayName name={account.display_name || account.username} emojis={account.emojis} />
                      {account.verified && (
                        <span title={t.verified_badge} style={{ marginLeft: "0.25rem", verticalAlign: "middle", flexShrink: 0 }}><Icon name="check" color="var(--success)" size="0.8rem" /></span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: "0.8rem",
                        color: "var(--text-muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      @{account.acct}
                    </div>
                  </div>
                </Link>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
