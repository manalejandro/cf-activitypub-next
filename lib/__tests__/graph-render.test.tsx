import { describe, it, expect, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import { ReactFlow, type Node, type NodeProps, type NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

// Smoke test: React Flow mounts with the /graph page's shape (custom node type
// + explicit node dimensions). Edge <path> rendering depends on real layout
// (getBoundingClientRect/handle bounds) which jsdom cannot provide, so edges
// are validated in the real-browser headless check instead; here we only
// assert mount + node rendering + that the edges layer exists.
function InstanceNode({ data }: NodeProps<Node<{ id: string }>>) {
  return <div>{data.id}</div>;
}

const nodeTypes: NodeTypes = { instance: InstanceNode };

describe("React Flow graph mounting", () => {
  beforeAll(() => {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  });

  it("mounts with custom-typed nodes and an edges layer", () => {
    const { container } = render(
      <div style={{ width: 600, height: 400 }}>
        <ReactFlow
          nodeTypes={nodeTypes}
          nodes={[
            { id: "a.example", type: "instance", position: { x: 0, y: 0 }, width: 150, height: 50, data: { id: "a.example" } },
            { id: "b.example", type: "instance", position: { x: 300, y: 200 }, width: 150, height: 50, data: { id: "b.example" } },
          ]}
          edges={[{ id: "e0", source: "a.example", target: "b.example", style: { stroke: "#7a7aaa", strokeWidth: 2 } }]}
        />
      </div>
    );
    expect(container.querySelector(".react-flow")).toBeTruthy();
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(2);
    expect(container.querySelector(".react-flow__edges")).toBeTruthy();
  });
});