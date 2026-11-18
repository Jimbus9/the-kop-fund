// node tests/register-history.mjs <register file>
//
// Fails if any commit in this repository's history took anything off the
// register or changed it, rather than adding to it (method/js/history.mjs).
// Needs the whole history: check out with fetch-depth: 0.

import { execFileSync } from "node:child_process";
import { historyProblems } from "../js/history.mjs";

const file = process.argv[2];
if (!file) { console.error("usage: node register-history.mjs <register file>"); process.exit(2); }
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });

if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
  console.error("This checkout has only part of the history, so the register's history can't be checked. Check out with fetch-depth: 0.");
  process.exit(1);
}
const commits = git("log", "--format=%H", "--reverse", "--", file).split("\n").filter(Boolean);
const versions = commits.map((c) => {
  try { return JSON.parse(git("show", `${c}:${file}`)); } catch { return null; }
});
const bad = historyProblems(versions);
for (const { step, problems } of bad) {
  for (const p of problems) console.log(`::error::${file}, commit ${commits[step].slice(0, 7)}: ${p}`);
}
if (bad.length) { console.log(`${file} has not only grown: see above.`); process.exit(1); }
console.log(`${file} has only ever grown, through ${commits.length} versions.`);
