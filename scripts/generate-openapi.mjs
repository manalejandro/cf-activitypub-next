// Generates lib/api-docs/openapi.json from the real route handlers in app/**/route.ts.
// Run with: node scripts/generate-openapi.mjs (also runs on predev/prebuild/prepredeploy).
// Add --check to fail when the committed spec is out of date.
//
// Self-contained: everything is derived from the source itself —
//   * paths + methods from the filesystem / exported handlers (re-exports followed),
//   * tags from the API path segments,
//   * security by detecting the auth guards the handler actually calls,
//   * query parameters from `searchParams.get(...)` calls,
//   * summaries/descriptions from the handler's leading comments,
//   * request bodies when the handler reads a body (json/formData/text).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "app");
const outFile = join(root, "lib", "api-docs", "openapi.json");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = packageJson.version ?? "0.1.0";
const instanceTitle = "CF ActivityPub API";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

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

/** Curated tag blurbs (the tag set itself is derived from the paths). */
const TAG_DESCRIPTIONS = {
  Admin:
    "Instance administration. Requires an access token held by an administrator or moderator; privileged operations (roles, instance settings, federation rules, audit log, media cache) require a full administrator.",
  ActivityPub:
    "Federation surface (actors, inbox/outbox, objects, nodeinfo, WebFinger). Served to remote servers without a token — requests are authenticated with HTTP signatures.",
  OAuth: "OAuth 2.0 token issuance and revocation.",
  Streaming: "Real-time WebSocket streaming of timeline updates and notifications.",
  Instance: "Public instance metadata (name, description, limits, rules, peers).",
  Calls: "WebRTC audio/video calls between accounts.",
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
  return out.sort();
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
  for (const name of HTTP_METHODS) {
    if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(src)) methods.push(name);
    else if (new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s+from\\s+["']`).test(src)) methods.push(name);
  }
  return methods;
}

/**
 * Source that actually defines an exported method. Thin route files re-export
 * the real handler (`export { PATCH } from "../verify_credentials/route"`), so
 * guards, params and comments must be read from the target file.
 */
function definingSource(file, src, method) {
  const match = src.match(new RegExp(`export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`));
  if (!match) return src;
  const spec = match[1];
  const base = spec.startsWith("@/") ? join(root, spec.slice(2)) : resolve(dirname(file), spec);
  for (const candidate of [base, `${base}.ts`]) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      /* try the next candidate */
    }
  }
  return src;
}

/**
 * Handler body (from the exported function to the next top-level export).
 * Follows delegation aliases (`export async function PATCH(r) { return PUT(r); }`)
 * so they inherit the guard of the method they call.
 */
function handlerBody(src, method, seen = new Set()) {
  const start = src.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`));
  if (start === -1) return src;
  const next = src.slice(start + 10).search(/\nexport\s+/);
  const body = next === -1 ? src.slice(start) : src.slice(start, start + 10 + next);

  const alias = body.match(/\breturn\s+([A-Z][A-Z_]*)\s*\(/)?.[1];
  if (alias && HTTP_METHODS.includes(alias) && !seen.has(alias)) {
    seen.add(method);
    return handlerBody(src, alias, seen);
  }
  return body;
}

/** Admin routes: /api/v1/admin/*, /api/v2/admin/* and /api/admin/*. */
const ADMIN_PATH_RE = /^\/api\/(?:v\d+\/)?admin(?:\/|$)/;
/** Helpers that exist only to resolve/gate the admin (or moderator) role. */
const ADMIN_HELPER_RE = /\b(?:require(?:Full)?Admin|getAdminRole|adminActionGuard)\s*\(/;
/**
 * Helpers (or the manual bearer parsing in /api/v1/apps/verify_credentials)
 * that establish *who* the caller is. A rejection only counts as an auth guard
 * when the handler actually resolves the caller this way; otherwise
 * `if (!user) return 401` inside a login endpoint (invalid credentials) would
 * be mistaken for a missing token.
 */
const IDENTITY_HELPER_RE =
  /\b(?:getAuthenticatedActor|getAuthenticatedUser|getBearerToken|getAccessToken|getTokenFromRequest|requireAuth|requireScope|getSession)\s*\(|replace\(\s*["']Bearer\s+["']/;
/** ActivityPub inboxes authenticate with HTTP signatures, not bearer tokens. */
const SIGNATURE_AUTH_RE = /\bverifySignature\s*\(/;
/** Rejection text that rejects the caller for missing/invalid auth. */
const AUTH_REJECT_RE = /unauthorized\s*\(|\b40[13]\b/;
/** Identifiers that mean "the caller" (a 403 tied to them is an auth error). */
const CALLER_IDENT_RE = /^(?:actor|me|user|authed|caller|token|session|viewer|auth|admin|role|scope)/i;

/**
 * True when the body rejects a missing viewer: the `if` condition must *start*
 * with a negation (`!actor`, `!me`, `!token`, `!actor.isLocal && !me`) and the
 * consequent return must be an auth rejection. A guard such as
 * `if (local && !authActor)` belongs to an optional-auth endpoint (public
 * timeline) and does not mark the whole operation as protected.
 */
function hasAuthGuard(body) {
  // One level of nested parentheses covers `if (!(await check(...)))`.
  const re = /if\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  let match;
  while ((match = re.exec(body))) {
    const condition = match[1];
    if (!/^\s*!\s*[A-Za-z_$][\w$]*/.test(condition)) continue;
    const ident = condition.replace(/^\s*!\s*/, "").match(/^[A-Za-z_$][\w$]*/)[0];
    const tail = body.slice(match.index + match[0].length, match.index + match[0].length + 400);
    const firstReturn = /\breturn\b[^;]{0,220}/.exec(tail)?.[0] ?? "";
    if (!firstReturn) continue;
    if (/unauthorized\s*\(|\b401\b/.test(firstReturn)) return true;
    if (/\b403\b/.test(firstReturn) && CALLER_IDENT_RE.test(ident)) return true;
  }
  return false;
}

function isProtected(src, method, path) {
  // Everything under /admin is role-gated by definition (including route files
  // that delegate the check to shared helpers).
  if (ADMIN_PATH_RE.test(path)) return true;
  const body = handlerBody(src, method);
  // getAdminRole/requireAdmin also accept the ADMIN_TOKEN operator secret.
  if (ADMIN_HELPER_RE.test(body) && AUTH_REJECT_RE.test(body)) return true;
  // Federated inboxes are documented as public (HTTP signature auth).
  if (SIGNATURE_AUTH_RE.test(body)) return false;
  // A rejection counts only when the handler resolves the caller first.
  if (!IDENTITY_HELPER_RE.test(body)) return false;
  return hasAuthGuard(body);
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

function buildDoc() {
  const files = findRouteFiles(appDir);
  const paths = {};
  const usedOperationIds = new Set();
  const usedTags = new Map();

  for (const [manualPath, ops] of Object.entries(MANUAL_PATHS)) {
    paths[manualPath] = {};
    for (const [method, op] of Object.entries(ops)) {
      paths[manualPath][method.toLowerCase()] = op;
      if (!usedTags.has(op.tags[0])) usedTags.set(op.tags[0], TAG_DESCRIPTIONS[op.tags[0]] ?? `${op.tags[0]} endpoints.`);
    }
  }

  for (const file of files) {
    const stub = readFileSync(file, "utf8");
    const path = pathFromFile(file);
    const methods = methodsIn(stub);
    if (methods.length === 0) continue;

    const tag = tagFor(path);
    if (!usedTags.has(tag)) usedTags.set(tag, TAG_DESCRIPTIONS[tag] ?? `${tag} endpoints.`);

    for (const method of methods) {
      const src = definingSource(file, stub, method);
      const description = fileComments(src) || (src === stub ? "" : fileComments(stub));
      const autoQuery = queryParams(src);
      const readsBody = hasBody(src);
      const security = isProtected(src, method, path) ? [{ bearerAuth: [] }] : [];
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
        "Mastodon-compatible ActivityPub API for this instance.\n\nAuthentication uses OAuth 2.0 bearer tokens obtained from `POST /oauth/token` (password grant). Public endpoints (instance metadata, public timelines, WebFinger, ActivityPub federation, oEmbed) do not require a token. Operations marked with a padlock need `Authorization: Bearer <token>`; everything under **Admin** additionally requires the administrator or moderator role (full administrator for privileged mutations). Click **Authorize** and paste your access token to try authenticated endpoints.\n\nThis document is generated from the actual route handlers in `app/**/route.ts`; tags, auth requirements and parameters are read from the source.",
    },
    servers: [{ url: "/" }],
    tags: [...usedTags].map(([name, description]) => ({ name, description })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "OAuth access token (or the operator ADMIN_TOKEN). Obtain it from `POST /oauth/token` and pass as `Authorization: Bearer <token>`.",
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

  let operationCount = 0;
  for (const p of Object.keys(paths)) operationCount += Object.keys(paths[p]).length;
  return { doc, pathCount: Object.keys(paths).length, operationCount };
}

function main() {
  const check = process.argv.includes("--check");
  const { doc, pathCount, operationCount } = buildDoc();
  const serialized = JSON.stringify(doc, null, 2) + "\n";

  if (check) {
    let existing = "";
    try {
      existing = readFileSync(outFile, "utf8");
    } catch {
      /* missing file — reported as out of date below */
    }
    if (existing !== serialized) {
      console.error(`OpenAPI spec is out of date (${relative(root, outFile)}). Run: npm run generate:openapi`);
      process.exit(1);
    }
    console.log(`OpenAPI spec is up to date: ${pathCount} paths, ${operationCount} operations.`);
    return;
  }

  writeFileSync(outFile, serialized);
  console.log(`OpenAPI generated: ${pathCount} paths, ${operationCount} operations → ${relative(root, outFile)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { buildDoc, isProtected, hasAuthGuard };
