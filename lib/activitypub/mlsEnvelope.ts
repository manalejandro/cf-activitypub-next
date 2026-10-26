import type { D1Database } from "@cloudflare/workers-types";
import { createObject, getObjectById } from "@/lib/db";
import type { APActivity } from "@/lib/types";

/**
 * Representation of an MLS object envelope. Public MLS messages
 * (PublicMessage) accepted by this instance are surfaced on the public
 * timeline as an "encrypted envelope" post — the ciphertext is never
 * decrypted, only described.
 */
export interface MlsEnvelopeInput {
  id: string;
  content?: string | null;
  mediaType?: string | null;
  encoding?: string | null;
  ciphersuite?: string | null;
  conversation?: string | null;
}

function escapeHtml(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build safe, sanitizer-friendly HTML describing the encrypted envelope:
 * a short "encrypted public message" lead, the MLS metadata, the
 * conversation IRI and a preview of the ciphertext envelope.
 */
export function buildMlsEnvelopeHtml(obj: MlsEnvelopeInput): string {
  const meta = [obj.encoding, obj.mediaType, obj.ciphersuite].filter(Boolean).join(" · ");
  const conv = obj.conversation
    ? `<p>Conversación: <code>${escapeHtml(obj.conversation)}</code></p>`
    : "";
  const preview = (obj.content ?? "").slice(0, 300);
  const contentBlock = preview
    ? `<pre><code>${escapeHtml(preview)}…</code></pre>`
    : "";
  return (
    `<p>🔒 Mensaje público cifrado · MLS/PublicMessage</p>` +
    (meta ? `<p><code>${escapeHtml(meta)}</code></p>` : "") +
    conv +
    contentBlock
  );
}

/**
 * Store a federated/created PublicMessage so it is reachable by its id.
 * LOCAL envelopes surface on the public timeline as "encrypted envelope"
 * posts; remote ones are stored unlisted — a third-party instance's MLS
 * traffic must not populate our public timeline. No-op for objects that were
 * already ingested as a status.
 */
export async function storePublicMlsEnvelope(
  db: D1Database,
  activity: APActivity,
  obj: MlsEnvelopeInput,
  objType: string,
  actorId: string,
  published: string,
  local: boolean
): Promise<void> {
  // PublicMessage is public *by type* (MLS wire format: signed, not encrypted).
  // We deliberately do NOT require the activity to be addressed to as:Public:
  // the draft says MLS objects must be addressed to explicit actors only.
  if (objType !== "PublicMessage") return;
  if (!obj.id) return;

  // The envelope's id must live on its author's own origin: a remote server
  // must not squat IRIs in our (or a third party's) namespace, which would
  // pre-empt legitimate object ids and confuse permalink resolution.
  try {
    if (new URL(obj.id).hostname !== new URL(actorId).hostname) return;
  } catch {
    return;
  }

  const existing = await getObjectById(db, obj.id).catch(() => null);
  if (existing) return;

  await createObject(db, {
    id: obj.id,
    type: "PublicMessage",
    actorId,
    content: buildMlsEnvelopeHtml(obj),
    contentWarning: null,
    sensitive: false,
    visibility: local ? "public" : "unlisted",
    inReplyToId: obj.conversation ?? null,
    quoteId: null,
    language: null,
    url: obj.id,
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published,
    local,
    raw: JSON.stringify(activity),
  });
}