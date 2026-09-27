import { describe, it, expect, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import LocationPreview from "@/components/LocationPreview";

const SOL = { name: "Puerta del Sol", latitude: 40.4168, longitude: -3.7038 };

describe("location preview link", () => {
  beforeAll(() => {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  });

  it("opens the origin's location page when the status federated one", () => {
    const url = "https://cf-ap.com/locations?lat=40.416800&lng=-3.703800&name=Puerta+del+Sol";
    const { container } = render(<LocationPreview location={{ ...SOL, url }} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(url);
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("falls back to the viewer's own location page", () => {
    const { container } = render(<LocationPreview location={SOL} />);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/locations?lat=40.416800&lng=-3.703800&name=Puerta+del+Sol"
    );
  });
});
