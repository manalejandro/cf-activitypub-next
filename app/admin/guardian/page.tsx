"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { getToolApproval, getToolCallId, getToolPartState, useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart } from "ai";
import { useLocale } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { Loading } from "@/components/Loading";
import type { GuardianAgentDO } from "@/lib/guardian/agent";

/** Instance name of the shared moderation conversation (one per instance). */
const AGENT_NAME = "instance";

interface Snapshot {
  accounts: { local: number; remote: number; suspended: number; limited: number };
  local_statuses_last_24h: number;
  open_reports: number;
  registrations_pending: number;
  moderation_decisions_last_24h: number;
}

/**
 * The Guardian's chat panel.
 *
 * The Guardian runs as a Cloudflare Agent (`lib/guardian/agent.ts`): the
 * conversation lives in the Durable Object's SQLite (survives deploys and
 * evictions), the moderation snapshot is synced over the agent's WebSocket, and
 * every action tool waits for an approval click here before it runs.
 */
export default function AdminGuardianPage() {
  const { t } = useLocale();
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const agent = useAgent<GuardianAgentDO, { model?: string; snapshot?: Snapshot | null; updatedAt?: string | null }>({
    agent: "GuardianAgent",
    name: AGENT_NAME,
  });

  const { messages, sendMessage, status, clearHistory, addToolApprovalResponse } = useAgentChat({
    agent,
  });

  const snapshot = agent.state?.snapshot ?? null;

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    });
  }, []);

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const text = input.trim();
      if (!text || status !== "ready") return;
      sendMessage({ text });
      setInput("");
      scrollToBottom();
    },
    [input, sendMessage, status, scrollToBottom]
  );

  const busy = status === "submitted" || status === "streaming";

  const stats = useMemo(() => {
    if (!snapshot) return [];
    return [
      { key: "open_reports", value: snapshot.open_reports, danger: snapshot.open_reports > 0 },
      { key: "registrations_pending", value: snapshot.registrations_pending, danger: false },
      { key: "suspended", value: snapshot.accounts.suspended, danger: false },
      { key: "limited", value: snapshot.accounts.limited, danger: false },
      { key: "local_statuses_last_24h", value: snapshot.local_statuses_last_24h, danger: false },
      { key: "moderation_decisions_last_24h", value: snapshot.moderation_decisions_last_24h, danger: false },
    ];
  }, [snapshot]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", height: "calc(100vh - 3rem)" }}>
      <div>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>
          <Icon name="shield" /> {t.admin_guardian_title}
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>{t.admin_guardian_desc}</p>
        {agent.connectionError && (
          <p style={{ color: "var(--danger)", fontSize: "0.85rem", marginTop: "0.35rem" }}>
            <Icon name="exclamation-triangle" /> {t.admin_guardian_admin_only}
          </p>
        )}
      </div>

      <div style={{ display: "flex", gap: "1rem", flex: 1, minHeight: 0, flexWrap: "wrap" }}>
        {/* Chat */}
        <div style={{ flex: "1 1 26rem", minWidth: 0, display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--bg-surface)" }}>
          <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "0.875rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {messages.length === 0 && (
              <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{t.admin_guardian_empty}</p>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                style={{
                  alignSelf: message.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "90%",
                  background: message.role === "user" ? "var(--accent-bg)" : "var(--bg-elevated)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "0.5rem 0.75rem",
                  fontSize: "0.85rem",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {message.parts.map((part, index) => {
                  if (part.type === "text") {
                    return <span key={index}>{part.text}</span>;
                  }
                  if (!isToolUIPart(part)) return null;
                  const state = getToolPartState(part);
                  const approval = getToolApproval(part);
                  return (
                    <div key={getToolCallId(part) ?? index} style={{ marginTop: "0.35rem", fontSize: "0.78rem", color: "var(--text-secondary)" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                        <Icon name={state === "complete" ? "check" : state === "error" ? "times" : "cog"} size="0.75rem" />
                        {getToolName(part)}
                        {state === "complete" && <span style={{ color: "var(--success)" }}>· {t.admin_guardian_tool_done}</span>}
                        {state === "error" && <span style={{ color: "var(--danger)" }}>· {t.admin_guardian_tool_failed}</span>}
                      </span>
                      {approval && state === "waiting-approval" && (
                        <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem", alignItems: "center" }}>
                          <span style={{ color: "var(--warning)" }}>{t.admin_guardian_needs_approval}</span>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => {
                              addToolApprovalResponse({ id: approval.id, approved: true });
                              scrollToBottom();
                            }}
                          >
                            {t.admin_guardian_approve}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => addToolApprovalResponse({ id: approval.id, approved: false })}
                          >
                            {t.admin_guardian_reject}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            {busy && (
              <div style={{ color: "var(--text-muted)", fontSize: "0.8rem", display: "flex", gap: "0.4rem", alignItems: "center" }}>
                <Loading /> {t.admin_guardian_thinking}
              </div>
            )}
          </div>

          <form onSubmit={submit} style={{ display: "flex", gap: "0.5rem", padding: "0.75rem", borderTop: "1px solid var(--border)" }}>
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder={t.admin_guardian_placeholder}
              aria-label={t.admin_guardian_placeholder}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={busy}
            />
            <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()}>
              <Icon name="paper-plane" color="currentColor" /> {t.admin_guardian_send}
            </button>
            {messages.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost"
                title={t.admin_guardian_clear}
                aria-label={t.admin_guardian_clear}
                onClick={() => clearHistory()}
              >
                <Icon name="trash" />
              </button>
            )}
          </form>
        </div>

        {/* Snapshot */}
        <aside style={{ flex: "0 0 16rem", minWidth: "14rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--bg-surface)", padding: "0.75rem" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
              <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)" }}>{t.admin_guardian_snapshot}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                title={t.admin_guardian_refresh}
                aria-label={t.admin_guardian_refresh}
                onClick={() => void agent.stub.refreshSnapshot()}
              >
                <Icon name="refresh" />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.82rem" }}>
              {stats.map((stat) => (
                <div key={stat.key} style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                  <span style={{ color: "var(--text-secondary)" }}>{t[`admin_guardian_${stat.key}` as keyof typeof t]}</span>
                  <strong style={{ color: stat.danger ? "var(--danger)" : "var(--text)" }}>{stat.value}</strong>
                </div>
              ))}
              {!snapshot && <span style={{ color: "var(--text-muted)" }}>{t.admin_guardian_loading}</span>}
            </div>
            <div style={{ marginTop: "0.6rem", fontSize: "0.72rem", color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: "0.15rem" }}>
              <span>{t.admin_guardian_model}: {agent.state?.model ?? "—"}</span>
              <span>
                {t.admin_guardian_updated}: {agent.state?.updatedAt ? new Date(agent.state.updatedAt).toLocaleTimeString() : "—"}
              </span>
            </div>
          </div>
          <p style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>{t.admin_guardian_approval_hint}</p>
        </aside>
      </div>
    </div>
  );
}
