import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { GET as RSS } from "@/app/users/[username]/rss/route";
import { GET as ATOM } from "@/app/users/[username]/atom/route";

const db = env.DB;
const BASE = "https://local.example.test";
const ALICE = `${BASE}/users/alice`;

async function seedActor(
  id: string,
  opts: { local?: boolean; silenced?: boolean; suspended?: boolean } = {}
): Promise<void> {
  const username = id.split("/").pop()!;
  const domain = new URL(id).hostname;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, email, email_verified, silenced, suspended)
       VALUES (?, ?, ?, 'pub', ?, ?, 1, ?, 1, ?, ?)`
    )
    .bind(id, username, domain, opts.local === false ? null : "priv", opts.local === false ? 0 : 1, `${username}@example.com`, opts.silenced ? 1 : 0, opts.suspended ? 1 : 0)
    .run();
}

async function seedStatus(
  id: string,
  opts: {
    actor?: string;
    visibility?: string;
    content?: string;
    reply?: string;
    published?: string;
    raw?: string;
  } = {}
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, in_reply_to_id, published, updated_at, is_local, media_pending, raw)
       VALUES (?, 'Note', ?, ?, ?, ?, ?, ?, 1, 0, ?)`
    )
    .bind(
      id,
      opts.actor ?? ALICE,
      opts.content ?? "<p>hola</p>",
      opts.visibility ?? "public",
      opts.reply ?? null,
      opts.published ?? "2026-10-01T10:00:00Z",
      opts.published ?? "2026-10-01T10:00:00Z",
      opts.raw ?? "{}"
    )
    .run();
}

function feed(handler: typeof RSS, username: string, query = ""): Promise<Response> {
  return handler(new NextRequest(`${BASE}/users/${username}/rss${query}`), {
    params: Promise.resolve({ username }),
  });
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await seedActor(ALICE);
  await seedActor(`${BASE}/users/spammer`, { silenced: true });
  await seedActor(`${BASE}/users/gone`, { suspended: true });
  await seedActor("https://remote.example/users/bob", { local: false });
});

describe("profile feeds", () => {
  it("serves the public posts as RSS, newest first, without replies, boosts or private posts", async () => {
    await seedStatus(`${BASE}/objects/1`, { content: "<p>el más nuevo &amp; bonito</p>", published: "2026-10-03T10:00:00Z" });
    await seedStatus(`${BASE}/objects/2`, { visibility: "unlisted", content: "<p>no listado</p>", published: "2026-10-02T10:00:00Z" });
    await seedStatus(`${BASE}/objects/3`, { content: "<p>respuesta</p>", reply: `${BASE}/objects/1`, published: "2026-10-01T10:00:00Z" });
    await seedStatus(`${BASE}/objects/4`, { visibility: "private", content: "<p>privado</p>", published: "2026-09-30T10:00:00Z" });
    await seedStatus(`${BASE}/objects/5`, { content: '<p>#etiqueta <a href="/tags/etiqueta">#etiqueta</a></p>', published: "2026-09-29T10:00:00Z" });
    await db
      .prepare("INSERT INTO announces (id, actor_id, object_id, created_at) VALUES ('a1', ?, ?, '2026-10-04T10:00:00Z')")
      .bind(ALICE, `${BASE}/objects/1`)
      .run();

    const res = await feed(RSS, "alice");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const xml = await res.text();

    expect(xml).toContain("<title>alice</title>");
    expect(xml).toContain("Public posts from @alice@local.example.test");
    expect(xml).toContain("<generator>");
    // Newest public/unlisted first, replies/private/boosts left out.
    const links = [...xml.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>[\s\S]*?<\/item>/g)].map((m) => m[1]);
    expect(links).toEqual([`${BASE}/@alice/1`, `${BASE}/@alice/2`, `${BASE}/@alice/5`]);
    expect(xml).not.toContain("/@alice/3");
    expect(xml).not.toContain("/@alice/4");
    // Content is escaped once (the stored entity survives the XML escaping).
    expect(xml).toContain("el más nuevo &amp;amp; bonito");
    // Hashtags become categories, and site-relative links are absolutized (a
    // reader resolves them against the feed, a syndicated copy would lose them).
    expect(xml).toContain("<category>etiqueta</category>");
    expect(xml).toContain(`href=&quot;${BASE}/tags/etiqueta&quot;`);
    // `rel="self"` points at the feed itself.
    expect(xml).toContain(`<atom:link href="${BASE}/users/alice/rss" rel="self" type="application/rss+xml"/>`);
  });

  it("adds media:content for the attachments and an enclosure for the first audio", async () => {
    await seedStatus(`${BASE}/objects/1`, { content: "<p>con audio</p>" });
    await db
      .prepare(
        `INSERT INTO attachments (id, object_id, type, url, mime_type, file_size, description)
         VALUES ('att-1', ?, 'audio', '/api/media/media/alice/clip.mp3', 'audio/mpeg', 2048, 'mi podcast')`
      )
      .bind(`${BASE}/objects/1`)
      .run();
    await db
      .prepare(
        `INSERT INTO attachments (id, object_id, type, url, mime_type, file_size)
         VALUES ('att-2', ?, 'image', 'https://cdn.example/foto.jpg', 'image/jpeg', 4096)`
      )
      .bind(`${BASE}/objects/1`)
      .run();

    const xml = await (await feed(RSS, "alice")).text();
    expect(xml).toContain(`<enclosure url="${BASE}/api/media/media/alice/clip.mp3" type="audio/mpeg" length="2048"/>`);
    expect(xml).toContain(`<media:content url="https://cdn.example/foto.jpg" type="image/jpeg" fileSize="4096" medium="image">`);
    expect(xml).toContain("<media:description>mi podcast</media:description>");
  });

  it("serves the same feed as Atom 1.0", async () => {
    await seedStatus(`${BASE}/objects/1`, { content: "<p>hola</p>" });

    const res = await feed(ATOM, "alice");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/atom+xml");
    const xml = await res.text();
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom"');
    expect(xml).toContain("<entry>");
    expect(xml).toContain(`<id>${BASE}/@alice/1</id>`);
    expect(xml).toContain('<content type="html">');
  });

  it("keeps serving a limited account's posts but has no feed for suspended, remote or unknown accounts", async () => {
    await seedStatus(`${BASE}/objects/1`, { actor: `${BASE}/users/spammer`, content: "<p>limitada</p>" });

    const limited = await feed(RSS, "spammer");
    expect(limited.status).toBe(200);
    expect(await limited.text()).toContain("limitada");

    expect((await feed(RSS, "gone")).status).toBe(404);
    expect((await feed(RSS, "bob")).status).toBe(404);
    expect((await feed(RSS, "nobody")).status).toBe(404);
  });
});
