# Commitment format

**Version 1 · 24 October 2026**

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

**One or two outputs:**

| | |
| --- | --- |
| Output 0 | The committed amount, to the proposal's destination |
| Output 1 | *Optional.* The remainder, to a new lock of the owner's own |

A bitcoin output is spent whole or not at all, so committing part of a lock
requires the second output. It must pay a lock derived from the **same owner
public key**, with a locktime **no earlier** than the lock being spent. Anything
else would be an early escape from the lock rather than a commitment.

**`nLockTime` must be zero.** The purchase exit is valid at any time and
declares no locktime. A commitment carrying one would simply be unspendable
until that date, which helps nobody.

**The witness takes the purchase branch**, with the co-signer's slot left empty:

```
[ <empty>, <owner signature>, <empty>, <witness script> ]
```

The first empty item is the co-signer's place, filled at settlement. The third
empty item selects the ELSE branch of the lock script.

## The committed amount is output 0, not the lock's balance

This matters and it is easy to get wrong. The fee comes out of the coin being
spent, so what reaches the destination is less than what was locked. **A
proposal's target is measured in delivered amount.** Counting lock balances would
overstate every proposal by the total of its fees.

## Verification

Anybody, with no permission and no account. Steps 1 to 7 need no network; step 8
needs any public block explorer.

1. **Re-derive the lock address** from `owner_pubkey`, `cosigner_pubkey` and
   `locktime`, exactly as the lock format specifies. It must equal
   `lock.address`.
2. **Exactly one input.**
3. **The witness is the purchase branch** in the shape above, with the
   co-signer's slot empty and the witness script matching the one just derived.
4. **The owner's signature verifies** over the transaction's sighash for that
   input.
5. **`nLockTime` is zero.**
6. **Output 0 pays the proposal's destination**, and that destination is on the
   published destinations list, attested, aged and not revoked — see the
   destinations format.
7. **If output 1 exists**, it pays a lock re-derived from the same
   `owner_pubkey` with a locktime no earlier than `lock.locktime`.
8. **The coin is still unspent.** A supporter whose lock has lapsed may have
   taken it home, which voids their commitment permanently.

A commitment that fails verification is **published and marked failed**, not
removed, exactly as with a registration. What was submitted is part of what makes
the pile checkable.

### The fee sanity check

Fee is the input value minus the sum of the outputs. A verifier **must** reject a
commitment whose fee exceeds **one per cent** of the committed amount.

This is not about economy. It is to stop a bug in somebody's client, or a
mistyped figure, destroying a supporter's money as miner fee — an error nobody
can reverse and which no other check would catch.

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
that has not waited out its fourteen days, a revoked one, a declared locktime, an
absurd fee, and a remainder output that would smuggle coins out of the lock.

## Amendments

This document is versioned and may change. The declaration cannot. If the two
ever appear to conflict, the declaration governs and this document is wrong.
