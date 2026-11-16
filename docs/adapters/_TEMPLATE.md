# Adapter Investigation Evidence Block Template

Use this template for each investigation question in `docs/adapters/<target>.md`.

---

## <Question / Title> (V-xx, spec §x)
- **Status:** `VERIFIED` | `PARTIALLY VERIFIED` | `UNVERIFIED` | `UNVERIFIED (needs user)`
- **Evidence level:** `L0` (public doc/code) | `L1` (automated check) | `L2` (runtime read-only on live instance or copy)
- **Requirement:** `ASSUMPTION` -> `OBSERVED` | remains `ASSUMPTION`
- **Command / action:** `<exact sanitized command; e.g. node tools/phase0/probe-xyz.mjs>`
- **Observed output:** `<concise, redacted output; large output in .phase0-scratch/ and summarized>`
- **Conclusion:** `<one-sentence verdict>`
- **Confidence:** `high` | `medium` | `low` (with rationale)
- **Date, version, OS:** `<observed target version, date YYYY-MM-DD, operating system>`
- **Spec delta:** `none` | `proposed update in REPORT.md`
