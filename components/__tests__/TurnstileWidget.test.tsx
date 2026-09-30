import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRef } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import TurnstileWidget, { type TurnstileHandle } from "@/components/TurnstileWidget";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

const api = {
  render: vi.fn((_el: HTMLElement, _options: Record<string, unknown>) => "widget-1"),
  remove: vi.fn(),
  reset: vi.fn(),
};

function setApi(value: unknown) {
  (window as unknown as { turnstile?: unknown }).turnstile = value;
}

beforeEach(() => {
  api.render.mockClear();
  api.remove.mockClear();
  api.reset.mockClear();
  api.render.mockReturnValue("widget-1");
  document.querySelectorAll(`script[src="${SCRIPT_SRC}"]`).forEach((el) => el.remove());
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { turnstile?: unknown }).turnstile;
  document.querySelectorAll(`script[src="${SCRIPT_SRC}"]`).forEach((el) => el.remove());
});

describe("TurnstileWidget", () => {
  it("renders on every mount, so navigating between the auth screens keeps the widget", async () => {
    setApi(api);
    const first = render(<TurnstileWidget siteKey="site-key" action="login" onToken={() => {}} />);
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));

    first.unmount();
    expect(api.remove).toHaveBeenCalledWith("widget-1");

    // Client-side navigation to another auth screen: the script is already in
    // the document and `window.turnstile` is defined, so the widget must render
    // again instead of waiting for an onLoad that never fires a second time.
    render(<TurnstileWidget siteKey="site-key" action="register" onToken={() => {}} />);
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(2));
  });

  it("waits for a script already injected by a previous screen", async () => {
    vi.resetModules();
    setApi(undefined);
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    document.head.appendChild(script);

    const { default: Widget } = await import("@/components/TurnstileWidget");
    render(<Widget siteKey="site-key" action="login" onToken={() => {}} />);
    expect(api.render).not.toHaveBeenCalled();

    // The API appears once that script finishes: the loader must notice it.
    setApi(api);
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it("delivers tokens and resets the widget through the ref", async () => {
    setApi(api);
    const tokens: string[] = [];
    const handle = createRef<TurnstileHandle>();
    render(
      <TurnstileWidget siteKey="site-key" action="login" onToken={(token) => tokens.push(token)} ref={handle} />
    );
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));

    const options = api.render.mock.calls[0][1] as { callback: (token: string) => void };
    act(() => options.callback("solved-token"));
    expect(tokens).toContain("solved-token");

    // Retries need a fresh challenge: reset clears the used token too.
    act(() => handle.current?.reset());
    expect(api.reset).toHaveBeenCalledWith("widget-1");
    expect(tokens[tokens.length - 1]).toBe("");
  });

  it("renders nothing (and never loads the script) without a site key", () => {
    setApi(api);
    const { container } = render(<TurnstileWidget siteKey="" action="login" onToken={() => {}} />);
    expect(container.querySelector("div")).toBeNull();
    expect(api.render).not.toHaveBeenCalled();
  });
});
