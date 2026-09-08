import { describe, it, expect, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import { ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

// Smoke test: React Flow mounts with the /graph page's node/edge shape and
// renders one node per entry. (Edge <path>s depend on real layout measurement,
// which jsdom cannot provide, so edge existence is not asserted here.)
describe("React Flow graph mounting", () => {
  beforeAll(() => {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
    const proto = (globalThis as unknown as { SVGElement?: { prototype: unknown } }).SVGElement?.prototype as { getBBox?: () => unknown } | undefined;
    if (proto) {
      Object.defineProperty(proto, "getBBox", { configurable: true, value: () => ({ x: 0, y: 0, width: 100, height: 40 }) });
    }
  });

  it("renders one node per entry and an edges layer", () => {
    const { container } = render(
      <div style={{ width: 600, height: 400 }}>
        <ReactFlow
          nodes={[
            { id: "a", position: { x: 0, y: 0 }, data: {} },
            { id: "b", position: { x: 300, y: 200 }, data: {} },
            { id: "c", position: { x: 500, y: 0 }, data: {} },
          ]}
          edges={[
            { id: "e0", source: "a", target: "b", animated: true, style: { stroke: "#6366f1", strokeWidth: 2.5 } },
            { id: "e1", source: "b", target: "c", style: { stroke: "#8a8ab8", strokeWidth: 2 } },
          ]}
        />
      </div>
    );
    expect(container.querySelector(".react-flow")).toBeTruthy();
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(3);
    expect(container.querySelector(".react-flow__edges")).toBeTruthy();
  });
});