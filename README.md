# The Kop Fund

Supporters locking bitcoin to buy a stake in Liverpool Football Club, as a Crowdlock.
This repository is The Kop Fund's own: its declaration, its register of members,
its published destinations, and the small relay inbox that collects members'
signed records. Anyone can check all of it with standard tools.

- Site: https://thekopfund.org/ (the old address, https://jimbus9.github.io/the-kop-fund/, forwards to it)
- Join and lock: use the Crowdlock app, or the pages on the site.
- The method this runs on, with its reference code and tests: https://github.com/Jimbus9/crowdlock

| What | Where |
|---|---|
| The Crowdlock's file (rules, co-signer key) | `crowdlocks/kop-fund.json` |
| The declaration members sign | `spec/declaration-v1.txt` |
| The register and published destinations | `registrations.json`, `destinations.json` |
| Weekly Bitcoin timestamps of the register | `anchors/` |
| The relay inbox (checking code and its schedule) | `relay/`, `js/`, `.github/workflows/relay-inbox.yml` |
| The anchoring job | `anchor/`, `.github/workflows/anchor-register.yml` |
| The fund's name as the site shows it (one place) | `site.json`, stamped into the pages by `tools/stamp-name.mjs` |
| The look: one stylesheet and self-hosted fonts (SIL Open Font Licence) | `assets/site.css`, `assets/fonts/` |
| The pages, one folder each | `index.html` (home), `declaration/`, `join/`, `get-bitcoin/`, `lock/`, `commit/`, `take-home/`, `how/`, `progress/`, `why/`, `risk/`, `society/`, `register/`, `spec/` |
| What the pages' scripts share (the website's own code) | `assets/shared.mjs`; for the Lock and Take it home pages `assets/lock-common.mjs`, `assets/lock.mjs`, `assets/take-home.mjs`; for declaration versions `assets/declaration-versions.mjs` |
| Old addresses that forward to new ones | `mock/`, `next/` |

Whoever has write access here can change all of the above, so it is given only to
The Kop Fund's maintainers.

## How it is put together

Plain HTML, CSS and JavaScript, served as it is by GitHub Pages. There is no
build step and no page loads anything from another site.

`js/` and `relay/` are the Crowdlock method's reference code, copied here byte
for byte; change them in the method's repository, never here (its checks compare
the two). Everything in `assets/` is this website's own.

## Checking a change

```
node tests/publishable.test.mjs     # every page would be served whole, loads nothing from outside, and takes the fund's name from site.json
node relay/check.mjs                # the Crowdlock file and the declaration check out
```

Both run on every push (`.github/workflows/checks.yml`). After changing the
name in `site.json`, run `node tools/stamp-name.mjs`.
