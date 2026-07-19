"use client";

import { useState, useEffect } from "react";
import { Sidebar } from "@/components/Sidebar";
import { getToken } from "@/lib/client-api";

interface PushSubscriptionData {
  id: string;
  endpoint: string;
  standard: boolean;
  alerts: Record<string, boolean>;
  server_key: string;
}

type NotificationType = "follow" | "favourite" | "reblog" | "mention" | "poll";

const NOTIFICATION_TYPES: { key: NotificationType; label: string }[] = [
  { key: "follow", label: "Follow" },
  { key: "favourite", label: "Favourite" },
  { key: "reblog", label: "Boost" },
  { key: "mention", label: "Mention" },
  { key: "poll", label: "Poll" },
];

export default function PushNotificationsPage() {
  const [subscription, setSubscription] = useState<PushSubscriptionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscribing, setSubscribing] = useState(false);
  const [unsubscribing, setUnsubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browserSupport, setBrowserSupport] = useState(true);
  const token = getToken();

  useEffect(() => {
    if (!token) { window.location.href = "/login"; return; }
    if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
      setBrowserSupport(false);
      setLoading(false);
      return;
    }
    void fetchSubscription();
  }, []);

  async function fetchSubscription() {
    if (!token) return;
    setLoading(true);
    const res = await fetch("/api/v1/push/subscription", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json() as PushSubscriptionData;
      setSubscription(data);
    }
    setLoading(false);
  }

  async function handleSubscribe() {
    if (!token) return;
    setError(null);
    setSubscribing(true);

    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setError("Push notification permission was denied.");
        setSubscribing(false);
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      const pushSubscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: undefined,
      });

      const subJSON = pushSubscription.toJSON();
      const endpoint = subJSON.endpoint ?? "";
      const keys = subJSON.keys as { p256dh?: string; auth?: string } | undefined;

      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        setError("Failed to get push subscription details from the browser.");
        setSubscribing(false);
        return;
      }

      const initialAlerts: Record<string, boolean> = {};
      for (const nt of NOTIFICATION_TYPES) {
        initialAlerts[nt.key] = true;
      }

      const res = await fetch("/api/v1/push/subscription", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: {
            endpoint,
            keys: { p256dh: keys.p256dh, auth: keys.auth },
            standard: false,
          },
          data: {
            alerts: initialAlerts,
            policy: "all",
          },
        }),
      });

      if (res.ok) {
        const data = await res.json() as PushSubscriptionData;
        setSubscription(data);
      } else {
        const err = await res.json() as { error?: string };
        setError(err.error ?? "Failed to create push subscription");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to subscribe to push notifications");
    }

    setSubscribing(false);
  }

  async function handleUnsubscribe() {
    if (!token || !subscription) return;
    setError(null);
    setUnsubscribing(true);

    try {
      const res = await fetch("/api/v1/push/subscription", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setSubscription(null);
      } else {
        const err = await res.json() as { error?: string };
        setError(err.error ?? "Failed to delete push subscription");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to unsubscribe");
    }

    setUnsubscribing(false);
  }

  async function handleToggleAlert(key: NotificationType, value: boolean) {
    if (!token || !subscription) return;
    setError(null);

    const updatedAlerts = { ...subscription.alerts, [key]: value };

    const res = await fetch("/api/v1/push/subscription", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        data: { alerts: { [key]: value } },
      }),
    });

    if (res.ok) {
      const data = await res.json() as PushSubscriptionData;
      setSubscription(data);
    } else {
      const err = await res.json() as { error?: string };
      setError(err.error ?? "Failed to update notification settings");
    }
  }

  if (!browserSupport) {
    return (
      <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
        <Sidebar currentPath="/settings" />
        <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
          <div style={{ position: "sticky", top: 0, background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10 }}>
            <h1 style={{ fontWeight: 700, fontSize: "1.25rem" }}>Push Notifications</h1>
          </div>
          <div style={{ padding: "1rem", color: "var(--text-muted)" }}>
            Push notifications require a Web Push compatible browser. Your browser does not appear to support this feature.
          </div>
        </main>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar currentPath="/settings" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        <div style={{ position: "sticky", top: 0, background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10 }}>
          <h1 style={{ fontWeight: 700, fontSize: "1.25rem" }}>Push Notifications</h1>
        </div>

        <div style={{ padding: "1rem", borderBottom: "1px solid var(--border)", fontSize: "0.875rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
          Push notifications require a Web Push compatible browser. Your browser must support the Push API and Service Workers to receive notifications even when the tab is closed.
        </div>

        {loading ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>
        ) : (
          <>
            {/* Subscription status & actions */}
            <div style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}>
                <span style={{ fontSize: "0.875rem", fontWeight: 600 }}>Status:</span>
                <span style={{ fontSize: "0.875rem", color: subscription ? "var(--accent)" : "var(--text-muted)" }}>
                  {subscription ? "Enabled" : "Disabled"}
                </span>
              </div>
              {subscription ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ background: "var(--danger, #e11d48)", color: "#fff", border: "none", borderRadius: "var(--radius)", padding: "0.35rem 0.875rem", cursor: "pointer", fontWeight: 600, fontSize: "0.85rem" }}
                  disabled={unsubscribing}
                  onClick={() => void handleUnsubscribe()}
                >
                  {unsubscribing ? "…" : "Unsubscribe"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={subscribing}
                  onClick={() => void handleSubscribe()}
                >
                  {subscribing ? "…" : "Enable Push Notifications"}
                </button>
              )}
            </div>

            {/* Notification type toggles */}
            {subscription && (
              <div style={{ padding: "1rem" }}>
                <h2 style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: "0.75rem" }}>Notification Types</h2>
                {NOTIFICATION_TYPES.map((nt) => {
                  const checked = subscription.alerts[nt.key] ?? false;
                  return (
                    <label
                      key={nt.key}
                      style={{ display: "flex", alignItems: "center", gap: "0.625rem", padding: "0.5rem 0", cursor: "pointer", fontSize: "0.875rem" }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => void handleToggleAlert(nt.key, e.target.checked)}
                      />
                      {nt.label}
                    </label>
                  );
                })}
              </div>
            )}

            {error && (
              <div style={{ padding: "0.5rem 1rem", background: "var(--accent-bg)", color: "var(--danger)", fontSize: "0.82rem" }}>
                {error}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
