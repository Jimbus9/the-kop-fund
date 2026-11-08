// Talking to Nostr relays, through nostr-tools — the standard library — so we
// write none of the event signing or relay protocol ourselves. Used by the
// inbox job and its self-test. The app has its own copy of the posting half.

import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { Relay } from "nostr-tools/relay";
import { recordEventTemplate, RECORD_KIND, FINGERPRINT_TAG } from "../js/inbox.mjs";

const TIMEOUT = 15000;
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

/** Post any event template to every relay with a throwaway key. Returns { relay, ok, reason } for each. */
export async function postTemplate(relays, template) {
  const event = finalizeEvent(template, generateSecretKey());
  return Promise.all(relays.map(async (url) => {
    try {
      const relay = await withTimeout(Relay.connect(url), TIMEOUT, "connecting");
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
      const relay = await withTimeout(Relay.connect(url), TIMEOUT, "connecting");
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
      const relay = await withTimeout(Relay.connect(url), TIMEOUT, "connecting");
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
