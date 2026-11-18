// node relay/accept.mjs
//
// Run by the relay inbox's publishing job, in the repository, after one pass's
// changes have been applied and before they are committed. It decides whether
// those changes are the kind a pass makes, and refuses everything else.
//
// Why it exists: the inbox's collecting
// job runs outside libraries (the Nostr client, bitcoinjs-lib). It used to run
// them while holding this repository's write permission, so a library gone
// bad could have rewritten the website's code or published a fake app release.
// Now they run as a user that holds no token; each pass's changes come back as
// a patch, and the workflow, which runs none of those libraries itself,
// applies them only if this check passes. So the worst a bad library can do is put
// bad data where data goes, and even that is limited:
//
//   - the relay health and announcement files, as JSON;
//   - a Crowdlock's registrations file, which may only grow (js/history.mjs);
//   - a proposal's pile of commitments, which may only grow: commitments are
//     only added at the end; a completed payment is only added for a
//     commitment already in the pile, and is the same transaction; one is
//     marked sent only once the block explorer knows it; and a failure notice
//     is never changed once there. A new pile is only for a published proposal;
//   - a Crowdlock's own file, and in it only its relays: a spare promoted to
//     replace a silent relay, one for one, and nothing else.
//
// How the libraries are kept from the write permission: they run as a
// separate, unprivileged user on the runner, in a copy of the repository, with
// no token in their environment; only the patch they leave comes back.
//
// Anything else changed, added or removed is refused, and the pass is dropped.
// Uses no library: only Node and this repository's own js/ folder.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { shrinkage } from "../js/history.mjs";

// The workflow runs a copy of this file kept apart from the working tree (so
// a patch can't change the check that judges it), and says where things are.
const HERE = process.env.RELAY_DIR_ABS ?? dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.REPO_ROOT ?? (() => {
  let d = HERE;
  for (;;) {
    if (existsSync(join(d, "crowdlocks"))) return d;
    const up = dirname(d);
    if (up === d) throw new Error(`no crowdlocks/ folder above ${HERE}`);
    d = up;
  }
})();
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
const atHead = (path) => { try { return execFileSync("git", ["show", `HEAD:${path}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
const now = (path) => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), "utf8") : null);
const json = (text) => { try { return text === null ? null : JSON.parse(text); } catch { return undefined; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const slash = (p) => p.split("\\").join("/");

/**
 * Every way the staged tree differs from HEAD: [{ path, status, mode }]. The
 * workflow applies a pass's patch with --index, so everything it changed is
 * staged; anything left unstaged or untracked is refused outright.
 */
function changes() {
  const out = [];
  const raw = git("diff", "--cached", "--raw", "--no-renames", "-z").split("\0").filter(Boolean);
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [, newMode, , , status] = raw[i].replace(/^:/, "").split(" ");
    out.push({ status, mode: newMode, path: raw[i + 1] });
  }
  for (const p of git("diff", "--name-only", "-z").split("\0").filter(Boolean)) out.push({ status: "U", mode: "", path: p });
  for (const p of git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)) out.push({ status: "U", mode: "", path: p });
  return out;
}

/**
 * A transaction's id, worked out from its hex here rather than by a library:
 * the double SHA-256 of everything but its witness, byte order reversed. Null
 * for anything that isn't one whole transaction.
 */
export function txidOfHex(hex) {
  if (typeof hex !== "string" || hex.length > 400_000 || !/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const b = Buffer.from(hex, "hex");
  let i = 0;
  const take = (n) => { if (n < 0 || i + n > b.length) throw new Error("short"); const s = b.subarray(i, i + n); i += n; return s; };
  const count = () => {
    const f = take(1)[0];
    const n = f < 0xfd ? f : f === 0xfd ? take(2).readUInt16LE() : f === 0xfe ? take(4).readUInt32LE() : Infinity;
    if (n > b.length) throw new Error("too many");
    return n;
  };
  try {
    const version = take(4);
    let witness = false;
    if (b[i] === 0 && b[i + 1] === 1) { witness = true; i += 2; }
    const start = i;
    const ins = count();
    if (ins === 0) return null;
    for (let k = 0; k < ins; k++) { take(36); take(count()); take(4); }
    const outs = count();
    for (let k = 0; k < outs; k++) { take(8); take(count()); }
    const end = i;
    if (witness) for (let k = 0; k < ins; k++) { const items = count(); for (let j = 0; j < items; j++) take(count()); }
    const locktime = take(4);
    if (i !== b.length) return null;
    const raw = Buffer.concat([version, b.subarray(start, end), locktime]);
    const h = createHash("sha256").update(createHash("sha256").update(raw).digest()).digest();
    return Buffer.from(h).reverse().toString("hex");
  } catch { return null; }
}

/** The completed payments `after` marks sent that `before` didn't: their txids. */
export function newlySent(before, after) {
  const was = new Set((before?.completed ?? []).filter((c) => c?.sent).map((c) => c.txid));
  return (after?.completed ?? []).filter((c) => c?.sent && !was.has(c.txid)).map((c) => c.txid);
}

/** Does a pile only grow from `before` to `after`? Problems, or []. */
export function pileGrew(before, after, hash) {
  const p = [];
  if (!after || typeof after !== "object") return ["it is not a JSON object"];
  if (after.proposal !== hash) p.push("it names another proposal");
  if (!Array.isArray(after.commitments)) p.push("its commitments are not a list");
  if (!before) before = { format: after.format, proposal: hash, commitments: [] };
  for (const k of Object.keys(before)) if (!(k in after)) p.push(`its ${k} was removed`);
  for (const k of ["format", "proposal"]) if (!same(before[k], after[k])) p.push(`its ${k} changed`);
  const bc = before.commitments ?? [];
  bc.forEach((c, i) => { if (!same(c, after.commitments?.[i])) p.push(`commitment ${i + 1} was changed, moved or removed`); });
  for (const c of before.completed ?? []) {
    const n = (after.completed ?? []).find((x) => x?.txid === c?.txid);
    if (!n) { p.push(`the completed payment ${String(c?.txid).slice(0, 12)}… was removed`); continue; }
    // Marked sent: the only thing added to a completed payment.
    for (const [k, v] of Object.entries(c)) if (!same(v, n[k])) p.push(`the completed payment ${String(c.txid).slice(0, 12)}… was changed`);
    for (const k of Object.keys(n)) if (!(k in c) && k !== "sent") p.push(`the completed payment ${String(c.txid).slice(0, 12)}… gained ${k}`);
  }
  // A completed payment added is the transaction of a commitment in the pile,
  // with the co-signer's signature added: so the same txid, worked out here.
  const committed = new Set((after.commitments ?? []).map((c) => txidOfHex(c?.record?.tx)).filter(Boolean));
  const had = new Set((before.completed ?? []).map((c) => c?.txid));
  for (const c of after.completed ?? []) {
    if (had.has(c?.txid)) continue;
    const id = txidOfHex(c?.tx);
    if (!id || id !== c?.txid) p.push(`a completed payment was added whose txid is not its transaction's`);
    else if (!committed.has(id)) p.push(`the completed payment ${id.slice(0, 12)}… is for no commitment in the pile`);
  }
  if (before.notice !== undefined && !same(before.notice, after.notice)) p.push("its failure notice was changed");
  for (const k of Object.keys(after)) if (!["format", "proposal", "commitments", "completed", "notice"].includes(k) && !same(before[k], after[k])) p.push(`its ${k} changed`);
  return p;
}

/** Did a Crowdlock's file change only by promoting spare relays? Problems, or []. */
export function onlyRelaysSwapped(before, after) {
  if (!before || !after) return ["it was added or removed"];
  const p = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === "relays" || k === "spare_relays") continue;
    if (!same(before[k], after[k])) p.push(`its ${k} changed`);
  }
  // A swap, exactly as relayhealth.mjs makes one: each relay replaced takes
  // the next spare, in its place, so the live list keeps its length; the
  // spares lose the ones promoted, from the front, and nothing else.
  const live = Array.isArray(before.relays) ? before.relays : [];
  const spare = Array.isArray(before.spare_relays) ? before.spare_relays : [];
  const now = after.relays;
  if (!Array.isArray(now) || now.length !== live.length || now.length === 0 || !now.every((r) => typeof r === "string")) {
    p.push("its live relays are not the same number as before");
    return p;
  }
  const promoted = now.filter((r, i) => r !== live[i]);
  if (!same(promoted, spare.slice(0, promoted.length))) p.push("a relay was replaced by something other than the next spare");
  if (new Set(now).size !== now.length) p.push("a relay is listed twice");
  const left = spare.slice(promoted.length);
  if (before.spare_relays === undefined ? after.spare_relays !== undefined : !same(after.spare_relays, left)) p.push("the spare relays changed other than by promoting the next");
  return p;
}

/** Does the block explorer at `api` know this transaction (in a block or waiting for one)? */
async function explorerKnows(api, txid, fetchImpl = fetch) {
  // An explorer is reached over https; plain http only on this machine (the tests' stand-in).
  if (typeof api !== "string" || !/^(?:https:\/\/|http:\/\/127\.0\.0\.1[:/])/.test(api) || !/^[0-9a-f]{64}$/.test(txid)) return false;
  try {
    const r = await fetchImpl(`${api.replace(/\/$/, "")}/tx/${txid}/status`, { signal: AbortSignal.timeout(20_000) });
    return r.ok;
  } catch { return false; }
}

async function main() {
  const crowdlocks = git("ls-tree", "--name-only", "HEAD", "crowdlocks/").split("\n").filter((f) => f.endsWith(".json") && !f.endsWith("/index.json"));
  const registers = new Map(), pileDirs = [];
  for (const f of crowdlocks) {
    const c = json(atHead(f));
    if (!c?.register) continue;
    if (typeof c.register.registrations === "string") registers.set(slash(c.register.registrations).replace(/^\.\//, ""), f);
    if (typeof c.register.proposals === "string") {
      const pp = slash(c.register.proposals).replace(/^\.\//, "");
      // A pile is only ever for a proposal its Crowdlock has published.
      const published = new Set((json(atHead(pp))?.proposals ?? []).map((x) => x?.hash).filter((h) => typeof h === "string"));
      pileDirs.push({ dir: `${pp.includes("/") ? pp.slice(0, pp.lastIndexOf("/") + 1) : ""}commitments/`, api: c.chain_api, published });
    }
  }
  const relayDir = slash(relative(ROOT, HERE));
  const data = new Set([`${relayDir}/health.json`, `${relayDir}/announced.json`]);

  const problems = [];
  for (const { path, status, mode } of changes()) {
    const p = slash(path);
    const add = (why) => problems.push(`${p}: ${why}`);
    if (status === "U") { add("left outside the patch the pass made"); continue; }
    if (status.startsWith("D")) { add("a pass never removes a file"); continue; }
    if (mode !== "100644") { add("a pass only ever writes ordinary files"); continue; }
    const after = json(now(p));
    if (after === undefined) { add("not readable JSON"); continue; }
    if (data.has(p)) continue;
    if (registers.has(p)) {
      const before = json(atHead(p));
      if (!before) { add("a register appeared from nowhere"); continue; }
      const s = shrinkage(before, after);
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (k !== "members" && k !== "locks" && !same(before[k], after[k])) s.push(`its ${k} changed`);
      for (const x of s) add(x);
      continue;
    }
    const pile = pileDirs.find((d) => p.startsWith(d.dir) && /^[0-9a-f]{64}\.json$/.test(p.slice(d.dir.length)));
    if (pile) {
      const hash = p.slice(pile.dir.length, -5), before = json(atHead(p));
      if (!before && !pile.published.has(hash)) { add("a pile for a proposal that isn't published"); continue; }
      for (const x of pileGrew(before, after, hash)) add(x);
      // Marked sent only if the explorer really has it: a pile wrongly saying
      // so would keep the inbox from ever sending that payment.
      for (const id of newlySent(before, after)) if (!(await explorerKnows(pile.api, id))) add(`the payment ${String(id).slice(0, 12)}… is marked sent, but the block explorer doesn't know it`);
      continue;
    }
    if (crowdlocks.includes(p)) { for (const x of onlyRelaysSwapped(json(atHead(p)), after)) add(x); continue; }
    add("a pass never writes this file");
  }
  if (problems.length) {
    for (const x of problems) console.log(`::error::Refused: ${x}`);
    console.log("This pass's changes were refused, and nothing was committed.");
    process.exit(1);
  }
  console.log("This pass's changes are the kind a pass makes.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
