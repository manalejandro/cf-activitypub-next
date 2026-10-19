/**
 * HTTP/WebSocket routing for the Guardian's Cloudflare Agent.
 *
 * The Agents SDK routes `/agents/:agent-name/:instance-name` through
 * `routeAgentRequest`, which talks to the Durable Object directly — so it has
 * to run **before** the app handler in `src/worker.ts`, and it has to be gated
 * here: the agent can read every report and suspend accounts, so only a full
 * administrator may open it (the panel and the WebSocket both authenticate with
 * the session cookie or a Bearer token).
 */

import { routeAgentRequest } from "agents";
import { getAdminRole } from "@/lib/admin-auth";

/** The bindings the routing needs; any env carrying them works — the app's
 *  `Cloudflare.Env`, the worker's local `Env` or the test environment. */
export interface AgentRoutingEnv {
  DB: D1Database;
  ADMIN_TOKEN?: string;
}

/** True when this request targets the agents namespace. */
export function isAgentRequest(request: Request): boolean {
  try {
    return new URL(request.url).pathname.startsWith("/agents/");
  } catch {
    return false;
  }
}

/**
 * Route an `/agents/*` request to the Guardian agent, or return null when the
 * request is not for the agents namespace. Administrators only: a moderator
 * gets a 403, an anonymous caller a 401.
 */
export async function routeGuardianAgent<E extends AgentRoutingEnv>(
  request: Request,
  env: E
): Promise<Response | null> {
  if (!isAgentRequest(request)) return null;

  const role = await getAdminRole(request, { DB: env.DB, ADMIN_TOKEN: env.ADMIN_TOKEN });
  if (role !== "admin") {
    return new Response(role ? "Forbidden" : "Unauthorized", { status: role ? 403 : 401 });
  }

  // `cors: true` mirrors the instance's other public-ish endpoints: the panel
  // runs on the same origin, but a client that reaches the agent over the
  // WebSocket needs the preflight to pass.
  return (await routeAgentRequest(request, env, { cors: true })) ?? new Response("Not found", { status: 404 });
}
