/**
 * Test Worker entry.
 *
 * The Workers Vitest integration bundles a Worker to provide `SELF`/`exports`
 * and the Durable Object classes declared in wrangler.toml. Production's
 * `src/worker.ts` imports the vinext app handler, which only exists after a
 * Vite build, so tests point the plugin here and re-export the DO classes
 * straight from `lib/streaming`.
 */
export { TimelineStreamDO } from "../lib/streaming/timeline-do";
export { CallSignalingDO } from "../lib/streaming/call-signaling-do";

const worker = {
  fetch(): Response {
    return new Response("cf-ap test worker");
  },
};

export default worker;
