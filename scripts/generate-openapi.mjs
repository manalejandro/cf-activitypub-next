// Generates lib/api-docs/openapi.json from the real route handlers in app/**/route.ts.
// Run with: node scripts/generate-openapi.mjs (also runs on predev/prebuild/prepredeploy).
// Add --check to fail when the committed spec is out of date.
//
// Self-contained: everything is derived from the source itself —
//   * paths + methods from the filesystem / exported handlers (re-exports followed),
//   * tags from the API path segments,
//   * security by detecting the auth guards the handler actually calls,
//   * query parameters from `searchParams.get(...)` calls,
//   * request bodies when the handler reads a body (json/formData/text),
//   * response schemas from the serializers the handler calls and the
//     TypeScript types those serializers declare (`lib/types/index.ts`,
//     `lib/mastodon/*`), converted to OpenAPI with the TypeScript compiler.
//
// There is no hand-written metadata file to keep in sync.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "app");
const outFile = join(root, "lib", "api-docs", "openapi.json");
const typesEntry = join(root, "lib", "types", "index.ts");
const workerTypes = join(root, "worker-configuration.d.ts");
const mastodonDir = join(root, "lib", "mastodon");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = packageJson.version ?? "0.1.0";
const instanceTitle = "CF ActivityPub API";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const JSON_CALLEES = ["json(", "activityJson("];

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

// ─────────────────────────────────────────────────────────────────────────────
// Response schemas
//
// The schema catalog comes from the types the API actually returns: every
// `Mastodon*` interface in the project plus the declared return types of the
// serializer functions in `lib/mastodon/`. A handler is wired to a schema by
// looking at the serializer it calls and at the shape of the response argument.
// ─────────────────────────────────────────────────────────────────────────────

function sourceFilesIn(dir) {
  return readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f));
}

function buildTypeCatalog() {
  const program = ts.createProgram([typesEntry, workerTypes, ...sourceFilesIn(mastodonDir)], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    baseUrl: root,
    paths: { "@/*": ["./*"] },
  });
  const checker = program.getTypeChecker();

  const declarations = new Map();
  for (const sf of program.getSourceFiles()) {
    if (sf.fileName.includes("node_modules") || sf.fileName.endsWith("worker-configuration.d.ts")) continue;
    for (const stmt of sf.statements) {
      if ((ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) && stmt.name && !declarations.has(stmt.name.text)) {
        declarations.set(stmt.name.text, stmt);
      }
    }
  }

  const schemas = {};
  const queued = new Set();
  const enqueue = (name) => {
    if (name && declarations.has(name)) queued.add(name);
  };
  for (const name of declarations.keys()) if (name.startsWith("Mastodon")) enqueue(name);

  /** Split nullable/enum/boolean unions before converting the real type. */
  function unwrapUnion(type) {
    if (!type.isUnion()) return { inner: type };
    const rest = type.types.filter((m) => !(m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
    const nullable = rest.length !== type.types.length;
    if (rest.length === 0) return { inner: null, nullable };
    if (rest.every((m) => m.flags & ts.TypeFlags.BooleanLiteral)) return { inner: null, nullable, boolean: true };
    if (rest.every((m) => m.isStringLiteral() || m.isNumberLiteral())) return { inner: null, nullable, literals: rest };
    if (rest.length === 1) return { inner: rest[0], nullable };
    return { inner: null, nullable, mixed: true };
  }

  function withNullable(schema, nullable) {
    return nullable ? { ...schema, nullable: true } : schema;
  }

  function toSchema(type, selfName) {
    const u = unwrapUnion(type);
    if (u.boolean) return withNullable({ type: "boolean" }, u.nullable);
    if (u.literals) {
      const isNumber = u.literals.every((m) => m.isNumberLiteral());
      return withNullable({ type: isNumber ? "number" : "string", enum: u.literals.map((m) => m.value) }, u.nullable);
    }
    if (!u.inner) return u.mixed ? withNullable({}, u.nullable) : u.nullable ? { nullable: true } : {};
    const t = u.inner;

    // Named reference to another catalog type (skipped when expanding its root).
    const named = t.aliasSymbol?.name ?? t.getSymbol()?.getName();
    if (named && named !== selfName && declarations.has(named)) {
      enqueue(named);
      const ref = { $ref: `#/components/schemas/${named}` };
      return u.nullable ? { allOf: [ref], nullable: true } : ref;
    }

    if (t.flags & ts.TypeFlags.StringLike) return withNullable({ type: "string" }, u.nullable);
    if (t.flags & ts.TypeFlags.NumberLike) return withNullable({ type: "number" }, u.nullable);
    if (t.flags & ts.TypeFlags.BooleanLike) return withNullable({ type: "boolean" }, u.nullable);

    if (checker.isArrayType(t) || t.getSymbol()?.getName() === "Array") {
      const [elem] = checker.getTypeArguments(t);
      return withNullable({ type: "array", items: elem ? toSchema(elem) : {} }, u.nullable);
    }

    const indexType = checker.getIndexTypeOfType(t, ts.IndexKind.String);
    if (indexType && t.getProperties().length === 0) {
      return withNullable({ type: "object", additionalProperties: toSchema(indexType) }, u.nullable);
    }

    // Named type we do not model (internal Local*/AP* shapes): keep it free-form
    // instead of inflating the catalog with implementation details. The root
    // type being expanded (selfName) still expands into its properties.
    if (named && named !== selfName && !named.startsWith("__")) return withNullable({ type: "object" }, u.nullable);

    const props = t.getProperties();
    if (props.length === 0) return withNullable({ type: "object" }, u.nullable);

    const properties = {};
    for (const prop of props) {
      const propType = checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration ?? prop.declarations?.[0] ?? null);
      const propSchema = toSchema(propType);
      const doc = ts.displayPartsToString(prop.getDocumentationComment(checker));
      if (doc) propSchema.description = doc;
      properties[prop.name] = propSchema;
    }
    return withNullable({ type: "object", properties }, u.nullable);
  }

  // Serializer function -> schema name (declared return type of lib/mastodon/*).
  const serializerMap = new Map();
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.includes(`${sep}lib${sep}mastodon${sep}`)) continue;
    for (const stmt of sf.statements) {
      if (!ts.isFunctionDeclaration(stmt) || !stmt.name) continue;
      if (!stmt.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword)) continue;
      const signature = checker.getSignatureFromDeclaration(stmt);
      if (!signature) continue;
      let ret = checker.getReturnTypeOfSignature(signature);
      ret = checker.getAwaitedType(ret) ?? ret;
      if (ret.isUnion()) ret = ret.types.find((m) => !(m.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null))) ?? ret;
      const name = ret.aliasSymbol?.name ?? ret.getSymbol()?.getName();
      if (name && declarations.has(name)) {
        enqueue(name);
        serializerMap.set(stmt.name.text, name);
      }
    }
  }
  // serializeTag declares its return type inline; it is structurally MastodonTag.
  if (declarations.has("MastodonTag")) serializerMap.set("serializeTag", "MastodonTag");

  while (true) {
    const next = [...queued].find((name) => !(name in schemas));
    if (!next) break;
    const stmt = declarations.get(next);
    const symbol = checker.getSymbolAtLocation(stmt.name);
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    const doc = ts.displayPartsToString(symbol.getDocumentationComment(checker));
    const schema = toSchema(type, next);
    if (doc) schema.description = doc;
    schemas[next] = schema;
  }

  for (const [fn, name] of serializerMap) if (!(name in schemas)) serializerMap.delete(fn);
  return { schemas, serializerMap };
}

/** All call arguments of the given callees, in source order. */
function callArgs(src, callees) {
  const out = [];
  for (const callee of callees) {
    let from = 0;
    while (true) {
      const at = src.indexOf(callee, from);
      if (at === -1) break;
      const open = at + callee.length - 1;
      let depth = 0;
      let closed = -1;
      for (let i = open; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") {
          depth--;
          if (depth === 0) {
            closed = i;
            break;
          }
        }
      }
      if (closed !== -1) out.push({ at, arg: src.slice(open + 1, closed).trim() });
      from = at + 1;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Last `json()` (or `activityJson()`) call that is not an error branch. */
function lastSuccessCall(src, callees) {
  const calls = callArgs(src, callees);
  if (calls.length === 0) return null;
  const ok = calls.filter((call) => !/^\{\s*(?:"error"|error)\b/.test(call.arg));
  return ok.length > 0 ? ok[ok.length - 1] : calls[calls.length - 1];
}

function earliestSerializer(src, serializerMap) {
  let best = null;
  for (const [fn, name] of serializerMap) {
    const at = src.search(new RegExp(`\\b${fn}\\s*\\(`));
    if (at === -1) continue;
    if (!best || at < best.at) best = { at, name, fn };
  }
  return best;
}

function lastSerializerBefore(src, idx, serializerMap) {
  let best = null;
  for (const [fn, name] of serializerMap) {
    const at = src.lastIndexOf(`${fn}(`, idx);
    if (at === -1) continue;
    if (!best || at > best.at) best = { at, name };
  }
  return best;
}

function refSchema(name) {
  return { $ref: `#/components/schemas/${name}` };
}

/** Split a call argument list on top-level commas. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function firstArg(text) {
  return splitTopLevel(text)[0] ?? text.trim();
}

/** `json(body, 201)` / `json(body, { status: 201 })` → 201. */
function successStatus(argText) {
  for (const arg of splitTopLevel(argText).slice(1)) {
    const match = arg.match(/^(\d{3})$/) ?? arg.match(/status\s*:\s*(\d{3})/);
    if (match) return Number(match[1]);
  }
  return null;
}

const sourceFileCache = new Map();
function parseSource(src) {
  let sf = sourceFileCache.get(src);
  if (!sf) {
    sf = ts.createSourceFile("route.ts", src, ts.ScriptTarget.Latest, false);
    sourceFileCache.set(src, sf);
  }
  return sf;
}

/** Initializer expression of a local `const name = ...` declaration. */
function resolveLocalInitializer(src, name) {
  const sf = parseSource(src);
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found = node.initializer.getText(sf);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function isPropertyValue(src, at) {
  return /[A-Za-z_$][\w$]*\s*:\s*$/.test(src.slice(Math.max(0, at - 60), at));
}

/** Serializer used as an array element: map callback, push, ternary branch. */
function isArrayElementReturn(src, at) {
  const before = src.slice(Math.max(0, at - 60), at);
  if (/(?:return|=>|\?|&&|\|\|)\s*$/.test(before)) return true;
  if (/\.(?:map|push)\(\s*$/.test(before)) return true;
  // Ternary else-branch (`? serializeX(...) : serializeX(...)`).
  return /:\s*$/.test(before) && before.includes("?");
}

/** Split a `{ ... }` literal into its top-level `key: value` chunks. */
function splitObjectEntries(text) {
  const entries = [];
  let depth = 0;
  let start = 1;
  let end = text.length;
  let quote = null;
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0 && c === "}") {
        end = i;
        break;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      entries.push(text.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(text.slice(start, end));
  return entries.map((e) => e.trim()).filter(Boolean);
}

function literalSchema(value) {
  const text = value.trimStart();
  if (/^["'`]/.test(text)) return { type: "string" };
  if (/^-?\d+(\.\d+)?[,)\s]?$/.test(text)) return { type: "number" };
  if (/^(true|false)\b/.test(text)) return { type: "boolean" };
  if (text.startsWith("[")) return { type: "array", items: {} };
  if (text.startsWith("{")) return { type: "object" };
  return null;
}

/**
 * Schema for an expression in a handler: a serializer call, an object/array
 * literal, or a local variable that resolves to one of those.
 */
function schemaForExpression(src, expr, serializerMap, seen = new Set()) {
  const text = expr.trim();
  if (!text) return null;
  if (text.startsWith("{")) return schemaForObject(text, serializerMap, src);
  if (text.startsWith("[")) {
    const inner = earliestSerializer(text, serializerMap);
    return { type: "array", items: inner ? refSchema(inner.name) : {} };
  }
  const serializer = earliestSerializer(text, serializerMap);
  if (serializer) {
    if (isArrayElementReturn(text, serializer.at)) return { type: "array", items: refSchema(serializer.name) };
    // Direct call in the response expression (`await serializeStatus(...)`).
    if (new RegExp(`^(?:await\\s+)?${serializer.fn}\\s*\\(`).test(text)) return refSchema(serializer.name);
    return null;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(text) && !seen.has(text)) {
    seen.add(text);
    const initializer = resolveLocalInitializer(src, text);
    if (initializer) return schemaForExpression(src, initializer, serializerMap, seen);
  }
  return null;
}

/** Envelope response: per-property schema for a `{ ... }` literal. */
function schemaForObject(text, serializerMap, src) {
  const properties = {};
  for (const entry of splitObjectEntries(text)) {
    const match = entry.match(/^(?:(["'])([^"']+)\1|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/);
    if (match) {
      const key = match[2] ?? match[3];
      const value = match[4];
      const placeholder = /^\[\s*\]$/.test(value.trim()) || /^\{\s*\}$/.test(value.trim());
      let schema = placeholder ? propertyFromSource(src, key, serializerMap) : schemaForExpression(src, value, serializerMap);
      properties[key] = schema ?? schemaForExpression(src, value, serializerMap) ?? literalSchema(value) ?? {};
    } else if (/^[A-Za-z_$][\w$]*$/.test(entry)) {
      // Shorthand property — resolve the local variable it refers to.
      properties[entry] = schemaForExpression(src, entry, serializerMap) ?? {};
    }
  }
  return { type: "object", ...(Object.keys(properties).length ? { properties } : {}) };
}

/** A property filled later (`results.statuses.push(serializeStatus(...))`). */
function propertyFromSource(src, key, serializerMap) {
  const match = new RegExp(`\\.${key}\\s*(\\.push\\(|=)`).exec(src);
  if (!match) return null;
  const windowText = src.slice(match.index, match.index + 700);
  const serializer = earliestSerializer(windowText, serializerMap);
  if (!serializer) return null;
  return match[1] === ".push(" || isArrayElementReturn(windowText, serializer.at)
    ? { type: "array", items: refSchema(serializer.name) }
    : refSchema(serializer.name);
}

/** Response (status + schema) for a handler. */
function responseSchemaFor(src, method, serializerMap) {
  const defaultStatus = method === "DELETE" ? 204 : 200;
  if (method === "DELETE") return { status: 204, schema: null };

  const call = lastSuccessCall(src, JSON_CALLEES);
  if (call) {
    const arg = firstArg(call.arg);
    const status = successStatus(call.arg) ?? defaultStatus;

    // Response expression: serializer call, object literal or a local variable.
    const schema = schemaForExpression(src, arg, serializerMap) ?? builtSerializerSchema(src, call.at, arg, serializerMap);
    if (schema) return { status, schema };

    // No serializer: structural inference from the response expression.
    if (arg.startsWith("{")) return { status, schema: schemaForObject(arg, serializerMap, src) };
    if (arg.startsWith("[")) return { status, schema: { type: "array", items: {} } };
    const literal = literalSchema(arg);
    return literal ? { status, schema: literal } : null;
  }

  // Handlers that answer with a raw Response built from a local literal.
  const stringify = callArgs(src, ["JSON.stringify("]);
  if (stringify.length > 0) {
    const arg = firstArg(stringify[stringify.length - 1].arg);
    const schema = schemaForExpression(src, arg, serializerMap);
    if (schema) return { status: defaultStatus, schema };
  }
  return null;
}

/** Serializer built into a local right before returning (timelines, edits). */
function builtSerializerSchema(src, callAt, arg, serializerMap) {
  const built = lastSerializerBefore(src, callAt, serializerMap);
  if (!built || isPropertyValue(src, built.at)) return null;
  const ident = /^[A-Za-z_$][\w$]*$/.test(arg) ? arg : null;
  const preceding = src.slice(Math.max(0, built.at - 60), built.at);
  if (ident && new RegExp(`\\b(?:const|let|var)\\s+${ident}\\s*=\\s*$`).test(preceding)) {
    return refSchema(built.name);
  }
  if (isArrayElementReturn(src, built.at)) return { type: "array", items: refSchema(built.name) };
  return null;
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
  const { schemas, serializerMap } = buildTypeCatalog();
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

      const response = responseSchemaFor(src, method, serializerMap);
      const okStatus = String(response?.status ?? (method === "DELETE" ? 204 : 200));
      op.responses = {
        [okStatus]: {
          description: method === "DELETE" ? "Successfully deleted." : "Successful response.",
          ...(response?.schema ? { content: { "application/json": { schema: response.schema } } } : {}),
        },
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
        "Mastodon-compatible ActivityPub API for this instance.\n\nAuthentication uses OAuth 2.0 bearer tokens obtained from `POST /oauth/token` (password grant). Public endpoints (instance metadata, public timelines, WebFinger, ActivityPub federation, oEmbed) do not require a token. Operations marked with a padlock need `Authorization: Bearer <token>`; everything under **Admin** additionally requires the administrator or moderator role (full administrator for privileged mutations). Click **Authorize** and paste your access token to try authenticated endpoints.\n\nThis document is generated from the actual route handlers in `app/**/route.ts`: paths, tags, auth requirements and parameters are read from the source, and the response schemas are converted from the TypeScript types the serializers declare.",
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
      schemas: { ...schemas, Error: ERROR_SCHEMA },
    },
  };

  let operationCount = 0;
  for (const p of Object.keys(paths)) operationCount += Object.keys(paths[p]).length;
  return { doc, pathCount: Object.keys(paths).length, operationCount, schemaCount: Object.keys(schemas).length };
}

function main() {
  const check = process.argv.includes("--check");
  const { doc, pathCount, operationCount, schemaCount } = buildDoc();
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
    console.log(`OpenAPI spec is up to date: ${pathCount} paths, ${operationCount} operations, ${schemaCount} schemas.`);
    return;
  }

  writeFileSync(outFile, serialized);
  console.log(`OpenAPI generated: ${pathCount} paths, ${operationCount} operations, ${schemaCount} schemas → ${relative(root, outFile)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export {
  buildDoc,
  buildTypeCatalog,
  isProtected,
  hasAuthGuard,
  responseSchemaFor,
  schemaForExpression,
  schemaForObject,
  resolveLocalInitializer,
  lastSuccessCall,
  splitObjectEntries,
};
