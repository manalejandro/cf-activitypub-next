import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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

import { MediaGrid, type MediaAttachment } from "@/components/StatusCard";
import { LocaleProvider } from "@/lib/i18n";

const ATTACHMENT: MediaAttachment = {
  id: "att-1",
  type: "image",
  url: "https://origin.example/media/photo.jpg",
  preview_url: "https://origin.example/media/photo.jpg",
  description: "una foto",
};

function renderGrid(attachments: MediaAttachment[]) {
  return render(
    <LocaleProvider>
      <MediaGrid attachments={attachments} />
    </LocaleProvider>
  );
}

describe("MediaGrid broken media", () => {
  it("replaces a failed attachment image with a labelled placeholder", () => {
    renderGrid([ATTACHMENT]);
    const img = screen.getByAltText("una foto");
    expect(img).toBeTruthy();

    fireEvent.error(img);

    // The broken image is gone; the description (or the generic "media
    // unavailable" label) keeps the status readable.
    expect(screen.queryByAltText("una foto")).toBeNull();
    expect(screen.getByText("una foto")).toBeTruthy();
  });

  it("falls back to the generic label when the attachment has no description", () => {
    const { container } = renderGrid([{ ...ATTACHMENT, id: "att-2", description: null }]);
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    fireEvent.error(img!);
    expect(screen.getByText(/media unavailable|multimedia no disponible|contenido multimedia/i)).toBeTruthy();
  });
});
