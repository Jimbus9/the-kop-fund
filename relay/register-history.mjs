// node relay/register-history.mjs   (from the top of the repository)
//
// Fails if any commit in this repository's history did to a Crowdlock's
// records what a Crowdlock never does. For every Crowdlock file in
// crowdlocks/:
//
//   - where its register and its proposals live never changed: moving the
//     register to a new file would have readers look at a different history
//     while the old file stayed whole;
//   - its register only ever grew (js/history.mjs);
//   - each lock added since 18 November 2026 kept the rules the inbox applies
//     when it adds one: it names the Crowdlock's newest co-signer key as it
//     stood then, and runs at least the shortest length it offered, less a
//     month. So a lock written into the register by hand, past the inbox,
//     can't escape them;
//   - each proposal's pile of commitments only ever grew (relay/accept.mjs).
//
// Every commit that touched a file is read, merges included, oldest first.
// Needs the whole history: check out with fetch-depth: 0.

import { execFileSync } from "node:child_process";
import { shrinkage } from "../js/history.mjs";
import { pileGrew } from "./accept.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
const show = (commit, path) => { try { return JSON.parse(git("show", `${commit}:${path}`)); } catch { return null; } };
const versions = (path) => git("log", "--format=%H %ct", "--reverse", "--full-history", "--topo-order", "--", path).split("\n").filter(Boolean).map((l) => { const [h, t] = l.split(" "); return { commit: h, time: Number(t) }; });
const norm = (p) => (typeof p === "string" ? p.replace(/^\.\//, "") : null);
const YEAR = 31557600;
// From when the inbox's rules for adding a lock were in force.
const RULES_FROM = Date.parse("2026-11-18T00:00:00Z") / 1000;

if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
  console.error("This checkout has only part of the history, so it can't be checked. Check out with fetch-depth: 0.");
  process.exit(1);
}

const errors = [];
const say = (path, commit, what) => { errors.push(`${path}, commit ${commit.slice(0, 7)}: ${what}`); };
const files = git("ls-tree", "--name-only", "HEAD", "crowdlocks/").split("\n").filter((f) => f.endsWith(".json") && !f.endsWith("/index.json"));
let checked = 0;

for (const file of files) {
  const configs = versions(file).map((v) => ({ ...v, c: show(v.commit, file) })).filter((v) => v.c);
  const regPaths = new Set(configs.map((v) => norm(v.c.register?.registrations)).filter(Boolean));
  const propPaths = new Set(configs.map((v) => norm(v.c.register?.proposals)).filter(Boolean));
  if (regPaths.size > 1) say(file, configs.at(-1).commit, `its register moved: ${[...regPaths].join(" → ")}`);
  if (propPaths.size > 1) say(file, configs.at(-1).commit, `its proposals moved: ${[...propPaths].join(" → ")}`);
  const configAt = (time) => [...configs].reverse().find((v) => v.time <= time)?.c ?? configs[0]?.c;

  // The register.
  const reg = [...regPaths].at(-1);
  if (reg) {
    const steps = versions(reg);
    if (!steps.length) say(reg, "0000000", "no version of it is in the history");
    let last = null;
    for (const step of steps) {
      const now = show(step.commit, reg);
      if (now === null) { say(reg, step.commit, "this version is not readable JSON"); continue; }
      if (last) {
        for (const x of shrinkage(last, now)) say(reg, step.commit, x);
        if (step.time >= RULES_FROM) {
          const c = configAt(step.time);
          const keys = (c?.cosigner_keys ?? []).map((k) => String(k).toLowerCase());
          const shortest = Math.min(...(c?.lock_lengths_years ?? [0]));
          for (const lock of (now.locks ?? []).slice((last.locks ?? []).length)) {
            if (keys.length && String(lock.cosigner_pubkey).toLowerCase() !== keys.at(-1)) say(reg, step.commit, `lock ${lock.address} names a co-signer key that wasn't the newest when it was added`);
            if (c?.network !== "regtest" && Number(lock.locktime) < step.time + shortest * YEAR - 30 * 86400) say(reg, step.commit, `lock ${lock.address} is shorter than the shortest length the Crowdlock offered when it was added`);
          }
        }
      }
      last = now;
    }
    checked += steps.length;
  }

  // Each proposal's pile.
  const props = [...propPaths].at(-1);
  if (props) {
    const dir = `${props.includes("/") ? props.slice(0, props.lastIndexOf("/") + 1) : ""}commitments/`;
    const piles = new Set(git("log", "--format=", "--name-only", "--full-history", "--", dir).split("\n").filter((p) => /^.*\/?commitments\/[0-9a-f]{64}\.json$/.test(p) && p.startsWith(dir)));
    for (const pile of piles) {
      const hash = pile.slice(dir.length, -5);
      let last = null;
      for (const step of versions(pile)) {
        const now = show(step.commit, pile);
        if (now === null) { if (last) say(pile, step.commit, "the pile was removed or is not readable JSON"); continue; }
        for (const x of pileGrew(last, now, hash)) say(pile, step.commit, x);
        last = now;
      }
      checked++;
    }
  }
}

for (const e of errors) console.log(`::error::${e}`);
if (errors.length) { console.log("A Crowdlock's records have not only grown: see above."); process.exit(1); }
if (!checked) { console.log("No register was found to check, which is itself wrong for a Crowdlock's repository."); process.exit(1); }
console.log(`Every Crowdlock's records have only ever grown (${checked} versions and piles read).`);
