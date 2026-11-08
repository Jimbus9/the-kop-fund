// Deciding whether a lock may be added to the register, and what the register
// looks like afterwards.
//
// This is the whole judgement of the lock endpoint, kept apart from the network
// code around it, exactly as method/js/append.mjs is for joining. It touches nothing
// outside itself — no fetch, no clock — so it can be tested properly. The one
// fact it needs from the blockchain (how much confirmed money sits at the lock
// address) is fetched by the caller and passed in.
//
// WHY THE REGISTER HAS TO BE TOLD ABOUT A LOCK AT ALL. A lock address is the
// hash of its script, so the chain shows only "some coins at some address"
// until the lock is spent. Nobody can find a lock by looking; its owner has to
// say "this address is my lock, built from these two keys and this date". The
// register then rebuilds the address from those three things and accepts the
// lock only if it comes out identical — which is spec/lock-format.md,
// "Verifying a lock", steps 1 to 4.
//
// What this can decide is narrow by design. It cannot invent a lock: an address
// that does not rebuild from the stated terms is refused, and the terms decide
// who can ever move the coins. It can only accept a genuine lock, or refuse one.
//
// It deliberately does NOT refuse a lock below the minimum. The minimum is a
// counting rule, not a validity rule (spec/counting-rule.md): such a lock is
// published and simply not counted.

import { sha256 } from "./vendor/noble-hashes/sha256.js";
import { encodeP2WPKH, memberAddressForOwnerKey } from "./verify.mjs";

const PUBKEY = /^0[23][0-9a-f]{64}$/;
const LOCKTIME_THRESHOLD = 500000000; // below this a locktime is a block height
const DAY = 86400;
const YEAR = 365.25 * DAY;
// A fan picks one of the offered lengths at the moment of locking, and coins
// may arrive a few weeks after the address is made. A month's slack either
// side of "the longest offered length from now" covers that without letting
// somebody publish a fifty-year lock the register was never meant to show.
const SLACK = 31 * DAY;

const OP = { CHECKSIG: 0xac, CHECKSIGVERIFY: 0xad, CHECKLOCKTIMEVERIFY: 0xb1, IF: 0x63, ELSE: 0x67, ENDIF: 0x68 };

/** Bech32 prefix for a Crowdlock's network. */
export function hrpFor(network) {
  return { mainnet: "bc", testnet4: "tb", signet: "tb", regtest: "bcrt" }[network] ?? null;
}

const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

/** Minimal script-number encoding, as Bitcoin requires for a pushed integer. */
function scriptNumber(n) {
  const out = [];
  let v = n;
  while (v > 0) { out.push(v & 0xff); v = Math.floor(v / 256); }
  if (out.length && out[out.length - 1] & 0x80) out.push(0x00);
  return out;
}

/**
 * The lock's witness script, byte for byte as spec/lock-format.md gives it:
 *   <owner> CHECKSIGVERIFY IF <locktime> CHECKLOCKTIMEVERIFY ELSE <cosigner> CHECKSIG ENDIF
 * Keys as 66-character hex. Returns bytes.
 */
export function lockScript({ ownerPubkey, cosignerPubkey, locktime }) {
  const owner = hexToBytes(ownerPubkey);
  const cosigner = hexToBytes(cosignerPubkey);
  const t = scriptNumber(locktime);
  return Uint8Array.from([
    33, ...owner, OP.CHECKSIGVERIFY,
    OP.IF, t.length, ...t, OP.CHECKLOCKTIMEVERIFY,
    OP.ELSE, 33, ...cosigner, OP.CHECKSIG,
    OP.ENDIF,
  ]);
}

/** The P2WSH address of a lock: segwit v0, program = sha256(script). */
export function lockAddress(terms, hrp = "bc") {
  // encodeP2WPKH is a general segwit-v0 encoder; the name reflects its first use.
  return encodeP2WPKH(sha256(lockScript(terms)), hrp);
}

function normalise(address) {
  const raw = String(address ?? "").trim();
  return raw === raw.toUpperCase() && raw !== raw.toLowerCase() ? raw.toLowerCase() : raw;
}

/**
 * Check a submitted lock's terms, before anything is read from the chain.
 *
 * submission  { owner_pubkey, cosigner_pubkey, locktime, address? } — untrusted
 * crowdlock   the parsed Crowdlock file
 * register    the parsed registrations file
 * now         unix seconds, passed in rather than read from a clock
 *
 * Returns { ok, status, reason } or { ok: true, lock } where `lock` is the
 * record that would be published. The caller then reads the chain for
 * lock.address and calls addLock().
 */
export function prepareLock(submission, { crowdlock, register, now }) {
  const no = (status, reason) => ({ ok: false, status, reason });

  if (!register || typeof register !== "object" || !Array.isArray(register.members)) {
    return no(500, "the register file is not in the expected shape");
  }
  const hrp = hrpFor(crowdlock?.network);
  if (!hrp) return no(500, "this Crowdlock names a network the register does not know");

  const owner = String(submission?.owner_pubkey ?? "").trim().toLowerCase();
  const cosigner = String(submission?.cosigner_pubkey ?? "").trim().toLowerCase();
  const locktime = submission?.locktime;

  if (!PUBKEY.test(owner)) return no(400, "owner_pubkey must be a compressed public key, 66 hex characters");
  if (!PUBKEY.test(cosigner)) return no(400, "cosigner_pubkey must be a compressed public key, 66 hex characters");
  if (!Number.isInteger(locktime)) return no(400, "locktime must be a whole number");

  // Step 1 of "Verifying a lock": two different keys, compared on the
  // x-coordinate so a key's mirror image is caught too.
  if (owner.slice(2) === cosigner.slice(2)) {
    return no(400, "the owner and co-signer are the same key — that is not a lock, because one person could move the coins at any time");
  }

  const cosigners = Array.isArray(crowdlock.cosigner_keys) ? crowdlock.cosigner_keys : [];
  if (cosigners.length === 0) {
    return no(409, "this Crowdlock has not published a co-signer key yet, so no lock can be made for it yet");
  }
  if (!cosigners.includes(cosigner)) {
    return no(400, "that co-signer key is not this Crowdlock's — a lock is counted by the Crowdlock whose co-signer it names");
  }

  // Dates, not heights, on every real network (spec/lock-format.md, Locktime).
  // Regtest is for testing, where heights are exact and quick.
  if (crowdlock.network !== "regtest") {
    if (locktime < LOCKTIME_THRESHOLD) return no(400, "locktime must be a date, not a block height");
    if (locktime <= now) return no(400, "that lock's date has already passed — it would be lapsed from the moment it was published");
    const years = Math.max(...(crowdlock.lock_lengths_years ?? [0]));
    if (locktime > now + years * YEAR + SLACK) {
      return no(400, `that lock runs longer than this Crowdlock offers (at most ${years} years)`);
    }
  } else if (locktime <= 0) {
    return no(400, "locktime must be positive");
  }

  const address = lockAddress({ ownerPubkey: owner, cosignerPubkey: cosigner, locktime }, hrp);
  if (submission.address !== undefined && normalise(submission.address) !== address) {
    return no(400, `those terms make the address ${address}, not the one you sent — check the keys and date your wallet used`);
  }

  // The owner key is the key that signed the declaration, so hashing it gives
  // the member's address. A lock is published only for a member.
  const member = memberAddressForOwnerKey(owner, hrp);
  if (!register.members.some((m) => normalise(m.address) === member)) {
    return no(403, `the owner of that lock is not on the register — sign the declaration with the same key first (it belongs to ${member})`);
  }

  const locks = Array.isArray(register.locks) ? register.locks : [];
  if (locks.some((l) => normalise(l.address) === address)) {
    return no(409, "that lock is already on the register");
  }

  return {
    ok: true,
    status: 200,
    lock: {
      address,
      member,
      owner_pubkey: owner,
      cosigner_pubkey: cosigner,
      locktime,
      unlocks: crowdlock.network === "regtest" ? null : new Date(locktime * 1000).toISOString().slice(0, 10),
    },
  };
}

/**
 * Add a prepared lock to the register, given what the chain says.
 *
 * confirmedSats  confirmed coins at lock.address right now, from the chain
 * today          "YYYY-MM-DD"
 *
 * A lock with no confirmed coins is refused: until a coin has confirmed there
 * is nothing on the chain to point at, and publishing empty addresses would let
 * anybody fill the register for free. A below-minimum lock is accepted; the
 * counting rule decides what counts.
 */
export function addLock(register, lock, { confirmedSats, today }) {
  if (!Number.isInteger(confirmedSats) || confirmedSats <= 0) {
    return {
      ok: false, status: 409,
      reason: "there are no confirmed coins at that lock address yet — send to it, wait for one confirmation, then submit again",
    };
  }
  const locks = Array.isArray(register.locks) ? register.locks : [];
  return {
    ok: true,
    status: 200,
    register: { ...register, locks: [...locks, { ...lock, submitted: today }] },
  };
}
