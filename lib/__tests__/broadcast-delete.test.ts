// @vitest-environment node
import { describe, it, expect } from "vitest";
import { broadcastObjectDelete, type DONamespace } from "@/lib/streaming/broadcast";

interface Event {
  channel: string;
  event: string;
  payload: string;
}

function fakeStream(): { ns: DONamespace; events: Event[] } {
  const events: Event[] = [];
  return {
    events,
    ns: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_input: string | URL, init?: RequestInit) => {
          events.push(JSON.parse(String(init?.body ?? "{}")) as Event);
          return new Response("ok");
        },
      }),
    },
  };
}

function fakeDb(rows: { followers?: string[]; lists?: string[] }) {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
              if (sql.includes("list_accounts")) {
                return { results: (rows.lists ?? []).map((list_id) => ({ list_id })) as T[] };
              }
              return { results: (rows.followers ?? []).map((id) => ({ id })) as T[] };
            },
          };
        },
      };
    },
  };
}

describe("broadcastObjectDelete", () => {
  it("fans a deletion out to public, followers, hashtags and lists", async () => {
    const stream = fakeStream();
    const db = fakeDb({
      followers: ["https://local.example/users/follower"],
      lists: ["list-1"],
    });

    await broadcastObjectDelete(stream.ns, db as never, {
      id: "https://local.example/objects/abc",
      local: true,
      visibility: "public",
      actorId: "https://local.example/users/author",
      raw: JSON.stringify({ tag: [{ type: "Hashtag", name: "#news" }] }),
    });

    const channels = stream.events.map((e) => `${e.channel}:${e.event}`);
    expect(channels).toContain("public:delete");
    expect(channels).toContain("public:local:delete");
    expect(channels).toContain("home:follower:delete");
    // The author's own home must get it too: an auto-deleted status otherwise
    // stays in the author's cached feed.
    expect(channels).toContain("home:author:delete");
    expect(channels).toContain("hashtag:news:delete");
    // Regression: the list branch used to read the DOM global `status`, throw
    // inside its try/catch and silently skip every list channel.
    expect(channels).toContain("list:list-1:delete");
  });

  it("does not send private deletions to public or list channels", async () => {
    const stream = fakeStream();
    const db = fakeDb({
      followers: ["https://local.example/users/follower"],
      lists: ["list-1"],
    });

    await broadcastObjectDelete(stream.ns, db as never, {
      id: "https://local.example/objects/private",
      local: true,
      visibility: "private",
      actorId: "https://local.example/users/author",
      raw: null,
    });

    const channels = stream.events.map((e) => `${e.channel}:${e.event}`);
    expect(channels.sort()).toEqual(["home:author:delete", "home:follower:delete"]);
  });
});
