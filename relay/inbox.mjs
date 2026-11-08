// The relay inbox job. Run by .github/workflows/relay-inbox.yml every few
// minutes, in the Crowdlock's own repository, with no secrets: it writes only
// to its own register files, and the workflow commits them.
//
// For every Crowdlock file in crowdlocks/ that names relays: collect the
// records posted for it, put each through the endpoints' own judgement
// (method/js/inbox.mjs), and write the register if anything was added. Prints one
// line per record, so the job's log is a public account of what was taken
// and what was refused, and why.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyRecords, announcementTemplate, announcementDue } from "../js/inbox.mjs";
import { membershipStatement, checkCrowdlock } from "../js/crowdlock.mjs";
import { fetchRecords, postTemplate } from "./nostr.mjs";
import { recordPass, planSwaps, SILENT_DAYS } from "../js/relayhealth.mjs";

// A relay connection can report an error after it has already been finished
// with. Left alone, that would end the whole pass part-way — after one
// Crowdlock's register was saved but before the next was read or the commit
// message written. Log it and carry on; anything missed is judged again on
// the next pass in any case.
process.on("unhandledRejection", (e) => console.log(`A relay connection failed after we were done with it: ${e?.message ?? e}`));
process.on("uncaughtException", (e) => console.log(`A relay connection failed after we were done with it: ${e?.message ?? e}`));

// This folder holds the inbox code and its two state files. The repository
// root is the first folder above it that holds crowdlocks/: the parent of
// method/relay/ in a founder's repository, and two levels up in this one (the code
// lives under method/).
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
// Records are looked for over the last 90 days and judged afresh each run, so
// a lock posted before it confirmed is added once it has, and a job that was
// asleep for a while catches up.
const WINDOW = 90 * 86400;

const now = Math.floor(Date.now() / 1000);
const today = new Date().toISOString().slice(0, 10);
const messages = [];
// When each Crowdlock's relays last answered, and since when any has been
// silent: method/relay/health.json, public like everything else here.
const HEALTH = join(HERE, "health.json");
let allHealth = {};
try { allHealth = JSON.parse(readFileSync(HEALTH, "utf8")); } catch {}
const healthBefore = JSON.stringify(allHealth);

// When each listed Crowdlock was last announced (method/relay/announced.json), and
// where this repository's site is, so each file's public link can be given.
const ANNOUNCED = join(HERE, "announced.json");
let announced = {};
try { announced = JSON.parse(readFileSync(ANNOUNCED, "utf8")); } catch {}
const announcedBefore = JSON.stringify(announced);
let listed = [];
try { listed = JSON.parse(readFileSync(join(ROOT, "crowdlocks", "index.json"), "utf8")).crowdlocks ?? []; } catch {}
const [owner, repo] = String(process.env.GITHUB_REPOSITORY ?? "").split("/");
const siteBase = owner && repo ? `https://${owner.toLowerCase()}.github.io/${repo}/` : null;

for (const file of readdirSync(join(ROOT, "crowdlocks")).filter((f) => f.endsWith(".json") && f !== "index.json")) {
  const crowdlock = JSON.parse(readFileSync(join(ROOT, "crowdlocks", file), "utf8"));
  if (!Array.isArray(crowdlock.relays)) continue;
  const declarationText = readFileSync(join(ROOT, crowdlock.declaration.file), "utf8");
  const ok = checkCrowdlock(crowdlock, { declarationText });
  if (!ok.ok) { console.log(`${file}: skipped, its file does not check out: ${ok.problems.join("; ")}`); continue; }

  const regPath = join(ROOT, crowdlock.register.registrations);
  const register = JSON.parse(readFileSync(regPath, "utf8"));
  const { events, report } = await fetchRecords(crowdlock.relays, crowdlock.declaration.sha256, now - WINDOW);
  for (const r of report) console.log(`${file}: ${r.relay} ${r.ok ? `answered, ${r.count} record(s)` : `did not answer (${r.reason})`}`);
  if (!report.some((r) => r.ok)) { console.log(`${file}: no relay answered — nothing changed`); continue; }

  // Relay health, and a swap for any relay silent for SILENT_DAYS.
  const health = recordPass(allHealth[file] ?? {}, report.map((r) => ({ relay: r.relay, ok: r.ok })), today);
  const swap = planSwaps(crowdlock, health, today);
  allHealth[file] = swap.health;
  for (const w of swap.swaps) {
    const when = w.lastAnswered ? `last answered ${w.lastAnswered}` : "never answered";
    console.log(`${file}: ${w.out} ${when}, ${w.days} days — replaced with ${w.in}`);
    messages.push(`Relay ${w.out.replace("wss://", "")} ${when} (${w.days} days), replaced with ${w.in.replace("wss://", "")}`);
  }
  for (const r of swap.stuck) console.log(`${file}: WARNING ${r} silent for ${SILENT_DAYS}+ days and no spare relay is left to replace it`);
  if (swap.swaps.length) writeFileSync(join(ROOT, "crowdlocks", file), JSON.stringify(swap.crowdlock, null, 2) + "\n");

  // Announce it weekly, if this site lists it — a Crowdlock left off its own
  // index (like a private test copy) is never announced.
  const slug = file.replace(/\.json$/, "");
  if (siteBase && listed.includes(slug) && announcementDue(announced[file], today)) {
    const url = `${siteBase}crowdlocks/${file}`;
    const posted = await postTemplate(crowdlock.relays, announcementTemplate(
      { url, name: crowdlock.name, about: crowdlock.about ?? "", network: crowdlock.network }, now));
    const took = posted.filter((p) => p.ok).length;
    console.log(`${file}: announced to ${took} of ${posted.length} relays`);
    if (took > 0) announced[file] = today;
  }

  const confirmedSats = async (address) => {
    const res = await fetch(`${crowdlock.chain_api}/address/${address}`);
    if (!res.ok) throw new Error(String(res.status));
    const s = (await res.json()).chain_stats;
    return s.funded_txo_sum - s.spent_txo_sum;
  };
  const result = await applyRecords(register, events, {
    crowdlock, statement: membershipStatement(crowdlock), now, today, confirmedSats,
  });
  for (const o of result.outcome) {
    console.log(`${file}: ${o.type} ${o.address} — ${o.added ? `ADDED${o.n ? ` (member ${o.n})` : ""}` : `not added: ${o.reason}`}`);
    if (o.added) messages.push(o.type === "join" ? `Member ${o.n} (via relays)` : `Lock for member ${o.n} (via relays)`);
  }
  if (result.register !== register) {
    writeFileSync(regPath, JSON.stringify(result.register, null, 2) + "\n");
  }
}

if (JSON.stringify(announced) !== announcedBefore) {
  writeFileSync(ANNOUNCED, JSON.stringify(announced, null, 2) + "\n");
  if (!messages.length) messages.push("Announced on the relays");
}
if (JSON.stringify(allHealth) !== healthBefore) {
  writeFileSync(HEALTH, JSON.stringify(allHealth, null, 2) + "\n");
  if (!messages.length) messages.push("Relay health");
}

// The workflow uses this as the commit message, if anything changed.
if (messages.length) writeFileSync(join(HERE, ".message"), messages.join(", "));
