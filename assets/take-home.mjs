// The Take it home page (step 6): connect a Ledger, list every lock on the
// register that belongs to its key, and send home any whose date has passed.
// What it shares with the Lock page is in assets/lock-common.mjs.

import { el, wireShare } from "./shared.mjs";
import { loadPage, setBox, L, same, chainFor, txLink, showFee, chosenRate, connect } from "./lock-common.mjs";
import { lockIsGenuine } from "../js/lockrecord.mjs";

let C = null;          // the Crowdlock file
let REGISTER = null;   // its register

async function load() {
  try {
    const page = await loadPage();
    C = page.crowdlock; REGISTER = page.register;
    if (!page.open) return;
    el("homeLedger").hidden = false;
    showFee("home", el("homeFeeLine"), el("homeFeeRate"), el("homeFeeHelp"));
  } catch (e) {
    el("paramStatus").textContent = "Could not load this Crowdlock's details. Do not send anything until it loads.";
  }
}

el("homeConnect").addEventListener("click", async () => {
  const acc = await connect(el("homeStatus"), el("homeConnect"));
  const list = el("homeLocks");
  list.replaceChildren();
  if (!acc) return;
  // Only records that really are a lock of this Crowdlock owned by this key:
  // the record's own `member` label is not believed.
  const mine = (REGISTER.locks ?? []).filter((l) => { const g = lockIsGenuine(l, { crowdlock: C, register: REGISTER }); return g.ok && same(g.owner, acc.address); });
  if (!mine.length) {
    setBox(el("homeStatus"), "", "No locks found", `Connected as ${acc.address}, but the register has no locks for it. A lock that was never published won't appear here.`);
    return;
  }
  const chain = chainFor();
  let medianTime;
  try { medianTime = await chain.medianTime(); }
  catch (e) { setBox(el("homeStatus"), "bad", "Could not read the network's clock", e.message); return; }

  // One card for each lock: what it holds, and a button if it is ready.
  for (const rec of mine) {
    const card = document.createElement("div"); card.className = "card";
    const h = document.createElement("b"); h.className = "head"; h.textContent = `Opens ${rec.unlocks}`;
    const a = document.createElement("div"); a.className = "address"; a.textContent = rec.address;
    const msg = document.createElement("p"); msg.className = "note";
    const res = document.createElement("div"); res.className = "verdict-live"; res.hidden = true;
    const go = document.createElement("button"); go.className = "btn"; go.type = "button"; go.textContent = "Take it home"; go.hidden = true;
    card.append(h, a, msg, go, res); list.append(card);
    try {
      const lock = {
        address: rec.address, ownerPubkey: rec.owner_pubkey, cosignerPubkey: rec.cosigner_pubkey,
        cosignerXpub: L.xpubForKey(C, rec.cosigner_pubkey), locktime: rec.locktime,
      };
      if (!lock.cosignerXpub) { msg.textContent = "This lock's co-signer has no published xpub, so a Ledger cannot take it home."; continue; }
      const st = await L.lockState({ chain, lock, medianTime });
      if (st.state === "locked") msg.textContent = `${st.confirmed.toLocaleString("en-GB")} sats, still locked. The network's clock has not reached the date yet (it runs about an hour behind real time on real bitcoin).`;
      else if (st.state === "arriving") msg.textContent = "Money is on its way and has not confirmed yet.";
      else if (st.state === "withdrawn") msg.textContent = "Already taken home. Nothing left here.";
      else if (st.state === "empty") msg.textContent = "Nothing was ever sent to this address.";
      else {
        msg.textContent = `${st.confirmed.toLocaleString("en-GB")} sats, ready to come home to ${acc.address}.`;
        go.hidden = false;
        go.addEventListener("click", async () => {
          go.disabled = true;
          try {
            setBox(res, "", "Check your Ledger", "It will ask you to approve this lock's rules if it has not seen them, then the payment home.");
            const built = await L.takeHome({ account: acc, chain, lock, feeRate: await chosenRate(el("homeFeeRate"), chain), medianTime });
            const txid = await chain.broadcast(built.hex);
            setBox(res, "ok", "Sent", `${built.sent.toLocaleString("en-GB")} sats are on their way home, fee ${built.fee.toLocaleString("en-GB")} sats.`);
            txLink(res, txid);
          } catch (e) { setBox(res, "bad", "Nothing was sent", e.message); go.disabled = false; }
        });
      }
    } catch (e) { msg.textContent = `Could not check this lock: ${e.message}`; }
  }
  setBox(el("homeStatus"), "ok", "Connected", `Ledger address ${acc.address}`);
});

load();

wireShare();
