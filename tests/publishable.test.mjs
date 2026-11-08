// Every file the browser loads must actually be published.
//
// GitHub Pages runs Jekyll, and Jekyll silently refuses to publish any file or
// directory whose name begins with an underscore. Two of the vendored crypto
// files are named _md.js and _assert.js, so for a week the register page's
// signature verification was broken in production while every local test
// passed. Nobody noticed because the register is empty.
//
// A .nojekyll file at the root turns Jekyll off. This test makes sure it stays
// there, and that nothing else the browser needs would be dropped.
//
// Run:  node tests/publishable.test.mjs

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const R = fileURLToPath(new URL("../", import.meta.url));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(58)} ${detail}`);
};

console.log("\n" + "-".repeat(78));
console.log("EVERYTHING THE BROWSER LOADS IS ACTUALLY PUBLISHED");
console.log("-".repeat(78));

check(".nojekyll exists at the repository root", existsSync(join(R, ".nojekyll")),
  "without it, Jekyll drops anything starting with _");

// Walk what would be served, ignoring what is not.
const SKIP = new Set(["node_modules", ".git", ".github"]);
const served = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else served.push(relative(R, full).split("\\").join("/"));
  }
})(R);

const underscored = served.filter((p) => p.split("/").some((seg) => seg.startsWith("_")));
console.log();
for (const p of underscored) console.log(`      underscored: ${p}`);
check(`${underscored.length} underscored path(s) — safe only because .nojekyll is present`,
  existsSync(join(R, ".nojekyll")) || underscored.length === 0);

// Follow the import graph from each browser entry point and prove every hop
// resolves to a file that exists.
const ENTRIES = ["js/verify.mjs", "js/crowdlock.mjs"];
const missing = [];
const seen = new Set();
function follow(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(join(R, file), "utf8");
  for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    const dir = file.split("/").slice(0, -1).join("/");
    const target = join(dir, m[1]).split("\\").join("/");
    if (!existsSync(join(R, target))) missing.push(`${file} -> ${m[1]}`);
    else follow(target);
  }
}
for (const e of ENTRIES) follow(e);

console.log();
check("Every import from the browser entry points resolves", missing.length === 0,
  missing.join(", ") || `${seen.size} files in the graph`);

// No bare specifiers: a browser cannot resolve "noble-hashes", only paths.
const bare = [];
for (const f of seen) {
  const src = readFileSync(join(R, f), "utf8");
  for (const m of src.matchAll(/from\s+["']([^."'][^"']*)["']/g)) bare.push(`${f} -> ${m[1]}`);
}
check("No bare import specifiers in browser code", bare.length === 0, bare.join(", ") || "all relative");

// Every element a page's script reaches for must exist in that page's markup.
//
// This is the same shape of bug as the Jekyll one: the page looks fine here
// and breaks in a browser. Renaming or removing an id in the markup without
// updating the script throws on load, and a thrown script means a register
// that renders nothing at all — every figure stuck on its placeholder dash,
// with no error anyone but the visitor can see. Found worth guarding after
// the signature counters were deliberately removed from the register page.
{
  const pages = ["index.html", "register/index.html", "join/index.html"];
  for (const page of pages) {
    const src = readFileSync(join(R, page), "utf8");
    const ids = new Set([...src.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const wanted = new Set([
      ...[...src.matchAll(/\bel\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
      ...[...src.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
    ]);
    const missing = [...wanted].filter((id) => !ids.has(id));
    check(`${page}: every element its script reaches for exists`, missing.length === 0,
      missing.length ? `missing: ${missing.join(", ")}` : `${wanted.size} checked`);
  }
}

// The front page carries its own copy of the declaration, so a visitor can
// hash what they are reading rather than trust that it matches the file. Two
// copies can drift. If they ever do, the page tells every visitor the
// fingerprint does not match — which is the correct behaviour and a terrible
// thing to discover in public. So the copies are compared here instead.
{
  const { canonicalise, declarationHash } = await import("../js/crowdlock.mjs");
  const crowdlock = JSON.parse(readFileSync(join(R, "crowdlocks/kop-fund.json"), "utf8"));
  const page = readFileSync(join(R, "index.html"), "utf8");
  const embedded = page.match(/<script id="declText" type="text\/plain">([\s\S]*?)<\/script>/);
  const published = page.match(/PUBLISHED\s*=\s*"([0-9a-f]{64})"/);

  check("The front page embeds the declaration text", Boolean(embedded),
    embedded ? "" : "no declText block — the in-page check cannot run");
  check("The front page's copy of the declaration is the published one",
    Boolean(embedded) && declarationHash(embedded[1]) === crowdlock.declaration.sha256,
    embedded ? declarationHash(embedded[1]) : "");
  check("The fingerprint the page checks against is the Crowdlock's",
    published?.[1] === crowdlock.declaration.sha256, published?.[1] ?? "not found");
  check("The declaration file itself still hashes correctly",
    declarationHash(readFileSync(join(R, crowdlock.declaration.file), "utf8")) === crowdlock.declaration.sha256);
  check("Canonicalisation is doing something, not passing text through",
    canonicalise("a  \r\nb\n\n\n") === "a\nb\n");
}

console.log("\n" + "-".repeat(78));
console.log(failures === 0
  ? "Everything the browser needs would be served."
  : `${failures} problem(s) — the live site would be broken.`);
console.log();
process.exit(failures === 0 ? 0 : 1);
