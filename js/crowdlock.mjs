// Reading and checking a Crowdlock's own file.
//
// Every Crowdlock publishes its parameters in one file, crowdlocks/<name>.json.
// Nothing about any particular Crowdlock — its declaration, its co-signer, its
// minimums — is written into the code. The code reads the file it is pointed
// at, so the same register page and the same lock tools serve every Crowdlock
// alike, including The Kop Fund's.
//
// Everything here is a pure check: no network, no keys, no signing. It runs
// unchanged in a browser and in Node.
//
// See spec/running-your-own.md for what each parameter means.

import { sha256 } from "./vendor/noble-hashes/sha256.js";

const HASH = /^[0-9a-f]{64}$/;
const PUBKEY = /^0[23][0-9a-f]{64}$/; // compressed only, as the lock format requires
// A BIP32 extended public key: xpub on Bitcoin, tpub on its test networks.
const XPUB = /^[xt]pub[1-9A-HJ-NP-Za-km-z]{107}$/;
const NETWORKS = ["mainnet", "testnet4", "signet", "regtest"];

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The declaration's canonical form: UTF-8, NFC, LF, no trailing whitespace, one trailing newline. */
export function canonicalise(raw) {
  return raw.normalize("NFC").replace(/\r\n?/g, "\n").split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n").replace(/\n+$/, "") + "\n";
}

/** SHA-256 of the canonical declaration. This is the Crowdlock's identity. */
export function declarationHash(text) {
  return hex(sha256(new TextEncoder().encode(canonicalise(text))));
}

/** The one line a member signs to join. Same shape for every Crowdlock; only the title, version and hash differ. */
export function membershipStatement(c) {
  const d = c.declaration;
  return `I agree to the ${d.title} v${d.version} (sha256:${d.sha256}) and join as a member.`;
}

/**
 * Check a Crowdlock file is complete and coherent.
 * Pass `declarationText` to also check the declaration really hashes to what the file says.
 * Returns { ok, problems }.
 */
export function checkCrowdlock(c, { declarationText } = {}) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  const posInt = (v) => Number.isInteger(v) && v > 0;

  need(c && typeof c === "object", "the file is not a JSON object");
  if (problems.length) return { ok: false, problems };

  need(c.format === 1, "format must be 1");
  need(typeof c.name === "string" && c.name.trim() !== "", "name is missing");

  const d = c.declaration ?? {};
  need(typeof d.title === "string" && d.title.trim() !== "", "declaration.title is missing");
  need(!/[()\n]/.test(d.title ?? ""), "declaration.title may not contain brackets or a newline — it goes inside the signed statement");
  need(posInt(d.version), "declaration.version must be a whole number from 1");
  need(typeof d.file === "string" && d.file !== "", "declaration.file is missing");
  need(HASH.test(d.sha256 ?? ""), "declaration.sha256 must be 64 lowercase hex characters");
  if (declarationText !== undefined && HASH.test(d.sha256 ?? "")) {
    const got = declarationHash(declarationText);
    need(got === d.sha256, `the declaration hashes to ${got.slice(0, 12)}…, but the file says ${d.sha256.slice(0, 12)}…`);
  }

  need(NETWORKS.includes(c.network), `network must be one of ${NETWORKS.join(", ")}`);
  need(c.unit === "BTC", "unit must be BTC");

  // Whole years on real bitcoin. A test Crowdlock may offer fractions of a
  // year — an hour, a day — so a lock can be made and taken home in one sitting.
  const lengthOk = c.network === "mainnet" ? posInt : (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
  need(Array.isArray(c.lock_lengths_years) && c.lock_lengths_years.length > 0 && c.lock_lengths_years.every(lengthOk),
    c.network === "mainnet"
      ? "lock_lengths_years must be a list of whole numbers of years"
      : "lock_lengths_years must be a list of positive numbers of years");
  need(Number.isInteger(c.minimum_counted_lock_sats) && c.minimum_counted_lock_sats >= 0,
    "minimum_counted_lock_sats must be a whole number of sats");

  for (const k of ["gathering_window_max_days", "settlement_window_max_days"]) {
    need(posInt(c[k]), `${k} must be a whole number of days`);
  }
  // How long a destination must be public before a proposal may name it: the
  // real protection while there are few attestors. Each Crowdlock chooses its
  // own (spec/running-your-own.md recommends at least seven days on real
  // bitcoin); none is allowed, so a test copy can try a proposal at once.
  need(Number.isInteger(c.destination_wait_days) && c.destination_wait_days >= 0,
    "destination_wait_days must be a whole number of days");

  for (const k of ["cosigner_keys", "attestor_keys"]) {
    const keys = c[k];
    need(Array.isArray(keys), `${k} must be a list (empty until chosen)`);
    if (!Array.isArray(keys)) continue;
    keys.forEach((key, i) => need(PUBKEY.test(key), `${k}[${i}] is not a compressed public key`));
    need(new Set(keys.map((x) => x.slice(2))).size === keys.length, `${k} lists the same key twice`);
  }
  if (Array.isArray(c.cosigner_keys) && Array.isArray(c.attestor_keys)) {
    // Compared on the x-coordinate, so a key's mirror is caught too.
    const cos = new Set(c.cosigner_keys.map((x) => x.slice(2)));
    need(!c.attestor_keys.some((x) => cos.has(x.slice(2))),
      "a key is both co-signer and attestor — the key that approves a destination must never be a key that spends to it");
  }

  // Optional. Each co-signer key's xpub — the account (m/84'/0'/0' for a key
  // made the standard way) whose first key, /0/0, is that co-signer key.
  // Hardware wallets need it: a Ledger will only sign for a lock whose keys it
  // is given as xpubs, then works out the plain key itself. Only its form is
  // checked here; that it really makes a listed key is checked by the app and
  // the repository's tests, which have the arithmetic for it.
  if (c.cosigner_xpubs !== undefined) {
    const xs = c.cosigner_xpubs;
    need(Array.isArray(xs), "cosigner_xpubs must be a list of xpubs");
    if (Array.isArray(xs)) {
      xs.forEach((x, i) => need(XPUB.test(x), `cosigner_xpubs[${i}] is not an xpub`));
      need(new Set(xs).size === xs.length, "cosigner_xpubs lists the same xpub twice");
      need(xs.length <= (c.cosigner_keys?.length ?? 0), "cosigner_xpubs has more xpubs than there are co-signer keys");
    }
  }

  need(posInt(c.attestor_threshold), "attestor_threshold must be a whole number from 1");
  if (Array.isArray(c.attestor_keys) && c.attestor_keys.length > 0) {
    need(c.attestor_threshold <= c.attestor_keys.length, "attestor_threshold is more than the number of attestors");
  }

  need(typeof c.max_commitment_fee === "number" && c.max_commitment_fee > 0 && c.max_commitment_fee < 1,
    "max_commitment_fee must be a fraction between 0 and 1");

  need(typeof c.register?.registrations === "string" && typeof c.register?.destinations === "string",
    "register must name the registrations and destinations files");
  // Optional: where the Crowdlock publishes its proposals (method/js/proposals.mjs).
  need(c.register?.proposals === undefined || (typeof c.register.proposals === "string" && /\.json$/.test(c.register.proposals)),
    "register.proposals, if given, must name a .json file");
  need(typeof c.chain_api === "string" && /^https:\/\//.test(c.chain_api), "chain_api must be an https address");
  // Optional. Where this Crowdlock accepts signed registrations. Leaving it out
  // is allowed — joining by pull request needs no endpoint — but if it is
  // given it must be a plain https address, because clients post signatures
  // to it and an app reads it straight from this file.
  // lock_endpoint is the same idea for locks: optional, https if given.
  for (const k of ["join_endpoint", "lock_endpoint"]) {
    if (c[k] !== undefined) {
      need(typeof c[k] === "string" && /^https:\/\/[^\s]+$/.test(c[k]) && c[k].length <= 200,
        `${k}, if given, must be an https address`);
    }
  }

  // Optional. The page to send people to when this Crowdlock is shared — its
  // front page or joining page. Without it, apps share the site the file
  // sits in.
  if (c.site !== undefined) {
    need(typeof c.site === "string" && /^https:\/\/[^\s]+$/.test(c.site) && c.site.length <= 200, "site, if given, must be an https address");
  }

  // Optional. Public Nostr relays where members post signed registrations and
  // locks, for the Crowdlock's own repository to collect (method/js/inbox.mjs). No
  // account, no server and no key of anybody's sits in that path.
  if (c.relays !== undefined) {
    need(Array.isArray(c.relays) && c.relays.length > 0 && c.relays.length <= 10
      && c.relays.every((r) => typeof r === "string" && /^wss:\/\/[^\s]+$/.test(r) && r.length <= 200),
      "relays, if given, must be a list of up to 10 wss:// addresses");
  }
  // Optional, published in advance: relays that replace a live one which has
  // been silent for 7 days (method/relay/inbox.mjs). Chosen now, in public, so nobody
  // picks a relay on the day.
  if (c.spare_relays !== undefined) {
    need(Array.isArray(c.relays), "spare_relays needs relays");
    need(Array.isArray(c.spare_relays) && c.spare_relays.length <= 10
      && c.spare_relays.every((r) => typeof r === "string" && /^wss:\/\/[^\s]+$/.test(r) && r.length <= 200),
      "spare_relays, if given, must be a list of up to 10 wss:// addresses");
    if (Array.isArray(c.relays) && Array.isArray(c.spare_relays)) {
      need(!c.spare_relays.some((r) => c.relays.includes(r)), "a relay is listed as both live and spare");
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Check a Crowdlock's register files agree with its own file. Catches the two
 * drifting apart — a register naming one declaration while the Crowdlock names
 * another. Returns { ok, problems }.
 */
export function checkRegisterFiles(c, { registrations, destinations }) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };

  if (registrations) {
    need(registrations.declaration?.sha256 === c.declaration.sha256,
      "the registrations file names a different declaration from this Crowdlock");
    if (registrations.declaration?.statement !== undefined) {
      need(registrations.declaration.statement === membershipStatement(c),
        "the registrations file's signing statement is not this Crowdlock's");
    }
  }
  if (destinations) {
    need(destinations.instance === c.declaration.sha256,
      "the destinations file belongs to a different Crowdlock");
    need(destinations.minimum_age_days === c.destination_wait_days,
      "the destinations file's waiting period disagrees with destination_wait_days");
    need(destinations.threshold === c.attestor_threshold,
      "the destinations file's threshold disagrees with attestor_threshold");
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Check several Crowdlocks published side by side can never be confused.
 *
 * Two may not share a declaration (that is their identity), and two may not
 * share a co-signer key: a lock is counted by whichever Crowdlock names its
 * co-signer, so a shared key would let one coin be counted twice.
 * Returns { ok, problems }.
 */
export function checkSeparate(crowdlocks) {
  const problems = [];
  const seenDecl = new Map();
  const seenKey = new Map();
  for (const c of crowdlocks) {
    const other = seenDecl.get(c.declaration?.sha256);
    if (other) problems.push(`${c.name} and ${other} share a declaration`);
    else seenDecl.set(c.declaration?.sha256, c.name);

    for (const k of c.cosigner_keys ?? []) {
      const x = k.slice(2);
      const owner = seenKey.get(x);
      if (owner && owner !== c.name) problems.push(`${c.name} and ${owner} share a co-signer key`);
      else seenKey.set(x, c.name);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Does a lock with this co-signer key belong to this Crowdlock? */
export function isCosignerOf(c, cosignerPubkeyHex) {
  const x = String(cosignerPubkeyHex).toLowerCase().slice(2);
  return (c.cosigner_keys ?? []).some((k) => k.slice(2) === x);
}
