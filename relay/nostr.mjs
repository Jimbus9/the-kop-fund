// Talking to Nostr relays, through nostr-tools — the standard library — so we
// write none of the event signing or relay protocol ourselves. Used by the
// inbox job and its self-test. The app has its own copy of the posting half.

import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { Relay, useWebSocketImplementation } from "nostr-tools/relay";
import { recordEventTemplate, RECORD_KIND, FINGERPRINT_TAG } from "../js/inbox.mjs";

const TIMEOUT = 15000;
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

// Two faults in nostr-tools 2.25.2 that we work around here, because every
// failed relay connection hit them.
//
// 1. Its error handler closes the socket, and Node's WebSocket fires the error
//    event again from inside that close, which runs the handler again. That
//    repeats until the stack overflows ("Maximum call stack size exceeded").
//    A guard stops a close from re-entering itself.
useWebSocketImplementation(class extends WebSocket {
  #closing = false;
  close(...args) {
    if (this.#closing) return;
    this.#closing = true;
    try { return super.close(...args); } finally { this.#closing = false; }
  }
});

// 2. Racing a connection against a timeout leaves the connection running after
//    the timeout has been reported. If it then fails, nothing is listening, so
//    the failure surfaces as an unhandled rejection. A connection that arrives
//    after its timeout is closed at once, so it cannot keep retrying behind us.
async function connectRelay(url, timeout = TIMEOUT) {
  let gaveUp = false;
  const connecting = Relay.connect(url).then(
    (relay) => { if (gaveUp) relay.close(); else return relay; },
    (e) => { if (!gaveUp) throw e; },
  );
  let timer;
  const timedOut = new Promise((_, rej) => { timer = setTimeout(() => { gaveUp = true; rej(new Error("connecting timed out")); }, timeout); });
  try { return await Promise.race([connecting, timedOut]); }
  finally { clearTimeout(timer); }
}

/** Post any event template to every relay with a throwaway key. Returns { relay, ok, reason } for each. */
export async function postTemplate(relays, template) {
  const event = finalizeEvent(template, generateSecretKey());
  return Promise.all(relays.map(async (url) => {
    try {
      const relay = await connectRelay(url);
      try { await withTimeout(relay.publish(event), TIMEOUT, "posting"); return { relay: url, ok: true }; }
      finally { relay.close(); }
    } catch (e) { return { relay: url, ok: false, reason: String(e.message ?? e) }; }
  }));
}

/**
 * Post one record to every relay, signed with a throwaway Nostr key (the
 * record's own Bitcoin signature, or the chain, is what makes it count).
 * Returns { relay, ok, reason } for each.
 */
export async function postRecord(relays, record, fingerprint) {
  const event = finalizeEvent(recordEventTemplate(record, fingerprint, Math.floor(Date.now() / 1000)), generateSecretKey());
  return Promise.all(relays.map(async (url) => {
    try {
      const relay = await connectRelay(url);
      try { await withTimeout(relay.publish(event), TIMEOUT, "posting"); return { relay: url, ok: true }; }
      finally { relay.close(); }
    } catch (e) { return { relay: url, ok: false, reason: String(e.message ?? e) }; }
  }));
}

// How far one pass reads back on one relay: a batch at a time, newest first.
const PAGE = 1000;         // records asked for at a time (a relay may give fewer)
const MAX_PAGES = 60;      // batches from one relay in one pass
const READ_BUDGET = 90000; // milliseconds on one relay in one pass

/**
 * Read a relay's records from the newest back to `since`, a batch at a time.
 *
 * One batch is not enough. A relay answers with its newest few hundred
 * records, so somebody posting junk under a Crowdlock's fingerprint could keep
 * real registrations and locks out of sight. This keeps asking for older
 * records until the relay has none left in the window.
 *
 * `ask({ since, until, limit })` resolves to one batch of events. `until`
 * includes its own second, so that second is asked for again in case the batch
 * was cut off inside it, and stepped past once it brings nothing new. (More
 * records in one second than a relay gives in a batch cannot all be read.)
 *
 * Returns { events, complete }. `complete` is false when it stopped early: at
 * a limit above, because a later batch failed, or because the relay ignored
 * `until`. Only a failure of the first batch is thrown.
 */
export async function readBack(ask, since, { limit = PAGE, maxPages = MAX_PAGES, budget = READ_BUDGET, from = undefined } = {}) {
  const byId = new Map();
  // `reached`: how far back it got, for a later pass to carry on from.
  // `saturated`: a second held more records than the relay gives at once, so
  // some of that second could not be read. Paging is by time only, so they
  // can't be reached; the read is then never called complete.
  let saturated = false, biggest = 0;
  // `paged`: every page back to `since` was read; `reached` is where to carry on if not.
  const done = (paged) => ({ events: [...byId.values()], complete: paged && !saturated, saturated, reached: paged ? null : until ?? null });
  const started = Date.now();
  let until = from, stale = 0;
  for (let page = 0; page < maxPages; page++) {
    if (Date.now() - started > budget) return done(false);
    let batch;
    try { batch = await ask({ since, ...(until === undefined ? {} : { until }), limit }); }
    catch (e) { if (page === 0) throw e; return done(false); }
    if (batch.length === 0) return done(true);
    let fresh = 0, oldest = Infinity;
    for (const e of batch) {
      if (!byId.has(e.id)) { byId.set(e.id, e); fresh++; }
      if (e.created_at < oldest) oldest = e.created_at;
    }
    // Nothing new, and as many as the relay has ever given at once: the whole
    // batch is one second (the one `until` asked again for), and it may hold more.
    if (fresh === 0 && batch.length >= biggest && batch.length > 1) saturated = true;
    if (batch.length > biggest) biggest = batch.length;
    stale = fresh === 0 ? stale + 1 : 0;
    if (stale === 2) return done(false);   // the same records twice running: this relay is not honouring `until`
    until = fresh === 0 ? oldest - 1 : oldest;
    if (until < since) return done(true);
  }
  return done(false);
}

/**
 * One pass over one relay: the newest records first, with half the reading,
 * then on from `saved` (how far back an earlier pass got) or from where this
 * pass stopped, whichever is further back, with the other half.
 * Returns { events, complete, cursor }: `cursor` is where to carry on next
 * pass, or null when nothing is left unread.
 */
export async function readRelay(ask, since, saved, { maxPages = MAX_PAGES, budget = READ_BUDGET, limit = PAGE } = {}) {
  const half = { limit, maxPages: Math.ceil(maxPages / 2), budget: budget / 2 };
  const fresh = await readBack(ask, since, half);
  if (fresh.reached === null) return { events: fresh.events, complete: fresh.complete, saturated: fresh.saturated, cursor: null };
  const from = Number.isInteger(saved) && saved >= since && saved < fresh.reached ? saved : fresh.reached;
  const more = await readBack(ask, since, { ...half, from }).catch(() => ({ events: [], complete: false, reached: from }));
  const saturated = !!(fresh.saturated || more.saturated);
  return { events: [...fresh.events, ...more.events], complete: more.complete && !saturated, saturated, cursor: more.reached };
}

/**
 * Every record event for this fingerprint since `since`, from all relays, deduplicated by id.
 *
 * `cursors` ({ relay: seconds }) is how far back an earlier pass got on each
 * relay without finishing. Each pass reads the newest records first, with half
 * its reading, then carries on from the cursor with the other half, so a flood
 * of new junk can delay an older record but not hide it for ever. Until
 * 17 November 2026 every pass started again from the newest, and enough junk
 * hid older records from every pass. The new cursors are returned.
 */
export async function fetchRecords(relays, fingerprint, since, { cursors = {} } = {}) {
  const nextCursors = {};
  const byId = new Map();
  const report = await Promise.all(relays.map(async (url) => {
    try {
      const relay = await connectRelay(url);
      try {
        const ask = (range) => withTimeout(new Promise((resolve) => {
          const got = [];
          const sub = relay.subscribe([{ kinds: [RECORD_KIND], [`#${FINGERPRINT_TAG}`]: [fingerprint], ...range }], {
            onevent(e) { got.push(e); },
            oneose() { sub.close(); resolve(got); },
          });
        }), TIMEOUT, "reading");
        const r = await readRelay(ask, since, cursors?.[url]);
        for (const e of r.events) byId.set(e.id, e);
        const complete = r.complete;
        if (r.cursor !== null) nextCursors[url] = r.cursor;
        return { relay: url, ok: true, count: r.events.length, complete, saturated: !!r.saturated };
      } finally { relay.close(); }
    } catch (e) { return { relay: url, ok: false, reason: String(e.message ?? e) }; }
  }));
  return { events: [...byId.values()], report, cursors: nextCursors };
}
