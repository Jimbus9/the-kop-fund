// The relay inbox: how a Crowdlock's register takes in registrations and locks
// posted to public Nostr relays, with no endpoint, account or key in the path.
//
// A member's app signs a record exactly as it would for the join or lock
// endpoint, and posts it to the relays the Crowdlock file names, labelled with
// the Crowdlock's declaration fingerprint. A scheduled job in the Crowdlock's
// own repository collects everything so labelled and puts each record through
// the very same judgement the endpoints use — method/js/append.mjs for a registration,
// method/js/lockrecord.mjs for a lock. Nothing here trusts the relay or the poster:
//
//   * a registration counts only if its Bitcoin signature verifies against the
//     Crowdlock's own statement, which nobody can fake;
//   * a lock counts only if its address rebuilds from its terms, its owner is a
//     member, and confirmed coins are at it on the chain.
//
// The Nostr signature on the wrapping event is transport only: relays check it
// before storing, and nothing here relies on it. Anything that fails is left
// out and tried again next time, which is what lets a lock be posted the
// moment it is sent and be added once it has confirmed.
//
// This file is pure: no network, no clock. The job around it does the fetching.

import { addRegistration } from "./append.mjs";
import { prepareLock, addLock, hrpFor } from "./lockrecord.mjs";

/** The Nostr event kind a Crowdlock record is posted as (a "regular" kind relays store). */
export const RECORD_KIND = 3713;

/** The tag that labels a record with its Crowdlock: the declaration's sha256. */
export const FINGERPRINT_TAG = "x";

/**
 * The content and tags of a Nostr event carrying one record. The caller wraps
 * these in an event and signs it with a throwaway Nostr key.
 *   record: { type: "join", address, signature }
 *        or { type: "lock", owner_pubkey, cosigner_pubkey, locktime, address }
 */
export function recordEventTemplate(record, fingerprint, createdAt) {
  return {
    kind: RECORD_KIND,
    created_at: createdAt,
    tags: [[FINGERPRINT_TAG, fingerprint], ["t", "crowdlock"]],
    content: JSON.stringify({ crowdlock: fingerprint, ...record }),
  };
}

/**
 * Read a record back out of an event, or null if it is not a well-formed
 * record for this Crowdlock. Says nothing yet about whether it is VALID.
 */
export function recordFromEvent(event, fingerprint) {
  if (!event || event.kind !== RECORD_KIND || typeof event.content !== "string") return null;
  if (event.content.length > 2000) return null;
  if (!Array.isArray(event.tags) || !event.tags.some((t) => t[0] === FINGERPRINT_TAG && t[1] === fingerprint)) return null;
  let c;
  try { c = JSON.parse(event.content); } catch { return null; }
  if (!c || c.crowdlock !== fingerprint) return null;
  if (c.type === "join" && typeof c.address === "string" && typeof c.signature === "string") {
    return { type: "join", address: c.address, signature: c.signature };
  }
  if (c.type === "lock" && typeof c.owner_pubkey === "string" && typeof c.cosigner_pubkey === "string"
      && Number.isInteger(c.locktime) && typeof c.address === "string") {
    return { type: "lock", owner_pubkey: c.owner_pubkey, cosigner_pubkey: c.cosigner_pubkey, locktime: c.locktime, address: c.address };
  }
  return null;
}

/**
 * Apply records to a register, oldest first, through the endpoints' own
 * judgement. Returns the new register and what happened to each record.
 *
 *   events          Nostr events from the relays (any order, duplicates fine)
 *   crowdlock       the parsed Crowdlock file
 *   statement       its membership statement
 *   now, today      unix seconds and "YYYY-MM-DD", passed in
 *   confirmedSats   async (address) => confirmed sats at that address
 *
 * Registrations go first, so a member's join and first lock can arrive in the
 * same run. Refusals are reported, never thrown: a record that is not valid
 * today (an unconfirmed lock) may be valid next run.
 */
export async function applyRecords(register, events, { crowdlock, statement, now, today, confirmedSats }) {
  const fingerprint = crowdlock.declaration.sha256;
  const hrp = hrpFor(crowdlock.network);
  const seen = new Set();
  const records = [];
  for (const e of [...events].sort((a, b) => a.created_at - b.created_at || String(a.id).localeCompare(String(b.id)))) {
    const r = recordFromEvent(e, fingerprint);
    if (!r) continue;
    const key = JSON.stringify(r);
    if (seen.has(key)) continue;   // the same record posted twice, or to two relays
    seen.add(key);
    records.push(r);
  }

  let reg = register;
  const outcome = [];
  for (const r of [...records.filter((x) => x.type === "join"), ...records.filter((x) => x.type === "lock")]) {
    if (r.type === "join") {
      const res = addRegistration(reg, r, { statement, today, hrp });
      if (res.ok) { reg = res.register; outcome.push({ added: true, type: "join", n: res.n, address: r.address }); }
      else outcome.push({ added: false, type: "join", address: r.address, reason: res.reason });
    } else {
      const prepared = prepareLock(r, { crowdlock, register: reg, now });
      if (!prepared.ok) { outcome.push({ added: false, type: "lock", address: r.address, reason: prepared.reason }); continue; }
      let sats;
      try { sats = await confirmedSats(prepared.lock.address); }
      catch { outcome.push({ added: false, type: "lock", address: r.address, reason: "could not read the chain" }); continue; }
      const res = addLock(reg, prepared.lock, { confirmedSats: sats, today });
      if (res.ok) {
        reg = res.register;
        const n = reg.members.find((m) => String(m.address).toLowerCase() === prepared.lock.member)?.n;
        outcome.push({ added: true, type: "lock", n, address: prepared.lock.address });
      } else outcome.push({ added: false, type: "lock", address: r.address, reason: res.reason });
    }
  }
  return { register: reg, outcome };
}

// ---------------------------------------------------------------------------
// Announcements: how Crowdlocks are found
//
// A Crowdlock announces itself on its relays — its file's link, name, purpose
// and network — when it is started, and its inbox repeats that weekly so it
// does not fade from relays that prune old posts. The app's Find screen reads
// announcements, loads and checks every Crowdlock they point at, and ranks
// them by committed bitcoin. Anybody may announce anything; an announcement
// only says where to look, so a fake one leads to a file that fails its
// checks, and nothing about money can be faked by announcing.
// ---------------------------------------------------------------------------

export const ANNOUNCE_KIND = 3714;
export const ANNOUNCE_TAG = "crowdlock-announce";
const FILE_LINK = /^https:\/\/[^\s?#]+\.json$/;

/** The Nostr event template announcing a Crowdlock. */
export function announcementTemplate({ url, name, about, network }, createdAt) {
  return {
    kind: ANNOUNCE_KIND,
    created_at: createdAt,
    tags: [["t", ANNOUNCE_TAG], ["r", url]],
    content: JSON.stringify({ url, name, about, network }),
  };
}

/** An announcement read back out of an event, or null if it isn't a well-formed one. */
export function announcementFromEvent(event) {
  if (!event || event.kind !== ANNOUNCE_KIND || typeof event.content !== "string" || event.content.length > 2000) return null;
  let a;
  try { a = JSON.parse(event.content); } catch { return null; }
  if (!a || typeof a.url !== "string" || !FILE_LINK.test(a.url) || a.url.length > 300) return null;
  if (typeof a.name !== "string" || a.name.length === 0 || a.name.length > 120) return null;
  return {
    url: a.url, name: a.name,
    about: typeof a.about === "string" ? a.about.slice(0, 300) : "",
    network: typeof a.network === "string" ? a.network : "",
    at: event.created_at,
  };
}

/** Is a Crowdlock due to be announced again? Weekly, so relays keep it. */
export function announcementDue(lastDate, today) {
  if (!lastDate) return true;
  return (Date.parse(today) - Date.parse(lastDate)) / 86400000 >= 7;
}
