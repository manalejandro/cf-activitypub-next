import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import NewStatusesPill from "@/components/NewStatusesPill";

vi.mock("@/lib/i18n", () => ({
  useLocale: () => ({
    t: {
      timeline_new_statuses: "{count} estados nuevos",
      timeline_new_statuses_one: "1 estado nuevo",
    },
    locale: "es",
  }),
}));

describe("NewStatusesPill", () => {
  it("renders nothing without pending statuses", () => {
    const { container } = render(<NewStatusesPill count={0} onClick={() => {}} />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("uses the singular label for one pending status", () => {
    render(<NewStatusesPill count={1} onClick={() => {}} />);
    expect(screen.getByRole("button").textContent).toContain("1 estado nuevo");
  });

  it("interpolates the count for several pending statuses", () => {
    render(<NewStatusesPill count={7} onClick={() => {}} />);
    expect(screen.getByRole("button").textContent).toContain("7 estados nuevos");
  });

  it("separates the pill from a sticky header (anchor=header)", () => {
    const { container } = render(<NewStatusesPill count={2} onClick={() => {}} anchor="header" />);
    const button = screen.getByRole("button");
    expect(button.style.marginTop).toBe("0.6rem");
    // The wrapper takes no layout space: the feed never shifts when it appears.
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.height).toBe("0px");
    expect(wrapper.style.position).toBe("absolute");
    expect(wrapper.style.top).toBe("100%");
  });

  it("keeps the in-flow variant flush to the viewport (no extra margin)", () => {
    render(<NewStatusesPill count={2} onClick={() => {}} />);
    expect(screen.getByRole("button").style.marginTop).toBe("");
  });
});
