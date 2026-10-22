import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

vi.mock("@/lib/moderation/pipeline", () => ({
  screenStatus: vi.fn().mockResolvedValue({ blocked: false, markedSensitive: false }),
}));
vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteraction: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteractionToLists: vi.fn().mockResolvedValue(undefined),
  broadcastStatusCreatedToAudience: vi.fn().mockResolvedValue(undefined),
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  broadcastAccountUpdate: vi.fn().mockResolvedValue(undefined),
  broadcastStatusUpdate: vi.fn().mockResolvedValue(undefined),
  broadcastHomeStatusUpdate: vi.fn().mockResolvedValue(undefined),
  broadcastObjectDelete: vi.fn().mockResolvedValue(undefined),
  eligibleLocalRecipients: vi.fn(async (_db: unknown, ids: string[]) => ids),
  actorExclusion: vi.fn(async (_db: unknown, id: string) => ({ id, domain: null })),
  parentExclusion: vi.fn(async () => null),
}));
vi.mock("@/lib/push", () => ({ deliverPushSafe: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/activitypub/queue", () => ({
  enqueueDeliveries: vi.fn().mockResolvedValue(undefined),
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/activitypub/federation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/activitypub/federation")>()),
  collectFollowerInboxes: vi.fn().mockResolvedValue([]),
}));

import { POST as uploadMedia } from "@/app/api/v2/media/route";
import { POST as postStatus } from "@/app/api/v1/statuses/route";
import { GET as getObject } from "@/app/objects/[id]/route";
import { GET as getStatus } from "@/app/api/v1/statuses/[id]/route";

const db = env.DB;
const BASE = "https://local.example.test";
const TOKEN = "documents-token";
const ACTOR = `${BASE}/users/me`;

async function upload(name: string, type: string, content: string, description?: string): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([content], name, { type }));
  if (description) form.append("description", description);
  return uploadMedia(
    new NextRequest(`${BASE}/api/v2/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    })
  );
}

interface AttachmentPayload {
  id: string;
  type: string;
  url: string;
  preview_url: string | null;
  remote_url: string | null;
  description: string | null;
  meta?: { original?: { size?: string } };
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, email, email_verified, discoverable)
       VALUES (?, 'me', 'local.example.test', 'pub', 'priv', 1, 'me@example.com', 1, 1)`
    )
    .bind(ACTOR)
    .run();
  await db
    .prepare(
      `INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at)
       VALUES ('t-documents', ?, NULL, ?, 'read write', datetime('now'))`
    )
    .bind(ACTOR, TOKEN)
    .run();
});

describe("document uploads (PDF / plain text)", () => {
  it("accepts a PDF and serializes it as Mastodon's 'unknown' attachment", async () => {
    const response = await upload("informe.pdf", "application/pdf", "%PDF-1.4 fake", "Resultados del trimestre");
    expect(response.status).toBe(200);

    const attachment = (await response.json()) as AttachmentPayload;
    // Mastodon's MediaAttachment enum has no `document`: unsupported/unrecognized
    // types are `unknown`, which every client renders as a download link.
    expect(attachment.type).toBe("unknown");
    expect(attachment.url).toContain("/api/media/media/me/");
    expect(attachment.url.endsWith("informe.pdf")).toBe(true);
    // No sized preview for a document: the file is its own preview.
    expect(attachment.preview_url).toBe(attachment.url);
    expect(attachment.remote_url).toBeNull();
    expect(attachment.description).toBe("Resultados del trimestre");
    // Mastodon's meta carries the byte size as a string (documents and audio
    // have no aspect ratio to report).
    expect(attachment.meta?.original?.size).toBe(String("%PDF-1.4 fake".length));

    // The bytes really landed in R2, with the right content type.
    const key = attachment.url.split("/api/media/")[1];
    const stored = await env.R2.get(key);
    expect(stored).not.toBeNull();
    expect(stored?.httpMetadata?.contentType).toBe("application/pdf");
  });

  it("accepts a plain-text file", async () => {
    const response = await upload("notas.txt", "text/plain", "hola");
    expect(response.status).toBe(200);
    const attachment = (await response.json()) as AttachmentPayload;
    expect(attachment.type).toBe("unknown");
    expect(attachment.description).toBeNull();
  });

  it("still rejects types the instance does not accept", async () => {
    const response = await upload("paquete.zip", "application/zip", "PK");
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error_code?: string };
    // The i18n key the composers translate.
    expect(payload.error_code).toBe("media_error_type");
  });
});

describe("federating a status with a document", () => {
  async function createStatusWithDocument(): Promise<{ id: string }> {
    const uploaded = (await (await upload("acta.pdf", "application/pdf", "%PDF-1.4 acta", "Acta de la reunión")).json()) as AttachmentPayload;
    const response = await postStatus(
      new NextRequest(`${BASE}/api/v1/statuses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ status: "Acta adjunta", visibility: "public", media_ids: [uploaded.id] }),
      })
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { id: string };
  }

  it("serves the document as an AP Document with its mediaType", async () => {
    const status = await createStatusWithDocument();

    const response = await getObject(
      new NextRequest(`${BASE}/objects/${encodeURIComponent(status.id)}`, {
        headers: { Accept: "application/activity+json" },
      }),
      { params: Promise.resolve({ id: status.id }) }
    );
    expect(response.status).toBe(200);
    const note = (await response.json()) as {
      attachment?: { type: string; mediaType?: string; url?: string; name?: string }[];
    };
    expect(note.attachment).toHaveLength(1);
    const [attachment] = note.attachment ?? [];
    // Mastodon keys the AP side off the type and the REST side off the media
    // type; a PDF must arrive as Document + application/pdf (its parser maps any
    // non-image/video/audio media type to the `unknown` attachment).
    expect(attachment?.type).toBe("Document");
    expect(attachment?.mediaType).toBe("application/pdf");
    expect(attachment?.name).toBe("Acta de la reunión");
    expect(attachment?.url).toContain("/api/media/");
  });

  it("keeps the REST payload Mastodon-shaped", async () => {
    const status = await createStatusWithDocument();

    const response = await getStatus(
      new NextRequest(`${BASE}/api/v1/statuses/${encodeURIComponent(status.id)}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      { params: Promise.resolve({ id: status.id }) }
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { media_attachments: AttachmentPayload[] };
    expect(payload.media_attachments).toHaveLength(1);
    const [attachment] = payload.media_attachments;
    expect(attachment?.type).toBe("unknown");
    expect(attachment?.preview_url).toBe(attachment?.url);
    expect(attachment?.description).toBe("Acta de la reunión");
    expect(attachment?.meta?.original?.size).toBe(String("%PDF-1.4 acta".length));
  });
});
