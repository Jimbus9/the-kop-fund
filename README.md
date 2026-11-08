# The Kop Fund

Supporters locking bitcoin to buy a stake in Liverpool Football Club, as a Crowdlock.
This repository is The Kop Fund's own: its declaration, its register of members,
its published destinations, and the small relay inbox that collects members'
signed records. Anyone can check all of it with standard tools.

- Site: https://jimbus9.github.io/the-kop-fund/
- Join and lock: use the Crowdlock app, or the pages on the site.
- The method this runs on, with its reference code and tests: https://github.com/Jimbus9/fanfund

| What | Where |
|---|---|
| The Crowdlock's file (rules, co-signer key) | `crowdlocks/kop-fund.json` |
| The declaration members sign | `spec/declaration-v1.txt` |
| The register and published destinations | `registrations.json`, `destinations.json` |
| Weekly Bitcoin timestamps of the register | `anchors/` |
| The relay inbox (checking code and its schedule) | `relay/`, `js/`, `.github/workflows/relay-inbox.yml` |
| The anchoring job | `anchor/`, `.github/workflows/anchor-register.yml` |

Whoever has write access here can change all of the above, so it is given only to
The Kop Fund's maintainers.
