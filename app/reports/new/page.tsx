"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { AvatarBubble } from "@/components/StatusCard";
import { getToken } from "@/lib/client-api";
import { useLocale } from "@/lib/i18n";

function LoadingFallback() {
  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={null} currentPath="/reports" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)", padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>
        Loading…
      </main>
    </div>
  );
}

interface TargetAccount {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

interface StatusPreview {
  id: string;
  content: string;
  account: TargetAccount;
  created_at: string;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

function stripHtml(html: string): string {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent ?? div.innerText ?? "";
}

export default function NewReportPageWrapper() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <NewReportPage />
    </Suspense>
  );
}

function NewReportPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = getToken();
  const { t } = useLocale();

  const [me, setMe] = useState<Me | null>(null);
  const [accountId, setAccountId] = useState(searchParams.get("account_id") ?? "");
  const [statusId, setStatusId] = useState(searchParams.get("status_id") ?? "");
  const [category, setCategory] = useState("other");
  const [comment, setComment] = useState("");
  const [forward, setForward] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewAccount, setPreviewAccount] = useState<TargetAccount | null>(null);
  const [previewStatus, setPreviewStatus] = useState<StatusPreview | null>(null);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    void fetchMe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (accountId) void fetchAccount();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => {
    if (statusId) void fetchStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusId]);

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchAccount() {
    if (!token || !accountId) return;
    const res = await fetch(`/api/v1/accounts/${encodeURIComponent(accountId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setPreviewAccount(await res.json() as TargetAccount);
  }

  async function fetchStatus() {
    if (!token || !statusId) return;
    const res = await fetch(`/api/v1/statuses/${encodeURIComponent(statusId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setPreviewStatus(await res.json() as StatusPreview);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !accountId) return;
    setError(null);
    setSubmitting(true);

    const body: Record<string, unknown> = {
      account_id: accountId,
      category,
      comment,
      forward,
    };
    if (statusId) body.status_ids = [statusId];

    const res = await fetch("/api/v1/reports", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      router.push("/reports");
    } else {
      const err = await res.json() as { error?: string };
      setError(err.error ?? "Failed to submit report");
    }
    setSubmitting(false);
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/reports" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        <div
          style={{
            position: "sticky", top: 0, background: "var(--bg)",
            borderBottom: "1px solid var(--border)", padding: "0.75rem 1rem",
            display: "flex", alignItems: "center", gap: "1rem", zIndex: 10,
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
          <span style={{ fontWeight: 600 }}>New Report</span>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
          {/* Reported account preview */}
          {previewAccount && (
            <div
              style={{
                display: "flex", alignItems: "center", gap: "0.75rem",
                padding: "0.875rem", background: "var(--bg-elevated)",
                borderRadius: "var(--radius)",
              }}
            >
              <AvatarBubble account={previewAccount} size={42} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)" }}>
                  {previewAccount.display_name || previewAccount.username}
                </div>
                <div style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>
                  @{previewAccount.acct}
                </div>
              </div>
            </div>
          )}

          {/* Status preview */}
          {previewStatus && (
            <div
              style={{
                padding: "0.75rem", background: "var(--bg-elevated)",
                borderRadius: "var(--radius)", fontSize: "0.9rem",
                color: "var(--text-secondary)",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: "0.8rem", marginBottom: "0.375rem", color: "var(--text-muted)" }}>
                Reported Status
              </div>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {stripHtml(previewStatus.content)}
              </div>
            </div>
          )}

          {/* Reason */}
          <div>
            <label style={{ display: "block", fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.375rem" }}>
              Reason
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={{
                width: "100%", padding: "0.5rem 0.75rem", borderRadius: "var(--radius)",
                border: "1px solid var(--border)", background: "var(--bg)",
                color: "var(--text)", fontSize: "0.9rem", fontFamily: "inherit",
              }}
            >
              <option value="spam">Spam</option>
              <option value="violation">Violation</option>
              <option value="other">Other</option>
            </select>
          </div>

          {/* Comment */}
          <div>
            <label style={{ display: "block", fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.375rem" }}>
              Comment
            </label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Additional information…"
              rows={4}
              style={{
                width: "100%", padding: "0.5rem 0.75rem", borderRadius: "var(--radius)",
                border: "1px solid var(--border)", background: "var(--bg)",
                color: "var(--text)", fontSize: "0.9rem", fontFamily: "inherit",
                resize: "vertical",
              }}
            />
          </div>

          {/* Forward checkbox */}
          <label
            style={{
              display: "flex", alignItems: "center", gap: "0.5rem",
              fontSize: "0.9rem", cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={forward}
              onChange={(e) => setForward(e.target.checked)}
              style={{ width: "1rem", height: "1rem", accentColor: "var(--accent)" }}
            />
            Forward to server
          </label>

          {error && (
            <div style={{ color: "var(--danger)", fontSize: "0.82rem" }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting || !accountId}
            style={{ width: "100%", padding: "0.625rem", fontWeight: 600 }}
          >
            {submitting ? "Submitting…" : "Submit Report"}
          </button>
        </form>
      </main>
    </div>
  );
}
