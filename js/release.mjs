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

import { lockAddress, lockIsGenuine, hrpFor } from "./lockrecord.mjs";

/** Was this input opened with the co-signer's signature? */
export function isCoSigned(vin) {
  const w = vin?.witness;
  return Array.isArray(w) && w.length === 4 && w[1] === "";
}

/**
 * Is this address currently on the destinations list: added, and not revoked
 * by a later entry? A spend to one is shaped like a purchase. This is a
 * label for the page, not the full check a purchase gets before it is signed
 * (attestations, age) — that lives with the commitment code.
 */
export function isListedDestination(address, destinations) {
  const entries = Array.isArray(destinations?.entries) ? destinations.entries : [];
  const mine = entries.filter((e) => e.address === address);
  const added = mine.filter((e) => e.op === "add").pop();
  if (!added) return false;
  return !mine.some((e) => e.op === "revoke" && e.index > added.index);
}

/**
 * Does money paid to this address stay locked? True if it is a lock of the
 * same owner, co-signed by this Crowdlock, opening no earlier than the lock
 * it came from: the remainder of a part-commitment. Either it is the lock the
 * same terms make under one of the Crowdlock's co-signer keys (how the app
 * makes a remainder), or it is on the register as a real lock of the same
 * owner with no earlier date.
 */
export function staysLocked(address, lock, { crowdlock, register, hrp }) {
  const a = String(address ?? "").toLowerCase();
  if (!a || !lock?.owner_pubkey) return false;
  for (const k of crowdlock?.cosigner_keys ?? []) {
    try {
      if (lockAddress({ ownerPubkey: lock.owner_pubkey, cosignerPubkey: k, locktime: lock.locktime }, hrp) === a) return true;
    } catch { /* a key that makes no lock with this owner */ }
  }
  return (register?.locks ?? []).some((r) => String(r.address).toLowerCase() === a
    && r.owner_pubkey === lock.owner_pubkey && r.locktime >= lock.locktime
    && lockIsGenuine(r, { crowdlock, register, hrp }).ok);
}

/** An output that can never be spent and carries nothing: OP_RETURN, value 0. */
function holdsNothing(o) {
  return String(o?.scriptpubkey ?? "").startsWith("6a") && Number(o?.value) === 0;
}

/**
 * Every time the co-signer helped open this lock before its date, other than
 * for a purchase.
 *   lock     { address, locktime, owner_pubkey, cosigner_pubkey? }
 *   txs      the explorer's transactions for the lock's address: the whole
 *            history (readHistory), or a release can be pushed out of sight
 *   context  { destinations, crowdlock, register } — the Crowdlock's
 *            destinations file, its own file and its register
 *   now      seconds; used for a spend not yet in a block
 * Returns [{ txid, at, sats, paidTo, confirmed, cosigner }]. A co-signed spend
 * after the date is left out: the owner could have done that alone.
 *
 * A co-signed spend is a purchase only if EVERY output of it is one of: a
 * listed destination; money staying locked (staysLocked); or an OP_RETURN
 * holding nothing (a commitment's proposal marker). Until 17 November 2026
 * only the first output was looked at, so 330 sats to a listed destination
 * and the rest to the member's own wallet read as a purchase. `paidTo` is the
 * first output that is none of these.
 */
export function earlyReleases(lock, txs, context = {}, now = Math.floor(Date.now() / 1000)) {
  const { destinations = null, crowdlock = null, register = null } = context ?? {};
  const hrp = context?.hrp ?? hrpFor(crowdlock?.network) ?? "bc";
  const address = String(lock.address).toLowerCase();
  const accounted = (o) => holdsNothing(o)
    || (!!o?.scriptpubkey_address && isListedDestination(o.scriptpubkey_address, destinations))
    || staysLocked(o?.scriptpubkey_address, lock, { crowdlock, register, hrp });
  const found = [];
  for (const tx of Array.isArray(txs) ? txs : []) {
    const at = tx.status?.confirmed ? tx.status.block_time : now;
    for (const vin of tx.vin ?? []) {
      if (String(vin.prevout?.scriptpubkey_address ?? "").toLowerCase() !== address) continue;
      if (!isCoSigned(vin)) continue;
      if (!(at < lock.locktime)) continue;
      const outs = Array.isArray(tx.vout) ? tx.vout : [];
      const stray = outs.find((o) => !accounted(o));
      if (outs.length > 0 && !stray) continue;
      found.push({
        txid: tx.txid, at, sats: vin.prevout?.value ?? 0, paidTo: stray?.scriptpubkey_address ?? null,
        confirmed: !!tx.status?.confirmed, cosigner: lock.cosigner_pubkey ?? null,
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
