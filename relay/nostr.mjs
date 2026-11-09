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

/** Every record event for this fingerprint since `since`, from all relays, deduplicated by id. */
export async function fetchRecords(relays, fingerprint, since) {
  const byId = new Map();
  const report = await Promise.all(relays.map(async (url) => {
    try {
      const relay = await connectRelay(url);
      try {
        let count = 0;
        await withTimeout(new Promise((resolve) => {
          const sub = relay.subscribe([{ kinds: [RECORD_KIND], [`#${FINGERPRINT_TAG}`]: [fingerprint], since, limit: 1000 }], {
            onevent(e) { count++; byId.set(e.id, e); },
            oneose() { sub.close(); resolve(); },
          });
        }), TIMEOUT, "reading");
        return { relay: url, ok: true, count };
      } finally { relay.close(); }
    } catch (e) { return { relay: url, ok: false, reason: String(e.message ?? e) }; }
  }));
  return { events: [...byId.values()], report };
}
