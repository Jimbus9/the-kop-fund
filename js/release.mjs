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

import { lockIsGenuine, hrpFor } from "./lockrecord.mjs";
import { chainIsIntact, attestationsAreValid, stampedAt, attestorsOf } from "./proposals.mjs";

/**
 * Was this input opened with the co-signer's signature, in the standard shape?
 * A label only. earlyReleases does not rely on it: before a lock's date the
 * owner alone cannot open it at all, so every spend before the date was
 * co-signed, whatever its witness looks like. (Until 17 November 2026 a spend
 * whose branch selector was the byte 00 rather than empty, which Bitcoin's
 * rules accept in a block, was not read as co-signed and never showed.)
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
 * Until 17 November 2026 this only asked whether the file had an `add` line
 * for the address, so one unattested line made a release read as a purchase.
 */
export function isListedDestination(address, destinations, { crowdlock = null, stamps = {}, at = Infinity, hrp } = {}) {
  const entries = Array.isArray(destinations?.entries) ? destinations.entries : [];
  if (!crowdlock || !entries.length) return false;
  const rules = attestorsOf(crowdlock, hrp ?? undefined);
  if (!/^[0-9a-f]{64}$/.test(String(rules.instance ?? "")) || !Number.isInteger(rules.threshold)) return false;
  if (!chainIsIntact(entries, rules.instance).ok) return false;
  const mine = entries.filter((e) => e.address === address);
  const added = mine.filter((e) => e.op === "add").pop();
  if (!added) return false;
  if (mine.some((e) => e.op === "revoke" && e.index > added.index)) return false;
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
 * the record also reads.
 *
 * Until 17 November 2026 any lock the same owner's key made under any of the
 * Crowdlock's co-signer keys counted, on the register or not, so money could
 * hop into a lock nobody watched and leave it unseen.
 */
export function staysLocked(address, lock, { crowdlock, register, hrp }) {
  const a = String(address ?? "").toLowerCase();
  if (!a || !lock?.owner_pubkey) return false;
  const own = String(lock.cosigner_pubkey ?? "").slice(2);
  if (a === String(lock.address ?? "").toLowerCase() && (crowdlock?.cosigner_keys ?? []).some((k) => String(k).slice(2) === own)) return true;
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
// Until 17 November 2026 the block's own timestamp was used (OpenAI review,
// C-02). Spends whose block is stamped before the date are early whatever the
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
 * proposal marker holding nothing; AND what it leaves as fee is no more than
 * a commitment may (the Crowdlock's max_commitment_fee of what it spends).
 * `paidTo` is the first output that is none of these, or null when the money
 * went as fee.
 */
export function earlyReleases(lock, txs, context = {}, now = Math.floor(Date.now() / 1000)) {
  const { destinations = null, crowdlock = null, register = null, stamps = {}, clocks = {} } = context ?? {};
  const hrp = context?.hrp ?? hrpFor(crowdlock?.network) ?? "bc";
  const maxFee = typeof crowdlock?.max_commitment_fee === "number" ? crowdlock.max_commitment_fee : 0.01;
  const address = String(lock.address).toLowerCase();
  const found = [];
  for (const tx of Array.isArray(txs) ? txs : []) {
    const at = tx.status?.confirmed ? tx.status.block_time : now;
    const accounted = (o) => holdsNothing(o)
      || (!!o?.scriptpubkey_address && isListedDestination(o.scriptpubkey_address, destinations, { crowdlock, stamps, at, hrp }))
      || staysLocked(o?.scriptpubkey_address, lock, { crowdlock, register, hrp });
    const ins = Array.isArray(tx.vin) ? tx.vin : [];
    const outs = Array.isArray(tx.vout) ? tx.vout : [];
    const spent = ins.reduce((n, v) => n + (Number(v?.prevout?.value) || 0), 0);
    const paid = outs.reduce((n, o) => n + (Number(o?.value) || 0), 0);
    const markers = outs.filter(holdsNothing).length;
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
      const feeTooBig = spent - paid > spent * maxFee;
      if (outs.length > 0 && !stray && !feeTooBig && markers <= 1 && paid > 0) continue;
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
 * confirmed; /address/<a>/txs/chain/<last txid> gives the next 25. Until
 * 17 November 2026 only the first page was read, so 25 small payments to a
 * lock's address pushed an earlier release out of sight.
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
