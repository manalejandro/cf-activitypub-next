"use client";

import { useLocale, type Translations } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { formatBytes, formatCount } from "@/lib/format";

/** One component of the instance status, as the API returns it. */
export interface StatusComponentDTO {
  key: string;
  state: string;
  metrics: Record<string, number | string | null>;
}

/** Component key → its i18n label. */
const COMPONENT_KEYS: Record<string, keyof Translations> = {
  web: "status_component_web",
  database: "status_component_database",
  federation: "status_component_federation",
  delivery: "status_component_delivery",
  media: "status_component_media",
  streaming: "status_component_streaming",
  maintenance: "status_component_maintenance",
};

const COMPONENT_ICONS: Record<string, string> = {
  web: "globe",
  database: "database",
  federation: "exchange",
  delivery: "paper-plane",
  media: "hdd-o",
  streaming: "signal",
  maintenance: "clock-o",
};

const STATE_KEYS: Record<string, keyof Translations> = {
  operational: "status_state_operational",
  degraded: "status_state_degraded",
  down: "status_state_down",
  unknown: "status_state_unknown",
  disabled: "status_state_disabled",
};

const STATE_COLORS: Record<string, string> = {
  operational: "var(--success)",
  degraded: "var(--warning)",
  down: "var(--danger)",
  unknown: "var(--text-muted)",
  disabled: "var(--text-muted)",
};

const STATE_ICONS: Record<string, string> = {
  operational: "check-circle",
  degraded: "exclamation-triangle",
  down: "times-circle",
  unknown: "question-circle",
  disabled: "minus-circle",
};

export function componentLabel(t: Translations, key: string): string {
  const translationKey = COMPONENT_KEYS[key];
  return translationKey ? t[translationKey] : key;
}

export function stateLabel(t: Translations, state: string): string {
  const translationKey = STATE_KEYS[state];
  return translationKey ? t[translationKey] : t.status_state_unknown;
}

/** Localized "12 min" / "3 h" / "2 d" for a number of minutes. */
export function formatAgo(t: Translations, minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return t.status_never;
  if (minutes < 60) return t.status_ago_minutes.replace("{n}", String(Math.max(0, Math.round(minutes))));
  if (minutes < 48 * 60) return t.status_ago_hours.replace("{n}", String(Math.round(minutes / 60)));
  return t.status_ago_days.replace("{n}", String(Math.round(minutes / 1440)));
}

/** The measured line shown under a component's label. */
export function componentMetricLine(t: Translations, component: StatusComponentDTO): string | null {
  const m = component.metrics ?? {};
  const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  switch (component.key) {
    case "web":
    case "database": {
      const ms = number(m.latency_ms ?? m.probe_ms);
      return ms === null ? null : t.status_metric_latency.replace("{ms}", String(ms));
    }
    case "federation": {
      const parts = [t.status_metric_last_activity.replace("{value}", formatAgo(t, number(m.last_activity_minutes)))];
      const domains = number(m.domains);
      if (domains !== null) parts.push(t.status_metric_domains.replace("{n}", formatCount(domains)));
      return parts.join(" · ");
    }
    case "delivery": {
      const failures = number(m.failures_24h) ?? 0;
      return t.status_metric_failures_24h.replace("{n}", formatCount(failures));
    }
    case "media": {
      if (component.state === "disabled") return null;
      const entries = formatCount(number(m.entries) ?? 0);
      const size = formatBytes(number(m.bytes) ?? 0);
      const line = t.status_metric_media.replace("{entries}", entries).replace("{size}", size);
      const pending = number(m.pending) ?? 0;
      return pending > 0 ? `${line} · ${t.status_metric_pending.replace("{n}", formatCount(pending))}` : line;
    }
    case "streaming": {
      const connections = number(m.connections);
      return connections === null ? null : t.status_metric_connections.replace("{n}", formatCount(connections));
    }
    case "maintenance": {
      const parts = [t.status_metric_last_run.replace("{value}", formatAgo(t, number(m.last_run_minutes)))];
      if (typeof m.stage === "string" && m.stage) parts.push(t.status_metric_stage.replace("{stage}", m.stage));
      return parts.join(" · ");
    }
    default:
      return null;
  }
}

export function StateBadge({ state }: { state: string }) {
  const { t } = useLocale();
  const color = STATE_COLORS[state] ?? STATE_COLORS.unknown;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.25rem 0.7rem",
        borderRadius: "999px",
        border: `1px solid ${color}`,
        color,
        fontSize: "0.78rem",
        whiteSpace: "nowrap",
      }}
    >
      <Icon name={STATE_ICONS[state] ?? STATE_ICONS.unknown} color={color} />
      {stateLabel(t, state)}
    </span>
  );
}

/** The component list shared by the public status page and the admin panel. */
export function InstanceStatusPanel({ components }: { components: StatusComponentDTO[] }) {
  const { t } = useLocale();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {components.map((component) => {
        const line = componentMetricLine(t, component);
        return (
          <div
            key={component.key}
            className="card"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
              padding: "0.85rem 1.1rem",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.85rem", minWidth: 0 }}>
              <Icon name={COMPONENT_ICONS[component.key] ?? "circle"} size="1.1rem" color="var(--text-muted)" />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{componentLabel(t, component.key)}</div>
                {line ? <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{line}</div> : null}
              </div>
            </div>
            <StateBadge state={component.state} />
          </div>
        );
      })}
    </div>
  );
}

/** Big banner with the overall verdict. */
export function OverallBanner({ overall }: { overall: string }) {
  const { t } = useLocale();
  const color = STATE_COLORS[overall] ?? STATE_COLORS.unknown;
  const titleKey = {
    operational: "status_overall_operational",
    degraded: "status_overall_degraded",
    down: "status_overall_down",
  }[overall] as keyof Translations | undefined;
  return (
    <div
      className="card"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.85rem",
        padding: "1rem 1.25rem",
        borderLeft: `4px solid ${color}`,
      }}
    >
      <Icon name={STATE_ICONS[overall] ?? STATE_ICONS.unknown} size="1.5rem" color={color} />
      <div>
        <div style={{ fontWeight: 700, fontSize: "1.05rem", color }}>{titleKey ? t[titleKey] : t.status_overall_unknown}</div>
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{t.status_overall_hint}</div>
      </div>
    </div>
  );
}
