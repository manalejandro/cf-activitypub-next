"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { PageLayout } from "@/components/PageLayout";
import { Sidebar } from "@/components/Sidebar";
import { StatusCard, type Status, type Account, type Me } from "@/components/StatusCard";
import { Icon, type IconName } from "@/components/Icon";
import {
  generateKeyPackage,
  storeSessionInitKey,
  forgetSessionInitKey,
  hydrateSessionInitKeys,
  listSessionInitKeys,
  exportSessionInitKeys,
  importSessionInitKeys,
  sealToKeyPackage,
  openEnvelope,
  encodeSenderContext,
  parseKeyPackageObject,
} from "@/lib/mls/keypackage";

// /e2ee — the authenticated user's view of their MLS messages and key packages.
// Encryption and decryption happen in the browser: this server never sees the
// plaintext, only the envelopes. Publishing key packages and sending messages
// go through the actor's outbox.

function uuid(): string {
  return crypto.randomUUID();
}

/** Decode a base64 string back to text. */
function base64Decode(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

interface Envelope {
  mediaType: string;
  encoding: string;
  content: string;
}

interface RecipientKeyPackage {
  objectId: string | null;
  ciphersuite?: string | null;
  mediaType?: string | null;
  encoding?: string | null;
  content: string;
}

/**
 * Real envelope: seals the plaintext with HPKE (RFC 9180) to the recipient's
 * active KeyPackage init_key and wraps it as an MLSMessage. The key package
 * objectId is embedded in the sender context so the recipient can open it.
 */
async function makeEnvelope(
  plain: string,
  opts: { sender: string; recipient: string; objectType: string; keyPackage: RecipientKeyPackage }
): Promise<Envelope> {
  const kp = parseKeyPackageObject(opts.keyPackage);
  if (!kp) throw new Error("recipient key package is not a valid MLS KeyPackage");
  const senderContext = encodeSenderContext(opts.keyPackage.objectId ?? opts.recipient);
  const content = await sealToKeyPackage(plain, kp, senderContext);
  return { mediaType: "message/mls", encoding: "base64", content };
}

interface DecryptedEnvelope {
  scheme: string;
  version: string;
  type: string;
  sender: string;
  recipient: string;
  keyPackage: string | null;
  ciphertext?: string;
  plaintext: string;
}

/**
 * Real decryption performed entirely on the client. The server only ever stores
 * and relays the opaque `content` envelope. Works when the message was sealed
 * to a key package whose private half is registered in this browser session;
 * otherwise it falls back to legacy JSON envelopes (scheme "mls").
 */
async function decryptMessage(content: string | null): Promise<string | null> {
  if (!content) return null;
  try {
    const opened = await openEnvelope(content);
    if (opened) return opened.plaintext;
  } catch {
    /* not a real envelope */
  }
  try {
    const payload = JSON.parse(base64Decode(content)) as Partial<DecryptedEnvelope>;
    if (payload.scheme === "mls" && typeof payload.ciphertext === "string") {
      return base64Decode(payload.ciphertext);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** POST an ActivityPub activity to the local actor's outbox. */
async function postOutbox(username: string, activity: unknown): Promise<void> {
  const token = getToken();
  const res = await fetch(`/users/${username}/outbox`, {
    method: "POST",
    headers: {
      "Content-Type": "application/activity+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: "include",
    body: JSON.stringify(activity),
  });
  if (!res.ok) throw new Error(`outbox returned ${res.status}`);
}

interface Sender {
  id: string;
  username: string;
  acct: string;
  displayName: string;
  avatarUrl: string | null;
}

interface MlsMessage {
  id: string;
  recipientId: string;
  type: string;
  objectType: string | null;
  sender: Sender;
  conversation: string | null;
  content: string | null;
  published: string;
}

interface KeyPackage {
  id: string;
  objectId: string;
  ciphersuite: string | null;
  encoding: string | null;
  content: string | null;
  isActive: boolean;
  createdAt: string;
}

interface E2eeData {
  me: { id: string; username: string; acct: string; acctFull: string } & Sender;
  baseUrl: string;
  keyPackagesUrl: string;
  messagesUrl: string;
  messages: MlsMessage[];
  keyPackages: KeyPackage[];
  conversations: { conversation: string; last: string }[];
}

function envelopePreview(content: string | null, emptyLabel: string): string {
  if (!content) return emptyLabel;
  const flat = content.replace(/\s+/g, "");
  const head = flat.slice(0, 72);
  return flat.length > head.length ? `${head}…` : head;
}

function EnvelopePreview({ text }: { text: string }) {
  return (
    <div
      style={{
        marginTop: "0.5rem",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        padding: "0.5rem 0.625rem",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "0.75rem",
        color: "var(--text-muted)",
        overflowX: "auto",
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </div>
  );
}

function messageTitle(t: ReturnType<typeof useLocale>["t"], m: MlsMessage): string {
  switch (m.objectType) {
    case "Welcome": return t.e2ee_msg_welcome;
    case "GroupInfo": return t.e2ee_msg_groupinfo;
    case "PrivateMessage": return t.e2ee_msg_private;
    case "PublicMessage": return t.e2ee_msg_public;
    case "KeyPackage": return t.e2ee_msg_keypackage;
    default: return m.type === "Delete" ? t.e2ee_msg_deleted : (m.objectType ?? t.e2ee_msg_generic);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function toAccount(s: Sender): Account {
  return { id: s.id, username: s.username, acct: s.acct, display_name: s.displayName, avatar: s.avatarUrl ?? "" };
}

function toMe(data: E2eeData): Me {
  return { id: data.me.id, username: data.me.username, acct: data.me.acct, display_name: data.me.displayName, avatar: data.me.avatarUrl ?? "" };
}

function messageToStatus(m: MlsMessage, t: ReturnType<typeof useLocale>["t"], decryptedPlaintext: string | null): Status {
  const decrypted = decryptedPlaintext !== null
    ? { plaintext: decryptedPlaintext, type: m.objectType ?? "PrivateMessage" }
    : null;
  const title = escapeHtml(messageTitle(t, m));
  const parts: string[] = [];
  if (decrypted) {
    parts.push(`<p style="margin:0 0 0.35rem"><strong>${title}</strong></p>`);
    parts.push(`<p style="margin:0">${escapeHtml(decrypted.plaintext)}</p>`);
  } else {
    parts.push(`<p style="margin:0;color:var(--text-muted)">${title} · ${escapeHtml(t.e2ee_result_hint)}</p>`);
  }
  if (m.conversation) {
    parts.push(`<p style="margin:0.35rem 0 0;font-size:0.8rem;color:var(--text-muted)">${escapeHtml(t.e2ee_conversation_label)} <code>${escapeHtml(m.conversation)}</code></p>`);
  }
  if (m.content) {
    parts.push(
      `<details style="margin-top:0.4rem"><summary style="cursor:pointer;font-size:0.75rem;color:var(--text-muted)">${escapeHtml(t.e2ee_show_envelope)}</summary>` +
      `<pre style="font-size:0.7rem;overflow-x:auto;white-space:pre-wrap;background:var(--bg-elevated);padding:0.4rem 0.6rem;border-radius:var(--radius-sm)">${escapeHtml(envelopePreview(m.content, t.e2ee_envelope_empty))}</pre></details>`
    );
  }
  return {
    id: m.id,
    content: parts.join(""),
    created_at: m.published,
    account: toAccount(m.sender),
    favourites_count: 0,
    reblogs_count: 0,
    replies_count: 0,
    favourited: false,
    reblogged: false,
    media_attachments: [],
    sensitive: false,
    spoiler_text: "",
    poll: null,
    ap_type: m.objectType ?? undefined,
  };
}

function conversationToStatus(
  c: { conversation: string; last: string },
  messages: MlsMessage[],
  me: Sender,
  t: ReturnType<typeof useLocale>["t"],
  decryptedByMessage: Map<string, string | null>
): Status {
  const convMsgs = messages.filter((m) => m.conversation === c.conversation);
  const last = convMsgs.length ? convMsgs[convMsgs.length - 1] : null;
  const preview = last && decryptedByMessage.get(last.id) ? decryptedByMessage.get(last.id)! : t.e2ee_envelope_empty;
  const content = [
    `<p style="margin:0 0 0.35rem"><strong>${escapeHtml(c.conversation)}</strong></p>`,
    `<p style="margin:0;font-size:0.8rem;color:var(--text-muted)">${convMsgs.length} ${escapeHtml(t.e2ee_stat_messages)}</p>`,
    `<p style="margin:0.35rem 0 0;color:var(--text-secondary)">${escapeHtml(preview)}</p>`,
  ].join("");
  return {
    id: `conversation:${c.conversation}`,
    content,
    created_at: c.last,
    account: toAccount(me),
    favourites_count: 0,
    reblogs_count: 0,
    replies_count: 0,
    favourited: false,
    reblogged: false,
    media_attachments: [],
    sensitive: false,
    spoiler_text: "",
    poll: null,
    ap_type: "Conversation",
  };
}

export default function E2EEPage() {
  const { t } = useLocale();
  const [data, setData] = useState<E2eeData | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  // plaintext per message, decrypted in the browser (null = not decryptable here)
  const [decryptedByMessage, setDecryptedByMessage] = useState<Map<string, string | null>>(new Map());

  const load = (signal?: AbortSignal) =>
    fetch("/api/v1/e2ee", { credentials: "include", signal })
      .then(async (res) => {
        if (res.status === 401) { setAuthed(false); return null; }
        if (!res.ok) { setAuthed(false); return null; }
        return await res.json() as E2eeData;
      });

  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        data.messages.map(async (m) => [m.id, await decryptMessage(m.content)] as const)
      );
      if (!cancelled) setDecryptedByMessage(new Map(entries));
    })();
    return () => { cancelled = true; };
  }, [data]);

  useEffect(() => {
    const ctrl = new AbortController();
    // Private keys were persisted to localStorage when published; reload them so
    // messages stay decryptable across page reloads.
    hydrateSessionInitKeys()
      .then(() => load(ctrl.signal))
      .then((d) => {
        if (d) { setData(d); setAuthed(true); }
      })
      .catch(() => { if (!ctrl.signal.aborted) setAuthed(false); });
    return () => ctrl.abort();
  }, []);

  // ── Publish key package ─────────────────────────────────────────────────
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function handlePublish() {
    if (!data) return;
    setPublishing(true);
    setPublishMsg(null);
    try {
      const actorIri = data.me.id;
      const objectId = `${actorIri}/keyPackages/${uuid()}`;
      const kp = await generateKeyPackage(actorIri);
      // Keep the private half in this session: allows decrypting messages sealed
      // to this key package (equivalent to persisting it in a real client).
      storeSessionInitKey(objectId, kp.session());
      const activity = {
        "@context": ["https://www.w3.org/ns/activitystreams", "https://purl.archive.org/socialweb/mls"],
        id: `${actorIri}/outbox-activities/${uuid()}`,
        type: "Create",
        actor: actorIri,
        published: new Date().toISOString(),
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        object: { id: objectId, type: "KeyPackage", ciphersuite: kp.ciphersuite, mediaType: kp.mediaType, encoding: kp.encoding, content: kp.content },
      };
      await postOutbox(data.me.username, activity);
      setPublishMsg({ ok: true, text: t.e2ee_publish_ok });
      const d = await load();
      if (d) setData(d);
    } catch {
      setPublishMsg({ ok: false, text: t.e2ee_publish_err });
    } finally {
      setPublishing(false);
    }
  }

  // ── Send MLS message ────────────────────────────────────────────────────
  const [recipient, setRecipient] = useState("");
  const [objectType, setObjectType] = useState<string>("PrivateMessage");
  const [plain, setPlain] = useState("");
  const [conversation, setConversation] = useState("");
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [resolvedIri, setResolvedIri] = useState<string | null>(null);

  // ── Delete key packages / messages / conversations ─────────────────────
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteMsg, setDeleteMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // ── Backup / restore session init keys ─────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [keysBusy, setKeysBusy] = useState(false);
  const [keysMsg, setKeysMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleExportKeys() {
    if (!data) return;
    setKeysBusy(true);
    setKeysMsg(null);
    try {
      const bundle = await exportSessionInitKeys();
      if (bundle.keys.length === 0) {
        setKeysMsg({ ok: false, text: t.e2ee_export_empty });
        return;
      }
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cf-ap-mls-keys-${data.me.username}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setKeysMsg({ ok: true, text: t.e2ee_export_ok });
    } catch {
      setKeysMsg({ ok: false, text: t.e2ee_export_err });
    } finally {
      setKeysBusy(false);
    }
  }

  async function handleImportKeysFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setKeysBusy(true);
    setKeysMsg(null);
    try {
      const text = await file.text();
      let bundle: unknown;
      try {
        bundle = JSON.parse(text);
      } catch {
        setKeysMsg({ ok: false, text: t.e2ee_import_invalid });
        return;
      }
      const count = await importSessionInitKeys(bundle);
      if (count === 0) {
        setKeysMsg({ ok: false, text: t.e2ee_import_invalid });
        return;
      }
      setKeysMsg({ ok: true, text: t.e2ee_import_ok.replace("{count}", String(count)) });
      // Reload so messages sealed to the freshly imported keys can be decrypted.
      const reloaded = await load();
      if (reloaded) setData(reloaded);
    } catch {
      setKeysMsg({ ok: false, text: t.e2ee_import_err });
    } finally {
      setKeysBusy(false);
    }
  }

  async function handleDelete(target: "key-package" | "message" | "conversation", id: string) {
    if (!data) return;
    setDeleting(id);
    setDeleteMsg(null);
    try {
      if (target === "key-package") {
        // The server deletes the key package and its messages; here we forget the
        // persisted private copy so no orphaned key is left behind.
        forgetSessionInitKey(id);
      }
      const res = await fetch(`/api/v1/e2ee?target=${target}&id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error();
      setDeleteMsg({ ok: true, text: t.e2ee_delete_ok });
      const d = await load();
      if (d) setData(d);
    } catch {
      setDeleteMsg({ ok: false, text: t.e2ee_delete_err });
    } finally {
      setDeleting(null);
    }
  }

  async function handleDeleteLocalKey(objectId: string) {
    setDeleting(objectId);
    setDeleteMsg(null);
    try {
      forgetSessionInitKey(objectId);
      setDeleteMsg({ ok: true, text: t.e2ee_delete_ok });
    } catch {
      setDeleteMsg({ ok: false, text: t.e2ee_delete_err });
    } finally {
      setDeleting(null);
    }
  }

  async function handleResolve() {
    if (!recipient.trim() || !data) return;
    try {
      const res = await fetch(`/api/v1/e2ee/resolve?handle=${encodeURIComponent(recipient.trim().replace(/^@/, ""))}`);
      if (!res.ok) { setSendMsg({ ok: false, text: t.e2ee_receiver_err }); setResolvedIri(null); return; }
      const r = await res.json() as { iri: string };
      setResolvedIri(r.iri);
      setSendMsg({ ok: true, text: `${t.e2ee_receiver_ok}: ${r.iri}` });
    } catch {
      setSendMsg({ ok: false, text: t.e2ee_receiver_err });
      setResolvedIri(null);
    }
  }

  async function handleSend() {
    if (!data || !resolvedIri) return;
    setSending(true);
    setSendMsg(null);
    try {
      const actorIri = data.me.id;
      // Envelope for the recipient: HPKE to the init_key of their active key package.
      const kpRes = await fetch(`/api/v1/e2ee/keypackage?iri=${encodeURIComponent(resolvedIri)}`);
      if (!kpRes.ok) {
        let detail: string | null = null;
        try { detail = ((await kpRes.json()) as { error?: string }).error ?? null; } catch { /* ignore */ }
        setSendMsg({ ok: false, text: detail ?? t.e2ee_no_key_recipient });
        return;
      }
      const recipientKp = await kpRes.json() as RecipientKeyPackage;
      const envelope = await makeEnvelope(plain || " ", {
        sender: actorIri,
        recipient: resolvedIri,
        objectType,
        keyPackage: recipientKp,
      });
      // Copy for the sender: the same text is sealed to their OWN active key
      // package so they can re-decrypt it in the message list. Without this,
      // their copy would be sealed to the recipient's key and unreadable.
      let senderContent: string | null = null;
      const selfKpRes = await fetch(`/api/v1/e2ee/keypackage?iri=${encodeURIComponent(actorIri)}`);
      if (selfKpRes.ok) {
        const selfKp = await selfKpRes.json() as RecipientKeyPackage;
        const selfParsed = parseKeyPackageObject(selfKp);
        if (selfParsed) {
          senderContent = await sealToKeyPackage(
            plain || " ",
            selfParsed,
            encodeSenderContext(selfKp.objectId ?? actorIri)
          );
        }
      }
      const objectId = `${new URL(actorIri).origin}/objects/${uuid()}`;
      // Draft: MLS messages must be addressed only to explicit actors, never to
      // collections (followers, as:Public). PublicMessage is public *by type*:
      // the server surfaces its envelope on the public timeline regardless.
      const to = [resolvedIri];
      // `conversation` must be an IRI (an OrderedCollection of the group's
      // activities, draft §conversation). Normalize free-text input into a
      // conversation collection URI under the sender's actor namespace.
      const rawConv = conversation.trim();
      const convIri = rawConv
        ? (/^https?:\/\//.test(rawConv)
            ? rawConv
            : `${actorIri}/collections/conversations/${encodeURIComponent(rawConv)}`)
        : undefined;
      const activity = {
        "@context": ["https://www.w3.org/ns/activitystreams", "https://purl.archive.org/socialweb/mls"],
        id: `${actorIri}/outbox-activities/${uuid()}`,
        type: "Create",
        actor: actorIri,
        published: new Date().toISOString(),
        to,
        object: {
          id: objectId,
          type: objectType,
          conversation: convIri,
          mediaType: envelope.mediaType,
          encoding: envelope.encoding,
          content: envelope.content,
          senderContent,
        },
      };
      await postOutbox(data.me.username, activity);
      setSendMsg({ ok: true, text: t.e2ee_send_ok });
      setPlain("");
      const reloaded = await load();
      if (reloaded) setData(reloaded);
    } catch {
      setSendMsg({ ok: false, text: t.e2ee_send_err });
    } finally {
      setSending(false);
    }
  }

  if (authed === null) {
    return (
      <PageLayout sidebar={<Sidebar me={null} currentPath="/e2ee" />}>
        <LoadingSkeleton />
      </PageLayout>
    );
  }

  if (!authed || !data) {
    return (
      <PageLayout sidebar={<Sidebar me={null} currentPath="/e2ee" />}>
        <div className="flex flex-col items-center justify-center" style={{ padding: "5rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
          <span style={{ fontSize: "3rem", marginBottom: "1rem" }}><Icon name="lock" size="3rem" /></span>
          <h2 style={{ margin: 0 }}>{t.e2ee_signed_out_title}</h2>
          <p style={{ maxWidth: 420, fontSize: "0.9rem" }}>{t.e2ee_signed_out_body}</p>
          <Link href="/login" className="btn btn-primary">{t.e2ee_sign_in}</Link>
        </div>
      </PageLayout>
    );
  }

  const meForCards = toMe(data);

  return (
    <PageLayout sidebar={<Sidebar me={{ username: data.me.username, display_name: data.me.displayName, acct: data.me.acct }} currentPath="/e2ee" />}>
      {/* Cabecera */}
      <div style={{ padding: "1.25rem 1rem", borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: "1.35rem", margin: 0, display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <Icon name="lock" /> {t.e2ee_title}
              <span className="badge badge-accent">{t.e2ee_badge_mls}</span>
            </h1>
            <p style={{ margin: "0.25rem 0 0", color: "var(--text-muted)", fontSize: "0.85rem" }}>
              {t.e2ee_account_line}{" "}
              <strong style={{ color: "var(--text-primary)" }}>@{data.me.acctFull}</strong>
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <Stat value={data.messages.length} label={t.e2ee_stat_messages} />
            <Stat value={data.keyPackages.length} label={t.e2ee_stat_key_packages} />
            <Stat value={data.conversations.length} label={t.e2ee_stat_conversations} />
          </div>
        </div>

        <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap", fontSize: "0.82rem", color: "var(--text-muted)" }}>
          <span>{t.e2ee_stats_hint}</span>
          <Link href={data.keyPackagesUrl} style={{ wordBreak: "break-all" }}>keyPackages</Link>
          <span>·</span>
          <Link href={data.messagesUrl} style={{ wordBreak: "break-all" }}>messages</Link>
        </div>
      </div>

      {/* Publicar key package */}
      <section style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}><Icon name="key" /> {t.e2ee_publish_button}</h2>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.82rem", color: "var(--text-muted)" }}>{t.e2ee_publish_desc}</p>
          </div>
          <button className="btn btn-primary btn-sm" onClick={handlePublish} disabled={publishing}>
            {publishing ? "…" : <><Icon name="plus" color="#fff" /> {t.e2ee_publish_button}</>}
          </button>
        </div>
        {publishMsg && <p style={{ margin: "0.5rem 0 0", fontSize: "0.82rem", color: publishMsg.ok ? "var(--success)" : "var(--danger)" }}>{publishMsg.text}</p>}
      </section>

      {/* Copia de seguridad / restauración de claves */}
      <section style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}><Icon name="save" /> {t.e2ee_keys_title}</h2>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.82rem", color: "var(--text-muted)" }}>{t.e2ee_keys_desc}</p>
            <p style={{ margin: "0.35rem 0 0", fontSize: "0.78rem", color: "var(--text-muted)" }}>{t.e2ee_keys_note}</p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <button className="btn btn-outline btn-sm" onClick={handleExportKeys} disabled={keysBusy}>
              {keysBusy ? "…" : <><Icon name="arrow-down" /> {t.e2ee_export_button}</>}
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => fileInputRef.current?.click()} disabled={keysBusy}>
              <><Icon name="arrow-up" /> {t.e2ee_import_button}</>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={handleImportKeysFile}
            />
          </div>
        </div>
        {keysMsg && <p style={{ margin: "0.5rem 0 0", fontSize: "0.82rem", color: keysMsg.ok ? "var(--success)" : "var(--danger)" }}>{keysMsg.text}</p>}
      </section>

      {/* Enviar mensaje cifrado */}
      <section style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}>
        <h2 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}><Icon name="envelope" /> {t.e2ee_send_title}</h2>
        <p style={{ margin: "0.25rem 0 0.75rem", fontSize: "0.82rem", color: "var(--text-muted)" }}>{t.e2ee_send_desc}</p>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <input
              className="input"
              placeholder={t.e2ee_recipient_ph}
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              style={{ flex: 1, minWidth: 160 }}
            />
            <button type="button" className="btn btn-outline btn-sm" onClick={handleResolve} disabled={!recipient.trim()}>
              <Icon name="search" />
            </button>
          </div>
          {resolvedIri && <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", wordBreak: "break-all" }}>{resolvedIri}</div>}

          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <select
              className="btn btn-ghost btn-sm"
              value={objectType}
              onChange={(e) => setObjectType(e.target.value)}
              style={{ fontSize: "0.82rem", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", color: "var(--text)", padding: "0.4rem 0.6rem" }}
            >
              <option value="PrivateMessage">{t.e2ee_type_private}</option>
              <option value="PublicMessage">{t.e2ee_type_public}</option>
              <option value="Welcome">{t.e2ee_type_welcome}</option>
              <option value="GroupInfo">{t.e2ee_type_groupinfo}</option>
            </select>
            <input
              className="input"
              placeholder={t.e2ee_conv_label}
              value={conversation}
              onChange={(e) => setConversation(e.target.value)}
              style={{ flex: 1, minWidth: 160 }}
            />
          </div>

          <textarea
            className="input"
            placeholder={t.e2ee_plain_label}
            value={plain}
            onChange={(e) => setPlain(e.target.value)}
            rows={2}
            style={{ resize: "none", fontFamily: "inherit" }}
          />

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>{t.e2ee_crypto_note}</span>
            <button className="btn btn-primary btn-sm" onClick={handleSend} disabled={sending || !plain.trim() || !resolvedIri}>
              {sending ? "…" : t.e2ee_send_cta}
            </button>
          </div>
          {sendMsg && <p style={{ margin: 0, fontSize: "0.82rem", color: sendMsg.ok ? "var(--success)" : "var(--danger)", wordBreak: "break-word" }}>{sendMsg.text}</p>}
        </div>
      {deleteMsg && <p style={{ margin: "0.5rem 0 0", fontSize: "0.82rem", color: deleteMsg.ok ? "var(--success)" : "var(--danger)" }}>{deleteMsg.text}</p>}
      </section>

      {/* Key packages */}
      <section>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.9rem 1rem", borderBottom: "1px solid var(--border)" }}>
          <h2 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}>
            {t.e2ee_key_packages_title} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>{t.e2ee_key_packages_sub}</span>
          </h2>
        </div>
        {(() => {
          const serverIds = new Set(data.keyPackages.map((kp) => kp.objectId));
          const localOnlyIds = listSessionInitKeys().filter((id) => !serverIds.has(id));
          const isEmpty = data.keyPackages.length === 0 && localOnlyIds.length === 0;
          if (isEmpty) {
            return <EmptyState icon="key" title={t.e2ee_no_key_packages} sub={t.e2ee_no_key_packages_sub} />;
          }
          return (
            <>
              {data.keyPackages.map((kp) => (
                <div
                  key={kp.id}
                  className="status-card"
                  style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem", padding: "1rem", flexWrap: "wrap" }}
                >
                  <span style={{ fontSize: "1.2rem", lineHeight: 1 }}><Icon name="key" size="1.2rem" /></span>
                  <div className="flex-1" style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                      <span
                        className={kp.isActive ? "badge badge-success" : "badge"}
                        style={!kp.isActive ? { background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)" } : undefined}
                      >
                        {kp.isActive ? t.e2ee_kp_active : t.e2ee_kp_retired}
                      </span>
                      <span className="badge" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                        {kp.ciphersuite ?? "MLS"}
                      </span>
                      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ padding: "0.2rem 0.4rem", color: "var(--danger)" }}
                          onClick={() => void handleDelete("key-package", kp.objectId)}
                          disabled={deleting === kp.objectId}
                          title={t.e2ee_delete}
                        >
                          <Icon name="trash" color="var(--danger)" />
                        </button>
                      </span>
                    </div>
                    <EnvelopePreview text={envelopePreview(kp.content, t.e2ee_envelope_empty)} />
                  </div>
                </div>
              ))}
              {localOnlyIds.map((objectId) => (
                <div
                  key={objectId}
                  className="status-card"
                  style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem", padding: "1rem", flexWrap: "wrap" }}
                >
                  <span style={{ fontSize: "1.2rem", lineHeight: 1 }}><Icon name="key" size="1.2rem" /></span>
                  <div className="flex-1" style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                      <span className="badge" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                        {t.e2ee_kp_local}
                      </span>
                      <span className="badge" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                        MLS
                      </span>
                      <span style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginLeft: "auto" }}>
                        {t.e2ee_kp_local_note}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ padding: "0.2rem 0.4rem", color: "var(--danger)" }}
                        onClick={() => void handleDeleteLocalKey(objectId)}
                        disabled={deleting === objectId}
                        title={t.e2ee_kp_delete_local}
                      >
                        <Icon name="trash" color="var(--danger)" />
                      </button>
                    </div>
                    <div style={{ marginTop: "0.4rem", fontSize: "0.78rem", color: "var(--text-muted)", wordBreak: "break-all" }}>{objectId}</div>
                  </div>
                </div>
              ))}
            </>
          );
        })()}
      </section>

      {/* Conversaciones */}
      <section>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.9rem 1rem", borderBottom: "1px solid var(--border)" }}>
          <h2 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}>{t.e2ee_conversations_title}</h2>
        </div>
        {data.conversations.length === 0 ? (
          <EmptyState icon="comment" title={t.e2ee_no_messages} sub={t.e2ee_no_messages_sub} />
        ) : (
          data.conversations.map((c) => (
            <StatusCard
              key={c.conversation}
              status={conversationToStatus(c, data.messages, data.me, t, decryptedByMessage)}
              me={meForCards}
              hideActions
              forceDelete
              onFav={() => {}}
              onReblog={() => {}}
              onReply={() => {}}
              onDelete={() => void handleDelete("conversation", c.conversation)}
            />
          ))
        )}
      </section>

      {/* Mensajes */}
      <section>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.9rem 1rem", borderBottom: "1px solid var(--border)" }}>
          <h2 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}>{t.e2ee_messages_title}</h2>
        </div>
        {data.messages.length === 0 ? (
          <EmptyState icon="comment" title={t.e2ee_no_messages} sub={t.e2ee_no_messages_sub} />
        ) : (
          data.messages.map((m) => (
            <StatusCard
              key={`${m.recipientId}:${m.id}`}
              status={messageToStatus(m, t, decryptedByMessage.get(m.id) ?? null)}
              me={meForCards}
              hideActions
              forceDelete
              onFav={() => {}}
              onReblog={() => {}}
              onReply={() => {}}
              onDelete={() => void handleDelete("message", m.id)}
            />
          ))
        )}
      </section>

      <div style={{ padding: "1rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>
        {t.e2ee_footer}
      </div>
    </PageLayout>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="card" style={{ padding: "0.5rem 0.85rem", textAlign: "center", borderRadius: "var(--radius)" }}>
      <div style={{ fontWeight: 700, fontSize: "1.1rem" }}>{value}</div>
      <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>{label}</div>
    </div>
  );
}

function EmptyState({ icon, title, sub }: { icon: IconName; title: string; sub: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center"
      style={{ padding: "3.5rem 1.5rem", color: "var(--text-muted)", textAlign: "center" }}
    >
      <span style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}><Icon name={icon} size="2.5rem" /></span>
      <p style={{ margin: 0, fontWeight: 600, color: "var(--text-secondary)" }}>{title}</p>
      <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>{sub}</p>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-0">
      {[1, 2, 3].map((i) => (
        <div key={i} className="status-card flex gap-3" style={{ padding: "1rem" }}>
          <div className="skeleton" style={{ width: 42, height: 42, borderRadius: "50%", flexShrink: 0 }} />
          <div className="flex flex-col gap-2 flex-1">
            <div className="skeleton" style={{ height: 14, width: "40%" }} />
            <div className="skeleton" style={{ height: 14, width: "80%" }} />
            <div className="skeleton" style={{ height: 14, width: "60%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}