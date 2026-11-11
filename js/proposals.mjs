// A Crowdlock's published proposals, as the app and the register page read
// them. Browser-safe (no Node), like the rest of method/js.
//
// The canonical proposal line and its hash are the reference code's in
// method/lock/commitment.mjs, which runs in Node. This file repeats the same
// rules so a phone and a browser can compute the same hash, and
// proposals.test.mjs holds the two to the same bytes. If they ever differ,
// commitment.mjs is right and this file is wrong.
//
// The file format is spec/proposal-and-settlement.md, "Publishing a proposal".

import { sha256 } from "./vendor/noble-hashes/sha256.js";
import { verifyMembership } from "./verify.mjs";

export const PROPOSALS_FORMAT = "crowdlock-proposals/1";
export const PILE_FORMAT = "crowdlock-commitments/1";

const HEX64 = /^[0-9a-f]{64}$/;
const DAY = 86400 * 1000;

function hex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

const utf8 = (s) => new TextEncoder().encode(String(s).normalize("NFC"));

/** The SHA-256 of a proposal's prose: its `document` field. */
export function documentHash(text) {
  return hex(sha256(utf8(text)));
}

/** The canonical line, exactly as method/lock/commitment.mjs builds it. */
export function proposalLine({ instance, destination, requiresMinor, currency, document, opens, closes, settlesBy }) {
  if (!HEX64.test(instance ?? "")) throw new Error("instance must be a 64-character hex declaration hash");
  if (!HEX64.test(document ?? "")) throw new Error("document must be the 64-character hex hash of the proposal's prose");
  if (!Number.isInteger(requiresMinor) || requiresMinor <= 0) {
    throw new Error("requires must be a positive whole number of the currency's minor units");
  }
  if (!/^[A-Z]{3}$/.test(currency ?? "")) {
    throw new Error("currency must be an ISO 4217 three-letter code in capitals, e.g. GBP");
  }
  for (const [name, v] of [["destination", destination], ["opens", opens], ["closes", closes], ["settlesBy", settlesBy]]) {
    if (typeof v !== "string" || !v) throw new Error(`${name} is required`);
    if (/[|\n\r]/.test(v)) throw new Error(`${name} may not contain | or a newline`);
  }
  if (!(Date.parse(opens) < Date.parse(closes))) throw new Error("closes must be after opens");
  if (!(Date.parse(closes) <= Date.parse(settlesBy))) throw new Error("settlesBy must be at or after closes");
  return `${instance}|proposal|${destination}|${requiresMinor}|${currency}|${document}|${opens}|${closes}|${settlesBy}`;
}

/** The hash a commitment names, and the only thing that identifies a proposal. */
export function proposalHash(fields) {
  return hex(sha256(utf8(proposalLine(fields))));
}

/** A published proposal's fields, in the shape proposalLine takes. */
export function fieldsOf(p, instance) {
  return {
    instance, destination: p.destination, requiresMinor: p.requires, currency: p.currency,
    document: documentHash(p.text ?? ""), opens: p.opens, closes: p.closes, settlesBy: p.settles_by,
  };
}

const isoZ = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) && !Number.isNaN(Date.parse(v));

/**
 * Check a proposals file against its Crowdlock. Every proposal's hash is
 * recomputed from its own fields and prose, so a file cannot name one
 * proposal and describe another. Whether its destination is attested and old
 * enough is the destinations list's question, checked when committing.
 *
 * @returns {{ ok: boolean, problems: string[], proposals: any[] }}
 */
export function checkProposals(file, crowdlock) {
  const problems = [];
  const instance = crowdlock?.declaration?.sha256;
  if (file?.format !== PROPOSALS_FORMAT) problems.push(`the proposals file is not ${PROPOSALS_FORMAT}`);
  if (file?.instance !== instance) problems.push("the proposals file belongs to a different Crowdlock");
  const list = Array.isArray(file?.proposals) ? file.proposals : (problems.push("proposals must be a list"), []);
  const seen = new Set();
  const good = [];
  list.forEach((p, i) => {
    const where = `proposal ${i + 1}`;
    const bad = (why) => problems.push(`${where}: ${why}`);
    if (typeof p?.title !== "string" || !p.title.trim()) return bad("it has no title");
    if (typeof p.text !== "string" || !p.text.trim()) return bad("it has no text");
    for (const k of ["opens", "closes", "settles_by"]) {
      if (!isoZ(p[k])) return bad(`${k} must be a UTC time like 2026-12-01T00:00:00Z`);
    }
    let hash;
    try { hash = proposalHash(fieldsOf(p, instance)); } catch (e) { return bad(e.message); }
    if (p.hash !== hash) return bad("its hash is not the hash of its own fields and text");
    if (seen.has(hash)) return bad("it is listed twice");
    const gathering = (Date.parse(p.closes) - Date.parse(p.opens)) / DAY;
    const settling = (Date.parse(p.settles_by) - Date.parse(p.closes)) / DAY;
    if (gathering > crowdlock.gathering_window_max_days) return bad(`it gathers for longer than ${crowdlock.gathering_window_max_days} days`);
    if (settling > crowdlock.settlement_window_max_days) return bad(`it settles for longer than ${crowdlock.settlement_window_max_days} days`);
    const t = p.target;
    if (!t || !Number.isInteger(t.sats) || t.sats <= 0 || typeof t.rate !== "string" || !isoZ(t.at)) {
      return bad("its target must give whole sats, the rate used and when");
    }
    seen.add(hash);
    good.push({ ...p, hash });
  });
  return { ok: problems.length === 0, problems, proposals: good };
}

/**
 * Where a proposal is in its life, at `now` (ms).
 * "soon" — not open yet; "gathering" — commitments may be added;
 * "settling" — closed for new commitments, the co-signer may complete them;
 * "over" — past settles_by: nothing more can happen.
 */
export function phaseOf(p, now = Date.now()) {
  if (now < Date.parse(p.opens)) return "soon";
  if (now < Date.parse(p.closes)) return "gathering";
  if (now <= Date.parse(p.settles_by)) return "settling";
  return "over";
}

/** Where a proposal's pile is published: beside the proposals file. */
export function pilePath(proposalsPath, hash) {
  if (!HEX64.test(hash)) throw new Error("not a proposal's hash");
  const dir = proposalsPath.includes("/") ? proposalsPath.slice(0, proposalsPath.lastIndexOf("/") + 1) : "";
  return `${dir}commitments/${hash}.json`;
}

/** The shape of a pile file, before each commitment in it is verified. */
export function checkPileShape(file, hash) {
  if (file?.format !== PILE_FORMAT) return { ok: false, reason: `the pile is not ${PILE_FORMAT}` };
  if (file.proposal !== hash) return { ok: false, reason: "the pile is for a different proposal" };
  if (!Array.isArray(file.commitments)) return { ok: false, reason: "commitments must be a list" };
  for (const [i, c] of file.commitments.entries()) {
    if (!isoZ(c?.submitted) || typeof c?.record?.tx !== "string" || c.record.proposal !== hash) {
      return { ok: false, reason: `commitment ${i + 1} is not in the pile's format` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The destinations list, browser-safe. The same rules as method/lock/
// commitment.mjs (destinationLine … destinationIsPermitted), held to the same
// results by proposals.test.mjs. spec/destinations-format.md.
// ---------------------------------------------------------------------------


export const ZERO_PREV = "0".repeat(64);

export function destinationLine({ instance, index, op, address, text, added, prev }) {
  if (!HEX64.test(instance ?? "")) throw new Error("instance must be a 64-character hex declaration hash");
  for (const [name, v] of [["text", text], ["address", address]]) {
    if (/[|\n\r]/.test(v)) throw new Error(`${name} may not contain | or a newline`);
  }
  return `${instance}|${index}|${op}|${address}|${text}|${added}|${prev}`;
}

export function destinationHash(entry) {
  return hex(sha256(utf8(destinationLine(entry))));
}

export function attestationStatement(entry) {
  return `I attest destination entry ${entry.index} (sha256:${destinationHash(entry)}).`;
}

export function attestationsAreValid(entry, { attestors = [], threshold = 1, hrp = "bc" } = {}) {
  if (!Number.isInteger(threshold) || threshold < 1) return { ok: false, reason: "the threshold must be a positive whole number", signers: [] };
  if (attestors.length < threshold) return { ok: false, reason: `the list names ${attestors.length} attestor(s) but requires ${threshold}`, signers: [] };
  const statement = attestationStatement(entry);
  const permitted = new Set(attestors);
  const signers = new Set();
  for (const a of entry.attestations ?? []) {
    const address = String(a?.address ?? "").trim();
    if (!permitted.has(address)) return { ok: false, reason: `entry ${entry.index} is attested by ${address || "nobody"}, who is not a listed attestor`, signers: [...signers] };
    const r = verifyMembership({ address, signature: String(a?.signature ?? ""), message: statement, hrp });
    if (!r.valid) return { ok: false, reason: `entry ${entry.index}: ${address}'s attestation does not verify — ${r.reason}`, signers: [...signers] };
    signers.add(address);
  }
  if (signers.size < threshold) return { ok: false, reason: `entry ${entry.index} has ${signers.size} valid attestation(s) from distinct attestors, needs ${threshold}`, signers: [...signers] };
  return { ok: true, reason: "", signers: [...signers] };
}

export function chainIsIntact(entries) {
  let expected = ZERO_PREV;
  const instance = entries[0]?.instance;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.instance !== instance) return { ok: false, reason: `entry ${e.index} belongs to a different instance` };
    if (e.index !== i + 1) return { ok: false, reason: `entry at position ${i} has index ${e.index}, expected ${i + 1}` };
    if (e.prev !== expected) return { ok: false, reason: `entry ${e.index} chains to ${String(e.prev).slice(0, 12)}…, expected ${expected.slice(0, 12)}…` };
    expected = destinationHash(e);
  }
  return { ok: true, reason: "" };
}

export function destinationIsPermitted({ address, entries, opensAt, minimumAgeDays = 7, attestors = null, threshold = null, hrp = "bc" }) {
  const chain = chainIsIntact(entries);
  if (!chain.ok) return { permitted: false, reason: `the list itself is broken: ${chain.reason}` };
  const mine = entries.filter((e) => e.address === address);
  const added = mine.filter((e) => e.op === "add").pop();
  if (!added) return { permitted: false, reason: "not on the published destinations list" };
  const revoked = mine.filter((e) => e.op === "revoke" && e.index > added.index).pop();
  if (revoked) return { permitted: false, reason: `revoked by entry ${revoked.index}` };
  if (attestors !== null || threshold !== null) {
    const att = attestationsAreValid(added, { attestors: attestors ?? [], threshold: threshold ?? 1, hrp });
    if (!att.ok) return { permitted: false, reason: att.reason };
  }
  if (!added.firstSeen) return { permitted: false, reason: `entry ${added.index} has no recorded first public appearance, so its age cannot be established` };
  const seen = Date.parse(added.firstSeen), opens = Date.parse(opensAt);
  if (Number.isNaN(seen) || Number.isNaN(opens)) return { permitted: false, reason: "the entry's first appearance or the proposal's opening is not a readable date" };
  const ageDays = (opens - seen) / 86_400_000;
  if (!(ageDays >= minimumAgeDays)) return { permitted: false, reason: `only ${ageDays.toFixed(1)} days old at the proposal's opening, needs ${minimumAgeDays}` };
  return { permitted: true, reason: "" };
}

/**
 * The next entry to add to a destinations list, unsigned. Its attestations
 * are added by the attestors; `firstSeen` is when it is first published.
 */
export function nextDestination(file, { address, text, now = new Date() }) {
  const entries = file?.entries ?? [];
  const at = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString().replace(".000Z", "Z");
  const entry = {
    instance: file.instance, index: entries.length + 1, op: "add", address: String(address).trim(), text: String(text).trim(),
    added: at, prev: entries.length ? destinationHash(entries[entries.length - 1]) : ZERO_PREV,
  };
  destinationLine(entry); // refuses a | or a newline
  return { entry, firstSeen: at };
}

// ---------------------------------------------------------------------------
// Commitments on the relays: the same Nostr kind as registrations and locks,
// tagged with the Crowdlock and the proposal so they can be collected.
// ---------------------------------------------------------------------------

export const PROPOSAL_TAG = "y";
const RECORD_KIND = 3713; // method/js/inbox.mjs

/** A commitment (the owner's half) or a completed one (the co-signer's), as a Nostr event template. */
export function commitmentEventTemplate({ type, proposal, record, tx }, fingerprint, createdAt) {
  if (type !== "commitment" && type !== "completed") throw new Error("type must be commitment or completed");
  if (!HEX64.test(proposal)) throw new Error("not a proposal's hash");
  return {
    kind: RECORD_KIND, created_at: createdAt,
    tags: [["x", fingerprint], [PROPOSAL_TAG, proposal], ["t", "crowdlock"]],
    content: JSON.stringify(type === "commitment" ? { crowdlock: fingerprint, type, proposal, record } : { crowdlock: fingerprint, type, proposal, tx }),
  };
}

/** Read one back, or null. Says nothing about whether it is valid. */
export function commitmentFromEvent(event, fingerprint, proposal) {
  if (!event || event.kind !== RECORD_KIND || typeof event.content !== "string" || event.content.length > 8000) return null;
  const tags = Array.isArray(event.tags) ? event.tags : [];
  if (!tags.some((t) => t[0] === "x" && t[1] === fingerprint) || !tags.some((t) => t[0] === PROPOSAL_TAG && t[1] === proposal)) return null;
  let c;
  try { c = JSON.parse(event.content); } catch { return null; }
  if (!c || c.crowdlock !== fingerprint || c.proposal !== proposal) return null;
  if (c.type === "commitment" && c.record?.proposal === proposal && typeof c.record?.tx === "string") return { type: "commitment", record: c.record, at: event.created_at };
  if (c.type === "completed" && typeof c.tx === "string" && /^[0-9a-f]+$/.test(c.tx)) return { type: "completed", tx: c.tx, at: event.created_at };
  return null;
}

// ---------------------------------------------------------------------------
// The pile, kept in the repository by the relay inbox (spec/proposal-and-
// settlement.md, "Where the pile lives"). The inbox records what arrived and
// when; it does not judge signatures or coins, which change and need the
// chain. Every reader — the app, the co-signer, the register page — checks
// every commitment in full before counting or completing it. What the inbox
// does refuse keeps the file honest and small: a commitment for a lock that
// is not on the register, one posted outside the proposal's gathering window,
// a malformed one, a copy of one already there, and more than a handful per
// lock.
// ---------------------------------------------------------------------------

export const PER_LOCK_LIMIT = 5;
const MAX_TX_HEX = 4000;

/** A new, empty pile for a proposal. */
export function emptyPile(hash) {
  return { format: PILE_FORMAT, proposal: hash, commitments: [] };
}

/**
 * Add the commitments found in relay events to a proposal's pile.
 *
 *   pile       the pile file as it stands (or emptyPile(hash))
 *   events     Nostr events from the Crowdlock's relays, any order
 *   crowdlock  the parsed Crowdlock file
 *   proposal   a checked proposal (checkProposals)
 *   register   the Crowdlock's register, for its locks
 *   nowIso     when this run is, as "YYYY-MM-DDTHH:MM:SSZ": the time recorded
 *              as `submitted`. The repository's own clock decides the order,
 *              not the time a poster wrote on the event, which anyone can set.
 *
 * Returns { pile, outcome }; the pile is the same object if nothing was added.
 */
export function applyCommitments(pile, events, { crowdlock, proposal, register, nowIso }) {
  const fingerprint = crowdlock.declaration.sha256;
  const opens = Date.parse(proposal.opens) / 1000, closes = Date.parse(proposal.closes) / 1000;
  const known = new Set(pile.commitments.map((c) => c.record.tx));
  const perLock = new Map();
  for (const c of pile.commitments) perLock.set(c.record.lock?.address, (perLock.get(c.record.lock?.address) ?? 0) + 1);
  const locks = new Map((register?.locks ?? []).map((l) => [l.address, l]));
  const outcome = [];
  const added = [];
  const sorted = [...events].sort((a, b) => a.created_at - b.created_at || String(a.id).localeCompare(String(b.id)));
  for (const e of sorted) {
    const item = commitmentFromEvent(e, fingerprint, proposal.hash);
    if (!item || item.type !== "commitment") continue;
    const r = item.record;
    if (known.has(r.tx)) continue; // already in the pile, or posted to two relays
    const lockAddress = r.lock?.address;
    const refuse = (reason) => { outcome.push({ added: false, lock: lockAddress, reason }); known.add(r.tx); };
    if (typeof r.tx !== "string" || r.tx.length > MAX_TX_HEX || !/^[0-9a-f]+$/.test(r.tx) || r.tx.length % 2) { refuse("its transaction is not hex of a sensible size"); continue; }
    if (!(item.at >= opens && item.at < closes)) { refuse("it was posted outside the proposal's gathering window"); continue; }
    const onRegister = locks.get(lockAddress);
    if (!onRegister || onRegister.owner_pubkey !== r.lock.owner_pubkey || onRegister.cosigner_pubkey !== r.lock.cosigner_pubkey || onRegister.locktime !== r.lock.locktime) {
      refuse("its lock is not on this Crowdlock's register"); continue;
    }
    if ((perLock.get(lockAddress) ?? 0) >= PER_LOCK_LIMIT) { refuse(`that lock already has ${PER_LOCK_LIMIT} commitments in the pile`); continue; }
    perLock.set(lockAddress, (perLock.get(lockAddress) ?? 0) + 1);
    known.add(r.tx);
    const entry = { submitted: nowIso, record: r };
    if (r.remainder === undefined) delete entry.record.remainder;
    added.push(entry);
    outcome.push({ added: true, lock: lockAddress, member: onRegister.member });
  }
  if (!added.length) return { pile, outcome };
  return { pile: { ...pile, commitments: [...pile.commitments, ...added] }, outcome };
}
