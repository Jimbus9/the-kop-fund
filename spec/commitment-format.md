# Commitment format

**Version 2 · 17 November 2026** (version 1: 24 October 2026)

**15 November 2026:** one check added after the eight: the lock's owner must have signed the version of the declaration the proposal was published under.

**17 November 2026, version 2.** Two reviews of the project's own code found that a version-1 commitment could be counted for a proposal its owner never chose, and that one could pass every check and never be payable. So:

- **The payment now names its proposal**, in a last output that carries no money. In version 1 the proposal was named only beside the payment, outside what the owner signed, so a commitment could be relabelled for any other proposal paying the same address, including one published long after the first had failed.
- **Five more things are checked**, all of them things that would keep a payment off the network: the transaction's version, the input's sequence number, a high-S signature, an output too small to be passed on, and a fee too low to be passed on.
- **One coin counts once per proposal** was already the rule; the app and The Kop Fund's website now apply it.
- **The destinations list is checked against the Crowdlock's own file**: its attestors are the ones that file names, and every entry must carry that Crowdlock's fingerprint.

No real commitment had been made under version 1. A version-1 commitment does not verify under version 2.

A commitment is how a supporter backs one specific purchase with their own
locked money. What a proposal is and how it settles is in the **proposal and
settlement format**; this document is the record itself.

## A commitment is not a payment

It is the owner's half of a transaction nobody has broadcast. The coins stay in
the lock, at the same address, with the same balance. The blockchain has no
knowledge that any of this happened.

**The owner's signature alone cannot move their coins.** The lock's purchase exit
requires the owner *and* the co-signer, so a commitment is inert on its own. It
can be published, copied and mirrored freely by anybody; nobody can spend with
it.

## The record

```json
{
  "proposal": "<sha256 of the canonical proposal document>",
  "lock": {
    "address": "bc1q…",
    "owner_pubkey": "<33 bytes, hex>",
    "cosigner_pubkey": "<33 bytes, hex>",
    "locktime": 2900000
  },
  "tx": "<raw transaction, hex, owner-signed, co-signer's slot empty>"
}
```

The transaction carries everything of substance: which coin, how much, to whom,
and the signature. The `lock` fields are there so a verifier can re-derive the
lock address and confirm the coin being spent really is a lock of the shape this
project specifies, rather than taking it on trust.

No name, no identity, nothing about the supporter. A commitment asserts that
whoever controls a lock wishes a specific purchase to happen, and nothing else.

## The transaction

**Exactly one input**: the lock being spent.

**Two or three outputs**, in this order:

| | |
| --- | --- |
| Output 0 | The committed amount, to the proposal's destination |
| Output 1 | *Optional.* The remainder, to a new lock of the owner's own |
| Last output | **The proposal.** `OP_RETURN` and the proposal's 32-byte hash, holding nothing |

A bitcoin output is spent whole or not at all, so committing part of a lock
requires the remainder output. It must pay a lock derived from the **same owner
public key**, with a locktime **no earlier** than the lock being spent. Anything
else would be an early escape from the lock rather than a commitment.

**The last output names the proposal.** Its script is the two bytes `6a 20`
followed by the proposal's hash, and its value is zero: an output that can never
be spent and carries no money. It is there because the owner's signature covers
every output. With it, what the owner signed says which proposal the payment is
for, and once the payment is made the blockchain says so too. Without it the
owner would have signed only "this much, to this address", and anyone could offer
that signature for any proposal paying the same address.

**The transaction's version is 1 or 2, and the input's sequence number sets no
waiting period** (its top bit is set; `fffffffd` and `fffffffe` are both fine).
The owner's signature covers both. A commitment with an unusual version is not
passed on by the network, and one whose sequence number asks for a waiting period
cannot be mined until it has passed, which can be more than a year. Either would
count toward a proposal's target and never pay, and nobody but the owner could
put it right.

**`nLockTime` must be zero.** The purchase exit is valid at any time and
declares no locktime. A commitment carrying one would simply be unspendable
until that date, which helps nobody.

**The witness takes the purchase branch**, with the co-signer's slot left empty:

```
[ <empty>, <empty>, <owner signature>, <witness script> ]
```

The first empty item is the co-signer's place, filled at settlement. The
second empty item selects the ELSE branch of the lock script — the purchase
branch. (Until 10 November 2026 this showed the owner's signature second and
the selector third. That order was never what `method/lock/commitment.mjs`
builds, checks or completes, nor what Bitcoin accepted on the test chain: the
script checks the owner's signature first, so it must sit nearest the script.)

## The committed amount is output 0, not the lock's balance

This matters and it is easy to get wrong. The fee comes out of the coin being
spent, so what reaches the destination is less than what was locked. **A
proposal's target is measured in delivered amount.** Counting lock balances would
overstate every proposal by the total of its fees.

## Verification

Anybody, with no permission and no account. The owner's signature covers the
amount of the coin it spends, so checking it (step 4), the fee, and whether the
coin is still there (step 8) need that coin from any public block explorer. The
rest needs no network.

1. **Re-derive the lock address** from `owner_pubkey`, `cosigner_pubkey` and
   `locktime`, exactly as the lock format specifies. It must equal
   `lock.address`.
2. **Exactly one input.**
3. **The witness is the purchase branch** in the shape above, with the
   co-signer's slot empty and the witness script matching the one just derived.
4. **The owner's signature verifies** over the transaction's sighash for that
   input. It must be strictly encoded, sign the whole transaction
   (`SIGHASH_ALL`) and have a low S value: the network does not pass on a
   signature with a high one.
5. **`nLockTime` is zero, the version is 1 or 2, and the sequence number sets
   no waiting period.**
6. **The last output names this proposal**, as above, and holds nothing.
   **Output 0 pays the proposal's destination**, and that destination is on the
   Crowdlock's published destinations list, attested by the attestors the
   Crowdlock's own file names, aged and not revoked — see the destinations
   format. Output 0 holds at least what the network will pass on for an output
   of its kind (294 sats to an ordinary segwit address).
7. **If there are three outputs**, output 1 pays a lock re-derived from the same
   `owner_pubkey` with a locktime no earlier than `lock.locktime`, co-signed by
   this Crowdlock, and holds at least 330 sats.
8. **The coin is still unspent.** A supporter whose lock has lapsed may have
   taken it home, which voids their commitment permanently.

One more check needs the register rather than the transaction: **the lock's
owner has signed the version of the declaration the proposal was published
under** (registration format, "Versioning"). For a proposal under version 1,
every member has.

A commitment that fails verification is **published and marked failed**, not
removed, exactly as with a registration. What was submitted is part of what makes
the pile checkable.

### The fee sanity check

Fee is the input value minus the sum of the outputs. A verifier **must** reject a
commitment whose fee exceeds **one per cent** of the committed amount.

This is not about economy. It is to stop a bug in somebody's client, or a
mistyped figure, destroying a supporter's money as miner fee — an error nobody
can reverse and which no other check would catch.

And it must reject one whose fee is **below one sat for every virtual byte** of
the payment as it will finally be sent, with the co-signer's signature added (72
bytes more than the commitment as recorded). Below that the network does not
pass a payment on, so the commitment could not be settled.

## Counting the pile

```
committed = Σ (output 0 value of every commitment that passes verification
               and whose coin is still unspent)
```

- **One coin, one commitment, per proposal.** A second commitment for the same
  outpoint and the same proposal is ignored and the earlier one stands.
- The same coin **may** be committed to two different live proposals. Nothing
  prevents it and nothing should: only one can ever confirm, because they spend
  the same coin, and the loser becomes permanently invalid the moment the winner
  confirms.
- **Totals must never be summed across proposals.** The point above is exactly
  why. Each proposal's own total is honest; their sum double-counts.
- A pile total is **not money that has moved**. Until broadcast it is a
  collection of signatures. It must never be presented as settled.

## Submission

Open a pull request adding the record to `commitments/<proposal>.json`, where
`<proposal>` is the proposal's SHA-256.

Or hand the record to anybody who will publish it for you. As with a
registration, a signature cannot be forged and needs nobody's permission to pass
on, so no operator of anything can keep a supporter out of a proposal they want
to back.

**The pile lives in the repository and nowhere else.** A collection held on a
server could have one commitment quietly dropped from it with no way for anyone
to prove it happened. In the repository every submission is timestamped, the
history is public, the whole thing can be mirrored, and censorship leaves a
trace.

## Reference implementation

`method/lock/commitment.mjs`, with `method/lock/commitment.test.mjs` proving it offline.

It builds a commitment, verifies one against a proposal and a destinations list,
and completes one with the co-signer's signature. The tests cover the ways a
commitment is supposed to be rejected as well as the way it is supposed to work:
a tampered destination, a forged owner signature, an unlisted destination, one
that has not waited out its waiting period, a revoked one, a declared locktime, an
absurd fee, a remainder output that would smuggle coins out of the lock, and
everything version 2 added: a commitment relabelled for another proposal, one
with a waiting period or an unusual version, a high-S signature, outputs and a
fee too small to be passed on, a list attested by somebody the Crowdlock's file
does not name, and an entry attested for another Crowdlock.

The app's own builder and checker are in `app/src/wallet/core.mjs`, held to the
reference checker's verdicts by `app/test-chain/wallet.test.mjs`, which also
mines a commitment on a private chain.

## Amendments

This document is versioned and may change. The declaration cannot. If the two
ever appear to conflict, the declaration governs and this document is wrong.
