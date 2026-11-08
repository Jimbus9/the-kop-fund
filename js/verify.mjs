// Verifying a membership signature.
//
// This is the only piece of cryptography a Crowdlock asks anyone to trust,
// and it runs in your own browser rather than on anyone's server. Given an address
// and a signature, it answers one question: did the holder of that address
// sign this exact declaration?
//
// It works by recovering the public key from the signature, deriving an
// address from that key, and checking the result matches the address claimed.
// If somebody tampers with the declaration, or submits somebody else's
// signature, or claims a signature for an address they do not control, the
// derived address comes out different and the check fails.
//
// Runs unchanged in a browser and in Node. No network, no server, no trust.

import * as secp from "./vendor/noble-secp256k1.js";
import { sha256 } from "./vendor/noble-hashes/sha256.js";
import { ripemd160 } from "./vendor/noble-hashes/ripemd160.js";

const MAGIC = "Bitcoin Signed Message:\n";

const enc = new TextEncoder();

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) { out.set(a, at); at += a.length; }
  return out;
}

/** Bitcoin's variable-length integer. */
function varint(n) {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  if (n <= 0xffffffff) return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  throw new Error("message too long");
}

/** The digest a wallet actually signs when it signs a message. */
export function messageHash(message) {
  const msg = enc.encode(message);
  const magic = enc.encode(MAGIC);
  const payload = concat(varint(magic.length), magic, varint(msg.length), msg);
  return sha256(sha256(payload));
}

export function hash160(bytes) {
  return ripemd160(sha256(bytes));
}

// --- bech32, for turning a key hash into a bc1q address ---------------------
// Short enough to read and check against BIP-173 rather than take on faith.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  else if (!pad && (bits >= from || ((acc << (to - bits)) & maxv))) return null;
  return out;
}

/** Native segwit v0 address (bc1q… / tb1q…) from a 20-byte key hash. */
export function encodeP2WPKH(keyHash, hrp = "bc") {
  const data = [0, ...convertBits(Array.from(keyHash), 8, 5, true)];
  const checksum = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const cs = [];
  for (let i = 0; i < 6; i++) cs.push((checksum >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...cs].map((d) => CHARSET[d]).join("");
}

// --- The verification itself ------------------------------------------------

function b64ToBytes(b64) {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Does `signature` prove that the holder of `address` signed `message`?
 *
 * Returns { valid, reason, derived } — on failure, `derived` is the address the
 * signature actually belongs to, which is usually the most useful thing to see.
 */
/**
 * The member address that owns a lock.
 *
 * The key that signs the declaration is the key that owns the locks, so a lock
 * is tied to a member with no extra registration and no second signature:
 * hash the lock's owner public key and the member's address falls out. See
 * spec/registration-format.md.
 *
 * ownerPubkey: 33-byte compressed key, as hex or bytes.
 */
export function memberAddressForOwnerKey(ownerPubkey, hrp = "bc") {
  const bytes = typeof ownerPubkey === "string"
    ? Uint8Array.from(ownerPubkey.match(/../g).map((h) => parseInt(h, 16)))
    : Uint8Array.from(ownerPubkey);
  if (bytes.length !== 33) throw new Error("owner key must be 33 bytes (compressed)");
  return encodeP2WPKH(hash160(bytes), hrp);
}

export function verifyMembership({ address, signature, message, hrp = "bc" }) {
  let sig;
  try {
    sig = b64ToBytes(String(signature).trim());
  } catch {
    return { valid: false, reason: "signature is not valid base64" };
  }
  if (sig.length !== 65) {
    return { valid: false, reason: `signature should be 65 bytes, got ${sig.length}` };
  }

  const header = sig[0];
  if (header < 27 || header > 42) {
    return { valid: false, reason: `signature header out of range (${header})` };
  }
  // 27–30 uncompressed, 31–34 compressed, 35–38 P2SH-segwit, 39–42 native segwit.
  const recovery = (header - 27) & 3;
  const compressed = header >= 31;

  let pubkey;
  try {
    const s = new secp.Signature(
      bytesToBigInt(sig.slice(1, 33)),
      bytesToBigInt(sig.slice(33, 65)),
      recovery,
    );
    pubkey = s.recoverPublicKey(messageHash(message)).toRawBytes(compressed);
  } catch (e) {
    return { valid: false, reason: `could not recover a key from this signature` };
  }

  const derived = encodeP2WPKH(hash160(pubkey), hrp);

  // Bech32 is case-insensitive: BC1Q... and bc1q... are the same address, and
  // some wallets and QR readers hand back the uppercase form. Comparing raw
  // would reject a correct signature with the words "belongs to a different
  // address", which is both wrong and the worst possible thing to tell someone
  // hunting a mistake. Mixed case is genuinely invalid and stays rejected.
  const raw = String(address).trim();
  const claimed = (raw === raw.toUpperCase() && raw !== raw.toLowerCase())
    ? raw.toLowerCase()
    : raw;

  if (derived !== claimed) {
    return {
      valid: false,
      reason: "this signature belongs to a different address",
      derived,
    };
  }
  return { valid: true, reason: "signature matches the address", derived };
}

function bytesToBigInt(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
