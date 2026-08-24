import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/Sidebar";

type MockLinkProps = { children?: ReactNode; href?: string; [key: string]: unknown };
type MockImageProps = { alt?: string; src?: string; width?: number; height?: number; [key: string]: unknown };

// Mock next/link and next/image
vi.mock("next/link", () => ({
  default: (props: MockLinkProps) => (
    <a href={props.href} {...props}>{props.children}</a>
  ),
}));

vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element -- test stub for next/image
  default: (props: MockImageProps) => <img alt={props.alt} {...props} />,
}));

// Mock i18n
const mockT = {
  nav_home: "Home",
  nav_explore: "Explore",
  nav_timelines: "Timelines",
  nav_notifications: "Notifications",
  nav_messages: "Messages",
  nav_bookmarks: "Bookmarks",
  nav_favourites: "Favourites",
  nav_lists: "Lists",
  nav_followed_tags: "Hashtags",
  nav_mutes: "Mutes",
  nav_scheduled: "Scheduled",
  nav_profile: "Profile",
  nav_settings: "Settings",
  nav_logout: "Log out",
  nav_blocks: "Blocks",
  nav_emojis: "Emojis",
  theme_light: "Light",
  theme_dark: "Dark",
};

vi.mock("@/lib/i18n", () => ({
  useLocale: () => ({
    t: mockT,
    locale: "en" as const,
    setLocale: vi.fn(),
  }),
  LOCALES: [
    { code: "en", name: "English" },
    { code: "es", name: "Español" },
  ],
}));

// Mock getToken
vi.mock("@/lib/client-api", () => ({
  getToken: vi.fn(() => null),
}));

// Mock useTimelineStream
vi.mock("@/lib/streaming/use-timeline-stream", () => ({
  useTimelineStream: vi.fn(),
}));

// Mock global fetch to prevent network requests in tests
const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.clearAllMocks();
});

describe("Sidebar", () => {
  it("renders the logo and app name", () => {
    render(<Sidebar me={null} currentPath="/home" />);
    // The logo appears in both the desktop sidebar and the mobile top bar.
    expect(screen.getAllByText("CF ActivityPub").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByAltText("CF ActivityPub").length).toBeGreaterThanOrEqual(1);
  });

  it("renders all navigation items", () => {
    render(<Sidebar me={null} currentPath="/home" />);
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Explore")).toBeInTheDocument();
    expect(screen.getByText("Notifications")).toBeInTheDocument();
    expect(screen.getByText("Messages")).toBeInTheDocument();
  });

  it("highlights the current path nav item", () => {
    render(<Sidebar me={null} currentPath="/home" />);
    const homeLink = screen.getByText("Home").closest("a");
    expect(homeLink?.getAttribute("style")).toContain("var(--accent-bg)");
  });

  it("shows theme toggle button", () => {
    render(<Sidebar me={null} currentPath="/home" />);
    const buttons = screen.getAllByTitle("Light");
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    const sunIcons = document.querySelectorAll(".fa-sun");
    expect(sunIcons.length).toBeGreaterThanOrEqual(1);
  });

  it("renders logout button when not authenticated", () => {
    render(<Sidebar me={null} currentPath="/home" />);
    expect(screen.getByText((content) => content.includes("Log out"))).toBeInTheDocument();
  });

  it("renders user info when me prop is provided", () => {
    const me = { username: "alice", display_name: "Alice", acct: "alice@example.com" };
    render(<Sidebar me={me} currentPath="/home" />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("@alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("renders a language selector with the supported locales", () => {
    render(<Sidebar me={null} currentPath="/home" />);
    expect(screen.getAllByText("English").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Español")).toBeInTheDocument();
  });

  it("renders mobile top bar with theme toggle", () => {
    render(<Sidebar me={null} currentPath="/home" />);
    const mobileThemeBtn = screen.getAllByTitle("Light");
    expect(mobileThemeBtn.length).toBeGreaterThanOrEqual(2);
  });
});
