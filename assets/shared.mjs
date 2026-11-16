// Things more than one page needs, written once.
//
// Site-only: the method's code in js/ stays byte for byte the method's, so
// nothing here is copied there.

export const el = (id) => document.getElementById(id);

/**
 * Which Crowdlock this page is about, and where its files live.
 *
 * With nothing in the address it is the first Crowdlock this site lists, which
 * is the real fund. `?c=kop-fund-testnet4` is the method's shared test copy at
 * crowdlock.org, the one the app uses, so a lock made here and one made in the
 * app land on the same register. Any other name is a file in this site's own
 * crowdlocks folder; only a plain file name is accepted.
 *
 * Returns { c, base, name }: the Crowdlock file, the address its other files
 * are relative to, and its name.
 */
export async function loadCrowdlock() {
  const wanted = new URLSearchParams(location.search).get("c");
  let name;
  if (wanted !== null) {
    if (!/^[a-z0-9-]+$/.test(wanted)) throw new Error("that is not a Crowdlock name");
    name = wanted;
  } else {
    name = (await (await fetch("../crowdlocks/index.json")).json()).crowdlocks[0];
  }
  const base = name === "kop-fund-testnet4" ? "https://crowdlock.org/" : "../";
  const c = await (await fetch(`${base}crowdlocks/${name}.json`, { cache: "no-store" })).json();
  return { c, base, name };
}

/**
 * Post one record to a Crowdlock's relays, signed with a throwaway Nostr key
 * (the record's own Bitcoin signature, or the chain, is what makes it count).
 * `template` is the unsigned event from js/inbox.mjs or js/proposals.mjs. A
 * relay that has not answered within 12 seconds counts as not taking it.
 *
 * Returns { accepted, total }: how many relays took it, out of how many.
 */
export async function postToRelays(relays, template) {
  const { finalizeEvent, generateSecretKey, Relay } = globalThis.NostrTools;
  const event = finalizeEvent(template, generateSecretKey());
  const limit = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("no answer")), 12000))]);
  const results = await Promise.all(relays.map(async (url) => {
    let relay;
    try { relay = await limit(Relay.connect(url)); await limit(relay.publish(event)); return true; }
    catch { return false; }
    finally { try { relay?.close(); } catch {} }
  }));
  return { accepted: results.filter(Boolean).length, total: relays.length };
}

/** Copy text, and say so on the button for a moment. */
export async function copyTo(btn, text, done) {
  try { await navigator.clipboard.writeText(text); } catch { return; }
  const was = btn.textContent;
  btn.textContent = done;
  setTimeout(() => { btn.textContent = was; }, 1600);
}
