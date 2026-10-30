"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { useLocale, translateKey } from "@/lib/i18n";
import { parseDbDate } from "@/lib/dates";
import { getToken } from "@/lib/client-api";
import { Icon } from "@/components/Icon";
import { Loading } from "@/components/Loading";

interface ScheduledStatus {
  id: string;
  scheduled_at: string;
  params: {
    status?: string;
    text?: string;
    visibility?: string;
    sensitive?: boolean;
    spoiler_text?: string;
    poll?: { options?: unknown[] } | null;
    location?: { name?: string | null } | null;
    event?: { name?: string } | null;
  };
  media_attachments: { id: string }[];
}

const VIS_META: Record<string, { icon: string; key: string }> = {
  public: { icon: "globe", key: "vis_public" },
  unlisted: { icon: "unlock", key: "vis_unlisted" },
  private: { icon: "lock", key: "vis_followers" },
  direct: { icon: "envelope", key: "vis_direct" },
};

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

export default function ScheduledPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [items, setItems] = useState<ScheduledStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const token = getToken();
  const { t } = useLocale();

  useEffect(() => {
    async function fetchMe() {
      if (!token) return;
      const res = await fetch("/api/v1/accounts/verify_credentials", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setMe(await res.json() as Me);
    }

    async function fetchScheduled() {
      if (!token) return;
      const res = await fetch("/api/v1/scheduled_statuses", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setItems(await res.json() as ScheduledStatus[]);
      setLoading(false);
    }

    if (!token) { router.push("/login"); return; }
    void fetchMe();
    void fetchScheduled();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCancel(id: string) {
    if (!token) return;
    setCancelling(id);
    const res = await fetch(`/api/v1/scheduled_statuses/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setItems((prev) => prev.filter((s) => s.id !== id));
    setCancelling(null);
  }

  return (
    <PageLayout sidebar={<Sidebar me={me} currentPath="/scheduled" />}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10 }}>
          <h1 className="text-lg font-bold">{t.scheduled_title}</h1>
        </div>
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}><Icon name="calendar" size="2rem" /></div>
            <div style={{ fontWeight: 600 }}>{t.scheduled_empty}</div>
            <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>{t.scheduled_empty_sub}</div>
          </div>
        ) : (
          items.map((s) => (
            <div key={s.id} style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "0.25rem" }}>
                    <Icon name="calendar" /> {(parseDbDate(s.scheduled_at) ?? new Date(s.scheduled_at)).toLocaleString()}
                  </div>
                  <div style={{ fontSize: "0.9rem", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.params.status || s.params.text || t.scheduled_no_content}
                  </div>
                  {s.params.spoiler_text && (
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.2rem" }}>
                      <Icon name="exclamation-triangle" /> {s.params.spoiler_text}
                    </div>
                  )}
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.35rem", display: "flex", gap: "0.65rem", alignItems: "center", flexWrap: "wrap" }}>
                    {(() => {
                      const vis = VIS_META[s.params.visibility ?? "public"] ?? VIS_META.public;
                      return (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                          <Icon name={vis.icon} /> {translateKey(t, vis.key) ?? vis.key}
                        </span>
                      );
                    })()}
                    {s.params.sensitive && (
                      <span title={t.media_sensitive_label} style={{ display: "inline-flex", alignItems: "center" }}>
                        <Icon name="eye-slash" />
                      </span>
                    )}
                    {s.media_attachments.length > 0 && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                        <Icon name="paperclip" /> {s.media_attachments.length}
                      </span>
                    )}
                    {s.params.poll && (
                      <span title={t.composer_poll} style={{ display: "inline-flex", alignItems: "center" }}>
                        <Icon name="bar-chart" />
                      </span>
                    )}
                    {s.params.location && (
                      <span title={t.location_title} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", maxWidth: "12rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <Icon name="map-marker" /> {s.params.location.name || t.location_title}
                      </span>
                    )}
                    {s.params.event && (
                      <span title={t.composer_event} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", maxWidth: "14rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <Icon name="calendar" /> {s.params.event.name || t.composer_event}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0 }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => router.push(`/home?edit_scheduled=${encodeURIComponent(s.id)}`)}
                    aria-label={t.action_edit}
                    title={t.action_edit}
                  >
                    <Icon name="pencil" />
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ color: "var(--danger)" }}
                    onClick={() => void handleCancel(s.id)}
                    disabled={cancelling === s.id}
                  >
                    {cancelling === s.id ? "…" : t.scheduled_cancel}
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
    </PageLayout>
  );
}
