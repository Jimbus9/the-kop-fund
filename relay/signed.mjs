// What the relay inbox checks about a commitment's signatures before it takes
// it into a proposal's pile, and how it sends a completed payment.
//
// Anybody can post a record to the relays. Before these checks, five unsigned
// records naming somebody's lock used up that lock's five places in a pile,
// and a copy of a commitment with a made-up co-signer signature was recorded
// as "completed" ahead of the real one. So the inbox now takes a commitment
// only if the lock's owner signed it, and a completion only if owner and
// co-signer both did. Every reader still checks every commitment in full; this
// is what keeps strangers' junk out of the file.
//
// A signature covers the amount of the coin it spends, so checking one means
// asking the chain what that coin holds. The questions are kept few and
// bounded: one per lock that has a new commitment waiting, and one per
// commitment that has a completion waiting. Junk naming a coin the lock does
// not hold costs no question at all.

import { createHash } from "node:crypto";
import { Transaction, script as bscript } from "bitcoinjs-lib";
import { verify } from "../js/vendor/noble-secp256k1.js";
import { lockScript } from "../js/lockrecord.mjs";
import { readHistory, coinsFromHistory } from "../js/release.mjs";

const hex = (b) => Buffer.from(b).toString("hex");
const TIMEOUT_MS = 20000;

/** One question to the block explorer, with a time limit so a silent explorer cannot hold a pass up. */
async function ask(url, init, fetchImpl) {
  return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/**
 * One signature from a witness, checked against a key. It must be strictly
 * encoded, sign everything (SIGHASH_ALL), and have a low S value: the network
 * will not pass on a high one, and anyone can turn a low one into a high one,
 * so allowing both would let a stranger post a second, unsendable version of a
 * genuine payment.
 */
function signatureIsGood(item, sighash, pubkeyHex) {
  let decoded;
  try { decoded = bscript.signature.decode(Buffer.from(item)); } catch { return false; }
  if (decoded.hashType !== Transaction.SIGHASH_ALL) return false;
  try { return verify(new Uint8Array(decoded.signature), new Uint8Array(sighash), pubkeyHex, { lowS: true }); } catch { return false; }
}

/** The transaction, if it has the one shape a commitment can have: one input, a four-part witness ending in this lock's script. */
function parse(txHex, lock) {
  let tx;
  try { tx = Transaction.fromHex(txHex); } catch { return { reason: "its transaction cannot be read" }; }
  if (tx.ins.length !== 1) return { reason: "it does not spend exactly one coin" };
  // The owner's signature does not cover the input's own script, so anyone
  // can add one: the copy has another id, is still "signed", and the network
  // never takes it. Posted first it took the coin's place in the pile
  // (security loop, 17 November 2026).
  if (tx.ins[0].script.length !== 0) return { reason: "its input carries a script, which a spend of a lock never does — the network would not take it" };
  const w = tx.ins[0].witness;
  let script;
  try { script = lockScript({ ownerPubkey: lock.owner_pubkey, cosignerPubkey: lock.cosigner_pubkey, locktime: lock.locktime }); } catch { return { reason: "its lock's terms do not make a lock" }; }
  if (w.length !== 4 || hex(w[3]) !== hex(script)) return { reason: "it is not a spend of the lock it names" };
  if (w[1].length !== 0) return { reason: "it does not take the co-signed route out of the lock" };
  return { tx, w, script: Buffer.from(script), coin: `${hex(Buffer.from(tx.ins[0].hash).reverse())}:${tx.ins[0].index}` };
}

/**
 * Did the lock's owner sign this commitment?
 *   coins: the coins at the lock's address, as { "txid:vout": sats }, or null
 *          if the explorer could not be asked this pass.
 * Returns { ok: true } or { ok: false, reason }.
 */
export function ownerSigned(record, coins) {
  const p = parse(record.tx, record.lock);
  if (!p.tx) return { ok: false, reason: p.reason };
  // A commitment leaves the co-signer's place empty. Until 17 November 2026
  // this was not asked, so copies of a member's real commitment with junk in
  // that place still carried the owner's signature and used up the lock's places.
  if (p.w[0].length !== 0) return { ok: false, reason: "the co-signer's place is not empty, so this is not a commitment" };
  // The payment names its proposal in its last output, inside what the owner
  // signed (spec/commitment-format.md). A record relabelled for another
  // proposal is turned away here, before the explorer is asked anything.
  const last = p.tx.outs[p.tx.outs.length - 1];
  if (!last || hex(last.script) !== `6a20${record.proposal}` || BigInt(last.value) !== 0n) {
    return { ok: false, reason: "the payment does not name this proposal inside it" };
  }
  if (coins === null || coins === undefined) return { ok: false, reason: "the block explorer could not be asked about that lock this pass; it will be looked at again on the next" };
  const value = coins[p.coin];
  if (value === undefined) return { ok: false, reason: "it does not spend a coin that lock holds" };
  const sighash = p.tx.hashForWitnessV0(0, p.script, BigInt(value), Transaction.SIGHASH_ALL);
  if (!signatureIsGood(p.w[2], sighash, record.lock.owner_pubkey)) return { ok: false, reason: "the lock's owner has not signed it" };
  return { ok: true };
}

/**
 * Is this the co-signer's completion of that commitment: the same payment,
 * signed by the owner and by the co-signer?
 *   value: what the coin it spends holds, in sats, or null if the explorer
 *          could not be asked this pass.
 */
export function completedBy(txHex, record, value) {
  const p = parse(txHex, record.lock);
  if (!p.tx) return { ok: false, reason: p.reason };
  if (value === null || value === undefined) return { ok: false, reason: "the block explorer could not be asked about its coin this pass; it will be looked at again on the next" };
  const sighash = p.tx.hashForWitnessV0(0, p.script, BigInt(value), Transaction.SIGHASH_ALL);
  if (!signatureIsGood(p.w[2], sighash, record.lock.owner_pubkey)) return { ok: false, reason: "the lock's owner has not signed it" };
  if (!signatureIsGood(p.w[0], sighash, record.lock.cosigner_pubkey)) return { ok: false, reason: "the co-signer has not signed it" };
  return { ok: true };
}

// How many locks, and how many coins, one pass asks the explorer about for one
// proposal. A free public explorer turns away heavy users, and what is asked
// here is decided by whoever posts to the relays.
export const ASKED_PER_PASS = 200;

/**
 * One budget of explorer questions for one proposal in one pass, shared by
 * the commitment check and the completion check. Until 17 November 2026 each
 * had its own 200, so a proposal could cost 400 (OpenAI review, M-01).
 */
export function explorerBudget(n = ASKED_PER_PASS) {
  // Some of it is kept back for completed payments. The commitment check
  // runs first and what it asks is decided by whoever posts to the relays:
  // junk naming 200 registered locks used every question, the completion
  // check got none, and the inbox recorded and sent no completed payment
  // for as long as the junk was there (security loop, round 4).
  return { left: n, keptForCompletions: Math.min(KEPT_FOR_COMPLETIONS, Math.floor(n / 2)) };
}
export const KEPT_FOR_COMPLETIONS = 50;

/**
 * Which of these to ask about this pass, when there are more than a pass
 * asks about: a different selection each pass, so that junk posted for many
 * locks cannot keep the same real one waiting for ever.
 */
function thisPass(keys, limit, seed) {
  if (limit <= 0) return new Set();
  if (keys.length <= limit) return new Set(keys);
  const order = (k) => createHash("sha256").update(`${seed}|${k}`).digest("hex");
  return new Set([...keys].sort((a, b) => order(a).localeCompare(order(b))).slice(0, limit));
}
const NEXT_PASS = "more was posted than one pass asks the block explorer about; it will be looked at on a later pass";

/**
 * ownerSigned for a batch, in the shape applyCommitments asks for.
 *   coinsFor: (address) => coins at that address, or null (see coinsAt)
 *   seed:     anything that differs from pass to pass
 */
export async function ownersSigned(records, { coinsFor, limit = ASKED_PER_PASS, seed = "", budget = null }) {
  const pick = thisPass([...new Set(records.map((r) => r.lock.address))], budget ? Math.min(limit, Math.max(0, budget.left - (budget.keptForCompletions ?? 0))) : limit, seed);
  if (budget) budget.left -= pick.size;
  const coins = new Map();
  for (const address of pick) coins.set(address, await coinsFor(address));
  return records.map((r) => pick.has(r.lock.address) ? ownerSigned(r, coins.get(r.lock.address)) : { ok: false, reason: NEXT_PASS });
}

/**
 * completedBy for a batch, in the shape applySettlement asks for.
 *   valueFor: ("txid:vout") => sats, or null (see coinValue)
 */
export async function completedByBoth(candidates, { valueFor, limit = ASKED_PER_PASS, seed = "", budget = null }) {
  const coin = candidates.map((c) => coinOf(c.record.tx));
  const pick = thisPass([...new Set(coin.filter(Boolean))], budget ? Math.min(limit, budget.left) : limit, seed);
  if (budget) budget.left -= pick.size;
  const values = new Map();
  for (const c of pick) values.set(c, await valueFor(c));
  return candidates.map((c, i) => !coin[i] ? { ok: false, reason: "its commitment cannot be read" }
    : pick.has(coin[i]) ? completedBy(c.tx, c.record, values.get(coin[i])) : { ok: false, reason: NEXT_PASS });
}

/**
 * A transaction's id, the coin it spends and its standard encoding, or null if
 * it can't be read or doesn't spend exactly one coin. The same payment can be
 * written in more than one way (a count can be written long) and keep its id;
 * the network takes only the standard one, so that is what is kept and sent.
 */
export function readTx(txHex) {
  try {
    const tx = Transaction.fromHex(txHex);
    if (tx.ins.length !== 1) return null;
    return { txid: tx.getId(), coin: `${hex(Buffer.from(tx.ins[0].hash).reverse())}:${tx.ins[0].index}`, hex: tx.toHex(), outputs: tx.outs.map((o) => hex(o.script)), inputScript: hex(tx.ins[0].script) };
  } catch { return null; }
}

/** The coin a commitment spends, as "txid:vout", or null if its transaction cannot be read. */
export function coinOf(txHex) {
  try {
    const tx = Transaction.fromHex(txHex);
    return tx.ins.length === 1 ? `${hex(Buffer.from(tx.ins[0].hash).reverse())}:${tx.ins[0].index}` : null;
  } catch { return null; }
}

/**
 * The coins at an address, asked once per address per pass.
 * Returns a function: address -> { "txid:vout": sats }, or null if the explorer did not answer.
 */
export function coinsAt(chainApi, fetchImpl = fetch) {
  const asked = new Map();
  return async (address) => {
    if (asked.has(address)) return asked.get(address);
    let coins = null;
    try {
      const r = await ask(`${chainApi}/address/${address}/utxo`, {}, fetchImpl);
      // Confirmed coins only: an unconfirmed one can be replaced by its sender
      // and vanish, so a commitment spending it counts toward nothing.
      if (r.ok) coins = Object.fromEntries((await r.json()).filter((u) => u?.status?.confirmed).map((u) => [`${u.txid}:${u.vout}`, u.value]));
      // Public explorers refuse to list the coins at an address holding more
      // than 500 (they answer 400). Anyone can send 501 tiny coins to a
      // lock's published address, and that lock's commitments could then
      // never be taken. Its history says the same thing, a page at a time
      // (security loop, 17 November 2026).
      else if (r.status === 400) {
        const page = async (path) => { const p = await ask(`${chainApi}/address/${address}/${path}`, {}, fetchImpl); if (!p.ok) throw new Error(String(p.status)); return p.json(); };
        const h = await readHistory(() => page("txs"), (last) => page(`txs/chain/${last}`));
        if (h.complete) coins = Object.fromEntries(coinsFromHistory(address, h.txs).filter((u) => u.confirmed).map((u) => [`${u.txid}:${u.vout}`, u.value]));
      }
    } catch {}
    asked.set(address, coins);
    return coins;
  };
}

/**
 * What one coin holds, whether or not it has been spent since, asked once per
 * coin per pass. Returns a function: "txid:vout" -> sats, or null if the
 * explorer did not answer or has no such coin.
 */
export function coinValue(chainApi, fetchImpl = fetch) {
  const asked = new Map();
  return async (coin) => {
    if (asked.has(coin)) return asked.get(coin);
    const [txid, vout] = coin.split(":");
    let value = null;
    try {
      const r = await ask(`${chainApi}/tx/${txid}`, {}, fetchImpl);
      if (r.ok) value = (await r.json()).vout?.[Number(vout)]?.value ?? null;
    } catch {}
    asked.set(coin, value);
    return value;
  };
}

/**
 * Send one completed payment, unless the network already has it.
 * Returns { state: "already on the network" | "sent" } when it is out there,
 * or { state: null, refused } when the network would not take it,
 * or { state: null, unreachable } when the explorer could not be asked.
 *
 * "Does the network have it?" is asked by asking for the payment itself, which
 * the explorer answers "not found" when it has never seen it. Asking for its
 * status is no use: an explorer answers "not confirmed" for any payment at
 * all, seen or not, and for a while this job took that for "already there" and
 * sent nothing.
 */
export async function sendCompleted(chainApi, { txid, tx }, fetchImpl = fetch) {
  try {
    const known = await ask(`${chainApi}/tx/${txid}/hex`, {}, fetchImpl);
    if (known.ok) return { state: "already on the network" };
    if (known.status !== 404) return { state: null, unreachable: `the explorer answered ${known.status}` };
    const r = await ask(`${chainApi}/tx`, { method: "POST", body: tx }, fetchImpl);
    const text = (await r.text()).trim();
    if (r.ok) return { state: "sent" };
    // Sent by somebody else between our two questions.
    if (/already (known|in block chain|in the mempool|in mempool)|txn-already/i.test(text)) return { state: "already on the network" };
    return { state: null, refused: text.slice(0, 200) };
  } catch (e) { return { state: null, unreachable: e.message }; }
}
