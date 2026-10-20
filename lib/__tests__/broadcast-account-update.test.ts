// @vitest-environment node
import { describe, it, expect } from "vitest";
import { broadcastAccountUpdate, type DONamespace } from "@/lib/streaming/broadcast";

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
        fetch: async (_url: string, init?: RequestInit) => {
          events.push(JSON.parse(String(init?.body)) as Event);
          return new Response("ok");
        },
      }),
    } as unknown as DONamespace,
  };
}

/** D1 stand-in that answers the three audience queries by SQL shape. */
function fakeDb(rows: {
  followers?: { id: string }[];
  lists?: { list_id: string }[];
  recipients?: { id: string }[];
}) {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async all() {
              if (sql.includes("follows")) return { results: rows.followers ?? [] };
              if (sql.includes("list_accounts")) return { results: rows.lists ?? [] };
              if (sql.includes("FROM notifications")) return { results: rows.recipients ?? [] };
              return { results: [] };
            },
          };
        },
      };
    },
  } as never;
}

describe("broadcastAccountUpdate", () => {
  it("reaches the public channels, the followers' homes, the lists and the notification channels", async () => {
    const { ns, events } = fakeStream();

    await broadcastAccountUpdate(
      ns,
      fakeDb({
        followers: [{ id: "https://cf-ap.com/users/fan" }],
        lists: [{ list_id: "list-1" }],
        recipients: [{ id: "https://cf-ap.com/users/mentioned" }],
      }),
      { actorId: "https://remote.example/users/spammer", suspended: true, local: false }
    );

    const channels = events.map((e) => e.channel).sort();
    expect(channels).toEqual([
      "home:fan",
      "list:list-1",
      // The mentioned account does not have to follow the spammer: without its
      // own notification channel the open notifications list would keep showing
      // what the suspension just hid server-side.
      "notification:mentioned",
      "public",
      "public:remote",
    ]);
    for (const event of events) {
      expect(event.event).toBe("account.updated");
      expect(JSON.parse(event.payload)).toEqual({ id: "https://remote.example/users/spammer", suspended: true });
    }
  });

  it("never lets a failing audience query stop the others", async () => {
    const { ns, events } = fakeStream();
    const failingDb = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes("follows")) throw new Error("no such table");
                if (sql.includes("list_accounts")) return { results: [{ list_id: "list-1" }] };
                return { results: [{ id: "https://cf-ap.com/users/mentioned" }] };
              },
            };
          },
        };
      },
    } as never;

    await broadcastAccountUpdate(ns, failingDb, {
      actorId: "https://cf-ap.com/users/spammer",
      suspended: false,
      local: true,
    });

    expect(events.map((e) => e.channel).sort()).toEqual([
      "list:list-1",
      "notification:mentioned",
      "public",
      "public:local",
    ]);
  });
});
