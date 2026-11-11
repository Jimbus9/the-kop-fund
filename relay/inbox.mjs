// The relay inbox job. Run by .github/workflows/relay-inbox.yml every few
// minutes, in the Crowdlock's own repository, with no secrets: it writes only
// to its own register files, and the workflow commits them.
//
// For every Crowdlock file in crowdlocks/ that names relays: collect the
// records posted for it, put each through the endpoints' own judgement
// (method/js/inbox.mjs), and write the register if anything was added. Prints one
// line per record, so the job's log is a public account of what was taken
// and what was refused, and why.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyRecords, announcementTemplate, announcementDue } from "../js/inbox.mjs";
import { membershipStatement, checkCrowdlock } from "../js/crowdlock.mjs";
import { fetchRecords, postTemplate } from "./nostr.mjs";
import { recordPass, planSwaps, SILENT_DAYS } from "../js/relayhealth.mjs";
import { checkProposals, phaseOf, pilePath, emptyPile, checkPileShape, applyCommitments, applySettlement, dueToSend, commitmentFromEvent } from "../js/proposals.mjs";
import { memberAddressForOwnerKey } from "../js/verify.mjs";
import { Transaction } from "bitcoinjs-lib";

// A large settlement is sent a few at a time, every pass, rather than all at
// once (spec/proposal-and-settlement.md, "Pacing is not optional").
const SEND_PER_PASS = 25;
const hrpOf = (c) => (c.network === "mainnet" ? "bc" : c.network === "regtest" ? "bcrt" : "tb");
const txidOf = (hex) => { try { return Transaction.fromHex(hex).getId(); } catch { return null; } };

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

  // Commitments to its proposals: recorded in each proposal's pile, in the
  // order this repository first saw them. Readers check every one in full.
  if (crowdlock.register.proposals && existsSync(join(ROOT, crowdlock.register.proposals))) {
    const checked = checkProposals(JSON.parse(readFileSync(join(ROOT, crowdlock.register.proposals), "utf8")), crowdlock);
    for (const x of checked.problems) console.log(`${file}: proposals: ${x}`);
    const nowIso = new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    for (const p of checked.proposals) {
      const phase = phaseOf(p, now * 1000);
      if (phase === "soon" || phase === "over") continue;
      const rel = pilePath(crowdlock.register.proposals, p.hash);
      const at = join(ROOT, rel);
      let pile = emptyPile(p.hash);
      if (existsSync(at)) {
        pile = JSON.parse(readFileSync(at, "utf8"));
        const shape = checkPileShape(pile, p.hash);
        if (!shape.ok) { console.log(`${file}: pile for "${p.title}" left alone: ${shape.reason}`); continue; }
      }
      const got = applyCommitments(pile, events, { crowdlock, proposal: p, register: result.register, nowIso });
      for (const o of got.outcome) console.log(`${file}: commitment to "${p.title}" from ${o.lock} — ${o.added ? "ADDED" : `not added: ${o.reason}`}`);
      const n = got.outcome.filter((o) => o.added).length;
      if (n) messages.push(`${n} commitment${n === 1 ? "" : "s"} to "${p.title}" (via relays)`);

      // What the co-signer has done: completed transactions, published here
      // so anyone can broadcast them, and a failure notice.
      const items = events.map((e) => commitmentFromEvent(e, crowdlock.declaration.sha256, p.hash)).filter((x) => x && x.type !== "commitment");
      const settled = applySettlement(got.pile, items, { crowdlock, hash: p.hash, hrp: hrpOf(crowdlock), addressOf: memberAddressForOwnerKey, txidOf, nowIso });
      for (const o of settled.outcome) console.log(`${file}: ${o.kind} for "${p.title}" — ${o.added ? "RECORDED" : `not recorded: ${o.reason}`}`);
      if (settled.outcome.some((o) => o.added && o.kind === "notice")) messages.push(`"${p.title}" declared dead by the co-signer`);
      let next = settled.pile;

      // Send what is due, paced: at most SEND_PER_PASS a pass, oldest
      // commitment first, and only while the proposal is still settling.
      let sent = 0;
      for (const c of dueToSend(next, SEND_PER_PASS, txidOf)) {
        let state = null;
        try {
          const known = await fetch(`${crowdlock.chain_api}/tx/${c.txid}/status`);
          if (known.ok) state = "already on the network";
          else {
            const r = await fetch(`${crowdlock.chain_api}/tx`, { method: "POST", body: c.tx });
            const text = (await r.text()).trim();
            state = r.ok ? "sent" : null;
            if (!r.ok) console.log(`${file}: ${c.txid} for "${p.title}" — refused by the network: ${text.slice(0, 200)}`);
          }
        } catch (e) { console.log(`${file}: ${c.txid} — could not reach the network: ${e.message}`); }
        if (state) {
          next = { ...next, completed: next.completed.map((x) => x.txid === c.txid ? { ...x, sent: nowIso } : x) };
          console.log(`${file}: ${c.txid} for "${p.title}" — ${state}`);
          sent++;
        }
      }
      if (sent) messages.push(`${sent} payment${sent === 1 ? "" : "s"} for "${p.title}" sent`);
      else if (settled.outcome.some((o) => o.added && o.kind === "completed")) messages.push(`Completed payments for "${p.title}" published`);

      if (JSON.stringify(next) !== JSON.stringify(pile)) {
        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, JSON.stringify(next, null, 2) + "\n");
      }
    }
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
