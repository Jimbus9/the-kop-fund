# Proposal and settlement format

**Version 1 · 24 October 2026**

How money committed to this fund is actually spent.

**There is no vote.** A proposal is funded or it is not. Nobody counts anything,
nobody is outvoted, and nothing passes.

## Why there is no vote

A vote exists to tell somebody where to send money they are holding. Nobody here
holds anybody's money, so there is nothing to instruct.

A fan who wants a purchase to happen signs their own coins into it. A fan who
does not, does nothing. If enough fans sign, the purchase happens; if they do
not, it does not. Declaration principle 6 — *spending is weighted by what each
member has committed* — is satisfied by arithmetic rather than by a tally, which
removes a counting step that could be got wrong or argued over.

This also disposes of a question that looked difficult: **who may put a proposal
up.** Anyone may. A bad proposal simply attracts no commitments and costs
nothing. The danger was never a bad proposal but a *fake* one, and that is
handled by the published destinations list in the lock format, not by gatekeeping
who is allowed to ask.

## A proposal

A published document containing, at a minimum:

| Field | |
| --- | --- |
| `destination` | A single address, which **must** already be on the published destinations list — see the destinations format |
| `requires` | The amount needed, in the seller's own currency, and what it buys |
| `currency` | Which currency `requires` is in — an ISO 4217 three-letter code, in capitals |
| `target` | The equivalent in bitcoin, at a stated rate and moment |
| `opens` / `closes` | The gathering window. `closes` is a deadline, not a duration |
| `settles_by` | The last date on which any commitment to this proposal may be completed |

`requires` is the binding figure, because it is a price quoted by somebody else.
`target` is an indicative running goal and is restated as the bitcoin price
moves.

## The canonical proposal document

Every commitment names its proposal by hash, and a commitment whose named hash
does not match is refused. For a long time that check rested on nothing: the
table above said a proposal was "a published document containing, at a
minimum" some fields, which describes a document rather than being one. Two
honest people writing out the same proposal would have produced different
bytes, hashed to different values, and each correctly rejected the other's
commitments.

So the bytes are fixed. Same shape as a destination entry, and for the same
reasons — readable by eye, and beginning with this instance's declaration hash
so a proposal cannot be replayed into another Crowdlock:

```
<instance>|proposal|<destination>|<requires>|<currency>|<document>|<opens>|<closes>|<settles_by>
```

SHA-256 of that line, UTF-8, NFC normalised, no trailing newline. Built by
`proposalLine` and `proposalHash` in `method/lock/commitment.mjs`.

**The fields are fixed in number and order, and "at a minimum" cannot survive
here.** An optional field is a second possible document, and a second possible
document is a second possible hash. Anything further a proposal wishes to say
belongs in its prose, which is referenced by `document` — the SHA-256 of that
prose — and so is bound into the hash without having to be squeezed into a
line.

**`requires` is a whole number of the currency's minor units** — pence for
GBP, cents for USD and EUR, whole yen for JPY, which has none, thousandths for
KWD — because floating-point money does not hash reliably. **`currency` is an
ISO 4217 three-letter code in capitals.** It is refused in lower case rather
than quietly corrected: silently rewriting what the proposal's author wrote
would mean the document they published and the line we hashed were not the
same bytes, which is the one thing this section exists to prevent.

**The currency field was added on 2 November 2026, and until then this line
had none.** The amount was simply "pence", which made a document that
describes a general mechanism into a British one: a Crowdlock run by
supporters anywhere else could not state what their purchase cost. No
proposal had been written anywhere, by anyone, so the change cost nothing;
after the first one existed it would have invalidated every commitment
already signed. The rule it illustrates is worth more than the fix —
**anything in these documents that assumes one country is a defect, and the
cheapest moment to find it is before anybody has used it.**

Note which way this cuts, because it looks at first like a contradiction of
the paragraph below. A currency belongs in the hash for the same reason the
price does: **once the proposal is written, it never moves.** The thing that
is kept out is the thing that changes.

**`target` is deliberately absent.** It moves with the bitcoin price, and a
proposal whose hash changed every time bitcoin moved would invalidate every
commitment gathered up to that moment. That is precisely the failure that sank
the assurance-contract designs, and it is not being reintroduced through the
back door of a hash.

A proposal whose window closes before it opens, or which settles before it
closes, is refused at construction rather than published and discovered later.

**`requires` is written with a margin.** Some commitments will not settle — a
lapsed lock taken home, a supporter who moved their coins, a transaction that
cannot be confirmed in time. The margin is built into the figure when the
proposal is written rather than handled by a further round of gathering.

**This is not a breach of the counting rule.** That document forbids publishing a
currency figure as authoritative *about the fund*. A seller's price is not a
description of the fund; it is a bill. The distinction matters: our own size is
measured in bitcoin because a price source must not sit inside it, while
somebody else's invoice is denominated in whatever they asked for.

Because every commitment is an independent transaction, a moving price
invalidates nothing. If bitcoin falls, more commitments are needed and the
existing ones still stand. This is the single largest advantage over the
assurance-contract designs considered and rejected, where a price movement
destroyed every signature gathered so far.

## Publishing a proposal

A Crowdlock publishes its proposals in one file, named in its Crowdlock file as
`register.proposals` (for example `proposals.json`). The file is append-only: a
proposal is never edited once listed, except that its `target` is restated as
the price moves.

```json
{
  "format": "crowdlock-proposals/1",
  "instance": "<the declaration's SHA-256>",
  "proposals": [
    {
      "title": "A short name",
      "text": "The proposal in full: what is being bought, from whom, and why.",
      "destination": "<an address on the destinations list>",
      "requires": 12345,
      "currency": "GBP",
      "opens": "2026-12-01T00:00:00Z",
      "closes": "2026-12-29T00:00:00Z",
      "settles_by": "2027-01-12T00:00:00Z",
      "hash": "<the proposal's hash>",
      "target": { "sats": 250000, "rate": "1 BTC = 66000.00 GBP", "at": "2026-11-30T12:00:00Z" }
    }
  ]
}
```

- `document`, in the canonical line, is the SHA-256 of `text` (UTF-8, after
  NFC), so the prose cannot be changed without changing the hash.
- `hash` is the SHA-256 of the canonical line built from these fields and
  `instance`. A reader recomputes it and refuses a proposal whose hash does not
  match its own fields and text.
- Times are UTC, written as above. `closes` is at most the Crowdlock's
  `gathering_window_max_days` after `opens`, and `settles_by` at most its
  `settlement_window_max_days` after `closes`.
- `target` is not hashed. It gives whole sats, the rate used, in words, and when
  it was worked out.

The reference checker is `method/js/proposals.mjs`, which also runs in a
browser and on a phone; its hash is held byte for byte to
`method/lock/commitment.mjs`.

## The window

**Up to four weeks to gather, then up to two weeks to settle.**

### Why it is two phases and not one

Settlement cannot begin until `requires` is met. A co-signer completing
commitments as they arrived would be sending money to the destination for a
purchase that might never be funded — and the destination is not ours to reverse.
The threshold forces the order: all of the gathering, then any of the settling.

The two dates also bind different parties. `closes` is a deadline for
**supporters** — sign by then or not at all. `settles_by` is a deadline for the
**co-signer and whoever broadcasts** — complete it or declare it dead by then. A
single combined date would leave it ambiguous who was late, and would let the
settlement runway be squeezed to nothing by a proposal funded the day before.

### Gathering closes as soon as the target is met

`closes` is the *last* date, not a duration to be served out. The moment
`requires` is met, gathering ends and settlement begins. A proposal funded on day
three does not hold anybody for another twenty-five days.

**Four weeks** is the outer limit because signing does not touch the blockchain,
so nothing about the network constrains gathering. What constrains it is people:
a global support includes supporters who look at this once a fortnight, who work
nights, who are away. Four weeks reaches them; two does not.

**Six weeks in total** is the ceiling because fee estimates drift and a commitment
is binding for as long as the proposal is open.

**A proposal window is weeks, never years.** The lock is the long commitment; a
commitment to a proposal is a short final step. Any design in which a supporter
can be bound to a specific purchase for years is wrong.

## A commitment

A commitment is **one transaction, spending one lock, signed by its owner only**.
Its record, its eight verification steps and how a pile is counted are in the
**commitment format**; what follows is what it means.

It is not a payment. It is the owner's half of a transaction nobody has
broadcast. The coins stay in the lock, at the same address, with the same
balance. The blockchain has no knowledge that the proposal exists.

**An owner's signature alone cannot move their coins.** The lock's purchase exit
requires both the owner and the co-signer, so a commitment is cryptographically
inert on its own. It can be published, copied and mirrored freely; nobody can
spend with it.

**One transaction per committing fan.** Schemes that pack many fans into one
transaction are smaller on-chain but require the set of participants to be fixed
before anyone signs, and that is a coordination exercise that does not survive
contact with hundreds of thousands of people. Independent transactions need no
coordination event at all: whoever assembles settlement uses the signatures that
already exist, so there are no no-shows. A supporter who has died, lost their
keys or changed their mind is simply absent.

### Committing part of a lock

A bitcoin output is spent whole or not at all. To commit part of a lock, the
transaction has **two outputs**: the committed amount to the destination, and the
remainder to a **new lock of the owner's own**, expiring no earlier than the one
being spent.

The co-signer checks both halves: the committed output against the published
destinations list, the remainder output by re-deriving the lock address from the
key that signed. Both checks are mechanical.

## Commitments are binding until the window closes

There is no way to withdraw a commitment. You cannot un-sign, and while your lock
is in date you cannot move those coins elsewhere.

**This must be stated plainly wherever a supporter commits.** The bound period is
six weeks at worst (four of gathering, two of settling) and usually far less, since gathering ends the moment the
target is met. But it is real, and a supporter who did not understand it was
misled.

A withdrawal mechanism was designed and rejected. It would have required the
co-signer's signature, which makes it no defence against a dishonest co-signer —
the only situation in which anybody would need it. It would also have obliged the
co-signer to run as a continuous service answering requests at any hour, which is
a far larger security liability than the problem it solved.

## Settlement

When `requires` is met, and not before:

1. The co-signer verifies the destination against the published list and that
   the target is met. **One judgement for the whole proposal**, not one per
   supporter.
2. The co-signer adds its signature to each commitment. This is software; the
   number of signatures is irrelevant to the time it takes.
3. Completed transactions are **published**, so that anybody can broadcast them.
   Settlement does not depend on any one party staying available.
4. Broadcasting is **paced across days**, and preferentially into quiet periods.

### Pacing is not optional

One transaction per supporter means a hundred thousand supporters is a hundred
thousand transactions — roughly thirteen blocks' worth of the entire Bitcoin
network's capacity. Dumped at once, that is a large fraction of global blockspace
bidding against itself and pushing the fee rate up for everybody, including us.

Paced across days and into quiet hours, it is unremarkable. The spec therefore
treats pacing as part of settlement rather than an optimisation.

### Oversubscription

More may be committed than is needed. Commitments are settled **in submission
order** until `requires` is met, and then no further.

Submission order is used because it is already recorded, timestamped and public
in the repository, so anybody can verify that the rule was followed. Unsettled
commitments are harmless: those coins never moved.

## Fees

The fee is fixed by the owner's signature and cannot be changed afterwards
without signing again.

- Commitments are signed at an **ordinary prevailing rate**, with a modest
  allowance for the window — something like the rate that would have cleared over
  the past month, rather than the rate at this minute.
- **No high multiple is mandated.** Mining is an auction. If our transactions are
  the bulk of what is in the mempool, only their ordering relative to each other
  matters, and a uniform multiple over everybody raises nothing but the miners'
  income. It would also raise the clearing price for every other user of the
  network for as long as settlement ran.
- **Stragglers are accelerated by the recipient**, not the supporter. Every
  commitment pays an output to the destination, so whoever controls that output
  can spend it in a child transaction carrying a high fee, which obliges a miner
  to confirm the parent in order to collect it. The decision is made at
  settlement with the real fee market visible, by the party that wants the
  purchase to complete, and it publishes what it spent.
- One such acceleration can rescue roughly two dozen stuck transactions, so a
  large rescue is itself many small ones.
- **A stuck commitment is not lost.** It is unconfirmed, still valid, and
  confirms when the market calms.

## Failure

If `requires` is not met by `closes`, the proposal fails.

**Failure requires no action by anyone.** The co-signer does not sign, so every
commitment in the pile stays permanently inert. The default outcome is the safe
one, which is the correct way round.

The co-signer **publishes a signed notice** declaring the pile dead, and does not
complete any commitment after `settles_by`.

### The residual risk, stated

A commitment stays technically valid while the coin it spends is unspent. A
**dishonest** co-signer could therefore complete a commitment belonging to a
proposal that closed unfunded.

Bitcoin cannot prevent this without covenants, which the network does not have.
What bounds it:

- The destination can only be the one the supporter signed for, which is on the
  published list. It is a premature payment to a named recipient, not theft to a
  stranger.
- Whether the target was met is publicly checkable from the pile, and the
  co-signer has published a signed notice saying it was not. Completing it
  afterwards is provably a breach by a named keyholder.
- **The supporter's backstop is their lock's expiry.** At that date they can move
  the coin alone, and every outstanding commitment over it dies instantly and
  permanently.

It follows that **a longer lock carries a longer tail of this exposure than a
short one**. Longer locks get more weight and more exposure. That belongs on the
page where a supporter chooses a lock length, not buried here.

## Where the pile lives

In the project repository, submitted the same way as registrations, at
`commitments/<proposal hash>.json` beside the proposals file:

```json
{
  "format": "crowdlock-commitments/1",
  "proposal": "<the proposal's hash>",
  "commitments": [
    { "submitted": "2026-12-02T09:15:00Z", "record": { "proposal": "…", "lock": { … }, "tx": "…" } }
  ]
}
```

Each `record` is a commitment in the commitment format. `submitted` is when the
repository first received it, which is the order oversubscription settles in.

Not on a server we run. A collection held by us could have an individual
commitment quietly dropped from it with no way for anyone to prove it happened.
In the repository every submission is timestamped, the history is public, the
whole thing can be mirrored, and censorship leaves a trace.

## Verifying a commitment

Anyone, with no permission and no account:

1. Check the signature is valid for the lock it spends.
2. Check the lock address re-derives from the owner key, co-signer key and
   locktime, exactly as the lock format specifies.
3. Check the coin is **still unspent**. A supporter whose lock has lapsed may have
   taken it home, which voids their commitment.
4. Check the destination matches the proposal, and that the proposal's destination
   is on the published list.
5. Add up the commitments that pass.

## Figures that must not be published

- **A combined total across proposals.** The same coin may be committed to two
  live proposals, so summing them double-counts. Each proposal's own total is
  honest; their sum is not.
- **A proposal's total as though it were settled.** Until broadcast, it is a pile
  of signatures, not money that has moved.

## Amendments

This document is versioned and may change. The declaration cannot. If the two
ever appear to conflict, the declaration governs and this document is wrong.
