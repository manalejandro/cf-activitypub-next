#!/usr/bin/env node
/**
 * Fail when the code reads an environment variable that `.dev.vars.example`
 * does not document (the file is the single reference of every variable and its
 * default). Sources of truth:
 *
 *   - `lib/constants.ts`: `resolveLimits()` reads the tunables by name.
 *   - anywhere: `env.NAME` / `env["NAME"]` reads of an upper-case key.
 *
 * Run with `npm run check:env`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const KEY = String.raw`[A-Z][A-Z0-9_]{2,}`;
const IGNORED = new Set([
  // Bindings, not variables (wrangler.toml / Durable Objects).
  "DB", "KV", "R2", "AI", "EMAIL", "ASSETS", "DELIVERY_QUEUE", "TIMELINE_STREAM",
  "CALL_SIGNALING", "GuardianAgent", "VECTORIZE", "TEST_SCHEMA",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mts|mjs)$/.test(entry)) out.push(path);
  }
  return out;
}

const documented = new Set(
  readFileSync(join(ROOT, ".dev.vars.example"), "utf8")
    .split("\n")
    .map((line) => line.replace(/^#\s*/, "").trim())
    .filter((line) => line.includes("="))
    .map((line) => line.split("=")[0].trim())
);

const read = new Map();
const patterns = [
  new RegExp(String.raw`(?<!process\.)env\["(${KEY})"\]`, "g"),
  new RegExp(String.raw`(?<!process\.)env\.(${KEY})\b`, "g"),
];
for (const file of walk(ROOT)) {
  if (file.includes("/__tests__/") || file.includes("/test/") || file.endsWith("scripts/check-env-vars.mjs")) continue;
  const source = readFileSync(file, "utf8");
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const name = match[1];
      if (!IGNORED.has(name)) read.set(name, read.get(name) ?? file.slice(ROOT.length + 1));
    }
  }
}

const missing = [...read.entries()].filter(([name]) => !documented.has(name));
if (missing.length > 0) {
  console.error("Environment variables read by the code but missing from .dev.vars.example:");
  for (const [name, file] of missing.sort()) console.error(`  - ${name} (${file})`);
  process.exit(1);
}
console.log(`check:env OK — ${documented.size} variables documented in .dev.vars.example`);
