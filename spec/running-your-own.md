# Running your own

**Version 1 · 24 October 2026**

Everything here is free to copy, for any club, any sport, or any cause that fits.
Copying it is not tolerated, it is the intended outcome. Nobody needs permission,
nobody needs to tell us, and nothing is owed to anybody if it works.

This document separates the **method** — which is general — from **this
instance**, which happens to be about buying a stake in Liverpool Football Club.

The method is called **Crowdlock**. It is a set of published rules, not a
program: anyone can build software that follows them, or follow them with an
ordinary wallet and no app at all. An instance is *a* Crowdlock, the way a
particular society is a co-operative. **The Kop Fund is a Crowdlock.** Yours
will be another, with its own name and its own declaration.

## Crowdlock is six documents, plus your own declaration

| | Document | General? |
| --- | --- | --- |
| 1 | The declaration | **No — yours will say something else entirely** |
| 2 | Registration format | Yes |
| 3 | Counting rule | Yes |
| 4 | Lock format | Yes |
| 5 | Proposal and settlement format | Yes |
| 6 | Commitment format | Yes |
| 7 | Published destinations format | Yes |

The declaration is the only one that is *about* anything. The other six describe
a mechanism: how a crowd of strangers can commit money towards buying something,
with nobody ever holding anybody else's money, and no way for anyone to be made
to pay.

Write your own declaration. Keep the six.

## What Crowdlock is for

**A crowd buying an asset it intends to hold permanently and never take income
from, without a custodian.**

A football club is one example. A pub, a piece of woodland, a local newspaper, a
building, a windfarm, a shuttered factory — all the same shape. What matters is
that there is a thing, a seller, a price, and a large number of people who would
each put in a small share and want nothing back.

### The one condition that is not negotiable

**Contributors must receive nothing financial, ever.** No dividend, no interest,
no profit share, no buyback, no appreciation they can realise.

If you intend to pay anybody a return, **this is the wrong specification**. What
you would be building is a collective investment scheme, which in most countries
is heavily regulated, and the design here offers none of the protections such a
scheme is required to have. Take proper advice instead of copying this.

The whole design leans on that condition. It is why nobody needs to be trusted
with a pot of money, why there is no custodian, and why the thing cannot quietly
become somebody's business.

## What Crowdlock is bad at

Said plainly, so that nobody adopts it for the wrong job:

- **Small amounts.** On-chain fees and on-ramp costs make small commitments poor
  value — somewhere around a couple of hundred pounds, dollars or euros is where
  it starts to make sense, and it cannot sensibly do a tenner. The threshold is
  set by the fee market, not by us, so check it against the fees of the day
  rather than trusting this sentence.
- **Speed.** A proposal takes weeks by design and settlement is paced across
  days. It cannot react to an opportunity that closes on Friday.
- **Vague goals.** It needs an identifiable seller, a price, and an address that
  can be published and attested in advance. "Fund our campaign" does not fit.
- **Anybody who might need their money back on demand.** A lock is a lock.
- **A trickle rather than a target.** Crowdlock funds something with a price: a
  stake, a building, a year's costs written as a figure and a date. It has no
  notion of a standing order, so it cannot be a subscription. A charity's whole
  year *can* be a target. "A bit each month, forever" cannot.

## What the money may be spent on is your declaration's business

The Kop Fund's declaration says committed money buys and holds a stake, so its
running costs have to come from somewhere else. **That is a rule The Kop Fund
wrote for itself, not a limit of the method.**

A Crowdlock whose declaration says it funds an air ambulance every year, or a
stadium expansion once a stake is owned, is doing exactly what it told its
members it would do. Repeat purchases are a normal shape. So is running several
Crowdlocks side by side, each with its own declaration and its own register,
which is what the instance files are for.

What does not bend is the condition above: **contributors receive nothing
financial, ever.** A donation is not a return, and neither is watching the thing
you paid for get built.

One warning for anyone funding something they only partly own. If supporters
hold two per cent of a club and then pay for a stand, ninety-eight per cent of
what they paid for belongs to the people they were trying to counterbalance. The
stand may well be worth building anyway — but that is a transfer, it should be
named as one, and a declaration that permits this should say so where its members
will read it.

## What your instance must publish

The six general documents are written against parameters rather than fixed
numbers. Publish your values for all of these **in one file**,
`crowdlocks/<your-name>.json`, and your instance is fully specified. The Kop
Fund's is `crowdlocks/kop-fund.json`: copy it and change the values.

| Parameter | What it is | This instance |
| --- | --- | --- |
| `name` | What your Crowdlock is called | The Kop Fund |
| `declaration` | Its title, version, file and SHA-256. **The SHA-256 is your instance's identity** | Supporters' Declaration v1, `declaration-v1.txt`, `3a0a0bca…6209b96` |
| `network` | Which chain | `mainnet` |
| `unit` | Unit of account for every published figure | `BTC` |
| `lock_lengths_years` | The fixed options a member may choose. Whole years on real bitcoin; a test Crowdlock may offer fractions (an hour is `1/8766`) so a lock can be made and taken home in one sitting | 1, 3 or 5 |
| `minimum_counted_lock_sats` | Below this, a lock does not count towards the total | 200,000 |
| `cosigner_keys` | Public keys for the lock's purchase exit | **Not yet chosen** — an empty list |
| `cosigner_xpubs` | *Optional.* Each co-signer key's xpub, so members with a hardware wallet can lock (see below). Each must stand for one of `cosigner_keys` | Left out |
| `gathering_window_max_days` | Longest a proposal may gather; each proposal chooses within it. Your choice; we recommend 28, long enough to reach supporters who only look now and then | 28 |
| `settlement_window_max_days` | Longest settlement may take after that. Your choice; we recommend 14, room to pace the sending | 14 |
| `destination_wait_days` | How long a destination must be public before a proposal may name it. Your choice; we recommend at least 7 on real bitcoin. A test copy may use 0 | 7 |
| `attestor_keys` | Who attests destinations. **Never a co-signer's key** | **Not yet chosen** — an empty list |
| `attestor_threshold` | How many attestations an entry needs | 1 |
| `max_commitment_fee` | Fee cap on a commitment, as a fraction of the amount committed | 0.01 |
| `register` | Your registrations and destinations files | `registrations.json`, `destinations.json` |
| `chain_api` | Where the register reads balances from. Anybody can swap in their own | mempool.space |
| `disclaimer` | Optional. Shown on your register page | Not affiliated with Liverpool FC |
| `join_endpoint` | Optional. An https address that accepts signed registrations, so clients and apps can submit without GitHub. It can refuse but never forge; the pull request route stays open | — (The Kop Fund no longer runs one; members join through the relays) |
| `lock_endpoint` | Optional. The same for locks: an https address that checks a lock's terms against the chain and publishes it. Can refuse but never invent a lock; the pull request route stays open | — (The Kop Fund no longer runs one; members join through the relays) |
| `relays` | Optional. Public Nostr relays where members post signed registrations and locks, for the Crowdlock's own repository to collect every two minutes — no endpoint, account or key in the path | — |
| `spare_relays` | Optional. Published in advance; one replaces a live relay that has been silent for 7 days, in a commit saying so | — |

Choose them deliberately. Shorter windows suit a smaller, more connected crowd; a
higher minimum suits fewer, larger contributors; a longer destination wait suits
a larger purchase.

Nothing about any one Crowdlock is written into the code. The register page and
the lock tools read whichever file they are pointed at, so the same software
serves every instance. `node method/js/crowdlock.test.mjs` checks every file listed in
`crowdlocks/index.json`: that it is complete, that its declaration really hashes
to the fingerprint it claims, and that its register files agree with it.

## Making a co-signer key

A co-signer key is an ordinary bitcoin key: **12 words of its own** (24 from
a hardware wallet work just as well), at the
first address of a standard native segwit wallet, `m/84'/0'/0'/0/0`. Nothing
about it belongs to any one program, so make it whichever way you trust:

- **The Crowdlock app**, under *Make a co-signer key*, with the phone in
  airplane mode.
- **`method/cosigner/generate.mjs`** in this repository, on a computer that is
  offline.
- **Sparrow or Electrum**: make a new native segwit wallet, write down its
  words, and take the public key of its first receiving address.

The same words give the same key in all three — the app's tests check this
against the published BIP84 example. Publish only the public key, in
`cosigner_keys`. The words go on paper, twice, one copy kept away from the
other; they are never saved on a device.

**Publish its xpub too.** A hardware wallet such as a Ledger will only sign
for a lock whose keys it is given as xpubs — the longer form a key comes
from — and works the plain key out itself. The co-signer key is the first key
(`/0/0`) of the account xpub at `m/84'/0'/0'`, so the lock is exactly the same
either way: the xpub only lets the device recognise it. The app shows it beside
the key, `generate.mjs` and `restore.mjs` print it, and Sparrow shows it as the
wallet's master public key. Put it in `cosigner_xpubs`; the app and this
repository's tests refuse one that does not stand for a listed key. Without it,
members on hardware wallets cannot lock — nobody else is affected.

**Never use a wallet's own words.** At this standard slot they would make the
wallet's own key, and a lock refuses a co-signer that is its owner.

What the key can do: add the second signature to commitments members have
already signed, to destinations already attested — nothing else. It cannot
take or keep anybody's money. Lose it and no purchase can happen, but every
lock still goes home on its date. Signing, when a proposal is funded, can be
done the same three ways, because commitments are standard partially signed
transactions in the published format.

## The co-signer's record

A lock opens two ways: by its owner alone once its date has passed, or by its
owner and the co-signer together at any time. The second is meant only for a
purchase, but Bitcoin cannot enforce that. A co-signer willing to sign anything
could let members take counted money back early.

What Bitcoin does record is which way each lock was opened: a co-signed spend
carries the co-signer's signature in its witness, and nothing can disguise it.
So the register page and the app list every lock opened before its date with
the co-signer's signature that did not pay a listed destination, read straight
from the chain (`method/js/release.mjs`). A co-signer cannot keep one off it.
Choose co-signers who would rather refuse than appear there.

## Putting the key in, and changing it later

**Starting a Crowdlock in the app:** it asks for the public key and will not
go on without one, then writes it into your Crowdlock file in your own GitHub
account. Nothing else to do.

**Adding one to a Crowdlock that already exists:** in the app, open the
Crowdlock, then "Look after this Crowdlock" → "For its founder and
maintainers" → paste the public key under "Co-signer keys" → "Add this
co-signer key". It signs you in to GitHub, refuses a key that is not a real
public key, is your own wallet's, or is already there, and adds it alongside
the others in one commit. It never removes one.

**By hand**, the key lives in one place:

```json
"cosigner_keys": ["03811ead…baf68b"]
```

On GitHub, open `crowdlocks/<your-name>.json`, press the pencil, add the new
key at the end of that list, and commit. The checks that run on every push will
refuse a key that is not 66 characters starting `02` or `03`, or that another
Crowdlock already uses; in this repository they also refuse one that is not a
real point on the curve.

**Before you change one, read this.** A lock names its co-signer key inside
the script that makes its address, and that script is frozen the moment the
address exists. So:

- **Removing a key orphans every lock that names it.** Those locks still work
  — the coins are safe and still come home on their dates — but the register
  will no longer count them, because a lock is counted by the Crowdlock whose
  co-signer it names. If your Crowdlock has locks, **add the new key alongside
  the old one** rather than replacing it. `cosigner_keys` is a list for exactly
  this reason.
- **New locks use the newest key — the last in the list**, so the old key stays
  in service only for the locks already made. It can come out of the list once
  the last of them has lapsed.
- **Plan the change for a renewal.** Members re-lock when a lock reaches its
  date anyway, so a key change costs nobody an extra transaction if it rides
  along with that. Twenty early members can be asked directly; twenty thousand
  cannot, which is the real reason to settle the shape of your co-signer
  before you are large rather than after.

**Losing the words is not the same as changing the key.** A lost co-signer key
cannot be replaced for locks that already name it: no purchase those locks
were meant to fund can ever complete, though every one of them still goes home
on its date. That is the whole case for the paper, twice, in two places.

## Several Crowdlocks side by side

One site, or one app, can carry as many Crowdlocks as people add. Add your file
to `crowdlocks/`, add its name to `crowdlocks/index.json`, and your register is
at `register/?c=<your-name>`. Three rules keep them apart:

- **Every Crowdlock has its own declaration.** Two sharing one would be the same
  Crowdlock, and the checks refuse it.
- **No two Crowdlocks share a co-signer key.** A lock is counted by the
  Crowdlock whose co-signer it names, so a shared key would let one coin be
  counted twice. The checks refuse it, and a commitment checked against the
  wrong Crowdlock's file is refused too, so money committed to one can never be
  counted by another.
- **One key across several Crowdlocks links your memberships publicly.** Your
  member address is derived from your key, so anyone can see that the same
  person backs both. That is a matter of privacy, not of safety, and nothing
  stops you doing it. If you would rather the two were not connected, use a
  separate wallet for each.

## Your instance is identified by its declaration's hash

This is not decoration. **Every signature in the method is made over a statement
containing that hash**, so a signature cannot be lifted out of one instance and
replayed into another. A registration proves agreement to *your* declaration, and
a destination attestation attests an entry in *your* list.

Two instances that copied the same parameters but wrote different declarations
remain cryptographically separate, with no coordination and no registry of
instances.

## About the language

These documents say "supporter", "fan" and "the club" throughout, because the
instance that wrote them is about football. If you are buying a woodland, change
every word of that — it is tone, not mechanism. Nothing in the behaviour depends
on it.

**But two sentences are machinery wearing the clothes of prose, and translating
them breaks your Crowdlock.** Both are strings that get *signed*, and a
signature is only checkable because the verifier can rebuild the exact bytes
that were signed:

```
I agree to the <title> v<version> (sha256:<fingerprint>) and join as a member.
I attest destination entry <n> (sha256:<hash of the line>).
```

**Leave both exactly as they are, in English, whatever language your instance
speaks.** The parts that are yours are already inside them — your declaration's
title, its version, its fingerprint. The English around those is a protocol
constant, like the `|` between fields or the `sha256:` prefix, and it is no more
translatable than they are. Translate the first sentence and every member's
signature stops verifying; translate the second and your destinations list can
no longer be shown to be attested.

This is an uncomfortable rule and it is worth being straight about why it
stands. A signed statement has to be reproducible byte for byte by anyone
checking it, years later, from the published files alone. A translation is a
second possible set of bytes, and once two exist the verifier has to guess —
the same reason the proposal line has fixed fields in a fixed order. There is
nothing stopping you *displaying* a translation beside it, and you should: show
people what they are signing in their own language, and sign the constant.

Three places where the words matter more than style:

- **The two statements above.** Not style at all. Do not touch them.

- The **declaration** is signed too, but differently: its *fingerprint* is what
  goes into the statement, so its words are entirely yours. Write them in any
  language. They are the thing people agreed to.
  Write it as though it will be quoted back at you in ten years, because it will.
- The **principles the other documents refer to by number** are your
  declaration's, not ours. If you renumber, check the references.

## What we would do differently if starting again

Offered because it is cheaper to read than to rediscover:

- **Do not pool money, in any form, however convenient.** Almost every hard
  problem in this project's earlier designs came from assuming a pot had to
  exist. Removing it removed all of them at once.
- **Decide nothing by vote that can be decided by funding.** A vote exists to
  instruct somebody holding money. If nobody holds money, the vote is machinery
  with nothing to do.
- **Put nothing in the declaration that will ever need to change.** Dates,
  numbers, names, procedures and technologies all belong elsewhere. Ours shrank
  by two thirds when that rule was applied, and it got stronger.
- **Publish the figures you would rather not.** Lapsed locks, failed
  registrations, proposals that died. A register that only shows good news is not
  a register.
- **Separate the key that approves a destination from the key that spends to
  it.** One compromise should not be able to deliver both halves.
- **Ask people whether they would contribute before building any of this.** We
  have still not done it. It remains the cheapest and most important untested
  assumption in the whole project, and we would be further along if we had
  started there.

## Licence and warranty

Take it. There is no warranty of any kind. Nobody outside this project has
reviewed the code or the documents, and at the time of writing none of it has
held real money.

If you find something wrong, saying so publicly helps every instance at once.
