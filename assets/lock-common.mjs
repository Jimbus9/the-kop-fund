// What the Lock page (step 4) and the Take it home page (step 6) share:
// loading the Crowdlock and its register, whether the page is open for this
// network, and talking to a Ledger. Written once, so a fix reaches both pages.
// Each page's own part is in assets/lock.mjs and assets/take-home.mjs.
//
// The signing code is the Crowdlock app's own, bundled (js/vendor/
// crowdlock-ledger-web.bundle.js, built from method/ledger-web in the method's
// repository). These pages only ask the questions and show the answers.

import { el, loadCrowdlock } from "./shared.mjs";

// Networks these two pages are open for. A real-money network is added here,
// in this one line, only after the outside review of the code, and on the
// founder's say-so. Until then they are closed.
const OPEN_NETWORKS = new Set(["testnet4"]);

export const L = globalThis.CrowdlockLedger;

let C = null;   // the Crowdlock file, once loadPage() has it

/**
 * Load the Crowdlock this page is about and its register, and show which one
 * it is. On a network these pages are closed for, the "not open" box is shown.
 * Throws if anything cannot be loaded.
 *
 * Returns { crowdlock, register, open }.
 */
export async function loadPage() {
  const { c, base } = await loadCrowdlock();
  C = c;
  const register = await (await fetch(`${base}${C.register.registrations}`)).json();

  el("paramStatus").textContent = `${C.name} · ${C.network}`;
  if (C.network !== "mainnet") el("testnote").hidden = false;

  const open = OPEN_NETWORKS.has(C.network);
  if (!open) {
    el("closed").hidden = false;
    el("closedWhy").textContent =
      "Locking real bitcoin from this page opens after an outside review of the code. "
      + "Nobody outside the project has checked it yet.";
  }
  return { crowdlock: C, register, open };
}

/** Fill a result box: a bold heading and a line, coloured by kind ("ok", "bad" or ""). */
export function setBox(box, kind, head, body) {
  box.hidden = false;
  box.className = "verdict-live" + (kind ? " " + kind : "");
  box.replaceChildren();
  const b = document.createElement("b"); b.textContent = head;
  const p = document.createElement("p"); p.textContent = body;
  box.append(b, p);
}

export const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const fmt = (n) => Number(n).toLocaleString("en-GB");

// --- The chain ---------------------------------------------------------------

export const chainFor = () => L.esploraChain(C.chain_api, undefined, undefined, { minFee: feeFloor() });
const explorer = () => C.chain_api.replace(/\/api$/, "");

/** Add a "See it on the block explorer" link for a payment to a result box. */
export function txLink(box, txid) {
  const a = document.createElement("a");
  a.href = `${explorer()}/tx/${txid}`; a.textContent = "See it on the block explorer"; a.target = "_blank"; a.rel = "noopener";
  const p = document.createElement("p"); p.append(a); box.append(p);
}

// --- Fee rate ----------------------------------------------------------------
// Left blank, the page uses the network's current estimate (never below the
// floor). A typed rate must sit between the floor and a ceiling so a typo
// can't burn the money. The Ledger shows the exact fee before you approve.

const feeFloor = () => (C.network === "mainnet" ? 1 : 5);
const feeCeiling = (est) => Math.max(50, est * 10);
const VBYTES = { lock: 153, home: 122 };   // typical sizes, for the estimate line only

/** Show the estimated fee for a lock or a payment home, and keep it up to date as a rate is typed. */
export async function showFee(kind, line, rateInput, help) {
  try {
    const est = await chainFor().feeRate();
    rateInput.placeholder = String(est);
    help.textContent = `Blank uses the current estimate, ${fmt(est)} sat/vB. Allowed: ${feeFloor()} to ${fmt(feeCeiling(est))}. A lower rate is cheaper but can take longer to confirm.`;
    const update = () => {
      const r = rateInput.value.trim() ? Number(rateInput.value.trim()) : est;
      line.textContent = Number.isFinite(r) && r > 0
        ? `Estimated network fee: about ${fmt(Math.ceil(VBYTES[kind] * r))} sats (${fmt(r)} sat/vB). It comes out of the amount. The Ledger shows the exact fee.`
        : "";
    };
    rateInput.oninput = update; update();
  } catch { line.textContent = ""; }
}

/** The rate to use: the typed one if it is allowed, the estimate if the box is blank. Throws a plain message otherwise. */
export async function chosenRate(rateInput, chain) {
  const est = await chain.feeRate();
  const raw = rateInput.value.trim();
  if (!raw) return est;
  if (!/^[0-9]+$/.test(raw)) throw new Error("The fee rate must be a whole number of sats per vbyte, or blank.");
  const r = Number(raw), max = feeCeiling(est);
  if (r < feeFloor()) throw new Error(`That fee rate is too low to confirm. The lowest allowed is ${feeFloor()} sat/vB.`);
  if (r > max) throw new Error(`That fee rate looks like a typo. The highest allowed is ${fmt(max)} sat/vB (the estimate now is ${fmt(est)}).`);
  return r;
}

// --- The Ledger --------------------------------------------------------------

/** Connect a Ledger and show how it went in statusBox. Returns its account, or null. */
export async function connect(statusBox, btn) {
  if (!L || !L.supported()) {
    setBox(statusBox, "bad", "This browser can't talk to a Ledger", "Use Chrome, Edge or Brave on a computer. Phones and Firefox and Safari don't allow it.");
    return null;
  }
  btn.disabled = true;
  setBox(statusBox, "", "Connecting", "Choose your Ledger when the browser asks, then look at the Ledger.");
  try {
    const account = await L.connectLedger(C.network);
    setBox(statusBox, "ok", "Connected", `Ledger address ${account.address}`);
    return account;
  } catch (e) {
    setBox(statusBox, "bad", "Could not connect", e.message);
    return null;
  } finally { btn.disabled = false; }
}
