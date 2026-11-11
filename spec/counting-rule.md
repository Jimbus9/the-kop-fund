# Counting rule

**Version 1 · 24 October 2026**

**11 November 2026:** no total of lapsed money is published (it was to be published separately). The counted total is unchanged.

How every number this movement publishes is computed. Two people applying this
document to the same public data must reach the same answer. If they do not,
this document is at fault and should be corrected.

Principle 10 of the declaration: no figure is published that cannot be checked
by a stranger. This is the document that makes that possible.

## The unit of account is bitcoin

The authoritative figure is in **BTC**, never in a national currency.

A figure in money may be shown alongside it — pounds here, whatever is local
to an instance elsewhere — and when it is, it must be marked as an indicative
conversion at the time of display. It is never the headline and it is never
archived as a fact.

The reason is not ideology. Priced in pounds, an ordinary fall in the bitcoin
price appears to shrink the movement while the target stands still, and nobody
whose money is locked can do anything about it. Priced in bitcoin, the movement
holds exactly what it held yesterday, and what has changed is the cost of the
thing it is trying to buy. The second description is the true one, and it keeps
a price source out of the only number that has to be beyond argument.

## The three states of a lock

Read directly from the blockchain, never from any record we keep.

| State | Condition | Counted |
| --- | --- | --- |
| **Locked** | Coins present at the lock address, locktime in the future | **Yes** |
| **Lapsed** | Coins present, locktime reached | No — and no total of it is published |
| **Withdrawn** | Coins no longer at the address | No |

**Lapsed money is not counted**, whether or not the owner has moved it. On the
date a lock reaches, the owner can spend those coins with a single signature,
which makes them indistinguishable from any other coins somebody happens to
own — and counting those would return the headline figure to meaninglessness.

**No total of lapsed money is published.** The counted total is the figure:
only locked money, and a lock that lapses shows as a fall in it, so nothing
that counts against the movement is hidden. A second figure of uncommitted
money beside it would read as "plus this much more" — the inflation this rule
exists to prevent. The owner of a lapsed lock still sees it as lapsed in their
own client, and every lock is public on the chain, so anyone who wants the
number can work it out; it is simply not a headline. A Crowdlock that wants to
chase renewals can compute it for itself.

## The committed total

```
committed = Σ (confirmed balance of every lock address in state "locked"
               whose balance is at least the minimum)
```

- Balances are read from the blockchain at a stated moment, and the moment is
  published with the figure.
- **Unconfirmed transactions do not count.** A lock counts from its first
  confirmation.
- Each lock address is counted once. An address appearing twice in the register
  is counted once.

## The minimum

**Each Crowdlock sets its own minimum**, in its published file
(`minimum_counted_lock_sats`). For example, The Kop Fund's is **200,000 satoshis**
(0.002 BTC). A lock below its Crowdlock's minimum does not count towards the
committed total.

A smaller lock is not invalid. It is still the owner's, still locked, and
still published; it is only left out of the total.

Expressed in satoshis rather than pounds so it does not drift with the price.
Its only purpose is to stop a large number of worthless locks inflating the
figures — at a level like The Kop Fund's, faking ten thousand of them would cost real
money. A Crowdlock choosing its own should pick a figure with the same effect
for the size of crowd it expects.

**Changing it.** The minimum may be revised, in a published amendment to this
document carrying a reason and an effective date, so that anyone can recompute
the totals under both the old rule and the new one and see exactly what the
change did.

**Existing locks are grandfathered.** A raised minimum never disqualifies a
lock that qualified when it was made. Otherwise a price movement could silently
remove supporters from the count, which would be the opposite of the point.

## The member count

Two different numbers, and they must never be conflated.

**Signatories** — registrations that verify. Costs nothing to obtain, so it is
a measure of agreement rather than commitment, and it must never be presented
as a financial figure.

**A signatory count must never be a headline figure, and the reason is not
modesty.** Anybody can generate keys and sign the statement as many times as
they like, for nothing, so the number can be inflated to any size by one
person with a script. Worse, every such signature is *valid*, so there is no
honest way to remove them afterwards: doing so would mean an operator deciding
which real signatures count, which this specification does not permit anywhere
else. The defence is therefore structural rather than a guard — give the number
no prominence worth attacking, and lead with figures that cannot be forged
because each one costs real money and a real transaction. Publish every
signature in full regardless, so anyone who wants to count them can.

**Committed members** — distinct members holding at least one lock in state
"locked" at or above the minimum. This is the figure to quote alongside the
committed total, because the two describe the same group of people.

Derived with no extra data, because the key that signs the declaration is the
key that owns the locks:

```
member(lock) = P2WPKH address of hash160(lock's owner public key)
committed_members = count of distinct member(lock) over all counted locks
```

A lock whose derived address is not on the register is counted in the money and
not in the members. It is somebody's lock either way, and the money is the
figure that matters; silently discarding it would understate the total.

Where only one figure is given, it must be the committed one, and it must be
labelled.

## There are no vote tallies

Spending is not decided by a vote, so there is nothing to tally. A supporter who
wants a purchase signs their own coins into it; one who does not, does nothing.
Declaration principle 6 — *spending is weighted by what each member has
committed* — is satisfied by arithmetic rather than by counting, which removes a
step that could be got wrong or argued over.

An earlier version of this document specified vote weights measured at a declared
block height. That machinery was inherited from a design in which money sat in a
pool and somebody had to be told where to send it. Nobody holds anybody's money
here, so there was nothing left for it to instruct.

How a proposal is published, funded and settled is in the **proposal and
settlement format**. What this document still governs is the only figure that
matters to it: the running total of commitments, which is computed from the
published pile of signatures rather than from the chain, and must never be summed
across proposals.

Influence cannot be rented in any case, because committed money cannot be
borrowed for an afternoon. That is why no decay curve, holding-period formula or
anti-gaming measure appears anywhere: the lock already does that work.

The one place a genuine ballot survives is **directing the club** — one member,
one vote, inside the society's own rules, because a decision that moves no money
cannot be funded. That exists only once a stake does, and is not specified here.

## Figures that must not be published

- **Holdings.** Bitcoin a supporter merely owns, however much of it there is.
- **Intentions.** Pledges, promises or expressions of support not backed by a
  lock.
- **A peak or record figure.** Only the present matters. A record flatters and
  is not load-bearing.
- **Any money figure presented as authoritative** rather than as an indicative
  conversion at a stated moment.

## Amendments

This document is versioned and may change. The declaration cannot. If the two
ever appear to conflict, the declaration governs and this document is wrong.
