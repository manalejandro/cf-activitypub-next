import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Account, Status } from "@/components/StatusCard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/lib/custom-emoji-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/custom-emoji-client")>()),
  useAllCustomEmojis: () => [],
}));
vi.mock("@/lib/preferences-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/preferences-client")>()),
  usePreferences: () => ({}),
}));
vi.mock("@/lib/license-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/license-client")>()),
  useLicenseInfo: () => null,
}));

import { StatusCard } from "@/components/StatusCard";

const PARTY = { shortcode: "party", url: "https://cdn.example/party.png", static_url: "https://cdn.example/party.png" };

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "https://local.example/users/booster",
    username: "booster",
    display_name: "Booster :party:",
    avatar: "https://cdn.example/avatar.png",
    acct: "booster@local.example",
    emojis: [PARTY],
    ...overrides,
  };
}

function status(overrides: Partial<Status> = {}): Status {
  return {
    id: "https://local.example/objects/1",
    content: "<p>hello</p>",
    created_at: "2026-01-01T00:00:00Z",
    account: account(),
    favourites_count: 0,
    reblogs_count: 0,
    replies_count: 0,
    favourited: false,
    reblogged: false,
    media_attachments: [],
    sensitive: false,
    spoiler_text: "",
    poll: null,
    ...overrides,
  };
}

describe("boost wrapper header", () => {
  it("renders the booster's custom emojis in the display name", () => {
    const wrapper = status({
      id: "https://local.example/objects/ann-1",
      account: account({ display_name: "ale :party:" }),
      reblog: status({
        id: "https://remote.example/objects/9",
        account: account({
          id: "https://remote.example/users/bob",
          username: "bob",
          display_name: "Bob",
          acct: "bob@remote.example",
          emojis: [],
        }),
      }),
    });

    const { container } = render(
      <StatusCard status={wrapper} onFav={vi.fn()} onReblog={vi.fn()} onReply={vi.fn()} />
    );

    // The shortcode became the emoji image, inside the boost header.
    const header = container.querySelector(".status-card-boost");
    expect(header).not.toBeNull();
    const img = header!.querySelector('img[alt=":party:"]');
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(PARTY.url);
    // …and the plain shortcode is not left behind in the header text.
    expect(header!.textContent).not.toContain(":party:");
  });

  it("keeps the plain display name when the booster has no emojis", () => {
    const wrapper = status({
      account: account({ display_name: "ale", emojis: [] }),
      reblog: status({
        account: account({
          id: "https://remote.example/users/bob",
          username: "bob",
          display_name: "Bob",
          acct: "bob@remote.example",
          emojis: [],
        }),
      }),
    });
    const { container } = render(
      <StatusCard status={wrapper} onFav={vi.fn()} onReblog={vi.fn()} onReply={vi.fn()} />
    );
    const header = container.querySelector(".status-card-boost");
    expect(header!.textContent).toContain("ale");
    expect(screen.queryByAltText(":party:")).toBeNull();
  });
});
