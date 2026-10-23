"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/client-api";
import { useLocale, type Translations } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { Loading } from "@/components/Loading";
import { InstanceStatusPanel, OverallBanner, type StatusComponentDTO } from "@/components/InstanceStatusPanel";
import { formatBytes, formatCount, parseDbDate } from "@/lib/format";

interface StatsSnapshot {
  status: {
    checked_at: string;
    version: string;
    overall: string;
    components: StatusComponentDTO[];
    metrics: Record<string, number | string | null>;
  };
  actors: {
    local: number;
    remote: number;
    suspended: number;
    limited: number;
    memorial: number;
    pending: number;
    firstLocalAt: string | null;
  };
  statuses: { local: number; remote: number; local24h: number };
  database: {
    bytes: number | null;
    measured_at: string | null;
    prunable_bytes: number;
    prunable_rows: number;
    measuring: boolean;
    retention: { days: number; max_bytes: number };
    rows: Record<string, number>;
  };
  federation: {
    domains: number;
    unavailable: number;
    lastActivityAt: string | null;
    blocked_domains: number;
    relays: { accepted: number; pending: number; rejected: number; idle: number };
  };
  delivery: {
    permanent_failures: number;
    unreachable: number;
    last_ok_at: string | null;
    failures_24h: number;
    failures_recorded: number;
  };
  media: {
    enabled: boolean;
    ready: number;
    pending: number;
    failed: number;
    bytes: number;
    queue_due: number;
    oldest_fetched_at: string | null;
    config: { days: number; profile_days: number; max_bytes: number; fetch_batch: number; cold_days: number };
  };
  moderation: {
    openReports: number;
    decisions24h: number;
    pending_registrations: number;
    suspended: number;
    limited: number;
    memorial: number;
  };
  cron: { lastRunAt: string | null; lastDurationMs: number | null; stage: string | null };
  features: {
    ai: boolean;
    vectorize: boolean;
    email: boolean;
    turnstile: boolean;
    page_cache: { enabled: boolean; ttl_seconds: number; swr_seconds: number };
    media_cache_enabled: boolean;
    retention: { days: number; max_bytes: number };
    registrations: { enabled: boolean; approval_required: boolean };
    anonymous_timelines: string;
  };
}


export default function AdminStatsPage() {
  const router = useRouter();
  const { t } = useLocale();
  const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const token = getToken();
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const response = await fetch("/api/v1/admin/stats", { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`status ${response.status}`);
      setSnapshot((await response.json()) as StatsSnapshot);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Deferred one microtask: the hook linter rejects a synchronous setState
    // from the effect body (same pattern as the other admin pages).
    Promise.resolve().then(() => void load());
  }, [load]);

  if (loading && !snapshot) return <Loading />;
  if (!snapshot) {
    return (
      <div>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>
          <Icon name="heartbeat" /> {t.admin_stats}
        </h1>
        <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
          <Icon name="exclamation-triangle" color="var(--warning)" />
          <span>{failed ? t.status_load_error : t.admin_stats_unknown}</span>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void load()}>
            <Icon name="refresh" /> {t.admin_media_cache_refresh}
          </button>
        </div>
      </div>
    );
  }

  const { status, actors, statuses, database, federation, delivery, media, moderation, cron, features } = snapshot;
  const checkedAt = parseDbDate(status.checked_at);
  const lastOk = parseDbDate(delivery.last_ok_at);
  const lastRun = parseDbDate(cron.lastRunAt);
  const measuredAt = parseDbDate(database.measured_at);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.75rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <h1 style={{ fontSize: "1.5rem", margin: 0 }}>
          <Icon name="heartbeat" /> {t.admin_stats}
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
            {t.admin_stats_checked.replace("{time}", (checkedAt ?? new Date()).toLocaleTimeString())}
          </span>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void load()}>
            <Icon name="refresh" /> {t.admin_media_cache_refresh}
          </button>
        </div>
      </div>
      <p style={{ fontSize: "0.82rem", color: "var(--text-muted)", margin: 0 }}>{t.admin_stats_desc}</p>

      <OverallBanner overall={status.overall} />

      <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <SectionTitle icon="heartbeat" title={t.admin_stats_section_components} />
        <InstanceStatusPanel components={status.components} />
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.75rem" }}>
        <MetricCard label={t.admin_users} value={formatCount(actors.local)} />
        <MetricCard label={t.admin_federated} value={formatCount(actors.remote)} />
        <MetricCard label={t.admin_stats_statuses_local} value={formatCount(statuses.local)} />
        <MetricCard label={t.admin_stats_statuses_remote} value={formatCount(statuses.remote)} />
        <MetricCard label={t.admin_guardian_local_statuses_last_24h} value={formatCount(statuses.local24h)} />
        <MetricCard label={t.admin_stats_domains} value={formatCount(federation.domains)} />
        <MetricCard label={t.admin_storage_database} value={database.bytes === null ? t.admin_stats_unknown : formatBytes(database.bytes)} />
        <MetricCard label={t.status_pub_media} value={formatBytes(media.bytes)} />
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))", gap: "1rem" }}>
        <Panel title={t.admin_storage_database} icon="database">
          <Row label={t.admin_storage_database} value={database.bytes === null ? t.admin_stats_unknown : formatBytes(database.bytes)} />
          <Row
            label={t.admin_storage_prunable}
            value={
              database.measuring && database.prunable_bytes === 0
                ? `${t.admin_storage_measuring} (${formatCount(database.prunable_rows)})`
                : `${formatBytes(database.prunable_bytes)} · ${formatCount(database.prunable_rows)}`
            }
          />
          <Row label={t.admin_stats_db_measured} value={measuredAt ? measuredAt.toLocaleString() : t.admin_stats_unknown} />
          <Row
            label={t.admin_storage_retention}
            value={
              database.retention.days > 0 || database.retention.max_bytes > 0
                ? [
                    database.retention.days > 0 ? t.admin_storage_days.replace("{days}", String(database.retention.days)) : null,
                    database.retention.max_bytes > 0
                      ? t.admin_storage_max_bytes.replace("{size}", formatBytes(database.retention.max_bytes))
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : t.admin_storage_no_days
            }
          />
          {Object.entries(database.rows).map(([table, count]) => (
            <Row key={table} label={table} value={formatCount(count)} mono />
          ))}
        </Panel>

        <Panel title={t.admin_stats_section_federation} icon="exchange">
          <Row label={t.admin_stats_domains} value={formatCount(federation.domains)} />
          <Row label={t.admin_instances_status_unavailable} value={formatCount(federation.unavailable)} />
          <Row label={t.admin_stats_blocked_domains} value={formatCount(federation.blocked_domains)} />
          <Row
            label={t.admin_relays}
            value={`${federation.relays.accepted} ${t.admin_stats_relay_accepted} · ${federation.relays.pending} ${t.admin_stats_relay_pending}`}
          />
          <Row
            label={t.admin_stats_last_activity}
            value={parseDbDate(federation.lastActivityAt)?.toLocaleString() ?? t.status_never}
          />
          <Row label={t.admin_stats_delivery_permanent} value={formatCount(delivery.permanent_failures)} />
          <Row label={t.admin_stats_delivery_unreachable} value={formatCount(delivery.unreachable)} />
          <Row label={t.admin_stats_delivery_dlq} value={`${formatCount(delivery.failures_24h)} · ${formatCount(delivery.failures_recorded)}`} />
          <Row label={t.admin_stats_delivery_last_ok} value={lastOk ? lastOk.toLocaleString() : t.status_never} />
        </Panel>

        <Panel title={t.admin_media_cache} icon="hdd-o">
          <Row label={t.admin_stats_media_state} value={media.enabled ? t.admin_media_cache_config_yes : t.admin_media_cache_config_no} />
          <Row label={t.admin_media_cache_stat_ready} value={formatCount(media.ready)} />
          <Row label={t.admin_media_cache_stat_pending} value={formatCount(media.pending)} />
          <Row label={t.admin_media_cache_stat_failed} value={formatCount(media.failed)} />
          <Row label={t.admin_stats_media_queue} value={formatCount(media.queue_due)} />
          <Row label={t.admin_media_cache_stat_bytes} value={formatBytes(media.bytes)} />
          <Row
            label={t.admin_media_cache_config}
            value={`${formatBytes(media.config.max_bytes)} · ${media.config.days} d · ${media.config.fetch_batch}/${t.admin_stats_tick}`}
          />
          <Row
            label={t.admin_media_cache_stat_oldest}
            value={parseDbDate(media.oldest_fetched_at)?.toLocaleString() ?? t.status_never}
          />
        </Panel>

        <Panel title={t.admin_stats_section_moderation} icon="shield">
          <Row label={t.admin_open_reports} value={formatCount(moderation.openReports)} />
          <Row label={t.admin_pending} value={formatCount(moderation.pending_registrations)} />
          <Row label={t.admin_stats_decisions_24h} value={formatCount(moderation.decisions24h)} />
          <Row label={t.admin_status_suspended} value={formatCount(moderation.suspended)} />
          <Row label={t.admin_status_silenced} value={formatCount(moderation.limited)} />
          <Row label={t.admin_status_memorial} value={formatCount(moderation.memorial)} />
        </Panel>

        <Panel title={t.admin_stats_section_cron} icon="clock-o">
          <Row label={t.admin_stats_cron_last} value={lastRun ? lastRun.toLocaleString() : t.status_never} />
          <Row
            label={t.admin_stats_cron_duration}
            value={cron.lastDurationMs === null ? t.admin_stats_unknown : `${(cron.lastDurationMs / 1000).toFixed(1)} s`}
          />
          <Row label={t.admin_stats_cron_stage} value={cron.stage ?? "—"} />
        </Panel>

        <Panel title={t.admin_stats_section_features} icon="cog">
          <Row label={t.admin_stats_feature_ai} value={flags(features.ai, t)} />
          <Row label={t.admin_stats_feature_vectorize} value={flags(features.vectorize, t)} />
          <Row label={t.admin_stats_feature_email} value={flags(features.email, t)} />
          <Row label={t.admin_stats_feature_turnstile} value={flags(features.turnstile, t)} />
          <Row
            label={t.admin_stats_feature_page_cache}
            value={
              features.page_cache.enabled
                ? `${features.page_cache.ttl_seconds} s + ${features.page_cache.swr_seconds} s`
                : t.admin_media_cache_config_no
            }
          />
          <Row
            label={t.admin_stats_feature_registrations}
            value={features.registrations.enabled ? (features.registrations.approval_required ? t.admin_stats_approval : t.admin_media_cache_config_yes) : t.admin_media_cache_config_no}
          />
          <Row label={t.admin_stats_feature_anonymous} value={anonymousTimelineLabel(t, features.anonymous_timelines)} />
          <Row label={t.admin_stats_feature_version} value={status.version} mono />
        </Panel>
      </section>
    </div>
  );
}

function flags(enabled: boolean, t: Translations): string {
  return enabled ? t.admin_media_cache_config_yes : t.admin_media_cache_config_no;
}

/** The setting is an enum; the settings screen already names each value. */
function anonymousTimelineLabel(t: Translations, value: string): string {
  if (value === "public") return t.admin_settings_anon_timelines_public;
  if (value === "public_local") return t.admin_settings_anon_timelines_public_local;
  return t.admin_settings_anon_timelines_none;
}

function SectionTitle({ icon, title }: { icon: string; title: string }) {
  return (
    <h2 style={{ fontSize: "1.05rem", margin: 0 }}>
      <Icon name={icon} /> {title}
    </h2>
  );
}

function Panel({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: "1.1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <strong style={{ fontSize: "0.95rem", marginBottom: "0.25rem" }}>
        <Icon name={icon} /> {title}
      </strong>
      {children}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", fontSize: "0.82rem" }}>
      <span style={{ color: "var(--text-secondary)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      <strong style={{ whiteSpace: "nowrap", fontFamily: mono ? "var(--font-mono)" : undefined }}>{value}</strong>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="card"
      style={{
        padding: "0.9rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.2rem",
        borderLeft: "3px solid var(--accent)",
      }}
    >
      <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</span>
      <strong style={{ fontSize: "1.25rem" }}>{value}</strong>
    </div>
  );
}
