"use client";

import { useState, useEffect } from "react";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { SettingsHeader } from "@/components/SettingsHeader";
import { useLocale, type Translations } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { Loading } from "@/components/Loading";

interface PushSubscriptionData {
  id: string;
  endpoint: string;
  standard: boolean;
  alerts: Record<string, boolean>;
  server_key: string;
}

type NotificationType = "follow" | "favourite" | "reblog" | "mention" | "poll" | "direct" | "encrypted";

const NOTIFICATION_TYPES: { key: NotificationType; labelKey: keyof Translations }[] = [
  { key: "follow", labelKey: "notif_type_follow" },
  { key: "favourite", labelKey: "notif_type_favourite" },
  { key: "reblog", labelKey: "notif_type_reblog" },
  { key: "mention", labelKey: "notif_type_mention" },
  { key: "poll", labelKey: "notif_type_poll" },
  { key: "direct", labelKey: "notif_type_direct" },
  { key: "encrypted", labelKey: "notif_type_encrypted" },
];

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = `${base64String}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray as Uint8Array<ArrayBuffer>;
}

function keyToBytes(key: BufferSource | null | undefined): Uint8Array<ArrayBuffer> | undefined {
  if (!key) return undefined;
  if (key instanceof ArrayBuffer) return new Uint8Array(key);
  const view = key as ArrayBufferView;
  return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength) as Uint8Array<ArrayBuffer>;
}

function sameKey(a: Uint8Array<ArrayBuffer> | undefined, b: Uint8Array<ArrayBuffer> | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export default function PushNotificationsPage() {
  const [subscription, setSubscription] = useState<PushSubscriptionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscribing, setSubscribing] = useState(false);
  const [unsubscribing, setUnsubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browserSupport, setBrowserSupport] = useState(true);
  const token = getToken();
  const { t } = useLocale();

  useEffect(() => {
    if (!token) { window.location.href = "/login"; return; }

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

    Promise.resolve().then(() => {
      if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
        setBrowserSupport(false);
        setLoading(false);
        return;
      }
      void fetchSubscription();
    });
  }, [token]);

  async function handleSubscribe() {
    if (!token) return;
    setError(null);
    setSubscribing(true);

    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setError(t.settings_push_permission_denied);
        setSubscribing(false);
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      // Use the instance's VAPID public key so the push service accepts
      // VAPID-authenticated deliveries (required by Chrome and increasingly by others).
      let vapidPublicKey: string | undefined;
      try {
        const instRes = await fetch("/api/v2/instance");
        if (instRes.ok) {
          const inst = await instRes.json() as { vapid_public_key?: string };
          vapidPublicKey = inst.vapid_public_key;
        }
      } catch { /* fall back to a non-VAPID subscription */ }
      const wantedKey = vapidPublicKey ? urlBase64ToUint8Array(vapidPublicKey) : undefined;

      // The browser only keeps one push subscription per origin. If a previous
      // one exists (possibly bound to a different/absent VAPID key), Chrome
      // rejects a new subscribe() call. Reuse it when the key matches, otherwise
      // drop it first and subscribe fresh.
      let pushSubscription = await registration.pushManager.getSubscription();
      if (pushSubscription && !sameKey(keyToBytes(pushSubscription.options.applicationServerKey), wantedKey)) {
        await pushSubscription.unsubscribe();
        pushSubscription = null;
      }
      pushSubscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: wantedKey,
      });

      const subJSON = pushSubscription.toJSON();
      const endpoint = subJSON.endpoint ?? "";
      const keys = subJSON.keys as { p256dh?: string; auth?: string } | undefined;

      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        setError(t.settings_push_no_details);
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
        setError(err.error ?? t.settings_push_create_failed);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t.settings_push_subscribe_failed);
    }

    setSubscribing(false);
  }

  async function handleUnsubscribe() {
    if (!token || !subscription) return;
    setError(null);
    setUnsubscribing(true);

    try {
      // Also drop the browser-level push subscription so a later re-enable
      // (from this page or Elk) can subscribe fresh with the current VAPID key.
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        const existing = await registration?.pushManager.getSubscription();
        if (existing) await existing.unsubscribe();
      } catch { /* best-effort */ }

      const res = await fetch("/api/v1/push/subscription", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setSubscription(null);
      } else {
        const err = await res.json() as { error?: string };
        setError(err.error ?? t.settings_push_delete_failed);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t.settings_push_unsubscribe_failed);
    }

    setUnsubscribing(false);
  }

  async function handleToggleAlert(key: NotificationType, value: boolean) {
    if (!token || !subscription) return;
    setError(null);

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
      setError(err.error ?? t.settings_push_update_failed);
    }
  }

  if (!browserSupport) {
    return (
      <PageLayout sidebar={<Sidebar currentPath="/settings" />}>
        <SettingsHeader />
        <div style={{ padding: "1rem", color: "var(--text-muted)" }}>
          {t.settings_push_unsupported}
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout sidebar={<Sidebar currentPath="/settings" />}>
        <SettingsHeader />

        <div style={{ padding: "1rem", borderBottom: "1px solid var(--border)", fontSize: "0.875rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
          {t.settings_push_intro}
        </div>

        {loading ? (
          <Loading />
        ) : (
          <>
            {/* Subscription status & actions */}
            <div style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}>
                <span style={{ fontSize: "0.875rem", fontWeight: 600 }}>{t.settings_push_status}</span>
                <span style={{ fontSize: "0.875rem", color: subscription ? "var(--accent)" : "var(--text-muted)" }}>
                  {subscription ? t.settings_push_enabled : t.settings_push_disabled}
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
                  {unsubscribing ? "…" : t.settings_push_unsubscribe}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={subscribing}
                  onClick={() => void handleSubscribe()}
                >
                  {subscribing ? "…" : t.settings_push_enable}
                </button>
              )}
            </div>

            {/* Notification type toggles */}
            {subscription && (
              <div style={{ padding: "1rem" }}>
                <h2 style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: "0.75rem" }}>{t.settings_push_notification_types}</h2>
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
                      {t[nt.labelKey]}
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
    </PageLayout>
  );
}
