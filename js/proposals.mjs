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
import { verifyMembership, memberAddressForOwnerKey, canonicalAddress } from "./verify.mjs";
import { versionOf, hasSigned } from "./crowdlock.mjs";

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
export function proposalLine({ instance, destination, requiresMinor, currency, document, opens, closes, settlesBy, declarationVersion }) {
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
  // The version of the declaration the proposal is published under, if it is
  // a later one. A version-1 proposal's line has nothing added, so every
  // line written before versions existed keeps its hash.
  if (declarationVersion !== undefined && !(Number.isInteger(declarationVersion) && declarationVersion >= 1)) {
    throw new Error("declarationVersion, if given, must be a whole number from 1");
  }
  const tail = declarationVersion > 1 ? `|v${declarationVersion}` : "";
  return `${instance}|proposal|${destination}|${requiresMinor}|${currency}|${document}|${opens}|${closes}|${settlesBy}${tail}`;
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
    declarationVersion: p.declaration_version,
  };
}

/** The version of the declaration a proposal is published under: the founding one unless it names another. */
export function proposalVersion(p, crowdlock) {
  return Number.isInteger(p?.declaration_version) ? p.declaration_version : crowdlock.declaration.version;
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
    if (p.declaration_version !== undefined) {
      if (!versionOf(crowdlock, p.declaration_version)) return bad(`it names version ${p.declaration_version} of the declaration, which this Crowdlock does not publish`);
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

/**
 * A destination's stamp on the chain: what a payment's OP_RETURN output
 * carries to prove an entry, with its attestations, existed by the time of
 * the block it is in. spec/destinations-format.md, "The waiting period".
 * It covers the attestations as well as the entry, so nobody without an
 * attestor's key can stamp an entry ahead of time.
 */
export function stampLine(entry) {
  return [destinationHash(entry), ...(entry.attestations ?? []).map((a) => `${a.address}:${a.signature}`)].join("|");
}

export function stampHash(entry) {
  return hex(sha256(utf8(stampLine(entry))));
}

/** The stamp's output script, as hex: OP_RETURN, 32 bytes, the stamp hash. */
export function stampScript(entry) {
  return `6a20${stampHash(entry)}`;
}

/**
 * When an entry was stamped: the block time of its stamp payment, `tx` being
 * the explorer's description of it (/tx/<txid>). Returns { ok, at, reason }.
 */
export function stampedAt(entry, tx) {
  if (!HEX64.test(String(entry?.stamp ?? ""))) return { ok: false, at: null, reason: `entry ${entry?.index} has no stamp on the chain, so when it was published cannot be established` };
  if (!tx || tx.txid !== entry.stamp) return { ok: false, at: null, reason: `entry ${entry.index}'s stamp could not be read from the chain` };
  const want = stampScript(entry);
  if (!(tx.vout ?? []).some((o) => o?.scriptpubkey === want && Number(o?.value) === 0)) {
    return { ok: false, at: null, reason: `entry ${entry.index}'s stamp is a payment that does not carry this entry and its attestations` };
  }
  if (!tx.status?.confirmed || !Number.isInteger(tx.status.block_time)) return { ok: false, at: null, reason: `entry ${entry.index}'s stamp is not in a block yet` };
  return { ok: true, at: tx.status.block_time, reason: "" };
}

/**
 * The stamp payments a check of these addresses needs, read through
 * `getTx(txid)` (the explorer's /tx/<txid>), as { txid: tx }. One that can't
 * be read is null, and the check then refuses that destination.
 */
export async function stampsFor(entries, addresses, getTx) {
  const out = {};
  for (const address of addresses) {
    const added = (entries ?? []).filter((e) => canonicalAddress(e.address) === canonicalAddress(address) && e.op === "add").pop();
    const txid = added?.stamp;
    if (!HEX64.test(String(txid ?? "")) || txid in out) continue;
    try { out[txid] = await getTx(txid); } catch { out[txid] = null; }
  }
  return out;
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

export function chainIsIntact(entries, instance = null) {
  let expected = ZERO_PREV;
  // Given the Crowdlock's fingerprint, every entry must carry it; without
  // one, they must at least all carry the same.
  const wanted = instance ?? entries[0]?.instance;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.instance !== wanted) return { ok: false, reason: `entry ${e.index} belongs to a different instance` };
    if (e.index !== i + 1) return { ok: false, reason: `entry at position ${i} has index ${e.index}, expected ${i + 1}` };
    if (e.prev !== expected) return { ok: false, reason: `entry ${e.index} chains to ${String(e.prev).slice(0, 12)}…, expected ${expected.slice(0, 12)}…` };
    expected = destinationHash(e);
  }
  return { ok: true, reason: "" };
}

/**
 * The attestors a Crowdlock's destinations list must be signed by: the ones
 * the Crowdlock's own file names (attestor_keys), as addresses. Never the
 * `attestors` a destinations file lists for itself: a list must not be able
 * to appoint its own attestors, and the rule that an attestor is never a
 * co-signer is checked on the Crowdlock's file.
 */
export function attestorsOf(crowdlock, hrp = { mainnet: "bc", regtest: "bcrt" }[crowdlock?.network] ?? "tb") {
  return {
    attestors: (crowdlock?.attestor_keys ?? []).map((k) => memberAddressForOwnerKey(k, hrp)),
    threshold: crowdlock?.attestor_threshold,
    instance: crowdlock?.declaration?.sha256,
    hrp,
  };
}

export function destinationIsPermitted({ address, entries, opensAt, minimumAgeDays = 7, attestors = null, threshold = null, hrp = "bc", instance = null, stamps = {} }) {
  // The list must be this Crowdlock's own, and it must be checked for
  // attestation. Both used to be the caller's to remember (17 November 2026).
  if (!HEX64.test(String(instance ?? ""))) return { permitted: false, reason: "no Crowdlock fingerprint was supplied, so the list cannot be tied to this Crowdlock" };
  if (!Array.isArray(attestors) || !Number.isInteger(threshold)) return { permitted: false, reason: "no attestor set was supplied, so the list cannot be checked for attestation" };
  const chain = chainIsIntact(entries, instance);
  if (!chain.ok) return { permitted: false, reason: `the list itself is broken: ${chain.reason}` };
  const mine = entries.filter((e) => canonicalAddress(e.address) === canonicalAddress(address));
  const added = mine.filter((e) => e.op === "add").pop();
  if (!added) return { permitted: false, reason: "not on the published destinations list" };
  const revoked = mine.filter((e) => e.op === "revoke" && e.index > added.index).pop();
  if (revoked) return { permitted: false, reason: `revoked by entry ${revoked.index}` };
  const att = attestationsAreValid(added, { attestors, threshold, hrp });
  if (!att.ok) return { permitted: false, reason: att.reason };
  // Its age is counted from its stamp's block, which nobody can backdate.
  // Until 17 November 2026 it was counted from `firstSeen`, a date written
  // into the file by whoever added the entry.
  const stamped = stampedAt(added, stamps?.[added.stamp] ?? null);
  if (!stamped.ok) return { permitted: false, reason: stamped.reason };
  const opens = Date.parse(opensAt);
  if (Number.isNaN(opens)) return { permitted: false, reason: "the proposal's opening is not a readable date" };
  const ageDays = (opens - stamped.at * 1000) / 86_400_000;
  // A miner may set a block's time up to two hours ahead, so a stamp can look
  // younger than it is, never older. With no waiting period, being in a block
  // is enough (17 November 2026: a test destination was refused for five
  // minutes because its block's clock ran fast).
  if (minimumAgeDays > 0 && !(ageDays >= minimumAgeDays)) return { permitted: false, reason: `only ${ageDays.toFixed(1)} days old at the proposal's opening, needs ${minimumAgeDays}` };
  return { permitted: true, reason: "" };
}

/**
 * The next entry to add to a destinations list, unsigned. Its attestations
 * are added by the attestors, then it is stamped on the chain (`stamp`, the
 * stamp payment's txid). `at` is the time written as `added`.
 */
export function nextDestination(file, { address, text, now = new Date() }) {
  const entries = file?.entries ?? [];
  const at = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString().replace(".000Z", "Z");
  const entry = {
    instance: file.instance, index: entries.length + 1, op: "add", address: canonicalAddress(address), text: String(text).trim(),
    added: at, prev: entries.length ? destinationHash(entries[entries.length - 1]) : ZERO_PREV,
  };
  destinationLine(entry); // refuses a | or a newline
  return { entry, at };
}

// ---------------------------------------------------------------------------
// Commitments on the relays: the same Nostr kind as registrations and locks,
// tagged with the Crowdlock and the proposal so they can be collected.
// ---------------------------------------------------------------------------

export const PROPOSAL_TAG = "y";
const RECORD_KIND = 3713; // method/js/inbox.mjs

/** A commitment (the owner's half) or a completed one (the co-signer's), as a Nostr event template. */
export function commitmentEventTemplate({ type, proposal, record, tx, notice }, fingerprint, createdAt) {
  if (type !== "commitment" && type !== "completed" && type !== "notice") throw new Error("type must be commitment, completed or notice");
  if (!HEX64.test(proposal)) throw new Error("not a proposal's hash");
  return {
    kind: RECORD_KIND, created_at: createdAt,
    tags: [["x", fingerprint], [PROPOSAL_TAG, proposal], ["t", "crowdlock"]],
    content: JSON.stringify(type === "commitment" ? { crowdlock: fingerprint, type, proposal, record }
      : type === "completed" ? { crowdlock: fingerprint, type, proposal, tx }
      : { crowdlock: fingerprint, type, proposal, notice }),
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
  if (c.type === "notice" && typeof c.notice?.address === "string" && typeof c.notice?.signature === "string") {
    return { type: "notice", notice: { address: c.notice.address, signature: c.notice.signature }, at: event.created_at };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The pile, kept in the repository by the relay inbox (spec/proposal-and-
// settlement.md, "Where the pile lives"). The inbox records what arrived and
// when. Every reader — the app, the co-signer, the register page — checks
// every commitment in full before counting or completing it. What the inbox
// does refuse keeps the file honest and small: a commitment for a lock that
// is not on the register, one posted outside the proposal's gathering window,
// a malformed one, a copy of one already there, more than a handful per lock,
// and one the lock's owner has not signed.
//
// That last check is the caller's (`signed`, below), because a signature
// covers the amount of the coin it spends and so needs the chain. It is here
// because anybody can post to the relays: without it, five unsigned records
// naming somebody else's lock used up that lock's five places.
// ---------------------------------------------------------------------------

export const PER_LOCK_LIMIT = 5;

/**
 * How long after a proposal closes a commitment posted before the close may
 * still be taken, measured by when the repository (or a reader) first sees
 * it, not by the time its poster wrote on it, which anyone can set. Covers an
 * inbox that was briefly down. Until 17 November 2026 only the written time
 * was checked, so a commitment posted hours after closing and dated before
 * it was taken (OpenAI review, H-02).
 */
export const LATE_GRACE = 3600;

/** May a commitment still be taken into this proposal's pile at `nowSeconds`, whatever it says of itself? */
export function stillTakingCommitments(proposal, nowSeconds) {
  return nowSeconds < Date.parse(proposal.closes) / 1000 + LATE_GRACE;
}
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
/**
 * Take the commitments posted for one proposal into its pile.
 *
 *   signed: async (records) => [{ ok: true } | { ok: false, reason }], one
 *           answer per record in the same order: did the lock's owner sign
 *           it? It is only asked about records that passed every check
 *           above it, so strangers' junk costs the caller as little as
 *           possible. Required: a caller that leaves it out is refused.
 */
export async function applyCommitments(pile, events, { crowdlock, proposal, register, nowIso, signed, readTx = null }) {
  if (typeof signed !== "function") throw new Error("applyCommitments needs a check that each commitment is signed by its lock's owner");
  const fingerprint = crowdlock.declaration.sha256;
  const opens = Date.parse(proposal.opens) / 1000, closes = Date.parse(proposal.closes) / 1000;
  const settles = Date.parse(proposal.settles_by) / 1000;
  // `readTx(hex)` gives { txid, coin, hex } (method/relay/signed.mjs). With it,
  // copies are told apart by id rather than by text, one coin counts once, and
  // what is kept is the payment's standard encoding: the same payment written
  // another way is the same payment (second review, 17 November 2026).
  // Copies whose signatures are junk share an id with the real one, so the id
  // only rules out a record once one with that id has been taken.
  const keyOf = (tx) => (readTx ? readTx(tx)?.txid ?? tx : tx);
  const taken = new Set(pile.commitments.map((c) => keyOf(c.record.tx)));
  const known = new Set([...pile.commitments.map((c) => c.record.tx), ...taken]);
  const coins = new Set(readTx ? pile.commitments.map((c) => readTx(c.record.tx)?.coin).filter(Boolean) : []);
  const perLock = new Map();
  for (const c of pile.commitments) perLock.set(c.record.lock?.address, (perLock.get(c.record.lock?.address) ?? 0) + 1);
  const locks = new Map((register?.locks ?? []).map((l) => [l.address, l]));
  const outcome = [];
  const added = [];
  const sorted = [...events].sort((a, b) => a.created_at - b.created_at || String(a.id).localeCompare(String(b.id)));

  // First, everything that can be judged without the chain. (`at` keeps the
  // outcome in the order the records were posted, whichever step judged them.)
  const waiting = [];
  let at = 0;
  for (const e of sorted) {
    const item = commitmentFromEvent(e, fingerprint, proposal.hash);
    if (!item || item.type !== "commitment") continue;
    const r = item.record;
    if (typeof r.tx !== "string") continue;
    const key = r.tx;
    if (known.has(key) || taken.has(keyOf(r.tx))) continue; // already in the pile, or posted to two relays
    const lockAddress = r.lock?.address;
    const here = at++;
    const refuse = (reason) => { outcome.push({ at: here, added: false, lock: lockAddress, reason }); known.add(key); };
    if (r.tx.length > MAX_TX_HEX || !/^[0-9a-f]+$/.test(r.tx) || r.tx.length % 2) { refuse("its transaction is not hex of a sensible size"); continue; }
    const read = readTx ? readTx(r.tx) : null;
    if (readTx && !read) { refuse("its transaction cannot be read, or does not spend exactly one coin"); continue; }
    if (!(item.at >= opens && item.at < closes)) { refuse("it was posted outside the proposal's gathering window"); continue; }
    if (!stillTakingCommitments(proposal, Date.parse(nowIso) / 1000)) { refuse("the repository first saw it more than an hour after the proposal closed, whatever time it gives itself"); continue; }
    const onRegister = locks.get(lockAddress);
    if (!onRegister || onRegister.owner_pubkey !== r.lock.owner_pubkey || onRegister.cosigner_pubkey !== r.lock.cosigner_pubkey || onRegister.locktime !== r.lock.locktime) {
      refuse("its lock is not on this Crowdlock's register"); continue;
    }
    // Its lock must stay shut until settling ends, or its owner could take
    // the money home first. (Heights are for private test chains only.)
    if (onRegister.locktime >= 500000000 && !(onRegister.locktime > settles)) {
      refuse("its lock opens before this proposal's settling ends, so its money isn't committed"); continue;
    }
    // Committing needs the version the proposal was published under. A lock
    // still counts in the total whatever its owner has signed; only backing
    // this purchase needs their agreement to the text it was proposed under.
    const owner = (register?.members ?? []).find((m) => String(m.address).toLowerCase() === String(onRegister.member).toLowerCase());
    const needs = proposalVersion(proposal, crowdlock);
    if (!owner || !hasSigned(crowdlock, owner, needs)) {
      refuse(`its owner has not signed version ${needs} of the declaration, which this proposal was published under`); continue;
    }
    if ((perLock.get(lockAddress) ?? 0) >= PER_LOCK_LIMIT) { refuse(`that lock already has ${PER_LOCK_LIMIT} commitments in the pile`); continue; }
    known.add(key);
    waiting.push({ r: read ? { ...r, tx: read.hex } : r, id: read?.txid ?? r.tx, coin: read?.coin ?? null, lockAddress, member: onRegister.member, here });
  }

  // Then the owner's signature, for those still standing. Only a signed
  // commitment takes one of a lock's places, so nobody but the owner can use
  // them up.
  const verdicts = waiting.length ? await signed(waiting.map((w) => w.r)) : [];
  waiting.forEach(({ r, id, coin, lockAddress, member, here }, i) => {
    const v = verdicts[i];
    if (!v || v.ok !== true) { outcome.push({ at: here, added: false, lock: lockAddress, reason: v?.reason ?? "it could not be checked" }); return; }
    if (taken.has(id)) return; // the same payment, written another way
    taken.add(id);
    // One coin, one commitment: the earlier stands (spec/commitment-format.md).
    if (coin && coins.has(coin)) { outcome.push({ at: here, added: false, lock: lockAddress, reason: "an earlier commitment in the pile already spends that coin" }); return; }
    if (coin) coins.add(coin);
    if ((perLock.get(lockAddress) ?? 0) >= PER_LOCK_LIMIT) { outcome.push({ at: here, added: false, lock: lockAddress, reason: `that lock already has ${PER_LOCK_LIMIT} commitments in the pile` }); return; }
    perLock.set(lockAddress, (perLock.get(lockAddress) ?? 0) + 1);
    const entry = { submitted: nowIso, record: r };
    if (r.remainder === undefined) delete entry.record.remainder;
    added.push(entry);
    outcome.push({ at: here, added: true, lock: lockAddress, member });
  });
  outcome.sort((a, b) => a.at - b.at);
  for (const o of outcome) delete o.at;
  if (!added.length) return { pile, outcome };
  return { pile: { ...pile, commitments: [...pile.commitments, ...added] }, outcome };
}

// ---------------------------------------------------------------------------
// The co-signer's failure notice (spec: "Failure"). A signed statement that a
// proposal did not reach its target and that none of its commitments will be
// completed. Like the other signed sentences, the English is a protocol
// constant: it is rebuilt byte for byte to check the signature, so it must
// never be translated.
// ---------------------------------------------------------------------------

export function noticeStatement(hash) {
  if (!HEX64.test(hash)) throw new Error("not a proposal's hash");
  return `I declare proposal ${hash} dead: it did not reach its target, and I will complete none of its commitments.`;
}

/**
 * Is this a genuine notice for this proposal? It must be signed by the key
 * of one of the Crowdlock's co-signers (its native segwit address).
 * `addressOf(pubkey)` gives that address (memberAddressForOwnerKey in verify.mjs).
 */
export function noticeIsGenuine(notice, { crowdlock, hash, hrp, addressOf }) {
  const cosigners = new Set((crowdlock.cosigner_keys ?? []).map((k) => addressOf(k, hrp)));
  if (!cosigners.has(notice?.address)) return { ok: false, reason: "it is not signed by this Crowdlock's co-signer" };
  const r = verifyMembership({ address: notice.address, signature: notice.signature, message: noticeStatement(hash), hrp });
  return r.valid ? { ok: true, reason: "" } : { ok: false, reason: `its signature does not verify — ${r.reason}` };
}

/**
 * Record what the co-signer has done, in the pile: completed transactions
 * (published, so anyone can broadcast them) and a failure notice.
 *
 *   items     commitmentFromEvent results of type "completed" and "notice"
 *   txidOf    (hex) => the transaction's id, or null if it won't parse —
 *             injected, so this file needs no transaction library
 *
 *   completedBy  async ([{ tx, record }]) => [{ ok: true } | { ok: false, reason }]:
 *             is each of these the commitment `record`, signed by its
 *             lock's owner and by the co-signer? Required; the caller
 *             asks the chain (method/relay/signed.mjs).
 *
 * A completed transaction is recorded only if its id is the id of a
 * commitment already in the pile (the id leaves out the signatures, so a
 * completion and its commitment share it) and both signatures are on it:
 * nothing else can be smuggled in, and a fake cannot take the real one's place.
 * A notice is recorded once, if genuine; after it, no completion is recorded.
 */
export async function applySettlement(pile, items, { crowdlock, hash, hrp, addressOf, txidOf, nowIso, completedBy, canonical = (h) => h, closes = null }) {
  if (typeof completedBy !== "function") throw new Error("applySettlement needs a check that each completed payment is signed by the owner and the co-signer");
  // A completion is kept, and so sent, in its standard encoding (`canonical`):
  // a copy written another way has the same id, and the network refuses it.
  // Until 17 November 2026 such a copy, posted first, took the real one's place.
  items = items.map((it) => (it.type === "completed" ? { ...it, tx: canonical(it.tx) ?? it.tx } : it));
  const outcome = [];
  let next = pile;
  const ids = new Map();
  for (const c of pile.commitments) { const id = txidOf(c.record.tx); if (id) ids.set(id, c); }
  const done = new Set((pile.completed ?? []).map((c) => c.txid));
  const sorted = [...items].sort((a, b) => a.at - b.at);

  // A payment's id does not cover its signatures, so a copy of a commitment
  // with a made-up co-signer signature has the id of the real completion.
  // Each candidate is therefore checked: completedBy is asked, once, about
  // every "completed" record that matches a commitment not yet completed.
  //   completedBy: async ([{ tx, record }]) => [{ ok: true } | { ok: false, reason }]
  const candidates = [];
  const asked = new Set();
  for (const it of sorted) {
    if (it.type !== "completed" || asked.has(it.tx)) continue;
    const id = txidOf(it.tx);
    if (!id || done.has(id) || !ids.has(id)) continue;
    asked.add(it.tx);
    candidates.push({ tx: it.tx, record: ids.get(id).record });
  }
  const answers = candidates.length ? await completedBy(candidates) : [];
  const verdict = new Map(candidates.map((c, i) => [c.tx, answers[i]]));

  const judged = new Set();
  for (const it of sorted) {
    if (it.type === "notice") {
      if (next.notice) continue;
      // A proposal can only fail once gathering is over. Until 17 November
      // 2026 a genuine notice was taken while it was still gathering, and the
      // pile then said it had failed (OpenAI review, H-04).
      if (!(closes && Date.parse(nowIso) >= Date.parse(closes))) { outcome.push({ added: false, kind: "notice", reason: "the proposal has not closed yet, so it cannot have failed" }); continue; }
      const g = noticeIsGenuine(it.notice, { crowdlock, hash, hrp, addressOf });
      if (!g.ok) { outcome.push({ added: false, kind: "notice", reason: g.reason }); continue; }
      next = { ...next, notice: { ...it.notice, statement: noticeStatement(hash), published: nowIso } };
      outcome.push({ added: true, kind: "notice" });
    } else if (it.type === "completed") {
      const id = txidOf(it.tx);
      if (!id || done.has(id)) continue;
      if (!ids.has(id)) { outcome.push({ added: false, kind: "completed", reason: "it completes no commitment in the pile" }); continue; }
      if (judged.has(it.tx)) continue; // the same record, from a second relay
      judged.add(it.tx);
      const v = verdict.get(it.tx);
      // Not recorded, and its commitment stays open for the real completion.
      if (!v || v.ok !== true) { outcome.push({ added: false, kind: "completed", txid: id, reason: v?.reason ?? "it could not be checked" }); continue; }
      done.add(id);
      // A completion signed by both is recorded even after a notice: it is
      // evidence the co-signer went back on its word, and must not be hidden.
      const breach = !!next.notice;
      next = { ...next, completed: [...(next.completed ?? []), { txid: id, tx: it.tx, published: nowIso, ...(breach ? { after_notice: true } : {}) }] };
      outcome.push({ added: true, kind: "completed", txid: id, ...(breach ? { reason: "completed AFTER the co-signer declared this proposal dead" } : {}) });
    }
  }
  return { pile: next, outcome };
}

/**
 * Which completed transactions to send this pass: those not yet sent, in the
 * order their commitments were submitted, at most `limit` — so a large
 * settlement goes out a few at a time over many passes rather than all at
 * once (spec: "Pacing is not optional").
 */
export function dueToSend(pile, limit, txidOf) {
  const order = new Map(pile.commitments.map((c, i) => [txidOf(c.record.tx), i]));
  return (pile.completed ?? []).filter((c) => !c.sent)
    .sort((a, b) => (order.get(a.txid) ?? 1e9) - (order.get(b.txid) ?? 1e9))
    .slice(0, limit);
}
