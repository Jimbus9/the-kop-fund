// Early releases: the one thing a co-signer can do that the counting rule
// cannot stop, made impossible to hide.
//
// A lock opens two ways: the owner alone once its date has passed, or the
// owner and the co-signer together at any time. The second is meant for
// purchases, but nothing in Bitcoin enforces that — a co-signer willing to
// sign anything can let a member take a counted lock back early, which would
// make every committed figure worthless. What Bitcoin does give us is a public
// record of which way every lock was opened. This module reads it.
//
// The witness says which way. The lock's script is
//   <owner> CHECKSIGVERIFY IF <date> CHECKLOCKTIMEVERIFY ELSE <co-signer> CHECKSIG ENDIF
// so a spend on its date carries   [01, owner signature, script]
// and a co-signed spend carries    [co-signer signature, (empty), owner signature, script].
// Nobody can dress one up as the other: the script refuses any other shape.
//
// Works on the transaction JSON an Esplora-style explorer returns for
// /address/<lock>/txs, so the register page and the app read it the same way.

import { lockIsGenuine, hrpFor, lockAddress } from "./lockrecord.mjs";
import { sha256 } from "./vendor/noble-hashes/sha256.js";
import { chainIsIntact, attestationsAreValid, stampedAt, attestorsOf } from "./proposals.mjs";
import { canonicalAddress } from "./verify.mjs";

/**
 * Was this input opened with the co-signer's signature, in the standard shape?
 * A label only. earlyReleases does not rely on it: before a lock's date the
 * owner alone cannot open it at all, so every spend before the date was
 * co-signed, whatever its witness looks like (a branch selector of 00 rather
 * than empty, say, which Bitcoin's rules accept in a block).
 */
export function isCoSigned(vin) {
  const w = vin?.witness;
  return Array.isArray(w) && w.length === 4 && w[1] === "";
}

/**
 * Was this address a destination the co-signer could pay at time `at`
 * (seconds)? The same checks a commitment gets before it is completed: the
 * list is this Crowdlock's and its chain is intact, the entry is attested by
 * the attestors the Crowdlock's own file names, it is stamped on the chain,
 * and it had waited out the Crowdlock's waiting period by `at`. Not revoked.
 *
 *   context  { crowdlock, stamps, at, hrp }: `stamps` the stamp payments as
 *            the explorer describes them, { txid: tx } (stampsFor in
 *            proposals.mjs). Without the Crowdlock's file nothing is listed.
 *
 * An `add` line alone is not enough: one unattested line would make a
 * release read as a purchase.
 */
export function isListedDestination(address, destinations, { crowdlock = null, stamps = {}, at = Infinity, hrp } = {}) {
  const entries = Array.isArray(destinations?.entries) ? destinations.entries : [];
  if (!crowdlock || !entries.length) return false;
  const rules = attestorsOf(crowdlock, hrp ?? undefined);
  if (!/^[0-9a-f]{64}$/.test(String(rules.instance ?? "")) || !Number.isInteger(rules.threshold)) return false;
  if (!chainIsIntact(entries, rules.instance).ok) return false;
  const mine = entries.filter((e) => canonicalAddress(e.address) === canonicalAddress(address));
  const added = mine.filter((e) => e.op === "add").pop();
  if (!added) return false;
  // A revocation stops payments from when it was published. One stamped on
  // the chain after this spend doesn't make a payment made before it a
  // release. One with no readable stamp counts from the start: when it was
  // made can't be shown.
  if (mine.some((e) => {
    if (e.op !== "revoke" || !(e.index > added.index)) return false;
    const s = stampedAt(e, stamps?.[e.stamp] ?? null);
    return !s.ok || s.at <= at;
  })) return false;
  if (!attestationsAreValid(added, { attestors: rules.attestors, threshold: rules.threshold, hrp: rules.hrp }).ok) return false;
  const stamped = stampedAt(added, stamps?.[added.stamp] ?? null);
  if (!stamped.ok) return false;
  const wait = Number.isInteger(crowdlock.destination_wait_days) ? crowdlock.destination_wait_days : 0;
  return at - stamped.at >= wait * 86400;
}

/**
 * Does money paid to this address stay locked? True if it is the same lock
 * (the remainder of a part-commitment, as the app makes it), or a genuine lock
 * of the same owner on the register with no earlier date, whose own history
 * the record also reads. A lock off the register doesn't count: money could
 * hop into a lock nobody watches and leave it unseen.
 */
export function staysLocked(address, lock, { crowdlock, register, hrp }) {
  const a = String(address ?? "").toLowerCase();
  if (!a || !lock?.owner_pubkey) return false;
  const own = String(lock.cosigner_pubkey ?? "").toLowerCase();
  if (a === String(lock.address ?? "").toLowerCase() && (crowdlock?.cosigner_keys ?? []).some((k) => String(k).toLowerCase() === own)) return true;
  return (register?.locks ?? []).some((r) => String(r.address).toLowerCase() === a
    && r.owner_pubkey === lock.owner_pubkey && r.locktime >= lock.locktime
    && lockIsGenuine(r, { crowdlock, register, hrp }).ok);
}

/** A commitment's proposal marker: OP_RETURN and 32 bytes, holding nothing. Nothing else counts. */
function holdsNothing(o) {
  return /^6a20[0-9a-f]{64}$/.test(String(o?.scriptpubkey ?? "")) && Number(o?.value) === 0;
}

// ---------------------------------------------------------------------------
// When was a spend early? Bitcoin lets the owner alone open a lock only once
// the median time of the eleven blocks BEFORE the spending block is past the
// lock's date (BIP 113), not when the spending block's own timestamp is. A
// miner chooses that timestamp, up to about two hours ahead, so a co-signed
// spend in a block stamped just after the date may still have been early.
// Spends whose block is stamped before the date are early whatever the
// clock; those stamped within CLOCK_WINDOW after it need the network's clock,
// read with clocksFor; beyond that they are not early.
// ---------------------------------------------------------------------------

/** How long after a lock's date a spend's block timestamp leaves its earliness in doubt. */
export const CLOCK_WINDOW = 7 * 86400;

/** Does this confirmed spend of the lock need the network's clock to decide whether it was early? */
export function needsClock(lock, tx) {
  if (!tx?.status?.confirmed || !Number.isInteger(tx.status.block_time)) return false;
  const address = String(lock.address).toLowerCase();
  if (!(tx.vin ?? []).some((v) => String(v.prevout?.scriptpubkey_address ?? "").toLowerCase() === address)) return false;
  const after = tx.status.block_time - lock.locktime;
  return after >= 0 && after < CLOCK_WINDOW;
}

/**
 * The network's clock for each block that needs it: { block_hash: median
 * time of the blocks before it }. `getBlock(hash)` is the explorer's
 * /block/<hash> (it gives `previousblockhash` and `mediantime`). A block that
 * can't be read is left out, and its spend is reported as undecided.
 */
export async function clocksFor(lock, txs, getBlock) {
  const out = {};
  for (const tx of Array.isArray(txs) ? txs : []) {
    if (!needsClock(lock, tx)) continue;
    const hash = tx.status.block_hash;
    if (!hash || hash in out) continue;
    try {
      const prev = (await getBlock(hash))?.previousblockhash;
      const mtp = prev ? (await getBlock(prev))?.mediantime : undefined;
      if (Number.isInteger(mtp)) out[hash] = mtp;
    } catch { /* left out: undecided */ }
  }
  return out;
}

/**
 * Every time the co-signer helped open this lock before its date, other than
 * for a purchase.
 *   lock     { address, locktime, owner_pubkey, cosigner_pubkey? }
 *   txs      the explorer's transactions for the lock's address: the whole
 *            history (readHistory), or a release can be pushed out of sight
 *   context  { destinations, crowdlock, register, stamps, clocks } — the
 *            Crowdlock's destinations file, its own file, its register, the
 *            destinations' stamp payments (stampsFor in proposals.mjs), and
 *            the network's clock for blocks stamped just after the date
 *            (clocksFor). A spend whose earliness can't be decided without a
 *            clock that is missing is returned with `undecided: true`: the
 *            caller says the lock could not be checked, never "no releases".
 *   now      seconds; used for a spend not yet in a block
 * Returns [{ txid, at, sats, paidTo, confirmed, cosigner }]. A spend after the
 * date is left out: the owner could have done that alone.
 *
 * Any spend before the date is co-signed: the owner alone cannot open a lock
 * until then, so the witness's shape is not asked about. It is a purchase only
 * if EVERY output is one of: a destination the co-signer could pay at that
 * moment (isListedDestination); money staying locked (staysLocked); or one
 * proposal marker holding nothing, which a payment to a destination must have
 * and a move that pays none must not; AND what it leaves as fee is small:
 *   - where it pays a destination, no more than a commitment may leave: the
 *     Crowdlock's max_commitment_fee of what it pays the destination;
 *   - where it pays none (all of it stays locked), no more than
 *     max_commitment_fee of what leaves this lock, COUNTING the fees of every
 *     earlier such move out of it, and into it from the same owner's other
 *     locks: measured one at a time, a lock could be emptied as fees a slice
 *     at a time, each slice going "back into the same lock".
 * `paidTo` is the first output that is none of these, or null when the money
 * went as fee.
 */
export function earlyReleases(lock, txs, context = {}, now = Math.floor(Date.now() / 1000)) {
  const { destinations = null, crowdlock = null, register = null, stamps = {}, clocks = {} } = context ?? {};
  const hrp = context?.hrp ?? hrpFor(crowdlock?.network) ?? "bc";
  const maxFee = typeof crowdlock?.max_commitment_fee === "number" ? Math.min(crowdlock.max_commitment_fee, 0.05) : 0.01;
  const address = String(lock.address).toLowerCase();
  const found = [];
  // Oldest first, so the fees of moves that pay no destination add up in the
  // order they were made. (An explorer lists the newest first.)
  const when = (tx) => (tx?.status?.confirmed ? tx.status.block_time : now);
  const inOrder = (Array.isArray(txs) ? txs : []).map((tx, i) => ({ tx, i })).sort((a, b) => when(a.tx) - when(b.tx) || b.i - a.i).map((x) => x.tx);
  let movedAsFees = 0;
  for (const tx of inOrder) {
    const at = tx.status?.confirmed ? tx.status.block_time : now;
    const accounted = (o) => holdsNothing(o)
      || (!!o?.scriptpubkey_address && isListedDestination(o.scriptpubkey_address, destinations, { crowdlock, stamps, at, hrp }))
      || staysLocked(o?.scriptpubkey_address, lock, { crowdlock, register, hrp });
    const ins = Array.isArray(tx.vin) ? tx.vin : [];
    const outs = Array.isArray(tx.vout) ? tx.vout : [];
    const spent = ins.reduce((n, v) => n + (Number(v?.prevout?.value) || 0), 0);
    // What came out of this lock itself: the base fees are judged against,
    // so coins added from outside don't make a bigger allowance.
    const fromHere = ins.reduce((n, v) => n + (String(v?.prevout?.scriptpubkey_address ?? "").toLowerCase() === address ? (Number(v?.prevout?.value) || 0) : 0), 0);
    const paid = outs.reduce((n, o) => n + (Number(o?.value) || 0), 0);
    const markers = outs.filter(holdsNothing).length;
    // What it pays destinations the co-signer could pay at that moment.
    const toDestinations = outs.reduce((n, o) => n + (o?.scriptpubkey_address && isListedDestination(o.scriptpubkey_address, destinations, { crowdlock, stamps, at, hrp }) ? (Number(o?.value) || 0) : 0), 0);
    // A move into this lock from another of the same owner's locks, paying no
    // destination: its fee counts here too, so money passed between two
    // locks can't spend a fresh allowance in each.
    if (toDestinations === 0 && !ins.some((v) => String(v?.prevout?.scriptpubkey_address ?? "").toLowerCase() === address)
      && outs.some((o) => String(o?.scriptpubkey_address ?? "").toLowerCase() === address)
      && ins.length > 0 && ins.every((v) => staysLocked(v?.prevout?.scriptpubkey_address, { ...lock, locktime: 0 }, { crowdlock, register, hrp }))) {
      movedAsFees += Math.max(0, spent - paid);
    }
    for (const vin of ins) {
      if (String(vin.prevout?.scriptpubkey_address ?? "").toLowerCase() !== address) continue;
      // Early if the network's clock had not passed the date. Before it in the
      // block's own time means early for certain; just after it, ask the clock.
      let undecided = false;
      if (!(at < lock.locktime)) {
        if (!needsClock(lock, tx)) continue;
        const mtp = clocks?.[tx.status.block_hash];
        if (Number.isInteger(mtp)) { if (mtp > lock.locktime) continue; }
        else undecided = true;
      }
      const stray = outs.find((o) => !accounted(o));
      const fee = spent - paid;
      let feeTooBig;
      if (toDestinations > 0) feeTooBig = fee > toDestinations * maxFee;
      else { movedAsFees += Math.max(0, fee); feeTooBig = movedAsFees > fromHere * maxFee; }
      // A payment to a destination is a commitment completed, and every
      // commitment names its proposal in exactly one marker; a move that only
      // keeps the money locked names none.
      const markersRight = toDestinations > 0 ? markers === 1 : markers === 0;
      if (outs.length > 0 && !stray && !feeTooBig && markersRight && paid > 0) continue;
      found.push({
        txid: tx.txid, at, sats: vin.prevout?.value ?? 0, paidTo: stray?.scriptpubkey_address ?? null,
        confirmed: !!tx.status?.confirmed, cosigner: lock.cosigner_pubkey ?? null, ...(undecided ? { undecided: true } : {}),
      });
    }
  }
  return found;
}

/** An Esplora explorer's page of confirmed history holds this many. */
export const PAGE = 25;
/** Read at most this many pages of one lock's history (1,000 payments). */
export const MOST_PAGES = 40;

/**
 * A lock's whole history, not just its newest page. Esplora answers
 * /address/<a>/txs with what is waiting (up to 50) and the newest 25
 * confirmed; /address/<a>/txs/chain/<last txid> gives the next 25. Reading
 * only the first, 25 small payments to a lock's address would push an
 * earlier release out of sight.
 *
 *   first()      the first page
 *   after(txid)  the next page of confirmed history after this transaction
 *
 * Returns { txs, complete }. `complete` is false when there was more than
 * could be read: a history longer than MOST_PAGES pages, or 50 waiting.
 * A caller says so rather than "no early releases".
 */
export async function readHistory(first, after, { mostPages = MOST_PAGES } = {}) {
  const page = await first();
  const list = Array.isArray(page) ? page : [];
  const txs = [...list];
  const seen = new Set(list.map((t) => t.txid));
  let complete = list.filter((t) => !t.status?.confirmed).length < 50;
  let confirmed = list.filter((t) => t.status?.confirmed);
  for (let pages = 1; confirmed.length >= PAGE; pages++) {
    if (pages >= mostPages) { complete = false; break; }
    const next = await after(confirmed[confirmed.length - 1].txid);
    confirmed = (Array.isArray(next) ? next : []).filter((t) => t.status?.confirmed && !seen.has(t.txid));
    for (const t of confirmed) { seen.add(t.txid); txs.push(t); }
  }
  return { txs, complete };
}

// ---------------------------------------------------------------------------
// Locks a reader has seen on a register.
//
// The record above is read from the chain, but WHICH locks it is read for
// came from the register, which is a file its founder can write, and today
// the founder is the co-signer. Taking a lock's record off the register, or
// bending one digit of its date so it no longer reads as a lock, would take
// its early release off the record too. So a reader (the app on a phone, the register page in a
// browser) keeps what it has seen:
//
//   - the terms of the locks, up to LOCKS_REMEMBERED of them, so one that
//     goes is still checked by name; and
//   - how many locks there were and a running fingerprint of all of them in
//     the register's order, so that ANY earlier record removed or changed
//     shows, however long the register has grown. (Terms alone are
//     capped, so 500 newer records could push an older lock out of memory
//     while it was still listed.) A register only ever grows at its end, like the destinations
//     list; anything else is a rewrite, and a rewrite is never forgotten.
// ---------------------------------------------------------------------------

const TERMS_KEY = /^0[23][0-9a-f]{64}$/;
const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** A running fingerprint of the first `n` locks, in order: each link covers the one before and a lock's terms. */
function chainOf(locks, n) {
  let h = "";
  for (let i = 0; i < n; i++) {
    const l = locks[i];
    h = hexOf(sha256(new TextEncoder().encode(`${h}|${l.owner_pubkey}|${l.cosigner_pubkey}|${l.locktime}`)));
  }
  return h;
}

/**
 * The locks to read the co-signer's record for: every genuine lock on the
 * register now, and every lock this reader saw there before that is no
 * longer on it as it was (`gone`). A remembered lock is believed only for
 * what its terms make: its address is worked out here, never stored.
 *
 *   remembered  what locksSeen returned last time: { locks, count, chain,
 *               rewritten? } (a plain list of terms, the older form, is read
 *               as its `locks`)
 * Returns { locks, gone, rewritten }. Each lock in `gone` carries
 * `removed: true`. `rewritten` is true when the locks this reader saw before
 * are not all still there, in the same order, with the same terms, whether
 * or not it can still say which: a caller then says the record cannot be
 * called clean.
 */
export function locksToWatch({ crowdlock, register, remembered = null, hrp = hrpFor(crowdlock?.network) }) {
  const mem = Array.isArray(remembered) ? { locks: remembered } : (remembered && typeof remembered === "object" ? remembered : {});
  const now = new Map();
  for (const lock of register?.locks ?? []) {
    const address = String(lock?.address ?? "").toLowerCase();
    if (now.has(address) || !lockIsGenuine(lock, { crowdlock, register, hrp }).ok) continue;
    now.set(address, lock);
  }
  const current = [...now.values()];
  const gone = new Map();
  for (const r of Array.isArray(mem.locks) ? mem.locks : []) {
    if (!r || typeof r !== "object" || !TERMS_KEY.test(String(r.owner_pubkey)) || !TERMS_KEY.test(String(r.cosigner_pubkey)) || !Number.isInteger(r.locktime)) continue;
    let address;
    try { address = lockAddress({ ownerPubkey: r.owner_pubkey, cosignerPubkey: r.cosigner_pubkey, locktime: r.locktime }, hrp); } catch { continue; }
    if (now.has(address) || gone.has(address)) continue;
    gone.set(address, { address, owner_pubkey: r.owner_pubkey, cosigner_pubkey: r.cosigner_pubkey, locktime: r.locktime, removed: true });
  }
  const count = Number.isInteger(mem.count) && mem.count > 0 ? mem.count : 0;
  const rewritten = mem.rewritten === true || gone.size > 0
    || (count > 0 && (current.length < count || chainOf(current, count) !== mem.chain));
  return { locks: [...current, ...gone.values()], gone: [...gone.values()], rewritten, current };
}

// How many locks' terms a reader keeps for one Crowdlock. Those already gone
// from the register are kept first: they are the ones that matter.
export const LOCKS_REMEMBERED = 500;

/**
 * What to remember now: { locks, count, chain, rewritten? }. The terms of the
 * locks watched (at most LOCKS_REMEMBERED), how many genuine locks the
 * register holds, the fingerprint of all of them in order, and whether the
 * register has ever been seen rewritten.
 */
export function locksSeen(ctx) {
  const w = locksToWatch(ctx);
  const terms = (l) => ({ owner_pubkey: l.owner_pubkey, cosigner_pubkey: l.cosigner_pubkey, locktime: l.locktime });
  const room = Math.max(0, LOCKS_REMEMBERED - w.gone.length);
  return {
    locks: [...w.gone.slice(0, LOCKS_REMEMBERED).map(terms), ...w.current.slice(Math.max(0, w.current.length - room)).map(terms)],
    count: w.current.length,
    chain: chainOf(w.current, w.current.length),
    ...(w.rewritten ? { rewritten: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// The coins at an address, from its history.
//
// Public explorers refuse to list the coins at an address that holds more
// than 500 ("Too many unspent transaction outputs"). Every lock's address is
// published, so one payment of 501 tiny outputs to it would make the lock
// unreadable to everyone, its owner included. An address's history is paged, not capped that way, and
// says the same thing: its coins are the outputs paying it that nothing in
// the history has spent.
// ---------------------------------------------------------------------------

/**
 * The unspent outputs at `address`, from its whole history (readHistory).
 * Returns [{ txid, vout, value, confirmed }]. An output spent by a payment
 * that is still waiting counts as spent, as an explorer's own list has it.
 */
export function coinsFromHistory(address, txs) {
  const a = String(address).toLowerCase();
  const at = (x) => String(x ?? "").toLowerCase() === a;
  const spent = new Set();
  const made = [];
  for (const tx of Array.isArray(txs) ? txs : []) {
    for (const v of tx?.vin ?? []) if (at(v?.prevout?.scriptpubkey_address)) spent.add(`${v.txid}:${v.vout}`);
    (tx?.vout ?? []).forEach((o, n) => { if (at(o?.scriptpubkey_address)) made.push({ txid: tx.txid, vout: n, value: o.value, confirmed: !!tx.status?.confirmed }); });
  }
  return made.filter((c) => !spent.has(`${c.txid}:${c.vout}`));
}
