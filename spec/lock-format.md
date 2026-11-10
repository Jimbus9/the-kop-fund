# Lock format

**Version 1 · 24 October 2026**

A lock is how a supporter commits money without anyone taking custody of it.
It is an ordinary Bitcoin output with a script that permits exactly two ways
out and no others.

## The two exits

| | Who signs | When |
| --- | --- | --- |
| **Going home** | The owner, alone | Only at or after the locktime |
| **Into a purchase** | The owner **and** the co-signer | Any time |

## The script

P2WSH, with both exits in one witness script. It reads: **the owner always
signs, and then either the date has passed or the co-signer signs too.**

```
<ownerPubkey> OP_CHECKSIGVERIFY
OP_IF
  <locktime> OP_CHECKLOCKTIMEVERIFY
OP_ELSE
  <cosignerPubkey> OP_CHECKSIG
OP_ENDIF
```

The spender selects a branch with the witness item beneath the owner's
signature: `01` for going home, an empty item for the purchase route. In full,
bottom of the stack first:

| Exit | Witness |
| --- | --- |
| Going home | `01`, owner's signature, script |
| Into a purchase | co-signer's signature, empty, owner's signature, script |

**The first line is the most important in this specification.** It runs before
either branch is chosen, so no way out of a lock exists without the owner's
signature. The co-signer can never move a coin alone.

Note also what is *absent*: the co-signer does not appear in the going-home
branch. They cannot block a withdrawal, delay one, or be asked to approve one.

### Why it is written in this form

The script is standard **miniscript**:
`and_v(v:pk(owner),or_i(after(locktime),pk(cosigner)))`. Any wallet or tool that
understands miniscript, including Bitcoin Core, can read a lock and sign for it
with no code of ours.

That matters most for the co-signer. A purchase may gather tens of thousands of
commitments, each a separate transaction needing its own co-signature. No
hardware wallet will approve that many one at a time. Instead the co-signing key
lives on a dedicated computer that is never connected to the internet, running
Bitcoin Core: the commitments arrive on a USB stick, every one is checked and
signed automatically, and the signatures leave the same way. The co-signer makes
one decision per proposal, which is all the role was ever meant to be.

An earlier form of this lock named the owner's key in both branches. It behaved
identically but is not valid miniscript, because miniscript refuses a key that
appears twice. No real lock was ever made in that form.

## Locktime

A unix timestamp (≥ 500,000,000), so a lock expresses a date a supporter can
understand. `OP_CHECKLOCKTIMEVERIFY` compares it against the block's
median-time-past, so a lock becomes spendable at approximately rather than
exactly that moment — typically within an hour. Immaterial for a lock measured
in years.

A block height may be used instead and behaves identically. Heights are used
in testing because they are exact. An instance uses one or the other for every
lock, never both: a single transaction cannot spend a date lock and a height
lock together.

### Rounding, and why it is UTC

A client turns a chosen length into a locktime by adding it to the current time
and then, **for any length of a day or more, rounding up to the next midnight
UTC**. Shorter lengths, which exist only on test networks, are not rounded.

**A year is 365.25 days exactly** — 31,557,600 seconds. That is not a detail of
one implementation; it is part of the format, because the locktime goes into the
address. A client using 365 days would derive a different address for the same
supporter making the same choice on the same day, and their money would land
somewhere the register is not watching.

**UTC, not the supporter's own midnight.** Two consequences follow, and a
client that rounds to local midnight gets both wrong. First, a lock's address
is derived from its locktime, so the same supporter choosing the same length on
the same day must land on the same address wherever they are standing — a
client in Sydney and a client in Liverpool have to agree. Second, two locks by
one member that round to the same date *are the same address*, and money sent
to the second simply joins the first; that is intended, and it only holds if
everybody rounds identically.

Rounding at all is what keeps the register readable: without it, expiry dates
scatter across every minute of the day and no two supporters' locks ever share
one.

A spend down the going-home branch must set the transaction's `nLockTime` to
the lock's locktime, and `nSequence` below `0xffffffff` so that `nLockTime` is
honoured.

## Offered lengths

**A short list of fixed lengths, chosen by the supporter at the moment of
locking.** The list is the instance's own, published as `lock_lengths_years` in
its Crowdlock file — The Kop Fund offers **one, three or five years**; a test
copy offers fractions of a year, so that expiry can be watched happening.

Fixed options rather than free choice: free choice scatters expiry dates across
a register nobody can read at a glance, and the point of the register is that
it can be read. **What is general here is "a few fixed options", not the
particular three.** An instance with a nearer goal may sensibly offer shorter
ones, as long as it is honest that a shorter lock counts for less and must be
renewed more often.

**Length is a genuine trade, in both directions.** A longer lock counts for more
and signals more. It also extends the period during which an outstanding
commitment to a dead proposal could, by a dishonest co-signer, still be
completed — because the locktime is when an owner regains the ability to kill
such a commitment by moving the coin alone. See the proposal and settlement
format. This must be presented to a supporter at the moment they choose, not
buried.

## Top-ups

A top-up is a **new lock**, not an extension of an existing one.

Simpler to build and simpler to verify. A supporter may hold several locks with
different dates; the counting rule adds them up and a client should present
them as one figure with the individual dates available.

## The published list

The co-signer signs a purchase-route spend **only** where the destination
appears on the published list of approved destinations.

Bitcoin cannot enforce a destination without covenants, which do not exist on
the network today. So this is policy rather than script — and it is the whole
defence against a forged proposal. Stealing committed money would require the
published list to be corrupted as well, not merely a convincing-looking
proposal to be put up.

The list is `destinations.json` in the project repository, and it has its own
specification: **published destinations format**. In short, it is append-only
and hash-chained, each entry is separately signed by keys that are **never** the
co-signing key, and an address must have been publicly visible for the
Crowdlock's waiting period (its own choice; seven days is recommended on real
bitcoin) before a proposal may name it.

## Expiry

Nothing happens at the locktime. Bitcoin performs no scheduled actions.

The coin remains exactly where it was and simply becomes spendable by its owner
alone. It stays there indefinitely until they sign. For how this affects the
figures, see the counting rule — a lapsed lock is not counted and is published
separately.

Renewal cannot be automatic, since no coin moves without a signature. It is a
new transaction with a new fee. A client should prompt ahead of the date and
pre-build the transaction, but it cannot act for the owner.

## Verifying a lock

The owner key is **the same key that signed the declaration** — see the
registration format. Nothing extra ties a lock to a member: hash the owner key
and the member's address falls out.

Given a lock address, an owner key, a co-signer key and a locktime:

1. Check the owner key and the co-signer key are different keys. If they are
   the same — or one is the other's mirror image, sharing its x-coordinate — it
   is not a lock: one person could supply both purchase signatures and move the
   coin at any time. It is not counted.
2. Rebuild the witness script exactly as above.
3. Derive the P2WSH address from it.
4. The lock is genuine if and only if the derived address matches.

The co-signer therefore cannot lock their own coins with their co-signing key.
Anyone who is both a member and a co-signer uses a separate key for each role.

## Publishing a lock

A lock address is the hash of its script, so the chain shows only some coins at
some address until the lock is spent. Nobody can find a lock by looking. Its
owner publishes the terms, and anybody can then check them with the four steps
above.

**Publishing a lock needs no signature, and that is deliberate.** Joining the
register does need one, because a registration asserts *agreement* — that a
particular person read the declaration and accepted it — and only a signature
can establish that. A lock asserts something different: that an address is a
lock with these terms, belonging to this member. Every part of that is a fact
about the chain and some arithmetic, and anybody can check it for themselves
without anybody's permission. A signature would prove consent to publish, not
truth, and this register deals in the second.

The consequence should be stated rather than discovered. **A member cannot
keep a funded lock private.** Once their owner key is known — which it is from
the moment their first lock is published — anybody who guesses the date can
derive the address, see the coins on the chain, and publish the lock for them.
Nothing is stolen and no figure is inflated, because the coins are the
member's own and were always going to be counted. What is lost is the choice
of *when* a lock becomes public. Somebody who minds should lock later rather
than earlier, not expect the register to keep their secret.

A lock on the register is a record of exactly these fields:

| Field | What it is |
| --- | --- |
| `address` | The lock address |
| `member` | The address the owner key hashes to — the member who owns it |
| `owner_pubkey` | The owner's compressed public key, hex |
| `cosigner_pubkey` | The co-signer key the lock names, hex. Must be one of this Crowdlock's `cosigner_keys` |
| `locktime` | The locktime as a number |
| `unlocks` | The same date written as `YYYY-MM-DD`, for reading at a glance |
| `submitted` | When it was published |

Before a lock is published, the register checks that:

1. it passes "Verifying a lock" above — two different keys, and the address
   rebuilds from the terms;
2. its co-signer key is this Crowdlock's, because a lock is counted by the
   Crowdlock whose co-signer it names;
3. its locktime is a date, not already past, and no longer than the longest
   offered length plus a month;
4. its owner is a member — the owner key hashes to an address on the register;
5. it is not already on the register;
6. confirmed coins are at the address. Until a coin has confirmed there is
   nothing on the chain to point at, and publishing empty addresses would let
   anybody fill the register for free.

A lock **below the minimum is still published**. The minimum is a counting rule,
not a validity rule; such a lock is shown and not counted.

**Submit** either way, and both count the same:

- Post the three terms — `owner_pubkey`, `cosigner_pubkey`, `locktime` — to the
  Crowdlock's `lock_endpoint`, if it publishes one. It runs the checks above and
  adds the record. It can refuse a lock but cannot invent one, because the terms,
  not the endpoint, decide who can ever move the coins.
- Open a pull request adding the record to the registrations file.

Changing any single element — either key, the locktime, the order of the keys —
produces a different address. A lock therefore commits to its own terms, and
those terms cannot be altered after coins are sent to it.

## Taproot

**Not in use.** Every lock this document specifies is P2WSH, built by
`method/lock/lock.mjs`. A taproot version exists in `method/lock/taproot.mjs`, is tested, and
is called by nothing. This section records what it would give and what would
call for it, so the option stays open and nobody mistakes it for live.

It gives smaller witnesses and keeps the unused branch private. It changes
nothing about the two exits.

Each exit lives in its own leaf of a tapscript tree rather than in two branches
of one script, so a spend reveals only the leaf it used. Going home reveals 40
bytes and never shows that a purchase exit existed; a purchase reveals 68 bytes
and never shows the date the lock would have expired. The P2WSH form reveals all
79 bytes of both branches on either spend.

Both leaves are standard tapscript miniscript, for the same reason as the P2WSH
form: going home is `and_v(v:pk(owner),after(locktime))`, a purchase is
`and_v(v:pk(owner),pk(cosigner))`.

The internal key is BIP-341's suggested unspendable point
(`50929b74c1a0…803ac0`), so there is no key-path shortcut past the two leaves.
Without that, whoever knew the internal key could spend a lock with no script at
all.

P2WSH is specified because the behaviour is what matters and P2WSH has the
widest tooling and wallet support, leaving less novel cryptography between the
design and the proof. In particular, Ledger and Trezor handle P2WSH miniscript
more reliably today than custom tapscript, and a fan being able to check a lock
with a wallet they already own outweighs the saving.

Two things would call for taproot, and either is enough:

- **The co-signer becoming several keys instead of one.** A tapscript tree
  holds extra branches at no cost to the address and reveals only the branch
  used. In P2WSH, every added co-signer key lengthens the script and every
  spend publishes all of them.
- **Hardware wallet support for custom tapscript catching up** with its
  support for the P2WSH equivalent.

The two forms may coexist if it comes to that — the counting rule treats them
identically — but taproot must have its own live-network proof first.

`method/lock/taproot.test.mjs` proves the taproot construction and its signatures
offline. Its enforcement has not yet been proven on a live network — unlike the
P2WSH form, which now has been — which is the
only reason this document still specifies P2WSH first.

## What a spend refuses to build

A spend's output value is the coin minus the fee, and an unchecked subtraction
is how a wallet quietly destroys somebody's money. These are refused at
construction rather than discovered afterwards:

| Refused | Why |
| --- | --- |
| A fee larger than or equal to the coin | The output value goes negative or to nothing |
| A negative or fractional fee | Would pay out more than the coin holds; satoshis are whole |
| An output below the dust limit | Valid, but no node relays it, so it never reaches a miner |
| A fee taking more than half the coin | Almost always satoshis typed where bitcoin was meant |
| A destination of another network, or not an address | Caught here rather than by a node, with a readable reason |
| A coin with a malformed id, a negative index, or no value | Not a coin |

**The dust rule is the one worth understanding**, because it is the only
failure on this list that is silent. A transaction paying an output below the
dust limit is perfectly valid. It is simply not relayed, by anybody — so it
never reaches a miner, nothing rejects it, no error appears anywhere, and the
coin sits in the lock as though the attempt had never been made. A fan would
have no way to know why.

The threshold is Bitcoin Core's: three times what the output costs in bytes at
the dust relay fee, counting what it will one day cost to spend it. That gives
**294 satoshis for a `bc1q` output, 330 for `bc1p` or a P2WSH, and 546 for a
legacy address** — and the implementation is checked against those figures
rather than trusting the arithmetic.

The half-the-coin rule is a judgement rather than a rule of Bitcoin's, so it
can be overridden. Sweeping a nearly worthless lock is the honest case where a
fee really is most of the coin.

## Reference implementation

`method/lock/` in the repository. `selftest.mjs` proves the construction offline;
`run-testnet.mjs` proves the network's enforcement, which no local test can.

The four behaviours that must hold — **all four confirmed on testnet4, 25 and
26 October 2026**:

| Attempt | Required | What the node said |
| --- | --- | --- |
| Owner alone, before the locktime | Rejected | `non-final` |
| Co-signer alone, ever | Rejected | `Script failed an OP_CHECKSIGVERIFY operation` |
| Owner and co-signer, any time | Accepted | txid `fddc6525…a89ae50` |
| Owner alone, at or after the locktime | Accepted | txid `765bbc23…6385cdb8` |

If any of these does not hold, nothing else in this project should be relied
upon. They were checked rather than assumed, by a Bitcoin node with no interest
in the answer.
