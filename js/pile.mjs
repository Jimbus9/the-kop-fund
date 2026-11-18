// Adding up a proposal's pile: what is committed, what is paid, what is
// refused, and whether the co-signer has declared it dead.
//
// One module for every reader that adds a pile up, the app and the website
// alike, so the two can't come to different answers. What differs between
// them (how files are fetched, which explorer answers) is passed in.
//
//   readPile({
//     crowdlock, register, destinations, proposal,
//     fetchPile()            the repository's pile file: a fetch Response
//     relayItems()           what the Crowdlock's relays hold for this proposal
//                            (commitmentFromEvent's items, each with `at`)
//     check(record)          the full check of one waiting commitment
//                            (checkCommitment in the app's wallet code)
//     payment(record)        what a spent commitment paid (commitmentPayment):
//                            null, { unknown, reason } or { sats, confirmed }
//     txidOf(record)         the id its payment has (commitmentTxid)
//     ownerPubkey            whose commitments are "mine", if anyone's
//     now                    milliseconds, for the phase and the cut-off
//   })
//
// The repository's pile comes first, in the order the Crowdlock received it
// (its order is the receipt order: relay/accept.mjs lets it only grow at the
// end). Then anything on the relays the repository hasn't taken yet, while
// relay-only commitments still count.

import { checkPileShape, noticeIsGenuine, stillTakingCommitments, relayOnlyCommitments, commitmentEligible, phaseOf } from "./proposals.mjs";
import { memberAddressForOwnerKey } from "./verify.mjs";
import { hrpFor } from "./lockrecord.mjs";

export async function readPile({ crowdlock, register, destinations, proposal: p, fetchPile, relayItems, check, payment, txidOf, ownerPubkey = null, now = Date.now() }) {
  const hrp = hrpFor(crowdlock?.network);
  const genuine = (n) => { try { return noticeIsGenuine(n, { crowdlock, hash: p.hash, hrp, addressOf: memberAddressForOwnerKey }).ok === true; } catch { return false; } };
  const items = [];
  const inPile = new Set();
  let notice = null;
  // No pile yet (404) is an empty pile. Anything else that stops it being
  // read is said, never shown as nothing committed.
  let unreadable = null;
  try {
    const r = await fetchPile();
    if (r.ok) {
      const file = await r.json();
      const shape = checkPileShape(file, p.hash);
      if (shape.ok) {
        for (const x of file.commitments) { items.push({ type: "commitment", record: x.record, at: Date.parse(x.submitted) / 1000, seq: items.length }); inPile.add(x.record.tx); }
        if (file.notice && genuine(file.notice)) notice = file.notice;
      } else unreadable = `the Crowdlock's record of commitments isn't in its format (${shape.reason})`;
    } else if (r.status !== 404) unreadable = `the Crowdlock's record of commitments couldn't be read (${r.status})`;
  } catch (e) { unreadable = `the Crowdlock's record of commitments couldn't be read (${String(e?.message ?? e)})`; }

  // Relay-only commitments count until an hour after closing; after that only
  // the repository's record does, since a late one could carry any date. And
  // only those the inbox itself would take (relayOnlyCommitments).
  const relaysCount = stillTakingCommitments(p, now / 1000);
  for (const it of relayOnlyCommitments(await relayItems(), { crowdlock, register, inPile, proposal: p })) {
    if (it.type === "commitment" && !relaysCount) continue;
    // Not yet in the repository: ordered after everything that is.
    items.push(it.type === "commitment" ? { ...it, at: Math.max(it.at ?? 0, ...items.map((x) => x.at ?? 0)) + 1 } : it);
  }

  const pile = { sent: 0, sentCount: 0, count: 0, sats: 0, mine: [], good: [], completed: 0, refused: [], paid: 0, paidCount: 0, notice, uncertain: 0, unreadable };
  // One coin, one commitment: of two commitments spending the same coin only
  // one could ever be paid, so the earlier stands (spec/commitment-format.md,
  // "Counting the pile").
  const counted = new Set();
  // One payment counts once, however many copies of its commitment were
  // posted: a payment's id leaves out the signatures, so every copy shares it.
  const paidIds = new Set();
  for (const it of items) {
    if (it.type === "completed") { pile.completed++; continue; }
    if (it.type === "notice") { if (!pile.notice && genuine(it.notice)) pile.notice = { ...it.notice, published: new Date(it.at * 1000).toISOString() }; continue; }
    let v;
    try { v = await check(it.record); }
    catch (e) {
      // The repository's own pile is read in full or not at all. One that is
      // only on the relays is left out if it can't be checked now.
      if (!it.relayOnly) throw e;
      pile.refused.push("a commitment that is only on the relays couldn't be checked just now"); continue;
    }
    if (!v.valid) {
      // A commitment whose coin is gone may be one the co-signer completed:
      // then it was paid, not refused.
      if (/already been spent/.test(v.reason)) {
        const id = txidOf(it.record);
        if (id && paidIds.has(id)) continue;
        const pay = await payment(it.record);
        // A lookup that failed is not "unpaid": it stops the co-signer.
        if (pay?.unknown) { pile.uncertain++; pile.refused.push(`whether a commitment was paid couldn't be checked just now (${pay.reason})`); continue; }
        if (pay && pay.sats > 0) {
          if (id) paidIds.add(id);
          if (pay.confirmed) { pile.paid += pay.sats; pile.paidCount++; } else { pile.sent += pay.sats; pile.sentCount++; }
          if (ownerPubkey && it.record.lock?.owner_pubkey === ownerPubkey) pile.mine.push({ sats: pay.sats, record: it.record, paid: pay.confirmed, sent: !pay.confirmed });
          continue;
        }
      }
      pile.refused.push(v.reason); continue;
    }
    // The inbox's own test of who may back this proposal, for the
    // repository's record too.
    const eligible = commitmentEligible(it.record, { crowdlock, register, proposal: p });
    if (!eligible.ok) { pile.refused.push(eligible.reason); continue; }
    if (v.coin && counted.has(v.coin)) { pile.refused.push("an earlier commitment already spends the same coin, and only one can be paid"); continue; }
    if (v.coin) counted.add(v.coin);
    pile.count++; pile.sats += v.committedSats;
    pile.good.push({ record: it.record, at: it.at, seq: it.seq, sats: v.committedSats });
    if (ownerPubkey && v.ownerPubkey === ownerPubkey) pile.mine.push({ sats: v.committedSats, record: it.record });
  }
  // A notice says the proposal failed. While it is still gathering it can't
  // have, so a notice then is ignored. One against a pile that reaches its
  // target is shown for what it is: contradicted.
  const phase = phaseOf(p, now);
  if (pile.notice && (phase === "soon" || phase === "gathering")) pile.notice = null;
  if (pile.notice && pile.sats + pile.paid + pile.sent >= p.target.sats) pile.noticeContradicted = true;
  return pile;
}

/**
 * The order commitments are settled in: the repository's receipt order, then
 * those only on the relays by the time they carry.
 */
export function settleOrder(good) {
  return good.slice().sort((a, b) => ((a.seq ?? 1e9) - (b.seq ?? 1e9)) || (a.at - b.at));
}

/** Which commitments, in order, take a pile to its target, counting what is already paid or sent. The rest are the reserve. */
export function planFor(pile, target) {
  const settled = pile.paid + pile.sent;
  const take = [];
  let sum = settled;
  for (const g of settleOrder(pile.good)) { if (sum >= target) break; take.push(g); sum += g.sats; }
  return { settled, take, sum };
}
