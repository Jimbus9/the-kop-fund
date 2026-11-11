// The fund's name lives in one place: site.json. This stamps it into the pages.
//
//   node tools/stamp-name.mjs          write the name into every page
//   node tools/stamp-name.mjs --check  change nothing; fail if a page disagrees
//
// The pages stay plain HTML with no build step: this only runs when the name
// changes. A stamped name is ordinary text, so it is there with scripts off and
// in link previews, which a name filled in by a script would not be.
//
// Two kinds of stamp:
//   <!--name-->The Kop Fund<!--/name-->            the name, in running text
//   <title data-t="Lock | {name}">…</title>        a title or a meta content,
//   <meta … data-t="{name}" content="…">           built from its data-t pattern
//
// A redesigned page (any page with a stamp in it) must not carry the name
// anywhere else, and --check fails if one does. Body copy says "the fund".
//
// RENAME CHECKLIST. Stamping does not reach these, on purpose (they are not
// pages, or they are read by the app and by members' tools):
//   crowdlocks/kop-fund.json ("name"; the test copy lives in the method repository, fanfund)
//   spec/*.md (the documents), README.md, js/crowdlock.mjs (one comment)
//   the site's own addresses, which contain the name: the GitHub address
//   (the-kop-fund) and the domain thekopfund.org in CNAME (bought 11 November)
// The signed declaration does not contain the name, so no signature breaks.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKIP = new Set(["node_modules", ".git", ".github"]);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function siteName(root = ROOT) {
  const name = JSON.parse(readFileSync(join(root, "site.json"), "utf8")).name;
  if (typeof name !== "string" || !name.trim()) throw new Error("site.json has no name");
  return name.trim();
}

function pages(root) {
  const out = [];
  (function walk(dir) {
    for (const n of readdirSync(dir)) {
      if (SKIP.has(n)) continue;
      const full = join(dir, n);
      if (statSync(full).isDirectory()) walk(full);
      else if (n.endsWith(".html")) out.push(full);
    }
  })(root);
  return out;
}

const NAME_RE = /<!--name-->[\s\S]*?<!--\/name-->/g;
const TITLE_RE = /<title data-t="([^"]*)">[\s\S]*?<\/title>/g;
const META_RE = /(<meta\b[^>]*\bdata-t="([^"]*)"[^>]*\bcontent=")[^"]*(")/g;

export function stamp(html, name) {
  const fill = (pattern) => esc(pattern.replace(/\{name\}/g, name));
  return html
    .replace(NAME_RE, `<!--name-->${esc(name)}<!--/name-->`)
    .replace(TITLE_RE, (_, t) => `<title data-t="${t}">${fill(t)}</title>`)
    .replace(META_RE, (_, head, t, tail) => `${head}${fill(t)}${tail}`);
}

// Problems found without changing anything: pages whose stamps are out of date,
// and stamped pages that carry the name outside a stamp.
export function checkStamps(root = ROOT) {
  const name = siteName(root);
  const problems = [];
  let stamped = 0;
  for (const file of pages(root)) {
    const html = readFileSync(file, "utf8");
    if (!NAME_RE.test(html) && !/data-t="/.test(html)) { NAME_RE.lastIndex = 0; continue; }
    NAME_RE.lastIndex = 0;
    stamped++;
    const rel = relative(root, file).split("\\").join("/");
    if (stamp(html, name) !== html) problems.push(`${rel}: a stamp does not match site.json (run node tools/stamp-name.mjs)`);
    const rest = html.replace(NAME_RE, "").replace(TITLE_RE, "").replace(META_RE, "");
    if (rest.toLowerCase().includes(name.toLowerCase())) problems.push(`${rel}: the name appears outside a stamp`);
  }
  return { name, stamped, problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const r = checkStamps();
    for (const p of r.problems) console.log(p);
    console.log(r.problems.length ? `${r.problems.length} problem(s)` : `${r.stamped} page(s) carry "${r.name}" and nothing else`);
    process.exit(r.problems.length ? 1 : 0);
  }
  const name = siteName();
  let changed = 0;
  for (const file of pages(ROOT)) {
    const html = readFileSync(file, "utf8");
    const next = stamp(html, name);
    if (next !== html) { writeFileSync(file, next); changed++; }
  }
  console.log(`"${name}" stamped; ${changed} page(s) changed.`);
}
