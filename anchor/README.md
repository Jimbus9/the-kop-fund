# Anchoring

Putting a file's fingerprint into the Bitcoin blockchain, so that the date it
existed is provable by anybody rather than taken on anybody's word.

## What it proves, and what it does not

The block's timestamp proves **a file with exactly these bytes existed before
that moment**. Nobody can later produce a different "original" with an earlier
date, because they would need a fingerprint in an earlier block and they
cannot go back and put one there.

**It is not a backup.** If the declaration vanished tomorrow, an anchor would
not bring it back — somebody still has to be holding a copy. What it changes
is that whoever holds one can *prove* theirs is the original, to anyone,
forever.

That is the difference between *detectable if somebody kept a copy* and
*provable by anybody*, and it is the gap left by the register's honest
admission that git history can be rewritten.

## What it costs

Nothing, and none of your bitcoin.

Public calendar servers collect fingerprints from everybody, combine thousands
of them into one value, and put that single value into one Bitcoin
transaction, paying the fee themselves. The proof shows mathematically that
your fingerprint is inside that batch, and it keeps working even if the
calendars disappear afterwards.

A self-funded `OP_RETURN` transaction is the alternative — a transaction of
your own carrying the fingerprint and nothing else, with no third party in the
proof at all. **It is not worth doing yet.** It costs a fee, needs a wallet
that can build one, and means deciding which address the project is publicly
spending from. The free proof is cryptographically complete; the paid one is
tidier. Revisit it when the fund has money of its own and a reason.

## Making one

```
cd anchor && npm install        once
node anchor/stamp.mjs           anchors spec/declaration-v1.txt
node anchor/stamp.mjs ../registrations.json    or any other file
```

It writes `<file>.ots` beside the file. **Commit both.**

It will not overwrite an existing proof. An old proof carries an earlier date,
and stamping again would quietly replace that with today's — losing the very
thing it was made for.

## Finishing it

A fresh proof is real but only half written. The calendars have the
fingerprint and need an hour or two to get it into a block — and the `.ots`
file does not update itself when they do. It is a snapshot of what was known
at the moment of stamping, which was "the calendars have it, the block has not
happened yet". That sentence stays frozen in the file until somebody goes back
and asks.

Going back and asking is the whole of the next step. OpenTimestamps calls it
"upgrading", which sounds like installing a newer version of something; it is
nothing of the kind, and the word is kept out of this project's own output.

```
node anchor/verify.mjs          the next day
```

This checks the proof belongs to the file — pure arithmetic, no internet
needed — and then asks the calendars whether the block has arrived, writing
the finished proof back if so. After that the proof stands alone and needs
nobody.

Run it as often as you like; it is read-only until there is something to
collect.

## Checking the ones already here

```
cd anchor && node anchor.test.mjs
```

Opens every `.ots` in the repository and asks whether it can be read at all,
and whether it commits to the file it is named after.

**This exists because of a real failure.** The first run of `stamp.mjs`
dropped its connection after the calendars had answered, and an 84-byte stump
of a proof reached the disk — unreadable by any OpenTimestamps tool, and
sitting there looking exactly like a real one. A truncated proof is worse than
no proof, because it is only discovered on the day somebody needs it.
`stamp.mjs` now reads every proof back and checks it before writing, and this
test makes sure none slips in by another route.

## What to anchor, and how often

| What | When | Why |
| --- | --- | --- |
| The declaration | Once, now it is signed and final | It never changes. One anchor covers it forever |
| The register | Weekly at first, then monthly | Proves what the register said on a date, so a signature quietly added or removed later is provable rather than suspected |
| The specification documents | At each released version | Free, and it dates the rules people agreed to |

The register is the interesting one. If it is anchored weekly and a signature
disappears in month three, the week-two anchor proves it was there.

This could eventually run automatically on every commit. Keep it manual while
the register is small — one more automated dependency is not worth it yet.

## Verifying somebody else's anchor

Anybody can, with nothing but the file, the `.ots` beside it, and a view of
the blockchain. `node anchor/verify.mjs <file>` does it, and so does the
standard `ots verify` client, because the proof is in the ordinary
OpenTimestamps format and not anything of ours.
