// The Lock page (step 4): work out a member's lock, show its address and its
// terms, publish it to the register, check the bitcoin arrived, and lock
// straight from a Ledger. What it shares with the Take it home page is in
// assets/lock-common.mjs.

import { planLock } from "../js/lockplan.mjs";
import { recordEventTemplate } from "../js/inbox.mjs";
import { el, copyTo, postToRelays } from "./shared.mjs";
import { loadPage, setBox, L, same, chainFor, txLink, showFee, chosenRate, connect } from "./lock-common.mjs";

let C = null;          // the Crowdlock file
let REGISTER = null;   // its register
let YEARS = null;      // the chosen length
let PLAN = null;       // the current plan
let ACCOUNT = null;    // the connected Ledger's account, once it is the member's own key

function lengthLabel(years) {
  const days = years * 365.25;
  if (days < 1) return `${Math.round(days * 24)} hour${Math.round(days * 24) === 1 ? "" : "s"} (test only)`;
  if (years < 1) return `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"} (test only)`;
  return `${years} year${years === 1 ? "" : "s"}`;
}

async function load() {
  try {
    const page = await loadPage();
    C = page.crowdlock; REGISTER = page.register;
    if (!page.open) { el("form").hidden = true; return; }

    el("ledgerAppName").textContent = C.network === "mainnet" ? "Bitcoin" : "Bitcoin Test";
    const box = el("lengths");
    for (const y of C.lock_lengths_years) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = lengthLabel(y); b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => {
        YEARS = y;
        for (const o of box.children) o.setAttribute("aria-pressed", String(o === b));
        update();
      });
      box.append(b);
    }
  } catch (e) {
    el("form").hidden = false;
    el("paramStatus").textContent = "Could not load this Crowdlock's details. Do not send anything until it loads.";
  }
}

// --- The plan: whose lock, how long, and so which address ---------------------

function update() {
  PLAN = null;
  el("plan").hidden = true; el("publish").hidden = true;
  const member = el("member").value.trim();
  if (!C || !REGISTER) return;
  if (!member || YEARS === null) { setBox(el("verdict"), "", "Waiting", "Say who you are and choose a length."); return; }

  const r = planLock({ crowdlock: C, register: REGISTER, member, years: YEARS, now: Math.floor(Date.now() / 1000) });
  if (!r.ok) { setBox(el("verdict"), "bad", "Not yet", r.reason); return; }
  PLAN = r;

  setBox(el("verdict"), "ok", "Ready",
    `A lock for member ${REGISTER.members.find((m) => m.address === r.member)?.n ?? ""}, `
    + `${lengthLabel(YEARS)}, opening on ${r.unlocks}.`);

  el("address").textContent = r.address;
  const min = r.minimumSats;
  el("amountNote").textContent =
    `This Crowdlock counts a lock of ${min.toLocaleString("en-GB")} sats (${(min / 1e8).toFixed(8)} BTC) or more. `
    + "A smaller lock is valid and published, but is left out of the total. Add a little extra for the network fee your wallet will charge."
    + (r.alreadyOnRegister ? " This exact lock is already on the register, so sending more to it simply adds to it." : "");
  el("terms").textContent = [
    `Crowdlock      ${C.name}`,
    `Network        ${C.network}`,
    `Lock address   ${r.address}`,
    `Owner key      ${r.ownerPubkey}`,
    `Co-signer key  ${r.cosignerPubkey}`,
    `Opens          ${r.unlocks} (unix ${r.locktime})`,
    `Script         <owner> CHECKSIGVERIFY IF <${r.locktime}> CHECKLOCKTIMEVERIFY ELSE <co-signer> CHECKSIG ENDIF`,
  ].join("\n");
  el("plan").hidden = false;
  el("publish").hidden = false;
}

el("member").addEventListener("input", update);
el("copyAddress").addEventListener("click", (e) => PLAN && copyTo(e.target, PLAN.address, "Copied"));
el("copyTerms").addEventListener("click", (e) => copyTo(e.target, el("terms").textContent, "Copied"));

// --- Telling the register -----------------------------------------------------

// Returns the relays' answer, or null if this page cannot publish at all.
async function publishPlan() {
  const btn = el("publishNow");
  if (!PLAN) return null;
  if (!Array.isArray(C.relays) || !C.relays.length || !globalThis.NostrTools) {
    setBox(el("publishResult"), "bad", "Cannot publish from here",
      "This Crowdlock names no relays, or the relay library did not load. Your lock is still real; it can be published another way.");
    return null;
  }
  btn.disabled = true; btn.textContent = "Posting…";
  const p = await postToRelays(C.relays, recordEventTemplate(PLAN.record, C.declaration.sha256, Math.floor(Date.now() / 1000)));
  if (p.accepted > 0) {
    btn.textContent = "Posted";
    setBox(el("publishResult"), "ok", "Posted",
      `${p.accepted} of ${p.total} relays took it. The register collects new records every two minutes and adds the lock once the bitcoin has one confirmation.`);
  } else {
    btn.disabled = false; btn.textContent = "Publish my lock";
    setBox(el("publishResult"), "bad", "No relay took it just now",
      "Check your connection, or turn off any VPN, and try again. Nothing is lost.");
  }
  return p;
}
el("publishNow").addEventListener("click", publishPlan);

// --- Has the bitcoin arrived? -------------------------------------------------

el("checkChain").addEventListener("click", async () => {
  if (!PLAN) return;
  const out = el("chainResult");
  setBox(out, "", "Looking", "Asking the blockchain…");
  try {
    const res = await Promise.race([
      fetch(`${C.chain_api}/address/${PLAN.address}`),
      new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 20000)),
    ]);
    const a = await res.json();
    const confirmed = a.chain_stats.funded_txo_sum - a.chain_stats.spent_txo_sum;
    const waiting = a.mempool_stats.funded_txo_sum - a.mempool_stats.spent_txo_sum;
    if (confirmed > 0) {
      setBox(out, "ok", "Arrived and confirmed", `${confirmed.toLocaleString("en-GB")} sats are locked at this address.`
        + (confirmed < PLAN.minimumSats ? ` That is under the ${PLAN.minimumSats.toLocaleString("en-GB")} sats this Crowdlock counts.` : ""));
    } else if (waiting > 0) {
      setBox(out, "", "On its way", `${waiting.toLocaleString("en-GB")} sats are waiting for their first confirmation.`);
    } else {
      setBox(out, "", "Nothing yet", "No bitcoin has reached this address. If you have just sent it, wait a minute and look again.");
    }
  } catch {
    setBox(out, "bad", "Could not look", "The blockchain service did not answer. Try again, or turn off any VPN.");
  }
});

// --- Locking from a Ledger ----------------------------------------------------

el("ledgerConnect").addEventListener("click", async () => {
  if (!PLAN) return;
  const acc = await connect(el("ledgerStatus"), el("ledgerConnect"));
  ACCOUNT = null;
  if (!acc) return;
  if (!same(acc.address, PLAN.member)) {
    setBox(el("ledgerStatus"), "bad", "Not your member key",
      `This Ledger's address is ${acc.address}, but the member you chose is ${PLAN.member}. A lock belongs to the key that signed the declaration. Nothing was sent.`);
    return;
  }
  ACCOUNT = acc;
  try {
    const coins = (await chainFor().utxos(acc.address)).filter((c) => c.confirmed);
    const total = coins.reduce((s, c) => s + BigInt(c.value), 0n);
    el("ledgerBalance").textContent = `Confirmed bitcoin on this Ledger address: ${total.toLocaleString("en-GB")} sats. The network fee comes out of what you lock.`;
    el("lockSats").value = String(Math.max(PLAN.minimumSats, 0));
    el("ledgerLockRow").hidden = false;
    showFee("lock", el("lockFeeLine"), el("lockFeeRate"), el("lockFeeHelp"));
  } catch (e) {
    setBox(el("ledgerStatus"), "bad", "Could not read the balance", e.message);
  }
});

el("ledgerLock").addEventListener("click", async () => {
  const out = el("ledgerLockResult");
  if (!PLAN || !ACCOUNT) return;
  const raw = el("lockSats").value.trim().replace(/[ ,_]/g, "");
  if (!/^[0-9]+$/.test(raw) || BigInt(raw) <= 0n) { setBox(out, "bad", "How much?", "Type a whole number of sats."); return; }
  const btn = el("ledgerLock");
  btn.disabled = true;
  try {
    const chain = chainFor();
    const feeRate = await chosenRate(el("lockFeeRate"), chain);
    const lock = {
      address: PLAN.address, ownerPubkey: PLAN.ownerPubkey, cosignerPubkey: PLAN.cosignerPubkey,
      cosignerXpub: L.xpubForKey(C, PLAN.cosignerPubkey), locktime: PLAN.locktime,
    };
    setBox(out, "", "Check your Ledger", "It will first ask you to approve this lock's rules, then the payment. Read each on the device.");
    const built = await L.buildLock({ account: ACCOUNT, chain, lock, feeRate, amount: BigInt(raw) });
    const txid = await chain.broadcast(built.hex);
    const sentLine = `${built.sent.toLocaleString("en-GB")} sats are on their way to the lock, fee ${built.fee.toLocaleString("en-GB")} sats.`;
    setBox(out, "ok", "Sent", `${sentLine} Publishing it to the register now…`);
    txLink(out, txid);
    // Publish straight away, so a lock sent from this page is never left uncounted.
    const p = await publishPlan();
    if (p && p.accepted > 0) setBox(out, "ok", "Sent and published", `${sentLine} The register adds it once the bitcoin has one confirmation. Then you are in.`);
    else setBox(out, "bad", "Sent, but not published yet", `${sentLine} Your bitcoin is safe in the lock. Tap "Publish my lock" in part 4 to try again before you leave this page.`);
    txLink(out, txid);
  } catch (e) {
    setBox(out, "bad", "Nothing was sent", e.message);
  } finally { btn.disabled = false; }
});

load();
