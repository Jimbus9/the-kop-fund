# Registration format

**Version 1 · 24 October 2026**

A registration is the whole of membership. It is two fields.

```json
{ "address": "bc1q…", "signature": "H…base64…" }
```

No name, no email, no account, no password. Nothing that could be leaked,
because nothing is collected.

## What a registration asserts

That the holder of `address` agreed to a specific version of the declaration.
Nothing else. It is not a claim about who someone is, where they live, or what
they own.

## Making one

**1. The signing statement.** For declaration v1:

```
I agree to the Supporters' Declaration v1 (sha256:3a0a0bca96ec2161d98ff9da05ae885d6b8d68e55ed412bc85dcc7fb16209b96) and join as a member.
```

Every Crowdlock signs a line of exactly this shape, with its own declaration's
title, version and fingerprint taken from its file in `crowdlocks/`:

```
I agree to the <title> v<version> (sha256:<fingerprint>) and join as a member.
```

**The English is a protocol constant and must not be translated.** The three
angle-bracketed parts are yours; everything around them is fixed, in English,
for every instance in every language. A verifier rebuilds this sentence from
the Crowdlock file and compares bytes, so a translated statement makes every
signature in that register unverifiable. Show a translation beside it if your
members need one — sign the constant. See **running your own**, "About the
language".

```
```

One line, no wrapping, no trailing whitespace. The fingerprint is the SHA-256
of the canonical declaration text — see `declaration-v1.txt` and the
canonicalisation rules below. Signing a statement that carries the fingerprint
means a signature can never be moved onto a different version of the document.

**2. Sign it** with the private key controlling `address`, using the Bitcoin
Signed Message convention (the "sign message" function in ordinary wallets).
The result is 65 bytes, base64 encoded.

**3. Submit** the two fields. Either route is equally valid:

- Open a pull request adding your entry to `registrations.json`.
- Hand the two lines to anybody who will publish them for you.

The second route exists because a signature cannot be forged and needs nobody's
permission to pass on. No operator of anything can keep a member out.

## One key does both jobs

**The key that signs the declaration is the same key that owns your locks.**

A lock's script names its owner's public key. Hash that key and you have the
address that signed the declaration. So a lock is tied to a member with no extra
registration, no second signature and no extra step — the tie is derivable by
anybody, from data already published.

This is deliberate, and it is safe. Message signing hashes its input behind a
fixed `"Bitcoin Signed Message:\n"` prefix, which is what stops a signature made
for a message being replayed as a signature for a transaction. Nonces are derived
from the key *and* the message, so signing both with one key leaks nothing. And a
signature over a message cannot spend anything: a lock needs a transaction
signature, and additionally the co-signer or the lock's own date.

One consequence: **a lock's owner key must be compressed**, because the lock
script requires 33 bytes. A registration made with an uncompressed legacy key
still counts as membership, but cannot be tied to a lock. Use `bc1q`.

## Address types

The prefixes below are mainnet's. A test network uses its own — `tb1q` on
testnet, `bcrt1q` on regtest — and the verifier derives whichever belongs to the
network the Crowdlock names. It is the *type* that is accepted or refused, never
the prefix.

| Type | Prefix (mainnet) | Accepted |
| --- | --- | --- |
| Native segwit v0 (P2WPKH) | `bc1q` | **Yes — the only kind accepted today** |
| Legacy (P2PKH) | `1` | Not yet |
| Nested segwit (P2SH-P2WPKH) | `3` | Not yet |
| Taproot (P2TR) | `bc1p` | Not yet — see below |

An earlier version of this document said legacy and nested segwit were accepted.
They were not: the verifier only ever derives a native segwit address from the
recovered key, so a signature from a legacy wallet was refused while the
specification promised it would work. Both are straightforward to add — derive
the other address types from the same recovered key and compare against each —
and adding them breaks no existing registration. Until they are added, this
table says what the code does.

Taproot message signing requires BIP-322, and wallet support for it is still
patchy. The register will accept taproot signatures once that changes; adding
the second verification route breaks no existing registration and requires
nobody to re-sign.

A verifier **must** accept any header byte in the range 27–42. Wallets differ
in which they use for the same key, and a signature made in "legacy" mode by a
segwit wallet still recovers the same public key.

## Verification

Given `address`, `signature` and the statement:

1. Compute the message digest: `SHA256(SHA256(varint(24) ‖ "Bitcoin Signed
   Message:\n" ‖ varint(len) ‖ statement))`.
2. Recover the public key from the signature's `r`, `s` and recovery id
   (`(header − 27) & 3`). Treat the key as compressed when `header ≥ 31`.
3. Derive an address from the recovered key for the claimed address's type.
4. The registration is valid if and only if the derived address equals the
   claimed address, byte for byte.

A registration that fails verification is **published and marked failed**, not
removed. The record of what was submitted is part of what makes the register
checkable.

## Canonicalising the declaration

These rules are part of the specification. Anybody writing their own client
must reach the same fingerprint from the same words.

1. UTF-8, Unicode **NFC** normalised
2. LF line endings only, never CR or CRLF
3. No trailing whitespace on any line
4. Exactly one newline at the end of the file

`declaration-v1.txt` is already canonical, so in practice a client hashes the
published file rather than re-deriving it. Canonical length: **3,408 bytes**.

## Duplicates and multiple registrations

One address, one registration. A second registration for an address already on
the register is ignored, and the earlier one stands.

A person may register as many addresses as they like. This is not a loophole:
membership confers no money and no weight on its own, so additional
registrations gain nothing beyond additional entries in a list. Weight comes
from committed money, and money cannot be duplicated.

## Member numbers

Assigned in the order registrations are accepted, starting at 1, never reused.
A number is a record of arrival and nothing more — it carries no weight, no
priority and no privilege, per principle 7 of the declaration.

**No test data ever enters the register.** Not a placeholder, not an example, not
a developer trying something out. A number is permanent and never reissued, so an
entry added and later removed would leave a hole and shift nothing — but an entry
added, numbered, and removed *before* real members arrive would silently consume
numbers that belong to people. Test registrations live in the test suite, against
throwaway keys, and never in `registrations.json`.

The same goes for anything on a test network. Test coins, test keys and test
locks are worthless by design and have no relationship to membership. **A
register records signatures on the network its own Crowdlock names, and nothing
else** — that is `mainnet` for any instance holding real money, and the two must
never mix. An instance's test copy has its own declaration, its own fingerprint
and its own register, so a test signature is not merely uncounted: it is a
signature over a different document, and the verifier derives the address using
that network's own prefix.

## Versioning

A registration is bound to the declaration version named in the statement it
signed. If a later version is published, existing registrations remain valid
for the version they signed, and members are asked whether they wish to sign
the new one. No signature is ever reinterpreted as applying to text its signer
did not read.
