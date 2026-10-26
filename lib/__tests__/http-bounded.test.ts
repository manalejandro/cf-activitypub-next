// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readBoundedBytes, readBoundedJson, readBoundedText } from "@/lib/http";

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body);
}

describe("readBoundedBytes / Text / Json", () => {
  it("returns the whole body when it fits under the cap", async () => {
    const res = streamResponse(["abc", "def"]);
    const bytes = await readBoundedBytes(res, 100);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe("abcdef");
  });

  it("returns null when the stream exceeds the cap mid-flight", async () => {
    const res = streamResponse(["a".repeat(50), "b".repeat(50), "c".repeat(50)]);
    expect(await readBoundedBytes(res, 120)).toBeNull();
  });

  it("bounds text reads the same way", async () => {
    expect(await readBoundedText(streamResponse(["hello"]), 10)).toBe("hello");
    expect(await readBoundedText(streamResponse(["x".repeat(30)]), 10)).toBeNull();
  });

  it("parses JSON within the cap and rejects oversize or invalid bodies", async () => {
    expect(await readBoundedJson<{ a: number }>(streamResponse(['{"a":1}']), 100)).toEqual({ a: 1 });
    expect(await readBoundedJson(streamResponse(["{".padEnd(200, " ")]) , 100)).toBeNull();
    expect(await readBoundedJson(streamResponse(["not json"]), 100)).toBeNull();
  });

  it("handles a body-less response through the arrayBuffer path", async () => {
    const res = new Response(null);
    const bytes = await readBoundedBytes(res, 10);
    expect(bytes).toHaveLength(0);
  });
});
