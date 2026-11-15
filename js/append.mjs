// Deciding whether a submission may join the register, and what the register
// looks like afterwards.
//
// This is the whole judgement of the join endpoint, kept deliberately apart
// from the network code that surrounds it. It touches nothing outside itself:
// no fetch, no clock, no environment. That is what lets it be tested properly,
// and the network shell around it stays thin enough to read in one sitting.
//
// What it is allowed to decide is narrow by design. It cannot create a member
// who did not sign, because it cannot produce a signature. It can only accept
// a valid one, refuse an invalid one, or refuse a duplicate.

import { verifyMembership } from "./verify.mjs";
import { versionsOf, membershipStatement, hasSigned, joinedVersion } from "./crowdlock.mjs";

/** Addresses are compared in canonical lower case; bech32 is case-insensitive. */
function normalise(address) {
  const raw = String(address ?? "").trim();
  return raw === raw.toUpperCase() && raw !== raw.toLowerCase() ? raw.toLowerCase() : raw;
}

/**
 * Would this submission join the register, and what would the register become?
 *
 * register   the parsed registrations.json as it stands
 * submission { address, signature } as received, untrusted
 * statement  the exact membership statement, rebuilt from the Crowdlock file
 * today      "YYYY-MM-DD", passed in rather than read from a clock
 * hrp        address prefix of the Crowdlock's network: "bc" (default), or
 *            "tb" for a test Crowdlock on testnet4 or signet
 *
 * Returns { ok, status, reason, n, register } — `register` is a new object,
 * never the one passed in, so a refusal cannot leave a half-changed register
 * behind.
 */
export function addRegistration(register, submission, { statement, today, hrp = "bc" }) {
  const no = (status, reason) => ({ ok: false, status, reason });

  if (!register || typeof register !== "object" || !Array.isArray(register.members)) {
    return no(500, "the register file is not in the expected shape");
  }

  const address = normalise(submission?.address);
  const signature = String(submission?.signature ?? "").trim();

  if (!address || !signature) return no(400, "send both an address and a signature");

  // Generous, but bounded. A real address is ~42 characters and a real
  // signature is 88; anything far larger is somebody probing, and there is no
  // reason to hand it to the verifier.
  if (address.length > 120) return no(400, "that is not an address");
  if (signature.length > 200) return no(400, "that is not a signature");

  // The signature is checked before anything else is considered, including
  // whether the address is already a member. An unsigned submission learns
  // nothing about the register.
  const result = verifyMembership({ address, signature, message: statement, hrp });
  if (!result.valid) {
    return no(400, result.derived
      ? `${result.reason} — this signature belongs to ${result.derived}`
      : result.reason);
  }

  if (register.members.some((m) => normalise(m.address) === address)) {
    return no(409, "that address is already on the register");
  }

  // Numbers record arrival order and nothing else, so the next one is simply
  // one past the highest. Derived from the file rather than from its length,
  // so a hand-edited register cannot silently reuse a number.
  const highest = register.members.reduce((max, m) => Math.max(max, Number(m.n) || 0), 0);
  const n = highest + 1;

  return {
    ok: true,
    status: 200,
    n,
    register: {
      ...register,
      members: [...register.members, { n, address, signature, signed: today }],
    },
  };
}

/**
 * A signature posted for this Crowdlock, whichever version of its declaration
 * it signs. Two things it can be:
 *
 *   * a new member joining: they must sign the current version, and join
 *     with it (recorded as `version` when it is not the founding one);
 *   * an existing member signing a version they have not signed yet: added
 *     to their `also_signed`. Their number, their earlier signature and their
 *     locks are untouched; a signature is never read as agreeing to any
 *     version but the one it names.
 *
 * crowdlock  the parsed Crowdlock file (its versions are read from it)
 * Other arguments as addRegistration. Returns as addRegistration, plus
 * `version` (the version signed) and `resigned` (true for an existing member).
 */
export function addSignature(register, submission, { crowdlock, today, hrp = "bc" }) {
  const no = (status, reason) => ({ ok: false, status, reason });
  if (!register || typeof register !== "object" || !Array.isArray(register.members)) {
    return no(500, "the register file is not in the expected shape");
  }
  const address = normalise(submission?.address);
  const signature = String(submission?.signature ?? "").trim();
  if (!address || !signature) return no(400, "send both an address and a signature");
  if (address.length > 120) return no(400, "that is not an address");
  if (signature.length > 200) return no(400, "that is not a signature");

  // Which version does it sign? Newest first, so a join is matched against
  // the current version before any other. As in addRegistration, nothing
  // about the register is looked at until a signature verifies.
  const versions = versionsOf(crowdlock).slice().reverse();
  const current = versions[0];
  let signed = null, firstRefusal = null;
  for (const v of versions) {
    const result = verifyMembership({ address, signature, message: membershipStatement(crowdlock, v.version), hrp });
    if (result.valid) { signed = v; break; }
    if (!firstRefusal) firstRefusal = result;
  }
  if (!signed) {
    return no(400, firstRefusal.derived
      ? `${firstRefusal.reason} — this signature belongs to ${firstRefusal.derived}`
      : firstRefusal.reason);
  }

  const member = register.members.find((m) => normalise(m.address) === address);
  if (!member) {
    if (signed.version !== current.version) {
      return no(400, `that signs version ${signed.version} of the declaration; to join, sign the current one, version ${current.version}`);
    }
    const highest = register.members.reduce((max, m) => Math.max(max, Number(m.n) || 0), 0);
    const n = highest + 1;
    const record = { n, address, signature, signed: today };
    if (signed.version !== crowdlock.declaration.version) record.version = signed.version;
    return { ok: true, status: 200, n, version: signed.version, resigned: false,
      register: { ...register, members: [...register.members, record] } };
  }

  if (hasSigned(crowdlock, member, signed.version)) {
    return no(409, signed.version === joinedVersion(crowdlock, member)
      ? "that address is already on the register"
      : `that member has already signed version ${signed.version}`);
  }
  const also = [...(Array.isArray(member.also_signed) ? member.also_signed : []), { version: signed.version, signature, signed: today }]
    .sort((a, b) => a.version - b.version);
  return {
    ok: true, status: 200, n: member.n, version: signed.version, resigned: true,
    register: { ...register, members: register.members.map((m) => (m === member ? { ...m, also_signed: also } : m)) },
  };
}
