// Generates lib/api-docs/openapi.json from the real route handlers in app/**/route.ts.
// Run with: node scripts/generate-openapi.mjs (also runs on predev/prebuild/predeploy).
//
// Self-contained: everything is derived from the source itself —
//   * paths + methods from the filesystem / exported handlers,
//   * tags from the API path segments,
//   * security by detecting the auth guards the handler actually calls,
//   * query parameters from `searchParams.get(...)` calls,
//   * summaries/descriptions from the handler's leading comments,
//   * request bodies when the handler reads a body (json/formData/text).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "app");
const outFile = join(root, "lib", "api-docs", "openapi.json");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = packageJson.version ?? "0.1.0";
const instanceTitle = "CF ActivityPub API";

const METHOD_VERB = {
  GET: "Get",
  POST: "Create",
  PUT: "Update",
  PATCH: "Partial update",
  DELETE: "Delete",
};

/** Acronyms/oddities that a naive title-case would get wrong. */
const TAG_OVERRIDES = {
  e2ee: "E2EE",
  oembed: "oEmbed",
  map: "Maps",
  mls: "MLS",
  oauth: "OAuth",
  api: "API",
  emojis: "Emojis",
  custom_emojis: "Custom Emojis",
  featured_tags: "Featured Tags",
  followed_tags: "Followed Tags",
  follow_requests: "Follow Requests",
  scheduled_statuses: "Scheduled Statuses",
  instance_domains: "Instance Domains",
  canonical_email_blocks: "Canonical Email Blocks",
  media_cache: "Media Cache",
};

/** Query params whose values are numeric (used for the schema types). */
const INTEGER_QUERY = new Set([
  "limit", "offset", "max_id", "since_id", "min_id", "max_bookmarks",
  "expires_in", "four_of_a_kind", "depth", "radius",
]);

function findRouteFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "docs") continue;
      out.push(...findRouteFiles(p));
    } else if (entry.name === "route.ts" && entry.isFile) {
      out.push(p);
    }
  }
  return out;
}

function pathFromFile(file) {
  let rel = relative(appDir, file).split(sep).join("/");
  rel = rel.replace(/\/route\.ts$/, "");
  return ("/" + rel)
    .replace(/\[\.\.\.([^\]]+)\]/g, "{$1}")
    .replace(/\[([^\]]+)\]/g, "{$1}");
}

function methodsIn(src) {
  const methods = [];
  for (const name of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(src)) methods.push(name);
    else if (new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s+from\\s+["']`).test(src)) methods.push(name);
  }
  return methods;
}

/** Handler body (from the exported function to the next top-level export). */
function handlerBody(src, method) {
  const start = src.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`));
  if (start === -1) return src;
  const next = src.slice(start + 10).search(/\nexport\s+/);
  return next === -1 ? src.slice(start) : src.slice(start, start + 10 + next);
}

/**
 * A handler is protected when it explicitly rejects missing auth. Routes that
 * only read the viewer (public timelines, public statuses) call
 * `getAuthenticatedActor` too, so the guard must be an `unauthorized()` (or an
 * admin role check) tied to a missing actor.
 */
function isProtected(src, method) {
  const body = handlerBody(src, method);
  if (/require(?:Full)?Admin\s*\(/.test(body)) return true;
  if (!/unauthorized\s*\(/.test(body) && !/\bstatus:\s*40[13]\b/.test(body)) return false;
  // Only an unconditional `if (!actor) return unauthorized()` protects the
  // whole endpoint; `if (local && !authActor)` (public timeline) stays public.
  return /if\s*\(\s*!\s*(?:authActor|actor|me|user|session)\s*\)\s*(?:\{[^}]*\}\s*)?return\s+unauthorized/.test(body);
}

function queryParams(src) {
  const names = new Set();
  const re = /(?:searchParams|nextUrl\.searchParams)\.get(?:All)?\(['"]([A-Za-z0-9_]+)['"]\)/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  return [...names];
}

function hasBody(src) {
  return /request\.json\(\)|request\.formData\(|await request\.text\(\)/.test(src);
}

function titleCase(segment) {
  return (TAG_OVERRIDES[segment] ?? segment.replace(/[_-]/g, " ")).replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Tag derived from the API path: /api/v1/accounts/{id}/x → "Accounts". */
function tagFor(path) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "api" && /^v\d+$/.test(parts[1] ?? "")) {
    const seg = parts[2] ?? "misc";
    if (seg === "admin") return "Admin";
    if (seg === "users" || seg === "inbox" || seg === "nodeinfo") return "ActivityPub";
    return titleCase(seg);
  }
  if (parts[0] === "api") {
    const seg = parts[1] ?? "misc";
    if (seg === "users" || seg === "inbox" || seg === "nodeinfo") return "ActivityPub";
    if (seg === "admin") return "Admin";
    return titleCase(seg);
  }
  if (path.startsWith("/oauth")) return "OAuth";
  if (path.startsWith("/.well-known") || path.startsWith("/nodeinfo") || path.startsWith("/users") || path.startsWith("/inbox") || path.startsWith("/objects")) {
    return "ActivityPub";
  }
  return "Misc";
}

/** First comment block of the file, minus the "GET /path" route header lines. */
function fileComments(src) {
  const lines = src.split("\n");
  const comments = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) comments.push(trimmed.replace(/^\/\/\s?/, ""));
    else if (trimmed.startsWith("import ") || trimmed.startsWith("import{")) break;
    else if (comments.length > 0) break;
  }
  return comments
    .filter((c) => c.length > 0 && !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+\//.test(c))
    .join(" ")
    .slice(0, 300);
}

// WebSocket endpoints have no route.ts handler (the worker upgrades them).
const MANUAL_PATHS = {
  "/api/v1/streaming": {
    GET: {
      summary: "Streaming WebSocket endpoint",
      description:
        "Real-time WebSocket stream for timelines and notifications. Open a WebSocket to `/api/v1/streaming?stream=...&access_token=...` and listen for `update`, `notification`, `delete`, `status.update` and `conversation` events.",
      operationId: "streamingWs",
      tags: ["Streaming"],
      security: [],
      responses: { 101: { description: "WebSocket upgrade" } },
    },
  },
};

const ERROR_SCHEMA = {
  type: "object",
  properties: { error: { type: "string" }, error_code: { type: "string" } },
};

const files = findRouteFiles(appDir);
const paths = {};
const usedOperationIds = new Set();
const usedTags = new Map();

for (const [manualPath, ops] of Object.entries(MANUAL_PATHS)) {
  paths[manualPath] = {};
  for (const [method, op] of Object.entries(ops)) {
    paths[manualPath][method.toLowerCase()] = op;
    if (!usedTags.has(op.tags[0])) usedTags.set(op.tags[0], "WebSocket streaming.");
  }
}

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const path = pathFromFile(file);
  const methods = methodsIn(src);
  if (methods.length === 0) continue;

  const tag = tagFor(path);
  if (!usedTags.has(tag)) usedTags.set(tag, `${tag} endpoints.`);
  const description = fileComments(src);
  const autoQuery = queryParams(src);
  const readsBody = hasBody(src);

  for (const method of methods) {
    const security = isProtected(src, method) ? [{ bearerAuth: [] }] : [];
    const summary = `${METHOD_VERB[method] ?? method} ${path}`;

    let operationId = (method.toLowerCase() + path.replace(/\//g, "_").replace(/\{([^}]+)\}/g, "By$1").replace(/[^a-z0-9_]/gi, "")).replace(/_+/g, "_");
    let suffix = 2;
    while (usedOperationIds.has(operationId)) operationId = `${operationId}_${suffix++}`;
    usedOperationIds.add(operationId);

    const parameters = [];
    for (const param of path.matchAll(/\{([^}]+)\}/g)) {
      parameters.push({ name: param[1], in: "path", required: true, schema: { type: "string" } });
    }
    for (const q of autoQuery) {
      parameters.push({
        name: q,
        in: "query",
        schema: { type: INTEGER_QUERY.has(q) ? "integer" : "string" },
      });
    }

    const op = {
      summary,
      ...(description ? { description } : {}),
      operationId,
      tags: [tag],
      ...(parameters.length ? { parameters } : {}),
      security,
    };

    if (["POST", "PUT", "PATCH"].includes(method) && readsBody) {
      op.requestBody = {
        required: false,
        content: {
          "application/json": { schema: { type: "object", additionalProperties: true } },
          "multipart/form-data": { schema: { type: "object", additionalProperties: true } },
        },
      };
    }

    const okStatus = method === "DELETE" ? "204" : "200";
    op.responses = {
      [okStatus]: { description: method === "DELETE" ? "Successfully deleted." : "Successful response." },
      ...(security.length
        ? { 401: { description: "Unauthorized. Missing or invalid access token.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } }
        : {}),
      ...(op.requestBody
        ? { 422: { description: "Validation error.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } }
        : {}),
    };

    paths[path] = paths[path] ?? {};
    paths[path][method.toLowerCase()] = op;
  }
}

const doc = {
  openapi: "3.0.3",
  info: {
    title: instanceTitle,
    version,
    description:
      "Mastodon-compatible ActivityPub API for this instance.\n\nAuthentication uses OAuth 2.0 bearer tokens obtained from `POST /oauth/token` (password grant). Public endpoints (instance metadata, public timelines, WebFinger, ActivityPub federation, oEmbed) do not require a token. Click **Authorize** and paste your access token to try authenticated endpoints.\n\nThis document is generated from the actual route handlers in `app/**/route.ts`; tags, auth requirements and parameters are read from the source.",
  },
  servers: [{ url: "/" }],
  tags: [...usedTags].map(([name, description]) => ({ name, description })),
  paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "OAuth access token. Obtain it from `POST /oauth/token` and pass as `Authorization: Bearer <token>`.",
      },
      oauth2: {
        type: "oauth2",
        flows: {
          password: {
            tokenUrl: "/oauth/token",
            scopes: {
              read: "Read access",
              write: "Write access",
              follow: "Follow accounts and manage relationships",
              push: "Manage push subscriptions",
            },
          },
        },
      },
    },
    schemas: { Error: ERROR_SCHEMA },
  },
};

writeFileSync(outFile, JSON.stringify(doc, null, 2) + "\n");

let total = 0;
for (const p of Object.keys(paths)) total += Object.keys(paths[p]).length;
console.log(`OpenAPI generated: ${Object.keys(paths).length} paths, ${total} operations → ${relative(root, outFile)}`);
