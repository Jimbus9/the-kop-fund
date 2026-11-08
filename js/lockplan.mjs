// Working out a lock for a member, entirely from public records — no key, no
// wallet and no account involved.
//
// WHY THIS EXISTS. The Lock page on the website funds a lock without the app.
// A lock needs three things: the owner's public key, the Crowdlock's co-signer
// key, and a date. The owner's key is not asked for: a member's registered
// signature contains it (that is how the register checks the signature at all),
// so it is recovered from the register itself. The co-signer key comes from the
// Crowdlock's file. The date comes from the length chosen and the rounding rule
// in spec/lock-format.md.
//
// Nothing here signs anything or holds anything. It produces an address to send
// to and the record to publish, and checks its own answer with the same judgement
// the register applies (method/js/lockrecord.mjs), so the page can never offer
// an address the register would refuse.
//
// Pure: no network, no clock (the time is passed in).

import * as secp from "./vendor/noble-secp256k1.js";
import { verifyMembership, messageHash, memberAddressForOwnerKey } from "./verify.mjs";
import { membershipStatement } from "./crowdlock.mjs";
import { prepareLock, hrpFor } from "./lockrecord.mjs";

const DAY = 86400;
const YEAR = 365.25 * DAY; // exactly 31,557,600 seconds — part of the format

/**
 * The date a lock of `years`, made at `nowSeconds`, unlocks, as unix seconds.
 * Rounded up to the next midnight UTC for any length of a day or more; shorter
 * lengths (test networks only) are not rounded. Must match the app's lockDate
 * exactly, because the date decides the address (spec/lock-format.md).
 */
export function lockDate(years, nowSeconds) {
  const t = Math.ceil(nowSeconds + years * YEAR);
  return years * YEAR < DAY ? t : Math.ceil(t / DAY) * DAY;
}

/**
 * The compressed public key behind a message signature, as hex, or null.
 *
 * A signed message carries the key that made it — that is how the register
 * checks one at all. verify.mjs recovers it too but keeps only the address it
 * hashes to; that file is copied into every founder's repository, so it is left
 * alone and the key is recovered here, then checked against the address.
 */
function recoverKey(signatureBase64, message) {
  try {
    const bin = atob(String(signatureBase64).trim());
    if (bin.length !== 65) return null;
    const sig = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const header = sig[0];
    if (header < 31 || header > 42) return null; // only a compressed key can own a lock
    const big = (b) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
    const point = new secp.Signature(big(sig.slice(1, 33)), big(sig.slice(33, 65)), (header - 27) & 3)
      .recoverPublicKey(messageHash(message));
    return Array.from(point.toRawBytes(true), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/**
 * Plan a lock.
 *
 * crowdlock  the parsed Crowdlock file
 * register   the parsed registrations file
 * member     the member's address, or the member's number
 * years      one of the Crowdlock's offered lengths
 * now        unix seconds
 *
 * Returns { ok: false, reason } or
 *   { ok: true, address, ownerPubkey, cosignerPubkey, locktime, unlocks,
 *     record, minimumSats, alreadyOnRegister }
 */
export function planLock({ crowdlock, register, member, years, now }) {
  const no = (reason) => ({ ok: false, reason });
  const hrp = hrpFor(crowdlock?.network);
  if (!hrp) return no("this Crowdlock names a network this page does not know");
  if (!Array.isArray(register?.members)) return no("the register is not in the expected shape");

  const wanted = String(member ?? "").trim();
  if (!wanted) return no("say which member you are — your address or your number");
  const lower = wanted.toLowerCase();
  const m = register.members.find((x) => String(x.n) === wanted || String(x.address).toLowerCase() === lower);
  if (!m) return no("that is not on this Crowdlock's register yet — sign the declaration first, then come back");

  const offered = crowdlock.lock_lengths_years ?? [];
  if (!offered.includes(years)) return no("that length is not one this Crowdlock offers");

  const cosigners = crowdlock.cosigner_keys ?? [];
  if (cosigners.length === 0) return no("this Crowdlock has not published a co-signer key, so nobody can lock yet");
  const cosignerPubkey = cosigners[0];

  // The key behind a member is in their own signature.
  const statement = membershipStatement(crowdlock);
  const v = verifyMembership({ address: m.address, signature: m.signature, message: statement, hrp });
  const ownerPubkey = v.valid ? recoverKey(m.signature, statement) : null;
  // The recovered key must hash to the member's own address, or it is not theirs.
  const addr = (a) => String(a).toLowerCase();
  if (!ownerPubkey || addr(memberAddressForOwnerKey(ownerPubkey, hrp)) !== addr(m.address)) {
    return no("this member's registered signature could not be checked, so a lock cannot be built for them");
  }

  const locktime = lockDate(years, now);
  let prepared = prepareLock(
    { owner_pubkey: ownerPubkey, cosigner_pubkey: cosignerPubkey, locktime },
    { crowdlock, register, now },
  );
  let alreadyOnRegister = false;
  if (!prepared.ok && prepared.status === 409 && /already on the register/.test(prepared.reason)) {
    // Same member, same length, same day: the same address, which is intended.
    // Sending more to it is fine, so rebuild the plan without that one check.
    alreadyOnRegister = true;
    prepared = prepareLock(
      { owner_pubkey: ownerPubkey, cosigner_pubkey: cosignerPubkey, locktime },
      { crowdlock, register: { ...register, locks: [] }, now },
    );
  }
  if (!prepared.ok) return no(prepared.reason);

  const { lock } = prepared;
  return {
    ok: true,
    address: lock.address,
    ownerPubkey,
    cosignerPubkey,
    locktime,
    unlocks: lock.unlocks,
    member: lock.member,
    record: { type: "lock", owner_pubkey: ownerPubkey, cosigner_pubkey: cosignerPubkey, locktime, address: lock.address },
    minimumSats: crowdlock.minimum_counted_lock_sats ?? 0,
    alreadyOnRegister,
  };
}
