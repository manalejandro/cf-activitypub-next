import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Pagination } from "@/components/Pagination";

vi.mock("@/lib/i18n", () => ({
  useLocale: () => ({
    t: {
      pagination_prev: "Previous",
      pagination_next: "Next",
      pagination_page: "Page {page} of {pages}",
    },
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

describe("Pagination", () => {
  it("renders nothing with a single page", () => {
    const { container } = render(<Pagination page={1} pages={1} onPageChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("navigates between pages and disables the edges", () => {
    const onPageChange = vi.fn();
    render(<Pagination page={1} pages={4} onPageChange={onPageChange} />);

    expect(screen.getByText("Page 1 of 4")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("disables Next on the last page", () => {
    render(<Pagination page={4} pages={4} onPageChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
  });
});
