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
 * Every time the co-signer helped open this lock before its date, other than
 * to pay a listed destination.
 *   lock          { address, locktime, cosigner_pubkey? }
 *   txs           the explorer's transactions for the lock's address
 *   destinations  the Crowdlock's destinations file, or null
 *   now           seconds; used for a spend not yet in a block
 * Returns [{ txid, at, sats, paidTo, confirmed, cosigner }]. A co-signed spend
 * after the date is left out: the owner could have done that alone.
 */
export function earlyReleases(lock, txs, destinations = null, now = Math.floor(Date.now() / 1000)) {
  const address = String(lock.address).toLowerCase();
  const found = [];
  for (const tx of Array.isArray(txs) ? txs : []) {
    const at = tx.status?.confirmed ? tx.status.block_time : now;
    for (const vin of tx.vin ?? []) {
      if (String(vin.prevout?.scriptpubkey_address ?? "").toLowerCase() !== address) continue;
      if (!isCoSigned(vin)) continue;
      if (!(at < lock.locktime)) continue;
      const paidTo = tx.vout?.[0]?.scriptpubkey_address ?? null;
      if (paidTo && isListedDestination(paidTo, destinations)) continue;
      found.push({
        txid: tx.txid, at, sats: vin.prevout?.value ?? 0, paidTo,
        confirmed: !!tx.status?.confirmed, cosigner: lock.cosigner_pubkey ?? null,
      });
    }
  }
  return found;
}
