# Published destinations format

**Version 1 · 24 October 2026**

**17 November 2026:** two checks that had been left to whoever read the list are now part of reading it. The attestors are the ones the Crowdlock's own file names, whatever the list says of itself; and every entry must carry this Crowdlock's fingerprint, not merely the same one as its neighbours.

**17 November 2026, later:** an entry's age is now counted from its **stamp on the chain** (see "The waiting period"), not from `firstSeen`. `firstSeen` was a date written into the file by whoever added the entry, so it could be backdated, which is the one thing the waiting period exists to prevent. An entry without a stamp can no longer be paid.

The only addresses committed money may ever be sent to.

Bitcoin cannot restrict where a coin goes without covenants, which the network
does not have. The lock's purchase exit therefore permits any destination, and
what actually constrains it is this document: **the co-signer completes a
commitment only where the destination appears on this list.**

That makes this list the whole defence against a forged proposal, and the most
attractive thing in the project to attack. Draining locks would require
corrupting this list as well as putting up a convincing proposal — not merely
the second.

## This document is a starting point, not a settled answer

Nothing can be attested until there is something to buy and a body to receive
it, which is a long way off. What is written here is a workable first design
recorded so that the problem is not discovered late — not a claim to have solved
it.

By the time it matters there should be a great many more people involved, several
of whom will know more about securing a list like this than anybody who has
worked on it so far. Their ideas should replace these if they are better. The one
part worth defending is the separation below: **the keys that attest a
destination must never be the key that spends to it.**

## The list is `destinations.json`

It lives in the project repository and it is **append-only**. Nothing is ever
edited or deleted; a mistake is corrected by appending a revocation.

Every entry is signed, and every entry commits to the one before it, so the list
cannot be rewritten without the signing keys and without the break being visible.

## The signed line

The container is JSON for convenience. **The thing that is signed is a single
canonical line of text**, which any language can reproduce exactly:

```
instance|index|op|address|text|added|prev
```

| Field | |
| --- | --- |
| `instance` | The SHA-256 of this instance's declaration. See **running your own** |
| `index` | Decimal, starting at 1, never reused, never skipped |
| `op` | `add` or `revoke` |
| `address` | The destination, or for a revocation the address being revoked |
| `text` | What it is for, or for a revocation why. No `|` and no newlines |
| `added` | RFC 3339 UTC, e.g. `2026-11-01T12:00:00Z` |
| `prev` | SHA-256 of the previous entry's line, hex. 64 zeros for entry 1 |

Canonicalisation, as for the declaration: UTF-8, NFC normalised, no leading or
trailing whitespace, no trailing newline on the line itself.

An example first entry:

```
3a0a0bca…6209b96|1|add|bc1qexampleaddressgoeshere|Receiving address for the stake purchase|2026-11-01T12:00:00Z|0000000000000000000000000000000000000000000000000000000000000000
```

(the `instance` field is the full 64-character hash; abbreviated here only to fit
the page)

**Why the instance is in the line.** Anyone may copy these documents for their
own club or cause, and several instances may run at once. Without this field, two
instances could in principle produce an identical line, and an attestation signed
for one would verify against the other. Binding every entry to its declaration's
hash makes a signature meaningless outside the instance it was made for — the
same property a registration already has, for the same reason.

## Attestation

An entry is attested by signing this statement with the Bitcoin Signed Message
convention, exactly as a registration signs the declaration:

```
I attest destination entry 1 (sha256:<hash of the line>).
```

The instance needs no mention here, because the line it hashes already carries
it.

**This sentence is a protocol constant and must not be translated**, for the
same reason as the membership statement: a verifier rebuilds it from the entry
and compares bytes. Only the number and the hash change. See **running your
own**, "About the language".

Deliberately the same mechanism as a registration, so the verifier already
written for the register verifies these too. No new cryptography enters the
project to protect its most sensitive list.

### Attestor keys must never be the co-signing key

This is the point of the whole arrangement. If the key that attests destinations
were the key that completes commitments, one compromise would deliver both halves
and the list would protect nothing.

The attestor keys are published **in the Crowdlock's own file** (`attestor_keys`),
are separate from the co-signing key, and should be held on different hardware.
A co-signing key must never appear as an attestor, and the Crowdlock's file is
refused if one does.

The list repeats them, as addresses, in its own `attestors` field, and the two
must agree. **A verifier takes the attestors from the Crowdlock's file, never
from the list.** A list that could name its own attestors could approve its own
destinations, and could name the co-signer as one.

### How many signatures

Day one: **one attestor, one signature**, held by a single person who also
happens to hold the co-signing key — on a different key, on different hardware.
That is stated plainly rather than dressed up. One person attesting is weak, and
what actually does the work at this stage is the waiting period below.

The required count rises with the number of attestors. The rule is a simple
majority of published attestors, and it is recorded in the list's `threshold`
field so that a verifier never has to guess.

## The waiting period

**An entry must have been stamped on the chain at least the Crowdlock's
waiting period before a proposal naming it may open.** The waiting period is the Crowdlock's own
choice, its `destination_wait_days`, recorded in the list as
`minimum_age_days`. **We recommend at least seven days on real bitcoin**, which
is The Kop Fund's. A test Crowdlock may set it to zero, so a proposal can be
tried in one sitting. (Until 10 November 2026 this document required fourteen
days of every Crowdlock. The Kop Fund's founder judged a fortnight longer than
needed, and that the length is each Crowdlock's to choose, not the method's.)

This is the real protection while there is one attestor. At seven days, a
fraudulent addition has to have been attested and stamped a week before its
proposal opens, and the proposal then gathers in public (up to four weeks for
The Kop Fund) before a penny moves. The app publishes an entry in the same step
that stamps it.

**Age is measured from the entry's stamp on the chain**, not from its `added`
field, and not from any other date written into the file. Whoever can write the
file can write any date in it.

**The stamp** is an ordinary bitcoin payment, made by the attestor once the
entry is attested, from their own wallet back to itself. It has one extra
output: `OP_RETURN` followed by 32 bytes, holding no money. Those 32 bytes are
the SHA-256 of the **stamp line**:

```
<hash of the entry's signed line>|<attestor address>:<signature>|…
```

that is, the entry's hash (the same hash `prev` and the attestation statement
use), then each attestation in the order the entry lists them, as address,
colon, signature, joined by `|`. The payment's txid is recorded on the entry as
`stamp`. The entry's age is counted from **the time of the block the stamp
payment is in**.

- **A block cannot be backdated.** Its time is fixed by the miners, to within a
  couple of hours, and is the same for everyone who reads the chain.
- **It covers the attestations, so it cannot be made ahead of time** by anybody
  without an attestor's key. Somebody planning to add a destination later
  cannot stamp it today and use its age then, unless they already hold the key.
- **An entry with no stamp, a stamp that does not carry the entry and its
  attestations, a stamp output holding money, or a stamp not yet in a block,
  is refused.** If the attestations change, the entry must be stamped again,
  and its age starts again.
- **It costs one ordinary network fee per destination**, not per proposal: a
  second proposal to the same destination stamps nothing.

Until 17 November 2026 the age was counted from `firstSeen`, a date recorded on
the entry by whoever added it. Before that, the code had fallen back to `added`
whenever `firstSeen` was missing. Both handed an attestor precisely the
backdating the waiting period exists to prevent: add an address this morning,
write last month's date beside it, name it in a proposal this afternoon.
Entries written before then may still carry a `firstSeen`; it is ignored.

A proposal may wait longer than its Crowdlock requires, and should, for a large
purchase. A Crowdlock that sets a short wait, or none, on real bitcoin is
telling its members that they have less time to notice a forged destination;
that is visible in its file to anyone who looks.

## Revocation

```
7|revoke|bc1qexampleaddressgoeshere|Superseded by entry 6; this address is no longer in use|2027-02-14T09:00:00Z|<hash of entry 6>
```

A revoked address may not receive new commitments from the moment the revocation
appears — **no waiting period applies to a revocation**, because the safe
direction needs no delay.

Existing commitments already signed for a revoked address are a different matter.
They remain cryptographically valid, and the co-signer must not complete them.
This is one of the places where the co-signer's refusal is doing real work.

## What the co-signer checks

Before completing any commitment, for the destination named in its proposal:

1. The hash chain is intact from entry 1 to the head of the list.
2. There is an `add` entry for the destination.
3. Its attestations meet the threshold and every one verifies.
4. The entry's stamp is in a block at least the waiting period
   (`minimum_age_days`) before the proposal opened.
5. There is no later `revoke` entry for that address.

Any check failing means the commitment is not completed. All five are mechanical;
none is a judgement call.

**All five now run in code.** `destinationIsPermitted` in `method/lock/commitment.mjs`
performs them, and `verifyCommitment` calls it on every commitment. Until
26 October only three did: nothing verified an attestation signature anywhere
in the project, so a list could have been edited freely and still read as
attested. The specification described the check; no code performed it, and a
check nobody performs is a comment.

Three rules in particular, learned from writing it:

- **Every signer must be a listed attestor.** A real signature from somebody
  who is not on the list is still somebody who is not on the list.
- **Two signatures from the same attestor count once.** Otherwise a single
  attestor meets any threshold alone, and the threshold means nothing.
- **A threshold higher than the number of attestors is a broken list**, not a
  safe one, and is refused rather than treated as unsatisfiable.

A commitment handed a destinations list with no attestor set is refused
outright rather than checked for age alone. A list nobody vouches for is the
attack this section exists to stop, and silently checking a weaker rule is how
that attack would have succeeded.

Attestor addresses carry the prefix of the network the instance runs on, so a
testnet attestation is checked against testnet rules. Checking it against
mainnet derives a different address and reports, misleadingly, that the
signature belongs to somebody else.

## Verifying the list yourself

Anybody, with no permission and nothing but the repository:

1. Rebuild each entry's canonical line from the fields, including this
   instance's declaration hash. **Every entry's `instance` must be this
   Crowdlock's declaration hash**: an entry attested for another Crowdlock is
   not an entry of this list, even if the same attestor signed it.
2. Hash it, and confirm the next entry's `prev` matches.
3. Verify each attestation against the attestor addresses of the keys the
   Crowdlock's file names, using the same verifier the register uses.
4. Compare `added` against the commit history and against a mirror, to catch a
   backdated entry.

A list whose chain breaks, or whose attestations do not verify, is not to be
relied on and no commitment should be completed against it.

## What this does not protect against

**A legitimate destination that is the wrong one.** If an address is genuinely
attested and genuinely waited out its waiting period, this document is satisfied
even if the purchase behind it is a bad idea. Nothing here judges whether a
purchase is worth making. That is what the absence of commitments is for.

**Routine small spends are the worse target, not the purchase.** Nobody is going
to wave through a forged proposal for the price of a football club. A plausible
invoice for a routine-looking amount, arriving when everybody is used to
approving such things, is
the realistic attack — which is why small operating costs are met from a separate
transparent fund with published receipts, and never from locked money.

## Amendments

This document is versioned and may change. The declaration cannot. If the two
ever appear to conflict, the declaration governs and this document is wrong.
