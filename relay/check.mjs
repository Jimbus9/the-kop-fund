// Does every Crowdlock file in this repository check out?
//
//   node method/relay/check.mjs        (node relay/check.mjs in a Crowdlock's own repository)
//
// Run on every push that touches a Crowdlock file or a declaration, so a
// mistake turns the repository's checks red the moment it is made, and GitHub
// emails whoever pushed it. The commonest mistake it catches: a new version of
// the declaration whose fingerprint doesn't match its text. Left uncaught, the
// relay inbox skips that Crowdlock on every pass, and no signature or lock
// reaches its register until someone notices.
//
// Checks exactly what the relay inbox checks before it collects anything
// (checkCrowdlock, with the founding text and every later version's text),
// and nothing else. Needs only Node: no network, nothing installed.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCrowdlock } from "../js/crowdlock.mjs";

// The repository root is the first folder above this one that holds crowdlocks/,
// as for the inbox.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = (() => {
  let d = HERE;
  while (!existsSync(join(d, "crowdlocks"))) {
    const up = dirname(d);
    if (up === d) throw new Error(`no crowdlocks/ folder above ${HERE}`);
    d = up;
  }
  return d;
})();

const read = (p) => { try { return readFileSync(join(ROOT, p), "utf8"); } catch { return null; } };

/** Problems with one Crowdlock file, as plain sentences; empty if it checks out. */
export function problemsWith(crowdlock) {
  const declarationText = read(crowdlock?.declaration?.file ?? "");
  if (declarationText === null) return [`its declaration file ${crowdlock?.declaration?.file} is missing`];
  const versionTexts = {};
  const missing = [];
  for (const v of crowdlock.declaration_versions ?? []) {
    const t = read(v.file ?? "");
    if (t === null) missing.push(`version ${v.version}'s file ${v.file} is missing`);
    versionTexts[v.version] = t ?? "";
  }
  const r = checkCrowdlock(crowdlock, { declarationText, versionTexts });
  return [...missing, ...(r.ok ? [] : r.problems)];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let bad = 0, seen = 0;
  for (const file of readdirSync(join(ROOT, "crowdlocks")).filter((f) => f.endsWith(".json") && f !== "index.json").sort()) {
    let c;
    try { c = JSON.parse(read(join("crowdlocks", file))); }
    catch (e) { console.log(`::error file=crowdlocks/${file}::crowdlocks/${file} is not valid JSON: ${e.message}`); bad++; continue; }
    // Only Crowdlocks this repository runs: an inbox collects for a file that names relays.
    if (!Array.isArray(c.relays)) continue;
    seen++;
    const problems = problemsWith(c);
    if (problems.length) {
      bad++;
      console.log(`::error file=crowdlocks/${file}::crowdlocks/${file} does not check out, so the relay inbox will collect nothing for it until it is fixed: ${problems.join("; ")}`);
    } else {
      console.log(`crowdlocks/${file}: checks out`);
    }
  }
  if (bad) process.exit(1);
  console.log(seen === 1 ? "The Crowdlock file checks out." : `All ${seen} Crowdlock files check out.`);
}
