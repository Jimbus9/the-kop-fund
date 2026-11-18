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
import { encodeP2WPKH, memberAddressForOwnerKey, verifyMembership } from "./verify.mjs";
import { membershipStatement, joinedVersion } from "./crowdlock.mjs";

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
  // A locktime is a whole number that fits Bitcoin's 32-bit field. Anything
  // else is refused, as method/lock/lock.mjs refuses it: until 17 November
  // 2026 nought, a fraction or a number too large still made "a script", and
  // not the one the proven code makes.
  if (!Number.isInteger(locktime) || locktime < 1 || locktime > 0xffffffff) throw new Error("a lock's date must be a whole number from 1 to 4294967295");
  // Both keys are compressed public keys: 33 bytes, starting 02 or 03, as
  // method/lock/lock.mjs requires. Until 17 November 2026 (security loop,
  // round 5) nothing here asked: the script says "33 bytes follow" and then
  // carried whatever it was given, so a 65-byte key still made "a lock" with
  // an address, and the app's commitment checker went on with it where the
  // reference checker refused.
  for (const [who, key] of [["owner", ownerPubkey], ["co-signer", cosignerPubkey]]) {
    if (typeof key !== "string" || !/^0[23][0-9a-fA-F]{64}$/.test(key)) throw new Error(`the ${who}'s key must be a compressed public key: 33 bytes, 66 hex characters`);
  }
  const owner = hexToBytes(ownerPubkey);
  const cosigner = hexToBytes(cosignerPubkey);
  // 1 to 16 have opcodes of their own (OP_1 … OP_16), which is how Bitcoin's
  // tools write them; everything larger is pushed as a minimal number.
  const t = scriptNumber(locktime);
  const pushed = locktime <= 16 ? [0x50 + locktime] : [t.length, ...t];
  return Uint8Array.from([
    33, ...owner, OP.CHECKSIGVERIFY,
    OP.IF, ...pushed, OP.CHECKLOCKTIMEVERIFY,
    OP.ELSE, 33, ...cosigner, OP.CHECKSIG,
    OP.ENDIF,
  ]);
}

/** The P2WSH address of a lock: segwit v0, program = sha256(script). */
export function lockAddress(terms, hrp = "bc") {
  // encodeP2WPKH is a general segwit-v0 encoder; the name reflects its first use.
  return encodeP2WPKH(sha256(lockScript(terms)), hrp);
}

const KEY = /^0[23][0-9a-f]{64}$/;

// Signatures already checked, so a register with many locks per member checks each once.
const checkedSignatures = new Map();

/**
 * Is this address a member of this register whose signature really verifies
 * against the version of the declaration it joined with? A register is a file,
 * and a file can list an address with any signature at all; until 17 November
 * 2026 the address alone made a lock's owner a committed member (OpenAI
 * review, H-03).
 */
export function isSignedMember(address, { crowdlock, register, hrp }) {
  const a = String(address ?? "").toLowerCase();
  const m = (register?.members ?? []).find((x) => String(x?.address ?? "").toLowerCase() === a);
  if (!m || !crowdlock?.declaration) return false;
  let statement;
  try { statement = membershipStatement(crowdlock, joinedVersion(crowdlock, m)); } catch { return false; }
  const key = `${hrp}|${a}|${m.signature}|${statement}`;
  if (!checkedSignatures.has(key)) {
    let ok = false;
    try { ok = verifyMembership({ address: a, signature: String(m.signature ?? ""), message: statement, hrp }).valid; } catch { ok = false; }
    checkedSignatures.set(key, ok);
  }
  return checkedSignatures.get(key);
}

/**
 * Is this record, as it sits on a register, really a lock of this Crowdlock?
 *
 * The relay inbox checks a lock before it adds one. A reader must check
 * again, because a register is a file: one that has been altered, or one
 * published by a Crowdlock's own founder, can list anything. Without this a
 * register could name any well-funded address a "lock" and its total would
 * count it (found by review, 17 November 2026).
 *
 * A record is a lock of this Crowdlock only if its address is the lock its
 * stated terms make and its co-signer is one of this Crowdlock's keys.
 *
 * Returns { ok, reason, owner, member }:
 *   owner   the address the lock's owner key hashes to, worked out here and
 *           never read from the record's own `member` label
 *   member  whether that address is a member on this register, with a
 *           signature that verifies (isSignedMember). The counting
 *           rule counts a real lock's money either way, and counts its owner
 *           among the committed members only if they are one.
 *
 * `hrp` is only for a private test chain whose addresses use another prefix.
 */
export function lockIsGenuine(lock, { crowdlock, register, hrp = hrpFor(crowdlock?.network) }) {
  const no = (reason) => ({ ok: false, reason, owner: null, member: false });
  if (!lock || typeof lock !== "object") return no("it is not a lock record");
  if (!hrp) return no("this Crowdlock's network is not one the checker knows");
  if (!KEY.test(String(lock.owner_pubkey ?? "")) || !KEY.test(String(lock.cosigner_pubkey ?? ""))) return no("its keys are not public keys");
  if (!Number.isInteger(lock.locktime) || lock.locktime <= 0) return no("its date is not a date");
  if (lock.owner_pubkey.slice(2) === lock.cosigner_pubkey.slice(2)) return no("its owner and co-signer are the same key");
  // Dates, not heights, on every real network (spec/lock-format.md), as the
  // inbox already requires before it adds a lock. A reader must ask too: a
  // register is a file, and a "lock" dated by a block height long passed is
  // money its owner can take home alone (security loop, 17 November 2026).
  if (lock.locktime < LOCKTIME_THRESHOLD && hrp !== "bcrt") return no("its date is a block height, which only a private test chain uses");
  let derived;
  try { derived = lockAddress({ ownerPubkey: lock.owner_pubkey, cosignerPubkey: lock.cosigner_pubkey, locktime: lock.locktime }, hrp); } catch { return no("its terms do not make a lock"); }
  if (derived !== String(lock.address ?? "").toLowerCase()) return no("its address is not the lock its terms make");
  // The key itself, not just its x-coordinate: a lock naming a key's mirror
  // image is a different lock, which the co-signer's words cannot open.
  if (!(crowdlock?.cosigner_keys ?? []).some((k) => String(k).toLowerCase() === lock.cosigner_pubkey)) return no("its co-signer is not this Crowdlock's");
  const owner = memberAddressForOwnerKey(lock.owner_pubkey, hrp);
  return { ok: true, reason: "", owner, member: isSignedMember(owner, { crowdlock, register, hrp }) };
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
  } else if (locktime <= 0 || locktime > 0xffffffff) {
    return no(400, "locktime must be positive, and no larger than a locktime can hold");
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
