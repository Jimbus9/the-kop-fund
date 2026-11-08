// Keeping a Crowdlock's relays alive. Pure: no network, no clock.
//
// Each pass of the inbox reports which relays answered. This records, per
// relay, the day it last answered — and nothing else that moves. A relay that
// has not answered for SILENT_DAYS is swapped for the first spare the
// Crowdlock file published in advance, in a commit saying which relay went,
// when it last answered, and what replaced it.
//
// A pass in which NO relay answered says nothing about the relays — far more
// likely the job's own connection — so it changes nothing.
//
// WHY THERE IS NO "silentSince" ANY MORE. There was, and it was wrong twice
// over. It was set on the first failed pass and cleared on the next good one,
// so a relay answering intermittently flipped it several times an hour: 117
// of this repository's first 223 commits were that one field changing, over
// half the history, burying every real commit in it. And because any single
// good pass reset the clock, a relay failing nine passes in ten never
// accumulated seven CONSECUTIVE silent days, so the rule could only ever
// catch a relay that was completely dead — the rarer failure, and the one
// least in need of catching.
//
// Measuring from the day a relay last answered fixes both at once. The field
// only moves forward, and only to today, so a relay can change the record at
// most once a day; and "silent for seven days" now means what it says.
//
// `since` is the day a relay entered the record, written once and never
// changed. It exists for the relay that has never answered at all, which has
// no lastAnswered to measure from and would otherwise sit there forever.

export const SILENT_DAYS = 7;

const DAY = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/** The day a relay's silence is counted from, answered or not. */
export function silentFrom(entry) {
  return entry?.lastAnswered ?? entry?.since ?? null;
}

/** How many days a relay has been silent, or null if it is not being watched. */
export function daysSilent(entry, today) {
  const from = silentFrom(entry);
  return from === null ? null : daysBetween(from, today);
}

/**
 * Record one pass.
 *   health   { [relay]: { lastAnswered, since } } — dates "YYYY-MM-DD"
 *   report   [{ relay, ok }] from the pass
 * Returns the new health record, or the same object if nothing changed.
 */
export function recordPass(health, report, today) {
  if (!report.some((r) => r.ok)) return health;

  let changed = false;
  const next = { ...health };

  for (const { relay, ok } of report) {
    const was = health[relay];
    // Records written before this module dropped silentSince carry it. Drop
    // it on the first pass that touches them, and anchor `since` to whatever
    // that record already knew, so no relay's history restarts at today.
    const since = was?.since ?? was?.lastAnswered ?? was?.silentSince ?? today;
    const lastAnswered = ok ? today : (was?.lastAnswered ?? null);
    const now = { lastAnswered, since };

    if (!was
      || was.lastAnswered !== now.lastAnswered
      || was.since !== now.since
      || "silentSince" in was) {
      next[relay] = now;
      changed = true;
    }
  }

  return changed ? next : health;
}

/**
 * Swap out relays silent for SILENT_DAYS or more, in the order listed, each
 * for the next unused spare. Returns { crowdlock, health, swaps, stuck } —
 * `stuck` lists silent relays with no spare left to replace them.
 */
export function planSwaps(crowdlock, health, today) {
  const relays = [...(crowdlock.relays ?? [])];
  const spares = [...(crowdlock.spare_relays ?? [])];
  const swaps = [], stuck = [];
  const nextHealth = { ...health };

  relays.forEach((relay, i) => {
    const silent = daysSilent(health[relay], today);
    if (silent === null || silent < SILENT_DAYS) return;

    const replacement = spares.shift();
    if (!replacement) { stuck.push(relay); return; }

    relays[i] = replacement;
    delete nextHealth[relay];
    swaps.push({
      out: relay,
      in: replacement,
      lastAnswered: health[relay]?.lastAnswered ?? null,
      days: silent,
    });
  });

  if (swaps.length === 0) return { crowdlock, health, swaps, stuck };
  const next = { ...crowdlock, relays };
  if (crowdlock.spare_relays) next.spare_relays = spares;
  return { crowdlock: next, health: nextHealth, swaps, stuck };
}
