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

/**
 * "Carry on on a computer": every [data-share] button sends this page to
 * another device through the phone's share sheet, or copies its link where
 * there is no share sheet. The link is the page and its ?c= Crowdlock name,
 * nothing else: no address, amount or anything typed in, because people send
 * links to themselves through messaging apps.
 */
export function wireShare() {
  const c = new URLSearchParams(location.search).get("c");
  const url = location.origin + location.pathname + (c && /^[a-z0-9-]+$/.test(c) ? `?c=${c}` : "");
  for (const btn of document.querySelectorAll("[data-share]")) {
    const msg = btn.parentElement.querySelector("[data-share-msg]");
    btn.addEventListener("click", async () => {
      if (navigator.share) {
        try { await navigator.share({ title: document.title, url }); return; }
        catch (e) { if (e?.name === "AbortError") return; }
      }
      try {
        await navigator.clipboard.writeText(url);
        if (msg) msg.textContent = "Link copied. Send it to yourself and open it on a computer.";
      } catch {
        if (msg) msg.textContent = `Open this on a computer: ${url}`;
      }
    });
  }
}

/**
 * Draws a QR code of `text` into `box` as an SVG, made on this page by the
 * vendored qrcode-generator (no outside service). Dark squares on white with
 * the four-square quiet zone scanners need.
 */
export function drawQr(box, text, qrcode) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), q = 4, size = n + 2 * q;
  let d = "";
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
    if (qr.isDark(r, col)) d += `M${col + q} ${r + q}h1v1h-1z`;
  }
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", size); bg.setAttribute("height", size); bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d); path.setAttribute("fill", "#000");
  svg.append(bg, path);
  box.replaceChildren(svg);
}
