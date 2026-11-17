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
 * Which of these to ask about this pass, when there are more than a pass
 * asks about: a different selection each pass, so that junk posted for many
 * locks cannot keep the same real one waiting for ever.
 */
function thisPass(keys, limit, seed) {
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
export async function ownersSigned(records, { coinsFor, limit = ASKED_PER_PASS, seed = "" }) {
  const pick = thisPass([...new Set(records.map((r) => r.lock.address))], limit, seed);
  const coins = new Map();
  for (const address of pick) coins.set(address, await coinsFor(address));
  return records.map((r) => pick.has(r.lock.address) ? ownerSigned(r, coins.get(r.lock.address)) : { ok: false, reason: NEXT_PASS });
}

/**
 * completedBy for a batch, in the shape applySettlement asks for.
 *   valueFor: ("txid:vout") => sats, or null (see coinValue)
 */
export async function completedByBoth(candidates, { valueFor, limit = ASKED_PER_PASS, seed = "" }) {
  const coin = candidates.map((c) => coinOf(c.record.tx));
  const pick = thisPass([...new Set(coin.filter(Boolean))], limit, seed);
  const values = new Map();
  for (const c of pick) values.set(c, await valueFor(c));
  return candidates.map((c, i) => !coin[i] ? { ok: false, reason: "its commitment cannot be read" }
    : pick.has(coin[i]) ? completedBy(c.tx, c.record, values.get(coin[i])) : { ok: false, reason: NEXT_PASS });
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
      if (r.ok) coins = Object.fromEntries((await r.json()).map((u) => [`${u.txid}:${u.vout}`, u.value]));
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
