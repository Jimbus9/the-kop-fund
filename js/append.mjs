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
