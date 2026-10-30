"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/lib/i18n";
import { useInstanceTitle } from "@/lib/instance-context";
import { Icon } from "@/components/Icon";
import { Loading } from "@/components/Loading";
import { InstanceStatusPanel, OverallBanner, type StatusComponentDTO } from "@/components/InstanceStatusPanel";
import { formatBytes, formatCount } from "@/lib/format";
import { parseDbDate } from "@/lib/dates";

interface StatusSnapshot {
  checked_at: string;
  version: string;
  overall: string;
  components: StatusComponentDTO[];
  metrics: Record<string, number | string | null>;
}

/** The API answers from a minute-long KV cache: no point asking more often. */
const REFRESH_MS = 60_000;

export default function InstanceStatusPage() {
  const { t } = useLocale();
  const brand = useInstanceTitle();
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (fresh = false) => {
    // `fresh` is the manual button: it asks the API to recompute the snapshot
    // (behind its own global throttle) instead of serving the minute-long KV
    // cache — without it, clicking inside the cache window returned a
    // byte-identical body and the button looked dead.
    if (fresh) setRefreshing(true);
    try {
      const response = await fetch(fresh ? "/api/v1/status?fresh=1" : "/api/v1/status", { cache: "no-store" });
      if (!response.ok) throw new Error(`status ${response.status}`);
      setSnapshot((await response.json()) as StatusSnapshot);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
      if (fresh) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Deferred one microtask: the hook linter rejects a synchronous setState
    // from the effect body (same pattern as the other admin pages).
    Promise.resolve().then(() => void load());
    const timer = setInterval(() => {
      // A hidden tab does not need the refresh; the page catches up as soon as
      // it is visible again (the next tick).
      if (!document.hidden) void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const metrics = snapshot?.metrics ?? {};
  const metric = (key: string): number | null => (typeof metrics[key] === "number" ? (metrics[key] as number) : null);
  const since = parseDbDate(metrics.running_since);

  return (
    // Same forced-light surface as the landing: `.force-light` + the palette's
    // `--bg` painted on the page. `globals.css` zeroes the mobile body
    // paddings for it (they exist for the app's fixed bar, which this page does
    // not render), so the surface reaches both edges with no palette band.
    <main className="force-light flex flex-col flex-1" style={{ background: "var(--bg)" }}>
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 40,
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-surface)",
        }}
      >
        <div className="container-wide flex items-center justify-between gap-4 py-4">
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 700 }}>
            <Icon name="arrow-left" /> {brand}
          </Link>
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
            {t.status_version.replace("{version}", snapshot?.version ?? "—")}
          </span>
        </div>
      </header>

      <div className="container-wide" style={{ padding: "2rem 1rem 3rem", display: "flex", flexDirection: "column", gap: "1.5rem", maxWidth: "52rem" }}>
        <div>
          <h1 style={{ fontSize: "1.6rem", marginBottom: "0.4rem" }}>
            <Icon name="heartbeat" /> {t.status_title}
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>{t.status_subtitle}</p>
        </div>

        {loading && !snapshot ? (
          <Loading />
        ) : failed && !snapshot ? (
          <div className="card" style={{ padding: "1.25rem", display: "flex", gap: "0.6rem", alignItems: "center" }}>
            <Icon name="exclamation-triangle" color="var(--warning)" />
            <span>{t.status_load_error}</span>
          </div>
        ) : snapshot ? (
          <>
            <OverallBanner overall={snapshot.overall} />
            <InstanceStatusPanel components={snapshot.components} />

            <div>
              <h2 style={{ fontSize: "1.05rem", marginBottom: "0.75rem" }}>{t.status_pub_metrics}</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.75rem" }}>
                <Metric label={t.status_pub_accounts} value={formatCount(metric("local_accounts") ?? 0)} />
                <Metric label={t.status_pub_statuses} value={formatCount(metric("local_statuses") ?? 0)} />
                <Metric label={t.status_pub_statuses_24h} value={formatCount(metric("statuses_24h") ?? 0)} />
                <Metric label={t.status_pub_domains} value={formatCount(metric("domains") ?? 0)} />
                <Metric
                  label={t.status_pub_media}
                  value={formatBytes(metric("media_bytes") ?? 0)}
                  detail={t.status_metric_media_entries.replace("{n}", formatCount(metric("media_entries") ?? 0))}
                />
                {since ? <Metric label={t.status_pub_since} value={since.toLocaleDateString()} /> : null}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", fontSize: "0.8rem", color: "var(--text-muted)" }}>
              <span>
                {t.status_checked_at.replace("{time}", new Date(snapshot.checked_at).toLocaleTimeString())}
                {" · "}
                {t.status_auto_refresh}
              </span>
              <button type="button" className="btn btn-outline btn-sm" disabled={refreshing} onClick={() => void load(true)}>
                <Icon name="refresh" spin={refreshing} /> {refreshing ? t.status_refreshing : t.status_refresh}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="card" style={{ padding: "0.9rem 1rem", display: "flex", flexDirection: "column", gap: "0.2rem" }}>
      <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</span>
      <strong style={{ fontSize: "1.25rem" }}>{value}</strong>
      {detail ? <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{detail}</span> : null}
    </div>
  );
}
